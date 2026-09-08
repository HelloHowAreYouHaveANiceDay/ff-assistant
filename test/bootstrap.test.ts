import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, sampleSeason, weekOf, cholesky, normalCdf, quantile, pairCorr, type RankOutcomes, type CorrelationModel } from "../src/draft/bootstrap.js";
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
