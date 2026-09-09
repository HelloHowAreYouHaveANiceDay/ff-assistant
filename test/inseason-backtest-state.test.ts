// STEP 2: WEEKLY ROSTER STATE, THE FREE-AGENT POOL, AND THE LEAKAGE GUARD.
//
// THE INVARIANT, stated precisely, because the naive version of it is wrong. Week w's roster
// MEMBERSHIP and slot assignment ARE knowable before week w's first kickoff -- that is exactly when
// a manager sets them, and a backtest that refused to look at them could not evaluate a lineup
// decision at all. Week w's applied POINTS are not knowable. So the guard is:
//
//   perturb week w's points, and every row of every LATER week, and nothing `asOfRosterState`
//   returns for week w may move.
//
// It is fault-injected three ways, because a guard that has only ever returned "clean" is
// indistinguishable from one that is not connected to anything:
//
//   1. POSITIVE CONTROL ON THE PERTURBATION -- the hindsight lineup MUST move when week w's points
//      move. If it does not, the perturbation never reached the data and the null above is
//      measuring nothing.
//   2. POSITIVE CONTROL ON THE DETECTOR -- a deliberately leaky read (the roster of week w+1, which
//      is what "just use the final roster" would give you) MUST be caught as different.
//   3. POSITIVE CONTROL ON THE POSITIVE ANSWER -- the state must be able to return a NON-EMPTY
//      roster against real fixture rows, or every "nothing moved" is trivially true of nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { asOfRosterState, startingTemplate, buildRosterState, buildEspnResolver } from "../src/features/sources/rosterState.js";

const SEASON = 2097;
const LEAGUE = "TESTLG";
const TEAMS = ["1", "2"];
/** 8 starters: QB, RB, WR, TE, FLEX, FLEX, DST, K -- the slot ids ESPN uses for them. */
const START_SLOTS = [0, 2, 4, 6, 23, 23, 16, 17];
const BENCH = [20, 20, 20, 20, 20];
const POS_OF: Record<number, string> = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 23: "RB", 16: "DST", 17: "K", 20: "WR" };

interface Fixture { dir: string; db: DB }

/** A hermetic two-team, three-week league. Its own SQLite file, no network, no real store: a
 *  failure here can only mean the builder is wrong, never that the store changed under it. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ff-inseason-"));
  const db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO league (league_id, platform, season, team_id, last_synced_at) VALUES (?,?,?,?,?)")
    .run(LEAGUE, "espn", SEASON, "1", "2097-01-01");
  const game = db.prepare(
    `INSERT INTO raw_nfl_game (season, game_id, week, gameday, game_type, home_team, away_team, fetched_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (let w = 1; w <= 3; w++) game.run(SEASON, `g${w}`, w, `2097-09-${String(w * 7).padStart(2, "0")}`, "REG", "AAA", "BBB", "now");

  const roster = db.prepare(
    `INSERT INTO raw_league_roster_week VALUES (@l,@s,@w,@t,@p,@n,@pos,@slot,@st,@pts,NULL,NULL,@aof,@aof,@aof,'now')`);
  const feat = db.prepare(
    `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, pts, updated_at) VALUES (?,?,?,?,?,?,?,'now')`);
  const xref = db.prepare("INSERT INTO player_xref (player_sk, source, source_id, created_at) VALUES (?,?,?,'now')");
  const ident = db.prepare("INSERT INTO player_identity (player_sk, name_key, primary_position, created_at) VALUES (?,?,?,'now')");

  // 13 players per team per week, with the same men all season so a week-to-week comparison is a
  // comparison of LINEUPS rather than of rosters.
  const slots = [...START_SLOTS, ...BENCH];
  for (const t of TEAMS) {
    slots.forEach((_, i) => {
      const pid = `${t}${String(i).padStart(2, "0")}`;
      ident.run(Number(pid) + 900000, `player${pid}`, "WR");
      xref.run(Number(pid) + 900000, "espn", pid);
    });
  }
  for (let w = 1; w <= 3; w++) {
    for (const t of TEAMS) {
      slots.forEach((slot, i) => {
        const pid = `${t}${String(i).padStart(2, "0")}`;
        const sk = String(Number(pid) + 900000);
        roster.run({
          l: LEAGUE, s: SEASON, w, t, p: pid, n: `Player ${pid}`, pos: POS_OF[slot], slot,
          st: slot === 20 || slot === 21 ? 0 : 1, pts: null, aof: `2097-09-${String(w * 7).padStart(2, "0")}`,
        });
        // The BENCH scores more than the starters, so the hindsight optimum is strictly above what
        // was started -- a fixture where they are equal cannot tell a working optimiser from a
        // broken one.
        feat.run(sk, sk, SEASON, w, `Player ${pid}`, POS_OF[slot], slot === 20 ? 20 + i : 5 + i);
      });
    }
  }
  return { dir, db };
}

const close = (f: Fixture) => { f.db.close(); rmSync(f.dir, { recursive: true, force: true }); };

/** A stable signature of everything a week-w decision is allowed to see. */
const signature = (db: DB, week: number): string => {
  const s = asOfRosterState(db, LEAGUE, SEASON, week);
  return JSON.stringify({
    asOf: s.asOf, firstKickoff: s.firstKickoff, unresolved: s.unresolved,
    rosters: s.rosters.map((r) => [r.teamId, r.playerSk, r.slot, r.isStarter]).sort(),
  });
};

test("POSITIVE CONTROL ON THE POSITIVE ANSWER: the state returns a real, complete roster", () => {
  const f = fixture();
  try {
    const s = asOfRosterState(f.db, LEAGUE, SEASON, 2);
    assert.equal(s.rosters.length, 26, "two teams of thirteen");
    assert.equal(s.rosters.filter((r) => r.isStarter).length, 16, "eight starters each");
    assert.equal(s.unresolved, 0);
    assert.equal(s.firstKickoff, "2097-09-14");
    assert.equal(s.asOf, "2097-09-07", "the newest information a week-2 decision may use is week 1's last kickoff");
  } finally { close(f); }
});

test("LEAKAGE: perturbing week 2's POINTS moves nothing in week 2's decision state", () => {
  const f = fixture();
  try {
    const before = signature(f.db, 2);
    f.db.prepare("UPDATE feat_player_week_model SET pts = pts * 100 + 7 WHERE season=? AND week=2").run(SEASON);
    f.db.prepare("UPDATE raw_league_roster_week SET applied_points = 999 WHERE season=? AND week=2").run(SEASON);
    assert.equal(signature(f.db, 2), before, "week 2's decision state moved when week 2's points moved -- that is a leak");
  } finally { close(f); }
});

test("LEAKAGE: perturbing every LATER week moves nothing in week 2's decision state", () => {
  const f = fixture();
  try {
    const before = signature(f.db, 2);
    f.db.prepare("UPDATE feat_player_week_model SET pts = pts * -3 WHERE season=? AND week>2").run(SEASON);
    f.db.prepare("DELETE FROM raw_league_roster_week WHERE season=? AND week=3 AND team_id='2'").run(SEASON);
    assert.equal(signature(f.db, 2), before, "week 2's decision state moved when week 3 moved -- that is a leak");
  } finally { close(f); }
});

test("FAULT INJECTION 1 -- the perturbation reaches the data: week 2's hindsight optimum MOVES", () => {
  const f = fixture();
  try {
    buildRosterState(f.db, LEAGUE, [SEASON], { throughAsOf: "2099-01-01" });
    const before = f.db.prepare("SELECT optimal_pts, started_pts FROM fact_lineup_week WHERE season=? AND week=2 AND team_id='1'").get(SEASON) as { optimal_pts: number; started_pts: number };
    assert.ok(before.optimal_pts > before.started_pts, "the fixture's bench outscores its starters, so the optimum must beat what was started");
    f.db.prepare("UPDATE feat_player_week_model SET pts = pts + 50 WHERE season=? AND week=2").run(SEASON);
    buildRosterState(f.db, LEAGUE, [SEASON], { throughAsOf: "2099-01-01" });
    const after = f.db.prepare("SELECT optimal_pts FROM fact_lineup_week WHERE season=? AND week=2 AND team_id='1'").get(SEASON) as { optimal_pts: number };
    assert.notEqual(after.optimal_pts, before.optimal_pts,
      "the hindsight optimum did not move when week 2's points moved -- the perturbation never reached the data, so the leakage nulls above measure nothing");
  } finally { close(f); }
});

test("FAULT INJECTION 2 -- the detector can tell two weeks apart", () => {
  const f = fixture();
  try {
    // A leaky implementation would serve some other week's roster under week 2's number, which is
    // exactly what leagueHistory+mRoster does. Make week 3 differ and confirm the signature notices.
    f.db.prepare("UPDATE raw_league_roster_week SET lineup_slot_id=20, is_starter=0 WHERE season=? AND week=3 AND lineup_slot_id=0").run(SEASON);
    assert.notEqual(signature(f.db, 3), signature(f.db, 2),
      "the signature cannot distinguish two genuinely different weeks -- it would not catch a leak either");
  } finally { close(f); }
});

test("the starting template is DERIVED from the rows, not typed", () => {
  const f = fixture();
  try {
    assert.deepEqual(startingTemplate(f.db, LEAGUE, SEASON), ["QB", "RB", "WR", "TE", "DST", "K", "FLEX", "FLEX"]);
    // Change the league's shape and the template must follow it. An enumerated list would not.
    f.db.prepare("UPDATE raw_league_roster_week SET lineup_slot_id=20, is_starter=0 WHERE season=? AND lineup_slot_id=17").run(SEASON);
    assert.deepEqual(startingTemplate(f.db, LEAGUE, SEASON), ["QB", "RB", "WR", "TE", "DST", "FLEX", "FLEX"]);
  } finally { close(f); }
});

test("the free-agent pool is everyone with a weekly row who is on nobody's roster", () => {
  const f = fixture();
  try {
    // One extra man with a feature row and no roster row anywhere: he is the pool.
    f.db.prepare("INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, pts, updated_at) VALUES (?,?,?,?,?,?,?,'now')")
      .run("FA1", "FA1", SEASON, 2, "Free Agent", "WR", 22);
    buildRosterState(f.db, LEAGUE, [SEASON], { throughAsOf: "2099-01-01" });
    const pool = f.db.prepare("SELECT player_sk, actual_pts FROM fact_fa_pool_week WHERE season=? AND week=2").all(SEASON) as { player_sk: string; actual_pts: number }[];
    assert.deepEqual(pool.map((p) => p.player_sk), ["FA1"], "a rostered player leaked into the free-agent pool, or the pool is empty");
    assert.equal(pool[0].actual_pts, 22);
  } finally { close(f); }
});

test("the resolver reports HOW each id was placed, and refuses a bare name", () => {
  const f = fixture();
  try {
    const r = buildEspnResolver(f.db);
    assert.equal(r.resolve("100", "Player 100", "QB")?.how, "xref");
    // A team defence: ESPN's -16011 is proTeamId 11 is IND. Arithmetic on ESPN's encoding, not a
    // name match -- there is no xref row for a defence and there never will be.
    assert.equal(r.resolve("-16011", "Colts D/ST", "DST")?.sk, "DST:IND");
    // A name with no id and no staging row resolves to NOTHING rather than to a guess.
    assert.equal(r.resolve("999999", "Nobody At All", "WR"), null);
    assert.equal(r.report.unresolved, 1);
    assert.ok(r.report.examples[0].includes("Nobody At All"));
  } finally { close(f); }
});
