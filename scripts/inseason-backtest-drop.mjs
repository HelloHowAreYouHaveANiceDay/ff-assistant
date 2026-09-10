// Value-min vs depth-aware DROP selection, on real historical rosters. See
// src/inseason/backtest/dropPolicy.ts for the design. Usage:
//   node --import tsx scripts/inseason-backtest-drop.mjs [--seasons 2018-2025] [--model served|floor] [--db path]
import { openDb } from "../src/db/db.ts";
import { backtestDropPolicy } from "../src/inseason/backtest/dropPolicy.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const t0 = Date.now();
const r = backtestDropPolicy(db, { leagueId: lg.league_id, seasons, model });
db.close();

console.log(`\nDROP POLICY BACKTEST -- value-min vs depth-aware, ${model} model, seasons ${seasonsArg}`);
console.log(`  ${r.decisions} (team,week) decisions; the two policies DIFFERED on ${r.differing} (${r.agree} agreed).`);
console.log(`  diff = realized rest-of-season lineup value of [value-min drop] - [depth-aware drop];  + => depth-aware kept the more valuable man.\n`);
console.log("  season   differing   mean diff (pts)");
for (const s of r.perSeason) console.log(`  ${s.season}      ${String(s.differing).padStart(5)}      ${s.meanDiff.toFixed(2).padStart(7)}`);
console.log("");
console.log(`  MEAN diff over differing decisions : ${r.meanDiff.toFixed(3)} pts   (depth-aware ${r.meanDiff > 0 ? "BETTER" : "WORSE"} per differing move)`);
console.log(`  MEAN diff spread over ALL decisions: ${r.meanDiffAll.toFixed(3)} pts`);
console.log(`  season-level 90% CI on the all-decisions mean: [${r.bootstrap.lo.toFixed(3)}, ${r.bootstrap.hi.toFixed(3)}]  P(depth-aware better) = ${(100 * r.bootstrap.pDepthBetter).toFixed(0)}%`);
console.log("");
console.log(`  POSITIVE CONTROL -- value-min minus DROP-THE-BEST-PLAYER: ${r.controlDropStarterMeanDiff.toFixed(1)} pts`);
console.log(`    (must be strongly NEGATIVE: dropping your best player forfeits real lineup points, proving the harness scores realized value.)`);
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
