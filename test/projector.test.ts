// ONE PROJECTOR, AND THE MULTIPLIER IS APPLIED EXACTLY ONCE.
//
// The defect these tests exist to catch is the one Phase 2a was built to end: the board applied the
// age and opportunity multipliers in projections.ts, and the backtest applied them again a thousand
// lines away in ff.ts with slightly different arguments. Two implementations of "the projection",
// one of which was the thing being validated and the other the thing being shipped, and they agreed
// only by luck. Nothing about either output betrays a factor applied twice: a 0.9 multiplier squared
// is 0.81, which is a perfectly plausible projection.
//
// So the assertions are (a) both entry points route through the same pure function, and (b) the
// arithmetic is exactly base x factors -- a claim a double application is structurally incapable of
// satisfying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { projectSeason, loadArtifact, curveOnlyArtifact, checkGolden, type ProjectionArtifact } from "../src/model/projector.js";
import { loadFeatureRows, backtestFeatureRows, boardProjection, backtestProjection } from "../src/model/features.js";

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
    features: loadFeatureRows(db, {
      season: 2026, rankBasis: "ecr-else-prior", base: a.base,
      useAge: a.multiplicative.includes("age_factor"), useOpp: a.multiplicative.includes("opp_factor"),
    }),
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
 * THE ONE THAT MATTERS. Under a curve-only artifact the projection IS the curve times the declared
 * multiplicative stage, so the arithmetic is checkable exactly, per row, against inputs the test
 * reads for itself. A path that applies the age factor a second time squares it, which this cannot
 * pass and which no amount of eyeballing a board would ever catch.
 */
function assertNoDoubleApplication(rows: ReturnType<typeof backtestFeatureRows>, out: ReturnType<typeof projectSeason>, a: ProjectionArtifact) {
  assert.ok(a.features.length === 0, "this check assumes a curve-only artifact");
  const byName = new Map(rows.map((r) => [`${r.pos}|${r.name}`, r]));
  let checked = 0, moved = 0;
  for (const p of out) {
    const r = byName.get(`${p.pos}|${p.name}`);
    if (!r || r.base == null) continue;
    let want = r.base;
    for (const k of a.multiplicative) want *= r.factors[k];
    assert.ok(Math.abs(p.mean - want) < 1e-9,
      `${p.pos} ${p.name}: projector says ${p.mean}, base x factors is ${want} ` +
      `(base ${r.base}, age ${r.factors.age_factor}, opp ${r.factors.opp_factor}). ` +
      `A ratio near the square of a factor means it was applied twice.`);
    checked++;
    if (Math.abs(r.factors.age_factor * r.factors.opp_factor - 1) > 1e-6) moved++;
  }
  assert.ok(checked > 100, `only ${checked} rows checked`);
  // POSITIVE CONTROL. If no row's factors differ from 1, the assertion above cannot tell a correct
  // multiplication from no multiplication at all, and it would pass forever against a projector that
  // ignored the multiplicative stage entirely.
  assert.ok(moved > 20, `only ${moved} rows carry a multiplier away from 1.0 -- the check cannot distinguish ` +
    `a correct multiplicative stage from an absent one`);
}

test("the multiplicative stage is applied EXACTLY ONCE on the backtest path", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2024)) return t.skip("no artifact or no 2024 features");
  const a = art();
  const db = openDb("data/ff.db");
  // Scored against the ENTRY POINT's output, not against a locally-assembled call. Asserting on
  // projectSeason here would test the pure function -- which is correct -- while the extra multiply
  // a caller could add sits outside it, and the guard would pass forever against the broken case.
  const rows = backtestFeatureRows(db, 2024, a);
  const out = backtestProjection(db, 2024, a);
  db.close();
  assertNoDoubleApplication(rows, out, a);
});

test("the multiplicative stage is applied EXACTLY ONCE on the board path", (t) => {
  if (!existsSync(ARTIFACT) || !haveFeatures(2026)) return t.skip("no artifact or no 2026 features");
  const a = art();
  const db = openDb("data/ff.db");
  const rows = loadFeatureRows(db, {
    season: 2026, rankBasis: "ecr-else-prior", base: a.base,
    useAge: a.multiplicative.includes("age_factor"), useOpp: a.multiplicative.includes("opp_factor"),
  });
  const out = boardProjection(db, 2026, a);
  db.close();
  assertNoDoubleApplication(rows, out, a);
});

test("a row with no curve value produces NO projection, never a zero", () => {
  const a = curveOnlyArtifact({ positions: ["RB"], seasons: [2024] });
  const out = projectSeason({
    season: 2024, asOf: "2024-09-01", artifact: a,
    features: [
      { player_sk: "1", name: "Has Curve", pos: "RB", base: 200, rank: 1, f: {}, factors: { age_factor: 1, opp_factor: 1 } },
      { player_sk: "2", name: "No Curve", pos: "RB", base: null, rank: null, f: {}, factors: { age_factor: 1, opp_factor: 1 } },
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
