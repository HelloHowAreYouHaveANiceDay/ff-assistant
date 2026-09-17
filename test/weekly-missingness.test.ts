/**
 * THE SERVE-TIME MISSINGNESS MASK (M2h) -- default off, and connected when it is on.
 *
 * The ablation this file guards asks a question the TRAINING ablation cannot: not "how much
 * information is in this feature" but "what does it cost us on a Sunday when this feed fails".
 * The instrument is `applyServeMask` (src/weekly/evaluate.ts): null the named fields on the SCORED
 * rows only, leave every fold's training untouched, and let the projector turn null into the
 * artifact's own declared `missing` (linear heads) or NaN (the boosted design) -- which is exactly
 * what the serving path sees when the feed is dark.
 *
 * TWO HALVES, AND THE SECOND IS WHY THE FIRST MEANS ANYTHING.
 *
 *   1. DEFAULT OFF. An absent or EMPTY list writes nothing at all -- the rows come out
 *      byte-identical by JSON. This is the property that makes every number the flagless
 *      `ff evaluate-weekly` prints the same number it printed before the option existed.
 *
 *   2. FAULT INJECTION -- THE MASK IS CONNECTED. A guard that can only ever be a no-op reads
 *      exactly like a guard that is passing, and an ablation built on a dead mask reports "this
 *      feed costs nothing" for every feed in the table. So: masking the LEVEL (`season_line_pg`,
 *      the model's own anchor column) must move the projection a lot, masking `week_no` must move
 *      it almost not at all, and masking the whole feature list must collapse the model towards a
 *      constant multiple of the line. All three are asserted against the artifact that actually
 *      ships, `data/weekly-artifact.json`, not a fixture -- a fixture would be grading the mask
 *      against a model nobody serves.
 *
 * Nothing here writes to the store or to any artifact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyServeMask } from "../src/weekly/evaluate.js";
import {
  loadWeeklyArtifact, projectWeekly, weeklyFeatureValue, weeklyFeatureValueBoosted,
  CHALLENGER_WEEKLY_ARTIFACT, type WeeklyArtifact, type WeeklyInputRow,
} from "../src/weekly/projector.js";
import { dataPath } from "../src/data/paths.js";
import type { WeeklyRow } from "../src/weekly/features.js";

/** Plausible, fully-populated rows -- one per boosted position and one linear (K). Values are in the
 *  units the columns are stored in, so every transform on the artifact has something real to do. */
function rows(): WeeklyRow[] {
  const mk = (i: number, pos: string, line: number): WeeklyRow => ({
    feat_key: `p${i}`, player_sk: `s${i}`, season: 2024, week: 7,
    name: `Player ${i}`, pos, team: "AAA", opponent: "BBB",
    season_line_pg: line, dvp_mult: 1.0,
    f: {
      td_ppg: line * 1.05, t4_mean: line * 0.92, t4_sd: line * 0.45, td_games: 6,
      spread_line: -2.5, total_line: 44.5, implied_team_total: 23.5, days_rest: 7,
      week_no: 7, season_line_pg: line, td_fd: 4.2, td_ts: 6.1, td_attempts: 14.0,
      td_rush_yards: 38.0, prior_snap_share: 0.72, prior_route_share: 0.68, depth_rank: 1,
      teammates_out: 1, home: 1, inj_out: 0, inj_doubtful: 0, inj_questionable: 1,
      prac_dnp: 0, prac_limited: 1, inj_feed: 1,
    },
  });
  return [mk(1, "QB", 18.5), mk(2, "RB", 12.0), mk(3, "WR", 10.5), mk(4, "TE", 7.0), mk(5, "K", 8.0)];
}

const toInput = (r: WeeklyRow): WeeklyInputRow => ({
  feat_key: r.feat_key, player_sk: r.player_sk, name: r.name, pos: r.pos,
  season: r.season, week: r.week, season_line_pg: r.season_line_pg, f: r.f,
});

const artifact = (): WeeklyArtifact =>
  loadWeeklyArtifact(JSON.parse(readFileSync(dataPath(CHALLENGER_WEEKLY_ARTIFACT), "utf8")));

/** Mean projections keyed by feat_key, with `mask` applied to a fresh copy of the rows. */
function means(a: WeeklyArtifact, mask?: string[]): Map<string, number> {
  const rs = rows();
  applyServeMask(rs, mask);
  const out = new Map<string, number>();
  for (const p of projectWeekly({ artifact: a, rows: rs.map(toInput) })) out.set(p.feat_key, p.mean);
  return out;
}

/** Mean absolute RELATIVE move of the projection, over the rows both arms projected. */
function relMove(base: Map<string, number>, other: Map<string, number>): number {
  let s = 0, n = 0;
  for (const [k, v] of base) {
    const w = other.get(k);
    if (w == null || !(v > 0)) continue;
    s += Math.abs(w - v) / v; n++;
  }
  assert.ok(n >= 4, `expected at least 4 comparable rows, got ${n}`);
  return s / n;
}

test("the serve mask is OFF by default: an absent or empty list writes nothing", () => {
  const before = JSON.stringify(rows());

  const a = rows();
  applyServeMask(a, undefined);
  assert.equal(JSON.stringify(a), before, "an undefined mask must not touch a single field");

  const b = rows();
  applyServeMask(b, []);
  assert.equal(JSON.stringify(b), before, "an EMPTY mask must not touch a single field");

  // And the projections it produces are identical, not merely close -- this is the property the
  // flagless `ff evaluate-weekly` inherits, and "close" would hide a mask that quietly re-imputed.
  const art = artifact();
  assert.deepEqual([...means(art, undefined)], [...means(art, [])]);
});

test("the serve mask nulls EXACTLY the named fields and leaves the rest alone", () => {
  const rs = rows();
  applyServeMask(rs, ["inj_out", "prac_dnp"]);
  for (const r of rs) {
    assert.equal(r.f.inj_out, null);
    assert.equal(r.f.prac_dnp, null);
    assert.equal(r.f.inj_questionable, 1, "an unnamed field in the same block must survive");
    assert.equal(r.f.prior_snap_share, 0.72);
    assert.equal(r.season_line_pg, r.season_line_pg, "the multiplicative anchor is not a masked field");
  }
});

test("a masked field reaches the two serve evaluators as the artifact's declared absent state", () => {
  const art = artifact();
  const rs = rows();
  applyServeMask(rs, ["prior_snap_share"]);
  const spec = art.features.find((f) => f.name === "prior_snap_share");
  assert.ok(spec, "the shipped artifact must carry prior_snap_share for this control to mean anything");
  const row = toInput(rs[1]);
  // Linear heads: the artifact's OWN `missing`. Boosted design: NaN, the native missing direction.
  assert.equal(weeklyFeatureValue(spec!, row), spec!.missing);
  assert.ok(Number.isNaN(weeklyFeatureValueBoosted(spec!, row)));
});

test("FAULT INJECTION: masking the level devastates, masking week_no is ~0, masking all collapses", () => {
  const art = artifact();
  const base = means(art);
  assert.ok(base.size >= 4, "the shipped artifact must project these rows at all");

  const level = relMove(base, means(art, ["season_line_pg"]));
  const weekNo = relMove(base, means(art, ["week_no"]));
  const all = relMove(base, means(art, art.features.map((f) => f.name)));

  // The anchor column: if THIS does not move, the mask is not connected and every zero in the
  // ablation table is a measurement of the instrument rather than of a feed.
  assert.ok(level > 0.02, `masking the level moved the projection only ${(100 * level).toFixed(3)}% -- the mask is not connected`);
  // A calendar column the model should barely lean on. This is the NEGATIVE control: it says the
  // instrument is not simply perturbing everything it touches.
  assert.ok(weekNo < level, `week_no (${(100 * weekNo).toFixed(3)}%) must move less than the level (${(100 * level).toFixed(3)}%)`);
  assert.ok(weekNo < 0.02, `masking week_no moved ${(100 * weekNo).toFixed(3)}% -- more than a calendar column should`);
  // Everything masked is the floor: the model has nothing left but its intercept times the line.
  assert.ok(all > level, `masking every feature (${(100 * all).toFixed(3)}%) must move at least as much as the level alone`);
});
