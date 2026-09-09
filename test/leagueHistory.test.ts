// THE LEAGUE'S OWN HISTORY, loaded into raw, asserted against the captured dump.
//
// The dump in test/fixtures is the real ESPN read, taken once through the app's session. Testing
// against it rather than against the network is the point: the assertion is about the LOADER, and a
// test that re-fetches would fail for a reason (expired session, ESPN rate limit) that says nothing
// about the code and would then be disabled.
//
// The three things asserted are the three that look identical whether the loader is right or
// silently wrong: the ROW COUNTS, the per-season DOLLAR TOTALS, and the KEY. The key matters most --
// `pick_no` is in the primary key because ESPN's auction feed gives a pick no id of its own, and
// without it a season's 182 picks collapse to however many DISTINCT PLAYERS it happens to contain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadLeagueHistory, readBackLeagueHistory } from "../src/data/leagueHistory.js";
import type { DB } from "../src/db/db.js";
import type { LeagueSchedule, SeasonSnapshot } from "../src/league/types.js";

interface Dump { fetchedAt: string; currentSeason: number; seasons: SeasonSnapshot[]; schedules: Record<string, LeagueSchedule> }
const DUMP = JSON.parse(readFileSync("test/fixtures/league-history.json", "utf8")) as Dump;
const LEAGUE = "TESTLEAGUE";

/** The five raw tables, created exactly as schema.sql declares them. Duplicated here rather than
 *  read from schema.sql so the test can also express the WRONG key (see the fault injection). */
function rawDb(pickPk = "(league_id,season,pick_no)"): DB {
  const db = new Database(":memory:") as unknown as DB;
  db.exec(`
CREATE TABLE raw_league_season (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, available INTEGER NOT NULL, size INTEGER,
  auction_budget REAL, ppr_points REAL, slot_counts_json TEXT, note TEXT, fetched_at TEXT NOT NULL,
  -- The per-season format columns. In a real store these are added by db.ts's ALTER path rather
  -- than by schema.sql; here the fixture declares them, because the loader must write them.
  reg_weeks INTEGER, playoff_teams INTEGER, playoff_round_weeks INTEGER, playoff_reseed INTEGER,
  seeding_rule TEXT, division_count INTEGER,
  PRIMARY KEY (league_id, season));
CREATE TABLE raw_league_team_season (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, team_id TEXT NOT NULL, name TEXT, owner_id TEXT, owner TEXT,
  acquisitions INTEGER, faab_spent REAL, drops INTEGER, trades INTEGER, lineup_moves INTEGER,
  acquisitions_by_week_json TEXT, wins INTEGER, losses INTEGER, points_for REAL, final_rank INTEGER, playoff_seed INTEGER,
  fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, team_id));
CREATE TABLE raw_league_pick (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, pick_no INTEGER NOT NULL, team_id TEXT, name TEXT NOT NULL,
  pos TEXT, price REAL, owner_id TEXT, owner TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY ${pickPk});
CREATE TABLE raw_league_matchup (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, home_id TEXT NOT NULL, away_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, week, home_id));
CREATE TABLE raw_league_division (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, division_id TEXT NOT NULL, name TEXT, team_ids_json TEXT,
  fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, division_id));`);
  return db;
}

const load = (db: DB) => loadLeagueHistory(db, LEAGUE, DUMP.seasons, DUMP.schedules, DUMP.fetchedAt);

test("the fixture loads to the counts the source dump contains", () => {
  const db = rawDb();
  const c = load(db);
  const srcTeams = DUMP.seasons.reduce((a, s) => a + (s.teams ?? []).length, 0);
  const srcPicks = DUMP.seasons.reduce((a, s) => a + (s.picks ?? []).length, 0);
  const srcGames = Object.values(DUMP.schedules).reduce((a, s) => a + s.games.length, 0);
  assert.equal(c.seasons, DUMP.seasons.length);
  assert.equal(c.teams, srcTeams);
  assert.equal(c.picks, srcPicks);
  assert.equal(c.games, srcGames);
  // The numbers as measured on the captured dump, so a silent shape change is visible as a number.
  assert.equal(c.seasons, 15);
  assert.equal(c.teams, 130);
  assert.equal(c.picks, 1658);
  assert.equal(c.games, 1050);
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  assert.equal(n("raw_league_season"), 15);
  assert.equal(n("raw_league_team_season"), 130);
  assert.equal(n("raw_league_pick"), 1658);
  assert.equal(n("raw_league_matchup"), 1050);
  db.close();
});

test("every season's teams, picks and dollar total match the fixture to the dollar", () => {
  const db = rawDb();
  load(db);
  const checks = readBackLeagueHistory(db, LEAGUE);
  assert.equal(checks.length, DUMP.seasons.length);
  for (const c of checks) {
    const src = DUMP.seasons.find((s) => s.season === c.season)!;
    assert.equal(c.teams, (src.teams ?? []).length, `${c.season} teams`);
    assert.equal(c.picks, (src.picks ?? []).length, `${c.season} picks`);
    assert.equal(c.total, (src.picks ?? []).reduce((a, p) => a + (p.price || 0), 0), `${c.season} total$`);
    assert.equal(c.available, src.available ? 1 : 0, `${c.season} available`);
  }
});

test("a 404 season is recorded as available=0 with its note, never dropped and never thrown", () => {
  const db = rawDb();
  load(db);
  const missing = DUMP.seasons.filter((s) => !s.available).map((s) => s.season);
  assert.ok(missing.length > 0, "the fixture must contain at least one unavailable season");
  for (const yr of missing) {
    const r = db.prepare("SELECT available, note FROM raw_league_season WHERE league_id=? AND season=?")
      .get(LEAGUE, yr) as { available: number; note: string | null };
    assert.equal(r.available, 0);
    assert.ok(r.note && r.note.length > 0, `${yr} must carry the source's own note`);
  }
});

test("the load is idempotent -- re-running upserts rather than duplicating", () => {
  const db = rawDb();
  load(db);
  load(db);
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  assert.equal(n("raw_league_pick"), 1658);
  assert.equal(n("raw_league_team_season"), 130);
  db.close();
});

// A season in which one player appears twice. MEASURED, not assumed: the captured dump contains
// zero repeated (season, name) pairs across all 1,658 picks, so the real data alone cannot
// distinguish a pick_no key from a name key -- which is exactly why the guard needs a case that can.
function duplicatePickSeason(): SeasonSnapshot[] {
  return [{
    season: 2099, available: true, size: 2, auctionBudget: 200, pprPoints: 0.5, slotCounts: {},
    teams: [],
    picks: [
      { teamId: "1", name: "Repeat Player", pos: "RB", price: 30, ownerId: "o1", owner: "A" },
      { teamId: "2", name: "Repeat Player", pos: "RB", price: 12, ownerId: "o2", owner: "B" },
    ],
  }];
}

test("the key keeps a player drafted twice in one season as two rows", () => {
  const db = rawDb();
  loadLeagueHistory(db, LEAGUE, duplicatePickSeason(), {}, "2099-01-01T00:00:00Z");
  const rows = db.prepare("SELECT pick_no, price FROM raw_league_pick WHERE season=2099 ORDER BY pick_no")
    .all() as { pick_no: number; price: number }[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.pick_no, r.price]), [[1, 30], [2, 12]]);
  db.close();
});

// FAULT INJECTION. Drop pick_no from the primary key -- key the table on (league_id, season, name),
// the "natural" key anyone would reach for -- and the SAME load must stop working. It does: the
// second pick of the same player violates the name key. Without this the test above is only a
// statement that two rows went in, which a name-keyed table would also satisfy on any season where
// no player repeats, i.e. every season we currently hold.
test("FAULT: a name-keyed pick table cannot hold a repeated player", () => {
  // The bad table keeps a UNIQUE on the real key so the loader's ON CONFLICT clause still resolves;
  // the PRIMARY KEY is the broken one. Anything less and the failure would be a SQL error about the
  // upsert rather than about the key under test.
  const bad = new Database(":memory:") as unknown as DB;
  bad.exec(`CREATE TABLE raw_league_pick (
    league_id TEXT NOT NULL, season INTEGER NOT NULL, pick_no INTEGER NOT NULL, team_id TEXT, name TEXT NOT NULL,
    pos TEXT, price REAL, owner_id TEXT, owner TEXT, fetched_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, name),
    UNIQUE (league_id, season, pick_no));
  CREATE TABLE raw_league_season (
    league_id TEXT NOT NULL, season INTEGER NOT NULL, available INTEGER NOT NULL, size INTEGER,
    auction_budget REAL, ppr_points REAL, slot_counts_json TEXT, note TEXT, fetched_at TEXT NOT NULL,
    reg_weeks INTEGER, playoff_teams INTEGER, playoff_round_weeks INTEGER, playoff_reseed INTEGER,
    seeding_rule TEXT, division_count INTEGER,
    PRIMARY KEY (league_id, season));
  CREATE TABLE raw_league_team_season (league_id TEXT, season INTEGER, team_id TEXT, name TEXT, owner_id TEXT, owner TEXT,
    acquisitions INTEGER, faab_spent REAL, drops INTEGER, trades INTEGER, lineup_moves INTEGER,
    acquisitions_by_week_json TEXT, wins INTEGER, losses INTEGER, points_for REAL, final_rank INTEGER, playoff_seed INTEGER,
    fetched_at TEXT, PRIMARY KEY (league_id, season, team_id));
  CREATE TABLE raw_league_matchup (league_id TEXT, season INTEGER, week INTEGER, home_id TEXT, away_id TEXT,
    fetched_at TEXT, PRIMARY KEY (league_id, season, week, home_id));
  CREATE TABLE raw_league_division (league_id TEXT, season INTEGER, division_id TEXT, name TEXT, team_ids_json TEXT,
    fetched_at TEXT, PRIMARY KEY (league_id, season, division_id));`);
  assert.throws(
    () => loadLeagueHistory(bad, LEAGUE, duplicatePickSeason(), {}, "2099-01-01T00:00:00Z"),
    /UNIQUE constraint failed: raw_league_pick\.league_id, raw_league_pick\.season, raw_league_pick\.name/,
  );
  bad.close();
});
