// BACKTEST 1 -- LINEUP REGRET AGAINST REAL MANAGERS.
//
//   node --import tsx scripts/inseason-backtest-lineup.mjs [--seasons 2018-2025] [--league <id>]
//                                                          [--artifact <path>]
//
// `--artifact <path>` points the CHALLENGER arm at a named artifact file instead of
// `data/weekly-artifact.json` (WP16b). The floor arm keeps its own file -- it is the reference the
// other arms are read against. It exists because until it did, the only way to score a candidate weekly model
// against real managers was to copy it over `data/weekly-artifact.json` first -- i.e. to promote it
// in order to measure it (docs/weekly-ecr-screen-2026-09-16.md section 6). The SERVED arm refuses the
// override and says so: that arm is the per-position TABLE, and one file applied to all six positions
// under the name "served" would be a number about a mapping nobody is served.
//
// WHICH LEAGUE (D-2, 2026-09-16 -- D25.2's fix applied to this sibling). `ORDER BY last_synced_at DESC
// LIMIT 1` returns whichever league synced last, not the ACTIVE one; on this store that is Yahoo
// 129048, which holds no `fact_roster_week` rows for these seasons, so every number below would have
// been computed over ZERO team-weeks and printed as a result. Now: the one resolver, `--league <id>`,
// and a refusal on an empty set.
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
import { formatServeTable, WEEKLY_SERVE, STREAM_SERVE_POS, STREAMING_ARTIFACT } from "../src/weekly/streamingServe.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);

const db = new Database("data/ff.db");
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-lineup");

// The named artifact, if any. It reaches the two FILE arms; `served` keeps its own table, so one run
// prints "this candidate" beside "what the live mapping scores" rather than two runs of two scripts.
const artifactPath = arg("--artifact", undefined);

const out = {};
for (const model of ["floor", "challenger", "served"]) {
  // The override reaches the CHALLENGER arm only. The floor is the season-line-only REFERENCE the
  // other two arms are read against; pointing it at a candidate too would leave the run with no
  // baseline at all and make every arm agree for the wrong reason (measured: both arms printed the
  // identical 89.07 on the first version of this flag).
  const override = model === "challenger" ? artifactPath : undefined;
  const { rows, summary } = backtestLineups(db, leagueId, { seasons, model, artifactPath: override });
  // AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25.2). With no team-weeks every mean below is
  // NaN/0 and the PRE-REGISTERED lines print HELD/FAILED verdicts about nothing at all.
  if (summary.teamWeeks === 0) {
    console.error(`\nREFUSED: league ${leagueId} has ZERO scored team-weeks over ${seasons[0]}-${seasons[seasons.length - 1]} ` +
      "(no fact_lineup_week / fact_roster_week rows for it). Nothing was measured, so nothing is printed. " +
      "Pass --league <id> for a league with in-season history.");
    process.exit(3);
  }
  out[model] = { summary, boot: seasonBootstrap(rows) };
  // NAME THE FILE THAT PRODUCED THE NUMBER, on the same line as the number. An arm silently reading
  // an overridden artifact is the provenance gap this flag would otherwise create.
  console.log(`\n=== ${model} (${override ?? MODEL_FILES[model]}${override ? "  [--artifact override]" : ""})`);
  if (model === "served") {
    console.log(formatServeTable().split("\n").map((l) => "  " + l).join("\n"));
    if (artifactPath) console.log(`  --artifact is NOT applied to this arm: it is the table above, resolved from data/.`);
  }
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
// Read FROM THE TABLE rather than naming positions by hand, so this line does not go stale the next
// time WEEKLY_SERVE changes -- it already did once, on 2026-09-09, when this said "RB/WR/TE come
// from the floor" and stopped being true.
// GROUP BY THE FILE EACH POSITION ACTUALLY READS. The previous version split the table into
// "streaming" and "everything else" and called the second group "the floor" -- true when those were
// the only two files, and FALSE since (2026-09-14) the streaming artifact stopped serving anywhere:
// it printed "QB/RB/WR/TE/K/DST come from the floor", which is wrong about four positions and about
// DST. Derived from the table, so it cannot go stale the next time the mapping moves.
const byFile = new Map();
for (const p of STREAM_SERVE_POS) {
  const f = WEEKLY_SERVE[p];
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push(p);
}
console.log(`    it is a BLEND of the artifacts the table names, so it sits between the single-artifact arms:`);
for (const [f, pos] of byFile) console.log(`      ${pos.join("/").padEnd(14)} ${f}`);
if (!byFile.has(STREAMING_ARTIFACT)) {
  console.log(`    (the streaming artifact serves NO position today, which is a measurement of the table, not a bug.)`);
}
