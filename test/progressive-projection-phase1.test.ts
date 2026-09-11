// PHASE 1 of the progressive-projection experiment -- the OPPORTUNITY (role) feature, proven on a
// synthetic in-memory store with a hand-built snap series.
//
// The load-bearing property is POINT-IN-TIME with NO LEAKAGE: the week-W role aggregates must read
// only games in weeks < W, so a game in week >= W cannot move them. This is the #1 way a progressive
// model fools itself, so it is fault-injected: after computing the week-4 aggregate we INSERT a huge
// future-week role and confirm the week-4 aggregate is byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeRoleAggregates } from "../src/inseason/backtest/opportunity.js";
import type { DB } from "../src/db/db.js";

function freshDb(): DB {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE player_xref (player_sk INTEGER, source TEXT, source_id TEXT);
    CREATE TABLE raw_snap_count (season INTEGER, week INTEGER, game_type TEXT, pfr_player_id TEXT, offense_pct REAL);
    CREATE TABLE raw_participation (season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, pass_plays INTEGER, team_pass_plays INTEGER);
    INSERT INTO player_xref VALUES (1, 'pfr', 'P1');
  `);
  // A back whose snap share JUMPS at week 3 (a takeover): weeks 1..5 = 20,20,50,70,70 %.
  const roles = [0.2, 0.2, 0.5, 0.7, 0.7];
  const ins = db.prepare("INSERT INTO raw_snap_count VALUES (2023, ?, 'REG', 'P1', ?)");
  roles.forEach((r, i) => ins.run(i + 1, r));
  return db as unknown as DB;
}

test("week-1 with no prior games returns null (nothing observed yet)", () => {
  const agg = makeRoleAggregates(freshDb(), { window: 3 });
  assert.equal(agg("1", "RB", 2023, 1), null);
});

test("aggregates use only weeks < W, and the trailing window trails", () => {
  const agg = makeRoleAggregates(freshDb(), { window: 3 });
  const w4 = agg("1", "RB", 2023, 4)!; // prior weeks 1,2,3 = [.2,.2,.5]
  assert.equal(w4.games, 3);
  assert.ok(Math.abs(w4.roleToDate - 0.3) < 1e-9, "to-date over weeks 1-3 = 0.30");
  assert.ok(Math.abs(w4.roleRecent - 0.3) < 1e-9, "recent(3) over weeks 1-3 = 0.30");

  const w6 = agg("1", "RB", 2023, 6)!; // prior weeks 1..5 = [.2,.2,.5,.7,.7]
  assert.equal(w6.games, 5);
  assert.ok(Math.abs(w6.roleToDate - 0.46) < 1e-9, "to-date over weeks 1-5 = 0.46");
  assert.ok(Math.abs(w6.roleRecent - (0.5 + 0.7 + 0.7) / 3) < 1e-9, "recent(3) = last three = 0.633");
  assert.ok(w6.roleRecent > w6.roleToDate, "recent role exceeds to-date -> trending up, the signal we want");
});

test("LEAKAGE FIREWALL: a future-week game cannot move the week-4 aggregate", () => {
  const db = freshDb();
  const before = makeRoleAggregates(db, { window: 3 })("1", "RB", 2023, 4)!;
  // Inject a huge role in week 10 -- strictly after the decision week.
  db.prepare("INSERT INTO raw_snap_count VALUES (2023, 10, 'REG', 'P1', 0.99)").run();
  const after = makeRoleAggregates(db, { window: 3 })("1", "RB", 2023, 4)!; // fresh instance, re-reads the store
  assert.deepEqual(after, before, "week-4 features must ignore a week-10 game entirely");
});

test("route share drives WR/TE, with a snap-share fallback when routes are absent", () => {
  const db = freshDb();
  // Add a WR on routes (gsis) and a TE with only snaps (should fall back).
  db.prepare("INSERT INTO player_xref VALUES (2,'gsis','G2')").run();
  db.prepare("INSERT INTO player_xref VALUES (3,'pfr','P3')").run();
  for (let w = 1; w <= 3; w++) db.prepare("INSERT INTO raw_participation VALUES (2023, ?, 'G2', 'AAA', ?, 100)").run(w, 40 + w * 10);
  for (let w = 1; w <= 3; w++) db.prepare("INSERT INTO raw_snap_count VALUES (2023, ?, 'REG', 'P3', ?)").run(w, 0.5);
  const agg = makeRoleAggregates(db, { window: 3 });
  const wr = agg("2", "WR", 2023, 4)!; // routes: (50,60,70)/100 = .5,.6,.7
  assert.ok(Math.abs(wr.roleToDate - 0.6) < 1e-9, "WR uses route share");
  const te = agg("3", "TE", 2023, 4)!; // no routes -> falls back to snaps = .5
  assert.ok(Math.abs(te.roleToDate - 0.5) < 1e-9, "TE with no route feed falls back to snap share");
});
