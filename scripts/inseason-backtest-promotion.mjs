// BACKTEST 3 -- BACKUP BECOMES STARTER.
//
//   node --import tsx scripts/inseason-backtest-promotion.mjs [--seasons 2018-2024]
//
// 2024 is the last season the weekly depth-chart feed covers; 2025-26 ship a daily snapshot with a
// different schema and no week column (see raw_depth_chart in schema.sql), so the event definition
// used here cannot be applied to them without a date-to-week join this script does not make.
import Database from "better-sqlite3";
import { promotionEvents, summarizeByPosition, crossValidate } from "../src/inseason/backtest/promotion.ts";
import { HANDCUFF_MODEL } from "../src/inseason/handcuff.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2024").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);

const db = new Database("data/ff.db");
const rows = promotionEvents(db, seasons);
db.close();

console.log(`promotion events (depth rank 2 -> 1 with the starter designated OUT), ${lo}-${hi}: ${rows.length}`);
console.log("  season counts:", JSON.stringify(Object.fromEntries(seasons.map((s) => [s, rows.filter((r) => r.season === s).length]))));

console.log("\npos    n   starter t4   backup t4   backup pts wk   next-4 mean   snap% wk   snap% before   lift   share of starter (ratio of means)   mean ratio (t4>=3)");
for (const s of summarizeByPosition(rows)) {
  console.log(`${s.pos.padEnd(4)} ${String(s.n).padStart(3)}   ${String(s.meanStarterT4).padStart(10)}   ${String(s.meanBackupT4).padStart(9)}   ` +
    `${String(s.meanPtsW).padStart(13)}   ${String(s.meanNext4).padStart(11)}   ${String(s.meanSnapPctW ?? "-").padStart(8)}   ${String(s.meanPriorSnapPct ?? "-").padStart(12)}   ` +
    `${String(s.snapLift ?? "-").padStart(5)}   ${String(s.shareOfStarter).padStart(33)}   ${s.meanRatio} (n=${s.ratioN})`);
}

console.log("\n--- THE MODEL, NESTED BY SEASON");
for (const pos of ["RB", "ALL"]) {
  const cv = crossValidate(rows, pos === "ALL" ? undefined : pos);
  if (!cv.folds) { console.log(`  ${pos}: too few events to cross-validate`); continue; }
  console.log(`  ${pos}: n=${cv.n} over ${cv.folds} held-out seasons`);
  console.log(`    RMSE  new model ${cv.rmseNew}   shipped prior ${cv.rmsePrior}   new+backup_t4 ${cv.rmseNewPlusBackup}   constant ${cv.rmseConstant}`);
  console.log(`    fitted: pts = ${cv.coef.intercept} + ${cv.coef.starterT4}*starter_t4 + ${cv.coef.priorSnapPct}*backup_prior_snap_share + ${cv.coef.impliedTotal}*implied_total`);
  console.log(`    prior:  pts = ${HANDCUFF_MODEL.backup}*backup_t4 + ${HANDCUFF_MODEL.lead}*lead_t4`);
  console.log("    per held-out season:", cv.perFold.map((f) => `${f.season}:${f.rmseNew}/${f.rmsePrior}`).join("  "));
  const better = cv.rmseNew < cv.rmsePrior;
  const betterPlus = cv.rmseNewPlusBackup < cv.rmsePrior;
  console.log(`    GATE: replace the prior only on a strict out-of-sample improvement -> ${better ? "PASS" : "FAIL"} (with backup_t4: ${betterPlus ? "PASS" : "FAIL"})`);
}

console.log("\n--- PRE-REGISTERED");
const byPos = Object.fromEntries(summarizeByPosition(rows).map((s) => [s.pos, s]));
const rb = byPos.RB;
if (rb) {
  console.log(`P39 a promoted RB backup posts >= 60% of the departed starter's trailing-4 that week:`);
  console.log(`    ratio of means ${rb.shareOfStarter} -> ${rb.shareOfStarter >= 0.60 ? "HELD" : "FAILED"}   (mean of ratios ${rb.meanRatio} on n=${rb.ratioN})`);
}
console.log("    registered direction for WR and TE: LOWER than RB.");
for (const p of ["WR", "TE"]) {
  const s = byPos[p];
  if (!s) { console.log(`    ${p}: no events`); continue; }
  console.log(`    ${p} ${s.shareOfStarter} vs RB ${rb ? rb.shareOfStarter : "-"} -> ${rb && s.shareOfStarter < rb.shareOfStarter ? "HELD" : "FAILED"}`);
}
