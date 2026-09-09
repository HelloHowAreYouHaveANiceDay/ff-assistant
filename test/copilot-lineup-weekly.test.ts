/**
 * THE LINEUP SEAM: `lineupRecommend` now takes its weekly points from the WEEKLY PROJECTOR
 * (`src/weekly/projector.ts`) instead of dividing the season projection by 17 itself.
 *
 * Swapping a seam in under a model that is deliberately the identity is the most dangerous kind of
 * refactor there is, because BOTH failure modes are silent:
 *
 *   - if the seam changed a number, the lineup moved for no reason anybody chose;
 *   - if the seam is not CONNECTED at all, every number is identical -- which looks exactly like
 *     success, because the shipped artifact is the season-line-only floor and success IS identical.
 *
 * So this file asserts both directions, and neither one alone would be worth anything:
 *
 *   1. under the SHIPPED season-line-only artifact the recommendation is NUMERICALLY IDENTICAL,
 *      player for player, to the old divide-by-17 path -- deep equality, not a total;
 *   2. under a fixture artifact with ONE non-zero coefficient the recommendation CHANGES. That is
 *      the positive control: a dead seam cannot produce it.
 *
 * And the third case, which is the one that ships today: a roster player the projector has no row
 * for falls back to the season line and `assumptions.basisNote` NAMES HIM. A fallback nobody is told
 * about is a lineup half from a weekly model and half from a flat line, reported as one thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineupRecommend, lineupNameKey, NFL_WEEKS } from "../src/inseason/copilot.js";
import { projectWeekly, seasonLineOnlyArtifact, type WeeklyArtifact, type WeeklyInputRow } from "../src/weekly/projector.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";

const WEEK = 3;
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Feature rows for OUR roster, with the season line per game set to exactly `proj / 17` -- which
 *  is what the divide-by-17 path computed, so the season-line-only artifact must reproduce it. */
function rowsForMyRoster(ctx = fixtureCtx(), skip: string[] = []): WeeklyInputRow[] {
  return ctx.teams[ctx.meIdx].roster
    .filter((p) => !skip.includes(p.name))
    .map((p) => ({
      feat_key: lineupNameKey(p.name), player_sk: null, name: p.name, pos: p.pos,
      season: ctx.season, week: WEEK,
      season_line_pg: p.proj / NFL_WEEKS,
      f: { t4_mean: 12, dvp_mult: 1.2, week_no: WEEK },
    }));
}

const projMap = (artifact: WeeklyArtifact, rows: WeeklyInputRow[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const p of projectWeekly({ artifact, rows })) out.set(lineupNameKey(p.name), p.mean);
  return out;
};

const shipped = () => seasonLineOnlyArtifact({ positions: POS, seasons: [2010, 2025] });

test("the SHIPPED season-line-only artifact reproduces the divide-by-17 lineup exactly", () => {
  const ctx = fixtureCtx();
  const rows = rowsForMyRoster(ctx);
  const weekly = projMap(shipped(), rows);
  assert.equal(weekly.size, ctx.teams[ctx.meIdx].roster.length, "the projector did not cover the roster, so the comparison below is against a fallback");

  const before = lineupRecommend(ctx, WEEK);
  const after = lineupRecommend(ctx, WEEK, { weekly });

  assert.deepEqual(after.starters, before.starters, "the weekly seam changed the starting lineup under an artifact that is the identity");
  assert.deepEqual(after.bench, before.bench);
  assert.equal(after.totalProj, before.totalProj);
  assert.deepEqual(after.unavailable, before.unavailable);

  // And the result says which path produced it -- identical numbers, different provenance.
  assert.equal(before.assumptions.basis, "projection");
  assert.equal(after.assumptions.basis, "weekly-model");
  assert.match(String(after.assumptions.basisNote), /weekly projector/);
});

test("POSITIVE CONTROL: an artifact with a non-zero coefficient CHANGES the recommendation", () => {
  const ctx = fixtureCtx();
  const rows = rowsForMyRoster(ctx);

  // One live coefficient on a feature whose value differs per player: the trailing-4 mean as a
  // ratio to that player's own line. A dead seam cannot notice this.
  const live = shipped();
  live.features = [{ name: "t4_mean", transform: "ratio_to_line", missing: 0 }] as WeeklyArtifact["features"];
  for (const p of POS) {
    live.coef[p] = {
      mean: { intercept: 0.5, t4_mean: 0.5 }, p10: { intercept: 0.5, t4_mean: 0.5 },
      p50: { intercept: 0.5, t4_mean: 0.5 }, p90: { intercept: 0.5, t4_mean: 0.5 },
    };
  }

  const base = lineupRecommend(ctx, WEEK, { weekly: projMap(shipped(), rows) });
  const moved = lineupRecommend(ctx, WEEK, { weekly: projMap(live, rows) });

  assert.notDeepEqual(moved.starters, base.starters, "the live artifact produced the same lineup -- the seam is not connected");
  assert.notEqual(moved.totalProj, base.totalProj);
  assert.equal(moved.assumptions.basis, "weekly-model");
});

test("a player the projector has no row for falls back to the season line, and is NAMED", () => {
  const ctx = fixtureCtx();
  const missing = ctx.teams[ctx.meIdx].roster[1].name;
  const weekly = projMap(shipped(), rowsForMyRoster(ctx, [missing]));

  const r = lineupRecommend(ctx, WEEK, { weekly });

  // The numbers are still the divide-by-17 numbers, because the shipped artifact is the identity.
  assert.deepEqual(r.starters, lineupRecommend(ctx, WEEK).starters);
  // But the basis is NOT claimed as a clean weekly-model run, and the fallback names the man.
  assert.equal(r.assumptions.basis, "projection", "a partial weekly run was reported as a full one");
  assert.match(String(r.assumptions.basisNote), new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(String(r.assumptions.basisNote), /fell back to the season projection/);
});

test("with no weekly projector at all the old path is unchanged, and says so", () => {
  const r = lineupRecommend(fixtureCtx(), WEEK);
  assert.equal(r.assumptions.basis, "projection");
  assert.match(String(r.assumptions.basisNote), /divided by 17/);
});
