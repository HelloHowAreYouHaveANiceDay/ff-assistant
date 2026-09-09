// ONE PROJECTOR, AND THE BASE IT USES IS THE BASE THE ARTIFACT DECLARES.
//
// Phase 2a's defect was a multiplier applied by the projector AND again by the caller: two
// implementations of "the projection", agreeing only by luck, and nothing about either output
// betrays it -- a 0.9 factor squared is 0.81, a perfectly plausible projection. That stage is now
// retired and `loadArtifact` refuses an artifact that still declares one.
//
// Phase 2b's version of the same failure is one layer up. The curve now travels ON the artifact, so
// its construction can be selected by the evaluation rather than compiled into the feature builder
// -- and the way that goes wrong is a loader that ignores it and reads the precomputed column
// instead. The board renders, every dollar adds up, and the curve the evaluation chose was never
// used. So the assertions are (a) both entry points route through the same pure function, (b) a
// curve-only projection is EXACTLY the base it was handed, and (c) doubling the artifact's curve
// doubles every projection -- a claim a loader reading the column is structurally incapable of
// satisfying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { projectSeason, loadArtifact, curveOnlyArtifact, checkGolden, type ProjectionArtifact } from "../src/model/projector.js";
import { loadFeatureRows, backtestFeatureRows, boardProjection, backtestProjection, curveAt } from "../src/model/features.js";

const HAVE_DB = existsSync("data/ff.db");
const ARTIFACT = "data/projection-artifact.json";

function haveFeatures(season: number): boolean {
  if (!HAVE_DB) return false;
  const db = openDb("data/ff.db");
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM feat_player_season WHERE season = ?").get(season) as { c: number };
    return r.c > 0;
  } catch { return false; } finally { db.close(); }
}

const art = (): ProjectionArtifact => loadArtifact(JSON.parse(readFileSync(ARTIFACT, "utf8")));

test("the artifact on disk loads through the shipped validator and its golden rows reproduce", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no projection artifact -- run `ff build-artifact --curve-only`");
  const a = art();
  checkGolden(a, 1e-6);
  assert.ok(a.golden && a.golden.length >= 4, "an artifact must carry golden rows or nothing checks it");
});

test("BOARD path is exactly projectSeason over the board's own feature rows", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2026)) return t.skip("no artifact or no 2026 features");
  const a = art();
  const db = openDb("data/ff.db");
  const direct = projectSeason({
    season: 2026, asOf: "2026-09-01", artifact: a,
    features: loadFeatureRows(db, { season: 2026, rankBasis: "ecr-else-prior", base: a.base, curve: a.curve }),
  });
  const viaEntry = boardProjection(db, 2026, a);
  db.close();
  assert.ok(direct.length > 100, `expected a full board, got ${direct.length} rows`);
  assert.equal(JSON.stringify(viaEntry), JSON.stringify(direct));
});

test("BACKTEST path is exactly projectSeason over the backtest's own feature rows", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2024)) return t.skip("no artifact or no 2024 features");
  const a = art();
  const db = openDb("data/ff.db");
  const direct = projectSeason({ season: 2024, asOf: "2024-09-01", artifact: a, features: backtestFeatureRows(db, 2024, a) });
  const viaEntry = backtestProjection(db, 2024, a);
  db.close();
  assert.ok(direct.length > 100, `expected a full pool, got ${direct.length} rows`);
  assert.equal(JSON.stringify(viaEntry), JSON.stringify(direct));
});

test("both paths hand the SAME feature rows produce byte-identical projections", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2024)) return t.skip("no artifact or no 2024 features");
  const a = art();
  const db = openDb("data/ff.db");
  const rows = backtestFeatureRows(db, 2024, a);
  db.close();
  const one = projectSeason({ season: 2024, asOf: "2024-09-01", artifact: a, features: rows });
  const two = projectSeason({ season: 2024, asOf: "2024-09-01", artifact: a, features: rows });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
});

/**
 * THE ONE THAT MATTERS, Phase 2b edition.
 *
 * The defect it used to guard -- a multiplier applied by the projector AND again by the caller --
 * cannot happen any more, because the multiplicative stage is gone and `loadArtifact` refuses an
 * artifact that still declares one (asserted below). The defect that CAN happen now is the same
 * shape one layer over: the base a caller supplies and the base the artifact's own curve implies
 * silently disagree, and every projection is quietly a few percent wrong.
 *
 * So: under a curve-only artifact the projection IS the base, exactly, per row -- and the base is
 * checked against the artifact's own curve read at the row's own rank.
 */
function assertProjectionIsTheBase(rows: ReturnType<typeof backtestFeatureRows>, out: ReturnType<typeof projectSeason>, a: ProjectionArtifact) {
  assert.ok(a.features.length === 0, "this check assumes a curve-only artifact");
  assert.deepEqual(a.multiplicative, [], "the multiplicative stage is retired");
  const byName = new Map(rows.map((r) => [`${r.pos}|${r.name}`, r]));
  let checked = 0;
  const distinct = new Set<number>();
  for (const p of out) {
    const r = byName.get(`${p.pos}|${p.name}`);
    if (!r || r.base == null) continue;
    assert.ok(Math.abs(p.mean - r.base) < 1e-9,
      `${p.pos} ${p.name}: projector says ${p.mean}, the base it was handed is ${r.base}. ` +
      `A curve-only artifact multiplies by exactly 1; anything else is a stage nobody declared.`);
    checked++;
    distinct.add(Math.round(r.base * 100));
  }
  assert.ok(checked > 100, `only ${checked} rows checked`);
  // POSITIVE CONTROL. If every base were the same number the assertion could not tell a real curve
  // lookup from a constant, and it would pass forever against a loader that had stopped reading one.
  assert.ok(distinct.size > 50,
    `only ${distinct.size} distinct base values -- the check cannot distinguish a real curve from a constant`);
}

test("a curve-only projection is EXACTLY the base, on the backtest path", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2024)) return t.skip("no artifact or no 2024 features");
  const a = art();
  if (a.features.length) return t.skip("the shipped artifact is trained, not curve-only");
  const db = openDb("data/ff.db");
  // Scored against the ENTRY POINT's output, not against a locally-assembled call. Asserting on
  // projectSeason here would test the pure function -- which is correct -- while an extra factor a
  // caller could add sits outside it, and the guard would pass forever against the broken case.
  const rows = backtestFeatureRows(db, 2024, a);
  const out = backtestProjection(db, 2024, a);
  db.close();
  assertProjectionIsTheBase(rows, out, a);
});

test("a curve-only projection is EXACTLY the base, on the board path", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2026)) return t.skip("no artifact or no 2026 features");
  const a = art();
  if (a.features.length) return t.skip("the shipped artifact is trained, not curve-only");
  const db = openDb("data/ff.db");
  const rows = loadFeatureRows(db, { season: 2026, rankBasis: "ecr-else-prior", base: a.base, curve: a.curve });
  const out = boardProjection(db, 2026, a);
  db.close();
  assertProjectionIsTheBase(rows, out, a);
});

test("an artifact that still declares a multiplicative stage is REFUSED, not quietly stripped", () => {
  const a = base();
  (a as { multiplicative: string[] }).multiplicative = ["age_factor"];
  assert.throws(() => loadArtifact(a), /multiplicative stage/);
});

// --------------------------------------------------------------------------------------------
// THE CURVE ON THE ARTIFACT IS THE CURVE THE BOARD READS.
//
// Phase 2b moved the curve onto the artifact so its construction could be a fitted hyperparameter.
// The failure that buys is a loader that ignores it and reads the precomputed column instead: the
// board renders, every dollar adds up, and the curve the evaluation selected was never used. So the
// check is a live one -- double the artifact's curve and every projection must double.
// --------------------------------------------------------------------------------------------
test("the artifact's own curve is what a projection is built from", () => {
  const a = curveOnlyArtifact({ positions: ["RB"], seasons: [2024] });
  a.base = "artifact_curve";
  a.curve = { RB: [300, 250, 200, 150] };
  const rows = (curve: Record<string, number[]>) => [1, 2, 3, 9].map((rank) => ({
    player_sk: null, name: `r${rank}`, pos: "RB", rank,
    base: curveAt(curve, "RB", rank), f: {},
  }));
  const out = projectSeason({ season: 2024, asOf: "", artifact: a, features: rows(a.curve) });
  assert.deepEqual(out.map((r) => r.mean), [300, 250, 200, 150],
    "past the curve's end the last fitted value carries -- rank 9 must read 150, not undefined");
  const doubled = { RB: a.curve.RB.map((v) => v * 2) };
  const out2 = projectSeason({ season: 2024, asOf: "", artifact: { ...a, curve: doubled }, features: rows(doubled) });
  assert.deepEqual(out2.map((r) => r.mean), [600, 500, 400, 300]);
});

test("the offset form is a DIFFERENT arithmetic from the ratio form, and both are clamped in the same units", () => {
  const a = base();
  a.coef.RB = { mean: { intercept: 10, age: 0 }, p10: { intercept: -20, age: 0 }, p50: { intercept: 0, age: 0 }, p90: { intercept: 30, age: 0 } };
  a.clamps = { lo: 0.5, hi: 2 };
  const feats = [{ player_sk: null, name: "x", pos: "RB", base: 100, rank: 1, f: { age: 26 } }];
  const ratio = projectSeason({ season: 0, asOf: "", artifact: { ...a, form: "ratio" }, features: feats })[0];
  const offset = projectSeason({ season: 0, asOf: "", artifact: { ...a, form: "offset" }, features: feats })[0];
  // ratio: 100 * clamp(10, 0.5, 2) = 200. offset: clamp(100 + 10, 50, 200) = 110.
  assert.equal(ratio.mean, 200);
  assert.equal(offset.mean, 110);
  assert.equal(offset.p10, 80);
  assert.equal(offset.p90, 130);
  // The default is "ratio", so every artifact written before the form existed still means what it
  // meant. A silent flip here would move every projection on the board and throw nothing.
  assert.equal(projectSeason({ season: 0, asOf: "", artifact: a, features: feats })[0].mean, 200);
});

test("a row with no curve value produces NO projection, never a zero", () => {
  const a = curveOnlyArtifact({ positions: ["RB"], seasons: [2024] });
  const out = projectSeason({
    season: 2024, asOf: "2024-09-01", artifact: a,
    features: [
      { player_sk: "1", name: "Has Curve", pos: "RB", base: 200, rank: 1, f: {} },
      { player_sk: "2", name: "No Curve", pos: "RB", base: null, rank: null, f: {} },
    ],
  });
  // A zero is a real number that flows into VOR, the baselines and the auction book. "We have no
  // curve at this rank" is not a projection of zero points.
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Has Curve");
});

// --------------------------------------------------------------------------------------------
// THE LOADER REFUSES what it cannot fully evaluate. Each of these degrades, without the guard, to
// "that coefficient contributes zero" -- a slightly different projection and no error at all.
// --------------------------------------------------------------------------------------------

const base = (): ProjectionArtifact => ({
  schema: 1, kind: "projection", fittedFrom: "test", seasons: [2024], holdoutSeason: null,
  base: "curve_value_prior",
  features: [{ name: "age", transform: "center", center: 26, scale: 3, missing: 0 }],
  multiplicative: [],
  coef: { RB: { mean: { intercept: 1, age: -0.02 }, p10: { intercept: 0.6, age: 0 }, p50: { intercept: 1, age: 0 }, p90: { intercept: 1.5, age: 0 } } },
  clamps: { lo: 0.5, hi: 2 },
});

test("an artifact naming a feature the evaluator cannot compute is REFUSED", () => {
  const a = base();
  (a.features[0] as { name: string }).name = "vibes";
  assert.throws(() => loadArtifact(a), /not one this evaluator can compute/);
});

test("an artifact missing a quantile head is REFUSED", () => {
  const a = base();
  delete (a.coef.RB as Partial<typeof a.coef.RB>).p90;
  assert.throws(() => loadArtifact(a), /head 'p90'/);
});

test("an artifact whose coefficients name an undeclared feature is REFUSED", () => {
  const a = base();
  a.coef.RB.mean.wopr = 0.5;
  assert.throws(() => loadArtifact(a), /names no declared feature/);
});

test("an artifact with no explicit 'missing' value is REFUSED", () => {
  const a = base();
  delete (a.features[0] as Partial<{ missing: number }>).missing;
  assert.throws(() => loadArtifact(a), /'missing' must be an explicit finite number/);
});

test("a golden block the evaluator disagrees with is REFUSED", () => {
  const a = base();
  a.golden = [{ pos: "RB", base: 100, rank: 1, f: { age: 26 }, expect: { mean: 999, p10: 60, p50: 100, p90: 150 } }];
  assert.throws(() => loadArtifact(a), /golden row 0/);
});

test("a golden block the evaluator AGREES with passes -- the positive control", () => {
  const a = base();
  // age 26 centred on 26 is exactly 0, so mean = 100 * (1 + 0) = 100.
  a.golden = [{ pos: "RB", base: 100, rank: 1, f: { age: 26 }, expect: { mean: 100, p10: 60, p50: 100, p90: 150 } }];
  assert.doesNotThrow(() => loadArtifact(a));
});
