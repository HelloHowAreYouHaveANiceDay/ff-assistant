// BACKTEST 1 -- LINEUP REGRET AGAINST REAL MANAGERS.
//
//   node --import tsx scripts/inseason-backtest-lineup.mjs [--seasons 2018-2025]
//
// Prints, under THREE models, what the room started, what hindsight says was available on the same
// rosters, and what our lineup rule would have scored on the same real results.
//
//   floor        weekly-artifact-lineonly.json applied to all six positions
//   challenger   weekly-artifact.json applied to all six positions
//   served       WEEKLY_SERVE -- the per-position table the live seam resolves through, added in
//                integration pass 4. It is the arm that corresponds to what anybody is actually
//                served, and until pass 4 routed `loadWeeklyProjection` through the table there was
//                no such arm: the record's lineup numbers were about two models the copilot did not
//                use. The floor and challenger arms are KEPT, because "does the model help" and
//                "what does the shipped mapping score" are different questions.
import Database from "better-sqlite3";
import { backtestLineups, seasonBootstrap } from "../src/inseason/backtest/lineup.ts";
import { MODEL_FILES } from "../src/inseason/backtest/context.ts";
import { formatServeTable } from "../src/weekly/streamingServe.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);

const db = new Database("data/ff.db");
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;

const out = {};
for (const model of ["floor", "challenger", "served"]) {
  const { rows, summary } = backtestLineups(db, leagueId, { seasons, model });
  out[model] = { summary, boot: seasonBootstrap(rows) };
  console.log(`\n=== ${model} (${MODEL_FILES[model]})`);
  if (model === "served") console.log(formatServeTable().split("\n").map((l) => "  " + l).join("\n"));
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
console.log(`    same under the SERVED mapping: ${(out.served.summary.winVsLeagueMedian * 100).toFixed(1)}%`);
console.log(`    paired against each team's OWN manager -- challenger ${(c.winVsOwnManager * 100).toFixed(1)}%, served ${(out.served.summary.winVsOwnManager * 100).toFixed(1)}%, floor ${(f.winVsOwnManager * 100).toFixed(1)}%`);

// THE ARM THAT SHIPS, stated on its own line so nobody has to work out which of three it is.
const s = out.served.summary;
console.log(`\n--- WHAT THE LIVE SEAM SCORES (WEEKLY_SERVE, the mapping loadWeeklyProjection resolves through)`);
console.log(`    per team-week ${s.meanTool} against the manager's ${s.meanStarted} and hindsight's ${s.meanOptimal}`);
console.log(`    gain over the manager ${s.meanToolGain}; bootstrap ${out.served.boot.mean} [${out.served.boot.lo}, ${out.served.boot.hi}] over ${out.served.boot.seasons} seasons`);
console.log(`    it is BETWEEN the two single-artifact arms by construction: RB/WR/TE come from the floor,`);
console.log(`    QB/K/DST from the streaming artifact, and only the second group differs from the floor arm.`);
