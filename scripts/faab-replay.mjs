// BACKTEST 4 -- OUR BID, REPLAYED AGAINST WHAT THE ROOM ACTUALLY PAID.
//
//   node --import tsx scripts/faab-replay.mjs [--seasons 2018-2025] [--target 0.70]
//
// Track B could not price our own claims -- `faabFor` wanted a playoff-probability delta no past
// season can supply. The fitted model does not need one, so this closes that gap: every add our
// ranking recommended, the bid the model would have made for it, and whether that bid beats the
// winning bid the log actually recorded. Ties count as LOSSES; the field does not respond. Both
// limits are in the header of src/inseason/backtest/faab.ts.
import Database from "better-sqlite3";
import { backtestFaab } from "../src/inseason/backtest/faab.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);
const target = Number(arg("--target", "0.70"));

const db = new Database("data/ff.db");
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;
const { rows, summary: s } = backtestFaab(db, leagueId, { seasons, target });

console.log(`=== OUR BID AT A ${(target * 100).toFixed(0)}% TARGET, ${lo}-${hi}`);
console.log(`  adds priced ${s.rows}   of which CONTESTED (somebody else claimed him that week) ${s.contested}`);
console.log(`  realised win rate ${s.winRatePct}%   on the contested subset alone ${s.contestedWinRatePct ?? "n/a"}%`);
console.log(`  ties (scored as LOSSES -- ESPN breaks them on waiver priority) ${s.ties}`);
console.log(`  asks above what we actually had left that week, FLAGGED not capped: ${s.overRemaining}`);
console.log(`  dollars: model $${s.dollarsModel}   rule of thumb $${s.dollarsRule}   saved $${s.dollarsSaved}`);
console.log(`  the ask is BIMODAL: ${s.bidAtFloorPct}% of rows sit at the $1 floor, median $${s.medianBid}`);
console.log(`  CALIBRATION -- mean predicted P(win) at the bid we would have made ${s.meanPredictedWinPct}%, realised ${s.winRatePct}%`);

console.log("\n  season  adds  contested  wins   model $   rule $");
for (const x of s.seasons) {
  console.log(`   ${x.season}  ${String(x.rows).padStart(4)}  ${String(x.contested).padStart(9)}  ${String(x.wins).padStart(4)}` +
    `  ${String("$" + x.model).padStart(8)}  ${String("$" + x.rule).padStart(7)}`);
}

console.log("\n  the contested rows, where money actually did something:");
console.log("  season wk  player                     pos   ours   room   result");
for (const r of rows.filter((x) => x.contested).slice(0, 30)) {
  console.log(`   ${r.season}  ${String(r.week).padStart(2)}  ${String(r.name).slice(0, 24).padEnd(25)} ${r.pos.padEnd(4)} ` +
    `${String("$" + r.bid).padStart(5)}  ${String("$" + r.roomWon).padStart(5)}   ${r.tie ? "TIE (loss)" : r.won ? "win" : "lost"}`);
}

console.log("\n--- PRE-REGISTERED");
const off = Math.abs(s.winRatePct - target * 100);
console.log(`P63 at the ${(target * 100).toFixed(0)}% target the realised win rate is within 10 points of ${(target * 100).toFixed(0)}%:`);
console.log(`    realised ${s.winRatePct}%, off by ${off.toFixed(1)} points -> ${off <= 10 ? "HELD" : "FAILED"}`);
if (off > 10) {
  console.log("    WHY, and it is the same fact the artifact's `bidEffect` records: roughly four claims");
  console.log("    in five in this room are UNCONTESTED, so a target win probability is mostly a");
  console.log("    statement about how often anybody else wants the man, not about what we paid.");
  console.log("    P63 WAS ALSO MIS-SPECIFIED, and it is worth saying rather than quietly rescoring:");
  console.log("    the recommended bid is the SMALLEST that REACHES the target, so wherever P(win) at");
  console.log("    a dollar already clears it the constraint does not bind and the realised rate MUST");
  console.log("    come in above 70%. A target is only testable where money is what gets you there;");
  console.log("    the calibration line above is the question P63 should have asked.");
}
db.close();
