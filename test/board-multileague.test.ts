/**
 * THE BOARD IS PER LEAGUE (2026-09-20).
 *
 * `board`, `player_value` and `player_value_position` were a single slot: `assemble` for league B
 * DELETED league A's rows, and `switchActiveLeague` cleared all three outright. The stamp guard made
 * that visible -- "board is built for league A, not B" -- but visible destruction is still
 * destruction: mid-season, serving a second league took the live league's lineup offline until it was
 * rebuilt. docs/multi-league-refactor.md line 38 always listed all three under "MUST ADD league_id";
 * the single slot was an interim whose rebuild-on-switch half was never built (finding S-8).
 *
 * The two things worth testing are therefore:
 *   1. two leagues' boards COEXIST and cannot be read across (impossible before, by construction now);
 *   2. switching does NOT clear the other league's rows (the destruction that made this urgent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setBoardStamp, assertBoardFor, slotFilter, setSetting, type DB } from "../src/db/db.js";

const A = "111111";
const B = "222222";
const SEASON = 2026;

/** A store with two leagues' boards in it -- the state the single slot could not represent. */
function twoBoards(): DB {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "ff-board-ml-")), "ff.db"));
  const ins = db.prepare("INSERT INTO board (league_id, player_id, season, row_json, updated_at) VALUES (?,?,?,?,?)");
  const insV = db.prepare("INSERT INTO player_value (league_id, player_id, season, our_value, updated_at) VALUES (?,?,?,?,?)");
  // `player_value.player_id` REFERENCES `player`, and FKs are ON. The men are shared across leagues --
  // one NFL player, two fantasy economies -- which is precisely why the VALUE is what gets partitioned
  // and the player does not.
  const insP = db.prepare("INSERT INTO player (player_id, name, position, updated_at) VALUES (?,?,?,?) ON CONFLICT(player_id) DO NOTHING");
  for (const [lg, names, val] of [[A, ["ayers", "abbott"], 40], [B, ["bell", "burns", "byrd"], 7]] as [string, string[], number][]) {
    for (const n of names) {
      insP.run(n, n, "RB", "now");
      ins.run(lg, n, SEASON, JSON.stringify({ Player: n, Pos: "RB", Rank: 1 }), "now");
      insV.run(lg, n, SEASON, val, "now");
    }
    setBoardStamp(db, { leagueId: lg, season: SEASON, builtAt: "now" });
  }
  return db;
}

test("two leagues' boards COEXIST -- the state a single slot could not hold", () => {
  const db = twoBoards();
  try {
    const count = (lg: string): number => {
      const f = slotFilter(lg);
      return (db.prepare(`SELECT COUNT(*) c FROM board WHERE season=?${f.sql}`).get(SEASON, ...f.args) as { c: number }).c;
    };
    assert.equal(count(A), 2);
    assert.equal(count(B), 3);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM board").get() as { c: number }).c, 5, "both, in one table");
  } finally { db.close(); }
});

test("a read for one league CANNOT return the other's rows -- structurally, not by a guard", () => {
  const db = twoBoards();
  try {
    const names = (lg: string): string[] => {
      const f = slotFilter(lg);
      return (db.prepare(`SELECT player_id FROM board WHERE season=?${f.sql} ORDER BY player_id`).all(SEASON, ...f.args) as { player_id: string }[]).map((r) => r.player_id);
    };
    assert.deepEqual(names(A), ["abbott", "ayers"]);
    assert.deepEqual(names(B), ["bell", "burns", "byrd"]);
    // The old failure mode in one line: A's reader must never see a B name.
    assert.ok(!names(A).some((n) => n.startsWith("b")), "league A's board leaked league B's players");
    // And the VALUES are each league's own economy, not a shared one.
    const val = (lg: string): number => {
      const f = slotFilter(lg);
      return (db.prepare(`SELECT MAX(our_value) v FROM player_value WHERE season=?${f.sql}`).get(SEASON, ...f.args) as { v: number }).v;
    };
    assert.equal(val(A), 40);
    assert.equal(val(B), 7, "a dollar value is a statement about ONE league's economy");
  } finally { db.close(); }
});

test("assertBoardFor passes for a built league and REFUSES one that has never been built", () => {
  const db = twoBoards();
  try {
    assertBoardFor(db, A, "test");       // built
    assertBoardFor(db, B, "test");       // also built -- both, at the same time
    // A third league with no board of its own must be refused BY NAME, not silently served zero
    // players. Under the single slot this returned quietly whenever the one board was non-empty.
    assert.throws(() => assertBoardFor(db, "333333", "test"), /no board has been built for league 333333/);
  } finally { db.close(); }
});

test("FAULT: an unfiltered read is exactly the cross-league serve this prevents", () => {
  const db = twoBoards();
  try {
    // The reader as it was written BEFORE partitioning -- no league in the WHERE clause.
    const unfiltered = (db.prepare("SELECT player_id FROM board WHERE season=?").all(SEASON) as { player_id: string }[]).map((r) => r.player_id);
    assert.equal(unfiltered.length, 5, "the old query shape returns BOTH leagues' players");
    // Which is why every reader threads a league. If a future reader forgets, this is what it gets.
    const f = slotFilter(A);
    const filtered = (db.prepare(`SELECT player_id FROM board WHERE season=?${f.sql}`).all(SEASON, ...f.args) as { player_id: string }[]);
    assert.equal(filtered.length, 2);
  } finally { db.close(); }
});

test("slotFilter with NO league does not filter -- a bare store still reads its own board", () => {
  const f = slotFilter(null);
  assert.equal(f.sql, "");
  assert.deepEqual(f.args, []);
  const g = slotFilter(A, "b");
  assert.equal(g.sql, " AND b.league_id = ?");
  assert.deepEqual(g.args, [A]);
});

/**
 * THE ONE THAT MADE THIS URGENT. `switchActiveLeague` used to `DELETE FROM board / player_value /
 * player_value_position` -- every row of every league -- before rebuilding. With a live league
 * mid-season that is destruction of the thing you are still using.
 */
test("switching the active league does NOT clear the other league's board", async () => {
  const db = twoBoards();
  try {
    setSetting(db, "active_league", A);
    const { switchActiveLeague } = await import("../src/data/assemble.js");
    // `rebuild: false` isolates the CLEAR from the rebuild: the old code cleared first and only then
    // noticed it had not been asked to rebuild, which is how the destruction happened even on a
    // switch that did no work.
    const r = await switchActiveLeague(db, B, { rebuild: false });
    assert.equal(r.active, B);
    assert.equal(r.cleared, false, "nothing may be cleared -- that was the whole defect");
    const left = (lg: string): number => {
      const f = slotFilter(lg);
      return (db.prepare(`SELECT COUNT(*) c FROM board WHERE season=?${f.sql}`).get(SEASON, ...f.args) as { c: number }).c;
    };
    assert.equal(left(A), 2, "league A's board must survive a switch to league B");
    assert.equal(left(B), 3, "and B's, already built, is reused rather than rebuilt");
    // A board that is already built is not pending: the switch is free, where it used to be a rebuild.
    assert.equal(r.rebuilt, false);
    assert.equal(r.stamp?.pending, undefined);
  } finally { db.close(); }
});

/**
 * THE PATH THAT ACTUALLY DESTROYED THINGS, and the one the test above does NOT reach.
 *
 * Switching to a league that is ALREADY built now returns early, so restoring the old `DELETE FROM
 * board` there changes nothing and the test above passes either way -- fault injection caught that.
 * The destruction happened when switching to a league with NO board yet: the old code cleared all
 * three tables for every league first, and only then discovered it could not rebuild. That is the
 * mid-season case -- onboarding a second league -- and it took the live league's board with it.
 */
test("switching to an UNBUILT league leaves every other league's board intact", async () => {
  const db = twoBoards();
  try {
    setSetting(db, "active_league", A);
    const { switchActiveLeague } = await import("../src/data/assemble.js");
    const C = "333333";                                  // never built -- the onboarding case
    const r = await switchActiveLeague(db, C, { rebuild: false });
    assert.equal(r.active, C);
    assert.equal(r.stamp?.pending, true, "C has no board, so its stamp is pending and readers refuse BY NAME");

    const left = (lg: string): number => {
      const f = slotFilter(lg);
      return (db.prepare(`SELECT COUNT(*) c FROM board WHERE season=?${f.sql}`).get(SEASON, ...f.args) as { c: number }).c;
    };
    assert.equal(left(A), 2, "the LIVE league's board must survive onboarding a new one -- this is the whole fix");
    assert.equal(left(B), 3);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM player_value").get() as { c: number }).c, 5, "and its values with it");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM board").get() as { c: number }).c, 5);
    // A is still SERVABLE, which is the property that actually matters on a game day.
    assertBoardFor(db, A, "test");
  } finally { db.close(); }
});
