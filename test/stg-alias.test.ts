// build-staging across EVERY league's board, with nickname aliases (2026-10-06). A FIXTURE store, so
// it runs on a clean clone: the live-store invariants in stgPlayer.test.ts skip there.
//
// Fault injection (AGENTS.md): each guard below was broken and this file watched to fail --
//   - `hits.size === 1` -> `hits.size >= 1`          : the "two candidates" test fails (alias guessed)
//   - board read limited to the active league again : the alias, refusal and other-league tests fail
//   - the byName "staged once" guard disabled       : the "one row across two boards" test fails
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { buildStgPlayer } from "../src/data/stgPlayer.js";
import { nicknameKeys, firstNameVariants } from "../src/data/nicknames.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ff-stg-alias-"));
  const path = join(dir, "ff.db");
  const db = openDb(path);
  const season = (JSON.parse((db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string }).value) as { season: number }).season;
  const pid = db.prepare(`INSERT INTO player_ids (name_key, position, name, team, birthdate, gsis_id, ambiguous, updated_at)
                          VALUES (?,?,?,?,?,?,0,'x')`);
  pid.run("drewogletree", "TE", "Drew Ogletree", "IND", "1998-07-28", "00-0000001");
  pid.run("joshuapalmer", "WR", "Joshua Palmer", "BUF", "1999-09-22", "00-0000002");
  pid.run("robertlee", "WR", "Robert Lee", "NYJ", "1990-01-01", "00-0000003");
  pid.run("bobbylee", "WR", "Bobby Lee", "NYG", "1991-01-01", "00-0000004");
  const lg = db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, scoring_json, last_synced_at) VALUES (?,?,?,?,?,?,?)");
  lg.run("A", "espn", "A", season, "1", "{}", "2026-10-02T00:00:00Z");
  lg.run("B", "yahoo", "B", season, "1", "{}", "2026-09-01T00:00:00Z");       // A is the active league
  const brd = db.prepare("INSERT INTO board (league_id, player_id, player_sk, season, row_json, updated_at) VALUES (?,?,NULL,?,?,'x')");
  const row = (player: string, pos: string) => JSON.stringify({ Player: player, Pos: pos, Team: "" });
  brd.run("A", "joshuapalmer", season, row("Joshua Palmer", "WR"));
  brd.run("B", "andrewogletree", season, row("Andrew Ogletree", "TE"));     // nickname, ONLY on league B
  brd.run("B", "joshpalmer", season, row("Josh Palmer", "WR"));              // nickname of a man league A spells in full
  brd.run("B", "roblee", season, row("Rob Lee", "WR"));                      // two staged men answer -> refuse
  brd.run("B", "zedrookie", season, row("Zed Rookie", "WR"));                // a rookie only league B lists
  brd.run("A", "zedrookie", season, row("Zed Rookie", "RB"));                // ...listed by A at another position
  db.close();
  return { path, dir };
}

test("nicknameKeys: swaps the first name only, both directions, never returns its own key", () => {
  assert.ok(nicknameKeys("Andrew Ogletree").includes("drewogletree"));
  assert.ok(nicknameKeys("Drew Ogletree").includes("andrewogletree"));
  assert.ok(nicknameKeys("Josh Palmer").includes("joshuapalmer"));
  assert.ok(!nicknameKeys("Josh Palmer").includes("joshpalmer"));
  assert.deepEqual(nicknameKeys("Puka Nacua"), []);
  assert.deepEqual(nicknameKeys("Cher"), []);
  // deliberately NOT equivalent: separate given names in practice
  assert.ok(!firstNameVariants("john").includes("jon"));
  assert.ok(!firstNameVariants("christian").includes("chris"));
});

test("build-staging aliases a nickname to the staged man instead of staging him twice", () => {
  const { path, dir } = fixture();
  try {
    const r = buildStgPlayer(path);
    const db = openDb(path);
    const alias = db.prepare("SELECT * FROM stg_player_alias WHERE name_key='andrewogletree'").get() as { player_sk: number; alias_of: string; source: string } | undefined;
    const drew = db.prepare("SELECT player_sk FROM stg_player WHERE name_key='drewogletree'").get() as { player_sk: number };
    assert.ok(alias, "Andrew Ogletree must be recorded as another spelling");
    assert.equal(alias!.player_sk, drew.player_sk);
    assert.equal(alias!.alias_of, "drewogletree");
    assert.equal(alias!.source, "board:B");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM stg_player WHERE name_key IN ('andrewogletree','joshpalmer')").get() as { c: number }).c, 0,
      "a nickname must never become a second staged person");
    assert.ok(db.prepare("SELECT 1 FROM stg_player_alias WHERE name_key='joshpalmer' AND alias_of='joshuapalmer'").get());
    assert.ok(r.aliased >= 2);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("two staged men answering to one nickname is REFUSED, not guessed", () => {
  const { path, dir } = fixture();
  try {
    const r = buildStgPlayer(path);
    const db = openDb(path);
    assert.equal(db.prepare("SELECT 1 FROM stg_player_alias WHERE name_key='roblee'").get(), undefined, "Rob Lee could be Robert OR Bobby -- no alias");
    assert.equal(r.aliasRefused, 1);
    assert.ok(db.prepare("SELECT 1 FROM stg_player WHERE name_key='roblee' AND source='board'").get(), "the refused row is staged on its own, as before");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a board-only player on a NON-active league is staged -- once, across two boards and two positions", () => {
  const { path, dir } = fixture();
  try {
    buildStgPlayer(path);
    const db = openDb(path);
    const rows = db.prepare("SELECT position FROM stg_player WHERE name_key='zedrookie'").all() as { position: string }[];
    assert.equal(rows.length, 1, "one man on two boards is one staged row");
    assert.equal(rows[0].position, "RB", "the ACTIVE league's classification wins");
    // every board row in every league now resolves (name_key or alias)
    const gap = db.prepare(`SELECT COUNT(*) c FROM board b WHERE NOT EXISTS (SELECT 1 FROM stg_player s WHERE s.name_key=b.player_id)
                             AND NOT EXISTS (SELECT 1 FROM stg_player_alias a WHERE a.name_key=b.player_id)`).get() as { c: number };
    assert.equal(gap.c, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("rebuilding staging is idempotent for aliases", () => {
  const { path, dir } = fixture();
  try {
    const a = buildStgPlayer(path);
    const b = buildStgPlayer(path);
    assert.equal(b.aliased, a.aliased);
    assert.equal(b.rows, a.rows);
    const db = openDb(path);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM stg_player_alias").get() as { c: number }).c, a.aliased);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a board-only duplicate that a nickname now resolves is MERGED in identity_rekey, never dropped", () => {
  // Kenny Gainwell was staged as a board-only row (no ids) while the crosswalk held Kenneth Gainwell:
  // one man, two keys. Once the alias resolves him, the old board key must say where it went.
  const { path, dir } = fixture();
  try {
    let db = openDb(path);
    const season = (JSON.parse((db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string }).value) as { season: number }).season;
    db.prepare("INSERT INTO board (league_id, player_id, player_sk, season, row_json, updated_at) VALUES ('A','kennygainwell',NULL,?,?,'x')")
      .run(season, JSON.stringify({ Player: "Kenny Gainwell", Pos: "RB", Team: "" }));
    db.close();
    buildStgPlayer(path);                                   // crosswalk lacks Kenneth: Kenny is staged on his own
    db = openDb(path);
    const old = db.prepare("SELECT player_sk FROM stg_player WHERE name_key='kennygainwell'").get() as { player_sk: number };
    assert.ok(old, "precondition: the board-only duplicate exists");
    db.prepare(`INSERT INTO player_ids (name_key, position, name, team, birthdate, gsis_id, ambiguous, updated_at)
                VALUES ('kennethgainwell','RB','Kenneth Gainwell','MIN','1999-03-14','00-0000009',0,'x')`).run();
    db.close();
    const r = buildStgPlayer(path);
    db = openDb(path);
    const kenneth = db.prepare("SELECT player_sk FROM stg_player WHERE name_key='kennethgainwell'").get() as { player_sk: number };
    assert.equal(db.prepare("SELECT 1 FROM stg_player WHERE name_key='kennygainwell'").get(), undefined, "the duplicate row is gone");
    const map = db.prepare("SELECT new_sk, reason FROM identity_rekey WHERE old_sk=?").all(old.player_sk) as { new_sk: number | null; reason: string }[];
    db.close();
    // "moved" here (Kenneth is new to this fixture); on a store that already held him it reads
    // "merged" -- the live 2026-10-06 rebuild recorded exactly that for Kenny Gainwell and Matt Hibner.
    assert.equal(map.length, 1);
    assert.equal(map[0].new_sk, kenneth.player_sk, "the old key points at the man it always was");
    assert.notEqual(map[0].reason, "dropped");
    assert.equal(r.rekey.dropped, 0);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
