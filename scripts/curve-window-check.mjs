// Is the expanding-window conditional curve actually POPULATED for every backtested season?
//
//   node --import tsx scripts/curve-window-check.mjs
//
// The guard that gates a season into the conditional arm counts season PAIRS. That is not the same
// question as "did a curve come out": the per-rank minimum-observation rule can empty the curve on a
// short window, and an empty curve falls back to raw actuals -- i.e. to the BASELINE, silently, in a
// run that reports itself as the conditional arm. Two arms then produce identical numbers for those
// seasons and it reads as "no effect" rather than "not connected".
import { buildConditionalCurve } from "../src/data/projections.js";
import { openDb } from "../src/db/db.js";

const db = openDb("data/ff.db");
console.log("season  pairs   curve length per position (0 = EMPTY -> falls back to raw actuals)");
for (let yr = 2003; yr <= 2024; yr++) {
  const { curve, pairs, levelFactor } = buildConditionalCurve(db, yr, "data/history-points.csv", yr);
  const lens = ["QB", "RB", "WR", "TE"].map((p) => `${p} ${String(curve[p]?.length ?? 0).padStart(3)}`).join("  ");
  const lf = ["QB", "RB", "WR", "TE"].map((p) => (levelFactor[p] ?? 1).toFixed(2)).join("/");
  console.log(`  ${yr}   ${String(pairs).padStart(4)}   ${lens}   levelFactor ${lf}`);
}
db.close();
