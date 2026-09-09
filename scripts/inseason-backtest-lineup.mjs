// BACKTEST 1 -- LINEUP REGRET AGAINST REAL MANAGERS.
//
//   node --import tsx scripts/inseason-backtest-lineup.mjs [--seasons 2018-2025]
//
// Prints, under BOTH weekly artifacts, what the room started, what hindsight says was available on
// the same rosters, and what our lineup rule would have scored on the same real results.
import Database from "better-sqlite3";
import { backtestLineups, seasonBootstrap } from "../src/inseason/backtest/lineup.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);

const db = new Database("data/ff.db");
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;

const out = {};
for (const model of ["floor", "challenger"]) {
  const { rows, summary } = backtestLineups(db, leagueId, { seasons, model });
  out[model] = { summary, boot: seasonBootstrap(rows) };
  console.log(`\n=== ${model} (${summary.model === "floor" ? "weekly-artifact-lineonly.json" : "weekly-artifact.json"})`);
  console.log(`team-weeks ${summary.teamWeeks}   seasons ${summary.seasons.join(",")}`);
  console.log(`  managers started     ${summary.meanStarted}`);
  console.log(`  hindsight optimum    ${summary.meanOptimal}   (bench left ${summary.meanBenchLeft})`);
  console.log(`  our lineup, scored   ${summary.meanTool}   (left ${summary.meanToolLeft}, gain over the manager ${summary.meanToolGain})`);
  console.log(`  beats that team's own manager in ${(summary.winVsOwnManager * 100).toFixed(1)}% of team-weeks (${summary.ties} exact ties, counted as half)`);
  console.log(`  beats the league's MEDIAN realised lineup in ${(summary.winVsLeagueMedian * 100).toFixed(1)}%`);
  console.log(`  projector had no row for ${(summary.fallbackRate * 100).toFixed(1)}% of rostered men (fell back to points per game through w-1)`);
  if (summary.seasonsWithoutInjuryData.length) console.log(`  NO INJURY BLOCK, availability is bye-only: ${summary.seasonsWithoutInjuryData.join(",")}`);
  const b = out[model].boot;
  console.log(`  season-level bootstrap of the per-team-week gain: ${b.mean} [${b.lo}, ${b.hi}] over ${b.seasons} seasons`);
  console.log("  season   n   started  optimal   tool    win%");
  for (const s of summary.perSeason) {
    console.log(`   ${s.season}  ${String(s.teamWeeks).padStart(3)}  ${String(s.started).padStart(7)}  ${String(s.optimal).padStart(7)}  ${String(s.tool).padStart(6)}  ${(s.win * 100).toFixed(1)}`);
  }
}
db.close();

console.log("\n--- PRE-REGISTERED");
const f = out.floor.summary, c = out.challenger.summary;
console.log(`P36 managers leave >= 8 pts/wk on the bench vs hindsight: ${f.meanBenchLeft} -> ${f.meanBenchLeft >= 8 ? "HELD" : "FAILED"}`);
console.log(`P37 our lineup beats the median manager's realised lineup in >= 60% of team-weeks, CHALLENGER: ${(c.winVsLeagueMedian * 100).toFixed(1)}% -> ${c.winVsLeagueMedian >= 0.60 ? "HELD" : "FAILED"}`);
console.log(`    same under the FLOOR: ${(f.winVsLeagueMedian * 100).toFixed(1)}%`);
console.log(`    paired against each team's OWN manager -- challenger ${(c.winVsOwnManager * 100).toFixed(1)}%, floor ${(f.winVsOwnManager * 100).toFixed(1)}%`);
