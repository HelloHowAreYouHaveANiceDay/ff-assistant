/**
 * FEED FRESHNESS -- commit 2 of docs/week-state-design-2026-09-18.md.
 *
 * Across the ten copilot verbs, freshness reached ZERO of them. A verb read whatever the store held
 * and reported a confident number, so a store whose ESPN cache had been frozen for nine days
 * produced output indistinguishable from one synced a minute ago. The staleness was never hidden;
 * it was never asked for.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is the last one, and it exists because of a bug this registry
 * had on its first run: `player-status` printed `ingest-source news` as its refresh command, and
 * running that command left the feed exactly as stale. A registry whose refresh command does not
 * refresh is WORSE than no registry -- it converts a visible staleness into a believed fix. So every
 * refresh command is checked against the asset that actually writes the table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { FEEDS, feedStatus, stalenessCaveat } from "../src/data/feeds.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-18T12:00:00.000Z");

/** A store with one feed's table stamped at a chosen age, and the rest absent. */
function storeWith(table: string, column: string, asOf: string | null) {
  const db = openDb(":memory:");
  if (asOf != null) {
    // Every registered table already exists in the schema, so this only has to put a row in it.
    // EVERY NOT NULL COLUMN GETS A VALUE. Inserting only the stamp fails on a table like
    // `raw_gameday_status`, whose `season` is NOT NULL -- and that failure is the fixture's, not the
    // registry's, so it must not be allowed to read like a registry bug.
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; type: string; dflt_value: unknown }[];
    assert.ok(cols.length, `${table} is not in the schema -- the registry names a table that does not exist`);
    const need = cols.filter((c) => c.name === column || (c.notnull && c.dflt_value == null));
    const names = need.map((c) => c.name);
    const vals = need.map((c) => (c.name === column ? asOf : /INT|REAL/i.test(c.type) ? 0 : "x"));
    db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...vals);
  }
  return db;
}

test("REGISTRY: every feed names a table and column that actually exist", () => {
  // The cheapest possible rot check. A renamed column would otherwise make its feed permanently
  // `absent`, which reads as "you have never synced this" rather than "the registry is wrong".
  const db = openDb(":memory:");
  try {
    for (const f of FEEDS) {
      const cols = (db.prepare(`PRAGMA table_info(${f.table})`).all() as { name: string }[]).map((c) => c.name);
      assert.ok(cols.length, `feed "${f.id}" names table ${f.table}, which is not in the schema`);
      assert.ok(cols.includes(f.asOfColumn),
        `feed "${f.id}" dates itself by ${f.table}.${f.asOfColumn}, which does not exist. Columns: ${cols.join(", ")}`);
    }
  } finally { db.close(); }
});

test("VERDICTS: fresh, stale and absent are three different answers", () => {
  const f = FEEDS.find((x) => x.id === "ownership")!;
  const fresh = storeWith(f.table, f.asOfColumn, new Date(NOW.getTime() - 1 * HOUR).toISOString());
  const stale = storeWith(f.table, f.asOfColumn, new Date(NOW.getTime() - (f.maxAgeHours + 5) * HOUR).toISOString());
  const empty = storeWith(f.table, f.asOfColumn, null);
  try {
    const only = (db: ReturnType<typeof openDb>) => feedStatus(db, NOW, [f])[0];
    assert.equal(only(fresh).verdict, "fresh");
    assert.equal(only(stale).verdict, "stale");
    // ABSENT IS NOT STALE. They have different fixes, and a fresh clone would otherwise report nine
    // stale feeds and tell the reader to re-run syncs that have never run.
    assert.equal(only(empty).verdict, "absent");
    assert.match(only(empty).note, /NO ROWS/);
    assert.notEqual(only(empty).note, only(stale).note);
  } finally { fresh.close(); stale.close(); empty.close(); }
});

test("VERDICTS: the boundary is the stated limit, not a vibe", () => {
  const f = FEEDS.find((x) => x.id === "ownership")!;
  const just = storeWith(f.table, f.asOfColumn, new Date(NOW.getTime() - (f.maxAgeHours - 0.1) * HOUR).toISOString());
  const past = storeWith(f.table, f.asOfColumn, new Date(NOW.getTime() - (f.maxAgeHours + 0.1) * HOUR).toISOString());
  try {
    assert.equal(feedStatus(just, NOW, [f])[0].verdict, "fresh", "just inside the limit is fresh");
    assert.equal(feedStatus(past, NOW, [f])[0].verdict, "stale", "just past it is stale");
  } finally { just.close(); past.close(); }
});

test("CAVEAT: silent when everything is fresh -- that is the design, not an omission", () => {
  // A DEGRADED banner on every run is wallpaper within a week, and the next real staleness scrolls
  // past unread. This is the assertion that keeps it from being "improved" into always printing.
  const f = FEEDS.find((x) => x.id === "ownership")!;
  const db = storeWith(f.table, f.asOfColumn, new Date(NOW.getTime() - 1 * HOUR).toISOString());
  try {
    assert.equal(stalenessCaveat(feedStatus(db, NOW, [f])), null);
  } finally { db.close(); }
});

test("CAVEAT: names the stale feed, what it powers, and the command", () => {
  // The other direction. A caveat that says "some data is old" is one the reader cannot act on.
  const f = FEEDS.find((x) => x.id === "gameday-status")!;
  const db = storeWith(f.table, f.asOfColumn, new Date(NOW.getTime() - 100 * HOUR).toISOString());
  try {
    const c = stalenessCaveat(feedStatus(db, NOW, [f]));
    assert.ok(c, "a stale feed must produce a caveat");
    assert.match(c!, /gameday-status/);
    assert.match(c!, /who can play/);
    assert.match(c!, /ingest-raw gameday-status/);
  } finally { db.close(); }
});

test("an UNDATABLE stamp is `unknown`, not silently fresh", () => {
  const f = FEEDS.find((x) => x.id === "ownership")!;
  const db = storeWith(f.table, f.asOfColumn, "not-a-date");
  try {
    const s = feedStatus(db, NOW, [f])[0];
    assert.equal(s.verdict, "unknown");
    assert.equal(s.ageHours, null);
    assert.ok(stalenessCaveat([s]), "an undatable feed is not a healthy one");
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------
// THE ONE THAT CAUGHT A REAL BUG
// ---------------------------------------------------------------------------------------------

test("every refresh command names an asset that ACTUALLY WRITES the feed's table", () => {
  /**
   * `player-status` shipped in the first draft of this registry pointing at `ingest-source news`.
   * Running that command left the feed exactly as stale: `player_status` is written by the `status`
   * asset (Sleeper), not by `news`. It was caught by RUNNING the printed command and watching the
   * feed not move -- which is the only check that can catch it, and is exactly the "prove the lever
   * is connected" rule this repo keeps relearning.
   *
   * This asserts the same thing statically, against `ingest.ts`'s own `writes:` declarations, so the
   * next wrong command fails here instead of in somebody's Sunday morning.
   */
  const ingest = readFileSync("src/data/ingest.ts", "utf8");
  const checked: string[] = [];
  for (const f of FEEDS) {
    if (f.refreshNotDeclared) {
      // An exemption must carry a reason, and the reason must be substantive -- an empty string
      // would otherwise be a blanket mute wearing the shape of a considered decision.
      assert.ok(f.refreshNotDeclared.length > 30,
        `feed "${f.id}" is exempt from the writes: check but gives no real reason`);
      continue;
    }
    const m = /ingest-(source|raw)\s+([a-z0-9-]+)/.exec(f.refresh);
    if (!m) continue;                       // e.g. `sync-rosters`, which is a verb not an asset
    const assetId = m[2];
    // Find that asset's declaration and confirm it claims to write this feed's table.
    const decl = new RegExp(`id:\\s*"${assetId}"[\\s\\S]{0,600}?writes:\\s*\\[([^\\]]*)\\]`).exec(ingest);
    assert.ok(decl, `feed "${f.id}" refreshes with \`${f.refresh}\` but no asset id "${assetId}" declares a writes: list in src/data/ingest.ts`);
    assert.ok(decl![1].includes(`"${f.table}"`),
      `feed "${f.id}" says to run \`${f.refresh}\`, but asset "${assetId}" declares writes: [${decl![1].trim()}] -- ` +
      `which does NOT include ${f.table}. Running that command would not refresh this feed.`);
    checked.push(f.id);
  }
  assert.ok(checked.length >= 5, `only ${checked.length} feeds had a checkable ingest command -- this test would pass vacuously`);
});

test("no two feeds share an id, and every one states what it powers", () => {
  assert.equal(new Set(FEEDS.map((f) => f.id)).size, FEEDS.length, "duplicate feed id");
  for (const f of FEEDS) {
    assert.ok(f.powers.length > 10, `feed "${f.id}" does not say what it powers, so a reader cannot tell whether to care`);
    assert.ok(f.maxAgeHours > 0, `feed "${f.id}" has a non-positive limit`);
  }
});
