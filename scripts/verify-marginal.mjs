// DOES THE COPULA REALLY LEAVE EACH PLAYER'S MARGINAL ALONE -- AND IS THE COUPLING WHERE WE SAY?
//
//   node --import tsx scripts/verify-marginal.mjs [--no-week] [--coupling 0.75]
//
// bootstrap.ts claims the marginal is untouched: "correlation is added without distorting any
// player's own distribution." That is the defining property of a Gaussian copula and it is almost
// certainly true, but the whole design of the projection-interval feature rests on it, so it gets
// measured rather than believed.
//
// PHASE 2b ADDS THE SECOND HALF OF THE QUESTION, because Phase 1 opened a gap (defect D4). The
// pairwise correlations were measured on SAME-WEEK residuals; Phase 1 moved the draw to the season,
// so the sampler coupled season QUALITY and the same-week figure fell from +0.348 to +0.107. The
// within-week permutation stage restores it. Both stages are now measured here, together, from ONE
// run of the sampler -- never two, because correlating two facts sampled from two separate runs of
// anything stochastic is how a difference that is entirely yours gets written down as a finding.
//
// `--no-week` disables the within-week stage: the fault-injection arm, and the before/after pair.
import { readFileSync } from "node:fs";
import { prepare, sampleSeason, weekOf } from "../src/draft/bootstrap.ts";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const WEEK_STAGE = !has("--no-week");
if (val("--coupling", null)) process.env.FF_WEEKLY_COUPLING = val("--coupling", null);

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
// (QB-WR +0.348, QB-TE +0.223). If a marginal is going to be distorted anywhere, it is here. A
// second team carries the K/DST pair (+0.224), the other mechanism in the matrix.
const players = [
  { name: "QB1", pos: "QB", team: "AAA", rank: 3 },
  { name: "WR1", pos: "WR", team: "AAA", rank: 5 },
  { name: "TE1", pos: "TE", team: "AAA", rank: 4 },
  { name: "K1", pos: "K", team: "CCC", rank: 5 },
  { name: "DST1", pos: "DST", team: "CCC", rank: 5 },
  { name: "RB_lone", pos: "RB", team: "BBB", rank: 8 },   // uncoupled control
];
const prep = prepare(players, outcomes, corr, "none");

const N = 20000;
const drawn = new Map(players.map((p) => [p.name, []]));
const seasonTotals = new Map(players.map((p) => [p.name, []]));
// SAME-WEEK series, one entry per (trial, week), for every player at once -- so every pairwise
// same-week correlation below comes from the SAME invocation and the same draws.
const weekly = new Map(players.map((p) => [p.name, []]));
const gaussWeek = WEEK_STAGE ? () => gauss() : undefined;
for (let i = 0; i < N; i++) {
  const sn = sampleSeason(players, prep, gauss, rng, gaussWeek);
  const len = Math.max(...players.map((p) => sn.get(p)?.weeks.length ?? 0));
  for (const p of players) {
    const t = sn.get(p);
    seasonTotals.get(p.name).push(t ? t.total : 0);
    for (let w = 1; w <= len; w++) {
      const x = weekOf(t, w);
      drawn.get(p.name).push(x);
      weekly.get(p.name).push(x);
    }
  }
}

const q = (sorted, u) => {
  const i = (sorted.length - 1) * u, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const pear = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};

console.log(`${N} correlated seasons; within-week stage ${WEEK_STAGE ? `ON (coupling ${process.env.FF_WEEKLY_COUPLING ?? "default"})` : "OFF"}\n`);
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
const PAIRS = [
  ["QB1", "WR1", "QB-WR", 0.35],
  ["QB1", "TE1", "QB-TE", 0.22],
  ["K1", "DST1", "K-DST", 0.22],
];
console.log(`\n  SAME-WEEK correlation (the quantity the model was FITTED on):`);
console.log(`    pair     target   same-week   season-total   fitted`);
const sameWeek = {};
for (const [a, b, label, target] of PAIRS) {
  const w = pear(weekly.get(a), weekly.get(b));
  const s = pear(seasonTotals.get(a), seasonTotals.get(b));
  sameWeek[label] = w;
  const fit = corr.pairs[label] ?? 0;
  const ok = Math.abs(w - target) <= 0.05 ? "" : "   <-- off target";
  console.log(`    ${label.padEnd(8)} ${target.toFixed(2).padStart(6)}   ${w.toFixed(3).padStart(9)}   ${s.toFixed(3).padStart(12)}   ${fit.toFixed(3).padStart(6)}${ok}`);
}
console.log(`    cross-team control, QB1 vs RB_lone (must be ~0):  ` +
  `same-week ${pear(weekly.get("QB1"), weekly.get("RB_lone")).toFixed(3)}   ` +
  `season ${pear(seasonTotals.get("QB1"), seasonTotals.get("RB_lone")).toFixed(3)}`);

console.log(`\n  SEASON-TOTAL sd, drawn vs the pool's own seasons (the statistic Phase 1 fixed):`);
for (const p of players) {
  const pool = prep.pools.get(p).map((t) => t.total);
  const ps = sdOf(pool), ds = sdOf(seasonTotals.get(p.name));
  const off = Math.abs(ds - ps) / (ps || 1);
  console.log(`    ${p.name.padEnd(9)} pool sd ${ps.toFixed(1).padStart(6)}   drawn sd ${ds.toFixed(1).padStart(6)}   ` +
    `${(100 * off).toFixed(1)}%${off > 0.15 ? "   <-- outside 15%" : ""}`);
}

console.log(`\n  worst quantile error, as a share of each player's own p10-p90 span: ${(100 * worst).toFixed(2)}%`);
console.log(worst < 0.02
  ? `  MARGINALS PRESERVED -- a per-player interval can be computed from the pool directly.
  That is not a shortcut: it is the same distribution, computed exactly instead of sampled.
  The correlated sim remains REQUIRED for anything JOINT -- P(A > B) for teammates, team
  totals, playoff and title odds -- where the coupling above is the whole point.`
  : `  MARGINALS DISTORTED -- intervals must come from the full correlated simulation.`);
