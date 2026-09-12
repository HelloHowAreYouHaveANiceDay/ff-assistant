// STATE-Phi vs OUTCOME-Phi: is a value function of the roster STATE (projected structure, knowable at
// decision time) a viable potential Phi = E[champ | state] for the unified evaluation model? Three
// decisive checks before anything depends on it (docs/redesign/unified-evaluation-model.md #4):
//   (1) AUC GAP -- how much champ-predictive power does state-Phi lose vs the hindsight outcome index?
//   (2) PARADOX DISCRIMINATION -- does state-Phi down-weight top-heavy rosters (projHHI coef < 0), and
//       predict champ better than the outcome index on the top-heavy subset?
//   (3) DECISION-TIME SURROGACY -- does the state-Phi LIFT track the champ LIFT across interventions?
//
//   node scripts/state-phi-check.mjs <baseline.tsv> [<label>=<intervention.tsv> ...]
//
// Dump cols: season seed champ playoffs wins regPoints projTotal projStart projBench projHHI
import fs from "node:fs";
const COL = { season: 0, seed: 1, champ: 2, playoffs: 3, wins: 4, regPoints: 5, projTotal: 6, projStart: 7, projBench: 8, projHHI: 9 };
const OUTCOME = ["wins", "regPoints", "playoffs"];   // the hindsight index (current surrogate)
const STATE = ["projTotal", "projStart", "projBench", "projHHI"];   // the value-function candidate

const load = (p) => fs.readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
  const r = l.split("\t"); const o = { seed: r[1], season: +r[0], champ: +r[2] };
  for (const [k, i] of Object.entries(COL)) o[k] = +r[i];
  return o;
});
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sdOf = (x, m) => Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length) || 1;

// logistic regression (ridge, GD) over a named feature set, standardised on the given rows.
function makeModel(rows, feats) {
  const mu = {}, sd = {};
  for (const f of feats) { const c = rows.map((r) => r[f]); mu[f] = mean(c); sd[f] = sdOf(c, mu[f]); }
  const x = (r) => feats.map((f) => (r[f] - mu[f]) / sd[f]);
  const fit = (tr, l2 = 1e-3, iters = 4000, lr = 0.3) => {
    const d = feats.length; let w = new Array(d).fill(0), b = 0; const sig = (z) => 1 / (1 + Math.exp(-z));
    for (let it = 0; it < iters; it++) {
      const gw = new Array(d).fill(0); let gb = 0;
      for (const r of tr) { const xi = x(r), p = sig(xi.reduce((s, v, j) => s + v * w[j], b)), e = p - r.champ; for (let j = 0; j < d; j++) gw[j] += e * xi[j]; gb += e; }
      for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / tr.length + l2 * w[j]); b -= lr * (gb / tr.length);
    }
    return { w, b, score: (r) => sig(x(r).reduce((s, v, j) => s + v * w[j], b)) };
  };
  return { feats, mu, sd, fit };
}
const auc = (rows, sc) => {
  const pos = rows.filter((r) => r.champ === 1).map(sc), neg = rows.filter((r) => r.champ === 0).map(sc);
  if (!pos.length || !neg.length) return NaN;
  let c = 0; for (const p of pos) for (const n of neg) c += p > n ? 1 : p === n ? 0.5 : 0;
  return c / (pos.length * neg.length);
};
// leave-season-out OOS scores for the baseline rows
function losScores(rows, model) {
  const sc = new Map();
  for (const yr of [...new Set(rows.map((r) => r.season))]) { const m = model.fit(rows.filter((r) => r.season !== yr)); for (const r of rows.filter((r) => r.season === yr)) sc.set(r.seed, m.score(r)); }
  return sc;
}

const [, , basePath, ...rest] = process.argv;
const base = load(basePath);
const interventions = rest.map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), rows: load(a.slice(i + 1)) }; });

const outM = makeModel(base, OUTCOME), stM = makeModel(base, STATE);
const outFull = outM.fit(base), stFull = stM.fit(base);
const outLOS = losScores(base, outM), stLOS = losScores(base, stM);

console.log(`\n================ STATE-Phi vs OUTCOME-Phi (${base.length} baseline trials) ================`);
console.log(`\n(1) AUC GAP -- champ prediction, leave-season-out (0.5 = useless)`);
console.log(`  OUTCOME-Phi [${OUTCOME.join(",")}]:  AUC ${auc(base, (r) => outLOS.get(r.seed)).toFixed(3)}`);
console.log(`  STATE-Phi   [${STATE.join(",")}]:  AUC ${auc(base, (r) => stLOS.get(r.seed)).toFixed(3)}`);

console.log(`\n(2) PARADOX DISCRIMINATION`);
console.log(`  state-Phi coefficients (standardised; projHHI < 0 = down-weights top-heavy):`);
STATE.forEach((f, j) => console.log(`    ${f.padEnd(10)} ${stFull.w[j] >= 0 ? "+" : ""}${stFull.w[j].toFixed(3)}`));
// top-heavy subset = highest-HHI tercile of baseline trials
const byHHI = [...base].sort((a, b) => b.projHHI - a.projHHI);
const topHeavy = byHHI.slice(0, Math.floor(base.length / 3));
console.log(`  on the top-heavy tercile (highest projHHI, ${topHeavy.length} trials, champ rate ${(100 * mean(topHeavy.map((r) => r.champ))).toFixed(1)}%):`);
console.log(`    OUTCOME-Phi AUC ${auc(topHeavy, (r) => outLOS.get(r.seed)).toFixed(3)}   STATE-Phi AUC ${auc(topHeavy, (r) => stLOS.get(r.seed)).toFixed(3)}`);

if (interventions.length) {
  console.log(`\n(3) DECISION-TIME SURROGACY -- lift tracks champ lift? (baseline-fit Phi scores both arms)`);
  const bMap = new Map(base.map((r) => [r.seed, r]));
  const seasonLift = (rows, val) => {
    const bySeason = new Map();
    for (const t of rows) { const b = bMap.get(t.seed); if (!b) continue; (bySeason.get(t.season) ?? bySeason.set(t.season, []).get(t.season)).push(val(t) - val(b)); }
    const per = [...bySeason.keys()].sort().map((y) => mean(bySeason.get(y)));
    const md = mean(per), se = (Math.sqrt(per.reduce((a, v) => a + (v - md) ** 2, 0) / (per.length - 1))) / Math.sqrt(per.length);
    return { effect: md, t: se ? md / se : 0 };
  };
  console.log(`  intervention        champ(pp)  t     outPhi   t     statePhi  t`);
  for (const { label, rows } of interventions) {
    const ch = seasonLift(rows, (r) => r.champ * 100);
    const op = seasonLift(rows, (r) => (r.seed && bMap.has(r.seed) ? (outLOS.get(r.seed) ?? outFull.score(r)) : outFull.score(r)) * 100);
    const sp = seasonLift(rows, (r) => (r.seed && bMap.has(r.seed) ? (stLOS.get(r.seed) ?? stFull.score(r)) : stFull.score(r)) * 100);
    // treatment rows are OOS for the baseline-fit models -> score with full models
    const op2 = seasonLift(rows, (r) => outFull.score(r) * 100), sp2 = seasonLift(rows, (r) => stFull.score(r) * 100);
    console.log(`  ${label.padEnd(18)} ${(ch.effect >= 0 ? "+" : "") + ch.effect.toFixed(2)}`.padEnd(31) + `${ch.t.toFixed(2).padStart(5)}  ${(op2.effect >= 0 ? "+" : "") + op2.effect.toFixed(2)}`.padStart(8) + `${op2.t.toFixed(2).padStart(6)}  ${(sp2.effect >= 0 ? "+" : "") + sp2.effect.toFixed(2)}`.padStart(9) + `${sp2.t.toFixed(2).padStart(6)}`);
    void op; void sp;
  }
}
console.log("");
