// CROSS-INTERVENTION SURROGACY (Prentice): does the surrogate-index LIFT track the championship LIFT
// across DIVERSE interventions -- and does it dodge the surrogate PARADOX (this repo's known top-heavy
// bias) that raw regular-season points falls into? This is the gate before optimising levers on the
// index.
//
//   node scripts/surrogate-validate.mjs <baseline.tsv> <label>=<treatment.tsv> [<label>=<t.tsv> ...]
//
// For each intervention we measure the season-paired lift on the TRUE objective (champ), on the raw
// proxy (regPoints), and on the fitted INDEX. Surrogacy HOLDS if index-lift tracks champ-lift across
// interventions BETTER than raw regPoints does -- especially that a top-heavy-favouring lever, which
// inflates regPoints, does NOT fool the index into a positive read the title does not deliver.
import fs from "node:fs";

const args = process.argv.slice(2);
const basePath = args[0];
const treatments = args.slice(1).map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), path: a.slice(i + 1) }; });
const load = (p) => fs.readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
  const r = l.split("\t"); return { seed: r[1], season: +r[0], champ: +r[2], playoffs: +r[3], wins: +r[4], regPoints: +r[5] };
});
const base = load(basePath);
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const stdOf = (x, m) => Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length) || 1;

// ---- fit the index on the baseline (features standardised on baseline) ----------------------------
const FEATS = ["wins", "regPoints", "playoffs"];
const mu = {}, sd = {};
for (const f of FEATS) { const c = base.map((r) => r[f]); mu[f] = mean(c); sd[f] = stdOf(c, mu[f]); }
const x = (r) => FEATS.map((f) => (r[f] - mu[f]) / sd[f]);
function fit(rows, l2 = 1e-3, iters = 4000, lr = 0.3) {
  const d = FEATS.length; let w = new Array(d).fill(0), b = 0; const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (const r of rows) { const xi = x(r), p = sig(xi.reduce((s, v, j) => s + v * w[j], b)), e = p - r.champ; for (let j = 0; j < d; j++) gw[j] += e * xi[j]; gb += e; }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / rows.length + l2 * w[j]); b -= lr * (gb / rows.length);
  }
  return { w, b, score: (r) => sig(x(r).reduce((s, v, j) => s + v * w[j], b)) };
}
const full = fit(base);
// leave-season-out scores for baseline trials (so its own contribution to a lift is honest)
const losScore = new Map();
for (const yr of [...new Set(base.map((r) => r.season))]) { const m = fit(base.filter((r) => r.season !== yr)); for (const r of base.filter((r) => r.season === yr)) losScore.set(r.seed, m.score(r)); }
const idxBase = (r) => losScore.get(r.seed);
const idxTreat = (r) => full.score(r);

// ---- season-paired lift of one metric, treatment vs baseline --------------------------------------
function lift(treat, valBase, valTreat) {
  const bMap = new Map(base.map((r) => [r.seed, r]));
  const bySeason = new Map();
  for (const t of treat) { const b = bMap.get(t.seed); if (!b) continue; (bySeason.get(t.season) ?? bySeason.set(t.season, []).get(t.season)).push(valTreat(t) - valBase(b)); }
  const seasons = [...bySeason.keys()].sort();
  const per = seasons.map((y) => mean(bySeason.get(y)));
  const md = mean(per), s = Math.sqrt(per.reduce((a, v) => a + (v - md) ** 2, 0) / (per.length - 1)), se = s / Math.sqrt(per.length);
  return { effect: md, se, t: se ? md / se : 0 };
}

// ---- run every intervention -----------------------------------------------------------------------
console.log(`\n================ CROSS-INTERVENTION SURROGACY ================`);
console.log(`  baseline ${basePath} (${base.length} trials); index AUC-fit on baseline, features ${FEATS.join("/")}`);
console.log(`  coefficients: ${FEATS.map((f, j) => `${f} ${full.w[j].toFixed(2)}`).join("  ")}\n`);
console.log(`  intervention        champ(pp)  t      index(pp)  t      regPts     t      agree?`);
const pts = [];
for (const { label, path } of treatments) {
  const treat = load(path);
  const ch = lift(treat, (r) => r.champ * 100, (r) => r.champ * 100);
  const ix = lift(treat, (r) => idxBase(r) * 100, (r) => idxTreat(r) * 100);
  const rg = lift(treat, (r) => r.regPoints, (r) => r.regPoints);
  const agreeIdx = Math.sign(ch.effect) === Math.sign(ix.effect) ? "idx=champ" : "IDX<>CHAMP";
  pts.push({ label, ch: ch.effect, ix: ix.effect, rg: rg.effect });
  console.log(
    `  ${label.padEnd(18)} ${(ch.effect >= 0 ? "+" : "") + ch.effect.toFixed(2)}`.padEnd(31) +
    `${ch.t.toFixed(2).padStart(5)}   ${(ix.effect >= 0 ? "+" : "") + ix.effect.toFixed(2)}`.padStart(9) +
    `${ix.t.toFixed(2).padStart(7)}   ${(rg.effect >= 0 ? "+" : "") + rg.effect.toFixed(0)}`.padStart(8) +
    `${rg.t.toFixed(2).padStart(7)}    ${agreeIdx}`,
  );
}
// ---- the surrogacy verdict: index vs raw regPoints as a predictor of the champ lift ----------------
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? n / Math.sqrt(da * db) : 0; };
if (pts.length >= 3) {
  const ch = pts.map((p) => p.ch), ix = pts.map((p) => p.ix), rg = pts.map((p) => p.rg);
  console.log(`\n  Across ${pts.length} interventions, correlation of the LIFT with the champ lift:`);
  console.log(`    surrogate index  r = ${corr(ix, ch).toFixed(3)}`);
  console.log(`    raw regPoints    r = ${corr(rg, ch).toFixed(3)}`);
  console.log(`  Surrogacy holds if the index tracks champ AND beats raw regPoints -- and if no row reads`);
  console.log(`  IDX<>CHAMP (the index disagreeing in sign with the true title on that intervention).`);
} else {
  console.log(`\n  (need >=3 interventions for a cross-intervention correlation; ${pts.length} given -- read the rows.)`);
}
