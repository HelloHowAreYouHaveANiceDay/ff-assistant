// THE SCORE SURVIVES THE WRITE, and an UNPLAYED week stays NULL rather than becoming a zero.
//
// `raw_league_matchup` carried the pairing and nothing else, so the warehouse could not answer "what
// were the scores" without re-deriving them by summing a started lineup -- a different measurement
// that can be wrong in ways nothing else would reveal. Two nullable REAL columns fix that, and this
// file exists because the two ways they can be wrong are both SILENT:
//
//   1. A POSITIONAL `INSERT ... VALUES (@l,@s,@w,@h,@a,@now)` drops the scores off the end. Nothing
//      throws while the column count still lines up, and every row reads back with NULL scores --
//      indistinguishable from a season nobody has played yet.
//   2. Coalescing an absent score to 0 on the way in. A fantasy team really can score 0, so once
//      that lands there is no way back: an unplayed week and a shutout are the same row.
//
// So every assertion here is made in BOTH directions -- a present score must be exactly the number
// that went in (and must not be NULL), and an absent score must be NULL (and must not be 0).
//
// The store is opened through `openDb`, deliberately, rather than with a hand-rolled CREATE TABLE.
// Duplicating the DDL into a test is what lets the test's idea of the table drift from schema.sql's;
// opening the real store exercises schema.sql AND db.ts's ALTER path, which is the thing under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, type DB } from "../src/db/db.js";
import { loadLeagueHistory } from "../src/data/leagueHistory.js";
import type { LeagueSchedule, SeasonSnapshot } from "../src/league/types.js";

const LEAGUE = "SCORETEST";
const SEASON = 2024;
const FETCHED = "2026-09-18T00:00:00Z";

/** A private temp dir per call -- the repo's shared `.tmp-test` is written by other test files and
 *  a store opened from it concurrently is a different kind of failure than the one under test. */
function scratch(): { dir: string; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ff-matchup-scores-"));
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The minimum season a schedule can hang off. No teams and no picks: this file asserts about the
 *  matchup table only, and rows it does not assert on would only make a failure harder to read. */
function season(): SeasonSnapshot {
  return {
    season: SEASON, available: true, size: 12, auctionBudget: 200, pprPoints: 0.5,
    slotCounts: { QB: 1, RB: 2, WR: 2, TE: 1 }, teams: [], picks: [],
    format: {
      regWeeks: 14, playoffTeams: 6, playoffRoundWeeks: 1, playoffReseed: false,
      seedingRule: "record", divisionCount: 1,
    },
  } as unknown as SeasonSnapshot;
}

function scheduleWithScores(): Record<string, LeagueSchedule> {
  return {
    [String(SEASON)]: {
      divisions: [],
      games: [
        { week: 1, homeId: "1", awayId: "2", homeScore: 112.5, awayScore: 98.25 },
        // A REAL ZERO. This row is the whole reason the column is nullable rather than
        // NOT NULL DEFAULT 0: 0 is a score a team can actually post, so it has to round-trip as the
        // number 0 and stay distinguishable from the unplayed week below.
        { week: 2, homeId: "1", awayId: "3", homeScore: 0, awayScore: 77 },
        // PLAYED ON ONE SIDE ONLY is not a shape we expect, but the columns are independent and the
        // writer must not let one side's number decide the other's.
        { week: 3, homeId: "2", awayId: "3", homeScore: 88, awayScore: null },
        // NOT PLAYED YET, in the same schedule as the played weeks -- the mixed case a live
        // mid-season ingest actually produces.
        { week: 4, homeId: "1", awayId: "2" },
      ],
    },
  };
}

function rows(db: DB) {
  return db.prepare(
    "SELECT week, home_id, away_id, home_score, away_score FROM raw_league_matchup WHERE league_id=? AND season=? ORDER BY week",
  ).all(LEAGUE, SEASON) as { week: number; home_id: string; away_id: string; home_score: number | null; away_score: number | null }[];
}

test("a schedule WITH scores round-trips: every number written is the number read back", () => {
  const { dir, drop } = scratch();
  const db = openDb(join(dir, "ff.db"));
  try {
    const counts = loadLeagueHistory(db, LEAGUE, [season()], scheduleWithScores(), FETCHED);
    assert.equal(counts.games, 4, "all four games written");
    const r = rows(db);
    assert.equal(r.length, 4);

    // POSITIVE DIRECTION: the scores are present and are exactly the values supplied. `notEqual`
    // against null as well as `equal` against the number, because a dropped score reads back as
    // null and `equal(112.5)` alone would be the only thing catching it.
    assert.equal(r[0].home_score, 112.5);
    assert.equal(r[0].away_score, 98.25);
    assert.notEqual(r[0].home_score, null);
    assert.notEqual(r[0].away_score, null);

    // A REAL ZERO IS A SCORE. It must survive as 0 and must not be turned into NULL by any
    // falsy-value guard on the way in (`g.homeScore || null` would do exactly that).
    assert.equal(r[1].home_score, 0);
    assert.notEqual(r[1].home_score, null);
    assert.equal(r[1].away_score, 77);

    // The two columns are independent: one side known, the other not.
    assert.equal(r[2].home_score, 88);
    assert.equal(r[2].away_score, null);

    // The unplayed week in the SAME schedule stays unknown.
    assert.equal(r[3].home_score, null);
    assert.equal(r[3].away_score, null);

    // The pairing itself is unchanged by any of this -- the columns are additive.
    assert.deepEqual(r.map((x) => [x.week, x.home_id, x.away_id]), [
      [1, "1", "2"], [2, "1", "3"], [3, "2", "3"], [4, "1", "2"],
    ]);
  } finally { db.close(); drop(); }
});

test("a schedule WITHOUT scores writes NULL, and NULL is not 0", () => {
  const { dir, drop } = scratch();
  const db = openDb(join(dir, "ff.db"));
  try {
    const sched: Record<string, LeagueSchedule> = {
      [String(SEASON)]: {
        divisions: [],
        games: [{ week: 1, homeId: "1", awayId: "2" }, { week: 2, homeId: "1", awayId: "3" }],
      },
    };
    loadLeagueHistory(db, LEAGUE, [season()], sched, FETCHED);
    const r = rows(db);
    assert.equal(r.length, 2);
    for (const g of r) {
      assert.equal(g.home_score, null, `week ${g.week} home stays unknown`);
      assert.equal(g.away_score, null, `week ${g.week} away stays unknown`);
      // BOTH DIRECTIONS. `equal(null)` passes for undefined too and would not notice a 0 becoming
      // NULL somewhere else, so assert the thing we must never see: a zero standing in for unknown.
      assert.notEqual(g.home_score, 0, `week ${g.week} home must not be a zero`);
      assert.notEqual(g.away_score, 0, `week ${g.week} away must not be a zero`);
    }
    // And SQL agrees, which is the form every downstream reader will actually use: a filter on
    // `IS NOT NULL` finds nothing here, while `> 0` and `IS NULL` would both be satisfied by 0.
    const known = (db.prepare(
      "SELECT COUNT(*) c FROM raw_league_matchup WHERE league_id=? AND home_score IS NOT NULL",
    ).get(LEAGUE) as { c: number }).c;
    assert.equal(known, 0);
  } finally { db.close(); drop(); }
});

test("an EXISTING store without the score columns gains them by migration, with its rows intact", () => {
  const { dir, drop } = scratch();
  const path = join(dir, "ff.db");
  try {
    // A store as it existed BEFORE the columns: the pre-change DDL, spelled out here on purpose,
    // because the point of the test is that a table already in this shape is reachable.
    const old = new Database(path);
    old.exec(`CREATE TABLE raw_league_matchup (
      league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
      home_id TEXT NOT NULL, away_id TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, week, home_id));`);
    old.prepare("INSERT INTO raw_league_matchup VALUES (?,?,?,?,?,?)").run(LEAGUE, SEASON, 1, "1", "2", FETCHED);
    const cols = (d: Database.Database | DB) =>
      (d.prepare("PRAGMA table_info(raw_league_matchup)").all() as { name: string }[]).map((c) => c.name);
    // NEGATIVE DIRECTION FIRST. Without this the test would pass against a store that already had
    // the columns, i.e. it would assert nothing about migrating.
    assert.equal(cols(old).includes("home_score"), false, "pre-migration store has no home_score");
    assert.equal(cols(old).includes("away_score"), false, "pre-migration store has no away_score");
    old.close();

    // schema.sql is CREATE ... IF NOT EXISTS throughout, so the table above is left alone and only
    // db.ts's ALTER path can add the columns. That is exactly what is being asserted.
    const db = openDb(path);
    try {
      assert.equal(cols(db).includes("home_score"), true, "migration added home_score");
      assert.equal(cols(db).includes("away_score"), true, "migration added away_score");
      // The pre-existing row is still there and its scores are UNKNOWN, not zero -- the honest value
      // for a schedule ingested before anything read a score.
      const r = rows(db);
      assert.equal(r.length, 1);
      assert.equal(r[0].home_id, "1");
      assert.equal(r[0].away_score, null);
      assert.notEqual(r[0].home_score, 0);

      // And the migrated store accepts a scored write -- the migration produced a usable column and
      // not merely a name in PRAGMA output.
      loadLeagueHistory(db, LEAGUE, [season()], {
        [String(SEASON)]: { divisions: [], games: [{ week: 1, homeId: "1", awayId: "2", homeScore: 101, awayScore: 0 }] },
      }, FETCHED);
      const after = rows(db);
      assert.equal(after.length, 1);
      assert.equal(after[0].home_score, 101);
      assert.equal(after[0].away_score, 0);
      assert.notEqual(after[0].away_score, null);
    } finally { db.close(); }
  } finally { drop(); }
});
