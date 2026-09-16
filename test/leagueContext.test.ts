/**
 * THE ONE RESOLVER, AND THE CONFIG ISOLATION IT DEPENDS ON (WP1: S-1, S-7, S-10, S-11, S-12).
 *
 * Every test here asserts something that was FALSE before 2026-09-16 and whose falseness produced a
 * confident wrong answer rather than an error:
 *   - two leagues shared one config, because an explicit id fell back to the legacy `config` mirror;
 *   - `resolveLeagueContext` ignored its own argument and mixed two resolvers;
 *   - an unknown league id silently became the active league;
 *   - `openLeague` dispatched on a config field that does not exist, so the Yahoo league got an ESPN
 *     adaptor and the loud refusal was unreachable;
 *   - `league_sync` could read one league's settings and write them onto another.
 *
 * Fault injection for the first of those is in `test/config-isolation-faultinject.test.ts`, which
 * reimplements the OLD fallback and asserts it produces the cross-league inheritance -- so the
 * assertion below is known to be capable of failing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate, getConfig, setConfig, setActiveLeagueId, DEFAULT_CONFIG, type DB } from "../src/db/db.js";
import { resolveLeagueContext } from "../src/data/leagueContext.js";
import { leagueSyncIdentityProblem } from "../src/agent/agent.js";

function freshDb(): DB {
  const db = new Database(":memory:") as unknown as DB;
  migrate(db as unknown as import("better-sqlite3").Database);
  return db;
}
const addLeague = (db: DB, id: string, platform: string, synced: string, teamId: string | null = "1", season = 2026) =>
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run(id, platform, `league ${id}`, season, teamId, synced);

// --- (a) CONFIG ISOLATION -------------------------------------------------------------------------

test("two leagues hold two DIFFERENT configs, and neither reads the other's", () => {
  const db = freshDb();
  addLeague(db, "A", "espn", "2026-01-01T00:00:00Z");
  addLeague(db, "B", "espn", "2026-02-01T00:00:00Z");
  setConfig(db, { teams: 14, budget: 250, scoring: "HALF" }, "A");
  setConfig(db, { teams: 12, budget: 300, scoring: "PPR" }, "B");

  assert.equal(getConfig(db, "A").teams, 14);
  assert.equal(getConfig(db, "B").teams, 12);
  assert.equal(getConfig(db, "A").budget, 250);
  assert.equal(getConfig(db, "B").budget, 300);
  assert.equal(getConfig(db, "A").scoring, "HALF");
  assert.equal(getConfig(db, "B").scoring, "PPR");
});

test("an EXPLICIT id with no config of its own falls back to DEFAULTS, never to another league", () => {
  // This is the exact shape of S-7: league A is configured and ACTIVE, so the legacy `config` mirror
  // holds A's config. B has never been configured. Before the fix, `getConfig(db, "B")` returned A's.
  const db = freshDb();
  addLeague(db, "A", "espn", "2026-01-01T00:00:00Z");
  addLeague(db, "B", "yahoo", "2026-02-01T00:00:00Z", null);
  setConfig(db, { teams: 14, budget: 250, scoring: "HALF" }, "A");
  setActiveLeagueId(db, "A");
  assert.equal(
    db.prepare("SELECT 1 FROM settings WHERE key='config'").get() != null, true,
    "the legacy mirror must EXIST, or this test cannot observe the fallback it is about",
  );

  const b = getConfig(db, "B");
  assert.equal(b.teams, DEFAULT_CONFIG.teams, "B must get the DEFAULT team count, not A's");
  assert.equal(b.budget, DEFAULT_CONFIG.budget, "B must get the DEFAULT budget, not A's");
  assert.equal(b.format, null, "B must have NO format block -- an inherited calendar is a fabricated fact");
});

test("setConfig REFUSES when no league can be resolved", () => {
  const db = freshDb();                                   // no league rows at all
  assert.throws(() => setConfig(db, { teams: 8 }), /no league/i);
});

// --- (b) RESOLVER AGREEMENT -----------------------------------------------------------------------

test("the ACTIVE league wins over the most-recently-synced one", () => {
  // The live store's exact configuration: `active_league` = the ESPN league, while a different league
  // carries the newer `last_synced_at`. Four resolvers used to disagree here.
  const db = freshDb();
  addLeague(db, "X", "espn", "2026-01-01T00:00:00Z");
  addLeague(db, "Y", "yahoo", "2026-09-16T00:00:00Z", null);   // NEWER sync
  setActiveLeagueId(db, "X");
  assert.equal(resolveLeagueContext(db).leagueId, "X");
  assert.equal(resolveLeagueContext(db).platform, "espn");
});

test("the context carries the platform and team from the LEAGUE ROW", () => {
  const db = freshDb();
  addLeague(db, "Y", "yahoo", "2026-09-16T00:00:00Z", null);
  setActiveLeagueId(db, "Y");
  const ctx = resolveLeagueContext(db);
  assert.equal(ctx.platform, "yahoo");
  assert.equal(ctx.teamId, null, "team_id IS NULL must arrive as null, not as another league's team");
});

test("no league at all degrades to leagueId=null rather than throwing", () => {
  const db = freshDb();
  const ctx = resolveLeagueContext(db);
  assert.equal(ctx.leagueId, null);
  assert.equal(ctx.platform, null);
});

// --- (c) AN UNKNOWN EXPLICIT ID THROWS ------------------------------------------------------------

test("an explicit league id that names no league THROWS -- a typo must not become the active league", () => {
  const db = freshDb();
  addLeague(db, "X", "espn", "2026-01-01T00:00:00Z");
  setActiveLeagueId(db, "X");
  assert.throws(() => resolveLeagueContext(db, "46223"), /no league "46223"/);
  // POSITIVE CONTROL: the same call with a real id returns it, so the throw above is about the id and
  // not about the resolver being unable to return anything.
  assert.equal(resolveLeagueContext(db, "X").leagueId, "X");
});

// --- (e) THE league_sync IDENTITY GUARD -----------------------------------------------------------

test("league_sync refuses a settings payload belonging to a DIFFERENT league", () => {
  assert.match(
    leagueSyncIdentityProblem({ id: 462233, settings: { size: 16 } }, "129048") ?? "",
    /asked for league 129048 but the payload is league 462233/,
  );
});

test("league_sync refuses an UNLABELLED payload -- unlabelled is the case the guard exists for", () => {
  assert.match(leagueSyncIdentityProblem({ settings: { size: 16 } }, "129048") ?? "", /carries no league id/);
});

test("league_sync ACCEPTS the payload for the league it asked for (the positive control)", () => {
  // Without this the guard could be one that can only ever refuse, which reads exactly like a guard
  // that is working. Number and string spellings both pass -- ESPN returns a number.
  assert.equal(leagueSyncIdentityProblem({ id: 462233 }, "462233"), null);
  assert.equal(leagueSyncIdentityProblem({ id: "462233" }, "462233"), null);
});
