/**
 * DEFECT D3: the backtest's pool is the PRIOR season's players, and a man who never posts a row in
 * the season being drafted arrived with every feature NULL.
 *
 * `backtestFeatureRows(db, Y)` builds its universe from season Y-1 -- deliberately, because in the
 * simulated August of Y the only people who exist are the ones who played in Y-1, including the ones
 * about to retire or get hurt in camp. It then looked each man's FEATURES up on his season-Y row,
 * which for exactly those men does not exist. So the trained arm projected them from its intercept
 * while the curve-only arm projected them from their rank, and the two arms were not being handed
 * the same pool at all.
 *
 * The fix is the `own_*` usage columns: season Y-1's row carries its OWN season's usage, which is
 * numerically the same quantity season Y's row would have carried as `prior_*`.
 *
 * The check is a positive one -- it counts men who HAVE no Y row and asserts they carry features
 * anyway. A fix that simply dropped them from the pool would pass a "no nulls" assertion and change
 * the pool, which is the other half of the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { backtestFeatureRows } from "../src/model/features.js";
import { curveOnlyArtifact } from "../src/model/projector.js";

const SEASON = 2024;

function haveFeatures(): boolean {
  if (!existsSync("data/ff.db")) return false;
  const db = openDb("data/ff.db");
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM feat_player_season WHERE season = ?").get(SEASON) as { c: number };
    return r.c > 0;
  } catch { return false; } finally { db.close(); }
}

test("a pool player with no row in the drafted season still carries his prior usage", (t) => {
  if (!haveFeatures()) return t.skip("no feature table");
  const db = openDb("data/ff.db");
  const a = curveOnlyArtifact({ positions: ["QB", "RB", "WR", "TE"], seasons: [SEASON] });
  const rows = backtestFeatureRows(db, SEASON, a);
  // The men the defect was about, named by the store rather than by the function under test.
  const orphanKeys = new Set((db.prepare(
    `SELECT p.name || '|' || p.pos k FROM feat_player_season p
      WHERE p.season = ? AND p.pts IS NOT NULL AND p.pos_rank IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM feat_player_season q WHERE q.season = ? AND q.feat_key = p.feat_key)`,
  ).all(SEASON - 1, SEASON) as { k: string }[]).map((r) => r.k));
  db.close();

  const orphans = rows.filter((r) => orphanKeys.has(`${r.name}|${r.pos}`));
  assert.ok(orphans.length >= 30,
    `only ${orphans.length} pool players are absent from ${SEASON} -- if this is 0 the test proves ` +
    `nothing, and if the pool dropped them the defect has been "fixed" by deleting the evidence`);
  // The claim: they are in the pool AND they have features.
  const skill = orphans.filter((r) => ["RB", "WR", "TE"].includes(r.pos));
  const withUsage = skill.filter((r) => r.f.prior_fd != null || r.f.prior_ts != null);
  assert.ok(withUsage.length >= skill.length * 0.5,
    `${withUsage.length}/${skill.length} absent skill players carry usage. Before the own_* columns ` +
    `this was 0 and the trained arm projected every one of them from its intercept.`);
  const withPts = orphans.filter((r) => r.f.prior_pts != null);
  assert.equal(withPts.length, orphans.length,
    "every pool player scored a prior season by construction -- prior_pts cannot be null for any of them");
  const withAge = orphans.filter((r) => r.f.age != null);
  assert.ok(withAge.length >= orphans.length * 0.5, `only ${withAge.length}/${orphans.length} carry an age`);
});

test("the pool is the PRIOR season's players, not the drafted season's", (t) => {
  if (!haveFeatures()) return t.skip("no feature table");
  const db = openDb("data/ff.db");
  const a = curveOnlyArtifact({ positions: ["QB", "RB", "WR", "TE", "K", "DST"], seasons: [SEASON] });
  const rows = backtestFeatureRows(db, SEASON, a);
  const prior = (db.prepare(
    "SELECT COUNT(*) c FROM feat_player_season WHERE season = ? AND pts IS NOT NULL AND pos_rank IS NOT NULL",
  ).get(SEASON - 1) as { c: number }).c;
  db.close();
  // Survivorship handed to our side of the draft and nobody else's is the failure this guards.
  assert.equal(rows.length, prior,
    `the pool has ${rows.length} rows against ${prior} scored ${SEASON - 1} players -- building it ` +
    `from ${SEASON} instead would delete everyone who never played`);
});
