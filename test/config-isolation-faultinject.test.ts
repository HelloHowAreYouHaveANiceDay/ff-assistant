/**
 * FAULT INJECTION FOR THE CONFIG CHOKEPOINT, AND FOR THE PLATFORM DISPATCH.
 *
 * A passing isolation test proves nothing until the broken version has been watched to fail. Both
 * defects below were live in this repo on 2026-09-16 and both were SILENT -- the Yahoo league carried
 * ESPN's playoff calendar, ESPN's half-PPR scoring and ESPN's divisions, and `openLeague` handed it an
 * ESPN adaptor while its "no adaptor for platform" refusal sat unreachable.
 *
 * So each test here runs the OLD rule against the SAME fixture the new rule passes on, and asserts
 * that the old rule produces the defect. If someone restores either fallback, the shipped assertion
 * in leagueContext.test.ts fails -- and this file says what it would have failed for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNKNOWN_PLATFORM, assertUnregistered } from "./helpers/unknown-platform.js";
import Database from "better-sqlite3";
import {
  migrate, getConfig, setConfig, setActiveLeagueId, setSetting, getSetting,
  DEFAULT_CONFIG, type DB,
} from "../src/db/db.js";
import { DEFAULT_SCORING } from "../src/draft/scoring.js";
import { DEFAULT_LEVERS } from "../src/draft/levers.js";
import { openLeague } from "../src/league/index.js";

function twoLeagueDb(): DB {
  const db = new Database(":memory:") as unknown as DB;
  migrate(db as unknown as import("better-sqlite3").Database);
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES ('A','espn','espn league',2026,'8','2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES ('B','yahoo','yahoo league',2026,NULL,'2026-09-16T00:00:00Z')").run();
  setConfig(db, { teams: 14, budget: 250, scoring: "HALF" }, "A");
  setActiveLeagueId(db, "A");                 // -> the legacy `config` mirror now holds A's config
  return db;
}

/** `getConfig` EXACTLY as it read before the fix: an explicit id falls back to the legacy mirror. */
function getConfigOld(db: DB, leagueId?: string | null) {
  const id = leagueId === undefined ? "A" : leagueId;
  const raw = (id ? getSetting(db, `config:${id}`) : undefined) ?? getSetting(db, "config");
  if (raw) {
    const s = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...s, levers: { ...DEFAULT_LEVERS, ...(s.levers ?? {}) }, scoring_rules: { ...DEFAULT_SCORING, ...(s.scoring_rules ?? {}) } };
  }
  return { ...DEFAULT_CONFIG };
}

test("FAULT INJECTION: the OLD getConfig gives league B league A's config -- the shipped one does not", () => {
  const db = twoLeagueDb();
  const old = getConfigOld(db, "B");
  assert.equal(old.teams, 14, "the injected old rule MUST inherit A's 16 teams, or it is not the old rule");
  assert.equal(old.scoring, "HALF", "...and A's scoring bucket");

  const now = getConfig(db, "B");
  assert.equal(now.teams, DEFAULT_CONFIG.teams);
  assert.notEqual(now.teams, old.teams, "the fix must change the answer on this exact fixture");
});

test("FAULT INJECTION: the legacy mirror is still WRITTEN (nothing external breaks) but is not read", () => {
  const db = twoLeagueDb();
  const mirror = getSetting(db, "config");
  assert.ok(mirror, "the derived mirror must still exist");
  assert.equal(JSON.parse(mirror as string).teams, 14, "and must track the ACTIVE league");
  // Corrupt the mirror. Every per-league read must be unaffected, which is the property "no reader
  // left" actually means -- and which a grep alone cannot demonstrate.
  setSetting(db, "config", JSON.stringify({ teams: 999, budget: 999 }));
  assert.equal(getConfig(db, "A").teams, 14, "A reads config:A, not the corrupted mirror");
  assert.equal(getConfig(db, "B").teams, DEFAULT_CONFIG.teams, "B reads defaults, not the corrupted mirror");
});

/**
 * openLeague REFUSES a league whose platform has NO ADAPTOR, by name.
 *
 * This used to name YAHOO, because on 2026-09-16 there was no Yahoo adaptor and the Yahoo league was
 * silently handed the ESPN one (S-12: the dispatch read `cfg.platform`, a field AppConfig has never
 * had, so `?? "espn"` was unconditional and the refusal below was unreachable). WP4 built that
 * adaptor, so yahoo now resolves -- and the property under test was never "yahoo is refused", it is
 * "an ABSENT adaptor is refused rather than substituted". So the subject moves to a platform that
 * genuinely has none. Substituting an adaptor is the defect; which platform happens to lack one is a
 * fact about today.
 */
test("openLeague REFUSES a platform with NO adaptor BY NAME -- the branch that used to be unreachable", async (t) => {
  // A temp store on disk, because openLeague opens the file itself.
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "ff-platform-")), "ff.db");
  const { openDb } = await import("../src/db/db.js");
  const db = openDb(path);
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES ('777777',?,'a league on no platform',2026,'3','2026-09-16T00:00:00Z')").run(assertUnregistered());
  setActiveLeagueId(db, "777777");
  setConfig(db, { teams: 12, slots: ["QB", "RB", "WR", "TE", "FLEX", "BE"] }, "777777");
  db.close();

  await assert.rejects(
    () => openLeague({ dbPath: path }),
    // The LEAGUE is named; the platform reads "unknown" because `asPlatform` maps any id the
    // REGISTRY does not hold to null -- an unrecognised platform cannot be mistaken for a
    // recognised one. (`LeaguePlatform` is no longer the closed `espn|yahoo` union this comment
    // used to describe; it is `PlatformId`, and the narrowing is done by `isRegisteredPlatform`.
    // `platformRaw` now carries the original string, which is what WP5 added.)
    /no adaptor for platform "unknown" \(league 777777\)/,
    "a league on a platform with no adaptor must be refused by name, not handed the ESPN adaptor",
  );
  void t;
});
