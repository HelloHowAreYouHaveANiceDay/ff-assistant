// The staging layer's invariants. These are not unit tests of a function -- they are assertions
// about the SHAPE of the layer, because the whole point of staging is that downstream code can rely
// on properties holding without re-checking them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { playerKey, normPos } from "../src/data/stgPlayer.js";

const DB = "data/ff.db";
const ready = (() => {
  if (!existsSync(DB)) return false;
  try {
    const db = new Database(DB, { readonly: true });
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stg_player'").get();
    const n = r ? (db.prepare("SELECT COUNT(*) c FROM stg_player").get() as { c: number }).c : 0;
    db.close();
    return n > 0;
  } catch { return false; }
})();
const open = () => new Database(DB, { readonly: true });

test("player_sk is unique -- staging is one row per real player", (t) => {
  if (!ready) return t.skip("stg_player not built (run: ff build-staging)");
  const db = open();
  const dupes = db.prepare("SELECT COUNT(*) c FROM (SELECT player_sk FROM stg_player GROUP BY player_sk HAVING COUNT(*)>1)").get() as { c: number };
  db.close();
  assert.equal(dupes.c, 0);
});

// THE INVARIANT THIS LAYER EXISTS FOR. A gsis id used as a key must belong to exactly one person.
// The source crosswalk violates this on ten ids -- 00-0022888 is attached to both Jake Schum (punter)
// and Bobby McCray (defensive end) -- and keying on it blindly merged those pairs into a single
// staging row, silently, which is the very failure staging is supposed to end.
test("a gsis_id shared by different people is never used as a key, and never recorded", (t) => {
  if (!ready) return t.skip("stg_player not built");
  const db = open();
  const shared = db.prepare(
    `SELECT gsis_id FROM player_ids WHERE gsis_id IS NOT NULL
     GROUP BY gsis_id HAVING COUNT(DISTINCT name_key || '|' || position) > 1`,
  ).all() as { gsis_id: string }[];
  for (const s of shared) {
    const used = db.prepare("SELECT COUNT(*) c FROM stg_player WHERE player_sk = ? OR gsis_id = ?").get(s.gsis_id, s.gsis_id) as { c: number };
    assert.equal(used.c, 0, `disputed gsis ${s.gsis_id} must not be a key or a recorded id`);
  }
  // ...and the people who shared it must both survive as separate rows.
  if (shared.length) {
    const both = db.prepare("SELECT COUNT(*) c FROM stg_player WHERE name IN ('Jake Schum','Bobby McCray')").get() as { c: number };
    if (both.c) assert.equal(both.c, 2, "both men must exist independently");
  }
  db.close();
});

test("nothing is silently lost: every crosswalk player reaches staging", (t) => {
  if (!ready) return t.skip("stg_player not built");
  const db = open();
  // Compared in the CONFORMED vocabulary. Checking raw player_ids.position against staged
  // position compares PK to K and reports every kicker as lost -- the test would be measuring the
  // vocabulary gap it exists downstream of, not whether anyone was dropped.
  const raw = db.prepare("SELECT name_key, position FROM player_ids").all() as { name_key: string; position: string }[];
  const have = new Set((db.prepare("SELECT name_key, position FROM stg_player").all() as { name_key: string; position: string }[])
    .map((r) => r.name_key + "|" + r.position));
  const missing = raw.filter((r) => !have.has(r.name_key + "|" + normPos(r.position)));
  db.close();
  assert.equal(missing.length, 0, `dropped ${missing.length} players, e.g. ${missing.slice(0,3).map((m) => m.name_key + "/" + m.position).join(", ")}`);
});

test("every current board player resolves -- staging cannot lose the people we act on", (t) => {
  if (!ready) return t.skip("stg_player not built");
  const db = open();
  const gap = db.prepare(
    `SELECT COUNT(*) c FROM board b
     WHERE b.season = (SELECT CAST(json_extract(value,'$.season') AS INTEGER) FROM settings WHERE key='config')
       AND NOT EXISTS (SELECT 1 FROM stg_player s WHERE s.name_key = b.player_id)`,
  ).get() as { c: number };
  db.close();
  assert.equal(gap.c, 0);
});

test("ambiguity is FLAGGED rather than resolved by guessing", (t) => {
  if (!ready) return t.skip("stg_player not built");
  const db = open();
  // Any name_key standing for more than one position must appear as multiple rows, all flagged.
  const bad = db.prepare(
    `SELECT COUNT(*) c FROM (
       SELECT name_key FROM stg_player GROUP BY name_key
       HAVING COUNT(*) > 1 AND SUM(ambiguous) < COUNT(*))`,
  ).get() as { c: number };
  db.close();
  assert.equal(bad.c, 0, "a shared name must have every one of its rows flagged, not some");
});

test("playerKey requires a position and returns null rather than guessing", (t) => {
  if (!ready) return t.skip("stg_player not built");
  const db = open();
  // A real board player resolves.
  const one = db.prepare("SELECT name_key, position FROM stg_player WHERE source='playerids' AND ambiguous=0 LIMIT 1").get() as { name_key: string; position: string };
  assert.ok(playerKey(db, one.name_key, one.position), "an unambiguous player must resolve");
  assert.equal(playerKey(db, one.name_key, "ZZ"), null, "a wrong position must not fall back to the name");
  assert.equal(playerKey(db, "definitelynotaplayer", "RB"), null);
  db.close();
});
