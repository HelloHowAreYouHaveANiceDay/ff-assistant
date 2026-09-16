// THE WEEKLY-CONSENSUS FAN-OUT INTO EVERY FORMAT STORE (D29, 2026-09-16).
//
// M2b retained each live FantasyPros weekly scrape into `ranking_history` -- in the INCUMBENT store
// only. A non-incumbent format reads its own `data/formats/<key>/features.db`, which carries a
// FROZEN copy of that table, so the Yahoo format's archive stopped on the day its store was built
// and no amount of weekly ingesting moved it. This asserts the fan-out reaches that copy, is
// idempotent, and REFUSES BY NAME rather than repairing a store that is not one.
//
// FF_DATA is read once at module load, so `ecrHistory` is imported dynamically after it is pointed
// at a fixture root -- nothing here can touch the real data/formats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "ff-fanout-"));
process.env.FF_DATA = root;
const formats = join(root, "formats");
mkdirSync(formats, { recursive: true });

// A REAL format key and its REAL scoring.json, so `checkPreimage` passes for the reason it exists
// (the file re-hashes to the directory name) rather than because a fixture was hand-written to.
const REAL_KEY = "sc-a845f67652fb";
const realScoring = join("data", "formats", REAL_KEY, "scoring.json");
const haveReal = existsSync(realScoring);

const RANKING_HISTORY_DDL = `CREATE TABLE ranking_history (
  source TEXT NOT NULL, ecr_type TEXT NOT NULL, season INTEGER, scrape_date TEXT NOT NULL,
  player_id TEXT NOT NULL, name TEXT, pos TEXT NOT NULL, team TEXT,
  ecr REAL, sd REAL, best REAL, worst REAL, fetched_at TEXT,
  PRIMARY KEY (source, ecr_type, scrape_date, player_id, pos))`;

function mkFormatStore(key: string, withTable: boolean): string {
  const dir = join(formats, key);
  mkdirSync(dir, { recursive: true });
  if (haveReal) copyFileSync(realScoring, join(dir, "scoring.json"));
  const db = new Database(join(dir, "features.db"));
  if (withTable) db.exec(RANKING_HISTORY_DDL);
  db.close();
  return dir;
}

const rows = [
  { name: "Josh Allen", pos: "QB", team: "BUF", ecr: 1, sd: 0.5, best: 1, worst: 3, scrapeDate: "2026-09-16" },
  { name: "Bijan Robinson", pos: "RB", team: "ATL", ecr: 2, sd: 0.8, best: 1, worst: 5, scrapeDate: "2026-09-16" },
];

const { fanOutWeeklyRankSnapshot } = await import("../src/data/ecrHistory.js");
const countWp = (dir: string) => {
  const db = new Database(join(dir, "features.db"), { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) c FROM ranking_history WHERE ecr_type='wp'").get() as { c: number }).c; }
  finally { db.close(); }
};

test("the scrape reaches a format store's OWN ranking_history, and a second run writes nothing", { skip: haveReal ? false : "data/formats/<key>/scoring.json is absent on this machine" }, () => {
  const dir = mkFormatStore(REAL_KEY, true);
  assert.equal(countWp(dir), 0, "the fixture store starts empty -- else the assertion below proves nothing");

  const first = fanOutWeeklyRankSnapshot(rows, "2026-09-16");
  const hit = first.find((f) => f.key === REAL_KEY);
  assert.ok(hit?.result, `the format store was skipped: ${hit?.skipped}`);
  assert.equal(hit!.result!.inserted, rows.length);
  assert.deepEqual(hit!.result!.dates, ["2026-09-16"]);
  assert.equal(countWp(dir), rows.length, "the rows are IN the format store, not only in the return value");

  // IDEMPOTENT. An archive any ingest can rewrite is not point-in-time; the tick runs every 15 min.
  const second = fanOutWeeklyRankSnapshot(rows, "2026-09-16");
  const again = second.find((f) => f.key === REAL_KEY)!;
  assert.equal(again.result!.inserted, 0);
  assert.equal(again.result!.ignored, rows.length);
  assert.equal(countWp(dir), rows.length);
});

test("a directory whose name is an unverifiable claim, or which has no ranking_history, is SKIPPED BY NAME", () => {
  // Preimage failure: a plausible-looking key with no scoring.json to re-hash.
  const bogus = join(formats, "sc-deadbeefdead");
  mkdirSync(bogus, { recursive: true });
  new Database(join(bogus, "features.db")).close();
  // A real key whose store carries no archive table: skipped, never migrated from here.
  const noTable = "sc-notable00000";
  const dir2 = join(formats, noTable);
  mkdirSync(dir2, { recursive: true });
  if (haveReal) copyFileSync(realScoring, join(dir2, "scoring.json"));  // re-hashes to REAL_KEY, not this name
  new Database(join(dir2, "features.db")).close();

  const out = fanOutWeeklyRankSnapshot(rows, "2026-09-16");
  const b = out.find((f) => f.key === "sc-deadbeefdead");
  assert.ok(b?.skipped, "a directory with no scoring.json must be skipped, not written to");
  assert.match(b!.skipped!, /scoring\.json|re-hash/);
  const n = out.find((f) => f.key === noTable);
  assert.ok(n?.skipped, "a store with no ranking_history must be skipped rather than migrated");
});

// The branch above is reached by the PREIMAGE check, so the "no archive table" refusal needs its own
// case: a store whose name is verified and whose table is gone. Without this the branch is unproven
// and a future edit could turn it into a silent CREATE TABLE in a model store.
test("a VERIFIED format store with the table dropped is refused, not migrated", { skip: haveReal ? false : "no real scoring.json on this machine" }, () => {
  const dir = join(formats, REAL_KEY);
  const db = new Database(join(dir, "features.db"));
  db.exec("DROP TABLE IF EXISTS ranking_history");
  db.close();
  const out = fanOutWeeklyRankSnapshot(rows, "2026-09-16");
  const hit = out.find((f) => f.key === REAL_KEY)!;
  assert.ok(hit.skipped, "a verified store with no archive table must be skipped");
  assert.match(hit.skipped!, /ranking_history/);
  const check = new Database(join(dir, "features.db"), { readonly: true });
  try {
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ranking_history'").get(), undefined,
      "the fan-out must not CREATE the table it found missing");
  } finally { check.close(); }
});
