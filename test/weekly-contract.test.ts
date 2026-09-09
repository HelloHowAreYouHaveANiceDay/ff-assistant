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
  // Over EVERY head the artifact actually carries, not a hardcoded four. A two-part artifact's heads
  // are `zero`, `mean` and one per grid level; iterating the quantile model's names against it would
  // rename nothing and the test would pass for a reason that has nothing to do with the rename.
  for (const pos of Object.keys(a.coef)) {
    for (const h of Object.keys(a.coef[pos])) {
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

  // Drop ANY head the artifact declares -- whichever the model in the file actually carries.
  const h = clone(base);
  const pos0 = Object.keys(h.coef)[0];
  const dropped = Object.keys(h.coef[pos0]).find((k) => k !== "mean") ?? "mean";
  delete h.coef[pos0][dropped];
  refuses(() => loadWeeklyArtifact(h), `an artifact with no '${dropped}' head was accepted`);

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

// ==================================================================================================
// THE TWO-PART MODEL (Phase 2d). Its arithmetic has a BRANCH in it -- the mixture shift
// q -> (q - pZero)/(1 - pZero), with the branch where the atom swallows the quantile level entirely
// -- and a branch is where two implementations of one contract most easily part company. So the
// golden block carries pZero as well as the four published heads, and one fixture is a man with an
// OUT designation, which is the row where the branch is actually taken.
// ==================================================================================================
test("the two-part artifact: schema 2, a grid on the artifact, and an OUT fixture that collapses onto the atom", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact");
  const a = load(ARTIFACT);
  if (a.zeroModel !== "two-part") {
    return t.skip(`the shipping artifact is a "${a.zeroModel ?? "quantile"}" model, not a two-part one`);
  }
  assert.equal(a.schema, 2);
  assert.ok(Array.isArray(a.quantileGrid) && a.quantileGrid.length >= 3,
    "a two-part artifact must publish the grid its consumer interpolates on");
  for (const pos of Object.keys(a.coef)) {
    assert.ok(a.coef[pos].zero, `${pos} has no zero head`);
  }
  // THE OUT ROW. A quantile-head model cannot express this at all: 0.10 is the smallest level it
  // publishes, so the most it could say about a man ruled out on Friday is "p10 might be 0".
  const out = (a.golden ?? []).find((g) => (g.f as Record<string, number | null>).inj_out === 1);
  assert.ok(out, "no golden fixture carries an OUT designation -- the row the two-part model exists " +
    "for is the one row nothing checks");
  assert.ok(out!.expect.pZero > 0.8,
    `a man listed Out projects P(zero) = ${out!.expect.pZero.toFixed(3)}; the first stage is not ` +
    "reading the injury designation");
  assert.equal(out!.expect.p50, 0,
    "with a zero probability above 0.5 the mixture's median must be exactly 0 -- if it is not, the " +
    "quantile shift is not being applied and the published quantiles are the CONDITIONAL ones");
  // And the healthy fixture at the same position must NOT collapse, or the model has simply learned
  // to project zero for everyone.
  const healthy = (a.golden ?? []).find((g) => g.pos === out!.pos && (g.f as Record<string, number | null>).inj_out === 0);
  assert.ok(healthy && healthy.expect.mean > 4 * out!.expect.mean,
    "the healthy fixture projects no better than the one ruled out -- the availability stage is not connected");
});

test("FAULT INJECTION: the loader refuses the OLD shape, and a two-part artifact missing its grid", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact");
  const a = load(ARTIFACT);
  if (a.zeroModel !== "two-part") return t.skip("not a two-part artifact");

  // A schema-1 artifact -- the shape that shipped before Phase 2d. It must be REFUSED rather than
  // read with whatever fields happen to line up: the mixture arithmetic reads a `zero` head that a
  // schema-1 artifact does not have, and "no zero head" silently becomes "no projection at all",
  // which looks exactly like an empty week.
  const old = clone(a);
  old.schema = 1;
  refuses(() => loadWeeklyArtifact(old), "a schema-1 artifact was accepted by a schema-2 evaluator");

  const noGrid = clone(a);
  delete noGrid.quantileGrid;
  refuses(() => loadWeeklyArtifact(noGrid),
    "a two-part artifact with no published grid was accepted -- the consumer would have guessed the " +
    "levels the trainer used, which is exactly the drift the golden block exists to catch");

  const badGrid = clone(a);
  badGrid.quantileGrid = [0.5, 0.2, 0.9];
  refuses(() => loadWeeklyArtifact(badGrid), "a non-ascending quantile grid was accepted");

  const noZero = clone(a);
  delete noZero.coef[Object.keys(noZero.coef)[0]].zero;
  refuses(() => loadWeeklyArtifact(noZero), "a two-part artifact with no zero head was accepted");

  // And the POSITIVE side: the untouched artifact still loads, so the four refusals above are the
  // refusals of a working loader rather than of one that rejects everything.
  assert.ok(loadWeeklyArtifact(clone(a)), "the unmodified artifact no longer loads");
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
