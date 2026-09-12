// SURROGATE INDEX -- a high-power stand-in for the near-lottery championship outcome, so THIN edges
// can be resolved on 25 seasons of history that the binary title/berth cannot.
//
//   node scripts/surrogate-index.mjs <baseline.tsv> <treatment.tsv>
//
// WHY (the power problem, measured). The championship is binary and near-lottery: P(title|seed) is a
// coin flip, so a real roster improvement lands in the title column as noise. On our own data the
// consensus edge reads t=1.19 on the playoff berth and t=2.10 on the title -- unresolvable -- while the
// SAME trials give t=4.27 on regular-season points. The continuous, upstream quantities carry the
// signal (surrogate-index literature: Athey-Chetty-Imbens NBER w26463; "Choosing a Proxy Metric",
// arXiv:2309.07893).
//
// THE CATCH the repo already knows (CLAUDE.md): `ff sim` season-points OVER-REWARDS top-heavy rosters --
// they pile up regular-season points and lose in the single-elim playoffs. That is the SURROGATE
// PARADOX. So we do NOT optimize raw points; we fit an INDEX = E[champ | wins, regPoints, playoffs]
// that learns the RIGHT combination. Conditioning on wins and the berth, a top-heavy roster's extra
// points carry little additional title signal, so the fitted index down-weights them -- it is aligned
// by construction, not by assumption. Fit LEAVE-SEASON-OUT so the validation is honest.
//
// WHAT THIS IS NOT (yet): full surrogacy needs the surrogate LIFT to track the champ LIFT across MANY
// interventions (Prentice). We have one contrast here; this validates PREDICTIVE surrogacy + the
// top-heavy guard + the power gain. Cross-intervention validation comes with the lever sweep.
import fs from "node:fs";

const [, , pathA, pathB] = process.argv;
if (!pathA || !pathB) { console.error("usage: surrogate-index.mjs <baseline.tsv> <treatment.tsv>"); process.exit(1); }
const load = (p) => {
  const rows = [];
  for (const l of fs.readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1)) {
    const r = l.split("\t");
    rows.push({ seed: r[1], season: +r[0], champ: +r[2], playoffs: +r[3], wins: +r[4], regPoints: +r[5] });
  }
  return rows;
};
const A = load(pathA), B = load(pathB);   // A = baseline (the index is fit on this), B = treatment

// ---- feature construction -------------------------------------------------------------------------
// The mediators of "did this roster win": games won, points scored, and whether it reached the bracket.
// Standardised on the BASELINE pool so the index is a fixed instrument applied identically to both arms.
const FEATS = ["wins", "regPoints", "playoffs"];
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const stdOf = (x, m) => Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length) || 1;
const mu = {}, sd = {};
for (const f of FEATS) { const col = A.map((r) => r[f]); mu[f] = mean(col); sd[f] = stdOf(col, mu[f]); }
const x = (r) => FEATS.map((f) => (r[f] - mu[f]) / sd[f]);

// ---- logistic regression (ridge, gradient descent) ------------------------------------------------
function fit(rows, l2 = 1e-3, iters = 4000, lr = 0.3) {
  const d = FEATS.length;
  let w = new Array(d).fill(0), b = 0;
  const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (const r of rows) {
      const xi = x(r), p = sig(xi.reduce((s, v, j) => s + v * w[j], b));
      const e = p - r.champ;
      for (let j = 0; j < d; j++) gw[j] += e * xi[j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] = w[j] - lr * (gw[j] / rows.length + l2 * w[j]);
    b = b - lr * (gb / rows.length);
  }
  return { w, b, score: (r) => sig(x(r).reduce((s, v, j) => s + v * w[j], b)) };
}

// ---- LEAVE-SEASON-OUT scores on the baseline (honest predictive validation) ------------------------
const seasonsA = [...new Set(A.map((r) => r.season))].sort();
const losScore = new Map();   // seed -> OOS predicted champ prob
for (const yr of seasonsA) {
  const model = fit(A.filter((r) => r.season !== yr));
  for (const r of A.filter((r) => r.season === yr)) losScore.set(r.seed, model.score(r));
}
// full-data model to SCORE the treatment arm (treatment trials are never in the fit -> already OOS)
const full = fit(A);

// ---- (1) predictive surrogacy: does the index predict the title out of season? ---------------------
const auc = (rows, sc) => {
  const pos = rows.filter((r) => r.champ === 1).map((r) => sc(r));
  const neg = rows.filter((r) => r.champ === 0).map((r) => sc(r));
  let c = 0; for (const p of pos) for (const n of neg) c += p > n ? 1 : p === n ? 0.5 : 0;
  return c / (pos.length * neg.length);
};
const logloss = (rows, sc) => -mean(rows.map((r) => { const p = Math.min(1 - 1e-9, Math.max(1e-9, sc(r))); return r.champ * Math.log(p) + (1 - r.champ) * Math.log(1 - p); }));
const baseRate = mean(A.map((r) => r.champ));
console.log(`\n================ SURROGATE INDEX ================`);
console.log(`  baseline ${A.length} trials, treatment ${B.length} trials; champ base rate ${(100 * baseRate).toFixed(1)}%`);
console.log(`\n(1) PREDICTIVE SURROGACY (leave-season-out on baseline)`);
console.log(`  OOS AUC for the title:  ${auc(A, (r) => losScore.get(r.seed)).toFixed(3)}   (0.5 = useless)`);
console.log(`  OOS log-loss:           ${logloss(A, (r) => losScore.get(r.seed)).toFixed(4)}   vs base-rate ${logloss(A, () => baseRate).toFixed(4)}`);

// ---- (2) top-heavy guard: coefficients (regPoints given wins should be small/non-positive) ---------
console.log(`\n(2) TOP-HEAVY GUARD (coefficients on standardised features; champ ~ .)`);
FEATS.forEach((f, j) => console.log(`  ${f.padEnd(11)} ${full.w[j] >= 0 ? "+" : ""}${full.w[j].toFixed(3)}`));
console.log(`  intercept   ${full.b.toFixed(3)}`);
console.log(`  -> if regPoints is small/<=0 given wins, the index is NOT fooled by raw points inflation.`);

// ---- (3) POWER: the effect on the index vs on the raw metrics (season-paired bootstrap) ------------
function pairedEffect(valOf) {
  const seeds = A.map((r) => r.seed).filter((s) => B.find);   // A and B share seeds (CRN); use A order
  const bMap = new Map(B.map((r) => [r.seed, r]));
  const bySeason = new Map();
  for (const r of A) {
    const bt = bMap.get(r.seed); if (!bt) continue;
    const d = valOf(bt, "B") - valOf(r, "A");
    (bySeason.get(r.season) ?? bySeason.set(r.season, []).get(r.season)).push(d);
  }
  const seasons = [...bySeason.keys()].sort();
  const per = seasons.map((y) => mean(bySeason.get(y)));
  const md = mean(per), s = Math.sqrt(per.reduce((a, v) => a + (v - md) ** 2, 0) / (per.length - 1)), se = s / Math.sqrt(per.length);
  return { effect: md, se, t: se ? md / se : 0, detectable: 2.9 * se, up: per.filter((d) => d > 0).length, n: seasons.length };
}
// score treatment trials with the full baseline-fit model; baseline trials with their LOS score
const idxA = (r) => losScore.get(r.seed);
const idxB = (r) => full.score(r);
const eIdx = pairedEffect((r, arm) => (arm === "A" ? idxA(r) : idxB(r)) * 100);   // index in "champ-prob pp"
const ePo = pairedEffect((r) => r.playoffs * 100);
const eCh = pairedEffect((r) => r.champ * 100);
const eWin = pairedEffect((r) => r.wins);
const eReg = pairedEffect((r) => r.regPoints);
console.log(`\n(3) POWER -- effect of THIS treatment, per metric (season-paired):`);
const row = (name, e, unit) => console.log(`  ${name.padEnd(16)} ${(e.effect >= 0 ? "+" : "") + e.effect.toFixed(unit === "pp" ? 2 : 2)}  ${unit.padEnd(9)} t ${e.t.toFixed(2).padStart(5)}   floor ~${e.detectable.toFixed(2)}   up ${e.up}/${e.n}`);
row("surrogate index", eIdx, "champ-pp");
row("playoffs", ePo, "pp");
row("championship", eCh, "pp");
row("wins", eWin, "wins");
row("regPoints", eReg, "pts");
console.log(`\n  The surrogate index (a fitted, top-heavy-guarded combination) should carry MORE power (higher`);
console.log(`  |t|) than the binary title/berth while staying ALIGNED with the title -- that is the whole`);
console.log(`  point: resolve thin edges the arbiter cannot, without the raw-points paradox.`);
