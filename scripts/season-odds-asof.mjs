// SEASON ODDS AS THEY WOULD HAVE BEEN COMPUTED ENTERING A PAST WEEK -- the look-back columns of the
// model bump chart (2026-10-06).
//
//   node --import tsx scripts/season-odds-asof.mjs --week W [--league <id>] [--trials 2000] [--seed 7]
//                                                 [--schedule auto|real|generated]
//
// Same simulator and the same defaults as `ff season-odds` (2000 trials, seed 7), on a context built
// with `loadSimContext({ asOfWeek: W })`: standings seeded from weeks 1..W-1 only, rest-of-season
// lines and usage from those weeks only, every team's WEEK-W roster (not today's), and only week W's
// game-day OUT list. What is NOT pinned is stated in simContext.ts beside the option (today's board
// projections; a week-W roster includes moves made during week W). Read-only: writes no snapshot and
// no action_log row -- it is a replay, not a recommendation.
//
// Prints one line, then the JSON `{ teams, assumptions }` -- the same `teams` rows `ff season-odds`
// prints, and the `assumptions.played.nextWeek` / `artifact` fields the bump-chart recorder reads.
import { loadSimContext } from "../src/draft/simContext.ts";
import { seasonOdds } from "../src/inseason/copilot.ts";
import { openDb } from "../src/db/db.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const week = Number(val("--week"));
if (!Number.isInteger(week) || week < 1) {
  console.error("usage: season-odds-asof.mjs --week W [--league <id>] [--trials 2000] [--seed 7] [--schedule auto]");
  process.exit(2);
}
const trials = Number(val("--trials", "2000"));
const seed = Number(val("--seed", "7"));
const schedule = val("--schedule", "auto");
const leagueId = val("--league", null);
const resolvedLeague = (() => {
  const db = openDb();
  try { return resolveLeagueContext(db, leagueId).leagueId; } finally { db.close(); }
})();

const ctx = await loadSimContext({ schedule, leagueId, asOfWeek: week });
const r = seasonOdds(ctx, { trials, seed });
const us = r.teams.find((t) => t.us);
console.log(`season-odds AS OF entering week ${week} (today pinned to ${ctx.played.today}; ${ctx.played.weeks} settled week(s)): ` +
  `us ${(100 * us.playoffs).toFixed(2)}% playoffs, ${(100 * us.champion).toFixed(2)}% title`);
console.log(JSON.stringify({
  teams: r.teams,
  assumptions: {
    pointInTime: { asOfWeek: week, today: ctx.played.today, rosters: `raw_league_roster_week week ${week}`, availability: `raw_gameday_status week ${week} only` },
    artifact: { leagueId: String(resolvedLeague), season: ctx.season },
    schedule: ctx.syntheticSchedule ? "generated" : "real",
    trials, seeds: [seed],
    asOf: new Date().toISOString(),
    played: { weeks: ctx.played.weeks, nextWeek: ctx.played.nextWeek, source: ctx.played.source },
  },
}, null, 2));
