// THE HANDCUFF COUPLING'S OWN GATE -- does the season simulator's re-timing predict what a backup
// actually scores in the weeks his lead is out, better than the independence it replaces?
//
// WHY A SECOND GATE. `season-calibration.mjs` scores playoff-probability calibration over every
// team-season; the coupling only acts on rosters holding a (lead, backup) pair in the lead's missed
// weeks, so that instrument is diluted by construction (D35/9765bb4: effect 1.1 SE, sub-floor, right
// direction). This scores the thing the coupling CHANGES, at the level it changes it, with the repo's
// standard verdict: out of sample, paired by SEASON, 2.9 * SE floor (the handcuff-lift screen's form).
//
// THE PREDICTIONS ARE THE SIMULATOR'S OWN ARITHMETIC. The simulator draws the backup a real season
// and, with coupling ratio R, RE-TIMES it: his season total is conserved and his lead-out weeks carry
// R times the per-week rate of his lead-in weeks. For a pair with n_in weeks beside the lead, n_out
// weeks without him, and season total T (the bootstrap preserves it):
//   independence (R = 1, shipped)   out-week rate = T / (n_in + n_out)
//   coupling R                      out-week rate = T * R / (R * n_out + n_in)
// scored against what he ACTUALLY averaged in the out weeks. R is fitted LEAVE-SEASON-OUT (pooled
// means, per position -- exactly fit-handcuff-coupling.mjs's estimator), so no season scores itself.
//
// CONTROLS: R's deviation from 1 scaled x0 (= independence, must reproduce it exactly), x0.5, x1.5
// and x3. A metric that cannot prefer the right MAGNITUDE over an overshoot would pass a coupling of
// any size; the x3 arm must lose to x1.
//
// Usage: node scripts/handcuff-coupling-gate.mjs [--from 2005] [--to 2025]
import { loadHistory, byeIndex, buildPairs, POS } from "./lib/handcuff-pairs.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2005)), TO = Number(arg("--to", 2025));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const H = loadHistory();
const pairs = buildPairs(H, byeIndex(H), { from: FROM, to: TO, leadMaxRank: 36 })
  .filter((p) => p.leadMissedGames > 0 && p.observedActive != null && p.playedWeeks > 0 && p.activeWeeks > 0 && p.observedBase > 0);
const seasons = [...new Set(pairs.map((p) => p.season))].sort((a, b) => a - b);

// Leave-season-out ratio per (season, pos): pooled means over every OTHER season.
const looR = new Map();
for (const Y of seasons) for (const pos of POS) {
  const rows = pairs.filter((p) => p.pos === pos && p.season !== Y);
  const base = mean(rows.map((p) => p.observedBase)), act = mean(rows.map((p) => p.observedActive));
  looR.set(`${Y}|${pos}`, base > 0 ? act / base : 1);
}

const ARMS = [["indep (shipped)", 0], ["coupling x0.5", 0.5], ["coupling (fitted)", 1], ["coupling x1.5", 1.5], ["coupling x3", 3]];
const predict = (p, scale) => {
  const R = 1 + scale * ((looR.get(`${p.season}|${p.pos}`) ?? 1) - 1);
  const nIn = p.playedWeeks, nOut = p.activeWeeks;
  const T = p.observedBase * nIn + p.observedActive * nOut;
  return (T * R) / (R * nOut + nIn);
};
// Week-weighted absolute error per season: a pair with six out-weeks is six weekly predictions.
const seasonErr = (scale) => new Map(seasons.map((Y) => {
  const rows = pairs.filter((p) => p.season === Y);
  const w = rows.reduce((a, p) => a + p.activeWeeks, 0);
  return [Y, rows.reduce((a, p) => a + p.activeWeeks * Math.abs(predict(p, scale) - p.observedActive), 0) / w];
}));

console.log(`\nHANDCUFF COUPLING GATE -- ${FROM}-${TO}, ${pairs.length} (lead, backup) pairs with a lead absence, ${seasons.length} seasons`);
console.log(`  ${pairs.reduce((a, p) => a + p.activeWeeks, 0)} backup-weeks without the lead; R fitted leave-season-out per position\n`);
const base = seasonErr(0);
console.log("  arm                  MAE/wk   vs indep   mean d     SE      floor    seasons better   verdict");
for (const [label, scale] of ARMS) {
  const e = seasonErr(scale);
  const d = seasons.map((Y) => base.get(Y) - e.get(Y));        // positive = better than independence
  const m = mean(d), se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / Math.max(1, d.length - 1));
  const floor = 2.9 * se, wins = d.filter((x) => x > 0).length;
  const verdict = scale === 0 ? "--" : m > floor ? "ADMIT" : m < -floor ? "REJECT (worse)" : "NULL";
  console.log(`  ${label.padEnd(20)} ${mean([...e.values()]).toFixed(3)}   ${(mean([...base.values()]) - mean([...e.values()])).toFixed(3).padStart(7)}   ${m.toFixed(4).padStart(7)}  ${se.toFixed(4)}  ${floor.toFixed(4)}   ${String(wins).padStart(2)}/${seasons.length}            ${verdict}`);
}
console.log("\n  per position (fitted arm vs independence, week-weighted MAE/wk):");
for (const pos of POS) {
  const rows = pairs.filter((p) => p.pos === pos);
  const w = rows.reduce((a, p) => a + p.activeWeeks, 0);
  const ei = rows.reduce((a, p) => a + p.activeWeeks * Math.abs(predict(p, 0) - p.observedActive), 0) / w;
  const ec = rows.reduce((a, p) => a + p.activeWeeks * Math.abs(predict(p, 1) - p.observedActive), 0) / w;
  console.log(`    ${pos.padEnd(3)} n=${String(rows.length).padStart(4)}  indep ${ei.toFixed(3)}  coupled ${ec.toFixed(3)}  (${(ei - ec >= 0 ? "+" : "")}${(ei - ec).toFixed(3)})`);
}
