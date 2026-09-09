import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { streamingRegret, realFaPool, POOL_DEPTH } from "../src/weekly/streamingEvaluate.js";

/**
 * WHICH POOL THE STREAMING METRIC ACTUALLY USED.
 *
 * The defect this guards was a LABEL, not arithmetic. `poolSource` was set to `fact_fa_pool_week`
 * the moment that table EXISTED in the store, while `streamingRegret` went on filtering by
 * `rank > POOL_DEPTH[pos]` -- the season-line approximation -- in every case. A store with Track B's
 * table therefore reported approximation numbers under the real pool's name, and nothing could have
 * noticed: both pools produce a pick, both produce a plausible mean, and the only difference is who
 * was eligible to be picked.
 *
 * So the test is not "does it produce a number". It is: on a fixture where the two pools contain
 * DIFFERENT men, do the two modes pick differently?
 */

/** Two men at QB. The rank pool admits only the low-ranked one; the real pool admits only the other. */
const rows = () => [
  {
    key: "A", pos: "QB", season: 2020, week: 1, actual: 30, line: 20, rank: 1, t4: 20,
    realFa: true,                       // in the REAL pool, but rank 1 so the approximation excludes him
    by: { streaming: { mean: 25, p10: 1, p50: 20, p90: 40 } },
  },
  {
    key: "B", pos: "QB", season: 2020, week: 1, actual: 3, line: 2, rank: 999, t4: 2,
    realFa: false,                      // outside the REAL pool, but rank 999 so the approximation includes him
    by: { streaming: { mean: 2, p10: 0, p50: 2, p90: 5 } },
  },
  {
    key: "C", pos: "QB", season: 2020, week: 1, actual: 1, line: 1, rank: 998, t4: 1,
    realFa: true,
    by: { streaming: { mean: 1, p10: 0, p50: 1, p90: 3 } },
  },
];

test("the REAL pool and the rank approximation select DIFFERENT men, and the mode decides which", () => {
  const rank = streamingRegret(rows(), POOL_DEPTH, ["streaming"], "rank");
  const real = streamingRegret(rows(), POOL_DEPTH, ["streaming"], "real");

  const pick = (t: Record<string, { model: string; meanActual: number }[]>) =>
    t.QB?.find((x) => x.model === "streaming")?.meanActual;

  // The rank pool holds B (999) and C (998) only -- A is rank 1 and rostered by the approximation.
  assert.equal(pick(rank), 3, "the rank pool should have picked B, the best of {B, C}");
  // The real pool holds A and C. A is the whole point: a top-ranked man who was genuinely unrostered.
  assert.equal(pick(real), 30, "the real pool should have picked A -- if it picked 3 the mode is ignored");
  assert.notEqual(pick(rank), pick(real),
    "the two pools produced the same answer, so this fixture cannot detect the label-only defect");
});

test("realFaPool reads the table, and returns null rather than an empty pool when there is none", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-fa-"));
  const db = new Database(join(dir, "t.db"));
  // NO TABLE at all: null, so the caller falls back and says so. Returning an empty Map here would
  // mark every player "not a free agent", empty every pool, and report "no weeks" -- a null that
  // looks exactly like a small measurement.
  assert.equal(realFaPool(db as never, [2020]), null, "a store with no table must report null");

  db.exec("CREATE TABLE fact_fa_pool_week (season INTEGER, week INTEGER, player_sk TEXT, pos TEXT)");
  assert.equal(realFaPool(db as never, [2020]), null, "an EMPTY table must also report null, not an empty pool");

  db.exec("INSERT INTO fact_fa_pool_week VALUES (2020, 1, 'QB:X', 'QB'), (2020, 2, 'QB:Y', 'QB')");
  const pool = realFaPool(db as never, [2020]);
  assert.ok(pool, "a populated table must produce a pool -- the positive control");
  assert.equal(pool!.size, 2);
  assert.equal(pool!.has("2020|1|QB:X"), true);
  assert.equal(pool!.has("2020|1|QB:Y"), false, "the key must include the WEEK, not just the player");
  // A season the caller did not ask for is not in the set.
  assert.equal(realFaPool(db as never, [2021]), null, "a season with no rows must not borrow another's");
  db.close();
});
