/**
 * BUILDING ONE LEAGUE'S FACTS MUST NOT TOUCH THE OTHER LEAGUE'S (WP9).
 *
 * WP9 put a SECOND league's rows into `raw_league_roster_week` for the first time. Every reader and
 * writer in `buildRosterState` is supposed to be filtered by `league_id` -- but "supposed to be" was
 * also true of a dozen things this repo's review found unfiltered, and with one league's rows in the
 * store an unfiltered query is indistinguishable from a filtered one. Two leagues in one store is the
 * only condition under which the difference is observable, so this is the test that makes it so.
 *
 * It also pins the ESPN-shape invariant END TO END rather than at the parser: a Yahoo-shaped raw row
 * (namespaced player id, ESPN slot integer, a `pro_team`) goes in, and the three fact tables come out
 * with the same columns and the same meanings as an ESPN row's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../src/db/db.js";
import { loadLeagueRosterWeeks, type RosterWeekFetch } from "../src/data/leagueRosters.js";
import { buildRosterState } from "../src/features/sources/rosterState.js";

const ESPN = "E1", YAHOO = "Y1", SEASON = 2091, WEEK = 1;

/** One team-week in the shape a platform ingester hands the loader. */
function week(teamId: string, players: [string, string, string, number, number, string | null][]): RosterWeekFetch {
  return {
    season: SEASON, week: WEEK, available: true, note: null,
    rows: players.map(([id, name, pos, slot, pts, team]) => ({
      season: SEASON, week: WEEK, teamId, espnPlayerId: id, name, position: pos,
      lineupSlotId: slot, isStarter: slot !== 20 && slot !== 21 ? 1 : 0, appliedPoints: pts,
      acquisitionType: null, acquisitionDate: null, proTeam: team,
    })),
  };
}

function withStore(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ff-wp9-"));
  const db = openDb(join(dir, "t.db"));
  try {
    const now = nowIso();
    // A played week, so `buildRosterState`'s "only completed weeks" cut lets the build through.
    db.prepare("INSERT INTO raw_nfl_game (game_id, season, week, game_type, gameday, as_of, fetched_at) VALUES (?,?,?,?,?,?,?)")
      .run("g1", SEASON, WEEK, "REG", `${SEASON}-09-10`, `${SEASON}-09-10`, now);
    // Two players staged, plus a father/son collision that ONLY the team column can separate.
    let sk = 0;
    for (const [nameKey, pos, team] of [["aplayer", "RB", "BUF"], ["bplayer", "WR", "MIA"], ["cplayer", "WR", "ARI"], ["cplayer", "WR", "IND"]] as [string, string, string][]) {
      // stg_player.player_sk REFERENCES player_identity, so the identity row comes first.
      db.prepare("INSERT INTO player_identity (player_sk) VALUES (?)").run(++sk);
      db.prepare("INSERT INTO stg_player (player_sk, name_key, position, team, ambiguous) VALUES (?,?,?,?,?)")
        .run(sk, nameKey, pos, team, nameKey === "cplayer" ? 1 : 0);
    }
    for (const [k, nm, pos] of [["1", "A Player", "RB"], ["2", "B Player", "WR"], ["3", "C Player", "WR"]] as [string, string, string][]) {
      db.prepare("INSERT INTO feat_player_week_model (season, week, player_sk, name, pos, pts) VALUES (?,?,?,?,?,?)")
        .run(SEASON, WEEK, k, nm, pos, Number(k) * 5);
    }
    // A free agent nobody rosters, so the pool is non-empty and its scoping is observable.
    db.prepare("INSERT INTO feat_player_week_model (season, week, player_sk, name, pos, pts) VALUES (?,?,?,?,?,?)")
      .run(SEASON, WEEK, "4", "Free Man", "RB", 9);
    // ESPN league: ids resolve by name+pos (no xref rows here), slots are ESPN integers.
    loadLeagueRosterWeeks(db, ESPN, [week("8", [
      ["101", "A Player", "RB", 2, 11, null],
      ["102", "B Player", "WR", 20, 3, null],
    ])], now);
    // YAHOO league: namespaced ids, the same ESPN slot integers, and a pro_team that is the only
    // thing able to separate "C Player" (ARI) from his father (IND).
    loadLeagueRosterWeeks(db, YAHOO, [week("11", [
      ["y:9001", "A Player", "RB", 0 + 2, 11, "BUF"],
      ["y:9002", "C Player", "WR", 23, 7, "ARI"],
      ["y:9003", "B Player", "WR", 20, 3, "MIA"],
    ])], now);
    fn(db);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("building the Yahoo league's facts leaves the ESPN league's facts byte-identical", () => {
  withStore((db) => {
    const espnFirst = buildRosterState(db, ESPN, [SEASON], { throughAsOf: `${SEASON}-12-01` });
    assert.ok(espnFirst.rosterRows > 0, "the ESPN build must actually do something");
    const snap = (t: string): string => JSON.stringify(db.prepare(`SELECT * FROM ${t} WHERE league_id=? ORDER BY season, week, rowid`).all(ESPN));
    const before = ["fact_roster_week", "fact_lineup_week", "fact_fa_pool_week"].map(snap);

    const y = buildRosterState(db, YAHOO, [SEASON], { throughAsOf: `${SEASON}-12-01` });
    assert.equal(y.rosterRows, 3, "all three Yahoo men resolve -- the third only via pro_team");
    assert.equal(y.resolve.unresolved, 0);
    assert.ok(y.resolve.byTeam >= 1, "the father/son collision must be broken by the team column");

    const after = ["fact_roster_week", "fact_lineup_week", "fact_fa_pool_week"].map(snap);
    assert.deepEqual(after, before, "the ESPN league's facts moved while building another league's");
  });
});

test("each league's facts hold only its own rows, and a Yahoo row is ESPN-shaped", () => {
  withStore((db) => {
    buildRosterState(db, ESPN, [SEASON], { throughAsOf: `${SEASON}-12-01` });
    buildRosterState(db, YAHOO, [SEASON], { throughAsOf: `${SEASON}-12-01` });
    for (const t of ["fact_roster_week", "fact_lineup_week", "fact_fa_pool_week"]) {
      const ids = db.prepare(`SELECT DISTINCT league_id FROM ${t} ORDER BY league_id`).all() as { league_id: string }[];
      assert.deepEqual(ids.map((r) => r.league_id), [ESPN, YAHOO], `${t} is not partitioned by league`);
    }
    // THE SHAPE INVARIANT: pick the same man off each league's fact_roster_week and compare the
    // columns that carry MEANING. Only the platform's own id and the team differ.
    const cols = (lg: string, team: string) => db.prepare(
      "SELECT pos, slot, lineup_slot_id, is_starter, actual_pts FROM fact_roster_week WHERE league_id=? AND team_id=? AND name='A Player'",
    ).get(lg, team);
    assert.deepEqual(cols(YAHOO, "11"), cols(ESPN, "8"));
    // ...and the starting template the Yahoo week produces is read back as slot NAMES, not "slot23".
    const slots = (db.prepare("SELECT slot FROM fact_roster_week WHERE league_id=? AND is_starter=1 ORDER BY slot").all(YAHOO) as { slot: string }[]).map((r) => r.slot);
    assert.deepEqual(slots, ["FLEX", "RB"]);
  });
});

test("an unresolved ROSTERED man never appears in that league's free-agent pool", () => {
  withStore((db) => {
    // Break the only thing that can resolve "C Player": drop his team from the raw row. Now the name
    // is ambiguous (two staged WRs share it) and he cannot be keyed at all.
    db.prepare("UPDATE raw_league_roster_week SET pro_team=NULL WHERE league_id=? AND name='C Player'").run(YAHOO);
    const y = buildRosterState(db, YAHOO, [SEASON], { throughAsOf: `${SEASON}-12-01` });
    assert.equal(y.resolve.unresolved, 1, "the fault injection must actually break the resolution");
    const pool = (db.prepare("SELECT name FROM fact_fa_pool_week WHERE league_id=?").all(YAHOO) as { name: string }[]).map((r) => r.name);
    assert.ok(pool.includes("Free Man"), "the pool must still contain the genuinely free man");
    assert.ok(!pool.includes("C Player"), "a rostered man we failed to identify was offered as a free agent");
  });
});
