// FIT THE SURROGATE TO THE SIMULATOR IT APPROXIMATES.
//
//   node --import tsx scripts/v3-calibrate.mjs [--in data/marginal-agreement.json]
//                                             [--train 1,2,3,4,5,6] [--target sim|shared]
//
// The input is `scripts/marginal-agreement.mjs`'s dump: for each sampled roster state, the analytic
// price V3 actually produced and the simulated marginal it is trying to approximate, on the same
// state, the same pool and the same price function.
//
// THE SELECTION RULE, STATED BEFORE THE NUMBERS, because on this data the obvious metric picks the
// worst map. Four monotone candidates are fitted and scored on held-out seeds:
//
//     identity        no calibration
//     level only      simulated$ ~= exp(a) x analytic$          -- one parameter per position
//     two parameter   simulated$ ~= exp(a) x analytic$^b        -- least squares in logs
//     isotonic        nonparametric, the ceiling any monotone map could reach
//
// and the one that SHIPS is the best held-out MAE among the maps that do not REDUCE held-out rank
// correlation. That second clause is the whole rule. Where the analytic dollars carry little
// magnitude signal, the log-log slope comes out near zero, the map collapses every price toward one
// number, and MAE FALLS because predicting the mean is what minimises MAE when there is no signal --
// while the book it produces prices every player the same and is useless to a bidder. A calibration
// is a LEVEL correction; a map that reorders the book is not calibrating, it is overwriting. And a
// fitted exponent at or below zero is rejected outright: it inverts the position's own book.
//
// THE HOLDOUT IS BY SEED, not by row. Sixty candidates from one roster state are sixty readings of
// the same state -- they share a budget curve, a baseline and a set of random numbers -- so a
// row-level split would put near-duplicates on both sides and report a fit of the noise as a fit.
// Whole drafts go to one side or the other, and the duplicate empty state (identical in every seed)
// is dropped upstream so it cannot appear on both.
//
// ONE FEATURE IS TESTED RATHER THAN ASSUMED: whether a STARTING slot at the man's position is still
// open. It is the split the mechanism argues for -- the analytic and the simulated books disagree
// about a starter for different reasons than they disagree about a bench body -- and it is the only
// one carried into the shipped table, and only if it earns its place on held-out seeds.
//
// NO CHAMPIONSHIP NUMBER ENTERS THIS SCRIPT. The arbiter is not consulted until P28 is re-run.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const IN = val("--in", "data/marginal-agreement.json");
const TARGET = val("--target", "sim") === "shared" ? "shDollars" : "simDollars";
const dump = JSON.parse(readFileSync(IN, "utf8"));

const seeds = [...new Set(dump.states.map((s) => s.seed))].sort((a, b) => a - b);
const TRAIN = new Set((val("--train", null) ?? seeds.slice(0, Math.ceil(seeds.length * 0.6)).join(",")).split(",").map(Number));
const TEST = new Set(seeds.filter((s) => !TRAIN.has(s)));

// Only USABLE states -- a state whose simulated book is flat at zero measures the trial count.
const rowsOf = (which) => dump.states
  .filter((s) => s.usable && which.has(s.seed))
  .flatMap((s) => s.rows.map((r) => ({ ...r, seed: s.seed, phase: s.phase })));
const train = rowsOf(TRAIN), test = rowsOf(TEST);
// A pair is fittable only where BOTH sides are above the dollar floor: log(0) is not a number, and a
// candidate both books price at zero carries no information about the map between them.
const fittable = (r) => r.anaDollars >= 1 && r[TARGET] >= 1;
/** The one feature: is a STARTING slot at his position still open? `openAtPos` counts the dedicated
 *  and FLEX slots he could start in, so zero means the only thing left for him is a bench spot. */
const startOpen = (r) => (r.openAtPos ?? 0) > 0;
const keyOf = (pos, start) => `${pos}:${start ? "start" : "bench"}`;

console.log(`SURROGATE CALIBRATION -- target ${TARGET === "simDollars" ? "per-candidate simulated $" : "shared-exclusion simulated $"}`);
console.log(`  input ${IN}: ${dump.states.length} states, ${dump.states.filter((s) => s.usable).length} usable`);
console.log(`  train seeds ${[...TRAIN].join(",")} (${train.length} rows, ${train.filter(fittable).length} fittable)`);
console.log(`  test  seeds ${[...TEST].join(",")} (${test.length} rows, ${test.filter(fittable).length} fittable)\n`);

// --- statistics --------------------------------------------------------------------------------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rankOf = (xs) => {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
  return r;
};
const pearson = (a, b) => {
  const n = a.length; if (n < 3) return NaN;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
};
const spearman = (a, b) => pearson(rankOf(a), rankOf(b));
const f3 = (x, w) => (Number.isFinite(x) ? x.toFixed(3) : "n/a").padStart(w);
const f2 = (x, w) => (Number.isFinite(x) ? x.toFixed(2) : "n/a").padStart(w);

/** Least squares of log(y) on log(x). Returns null below a stated minimum sample. */
function fitLogLog(rows, minN = 20) {
  const pts = rows.filter(fittable).map((r) => [Math.log(r.anaDollars), Math.log(r[TARGET])]);
  if (pts.length < minN) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, n: pts.length };
}
/** The same, with the exponent pinned at 1: a pure LEVEL shift, and the null the two-parameter fit
 *  has to beat on held-out data before its second parameter is worth having. */
function fitLevelOnly(rows, minN = 20) {
  const pts = rows.filter(fittable).map((r) => [Math.log(r.anaDollars), Math.log(r[TARGET])]);
  if (pts.length < minN) return null;
  return { a: mean(pts.map((p) => p[1] - p[0])), b: 1, n: pts.length };
}
// The SAME guard the shipped `calibrateSurrogateDollars` applies, so a map this script scores is a
// map V3 could actually run. An exponent at or below zero is refused rather than silently inverting.
const apply = (fit, d) => (fit && fit.b > 0 && d > 0 ? Math.exp(fit.a) * Math.pow(d, fit.b) : d);

/** Pool-adjacent-violators isotonic regression on (x, y), as a nonparametric ceiling on what any
 *  monotone map could do. Returned as a step function evaluated by binary search. */
function fitIsotonic(rows, minN = 20) {
  const pts = rows.filter(fittable).map((r) => ({ x: r.anaDollars, y: r[TARGET] })).sort((p, q) => p.x - q.x);
  if (pts.length < minN) return null;
  const blocks = [];
  for (const p of pts) {
    blocks.push({ sum: p.y, n: 1, x: p.x });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ sum: a.sum + b.sum, n: a.n + b.n, x: b.x });
    }
  }
  return (d) => {
    let lo = 0, hi = blocks.length - 1, out = blocks[0].sum / blocks[0].n;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (blocks[m].x <= d) { out = blocks[m].sum / blocks[m].n; lo = m + 1; } else hi = m - 1; }
    return out;
  };
}

const POS = ["QB", "RB", "WR", "TE"];
const byPos = (rows, pos) => rows.filter((r) => r.pos === pos);

// --- the four candidate maps, all fitted on the TRAINING seeds only -----------------------------
const build = (fitter, split) => {
  const t = {};
  for (const pos of POS) {
    if (!split) { const f = fitter(byPos(train, pos)); if (f) t[pos] = f; continue; }
    for (const start of [true, false]) {
      const f = fitter(byPos(train, pos).filter((r) => startOpen(r) === start));
      if (f) t[keyOf(pos, start)] = f;
    }
    const pooled = fitter(byPos(train, pos));
    if (pooled) t[pos] = pooled;               // fallback for a cell that never had enough rows
  }
  return t;
};
const lookup = (t, r, split) => (split ? (t[keyOf(r.pos, startOpen(r))] ?? t[r.pos]) : t[r.pos]);
const mapWith = (t, split) => (r) => apply(lookup(t, r, split), r.anaDollars);

const CANDIDATES = [
  { name: "identity (uncalibrated)", table: {}, split: false, fn: (r) => r.anaDollars },
  { name: "level only", table: build(fitLevelOnly, false), split: false },
  { name: "level only + start/bench", table: build(fitLevelOnly, true), split: true },
  { name: "two parameter x^b", table: build(fitLogLog, false), split: false },
  { name: "two parameter + start/bench", table: build(fitLogLog, true), split: true },
];
for (const c of CANDIDATES) if (!c.fn) c.fn = mapWith(c.table, c.split);
// The isotonic ceiling is scored but never shipped: it is a step function of hundreds of knots and
// there is no honest way to paste it into a source file as a lever somebody can read.
const isoTable = {};
for (const pos of POS) { const f = fitIsotonic(byPos(train, pos)); if (f) isoTable[pos] = f; }

// --- score every candidate on the held-out seeds -------------------------------------------------
const report = (label, rows, mapFn) => {
  const use = rows.filter(fittable);
  if (use.length < 5) return null;
  const before = use.map((r) => r.anaDollars);
  const after = use.map((r) => mapFn(r));
  const truth = use.map((r) => r[TARGET]);
  const lvl = (xs) => mean(xs) / Math.max(1e-9, mean(truth));
  const mae = (xs) => mean(xs.map((v, i) => Math.abs(v - truth[i])));
  const medr = (xs) => median(xs.map((v, i) => v / truth[i]));
  return { label, n: use.length, rho: spearman(after, truth), rhoBefore: spearman(before, truth),
    levelBefore: lvl(before), levelAfter: lvl(after), medBefore: medr(before), medAfter: medr(after),
    maeBefore: mae(before), maeAfter: mae(after) };
};

const baseline = report("identity", test, (r) => r.anaDollars);
console.log(`  HELD OUT (seeds ${[...TEST].join(",")}) -- every candidate map, scored on the same rows`);
console.log(`  ${"map".padEnd(28)} ${"MAE".padStart(8)} ${"rho".padStart(8)} ${"level".padStart(8)} ${"medRatio".padStart(9)}  verdict`);
const scored = [];
for (const c of [...CANDIDATES, { name: "isotonic (not shippable)", fn: (r) => (isoTable[r.pos] ? isoTable[r.pos](r.anaDollars) : r.anaDollars) }]) {
  const r = report(c.name, test, c.fn);
  if (!r) continue;
  // THE RULE, applied rather than described: a map that lowers held-out rank correlation is
  // overwriting the book, not calibrating its level, and is disqualified whatever its MAE.
  const keepsOrder = r.rho >= baseline.rho - 0.01;
  const bad = Object.entries(c.table ?? {}).filter(([, f]) => !(f.b > 0)).map(([k]) => k);
  const verdict = bad.length ? `REJECTED -- non-monotone fit at ${bad.join(", ")}`
    : !keepsOrder ? `REJECTED -- held-out rho falls ${(baseline.rho - r.rho).toFixed(3)}`
    : "eligible";
  scored.push({ ...c, ...r, eligible: !bad.length && keepsOrder });
  console.log(`  ${c.name.padEnd(28)} ${f2(r.maeAfter, 8)} ${f3(r.rho, 8)} ${f3(r.levelAfter, 8)} ${f3(r.medAfter, 9)}  ${verdict}`);
}
const shippable = scored.filter((c) => c.eligible && c.table && Object.keys(c.table).length);
const winner = shippable.sort((a, b) => a.maeAfter - b.maeAfter)[0] ?? null;
console.log(`\n  SHIPPED: ${winner ? winner.name : "NOTHING -- no eligible map, the table stays empty (identity)"}`);

if (winner) {
  console.log(`\n  ${winner.name.toUpperCase()} -- held out, by position`);
  console.log(`  ${"group".padEnd(10)} ${"n".padStart(5)} ${"rho pre".padStart(8)} ${"rho".padStart(7)} ${"lvl pre".padStart(8)} ${"lvl".padStart(7)} ${"MAE pre".padStart(8)} ${"MAE".padStart(7)}`);
  const line = (r) => console.log(`  ${r.label.padEnd(10)} ${String(r.n).padStart(5)} ${f3(r.rhoBefore, 8)} ${f3(r.rho, 7)} ` +
    `${f3(r.levelBefore, 8)} ${f3(r.levelAfter, 7)} ${f2(r.maeBefore, 8)} ${f2(r.maeAfter, 7)}`);
  const a = report("ALL", test, winner.fn);
  if (a) line(a);
  for (const pos of POS) { const r = report(pos, byPos(test, pos), winner.fn); if (r) line(r); }
  if (winner.split) {
    for (const st of [true, false]) {
      const r = report(st ? "start slot" : "bench only", test.filter((x) => startOpen(x) === st), winner.fn);
      if (r) line(r);
    }
  }
  console.log(`\n  PASTE INTO src/draft/lineupMarginal.ts (SURROGATE_CALIBRATION):\n`);
  console.log("export const SURROGATE_CALIBRATION: Record<string, SurrogateFit> = {");
  for (const [k, f] of Object.entries(winner.table).sort()) {
    console.log(`  "${k}": { a: ${f.a.toFixed(6)}, b: ${f.b.toFixed(6)}, n: ${f.n} },`);
  }
  console.log("};");
  console.log(`\n  What it DOES, as a multiplier (b = 1 means one number per cell):`);
  for (const [k, f] of Object.entries(winner.table).sort()) {
    console.log(`    ${k.padEnd(12)} x${Math.exp(f.a).toFixed(3)}${f.b !== 1 ? ` ^${f.b.toFixed(3)}` : ""}   (n=${f.n})`);
  }
}
