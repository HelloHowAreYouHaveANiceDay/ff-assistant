/**
 * THE BOARD STAMP (S-8): `board` / `player_value` / `player_value_position` are single-slot, so the
 * only thing standing between one league and another league's dollars is a refusal.
 *
 * The board is deliberately NOT partitioned -- it is regenerable, it is read in a dozen places, and
 * keying it per league would mean a pervasive reader cascade. What it could not do was say WHOSE it
 * is: `setActiveLeagueId` wrote two settings and stopped, leaving 529 rows of ESPN half-PPR AUCTION
 * values in place while every reader went on serving them as the newly-active league's. The values
 * are plausible for any league -- they are dollars with player names beside them -- so nothing
 * downstream could ever have noticed.
 *
 * Both directions are tested, because only one of them is the interesting one:
 *   NEGATIVE: a stamp for another league THROWS, by name, naming the fix.
 *   POSITIVE: a matching stamp passes -- a guard that can only ever refuse is dead code that reads
 *             exactly like a guard that works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb, nowIso, assertBoardFor, getBoardStamp, setBoardStamp, setActiveLeagueId, type DB,
} from "../src/db/db.js";
import { switchActiveLeague } from "../src/data/assemble.js";
import { appDataPayload, valueBook } from "../src/data/appdata.js";

const A = "AAA", B = "BBB", SEASON = 2094;

function withStore(fn: (db: DB, path: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "ff-stamp-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  const now = nowIso();
  for (const lg of [A, B]) {
    db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
      .run(lg, "espn", lg, SEASON, "1", now);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(`config:${lg}`, JSON.stringify({ season: SEASON }), now);
  }
  setActiveLeagueId(db, A);
  // A board: 3 rows, as league A's.
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO board (player_id, season, row_json, updated_at) VALUES (?,?,?,?)")
      .run(`p${i}`, SEASON, JSON.stringify({ Player: `P${i}`, Pos: "RB", Rank: i + 1, ProjPts: 100 - i }), now);
    db.prepare("INSERT INTO player (player_id, name, position, updated_at) VALUES (?,?,?,?)").run(`p${i}`, `P${i}`, "RB", now);
    db.prepare("INSERT INTO player_value (player_id, season, our_value, our_rank, updated_at) VALUES (?,?,?,?,?)")
      .run(`p${i}`, SEASON, 50 - i, i + 1, now);
  }
  setBoardStamp(db, { leagueId: A, season: SEASON, scoringKey: "sc-a", builtAt: now });
  const done = () => {
    db.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
  };
  const r = fn(db, path);
  if (r instanceof Promise) return r.finally(done);
  done();
  return undefined;
}

test("a MATCHING stamp passes -- the positive control the refusal is worthless without", () => {
  withStore((db) => {
    assert.doesNotThrow(() => assertBoardFor(db, A));
    const payload = appDataPayload(db, SEASON, A);
    assert.equal(payload.players.length, 3, "league A must actually get its board");
    assert.equal(valueBook(db, SEASON, A).length, 3);
  });
});

test("a MISMATCHED stamp throws BY NAME and names the fix", () => {
  withStore((db) => {
    assert.throws(() => assertBoardFor(db, B), /board is built for league AAA, not BBB/);
    assert.throws(() => assertBoardFor(db, B), /ff league-set-active BBB/);
    assert.throws(() => appDataPayload(db, SEASON, B), /board is built for league AAA, not BBB/);
    assert.throws(() => valueBook(db, SEASON, B), /board is built for league AAA, not BBB/);
  });
});

test("a board with rows and NO stamp is refused, not served to whoever asks", () => {
  withStore((db) => {
    db.prepare("DELETE FROM settings WHERE key = 'board_stamp'").run();
    assert.equal(getBoardStamp(db), null);
    assert.throws(() => assertBoardFor(db, A), /carries no league stamp/);
  });
});

test("an EMPTY board is not a refusal -- it is the empty-board failure every reader already handles", () => {
  withStore((db) => {
    db.prepare("DELETE FROM board").run();
    db.prepare("DELETE FROM settings WHERE key = 'board_stamp'").run();
    assert.doesNotThrow(() => assertBoardFor(db, A));
  });
});

test("league-set-active CLEARS the board and stamps it pending when the rebuild cannot run", async () => {
  await withStore(async (db, path) => {
    // The rebuild needs points.csv and a reachable ESPN; in a temp store it throws, which is exactly
    // the WP3/WP4 state for a league with no format artifacts. The REQUIREMENT is what happens then.
    const r = await switchActiveLeague(db, B, { dbPath: path, pointsPath: join(path, "no-such-points.csv") });
    assert.equal(r.active, B);
    assert.equal(r.cleared, true, "the previous league's board must be cleared, not left in place");
    assert.equal(r.rebuilt, false);
    assert.match(r.reason ?? "", /could not be rebuilt for league BBB/);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM board").get() as { c: number }).c, 0,
      "league A's 3 rows must be GONE -- serving them as B's is the whole defect");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM player_value").get() as { c: number }).c, 0);
    assert.deepEqual(getBoardStamp(db), { leagueId: B, pending: true });
    // And every reader now refuses BY NAME rather than returning an empty board that looks like a
    // league with no players in it.
    assert.throws(() => assertBoardFor(db, B), /board not built for league BBB/);
    assert.throws(() => assertBoardFor(db, A), /board not built for league BBB/);
  });
});

test("assemble REFUSES a league whose format has not been built -- it does NOT read the incumbent's files", async () => {
  await withStore(async (db, path) => {
    // Give B a genuinely different scoring rule, so its key is neither the ESPN one nor any built
    // format's. WP2 refused every non-incumbent league here; WP3 replaced that blanket refusal with
    // the resolver, so the refusal is now narrower AND stronger -- it names the key and the build
    // command, and a league whose format HAS been built proceeds. This is not hypothetical: on the
    // live store this path silently produced 529 ESPN rows stamped with the Yahoo scoring key.
    db.prepare("UPDATE settings SET value = ? WHERE key = ?")
      .run(JSON.stringify({ season: SEASON, scoring_rules: { rec: 1.0, passTD: 8, passYd: 0.07 } }), `config:${B}`);
    const { assemble } = await import("../src/data/assemble.js");
    await assert.rejects(() => assemble(path, join(path, "points.csv"), B),
      /scores as sc-[0-9a-f]{12}, and no model has been built for that format/);
    // ...and the switch reports THAT reason rather than a missing-file one.
    const r = await switchActiveLeague(db, B, { dbPath: path });
    assert.match(r.reason ?? "", /no model has been built for that format/);
    assert.equal(r.rebuilt, false);
    assert.deepEqual(getBoardStamp(db), { leagueId: B, pending: true });
  });
});

test("player_value_position IS cleared now that WP3 restored its producer", () => {
  withStore((db, path) => {
    // WP2 deliberately left this table alone: it had a CREATE on the live store, no producer in
    // `src/`, and clearing a table nothing can rebuild is irreversible loss (it cost 523 rows once).
    // WP3 restored the producer (`assemble`'s `upValPos`), its CREATE in schema.sql and its lineage
    // entry, so it joins board/player_value -- leaving another league's value POSITIONS behind is
    // the same defect as leaving its dollars behind.
    db.prepare("INSERT INTO player_value_position (player_id, season, board_pos, value_pos, updated_at) VALUES ('p0',?,'RB','RB','now')").run(SEASON);
    return switchActiveLeague(db, B, { dbPath: path }).then(() => {
      assert.equal((db.prepare("SELECT COUNT(*) c FROM player_value_position").get() as { c: number }).c, 0,
        "the previous league's value positions must be cleared with its board");
    });
  });
});

test("switching BACK to the league the board already belongs to leaves it alone", () => {
  withStore((db, path) => {
    return switchActiveLeague(db, A, { dbPath: path }).then((r) => {
      assert.equal(r.cleared, false, "a no-op switch must not destroy a good board");
      assert.equal((db.prepare("SELECT COUNT(*) c FROM board").get() as { c: number }).c, 3);
      assert.deepEqual(r.stamp?.leagueId, A);
    });
  });
});
