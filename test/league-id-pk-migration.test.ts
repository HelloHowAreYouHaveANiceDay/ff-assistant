/**
 * THE MIGRATION (S-5/S-13/I-5), tested on a store built in the OLD shape.
 *
 * `migrate` is the one piece of this pass that touches data nobody can re-derive, so it is checked
 * the way a migration has to be: build the old table by hand, put rows in it that COLLIDE under the
 * old key and are distinct under the new one, run the migration, and require that every row is still
 * there, that the new key admits both, and that the indexes came back.
 *
 * THE BUG THE INDEX ASSERTION EXISTS FOR. `DROP TABLE` takes the table's indexes with it, and the
 * recreation sat inside a bare `try {} catch {}` whose comment claimed schema.sql would restore them
 * "on the next open" -- schema.sql had already run, two lines earlier in the same function. A
 * swallowed failure there turns an index into a silent full table scan, which nothing measures and
 * no test would have noticed.
 *
 * FAULT INJECTION (2026-09-16): restoring the old predicate `cols.some(c => c.name === "league_id")`
 * in `migrateLeagueIdPk` makes "the three half-keyed fact tables gain league_id at the head of the
 * PK" fail with `[ 'season', 'team_name', 'pick_order' ] !== [ 'league_id', ... ]`; deleting the
 * `for (const ix of idx) db.exec(ix.sql)` line makes the index assertion fail with `0 !== 2`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, migrate, localDraftId, ESPN_SCORING_KEY, type DB } from "../src/db/db.js";

const A = "AAA", B = "BBB";

function tempPath(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ff-pkmig-"));
  return { path: join(dir, "t.db"), dir };
}

/** A store in the PRE-WP2 shape: the three fact tables carry `league_id` as a plain column, the
 *  scorecard tables have no `format_key`, and the working draft session is the bare `'local'`. */
function oldShape(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE league (league_id TEXT PRIMARY KEY, platform TEXT, name TEXT, season INTEGER, team_id TEXT, scoring_json TEXT, last_synced_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE fact_draft_pick (season INTEGER, league_id TEXT, team_id TEXT, team_name TEXT, name TEXT,
      player_sk TEXT, price INTEGER, pick_order INTEGER, updated_at TEXT, PRIMARY KEY (season, team_name, pick_order));
    CREATE INDEX idx_fdp_season ON fact_draft_pick (season);
    CREATE INDEX idx_fdp_name ON fact_draft_pick (name);
    CREATE TABLE fact_team_season (league_id TEXT, season INTEGER, team_id TEXT, team_name TEXT, owner TEXT,
      updated_at TEXT, PRIMARY KEY (season, team_id));
    CREATE TABLE fact_matchup (league_id TEXT, season INTEGER, week INTEGER, home_id TEXT, away_id TEXT,
      updated_at TEXT, PRIMARY KEY (season, week, home_id));
    CREATE TABLE scorecard_prediction (season INTEGER, week INTEGER, kind TEXT, model TEXT, subject TEXT,
      name TEXT, pos TEXT, value REAL, p10 REAL, p90 REAL, as_of TEXT, created_at TEXT,
      PRIMARY KEY (season, week, kind, model, subject));
    CREATE TABLE draft (draft_id TEXT PRIMARY KEY, kind TEXT, platform TEXT, league_id TEXT, season INTEGER,
      status TEXT, started_at TEXT, updated_at TEXT);
    CREATE TABLE draft_state (draft_id TEXT PRIMARY KEY, updated_at TEXT, state_json TEXT);
    CREATE TABLE my_roster (draft_id TEXT, player_id TEXT, name TEXT, slot TEXT, price INTEGER, PRIMARY KEY (draft_id, player_id));
  `);
  db.prepare("INSERT INTO league VALUES (?,?,?,?,?,?,?)").run(A, "espn", "A", 2094, "8", null, "2026-01-02");
  db.prepare("INSERT INTO league VALUES (?,?,?,?,?,?,?)").run(B, "yahoo", "B", 2094, "3", null, "2026-01-03");
  db.prepare("INSERT INTO settings VALUES ('active_league', ?, 'now')").run(A);
  // ONE league's rows, which is all the old key could hold: `(season, team_name, pick_order)` has no
  // room for a second league's 2094 Team 1 pick 1. That impossibility IS the defect -- the second
  // test below inserts exactly that row once the new key is in place.
  db.prepare("INSERT INTO fact_draft_pick VALUES (2094,?, '1', 'Team 1', ?, NULL, 50, 1, 'now')").run(A, `${A} Star`);
  db.prepare("INSERT INTO fact_team_season VALUES (?, 2094, '1', ?, ?, 'now')").run(A, `${A} Team 1`, `owner-${A}`);
  db.prepare("INSERT INTO fact_matchup VALUES (?, 2094, 1, '1', '2', 'now')").run(A);
  db.prepare("INSERT INTO draft VALUES ('local','local',NULL,NULL,2094,'active','now','now')").run();
  db.prepare("INSERT INTO draft_state VALUES ('local','now','{}')").run();
  db.prepare("INSERT INTO my_roster VALUES ('local','ja-marr-chase','Ja Marr Chase','WR',47)").run();
  db.prepare(
    `INSERT INTO scorecard_prediction VALUES (2094, 0, 'odds', 'playoff', '1', '1', NULL, 55, NULL, NULL, 'x', 'x')`,
  ).run();
  db.close();
}

const pkOf = (db: DB, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

function withOldStore(fn: (db: DB, path: string) => void): void {
  const { path, dir } = tempPath();
  oldShape(path);
  const db = openDb(path);                 // openDb -> migrate: this IS the thing under test
  try { fn(db, path); } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
  }
}

test("the three half-keyed fact tables gain league_id at the head of the PK, keeping every row", () => {
  withOldStore((db) => {
    for (const t of ["fact_draft_pick", "fact_team_season", "fact_matchup"]) {
      assert.equal(pkOf(db, t)[0], "league_id", `${t}: league_id must LEAD the primary key`);
      const byLeague = db.prepare(`SELECT league_id, COUNT(*) c FROM "${t}" GROUP BY league_id ORDER BY league_id`)
        .all() as { league_id: string; c: number }[];
      assert.deepEqual(byLeague, [{ league_id: A, c: 1 }], `${t}: the existing row must survive, attributed to its own league`);
    }
    // The values came across, not just the row count.
    assert.deepEqual(db.prepare("SELECT league_id, owner FROM fact_team_season").all(),
      [{ league_id: A, owner: `owner-${A}` }]);
    // A row whose league_id was NULL is attributed to the ACTIVE league, never dropped by NOT NULL.
    assert.equal((db.prepare("SELECT COUNT(*) c FROM fact_draft_pick WHERE league_id IS NULL").get() as { c: number }).c, 0);
  });
});

test("the NEW key admits a second league's colliding row, which the old one could not", () => {
  withOldStore((db) => {
    // League B, same season/team_name/pick_order as A's surviving row: the insert the OLD key made
    // impossible, which is what "the upserts collide across leagues" meant in practice.
    const ins = (lg: string, name: string) => db.prepare(
      "INSERT INTO fact_draft_pick (league_id, season, team_id, team_name, name, price, pick_order, updated_at) VALUES (?,2094,'1','Team 1',?,9,1,'now')",
    ).run(lg, name);
    ins(B, `${B} Star`);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM fact_draft_pick").get() as { c: number }).c, 2);
    assert.deepEqual(db.prepare("SELECT league_id, name FROM fact_draft_pick ORDER BY league_id").all(),
      [{ league_id: A, name: `${A} Star` }, { league_id: B, name: `${B} Star` }]);
    // ...and the key still binds INSIDE a league.
    assert.throws(() => ins(B, "dupe"), /UNIQUE constraint failed/,
      "one league must still not hold two rows at the same key");
  });
});

test("the indexes come BACK -- DROP TABLE took them and the recreation used to be swallowed", () => {
  withOldStore((db) => {
    const idx = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fact_draft_pick' AND sql IS NOT NULL ORDER BY name",
    ).all() as { name: string }[]).map((r) => r.name);
    // schema.sql adds idx_fdp_sk to a modern store, so this is a SUPERSET check on the two that
     // existed before the rebuild -- those are the ones DROP TABLE took away.
    for (const want of ["idx_fdp_name", "idx_fdp_season"]) {
      assert.ok(idx.includes(want), `${want} was lost by the rebuild (it is now a full table scan): got ${idx.join(", ")}`);
    }
  });
});

test("scorecard_* gain format_key at the head of the PK, backfilled with the ESPN scoring key", () => {
  withOldStore((db) => {
    assert.equal(pkOf(db, "scorecard_prediction")[0], "format_key");
    assert.equal(pkOf(db, "scorecard_result")[0], "format_key");
    const rows = db.prepare("SELECT format_key, subject FROM scorecard_prediction").all();
    assert.deepEqual(rows, [{ format_key: ESPN_SCORING_KEY, subject: "1" }],
      "an existing row is stamped with the rules it was actually written under");
  });
});

test("the working draft session is league-qualified, and its rows follow it", () => {
  withOldStore((db) => {
    const want = localDraftId(A);
    assert.equal(want, `local:${A}`);
    assert.deepEqual(db.prepare("SELECT draft_id, league_id FROM draft").all(), [{ draft_id: want, league_id: A }]);
    assert.deepEqual(db.prepare("SELECT draft_id FROM draft_state").all(), [{ draft_id: want }]);
    assert.deepEqual(db.prepare("SELECT draft_id, name FROM my_roster").all(),
      [{ draft_id: want, name: "Ja Marr Chase" }], "the drafted team must not be orphaned by the rename");
  });
});

test("the migration is IDEMPOTENT -- a second run is a no-op, not a second rebuild", () => {
  const { path, dir } = tempPath();
  oldShape(path);
  const db = openDb(path);
  try {
    const snap = () => ({
      picks: db.prepare("SELECT * FROM fact_draft_pick ORDER BY league_id").all(),
      teams: db.prepare("SELECT * FROM fact_team_season ORDER BY league_id").all(),
      pk: pkOf(db, "fact_draft_pick"),
      idx: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fact_draft_pick' AND sql IS NOT NULL ORDER BY name").all(),
      draft: db.prepare("SELECT * FROM draft").all(),
    });
    const before = snap();
    migrate(db);
    migrate(db);
    assert.deepEqual(snap(), before, "re-running the migration changed the store");
  } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
  }
});

test("action_log gains league_id, and logAction records it", async () => {
  const { path, dir } = tempPath();
  oldShape(path);
  const db = openDb(path);
  try {
    const { logAction } = await import("../src/db/db.js");
    const id = logAction(db, { runType: "test", action: "probe" });
    const row = db.prepare("SELECT league_id, action FROM action_log WHERE id = ?").get(id) as { league_id: string | null; action: string };
    assert.deepEqual(row, { league_id: A, action: "probe" }, "an action with no explicit league is the ACTIVE league's");
    const id2 = logAction(db, { runType: "test", action: "probe2", leagueId: B });
    assert.equal((db.prepare("SELECT league_id FROM action_log WHERE id = ?").get(id2) as { league_id: string }).league_id, B);
  } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp */ }
  }
});
