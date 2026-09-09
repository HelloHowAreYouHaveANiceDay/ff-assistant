// THE INJURY-DURATION ARTIFACT CONTRACT.
//
// The producer (tools/train_injury_duration.py) and the consumer (src/inseason/injuryHorizon.ts)
// implement the same four transforms twice, in two languages. A producer that ships its own
// validator grades its own homework and passes forever while every consumer rejects its output --
// this repo has that scar, recorded in tools/train_projection.py's header. The golden block is the
// only check where the two implementations are independent, so it is the one asserted here, at
// 1e-6, together with the loader's refusals and a FAULT INJECTION proving the check can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  loadInjuryHorizonArtifact, checkHorizonGolden, horizonFor, horizonFeatureValue,
  HORIZONS, HORIZON_FIELDS, type InjuryHorizonArtifact, type HorizonSpec,
} from "../src/inseason/injuryHorizon.js";

const PATH = "data/injury-duration-artifact.json";
const skip = existsSync(PATH) ? false : `${PATH} not fitted -- run tools/train_injury_duration.py`;
const load = (): InjuryHorizonArtifact => JSON.parse(readFileSync(PATH, "utf8"));

test("the shipped artifact loads, and its golden block agrees at 1e-6", { skip }, () => {
  const a = loadInjuryHorizonArtifact(load());
  assert.ok((a.golden?.length ?? 0) >= 5, "no golden block -- nothing checks that trainer and evaluator agree");
  checkHorizonGolden(a, 1e-6);
});

test("FAULT INJECTION: a one-part-in-a-thousand coefficient change FAILS the golden check", { skip }, () => {
  // Without this, the previous test is indistinguishable from a check that cannot fail.
  const a = loadInjuryHorizonArtifact(load());
  const broken = JSON.parse(JSON.stringify(a)) as InjuryHorizonArtifact;
  broken.coef["4"].intercept += 0.001;
  assert.throws(() => checkHorizonGolden(broken, 1e-6), /golden row .* horizon k=4/,
    "perturbing a shipped coefficient did not fail the golden check, so the check is inert");
});

test("FAULT INJECTION: a renamed field is REFUSED, not silently zeroed", { skip }, () => {
  const a = load() as InjuryHorizonArtifact;
  const broken = JSON.parse(JSON.stringify(a)) as InjuryHorizonArtifact;
  (broken.features[0] as unknown as { field: string }).field = "designation_v2";
  assert.throws(() => loadInjuryHorizonArtifact(broken), /HORIZON_FIELDS/);
});

test("FAULT INJECTION: a head missing one coefficient is REFUSED", { skip }, () => {
  const broken = JSON.parse(readFileSync(PATH, "utf8")) as InjuryHorizonArtifact;
  const name = broken.features[3].name;
  delete broken.coef["2"][name];
  assert.throws(() => loadInjuryHorizonArtifact(broken), /no finite coefficient/);
});

test("an unseen injury string lands in inj_other, NOT in the reference category", { skip }, () => {
  const a = loadInjuryHorizonArtifact(load());
  const other = a.features.find((f) => f.transform === "not_in");
  assert.ok(other, "the artifact declares no complement bucket, so an unseen injury would be the base level");
  assert.equal(horizonFeatureValue(other as HorizonSpec, { injury_group: "unicorn-horn" }), 1);
  assert.equal(horizonFeatureValue(other as HorizonSpec, { injury_group: (other as HorizonSpec).values![0] }), 0);
  // and a missing injury_group is also the complement, not a silent zero on every bucket
  assert.equal(horizonFeatureValue(other as HorizonSpec, {}), 1);
});

test("the horizon is MONOTONE: P(miss next 4) <= P(miss next 1), on real feature combinations", { skip }, () => {
  // Four independently fitted heads are not monotone by construction. If they crossed, the expected
  // -games-out figure the copilot prints would be nonsense for those rows, and nothing else would
  // notice. This walks the actual product of levels rather than a hand-picked example.
  const a = loadInjuryHorizonArtifact(load());
  let n = 0, bad: string[] = [];
  for (const designation of ["Out", "Doubtful", "Questionable", "Probable", ""]) {
    for (const practice_status of ["DNP", "Limited", "Full"]) {
      for (const injury_group of ["knee", "hamstring", "concussion", "unicorn-horn"]) {
        for (const pos of ["QB", "RB", "WR", "TE"]) {
          for (const weeks_missed_so_far of [0, 2, 5]) {
            const r = horizonFor(a, { designation, practice_status, injury_group, pos, weeks_missed_so_far, age: 27 });
            n++;
            for (let i = 1; i < HORIZONS.length; i++) {
              if (r.p[HORIZONS[i]] > r.p[HORIZONS[i - 1]] + 1e-9) {
                bad.push(`${designation}/${practice_status}/${injury_group}/${pos}/${weeks_missed_so_far}: k=${HORIZONS[i]} ${r.p[HORIZONS[i]].toFixed(4)} > k=${HORIZONS[i - 1]} ${r.p[HORIZONS[i - 1]].toFixed(4)}`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(n >= 700, `only ${n} combinations walked`);
  assert.equal(bad.length, 0, `non-monotone horizons:\n  ${bad.slice(0, 5).join("\n  ")}`);
});

test("the model SEPARATES what the designation alone cannot", { skip }, () => {
  // A model whose extra features do nothing is a model nobody should ship over the baseline. Two
  // rows identical but for the practice status and the episode history must not price the same.
  const a = loadInjuryHorizonArtifact(load());
  const base = { designation: "Questionable", injury_group: "hamstring", pos: "WR", age: 26 };
  const soft = horizonFor(a, { ...base, practice_status: "Full", weeks_missed_so_far: 0, weeks_in_episode: 0 });
  const hard = horizonFor(a, { ...base, practice_status: "DNP", weeks_missed_so_far: 3, weeks_in_episode: 4 });
  assert.ok(hard.p[1] > soft.p[1] + 0.10, `k=1: DNP+3 weeks out ${hard.p[1].toFixed(3)} vs full practice ${soft.p[1].toFixed(3)}`);
  assert.ok(hard.expectedGamesOut4 > soft.expectedGamesOut4 + 0.4);
  // and the designation-only baseline, which travels on the artifact, gives them the SAME answer --
  // which is the whole reason the extra features are there.
  assert.ok(soft.baseline && hard.baseline, "no designation-only baseline on the artifact");
  assert.ok(Math.abs(hard.baseline![1] - soft.baseline![1]) < 1e-12);
});

test("HORIZON_FIELDS covers every field the shipped artifact names", { skip }, () => {
  const a = load();
  for (const f of a.features) {
    assert.ok((HORIZON_FIELDS as readonly string[]).includes(f.field), `${f.field} is not published`);
  }
});
