// The shipped CONDITIONAL curve against the ORDER-STATISTIC curve it replaced.
//
//   node --import tsx scripts/curve-report.mjs
//
// This is the table docs/validation.md quotes. It exists as a script rather than a pasted table
// because the numbers move whenever history-points.csv is rebuilt, and a pasted table cannot tell
// you that it has gone stale.
import { buildCurveFromHistory, buildConditionalCurve, buildEcrCurve, buildPriorRankCurve } from "../src/data/projections.js";
import { openDb } from "../src/db/db.js";

const SEASON = 2026;
const POS = ["QB", "RB", "WR", "TE"];
const db = openDb("data/ff.db");
const order = buildCurveFromHistory(SEASON);
const { curve: cond, levelFactor, pairs } = buildConditionalCurve(db, SEASON);
const { curve: shape } = buildPriorRankCurve(SEASON);
const ecr = buildEcrCurve(db, SEASON);
db.close();

console.log(`prior-rank shape fitted on ${pairs} season pairs`);
console.log(`ECR level fitted on seasons ${ecr.seasons.join(",")} -- joined ${ecr.joined}, unmatched ${ecr.unmatched}`);
console.log(`  (unmatched = ranked but never scored: a hidden 0 that biases the ECR level UP, so the`);
console.log(`   level correction below is if anything CONSERVATIVE)\n`);
console.log("per-position ECR level factor applied to the prior-rank shape:");
console.log("  " + POS.map((p) => `${p} ${levelFactor[p].toFixed(3)}`).join("   ") + "\n");

console.log("pos  k    orderStat   priorRankShape   ECRcond   SHIPPED conditional   ratio");
for (const pos of POS) {
  for (const k of [1, 2, 3, 5, 8, 12, 16, 20, 24, 30, 36, 48]) {
    const o = order[pos]?.[k - 1], s = shape[pos]?.[k - 1], e = ecr.curve[pos]?.[k - 1], c = cond[pos]?.[k - 1];
    if (o == null || c == null) continue;
    console.log(
      `${pos.padEnd(4)} ${String(k).padStart(2)}   ${o.toFixed(1).padStart(8)} ${(s ?? NaN).toFixed(1).padStart(14)}` +
      ` ${(e == null ? "--" : e.toFixed(1)).padStart(9)} ${c.toFixed(1).padStart(19)}   ${(c / o).toFixed(2)}`);
  }
  console.log();
}

console.log("mean conditional/order-stat ratio over ranks 1-12:");
for (const pos of POS) {
  const r = [];
  for (let k = 0; k < 12; k++) r.push(cond[pos][k] / order[pos][k]);
  console.log(`  ${pos}  ${(r.reduce((a, b) => a + b, 0) / r.length).toFixed(3)}`);
}

// VOR of the #1 player -- the number the entire auction book is scaled from. Baselines per the
// shipped weighted-FLEX fill: QB17 / RB30 / WR36 / TE17.
const base = { QB: 17, RB: 30, WR: 36, TE: 17 };
console.log("\nVOR of the #1 player at each position (baseline = shipped weighted-FLEX fill):");
for (const pos of POS) {
  const a = order[pos][0] - order[pos][base[pos] - 1];
  const b = cond[pos][0] - cond[pos][base[pos] - 1];
  console.log(`  ${pos}: order-stat VOR ${a.toFixed(0).padStart(4)}   conditional VOR ${b.toFixed(0).padStart(4)}   ratio ${(b / a).toFixed(2)}`);
}
