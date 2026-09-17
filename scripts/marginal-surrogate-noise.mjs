// M2i STEP 1b -- WHAT A TRIAL COUNT BUYS. The label is a Monte Carlo estimate, so before any
// surrogate is scored against it the label's own reproducibility has to be measured at the trial
// count the labels were generated with.
//
//   node --import tsx scripts/marginal-surrogate-noise.mjs \
//        --pair 100 <a.jsonl> <b.jsonl> --pair 300 <a.jsonl> <b.jsonl> ...
//
// Each --pair is TWO labellings of THE SAME STATES at the same trial count under DIFFERENT book
// seeds. The statistic is the per-state rank correlation between the two, averaged over the states
// the two runs share -- exactly the CEILING column of `marginal-surrogate-h1.mjs`, computed here at
// several trial counts so the choice of trial count is a measurement rather than a preference.
//
// USABILITY IS REPORTED, NOT ASSUMED. A state whose simulated book is flat at $0 across the candidate
// set measures the trial count; it is counted separately on BOTH sides and excluded from the mean,
// which is the same rule the H1 harness and `scripts/marginal-agreement.mjs` apply.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const pairs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--pair") { pairs.push({ trials: Number(argv[i + 1]), a: argv[i + 2], b: argv[i + 3] }); i += 3; }
}
if (!pairs.length) { console.error("at least one --pair <trials> <a.jsonl> <b.jsonl> is required"); process.exit(2); }

const read = (p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const key = (s) => `${s.season}|${s.strategy}|${s.seed}|${s.buys}`;

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
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "n/a").padStart(7);
const usable = (rows) => rows.filter((r) => r.simDollars >= 1).length >= 8;

console.log("M2i -- LABEL NOISE: the simulated marginal against ITSELF at a second book seed.\n");
console.log(`  ${"trials".padStart(6)} ${"states".padStart(6)} ${"usable".padStart(6)} ${"rho".padStart(7)}  ${"liveRows".padStart(8)}   per-buy rho`);
for (const p of pairs) {
  const A = read(p.a), B = new Map(read(p.b).map((s) => [key(s), s]));
  const rhos = [];
  const byBuys = new Map();
  let usableN = 0, live = 0;
  for (const sa of A) {
    const sb = B.get(key(sa));
    if (!sb) continue;
    live += sa.liveRows;
    if (!usable(sa.rows) || !usable(sb.rows)) continue;
    usableN++;
    const byName = new Map(sb.rows.map((r) => [r.name, r]));
    const xs = [], ys = [];
    for (const r of sa.rows) { const o = byName.get(r.name); if (o) { xs.push(r.simDollars); ys.push(o.simDollars); } }
    const r = spearman(xs, ys);
    if (Number.isFinite(r)) { rhos.push(r); (byBuys.get(sa.buys) ?? byBuys.set(sa.buys, []).get(sa.buys)).push(r); }
  }
  const per = [...byBuys.entries()].sort((a, b) => a[0] - b[0])
    .map(([b, rs]) => `${b}:${mean(rs).toFixed(2)}(${rs.length})`).join(" ");
  console.log(`  ${String(p.trials).padStart(6)} ${String(A.length).padStart(6)} ${String(usableN).padStart(6)} ${f3(mean(rhos))}  ${(live / Math.max(1, A.length)).toFixed(1).padStart(8)}   ${per}`);
}
console.log(`
  rho here is the CEILING for that trial count: no surrogate can order the marginal better than the
  marginal orders itself. A trial count whose rho is far below the H1 threshold cannot produce a
  label H1 is answerable against, whatever the learner does.`);
