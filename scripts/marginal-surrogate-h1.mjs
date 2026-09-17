// M2i STEP 3 -- H1. Does the LEARNED surrogate order the candidates the way the SIMULATED marginal
// does, on held-out SEASONS, in the three regimes where the analytic surrogate is known to fail?
//
//   node --import tsx scripts/marginal-surrogate-h1.mjs \
//        --test <test-s7.jsonl> --ceiling <test-s11.jsonl> \
//        --artifact data/marginal-surrogate.candidate.json \
//        [--shuffled <shuffled-artifact.json>]
//
// H1, as pre-registered in docs/marginal-surrogate-2026-09-16.md:
//   rank correlation >= 0.60 with the simulated marginal on held-out roster states, after SIX buys,
//   after NINE buys, and in the 37-60 VOR rank band -- against the analytic surrogate's
//   -0.29 / -0.51 / -0.10 (Track G).
//
// FOUR COLUMNS, ONE INVOCATION, THE SAME STATES. `learned`, `analytic`, `ceiling` and (when handed a
// shuffled-label artifact) `shuffled` are computed from ONE read of ONE label file. Nothing here may
// be compared against a number quoted from another run: the label is a stochastic simulation and two
// samples of it differ for reasons that have nothing to do with the surrogate.
//
// THE CEILING IS THE POSITIVE CONTROL AND IT IS NOT DECORATION. It is the simulated marginal against
// ITSELF, re-simulated on the same states at a different book seed. No surrogate can order a
// quantity better than that quantity orders itself, so a ceiling below 0.60 in a regime means H1 is
// UNREACHABLE THERE BY ANY MODEL -- a fact about the label's Monte Carlo floor, not about learning.
// Track G already found 14 of 40 states degenerate at 300 trials; this puts a number on the rest.
//
// DEGENERATE STATES ARE EXCLUDED AND COUNTED. A state whose simulated book is flat at $0 across all
// sixty candidates measures the trial count. Averaging it in would read the Monte Carlo floor as
// agreement -- the rule `scripts/marginal-agreement.mjs` already applies, applied to the same data.
import { readFileSync } from "node:fs";
import { loadMarginalSurrogate, predictSurrogate } from "../src/draft/marginalSurrogate.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const TEST = val("--test", null);
const CEIL = val("--ceiling", null);
const ART = val("--artifact", "data/marginal-surrogate.candidate.json");
const SHUF = val("--shuffled", null);
const THRESHOLD = Number(val("--threshold", "0.60"));
if (!TEST) { console.error("--test <file.jsonl> is required"); process.exit(2); }

const readStates = (p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const key = (s) => `${s.season}|${s.strategy}|${s.seed}|${s.buys}`;

const test = readStates(TEST);
const ceilingBy = new Map();
if (CEIL) for (const s of readStates(CEIL)) ceilingBy.set(key(s), s);

const art = loadMarginalSurrogate(JSON.parse(readFileSync(ART, "utf8")));
const shuf = SHUF ? loadMarginalSurrogate(JSON.parse(readFileSync(SHUF, "utf8"))) : null;

// --- statistics (the same rank/pearson pair the agreement harness uses) ------------------------
const rankOf = (xs) => {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
};
const pearson = (a, b) => {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
};
const spearman = (a, b) => pearson(rankOf(a), rankOf(b));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => (a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : NaN);
const f3 = (x, w = 7) => (Number.isFinite(x) ? x.toFixed(3) : "n/a").padStart(w);

// --- per state, per regime ---------------------------------------------------------------------
/** Rows of a state restricted to a VOR band, or all of them. */
const band = (rows, lo, hi) => (lo == null ? rows : rows.filter((r) => r.vorRank >= lo && r.vorRank <= hi));
/** The usability rule, applied to whatever slice is being scored. */
const usable = (rows) => rows.filter((r) => r.simDollars >= 1).length >= 8;

const REGIMES = [
  { name: "empty", buys: (b) => b === 0, lo: null, hi: null },
  { name: "after3", buys: (b) => b === 3, lo: null, hi: null },
  { name: "after6", buys: (b) => b === 6, lo: null, hi: null },
  { name: "after9", buys: (b) => b === 9, lo: null, hi: null },
  { name: "all states", buys: () => true, lo: null, hi: null },
  { name: "band 1-12", buys: () => true, lo: 1, hi: 12 },
  { name: "band 13-36", buys: () => true, lo: 13, hi: 36 },
  { name: "band 37-60", buys: () => true, lo: 37, hi: 60 },
];

const predictOf = (a, rows) => rows.map((r) => predictSurrogate(a, r.x));

const out = [];
let nDegenerate = 0, nStates = 0, nRows = 0;
for (const reg of REGIMES) {
  const learned = [], analytic = [], ceiling = [], shuffled = [], learnedPp = [];
  let states = 0, skipped = 0;
  for (const st of test) {
    if (!reg.buys(st.buys)) continue;
    const rows = band(st.rows, reg.lo, reg.hi);
    if (rows.length < 3) { skipped++; continue; }
    // The usability rule is applied to the FULL state, not to the band: a band is a slice of one
    // state's simulated book, and a band with seven live rows inside a healthy state is a small
    // sample, not a degenerate measurement.
    if (!usable(st.rows)) { skipped++; continue; }
    states++;
    const sim = rows.map((r) => r.simDollars);
    const simPp = rows.map((r) => r.y);
    const pred = predictOf(art, rows);
    const rl = spearman(pred, sim);
    const ra = spearman(rows.map((r) => r.anaDollars), sim);
    if (Number.isFinite(rl)) learned.push(rl);
    if (Number.isFinite(ra)) analytic.push(ra);
    const rlp = spearman(pred, simPp);
    if (Number.isFinite(rlp)) learnedPp.push(rlp);
    if (shuf) {
      const rs = spearman(predictOf(shuf, rows), sim);
      if (Number.isFinite(rs)) shuffled.push(rs);
    }
    const c = ceilingBy.get(key(st));
    if (c) {
      const byName = new Map(c.rows.map((r) => [r.name, r]));
      const pairs = rows.map((r) => byName.get(r.name)).filter(Boolean);
      if (pairs.length === rows.length && usable(c.rows)) {
        const rc = spearman(sim, pairs.map((r) => r.simDollars));
        if (Number.isFinite(rc)) ceiling.push(rc);
      }
    }
  }
  out.push({ reg: reg.name, states, skipped, learned, analytic, ceiling, shuffled, learnedPp });
}
for (const st of test) { nStates++; nRows += st.rows.length; if (st.degenerate) nDegenerate++; }

// --- report -------------------------------------------------------------------------------------
console.log(`M2i H1 -- the learned surrogate against the simulated marginal, HELD-OUT SEASONS`);
console.log(`  labels   ${TEST}`);
console.log(`  ceiling  ${CEIL ?? "(none supplied -- the positive control is MISSING, say so)"}`);
console.log(`  artifact ${ART}  (${art.meta?.hidden ?? "?"} hidden, trained on ${JSON.stringify(art.meta?.trainSeasons ?? [])})`);
console.log(`  seasons in the scoring file: ${[...new Set(test.map((s) => s.season))].sort().join(", ")}`);
console.log(`  ${nStates} states, ${nRows} rows, ${nDegenerate} DEGENERATE (simulated book flat at $0; excluded and counted)\n`);
console.log(`  rho is the MEAN of the PER-STATE rank correlations against the SIMULATED dollars --`);
console.log(`  never a pooled one, which would mix between-state level differences into a`);
console.log(`  within-state ordering statistic.\n`);

const col = (a) => `${f3(mean(a))} ${`(${a.length})`.padStart(6)}`;
console.log(`  ${"regime".padEnd(12)} ${"states".padStart(6)} ${"LEARNED".padStart(14)} ${"analytic".padStart(14)} ${"CEILING".padStart(14)}${shuf ? " " + "shuffled".padStart(14) : ""}`);
for (const r of out) {
  console.log(`  ${r.reg.padEnd(12)} ${String(r.states).padStart(6)} ${col(r.learned).padStart(14)} ${col(r.analytic).padStart(14)} ${col(r.ceiling).padStart(14)}` +
    (shuf ? ` ${col(r.shuffled).padStart(14)}` : ""));
}

console.log(`\n  SPREAD, so a mean is not read as a point estimate (SD of the per-state rho):`);
for (const r of out) {
  console.log(`  ${r.reg.padEnd(12)} learned SD ${f3(sd(r.learned))}  analytic SD ${f3(sd(r.analytic))}  ceiling SD ${f3(sd(r.ceiling))}`);
}

console.log(`\n  AGAINST THE SIMULATED pp instead of the simulated DOLLARS (the dollar column is the`);
console.log(`  one Track G reports and is a monotone map of pp within a state, so the two differ only`);
console.log(`  through the tie block at $0):`);
for (const r of out) console.log(`  ${r.reg.padEnd(12)} learned-vs-pp ${f3(mean(r.learnedPp))}`);

// --- the registered verdict ---------------------------------------------------------------------
const get = (n) => out.find((r) => r.reg === n);
const gates = [["after6", get("after6")], ["after9", get("after9")], ["band 37-60", get("band 37-60")]];
console.log(`\n  H1 -- registered before any of this was run. Threshold ${THRESHOLD.toFixed(2)}.`);
let held = true;
for (const [name, r] of gates) {
  const m = mean(r.learned), c = mean(r.ceiling);
  const ok = Number.isFinite(m) && m >= THRESHOLD;
  if (!ok) held = false;
  console.log(`    ${name.padEnd(12)} learned ${f3(m)}  (analytic ${f3(mean(r.analytic))}, ceiling ${f3(c)})  -> ${ok ? "HELD" : "FAILED"}` +
    (Number.isFinite(c) && c < THRESHOLD ? `   [CEILING IS BELOW THE THRESHOLD: unreachable by ANY model here]` : ""));
}
console.log(`\n  H1 overall: ${held ? "HELD" : "FAILED"}`);
if (!held) {
  console.log(`  STOP RULE (pre-registered): H1 failed -> the fourth V3 null. The backtest is NOT run.`);
}
if (shuf) {
  const s = mean(get("all states").shuffled);
  console.log(`\n  FAULT INJECTION: the shuffled-label model scores ${f3(s)} over all states. ` +
    `${Math.abs(s) < 0.10 ? "As required (~0)." : "NOT ~0 -- the pipeline is measuring its own feature structure, and every number above is void."}`);
}
