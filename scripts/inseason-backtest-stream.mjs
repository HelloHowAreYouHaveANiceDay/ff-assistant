// Single-position streaming value: does starting the best-available body each week (roster + free
// agents) beat holding your rostered guy? A true weekly-churn measure, our-points-only, point-in-time
// choice / actual score. See src/inseason/backtest/streaming.ts.
//   node --import tsx scripts/inseason-backtest-stream.mjs [--seasons 2018-2025] [--model served|floor] [--pos QB,TE,K,DST]
import { openDb } from "../src/db/db.ts";
import { backtestStreaming } from "../src/inseason/backtest/streaming.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const positions = arg("--pos", "QB,TE,K,DST").split(",").map((s) => s.trim().toUpperCase());
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const t0 = Date.now();
const r = backtestStreaming(db, { leagueId: lg.league_id, seasons, model, positions });
db.close();

console.log(`\nSTREAMING VALUE -- stream best-available vs HOLD your rostered guy, ${model} model, seasons ${seasonsArg}`);
console.log(`  points are per team-week at the position; diff = stream - hold (+ => streaming pays); ceiling = perfect-hindsight streaming (headroom)\n`);
console.log("  pos    hold   stream   diff     CI            P(better)   ceiling   team-weeks");
for (const p of r.positions) {
  console.log(`  ${p.pos.padEnd(5)} ${p.holdPtsPerWeek.toFixed(2).padStart(6)} ${p.streamPtsPerWeek.toFixed(2).padStart(7)} ${p.diffPerWeek.toFixed(2).padStart(6)}   ` +
    `[${p.bootstrap.lo.toFixed(2)}, ${p.bootstrap.hi.toFixed(2)}]`.padEnd(15) + `${(100 * p.bootstrap.pStreamBetter).toFixed(0)}%`.padStart(6) +
    `   ${p.ceilingPtsPerWeek.toFixed(2).padStart(6)}   ${String(p.teamWeeks).padStart(7)}`);
}
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
