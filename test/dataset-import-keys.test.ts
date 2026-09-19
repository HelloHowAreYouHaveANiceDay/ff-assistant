/**
 * THE KEY FOOTGUN, MADE TO FIRE.
 *
 * `player_sk` is a minted AUTOINCREMENT surrogate. It is meaningful only inside the database that
 * minted it: the release's 11775 and your store's 11775 are two different players, and an identity
 * rebuild reassigns them (this store's own `identity_rekey` log records one moving 11,974 of 12,021
 * keys). So a cross-database `INSERT ... SELECT` keyed on it attaches the release's rows to whoever
 * holds that number locally. EVERY ROW STILL MATCHES SOMETHING. Nothing errors. The store is now
 * wrong everywhere and looks fine.
 *
 * That bug class was fixed once on the export side. These tests are the import side, and they exist
 * because the failure is silent -- there is no natural signal to notice, so the signal is
 * manufactured here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_SOURCES, IDENTITY_TABLES, buildBridge, planImport, targetHasIdentities,
  assertPublishedDataset,
} from "../src/data/datasetImport.js";

/** A tiny "release": a dim_player_key plus one keyed feature table. */
function makeRelease(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE dim_player_key (player_sk TEXT PRIMARY KEY, name TEXT, position TEXT, resolved_by TEXT,
      gsis_id TEXT, mfl_id TEXT, sportradar_id TEXT, pfr_id TEXT, sleeper_id TEXT, espn_id TEXT,
      yahoo_id TEXT, fantasypros_id TEXT);
    CREATE TABLE feat_player_week (player_sk TEXT, season INT, week INT, pts REAL);
    -- Key 100 is ALICE in the release.
    INSERT INTO dim_player_key VALUES ('100','Alice','WR','xref-gsis','00-0000001',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    -- Key 200 has no external id at all: unbridgeable by construction.
    INSERT INTO dim_player_key VALUES ('200','Ghost','RB','unresolved',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO dim_player_key VALUES ('DST:NE','NE DST','DST','dst-synthetic',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO feat_player_week VALUES ('100',2026,1,10.5),('200',2026,1,4.0),('DST:NE',2026,1,7.0);
  `);
  db.close();
}

/** A local store where key 100 is somebody ELSE, and Alice is key 999. */
function makeLocal(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE player_identity (player_sk INTEGER PRIMARY KEY AUTOINCREMENT, name_key TEXT);
    CREATE TABLE player_xref (player_sk INTEGER, source TEXT, source_id TEXT, PRIMARY KEY (source, source_id));
    CREATE TABLE stg_player (player_sk INTEGER PRIMARY KEY, name_key TEXT);
    CREATE TABLE feat_player_week (player_sk TEXT, season INT, week INT, pts REAL);
    INSERT INTO player_identity (player_sk, name_key) VALUES (100,'bob'), (999,'alice');
    -- Alice's gsis maps to 999 HERE. The release calls her 100. That mismatch is the whole point.
    INSERT INTO player_xref VALUES (999,'gsis','00-0000001');
  `);
  db.close();
}

function attached(): { db: InstanceType<typeof Database>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ff-import-"));
  const rel = join(dir, "release.db");
  const loc = join(dir, "local.db");
  makeRelease(rel);
  makeLocal(loc);
  const db = new Database(loc);
  db.exec(`ATTACH DATABASE '${rel.replace(/'/g, "''")}' AS src`);
  return { db, dir };
}

test("THE BRIDGE MAPS A KEY TO A DIFFERENT NUMBER -- which is the whole reason it exists", () => {
  const { db } = attached();
  try {
    const { bridge } = buildBridge(db as never);
    // Release 100 is Alice; locally Alice is 999. A correct bridge must NOT be the identity function.
    assert.equal(bridge.get("100"), "999",
      "the release's key 100 must map to the LOCAL key for the same player, not to 100");
    assert.notEqual(bridge.get("100"), "100",
      "the bridge returned the key unchanged -- that is the silent-corruption bug, not a bridge");
    // Unbridgeable stays unbridgeable rather than falling back to the raw number.
    assert.equal(bridge.has("200"), false, "a player with no shared id must NOT be mapped on a guess");
    // DST is deterministic and passes through, which is the one safe case.
    assert.equal(bridge.get("DST:NE"), "DST:NE");
  } finally { db.close(); }
});

test("A NAIVE COPY WOULD CORRUPT, and this shows exactly how", () => {
  // The control that makes the test above mean something. Without seeing the wrong answer, "100
  // maps to 999" is just a number.
  const { db } = attached();
  try {
    const naive = db.prepare("SELECT player_sk FROM src.feat_player_week WHERE player_sk='100'").get() as { player_sk: string };
    const whoThatIsLocally = db.prepare("SELECT name_key FROM player_identity WHERE player_sk = ?").get(naive.player_sk) as { name_key: string };
    assert.equal(whoThatIsLocally.name_key, "bob",
      "setup check: the release's key 100 must belong to somebody else locally");
    // So `INSERT INTO feat_player_week SELECT * FROM src.feat_player_week` would file Alice's week
    // under Bob, with no error and no null.
    const bridged = buildBridge(db as never).bridge.get("100")!;
    const whoBridgeSays = db.prepare("SELECT name_key FROM player_identity WHERE player_sk = ?").get(bridged) as { name_key: string };
    assert.equal(whoBridgeSays.name_key, "alice", "the bridge must land on the right player");
  } finally { db.close(); }
});

test("PLANNING COUNTS the rows that cannot be bridged rather than dropping them quietly", () => {
  const { db } = attached();
  try {
    const plan = planImport(db as never, { mode: "merge" });
    const fpw = plan.tables.find((t) => t.table === "feat_player_week")!;
    assert.equal(fpw.srcRows, 3);
    assert.equal(fpw.mapped, 2, "Alice and the DST bridge");
    assert.equal(fpw.unmapped, 1, "Ghost has no shared id and must be COUNTED, not silently lost");
    assert.equal(plan.unbridgeable, 1);
  } finally { db.close(); }
});

test("IDENTITY TABLES ARE REFUSED in a merge -- you cannot remap the map with itself", () => {
  const { db } = attached();
  try {
    const plan = planImport(db as never, { mode: "merge" });
    // LITERAL NAMES, NOT `IDENTITY_TABLES`. Looping over the constant under test makes the loop
    // vacuous the moment somebody empties it -- which is exactly what a fault injection did: the
    // list was set to [] and all seven tests still passed. A guard keyed on the thing it guards
    // cannot fail when that thing is removed.
    for (const t of ["player_identity", "player_xref", "stg_player"]) {
      assert.ok(!plan.tables.some((x) => x.table === t), `${t} must not be planned for a merge`);
    }
    // And the constant must still NAME them, so the two cannot drift apart silently either.
    assert.deepEqual([...IDENTITY_TABLES].sort(), ["player_identity", "player_xref", "stg_player"],
      "IDENTITY_TABLES changed -- if that was deliberate, change this assertion deliberately");
    // FRESH is the opposite: there is no local registry to collide with, so adopting the release's
    // is exactly right. Asserting both directions, because a rule that only ever refuses is a rule
    // that has disabled a feature.
    const fresh = planImport(db as never, { mode: "fresh" });
    assert.equal(fresh.identityRefused.length, 0, "fresh mode must not refuse the identity tables");
  } finally { db.close(); }
});

test("MODE IS DETECTED from whether the target already has identities", () => {
  const { db } = attached();
  try {
    assert.equal(targetHasIdentities(db as never), true);
    assert.equal(planImport(db as never).mode, "merge", "a store with identities must default to merge");
  } finally { db.close(); }
});

test("A FILE WITHOUT dim_player_key IS REFUSED, because there is no way to bridge it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-import-bad-"));
  const bad = join(dir, "bad.db");
  new Database(bad).exec("CREATE TABLE feat_player_week (player_sk TEXT, pts REAL)");
  const db = new Database(join(dir, "t.db"));
  try {
    db.exec(`ATTACH DATABASE '${bad.replace(/'/g, "''")}' AS src`);
    assert.throws(() => assertPublishedDataset(db as never), /no .dim_player_key./,
      "a file with no crosswalk must be refused -- importing it on player_sk alone is the corruption");
  } finally { db.close(); }
});

test("EVERY BRIDGE SOURCE IS A STABLE EXTERNAL ID -- player_sk is not among them", () => {
  // The rule stated as an assertion. If somebody ever adds `player_sk` here as a convenience for
  // the keys that happen to line up, this fails: "happens to line up" is the bug.
  for (const s of BRIDGE_SOURCES) {
    assert.notEqual(s.column, "player_sk", "player_sk is snapshot-local and can never be a bridge source");
    assert.notEqual(s.xrefSource, "player_sk");
  }
  assert.ok(BRIDGE_SOURCES.some((s) => s.xrefSource === "gsis"), "gsis must be one of the routes");
});
