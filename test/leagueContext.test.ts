// Phase 1 of the multi-league refactor: the LeagueContext resolver is behavior-preserving.
// It must return the current league + the current global config, and must NOT throw on a store with no
// league row (config-only callers keep working).
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate, getConfig } from "../src/db/db.js";
import { resolveLeagueContext } from "../src/data/leagueContext.js";
import type { DB } from "../src/db/db.js";

function freshDb(): DB {
  const db = new Database(":memory:") as unknown as DB;
  migrate(db as unknown as import("better-sqlite3").Database);
  return db;
}

test("resolveLeagueContext degrades to leagueId=null on a store with no league, config still resolves", () => {
  const db = freshDb();
  const ctx = resolveLeagueContext(db);
  assert.equal(ctx.leagueId, null, "no league synced -> null, not a throw");
  assert.deepEqual(ctx.config, getConfig(db as unknown as import("better-sqlite3").Database), "config is the current global config, byte-identical");
});

test("resolveLeagueContext returns the current (most-recently-synced) league when one exists", () => {
  const db = freshDb() as unknown as import("better-sqlite3").Database;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)").run("AAA", "espn", "old", 2026, "1", "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)").run("BBB", "espn", "new", 2026, "2", now);
  const ctx = resolveLeagueContext(db as unknown as DB);
  assert.equal(ctx.leagueId, "BBB", "most-recently-synced league wins, matching currentLeagueId()");
});

test("resolveLeagueContext honors an explicit leagueId override", () => {
  const db = freshDb() as unknown as import("better-sqlite3").Database;
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)").run("BBB", "espn", "new", 2026, "2", new Date().toISOString());
  const ctx = resolveLeagueContext(db as unknown as DB, "AAA");
  assert.equal(ctx.leagueId, "AAA", "explicit id overrides the current-league default");
});
