// DOES THE COPULA REALLY LEAVE EACH PLAYER'S MARGINAL ALONE?
//
//   node --import tsx scripts/verify-marginal.mjs
//
// bootstrap.ts claims it does: "The marginal distribution is therefore EXACTLY the bootstrap pool --
// correlation is added without distorting any player's own distribution." That is the defining
// property of a Gaussian copula and it is almost certainly true, but the whole design of the
// projection-interval feature rests on it, so it gets measured rather than believed. If the claim
// holds, a per-player season interval can be computed by resampling that player's OWN pool -- the
// correlated sim would return the same distribution at many times the cost. If it does not hold,
// the intervals must come from the full sim.
//
// This is a producer/consumer check of the kind that keeps paying: run the real sampler's real
// output through an independent computation of the same quantity, rather than reasoning about it.
import { readFileSync } from "node:fs";
import { prepare, sampleSeason, weekOf } from "../src/draft/bootstrap.ts";

const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corr = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260907);
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// A stacked NFL team -- QB + his WR + his TE -- which is exactly where the copula couples hardest
// (QB-WR +0.348, QB-TE +0.223). If a marginal is going to be distorted anywhere, it is here.
const players = [
  { name: "QB1", pos: "QB", team: "AAA", rank: 3 },
  { name: "WR1", pos: "WR", team: "AAA", rank: 5 },
  { name: "TE1", pos: "TE", team: "AAA", rank: 4 },
  { name: "RB_lone", pos: "RB", team: "BBB", rank: 8 },   // uncoupled control
];
const prep = prepare(players, outcomes, corr, "none");

// SEASONS are drawn now, not weeks. Each trial draws one whole player-season per player (coupled
// across teammates by the copula) and every week is read out of it -- so `drawn` still holds a long
// stream of weekly scores and every marginal check below asks exactly the same question of it.
// `seasonTotals` holds the season-level view, which is where the coupling now actually lives.
const N = 20000;
const drawn = new Map(players.map((p) => [p.name, []]));
const seasonTotals = new Map(players.map((p) => [p.name, []]));
const weekPairs = { qb: [], wr: [] };   // same-week teammate scores, for the WEEKLY correlation
for (let i = 0; i < N; i++) {
  const sn = sampleSeason(players, prep, gauss, rng);
  const len = Math.max(...players.map((p) => sn.get(p)?.weeks.length ?? 0));
  for (const p of players) {
    const t = sn.get(p);
    seasonTotals.get(p.name).push(t ? t.total : 0);
    for (let w = 1; w <= len; w++) drawn.get(p.name).push(weekOf(t, w));
  }
  for (let w = 1; w <= len; w++) {
    weekPairs.qb.push(weekOf(sn.get(players[0]), w));
    weekPairs.wr.push(weekOf(sn.get(players[1]), w));
  }
}

const q = (sorted, u) => {
  const i = (sorted.length - 1) * u, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`${N} correlated weekly draws vs each player's own bootstrap pool\n`);
console.log("  player     n_pool    pool mean   drawn mean    pool p10/p50/p90      drawn p10/p50/p90     max|dq|");
let worst = 0;
for (const p of players) {
  // The pool is trajectories sorted by season total; the MARGINAL question is about weeks, so
  // flatten it back to the weekly multiset -- which is exactly what schema 1 stored.
  const pool = prep.pools.get(p).flatMap((t) => t.weeks).sort((a, b) => a - b);
  const got = drawn.get(p.name).slice().sort((a, b) => a - b);
  const qs = [0.1, 0.25, 0.5, 0.75, 0.9];
  const dq = qs.map((u) => Math.abs(q(pool, u) - q(got, u)));
  const spread = q(pool, 0.9) - q(pool, 0.1) || 1;
  const rel = Math.max(...dq) / spread;                  // quantile error as a share of the p10-p90 span
  worst = Math.max(worst, rel);
  console.log(
    `  ${p.name.padEnd(9)} ${String(pool.length).padStart(6)}   ${mean(pool).toFixed(2).padStart(9)}   ${mean(got).toFixed(2).padStart(10)}` +
    `    ${[0.1, 0.5, 0.9].map((u) => q(pool, u).toFixed(1)).join("/").padStart(18)}    ${[0.1, 0.5, 0.9].map((u) => q(got, u).toFixed(1)).join("/").padStart(18)}   ${(100 * rel).toFixed(2)}%`,
  );
}

// The correlation must still BE there -- a "marginals preserved" result is worthless if the sampler
// simply is not coupling anything. Same reasoning as proving a guard can return its positive value.
const pear = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};
const rQBWRweek = pear(weekPairs.qb, weekPairs.wr);
const rQBWRseason = pear(seasonTotals.get("QB1"), seasonTotals.get("WR1"));
const rQBRBseason = pear(seasonTotals.get("QB1"), seasonTotals.get("RB_lone"));
console.log(`\n  COUPLING, now imposed at the SEASON level (target +${(corr.pairs["QB-WR"] ?? 0).toFixed(3)}):`);
console.log(`    QB-WR, same team, SEASON TOTALS:      ${rQBWRseason.toFixed(3)}`);
console.log(`    QB-WR, same team, SAME WEEK:          ${rQBWRweek.toFixed(3)}`);
console.log(`    QB-RB, DIFFERENT teams (must be ~0):  ${rQBRBseason.toFixed(3)}`);
console.log(`
  KNOWN LIMIT, stated rather than discovered later. The +0.348 target was measured on SAME-WEEK
  residuals, and it is now applied to the season quantile instead. Season totals therefore hit the
  target while the same-week figure comes in BELOW it: two teammates share season quality, not the
  particular week in which they boomed. That is a real gap and it is the right trade for now --
  season-total dispersion was wrong by a factor of two, which dominates a weekly correlation that
  only moves head-to-head weekly variance. Restoring the within-week component without disturbing
  the marginal is Phase 2 work, and it must not be done by scaling noise onto the scores.`);
console.log(`\n  SEASON-TOTAL sd, drawn vs the pool's own seasons (the statistic that was 2x too small):`);
const sdOf = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
for (const p of players) {
  const pool = prep.pools.get(p).map((t) => t.total);
  console.log(`    ${p.name.padEnd(9)} pool sd ${sdOf(pool).toFixed(1).padStart(6)}   drawn sd ${sdOf(seasonTotals.get(p.name)).toFixed(1).padStart(6)}`);
}

console.log(`\n  worst quantile error, as a share of each player's own p10-p90 span: ${(100 * worst).toFixed(2)}%`);
console.log(worst < 0.02
  ? `  MARGINALS PRESERVED -- a per-player interval can be computed from the pool directly.
  That is not a shortcut: it is the same distribution, computed exactly instead of sampled.
  The correlated sim remains REQUIRED for anything JOINT -- P(A > B) for teammates, team
  totals, playoff and title odds -- where the coupling above is the whole point.`
  : `  MARGINALS DISTORTED -- intervals must come from the full correlated simulation.`);
