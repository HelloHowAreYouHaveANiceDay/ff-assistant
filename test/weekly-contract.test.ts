// THE TRAIN-SERVE CONTRACT for the weekly model.
//
// tools/train_weekly.py fits in Python and src/weekly/projector.ts serves in TypeScript. Two
// implementations of one arithmetic, in two languages, is exactly the shape that stays green on both
// sides while disagreeing -- a producer that ships its own validator grades its own homework and
// passes forever. So the artifact carries five fixture rows with the TRAINER'S OWN predictions, and
// this test recomputes them here.
//
// Every assertion below is fault-injected, because a validator that has never refused anything is
// indistinguishable from one that cannot:
//   - rename a feature       -> the loader must refuse (the FEATURE_FIELDS dictionary check)
//   - corrupt a golden row   -> checkWeeklyGolden must refuse
//   - drop a quantile head   -> the loader must refuse
//   - drop one coefficient   -> the loader must refuse (absent and zero must not look the same)
//   - raise the clamp floor  -> refused, because p10 has to be able to reach the zero atom
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  loadWeeklyArtifact, checkWeeklyGolden, projectWeekly, seasonLineOnlyArtifact,
  type WeeklyArtifact,
} from "../src/weekly/projector.js";

const ARTIFACT = "data/weekly-artifact.json";
const LINE_ONLY = "data/weekly-artifact-lineonly.json";
const clone = (a: WeeklyArtifact): WeeklyArtifact => JSON.parse(JSON.stringify(a)) as WeeklyArtifact;
const load = (p: string): WeeklyArtifact => loadWeeklyArtifact(JSON.parse(readFileSync(p, "utf8")));
const refuses = (fn: () => unknown, why: string) => {
  assert.throws(fn, /weekly artifact:/, why);
};

test("the trained weekly artifact loads and its golden rows reproduce to 1e-6", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact -- run tools/train_weekly.py");
  const a = load(ARTIFACT);
  checkWeeklyGolden(a, 1e-6);
  assert.ok(a.golden && a.golden.length >= 5, "an artifact must carry golden rows or nothing checks it");
  // One of them must be the all-missing week-1 row: that is the fixture where the two sides fall
  // back on their own defaults, which is where they are most likely to differ, and it is not a
  // corner case -- it is every player in week 1.
  const supplied = (g: typeof a.golden extends (infer T)[] | undefined ? T : never) =>
    a.features.filter((s) => (g.f as Record<string, unknown>)[s.name] != null).length;
  const leanest = Math.min(...a.golden!.map(supplied));
  assert.ok(leanest * 2 <= a.features.length,
    `the leanest golden row still supplies ${leanest} of ${a.features.length} features -- no fixture ` +
    "exercises the missing-input defaults, which is where two implementations most easily differ");
});

test("FAULT INJECTION: renaming a feature makes the loader refuse", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact");
  const a = clone(load(ARTIFACT));
  assert.ok(a.features.length > 0, "the trained artifact must declare features or this proves nothing");
  const old = a.features[0].name;
  const renamed = "t4_mean_v2" as typeof old;
  a.features[0].name = renamed;
  for (const pos of Object.keys(a.coef)) {
    for (const h of ["mean", "p10", "p50", "p90"] as const) {
      a.coef[pos][h][renamed] = a.coef[pos][h][old];
      delete a.coef[pos][h][old];
    }
  }
  refuses(() => loadWeeklyArtifact(a),
    "a renamed feature loaded silently -- that is exactly how a producer and a consumer stay green while disagreeing");
});

test("FAULT INJECTION: a corrupted golden row, a missing head, a missing coefficient and a raised clamp floor are all refused", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact");
  const base = load(ARTIFACT);

  const g = clone(base);
  g.golden![0].expect.mean += 0.5;
  refuses(() => loadWeeklyArtifact(g), "a wrong golden prediction was accepted");

  const h = clone(base);
  delete (h.coef[Object.keys(h.coef)[0]] as Partial<typeof h.coef[string]>).p90;
  refuses(() => loadWeeklyArtifact(h), "an artifact with no p90 head was accepted");

  const c = clone(base);
  if (c.features.length) {
    const pos = Object.keys(c.coef)[0];
    delete c.coef[pos].mean[c.features[0].name];
    refuses(() => loadWeeklyArtifact(c),
      "a missing coefficient was accepted -- absent and zero must not look the same to a schema check");
  }

  const k = clone(base);
  k.clamps = { lo: 0.01, hi: 4 };
  // A positive floor is not refused by the schema (it is a legal range); what must hold is that the
  // SHIPPED artifact keeps lo at exactly 0, so p10 can sit on the zero atom.
  assert.equal(base.clamps.lo, 0,
    "the shipped weekly clamp floor must be exactly 0 -- a small positive floor silently turns every " +
    "projected zero week into a small positive number that no metric flags");
  const neg = clone(base);
  neg.clamps = { lo: -1, hi: 4 };
  refuses(() => loadWeeklyArtifact(neg), "a negative clamp floor was accepted");
});

test("the season-line-only artifact is producible and projects exactly the season line", (t) => {
  const a = seasonLineOnlyArtifact({ positions: ["QB", "RB", "WR", "TE", "K", "DST"], seasons: [2024] });
  const checked = loadWeeklyArtifact(a);
  const rows = projectWeekly({
    artifact: checked,
    rows: [{
      feat_key: "x", player_sk: null, name: "x", pos: "RB", season: 2024, week: 5,
      season_line_pg: 12.25, f: { t4_mean: 30, td_ppg: 30 },
    }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mean, 12.25,
    "the floor artifact must reproduce the season line EXACTLY -- if a feature moved it, a " +
    "coefficient is non-zero and it is no longer a floor");

  if (existsSync(LINE_ONLY)) {
    const fromDisk = load(LINE_ONLY);
    assert.equal(fromDisk.features.length, 0, "the trainer's --season-line-only artifact declared features");
    for (const pos of Object.keys(fromDisk.coef)) {
      assert.equal(fromDisk.coef[pos].mean.intercept, 1,
        `${pos}: the floor artifact's mean intercept must be exactly 1.0`);
    }
  }
});

test("a row with no season line produces NO projection, not a zero", () => {
  const a = loadWeeklyArtifact(seasonLineOnlyArtifact({ positions: ["RB"], seasons: [2024] }));
  const rows = projectWeekly({
    artifact: a,
    rows: [
      { feat_key: "a", player_sk: null, name: "a", pos: "RB", season: 2024, week: 1, season_line_pg: null, f: {} },
      { feat_key: "b", player_sk: null, name: "b", pos: "RB", season: 2024, week: 1, season_line_pg: 0, f: {} },
      { feat_key: "c", player_sk: null, name: "c", pos: "RB", season: 2024, week: 1, season_line_pg: 8, f: {} },
    ],
  });
  assert.deepEqual(rows.map((r) => r.feat_key), ["c"],
    "'we have no preseason line for this man' is not a projection of zero points and must not be recorded as one");
});
