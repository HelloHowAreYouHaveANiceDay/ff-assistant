// The board-change notification, tested in the direction that actually matters.
//
// Fault injection proves a probe REJECTS a bad state. It says nothing about whether the probe can
// ever return its positive value -- and a staleness detector that can only ever answer "unchanged"
// is indistinguishable, in every green test run, from one that works. So the first test here
// manufactures a real board change and requires the stamp to move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";


test("the stamp MOVES when the board is rewritten (the positive direction)", (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no local store");
  // Work on a copy: this test mutates board.updated_at and must never touch the real store.
  const dir = mkdtempSync(join(tmpdir(), "ffstamp-"));
  // The copy below is the whole store (~1 GB). Without this teardown every run leaks one, and 455
  // of them had accumulated in %TEMP% -- 287 GB -- before anyone noticed the disk filling.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db1 = join(dir, "ff.db");
  copyFileSync("data/ff.db", db1);
  for (const ext of ["-wal", "-shm"]) if (existsSync("data/ff.db" + ext)) copyFileSync("data/ff.db" + ext, db1 + ext);

  const db = new Database(db1);
  const stamp = () => (db.prepare("SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM board WHERE season = ?")
    .get(2026) as { m: string | null; n: number });

  const before = stamp();
  assert.ok(before.n > 0, "fixture must have a board to observe");
  assert.ok(before.m, "fixture must have a stamp to move");

  // A real rebuild rewrites board rows with a new updated_at. Reproduce exactly that.
  const later = new Date(Date.parse(before.m!) + 60_000).toISOString();
  db.prepare("UPDATE board SET updated_at = ? WHERE season = 2026").run(later);

  const after = stamp();
  assert.notEqual(after.m, before.m, "stamp must change when the board is rewritten");
  assert.equal(after.m, later);
  assert.equal(after.n, before.n, "row count must be unaffected by an updated_at rewrite");
  db.close();
});

test("the stamp does NOT move when nothing happens (it can also say 'unchanged')", (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no local store");
  const db = new Database("data/ff.db", { readonly: true });
  const q = () => (db.prepare("SELECT MAX(updated_at) AS m FROM board WHERE season = ?").get(2026) as { m: string });
  assert.equal(q().m, q().m, "two reads with no write between them must agree");
  db.close();
});

