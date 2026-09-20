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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    db.prepare("INSERT INTO board (league_id, player_id, season, row_json, updated_at) VALUES (?,?,?,?,?)")
      .run(A, `p${i}`, SEASON, JSON.stringify({ Player: `P${i}`, Pos: "RB", Rank: i + 1, ProjPts: 100 - i }), now);
    db.prepare("INSERT INTO player (player_id, name, position, updated_at) VALUES (?,?,?,?)").run(`p${i}`, `P${i}`, "RB", now);
    db.prepare("INSERT INTO player_value (league_id, player_id, season, our_value, our_rank, updated_at) VALUES (?,?,?,?,?,?)")
      .run(A, `p${i}`, SEASON, 50 - i, i + 1, now);
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

/**
 * WAS "a MISMATCHED stamp throws BY NAME". The stamp comparison is GONE, and not because the
 * protection was dropped -- because `board.league_id` makes the thing it protected against
 * impossible. There are no rows of A's to hand to B; the refusal is now "B has no board", which is
 * the honest question once the two can coexist.
 *
 * The property being defended is unchanged and is asserted directly below: asking as B must never
 * yield A's three players, and must never yield an EMPTY board either (a league with nobody in it is
 * the failure shape this repo pays for most).
 */
test("league B is refused BY NAME, and can never be handed league A's rows", () => {
  withStore((db) => {
    assert.throws(() => assertBoardFor(db, B), /no board has been built for league BBB/);
    assert.throws(() => appDataPayload(db, SEASON, B), /no board has been built for league BBB/);
    assert.throws(() => valueBook(db, SEASON, B), /no board has been built for league BBB/);
    // A still gets its own, which is the positive half: a refusal-only world would pass this too.
    assert.equal(appDataPayload(db, SEASON, A).players.length, 3);
  });
});

test("a board with rows and NO stamp is refused, not served to whoever asks", () => {
  withStore((db) => {
    // BOTH keys: the stamp is per-league now (`board_stamp:AAA`), with the global one kept as a
    // derived mirror. Deleting only the mirror would leave the real stamp in place and this test
    // would assert nothing.
    db.prepare("DELETE FROM settings WHERE key IN ('board_stamp', 'board_stamp:' || ?)").run(A);
    assert.equal(getBoardStamp(db, A), null);
    assert.throws(() => assertBoardFor(db, A), /carries no stamp/);
  });
});

test("an EMPTY board is not a refusal -- it is the empty-board failure every reader already handles", () => {
  withStore((db) => {
    db.prepare("DELETE FROM board").run();
    db.prepare("DELETE FROM settings WHERE key IN ('board_stamp', 'board_stamp:' || ?)").run(A);
    assert.doesNotThrow(() => assertBoardFor(db, A));
  });
});

/**
 * INVERTED ON PURPOSE (2026-09-20), and this is the test that used to encode the defect.
 *
 * It required that a switch DELETE league A's rows, for a good reason at the time: with one shared
 * slot, leaving them in place meant serving A's dollars under B's name. Its own comment says so --
 * "serving them as B's is the whole defect".
 *
 * `board.league_id` removes that dilemma. B cannot be handed A's rows whether or not A's rows exist,
 * so there is nothing to buy by destroying them -- and destroying them is expensive: mid-season it
 * takes the league you are actually playing offline until its board is rebuilt. The protected
 * property is asserted exactly as hard as before; only the required outcome for A is reversed.
 */
test("league-set-active does NOT clear another league's board, and still refuses B by name", async () => {
  await withStore(async (db, path) => {
    // The rebuild needs points.csv and a reachable ESPN; in a temp store it throws, which is exactly
    // the state of a league with no format artifacts. The REQUIREMENT is what happens then.
    const r = await switchActiveLeague(db, B, { dbPath: path, pointsPath: join(path, "no-such-points.csv") });
    assert.equal(r.active, B);
    assert.equal(r.rebuilt, false);
    assert.match(r.reason ?? "", /could not be rebuilt for league BBB/);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM board").get() as { c: number }).c, 3,
      "league A's 3 rows must SURVIVE -- destroying the live league to onboard another was the cost");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM player_value").get() as { c: number }).c, 3);
    assert.deepEqual(getBoardStamp(db, B), { leagueId: B, pending: true });
    // B is still refused BY NAME rather than served an empty board that looks like a league with
    // nobody in it -- the half of the contract that must NOT change.
    assert.throws(() => assertBoardFor(db, B), /board not built for league BBB/);
    // ...and A, untouched, is still servable. This is the whole point of the change.
    assert.doesNotThrow(() => assertBoardFor(db, A));
    assert.equal(appDataPayload(db, SEASON, A).players.length, 3);
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
    assert.deepEqual(getBoardStamp(db, B), { leagueId: B, pending: true });
  });
});

test("player_value_position is per-league too -- A's survives a switch to B", () => {
  withStore((db, path) => {
    // WP2 deliberately left this table alone: it had a CREATE on the live store, no producer in
    // `src/`, and clearing a table nothing can rebuild is irreversible loss (it cost 523 rows once).
    // WP3 restored the producer (`assemble`'s `upValPos`), its CREATE in schema.sql and its lineage
    // entry, so it joins board/player_value -- leaving another league's value POSITIONS behind is
    // the same defect as leaving its dollars behind.
    db.prepare("INSERT INTO player_value_position (league_id, player_id, season, board_pos, value_pos, updated_at) VALUES (?,'p0',?,'RB','RB','now')").run(A, SEASON);
    // `reportPath` keeps this test's rebuild from overwriting the REPO's data/player-report.csv, which
    // it did silently on every `npm test` (assemble writes that CSV unconditionally at the end).
    return switchActiveLeague(db, B, { dbPath: path, reportPath: join(path, "..", "report-clear.csv") }).then(() => {
      // It used to be required that this reach 0. Same reasoning as the board: A's value POSITIONS
      // are keyed to A and can never be read as B's, so there is nothing to buy by deleting them.
      const mine = db.prepare("SELECT COUNT(*) c FROM player_value_position WHERE league_id = ?").get(A) as { c: number };
      assert.equal(mine.c, 1, "league A's value positions must survive a switch to league B");
      const theirs = db.prepare("SELECT COUNT(*) c FROM player_value_position WHERE league_id = ?").get(B) as { c: number };
      assert.equal(theirs.c, 0, "and B, whose rebuild could not run, has none of its own");
    });
  });
});

/**
 * ...AND IT COMES BACK (W-2 / D-6, 2026-09-16).
 *
 * The test above proves `player_value_position` is CLEARED on a switch. Clearing is only half the
 * contract: a system where a league switch DESTROYS the table permanently passes that test perfectly,
 * and that is approximately the state an independent QA pass observed on the live store -- board 529
 * rows, `player_value_position` 0, and 1036 ingested eligibility rows that should have refilled it.
 * Nothing could tell "the rebuild did not restore it" from "the producer is gone", because no test and
 * no reader ever looked at the second half.
 *
 * So this drives a REAL round trip -- A -> B (clear, rebuild refused) -> A (clear, rebuild succeeds) --
 * through the actual `assemble`, and asserts the table comes BACK, with the same row count as the board
 * and written in the SAME transaction (one shared `updated_at`), which is the property that makes
 * board-without-value-positions impossible.
 *
 * Two things are stubbed, and only two: `globalThis.fetch` (assemble's last-year + ESPN-rank fetches;
 * an empty answer to both is exactly the offline case) and the report CSV path (so the repo's
 * `data/player-report.csv` is not overwritten by a test). The producer itself is untouched.
 */
test("a switch round-trip REPOPULATES player_value_position -- clearing is only half the contract", async () => {
  await withStore(async (db, path) => {
    const dir = join(path, "..");
    // A pool big enough for computeValues to have replacement levels at every position.
    // Names are ALPHABETIC and unique per player: `nameKey` strips digits, so "RB Player 1" and
    // "RB Player 2" collapse to the same key and the build dies on player_value's UNIQUE constraint.
    const pool: string[] = ["name,pos,points"];
    const alpha = (i: number) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    const mk = (pos: string, tag: string, n: number, top: number) => {
      for (let i = 0; i < n; i++) pool.push(`${tag} ${alpha(i)},${pos},${top - i * 2}`);
    };
    mk("QB", "Qq", 40, 380); mk("RB", "Rr", 60, 300); mk("WR", "Ww", 60, 290);
    mk("TE", "Tt", 30, 200); mk("K", "Kk", 20, 140); mk("DST", "Zz", 20, 130);
    const pointsPath = join(dir, "points.csv");
    const reportPath = join(dir, "player-report.csv");
    writeFileSync(pointsPath, pool.join("\n") + "\n", "utf8");

    // ESPN eligibility, INGESTED -- this is what `eligKnown` reads, and the reason the producer runs at
    // all. One player is genuinely dual-eligible and is staged onto a surrogate key, so the join the
    // producer depends on is exercised rather than assumed.
    const now = nowIso();
    db.prepare("INSERT INTO raw_espn_eligibility (season, espn_player_id, name, default_position, eligible_positions_json, raw_slots_json, fetched_at) VALUES (?,?,?,?,?,?,?)")
      .run(SEASON, "e1", "Rr aa", "RB", JSON.stringify(["RB", "WR"]), JSON.stringify([2, 4]), now);
    db.prepare("INSERT INTO player_identity (name_key, birthdate, primary_position, first_name, matched_by, created_at) VALUES (?,?,?,?,?,?)")
      .run("rraa", "1999-01-01", "RB", "Rr aa", "test", now);
    const sk = (db.prepare("SELECT player_sk FROM player_identity WHERE name_key='rraa'").get() as { player_sk: number }).player_sk;
    db.prepare("INSERT INTO player_eligibility (player_sk, season, positions_json, updated_at) VALUES (?,?,?,?)")
      .run(sk, SEASON, JSON.stringify(["RB", "WR"]), now);

    const realFetch = globalThis.fetch;
    // Offline: an empty body for the nflverse CSV, an empty object for the ESPN rank call. Both are
    // best-effort inputs to the board (last-year points, ESPN rank columns), not to the value book.
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    try {
      // 1. AWAY: the switch can no longer rebuild for B, and -- since 2026-09-20 -- no longer clears
      //    anything either. A's rows stay put, which is the point; see the inverted test above.
      const away = await switchActiveLeague(db, B, { dbPath: path, pointsPath: join(path, "no-such-points.csv"), reportPath });
      assert.equal(away.rebuilt, false);

      // 2. THE HALF THAT STILL MATTERS: a real build must REFILL player_value_position beside the
      //    board. The old version reached this through a switch BACK to A, which is now a no-op
      //    (A was never cleared, so there is nothing to rebuild) -- so `assemble` is driven directly.
      //    The property is unchanged and is the one that made the live "529 board rows, 0 value
      //    positions" state diagnosable: a completed build cannot produce one without the other.
      const { assemble } = await import("../src/data/assemble.js");
      db.prepare("DELETE FROM player_value_position WHERE league_id = ?").run(A);
      await assemble(path, pointsPath, A, { reportPath });
      const boardN = (db.prepare("SELECT COUNT(*) c FROM board WHERE league_id = ?").get(A) as { c: number }).c;
      const vpN = (db.prepare("SELECT COUNT(*) c FROM player_value WHERE league_id = ?").get(A) as { c: number }).c;
      const vppN = (db.prepare("SELECT COUNT(*) c FROM player_value_position WHERE league_id = ?").get(A) as { c: number }).c;
      assert.ok(boardN > 0, "the board itself must come back, or this test is asserting nothing");
      assert.equal(vppN, boardN, "player_value_position must have one row per board row after a rebuild");
      assert.equal(vpN, boardN);
      // ONE TRANSACTION, ONE TIMESTAMP. This is the structural fact that makes the observed live state
      // (a full board beside an empty value-position table) impossible from a completed build.
      const stamps = db.prepare(
        "SELECT (SELECT MAX(updated_at) FROM board WHERE league_id = @lg) b, " +
        "(SELECT MAX(updated_at) FROM player_value_position WHERE league_id = @lg) v",
      ).get({ lg: A }) as { b: string; v: string };
      assert.equal(stamps.v, stamps.b, "board and player_value_position are written in the SAME transaction");
      // ...and the value position comes from ESPN's eligibility, not from the board position: the one
      // dual-eligible man carries both positions in his audit column.
      const dual = db.prepare("SELECT eligible_json FROM player_value_position WHERE player_id = 'rraa'")
        .get() as { eligible_json: string } | undefined;
      assert.deepEqual(JSON.parse(dual?.eligible_json ?? "[]"), ["RB", "WR"],
        "the producer must read player_eligibility, not restate the board position");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("switching BACK to the league the board already belongs to leaves it alone", () => {
  withStore((db, path) => {
    return switchActiveLeague(db, A, { dbPath: path }).then((r) => {
      assert.equal(r.cleared, false, "a no-op switch must not destroy a good board");
      assert.equal((db.prepare("SELECT COUNT(*) c FROM board WHERE league_id = ?").get(A) as { c: number }).c, 3);
      assert.deepEqual(r.stamp?.leagueId, A);
    });
  });
});
