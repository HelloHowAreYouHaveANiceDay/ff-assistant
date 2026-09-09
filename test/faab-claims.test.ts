// `fact_waiver_claim` -- the builder, on a fixture league whose right answers are arithmetic.
//
// The three properties worth a test are the three that were wrong at some point while writing it:
//
//   1. THE CLAIMANT. ESPN publishes `teamId = -2147483648` on every 2018 EXECUTED waiver, so
//      reading the claimant off `team_id` drops a whole season's WINNERS and leaves the table
//      looking thin rather than wrong. The fixture reproduces that exact payload.
//   2. THE BUDGET STEPS ONCE PER RUN, NOT ONCE PER CLAIM. Every bid in one waiver run was placed
//      blind to the others, so two claims at the same timestamp must both see the pre-run budget.
//      Charging them in sequence is a leak that looks like careful bookkeeping.
//   3. ONLY EXECUTED DOLLARS LEAVE A BUDGET. A losing bid costs nothing, so a team that was outbid
//      must still have its full budget at the next run.
//
// Plus the semantics the whole track rests on: FAILED_INVALIDPLAYERSOURCE is a LOSING BID, and the
// coverage read-back proves it by the property no other failure mode has reason to satisfy -- one
// winner per contested player-week, and no loser ever above the winner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { buildWaiverClaimsOn, claimantOf, budgetFor, NULL_TEAM } from "../src/features/sources/faab.js";

const SEASON = 2098;

interface TxSpec { tx: string; ms: number; week: number; team: string | null; to: string; pid: string; bid: number; status: string }

function fixture(db: DB, specs: TxSpec[]): void {
  for (let t = 1; t <= 4; t++) {
    db.prepare(`INSERT INTO fact_team_season (league_id, season, team_id, team_name, faab_spent) VALUES ('L',?,?,?,0)`)
      .run(SEASON, String(t), `Team ${t}`);
  }
  // Rosters: four teams, three RB each in every week, so the positional-need median is flat and the
  // need column cannot accidentally carry the signal a bug would put there.
  for (let w = 1; w <= 6; w++) {
    for (let t = 1; t <= 4; t++) {
      for (let k = 0; k < 3; k++) {
        db.prepare(`INSERT INTO fact_roster_week (season, week, team_id, player_sk, espn_player_id, name, pos)
                    VALUES (?,?,?,?,?,?,'RB')`).run(SEASON, w, String(t), `r${t}${k}`, `9${t}${k}`, `Body ${t}${k}`);
      }
    }
  }
  // One claimable player with a preseason line and weekly points, plus a rival at the same position
  // so pos_line_rank has something to order.
  // The surrogate keys are the ones `player_xref` resolves to -- '1' and '2', not names. A fixture
  // that quietly used a different key would join nothing and every feature would read NULL, which
  // is the shape of bug this whole file exists to catch.
  for (const [sk, line] of [["1", 12], ["2", 9]] as [string, number][]) {
    for (let w = 1; w <= 6; w++) {
      db.prepare(`INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, season_line_pg, td_ppg, td_games, t4_mean, pts)
                  VALUES (?,?,?,?,?,'RB',?,?,?,?,?)`)
        .run(`${SEASON}-${w}-${sk}`, sk, SEASON, w, `Player ${sk}`, line, w, w - 1, w, w * 2);
    }
  }
  db.prepare(`INSERT INTO player_identity (player_sk, name_key) VALUES (1,'p1'), (2,'p2')`).run();
  db.prepare(`INSERT INTO player_xref (player_sk, source, source_id) VALUES (1,'espn','101'), (2,'espn','102')`).run();
  for (const s of specs) {
    db.prepare(`INSERT INTO raw_league_transaction
      (league_id, season, week, transaction_id, item_no, type, item_type, executed_at, proposed_at_ms,
       team_id, espn_player_id, from_team_id, to_team_id, bid_amount, status, is_pending, fetched_at)
      VALUES ('L',?,?,?,0,'WAIVER','ADD',?,?,?,?, '-1', ?, ?, ?, 0, 'now')`)
      .run(SEASON, s.week, s.tx, `${SEASON}-01-01 00:00:00`, s.ms, s.team ?? NULL_TEAM, s.pid, s.to, s.bid, s.status);
  }
}

function withDb(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "faab-"));
  const db = openDb(join(dir, "t.db"));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("the claimant survives ESPN's null sentinel on team_id", () => {
  assert.equal(claimantOf({ team_id: NULL_TEAM, to_team_id: "7" }), "7");
  assert.equal(claimantOf({ team_id: "3", to_team_id: "3" }), "3");
  // `from_team_id` on a free-agent add is -1, and -1 is never a team.
  assert.equal(claimantOf({ team_id: "3", to_team_id: "-1" }), "3");
  assert.equal(claimantOf({ team_id: NULL_TEAM, to_team_id: null }), null);
});

test("a waiver run prices every bid in it against the SAME pre-run budget", () => {
  withDb((db) => {
    fixture(db, [
      // Run A, week 2: team 1 wins p1 for $40, team 2 loses at $30. Both see $100.
      { tx: "a1", ms: 1000, week: 2, team: "1", to: "1", pid: "101", bid: 40, status: "EXECUTED" },
      { tx: "a2", ms: 1000, week: 2, team: "2", to: "2", pid: "101", bid: 30, status: "FAILED_INVALIDPLAYERSOURCE" },
      // Run B, week 3: team 1 has spent $40 and must now see $60; team 2 lost, so still $100.
      { tx: "b1", ms: 2000, week: 3, team: "1", to: "1", pid: "102", bid: 5, status: "EXECUTED" },
      { tx: "b2", ms: 2000, week: 3, team: "2", to: "2", pid: "102", bid: 4, status: "FAILED_INVALIDPLAYERSOURCE" },
    ]);
    const r = buildWaiverClaimsOn(db, [SEASON]);
    assert.equal(r.rows, 4);
    const rows = db.prepare("SELECT * FROM fact_waiver_claim ORDER BY proposed_at_ms, transaction_id")
      .all() as Record<string, number | string | null>[];
    assert.deepEqual(rows.map((x) => x.team_faab_left), [100, 100, 60, 100]);
    assert.deepEqual(rows.map((x) => x.won), [1, 0, 1, 0]);
    // The LEAGUE budget steps once per run too: 4 teams * $100, less the $40 that cleared in run A.
    assert.deepEqual(rows.map((x) => x.league_faab_left), [400, 400, 360, 360]);
    // ...and the loser's dollars never leave the pool.
    assert.equal(r.orderViolations, 0);
    assert.equal(r.losingBidsExist, true);
  });
});

test("a 2018-shaped payload -- teamId is the null sentinel -- still yields its winners", () => {
  withDb((db) => {
    fixture(db, [
      { tx: "s1", ms: 1000, week: 2, team: null, to: "3", pid: "101", bid: 18, status: "EXECUTED" },
      { tx: "s2", ms: 1000, week: 2, team: null, to: "4", pid: "102", bid: 6, status: "EXECUTED" },
    ]);
    const r = buildWaiverClaimsOn(db, [SEASON]);
    assert.equal(r.rows, 2);
    assert.deepEqual(r.perSeason[0].winners, 2);
    assert.deepEqual(
      (db.prepare("SELECT team_id FROM fact_waiver_claim ORDER BY transaction_id").all() as { team_id: string }[]).map((x) => x.team_id),
      ["3", "4"]);
  });
});

test("PENDING and CANCELED claims are excluded -- a bid with no outcome is not an outcome", () => {
  withDb((db) => {
    fixture(db, [
      { tx: "p1", ms: 1000, week: 2, team: "1", to: "1", pid: "101", bid: 22, status: "PENDING" },
      { tx: "c1", ms: 1000, week: 2, team: "2", to: "2", pid: "101", bid: 0, status: "CANCELED" },
      { tx: "e1", ms: 1000, week: 2, team: "3", to: "3", pid: "102", bid: 7, status: "EXECUTED" },
      // A rule failure is a real bid that did NOT lose an auction: kept, but with no win/loss.
      { tx: "f1", ms: 1000, week: 2, team: "4", to: "4", pid: "102", bid: 9, status: "FAILED_ROSTERLIMIT" },
    ]);
    const r = buildWaiverClaimsOn(db, [SEASON]);
    assert.equal(r.rows, 2);
    assert.equal(r.perSeason[0].winners, 1);
    assert.equal(r.perSeason[0].losers, 0);
    assert.equal(r.perSeason[0].unscored, 1);
    // ...and the rule failure's $9 never left anybody's budget.
    assert.equal(r.losingBidsExist, false);
  });
});

test("point-in-time columns read the week BEFORE, and the target reads from the week itself", () => {
  withDb((db) => {
    fixture(db, [{ tx: "x1", ms: 1000, week: 4, team: "1", to: "1", pid: "101", bid: 12, status: "EXECUTED" }]);
    buildWaiverClaimsOn(db, [SEASON]);
    const row = db.prepare("SELECT * FROM fact_waiver_claim").get() as Record<string, number>;
    assert.equal(row.prior_pts, 6);                    // week 3 points = 3*2
    assert.equal(row.td_ppg, 4);                       // the week-4 row's to-date column
    assert.equal(row.pos_line_rank, 1);                // p1's line (12) beats p2's (9)
    assert.equal(row.ros_pts, 8 + 10 + 12);            // weeks 4..6, inclusive of the claim week
    assert.equal(row.ros_games, 3);
  });
});

test("the budget is read from the league's own spend, not typed into the source", () => {
  withDb((db) => {
    fixture(db, []);
    assert.equal(budgetFor(db, SEASON), 100);          // nobody maxed out -> the documented fallback
    db.prepare("UPDATE fact_team_season SET faab_spent = 250 WHERE team_id='1'").run();
    assert.equal(budgetFor(db, SEASON), 250);          // a drained team puts the budget exactly here
  });
});
