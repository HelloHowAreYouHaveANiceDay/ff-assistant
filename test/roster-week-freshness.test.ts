/**
 * THE ROSTER PULL IS ALLOWED TO BE CHEAP, BUT NOT ALLOWED TO BE STALE.
 *
 * `raw_league_roster_week` powers the in-season surfaces -- the lineup serve, the waiver and trade
 * verbs, `fact_roster_week` and everything built on it -- so a wrong row here is wrong everywhere,
 * and the failure mode is the quiet one: the ingest prints its row count and succeeds.
 *
 * TWO DEFECTS ARE PINNED HERE, both found live on league 462233 on 2026-09-18, and both of which a
 * row count cannot see:
 *
 *   1. A PERMANENT CACHE. `espnGet` returned any cache file that existed, forever. ESPN answers a
 *      future `scoringPeriodId` with the roster as it stands NOW, so every one of the season's
 *      eighteen boxscores was a 2026-09-09 snapshot filed under eighteen different week keys. Nine
 *      days of lineup changes later the ingest still re-read those files and still reported success.
 *   2. AN UPSERT WITH NO DELETE. `ON CONFLICT ... DO UPDATE` can add or amend a row but can never
 *      remove one, so a dropped or traded man stayed on his old roster forever, carrying the
 *      `is_starter` he had the day he left.
 *
 * Each test asserts BOTH directions, because a freshness rule that always refetches and a delete
 * that always fires are as broken as ones that never do -- and they read identically in a green run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekPayloadFreshAfter, loadLeagueRosterWeeks, type RosterWeekFetch } from "../src/data/leagueRosters.js";
import { openDb, type DB } from "../src/db/db.js";

// ---------------------------------------------------------------------------------------------
// 1. THE FRESHNESS RULE
// ---------------------------------------------------------------------------------------------

const kick = new Map([
  ["2026|1", { first: "2026-09-10", last: "2026-09-14" }], // settled: last kickoff behind us
  ["2026|2", { first: "2026-09-17", last: "2026-09-21" }], // in progress: last kickoff still ahead
  ["2026|9", { first: "2026-11-05", last: "2026-11-09" }], // entirely in the future
]);
const TODAY = new Date("2026-09-18T12:00:00.000Z");

test("FRESHNESS: an unsettled week is never served from cache, however new the file is", () => {
  // Week 2's last kickoff is 2026-09-21, still ahead of TODAY, so nothing captured for it can be
  // trusted -- the manager is still editing the lineup. The cutoff is "now", so any capture is old.
  const cutoff = weekPayloadFreshAfter(kick, 2026, 2, TODAY);
  assert.ok(cutoff, "an unsettled week must state a cutoff, not opt out of the rule");
  const capturedASecondAgo = new Date(TODAY.getTime() - 1000);
  assert.ok(capturedASecondAgo < cutoff!, "a one-second-old capture of a live week is still stale");

  // And the same for a week that has not started at all.
  const future = weekPayloadFreshAfter(kick, 2026, 9, TODAY);
  assert.ok(future && capturedASecondAgo < future);
});

test("FRESHNESS: a SETTLED week is served from cache -- the rule must be able to say yes", () => {
  // The positive control. A cutoff that can only ever refetch would make every run hit the network
  // for all eighteen weeks forever, which is a different bug that also passes a row-count check.
  const cutoff = weekPayloadFreshAfter(kick, 2026, 1, TODAY);
  assert.ok(cutoff, "a settled week still states a cutoff");
  const capturedAfterTheWeekEnded = new Date("2026-09-16T00:00:00.000Z");
  assert.ok(!(capturedAfterTheWeekEnded < cutoff!), "a capture taken after the week settled is TRUSTED");
});

test("FRESHNESS: a capture taken DURING a now-settled week is refetched exactly once", () => {
  // This is the case that actually bit: the files were written 2026-09-09, before week 1 kicked off.
  // Week 1 is settled today, but its cached payload saw an unplayed week, so it must be refetched.
  const cutoff = weekPayloadFreshAfter(kick, 2026, 1, TODAY)!;
  const capturedBeforeKickoff = new Date("2026-09-09T22:52:00.000Z");
  assert.ok(capturedBeforeKickoff < cutoff, "a pre-kickoff capture of a settled week is stale");
  // A day of slack past the last kickoff: a game that starts the evening of the 14th US-time ends in
  // the 15th UTC, so a file stamped mid-game on the 14th must NOT count as post-settlement.
  assert.ok(new Date("2026-09-14T23:00:00.000Z") < cutoff, "a capture during the last game is stale");
});

test("FRESHNESS: no schedule for the week means NO opinion, not a guess", () => {
  // Returning a cutoff here would hammer ESPN for every week the store cannot date.
  assert.equal(weekPayloadFreshAfter(kick, 2026, 13, TODAY), null);
  assert.equal(weekPayloadFreshAfter(new Map(), 2026, 1, TODAY), null);
});

// ---------------------------------------------------------------------------------------------
// 2. THE ORPHAN DELETE
// ---------------------------------------------------------------------------------------------

const row = (teamId: string, espnPlayerId: string, name: string, isStarter: number, week = 2) => ({
  season: 2026, week, teamId, espnPlayerId, name, position: "WR",
  lineupSlotId: isStarter ? 23 : 20, isStarter, appliedPoints: null,
  acquisitionType: null, acquisitionDate: null,
});
const fetch = (rows: ReturnType<typeof row>[], available = true): RosterWeekFetch =>
  ({ season: 2026, week: 2, available, note: null, rows });

const countRows = (db: DB, teamId: string) => db.prepare(
  "SELECT COUNT(*) c FROM raw_league_roster_week WHERE league_id='L' AND season=2026 AND week=2 AND team_id=?",
).get(teamId) as { c: number };

test("ORPHANS: a man who leaves a roster leaves the WEEK's rows for that roster", () => {
  const db = openDb(":memory:");
  loadLeagueRosterWeeks(db, "L", [fetch([row("8", "111", "Kept", 1), row("8", "222", "Dropped", 1)])], "t0");
  assert.equal(countRows(db, "8").c, 2);

  // He is gone from the next payload. The upsert alone would leave him seated forever.
  const c = loadLeagueRosterWeeks(db, "L", [fetch([row("8", "111", "Kept", 1)])], "t1");
  assert.equal(countRows(db, "8").c, 1, "the dropped man must be removed, not merely not-updated");
  assert.equal(c.removed, 1, "and the removal must be COUNTED, so a run that removes nothing is visible");
  db.close();
});

test("ORPHANS: a man TRADED WITHIN the league leaves his old team -- the (team, player) key", () => {
  // The defect the first version of this delete had. Keyed on `espn_player_id` alone, a traded man
  // is still somewhere in the week's payload, so BOTH his new row and his stale old one are kept and
  // the team that traded him away goes on starting him. Measured live: 112 rows removed, and the
  // receiver still seated on the roster he had left.
  const db = openDb(":memory:");
  loadLeagueRosterWeeks(db, "L", [fetch([row("8", "111", "Traded", 1), row("13", "999", "Other", 1)])], "t0");
  const c = loadLeagueRosterWeeks(db, "L", [fetch([row("13", "111", "Traded", 1), row("13", "999", "Other", 1)])], "t1");
  assert.equal(countRows(db, "8").c, 0, "his old team must not keep him");
  assert.equal(countRows(db, "13").c, 2, "his new team must have him");
  assert.equal(c.removed, 1);
  db.close();
});

test("ORPHANS: an UNAVAILABLE week deletes nothing -- 'could not ask' is not 'nobody is rostered'", () => {
  // The negative control, and the one that protects real history. A failed fetch, an expired session
  // or a season whose games have ended all return an empty list; treating that as truth would erase
  // the week. This is the direction that must NOT fire.
  const db = openDb(":memory:");
  loadLeagueRosterWeeks(db, "L", [fetch([row("8", "111", "Kept", 1), row("8", "222", "AlsoKept", 0)])], "t0");
  const c = loadLeagueRosterWeeks(db, "L", [fetch([], false)], "t1");
  assert.equal(countRows(db, "8").c, 2, "an unavailable week must leave every stored row alone");
  assert.equal(c.removed, 0);
  db.close();
});

test("ORPHANS: the delete is scoped to its own WEEK and LEAGUE", () => {
  // A reconcile of week 2 that reached into week 1 or into another league would be the `DELETE FROM`
  // shape docs/multi-league-refactor.md records as having destroyed other leagues' history before.
  const db = openDb(":memory:");
  loadLeagueRosterWeeks(db, "L", [fetch([row("8", "111", "Kept", 1)])], "t0");
  loadLeagueRosterWeeks(db, "L", [{ ...fetch([row("8", "222", "Week1Man", 1, 1)]), week: 1 }], "t0");
  loadLeagueRosterWeeks(db, "OTHER", [fetch([row("8", "333", "OtherLeague", 1)])], "t0");

  loadLeagueRosterWeeks(db, "L", [fetch([row("8", "444", "AllNew", 1)])], "t1");
  const week1 = db.prepare("SELECT COUNT(*) c FROM raw_league_roster_week WHERE league_id='L' AND week=1").get() as { c: number };
  const other = db.prepare("SELECT COUNT(*) c FROM raw_league_roster_week WHERE league_id='OTHER'").get() as { c: number };
  assert.equal(week1.c, 1, "week 1 is untouched by a week-2 reconcile");
  assert.equal(other.c, 1, "another league is untouched");
  db.close();
});
