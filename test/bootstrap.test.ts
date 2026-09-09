import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, sampleSeason, weekOf, cholesky, normalCdf, quantile, pairCorr, teammateCorr, type RankOutcomes, type CorrelationModel } from "../src/draft/bootstrap.js";
import { mulberry32 } from "../src/draft/sim.js";

// The two properties that make a copula the right tool, and one that makes it safe:
//   1. it IMPOSES the target correlation between teammates
//   2. it leaves each player's MARGINAL distribution exactly the bootstrap pool
//   3. an unfittable correlation matrix degrades to independence, never to nonsense
// A test suite that only checked (1) would pass for a much worse implementation that just added
// shared noise to the scores -- which would raise correlation while quietly corrupting every marginal.

const gaussFrom = (rng: () => number) => () => {
  const a = Math.max(1e-9, rng()), b = rng();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
};
// pools with deliberately DIFFERENT shapes, so a corrupted marginal is detectable
const POOL_A = Array.from({ length: 400 }, (_, i) => i * 0.1);        // 0..40 uniform
const POOL_B = Array.from({ length: 400 }, (_, i) => (i < 200 ? 0 : 30)); // bimodal 0 / 30
// SCHEMA 2 fixtures. Each "player-season" here is three weeks at a CONSTANT value, so the multiset
// of weekly values is exactly POOL_A / POOL_B as before and every assertion below keeps its old
// meaning -- while still exercising the real multi-week trajectory path rather than a special case.
const asTraj = (pool: number[]) => pool.map((v) => [v, v, v]);
const outcomes: RankOutcomes = {
  schema: 2,
  pos: { QB: { 1: asTraj(POOL_A) }, WR: { 1: asTraj(POOL_A) }, TE: { 1: asTraj(POOL_B) }, RB: { 1: asTraj(POOL_A) } },
};
const corr: CorrelationModel = { pairs: { "QB-WR": 0.348, "QB-TE": 0.223, "QB-RB": 0.08, "WR-TE": 0 } };

const pearson = (xs: number[], ys: number[]) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return dx && dy ? num / (dx * dy) : 0;
};

function run(players: { name: string; pos: string; team?: string; rank: number }[], n = 6000) {
  const rng = mulberry32(99);
  const g = gaussFrom(rng);
  const prep = prepare(players, outcomes, corr);
  const series = new Map(players.map((p) => [p.name, [] as number[]]));
  for (let i = 0; i < n; i++) {
    // The draw moved from per-week to per-SEASON; the copula machinery under test is identical, so
    // these properties are asserted on the season draw, read back at week 1.
    const drawn = sampleSeason(players, prep, g, rng);
    for (const p of players) series.get(p.name)!.push(weekOf(drawn.get(p), 1));
  }
  return series;
}

test("teammates come out CORRELATED at roughly the target", () => {
  const s = run([
    { name: "qb", pos: "QB", team: "DET", rank: 1 },
    { name: "wr", pos: "WR", team: "DET", rank: 1 },
  ]);
  const r = pearson(s.get("qb")!, s.get("wr")!);
  assert.ok(r > 0.22 && r < 0.48, `QB-WR correlation came out ${r.toFixed(3)}, want ~0.35`);
});

test("players on DIFFERENT teams stay independent", () => {
  const s = run([
    { name: "qb", pos: "QB", team: "DET", rank: 1 },
    { name: "wr", pos: "WR", team: "KC", rank: 1 },
  ]);
  const r = pearson(s.get("qb")!, s.get("wr")!);
  assert.ok(Math.abs(r) < 0.06, `cross-team correlation should be ~0, got ${r.toFixed(3)}`);
});

test("THE KEY PROPERTY: correlation does not distort the marginals", () => {
  // The same player, once alone and once coupled to a teammate, must have the SAME distribution.
  // This is what separates a copula from "add shared noise to the scores", which would pass the
  // correlation test above while corrupting every player's own distribution.
  const alone = run([{ name: "te", pos: "TE", team: "DET", rank: 1 }]);
  const coupled = run([
    { name: "qb", pos: "QB", team: "DET", rank: 1 },
    { name: "te", pos: "TE", team: "DET", rank: 1 },
  ]);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const ma = mean(alone.get("te")!), mc = mean(coupled.get("te")!);
  assert.ok(Math.abs(ma - mc) < 1.0, `TE mean moved ${ma.toFixed(2)} -> ${mc.toFixed(2)} when coupled`);
  // and every sampled value must still be a MEMBER of the pool -- bimodal stays bimodal
  const vals = new Set(coupled.get("te")!);
  for (const v of vals) assert.ok(v === 0 || v === 30, `TE produced ${v}, which is not in its bimodal pool`);
});

test("sampled values are always drawn FROM the pool, never interpolated", () => {
  const s = run([{ name: "wr", pos: "WR", team: "KC", rank: 1 }], 2000);
  const pool = new Set(POOL_A.map((x) => Math.round(x * 1e6)));
  for (const v of s.get("wr")!) assert.ok(pool.has(Math.round(v * 1e6)), `${v} is not a pool member`);
});

test("an unfittable correlation matrix DEGRADES TO INDEPENDENCE, not to nonsense", () => {
  // 3 mutually +0.99-correlated series is fine, but flip one sign and the matrix is not PSD.
  const bad = [[1, 0.99, -0.99], [0.99, 1, 0.99], [-0.99, 0.99, 1]];
  const L = cholesky(bad);
  assert.equal(L.length, 3);
  for (const row of L) for (const v of row) assert.ok(Number.isFinite(v), "Cholesky produced a non-finite value");
  // worst case is the identity -> independent draws
  const diag = L.map((r, i) => r[i]);
  for (const d of diag) assert.ok(d > 0, "diagonal must stay positive");
});

test("normalCdf and quantile behave", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-3);
  assert.ok(normalCdf(-3) < 0.005 && normalCdf(3) > 0.995);
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 0.99), 5);
  assert.equal(quantile([], 0.5), 0);
});

test("pairCorr is symmetric, self-correlation is 1, unknown pairs are 0", () => {
  assert.equal(pairCorr(corr, "QB", "WR"), 0.348);
  assert.equal(pairCorr(corr, "WR", "QB"), 0.348);
  assert.equal(pairCorr(corr, "QB", "QB"), 1);
  assert.equal(pairCorr(corr, "K", "DST"), 0);
});

// ==================================================================================================
// SAME-POSITION TEAMMATES. Two receivers on one NFL team are two men, not one man twice.
//
// `prepare()` built the off-diagonal with `pairCorr(corr, a.pos, b.pos)`, which returns 1 when the
// two POSITION STRINGS match. So a roster holding two Lions receivers handed the copula a singular
// matrix; the Cholesky shrinkage repair fired and quietly damped that team's REAL couplings on the
// way to something decomposable, and nothing anywhere failed. The measurement that should have
// settled it never existed, because `scripts/fit-correlation.mjs` kept only the top scorer per
// position per team-week. It exists now: WR1-WR2 +0.013 (SE 0.009), RB1-RB2 -0.013, TE1-TE2 -0.020,
// every one inside 2 SE of zero.
// ==================================================================================================
test("teammateCorr never returns 1 for two DIFFERENT men at the same position", () => {
  // The measured keys are read...
  assert.equal(teammateCorr({ pairs: { "WR-WR": 0.013 } }, "WR", "WR"), 0.013);
  // ...and an UNMEASURED same-position pair reads 0, never 1. This is the whole defect in one line.
  assert.equal(teammateCorr({ pairs: {} }, "WR", "WR"), 0);
  assert.equal(teammateCorr(corr, "QB", "WR"), 0.348);
  assert.equal(teammateCorr(corr, "WR", "QB"), 0.348);
  // `pairCorr` keeps its own meaning -- a POSITION with itself is 1 -- so the two questions stay
  // separate rather than one function answering both and getting one of them wrong.
  assert.equal(pairCorr(corr, "WR", "WR"), 1);
});

test("two same-team RECEIVERS are NOT perfectly coupled", () => {
  const s = run([
    { name: "wr1", pos: "WR", team: "DET", rank: 1 },
    { name: "wr2", pos: "WR", team: "DET", rank: 1 },
  ]);
  const r = pearson(s.get("wr1")!, s.get("wr2")!);
  // The measured WR-WR is inside 2 SE of zero and is written as 0, so the sampler must produce ~0.
  // The assertion that matters is the UPPER one: 1 was the shipped answer.
  assert.ok(Math.abs(r) < 0.10, `two same-team receivers came out at r=${r.toFixed(3)}, want ~0`);
  // And they must be two DIFFERENT draws, not one value twice -- r < 1 could also be reached by a
  // broken sampler that returns the same number with noise, so check the series genuinely differ.
  const identical = s.get("wr1")!.every((v, i) => v === s.get("wr2")![i]);
  assert.ok(!identical, "the two receivers drew IDENTICAL season series -- they are one man");
});

test("FAULT INJECTION: restoring the old same-position=1 rule couples the two receivers at ~1", () => {
  // The old behaviour, reproduced exactly: `WR-WR` set to 1 in the model is what `pairCorr`'s
  // `a === b -> 1` branch fed the matrix. If this does NOT come out near 1, the test above is not
  // measuring what it claims and the fix is not connected.
  const rng = mulberry32(99), g = gaussFrom(rng);
  const players = [
    { name: "wr1", pos: "WR", team: "DET", rank: 1 },
    { name: "wr2", pos: "WR", team: "DET", rank: 1 },
  ];
  const prep = prepare(players, outcomes, { pairs: { ...corr.pairs, "WR-WR": 1 } });
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const drawn = sampleSeason(players, prep, g, rng);
    a.push(weekOf(drawn.get(players[0]), 1));
    b.push(weekOf(drawn.get(players[1]), 1));
  }
  const r = pearson(a, b);
  assert.ok(r > 0.7, `the injected old rule should couple the pair near 1, got ${r.toFixed(3)} -- ` +
    "the guard above is not connected to the behaviour it claims to test");
});

test("FAULT INJECTION: zeroing the correlation model removes the coupling", () => {
  const rng = mulberry32(99), g = gaussFrom(rng);
  const players = [
    { name: "qb", pos: "QB", team: "DET", rank: 1 },
    { name: "wr", pos: "WR", team: "DET", rank: 1 },
  ];
  const prep = prepare(players, outcomes, { pairs: {} });
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const drawn = sampleSeason(players, prep, g, rng);
    a.push(weekOf(drawn.get(players[0]), 1)); b.push(weekOf(drawn.get(players[1]), 1));
  }
  const r = pearson(a, b);
  assert.ok(Math.abs(r) < 0.06, `with a zeroed model teammates must be independent, got ${r.toFixed(3)}`);
});
