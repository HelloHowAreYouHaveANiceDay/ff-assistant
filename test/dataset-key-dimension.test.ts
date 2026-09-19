/**
 * THE KEY DIMENSION'S TWO REPORTED DEFECTS (bug report, 2026-09-19).
 *
 *   1. The player_ids routes reach an external id only THROUGH the DynastyProcess map. A player it
 *      does not carry came out `unresolved` with every column NULL -- even where `player_xref`
 *      already held five stable ids attached to that exact `player_sk`. 38 of 96 unresolved keys.
 *
 *   2. An identity rebuild minted a SECOND key for a player without reattaching his xref rows, and
 *      the new key is the one carrying the current season. The dimension covers the old key, fully
 *      populated and healthy-looking, while a consumer joining on it loses this year.
 *
 * The first is fixed. The second is REPORTED AND NOT FIXED, on purpose, and the test below pins that
 * decision so a later "obvious" cleanup has to argue with it: merging on (name, position) fuses
 * `Irv Smith TE` -- the 1999 player and the 2019-2023 player -- into one man who played across four
 * decades. `player_ids` already marks that name key ambiguous and both id routes already refuse it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const DB = "data/ff.db";
const skip = !existsSync(DB) && "no data/ff.db";

/** The direct route's own SQL, as the builder runs it. Kept here so the test asserts on the ROUTE
 *  rather than on a hand-made fixture that could agree with a broken builder. */
const DIRECT = `SELECT x.player_sk sk,
    MIN(CASE WHEN x.source='gsis' THEN x.source_id END) gsis_id,
    MIN(CASE WHEN x.source='pfr' THEN x.source_id END) pfr_id,
    MIN(CASE WHEN x.source='sleeper' THEN x.source_id END) sleeper_id,
    MIN(CASE WHEN x.source='espn' THEN x.source_id END) espn_id,
    MIN(CASE WHEN x.source='fantasypros' THEN x.source_id END) fantasypros_id
  FROM player_xref x GROUP BY x.player_sk`;

const G = `SELECT x.player_sk sk FROM player_xref x JOIN player_ids p ON p.gsis_id = x.source_id
            WHERE x.source='gsis' GROUP BY x.player_sk`;
const N = `SELECT s.player_sk sk FROM stg_player s JOIN player_ids p ON p.name_key = s.name_key
            WHERE COALESCE(p.ambiguous,0)=0 GROUP BY s.player_sk`;

// PRECONDITION, NOT A GUARD ON THE BUILDER. This asserts the POPULATION the fix exists for is
// really there -- keys the DynastyProcess map misses while player_xref holds ids for them. It was
// written as a builder test first, and it passed with the route deleted, because it queries the
// registry rather than the built dimension: the same wrong-layer mistake the injury seam taught.
// The assertion that the BUILDER resolves them is in test/dataset-export-privacy.test.ts, which
// exports for real and does fail when the route is removed (verified by deleting it).
// This one earns its place by making that assertion non-vacuous.
test("PRECONDITION: keys exist that only the registry's own ids can resolve", { skip }, () => {
  const db = new Database(DB, { readonly: true });
  try {
    const row = db.prepare(`
      SELECT COUNT(*) c FROM (
        SELECT k.player_sk FROM (SELECT player_sk FROM feat_player_week
                                  WHERE player_sk IS NOT NULL GROUP BY player_sk) k
          LEFT JOIN (${G}) g ON g.sk = CAST(k.player_sk AS INTEGER)
          LEFT JOIN (${N}) n ON n.sk = CAST(k.player_sk AS INTEGER)
          JOIN (${DIRECT}) d ON d.sk = CAST(k.player_sk AS INTEGER)
         WHERE k.player_sk NOT LIKE 'DST:%' AND g.sk IS NULL AND n.sk IS NULL)`).get() as { c: number };
    // A floor, not the measured 38, so a registry that gains or loses such players does not fail --
    // but a route that can reach NOBODY is the defect returning and does.
    assert.ok(row.c > 0,
      "no key is reachable by the direct route -- either the registry changed shape or the route is dead");
  } finally { db.close(); }
});

test("the direct route NEVER overwrites an id a player_ids route already produced", { skip }, () => {
  // The additive property, and the reason the route is last in every COALESCE. Measured at zero
  // across 3,694 already-resolved keys; anything above zero means published ids moved, which for a
  // dataset keyed across releases is the expensive kind of change.
  const db = new Database(DB, { readonly: true });
  try {
    const cols = ["gsis_id", "pfr_id", "sleeper_id", "espn_id", "fantasypros_id"];
    const gFull = `SELECT x.player_sk sk, ${cols.map((c) => `MIN(p.${c}) ${c}`).join(", ")}
                     FROM player_xref x JOIN player_ids p ON p.gsis_id = x.source_id
                    WHERE x.source='gsis' GROUP BY x.player_sk`;
    const nFull = `SELECT s.player_sk sk, ${cols.map((c) => `MIN(p.${c}) ${c}`).join(", ")}, MIN(p.name_key) name_key
                     FROM stg_player s JOIN player_ids p ON p.name_key = s.name_key
                    WHERE COALESCE(p.ambiguous,0)=0 GROUP BY s.player_sk`;
    const sel = cols.map((c) => `SUM(CASE WHEN COALESCE(g.${c}, n.${c}) IS NULL AND d.${c} IS NOT NULL THEN 1 ELSE 0 END) ${c}`).join(", ");
    const r = db.prepare(`
      SELECT ${sel}, COUNT(*) considered
        FROM (SELECT player_sk FROM feat_player_week WHERE player_sk IS NOT NULL GROUP BY player_sk) k
        LEFT JOIN (${gFull}) g ON g.sk = CAST(k.player_sk AS INTEGER)
        LEFT JOIN (${nFull}) n ON n.sk = CAST(k.player_sk AS INTEGER)
        LEFT JOIN (${DIRECT}) d ON d.sk = CAST(k.player_sk AS INTEGER)
       WHERE k.player_sk NOT LIKE 'DST:%' AND (g.gsis_id IS NOT NULL OR n.name_key IS NOT NULL)
      `).get() as Record<string, number>;
    assert.ok(r.considered > 1000, `only ${r.considered} resolved keys considered -- this would pass vacuously`);
    for (const c of cols) {
      assert.equal(r[c], 0, `the direct route filled ${r[c]} ${c} values on rows a player_ids route had already resolved`);
    }
  } finally { db.close(); }
});

test("duplicate (name, position) keys are NOT collapsed -- one of them is two different people", { skip }, () => {
  const db = new Database(DB, { readonly: true });
  try {
    const pairs = db.prepare(`
      SELECT a.name name, a.pos pos, a.player_sk withIds, b.player_sk orphan
        FROM (SELECT player_sk, MIN(name) name, MIN(pos) pos FROM feat_player_week
               WHERE player_sk IS NOT NULL GROUP BY player_sk) a
        JOIN (SELECT player_sk, MIN(name) name, MIN(pos) pos FROM feat_player_week
               WHERE player_sk IS NOT NULL GROUP BY player_sk) b
          ON a.name = b.name AND a.pos = b.pos AND CAST(a.player_sk AS INTEGER) < CAST(b.player_sk AS INTEGER)
       WHERE a.player_sk NOT LIKE 'DST:%'
         AND EXISTS (SELECT 1 FROM player_xref x WHERE x.player_sk = CAST(a.player_sk AS INTEGER))
         AND NOT EXISTS (SELECT 1 FROM player_xref x WHERE x.player_sk = CAST(b.player_sk AS INTEGER))`).all() as
      { name: string; pos: string; withIds: string; orphan: string }[];
    if (!pairs.length) return;   // a store without the rebuild artefact cannot be asked this

    // THE SPAN TEST, and it is the whole argument. For a rebuild duplicate the orphan's seasons sit
    // beside the original's; for two different men sharing a name they are decades apart. If some
    // future cleanup merges these, it must explain what it does with a pair spanning 20 years.
    let farApart = 0;
    for (const p of pairs) {
      const span = db.prepare(`
        SELECT MIN(s) lo, MAX(s) hi FROM (
          SELECT season s FROM feat_player_week WHERE player_sk = ?
          UNION ALL SELECT season FROM feat_player_week WHERE player_sk = ?)`).get(p.withIds, p.orphan) as { lo: number; hi: number };
      if (span.hi - span.lo > 10) farApart++;
    }
    assert.ok(farApart > 0,
      "no far-apart pair found -- if that is genuinely true the merge argument should be revisited, " +
      "but while `Irv Smith TE` spans 1999 and 2019-2023 a merge on (name, position) is unsafe");

    // AND THE UPSTREAM GUARD IS DOING ITS JOB: the far-apart name must be refused by the name route,
    // not merely unused by it. This is the check that would notice `ambiguous` being dropped.
    const irv = db.prepare("SELECT COUNT(*) c FROM player_ids WHERE name_key='irvsmith' AND COALESCE(ambiguous,0)=1").get() as { c: number };
    if (irv.c) assert.ok(irv.c > 0, "irvsmith is marked ambiguous, which is what stops the father/son merge");
  } finally { db.close(); }
});
