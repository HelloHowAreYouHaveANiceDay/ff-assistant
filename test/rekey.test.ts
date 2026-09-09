// MIGRATING A WRITE-ONCE TABLE THROUGH `identity_rekey`.
//
// `scorecard_prediction` is frozen by design and its `subject` IS a `player_sk` for the player
// kinds, so a rekey silently unjoins every row in it: the value is still there, the row still
// renders, and it names nobody. On the real store that took the `season` kind from 490 rows joining
// staging to 63.
//
// Built on an in-memory fixture rather than the real store, because the two failures worth testing
// -- an overlapping key space and a mid-migration collision -- both need a shape you cannot ask the
// live table for on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateScorecardSubjects, rekeyMap } from "../src/data/rekey.js";
import type { DB } from "../src/db/db.js";

function fixture(rekey: [number, number | null, string][], subjects: { sub: string; kind: string; model: string; name?: string; pos?: string }[]): DB {
  const db = new Database(":memory:") as unknown as DB;
  db.exec(`
    CREATE TABLE identity_rekey (old_sk INTEGER, new_sk INTEGER, reason TEXT, rebuilt_at TEXT);
    CREATE TABLE stg_player (player_sk INTEGER PRIMARY KEY, name_key TEXT, name TEXT, position TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scorecard_prediction (season INTEGER, week INTEGER, kind TEXT, model TEXT,
      subject TEXT, name TEXT, pos TEXT, value REAL, p10 REAL, p90 REAL, as_of TEXT, created_at TEXT,
      PRIMARY KEY (season, week, kind, model, subject));`);
  const ir = db.prepare("INSERT INTO identity_rekey VALUES (?,?,?,'STAMP-1')");
  const sp = db.prepare("INSERT INTO stg_player VALUES (?,?,?,?)");
  const seen = new Set<number>();
  for (const [o, n, r] of rekey) {
    ir.run(o, n, r);
    if (n != null && !seen.has(n)) { seen.add(n); sp.run(n, `p${n}`, `Player ${n}`, "RB"); }
  }
  const ins = db.prepare(
    "INSERT INTO scorecard_prediction VALUES (2026,1,@kind,@model,@sub,@name,@pos,1.0,NULL,NULL,'2026-09-01','x')",
  );
  for (const s of subjects) ins.run({ ...s, name: s.name ?? null, pos: s.pos ?? null });
  return db;
}

// THE FAILURE THAT SHIPPED, and it is the reason the migration is two passes. The old and new key
// spaces OVERLAP: 12097 is a live new key AND some other row's old subject. Checking "is my target
// taken?" against the table mid-migration therefore compares against rows that have not moved yet,
// and five real moves were reported as merge collisions because a row sitting on 12097 was about to
// move away from it.
test("a target held by a row that is ITSELF about to move is not a collision", () => {
  const db = fixture(
    [[22779, 12097, "moved"], [12097, 500, "moved"]],
    [{ sub: "22779", kind: "weekly", model: "weekly" }, { sub: "12097", kind: "weekly", model: "weekly" }],
  );
  const r = migrateScorecardSubjects(db);
  assert.equal(r.migrated, 2, `expected both rows to move, got ${JSON.stringify(r)}`);
  assert.equal(r.collided, 0);
  const subs = (db.prepare("SELECT subject FROM scorecard_prediction ORDER BY subject").all() as { subject: string }[]).map((x) => x.subject);
  assert.deepEqual(subs, ["12097", "500"]);
  db.close();
});

test("a REAL collision -- two old keys merged into one -- leaves the second row alone", () => {
  const db = fixture(
    [[10, 7, "merged"], [11, 7, "merged"]],
    [{ sub: "10", kind: "weekly", model: "weekly" }, { sub: "11", kind: "weekly", model: "weekly" }],
  );
  const r = migrateScorecardSubjects(db);
  assert.equal(r.migrated, 1);
  assert.equal(r.collided, 1, "the second row must be counted, not deleted and not overwritten");
  const n = (db.prepare("SELECT COUNT(*) c FROM scorecard_prediction").get() as { c: number }).c;
  assert.equal(n, 2, "a write-once table never loses a row to a migration");
  db.close();
});

test("the odds kind is NOT migrated -- a team id is a different key space that happens to be numeric", () => {
  const db = fixture(
    [[7, 900, "moved"]],
    [{ sub: "7", kind: "odds", model: "playoff" }, { sub: "7", kind: "weekly", model: "weekly" }],
  );
  const r = migrateScorecardSubjects(db);
  assert.equal(r.migrated, 1, "only the player row moves");
  const odds = db.prepare("SELECT subject FROM scorecard_prediction WHERE kind='odds'").get() as { subject: string };
  assert.equal(odds.subject, "7", "team 7 must still be team 7");
  db.close();
});

// FAULT INJECTION on idempotence. The key spaces overlap, so a migrated subject is indistinguishable
// from an unmigrated one BY VALUE -- run the migration twice without a stamp and it walks the rows
// down the map a second time. The stamp is what stops it, so the test removes the stamp and shows
// the damage, then shows the stamp preventing it.
test("FAULT INJECTION: without the stamp a second run would migrate the SAME rows again", () => {
  const rekey: [number, number | null, string][] = [[10, 5, "moved"], [5, 3, "moved"]];
  const db = fixture(rekey, [{ sub: "10", kind: "weekly", model: "weekly" }]);
  assert.equal(migrateScorecardSubjects(db).migrated, 1);
  assert.equal((db.prepare("SELECT subject FROM scorecard_prediction").get() as { subject: string }).subject, "5");
  // With the stamp: a no-op.
  assert.equal(migrateScorecardSubjects(db).rows, 0, "a second run must do nothing at all");
  assert.equal((db.prepare("SELECT subject FROM scorecard_prediction").get() as { subject: string }).subject, "5");
  // Remove the stamp -- the injection -- and the row walks on to 3, which is somebody else.
  db.prepare("DELETE FROM settings WHERE key = 'scorecard_rekey'").run();
  assert.equal(migrateScorecardSubjects(db).migrated, 1);
  assert.equal((db.prepare("SELECT subject FROM scorecard_prediction").get() as { subject: string }).subject, "3",
    "without the stamp the migration is not idempotent -- which is what the stamp exists to stop");
  db.close();
});

test("rekeyMap groups a split into several targets and drops the dropped", () => {
  const db = fixture([[1, 2, "moved"], [3, 4, "split"], [3, 5, "split"], [9, null, "dropped"]], []);
  const m = rekeyMap(db);
  assert.deepEqual(m.get(1), [2]);
  assert.deepEqual(m.get(3)!.sort(), [4, 5]);
  assert.equal(m.has(9), false, "a dropped key has no target and must not appear as one");
  db.close();
});
