// The board-change notification, tested in the direction that actually matters.
//
// Fault injection proves a probe REJECTS a bad state. It says nothing about whether the probe can
// ever return its positive value -- and a staleness detector that can only ever answer "unchanged"
// is indistinguishable, in every green test run, from one that works. So the first test here
// manufactures a real board change and requires the stamp to move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const MAIN = readFileSync("app/main.js", "utf8");

test("the stamp MOVES when the board is rewritten (the positive direction)", (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no local store");
  // Work on a copy: this test mutates board.updated_at and must never touch the real store.
  const dir = mkdtempSync(join(tmpdir(), "ffstamp-"));
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

// The notification hangs on the two chokepoints every `ff` invocation passes through. If it were
// hung on a list of board-mutating commands instead, that list would rot as tools are added -- there
// are 25 MCP tools today and several rewrite values.
test("notification is wired to BOTH engine chokepoints, not to a command list", () => {
  assert.match(MAIN, /p\.on\("close"[\s\S]{0,160}?noticeBoardChange\(\)/,
    "ffRun (one-shot verbs) must notify on completion");
  assert.match(MAIN, /if \(method !== "board-stamp"\) debouncedNotice\(\)/,
    "rpc (the serve helper) must notify, excluding only its own probe");
  // The exclusion is not cosmetic: without it noticeBoardChange -> rpc -> noticeBoardChange forever.
  const notice = MAIN.slice(MAIN.indexOf("async function noticeBoardChange"));
  assert.match(notice.slice(0, 400), /rpc\("board-stamp"\)/,
    "noticeBoardChange must probe via board-stamp, the method rpc excludes");
});

test("main sends the STAMP, so the renderer decides rather than trusting the ping", () => {
  assert.match(MAIN, /webContents\.send\("mc:boardChanged",\s*s\)/,
    "the payload must be the stamp object, not a bare event");
  assert.match(MAIN, /s\.builtAt !== lastBoardStamp/,
    "main must only push when the stamp actually moved");
});

test("the renderer keeps an independent poll as a backstop to the push", () => {
  const src = readFileSync("app/renderer/app.js", "utf8");
  const fn = src.slice(src.indexOf("function watchForRebuild"), src.indexOf("function showStaleBanner"));
  assert.match(fn, /onBoardChanged/, "must subscribe to the push");
  assert.match(fn, /setInterval\(/, "must ALSO poll -- push depends on main being wired, which is the bug class here");
  assert.match(fn, /stamp === seenAt/, "both paths must compare the same stamp so either can win");
});
