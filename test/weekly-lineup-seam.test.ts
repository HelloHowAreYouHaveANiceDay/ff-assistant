/**
 * THE SEAM IS LIVE: the TRAINED artifact on disk moves the lineup, and the refusals still hold.
 *
 * `test/copilot-lineup-weekly.test.ts` proved the seam is connected using a fixture artifact with one
 * hand-set coefficient. That is the right control for a refactor, and it is not the same claim as
 * "the model we actually fitted changes anything" -- a trained artifact whose coefficients happened
 * to be tiny would pass that test and move no lineup at all.
 *
 * So this file runs `data/weekly-artifact.json` AS IT SITS ON DISK against the season-line-only
 * floor, on the same fixture roster, and asserts:
 *
 *   1. the recommendation CHANGES. If the trained model and the floor pick the same eleven men, the
 *      whole weekly track is worth nothing to a lineup no matter what its CRPS says;
 *   2. the bye refusal still holds under it -- a bye player is benched and the reason names the week;
 *   3. the OUT refusal still holds under it, and QUESTIONABLE is still startable. Those are safety
 *      rules that live above the projection, and a projection change must not be able to reach them.
 *
 * (3) is the one that matters most for the two-part model specifically: its first stage projects a
 * man ruled out at close to zero, which is CORRECT and is exactly the kind of change that could
 * tempt someone to treat the projection as the availability check. It is not. A man the store rules
 * out is benched by the rule, not by his number, and this asserts the rule still fires when the
 * number would have benched him anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { lineupRecommend, lineupNameKey, NFL_WEEKS, type AvailabilityMap } from "../src/inseason/copilot.js";
import {
  loadWeeklyArtifact, projectWeekly, seasonLineOnlyArtifact,
  type WeeklyArtifact, type WeeklyInputRow,
} from "../src/weekly/projector.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";

const ARTIFACT = "data/weekly-artifact.json";
const WEEK = 5;
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * Feature rows for our roster, with per-player values that a real weekly model has an opinion about.
 * The season line is `proj / 17`, which is what the divide-by-17 path computed, so the floor artifact
 * reproduces the old numbers exactly and any difference below is the trained model's doing.
 */
function rows(ctx = fixtureCtx()): WeeklyInputRow[] {
  return ctx.teams[ctx.meIdx].roster.map((p, i) => ({
    feat_key: lineupNameKey(p.name), player_sk: null, name: p.name, pos: p.pos,
    season: ctx.season, week: WEEK,
    season_line_pg: p.proj / NFL_WEEKS,
    f: {
      // Deliberately VARIED across the roster: a model fed identical features for every player would
      // rank them exactly as the season line does, and "the lineup did not change" would be a fact
      // about the fixture rather than about the model.
      week_no: WEEK, td_games: 4, td_ppg: (p.proj / NFL_WEEKS) * (0.7 + 0.12 * (i % 5)),
      t4_mean: (p.proj / NFL_WEEKS) * (0.5 + 0.2 * (i % 4)), t4_sd: 3 + (i % 3),
      dvp_mult: 0.9 + 0.05 * (i % 5), dvp_n: 4,
      home: i % 2, spread_line: -3 + (i % 7), total_line: 42 + (i % 6),
      implied_team_total: 19 + (i % 8), days_rest: 7,
      prior_snap_share: 0.4 + 0.1 * (i % 6), prior_route_share: 0.3 + 0.1 * (i % 5),
      depth_rank: 1 + (i % 3), teammates_out: i % 2,
      inj_out: 0, inj_doubtful: 0, inj_questionable: i % 3 === 0 ? 1 : 0,
      prac_dnp: 0, prac_limited: i % 4 === 0 ? 1 : 0, inj_feed: 1,
    },
  }));
}

const projMap = (artifact: WeeklyArtifact, r: WeeklyInputRow[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const p of projectWeekly({ artifact, rows: r })) out.set(lineupNameKey(p.name), p.mean);
  return out;
};
const floor = () => loadWeeklyArtifact(seasonLineOnlyArtifact({ positions: POS, seasons: [2010, 2025] }));
const trained = () => loadWeeklyArtifact(JSON.parse(readFileSync(ARTIFACT, "utf8")));

test("the TRAINED artifact on disk moves the lineup off the season-line result", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact on disk");
  const ctx = fixtureCtx();
  const r = rows(ctx);
  const a = trained();
  const base = projMap(floor(), r);
  const live = projMap(a, r);
  assert.equal(base.size, ctx.teams[ctx.meIdx].roster.length,
    "the floor did not cover the roster, so the comparison is against a fallback rather than against it");
  assert.equal(live.size, base.size,
    "the trained artifact produced fewer projections than the floor -- some position is missing from " +
    "its coefficients and those players are silently on the fallback path");

  const before = lineupRecommend(ctx, WEEK, { weekly: base });
  const after = lineupRecommend(ctx, WEEK, { weekly: live });
  assert.notEqual(after.totalProj, before.totalProj,
    `the trained ${a.zeroModel ?? "quantile"} artifact produced the same projected total as the ` +
    "season-line floor -- either it is the identity or this seam is not carrying it");
  assert.equal(after.assumptions.basis, "weekly-model");
});

test("under the trained artifact, the BYE refusal still holds and names the week", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact on disk");
  const ctx = fixtureCtx();
  // Week 6 is the fixture QB's bye. Project with the trained model for that week specifically.
  const r = rows(ctx).map((x) => ({ ...x, week: 6 }));
  const weekly = projMap(trained(), r);
  const out = lineupRecommend(ctx, 6, { weekly, availability: new Map() as AvailabilityMap });
  const qb = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "QB")!;
  assert.ok(!out.starters.some((s) => s.name === qb.name),
    "a player on bye was started under the trained artifact -- a projection change reached a safety rule");
  assert.ok(out.unavailable.some((u) => u.name === qb.name && /bye week 6/.test(u.reason)),
    JSON.stringify(out.unavailable));
  // POSITIVE CONTROL on the bye lever itself: the same QB starts in a week he is not on bye, under
  // the same artifact. Without this, a model that benched him for being bad would look identical.
  const wk5 = lineupRecommend(ctx, WEEK, { weekly: projMap(trained(), rows(ctx)), availability: new Map() as AvailabilityMap });
  assert.ok(wk5.starters.some((s) => s.name === qb.name),
    "the QB is not on bye in week 5 and was still benched -- the bye assertion above proves nothing");
});

test("under the trained artifact, an OUT player is benched by the RULE and QUESTIONABLE still starts", (t) => {
  if (!existsSync(ARTIFACT)) return t.skip("no weekly artifact on disk");
  const ctx = fixtureCtx();
  const rb = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "RB" && p.proj === 250)!;
  const wr = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "WR" && p.proj === 240)!;
  const key = (n: string) => n.toLowerCase().replace(/[^a-z]/g, "");
  const avail: AvailabilityMap = new Map([
    [key(rb.name), { status: "OUT" as const, source: "player_status", detail: "Knee" }],
    [key(wr.name), { status: "QUESTIONABLE" as const, source: "player_status", detail: "Foot" }],
  ]);
  // The weekly projection here says NOTHING about either man's availability -- inj_out is 0 for every
  // row. So if the OUT player is benched it is the store's rule doing it, which is the point.
  const weekly = projMap(trained(), rows(ctx));
  const r = lineupRecommend(ctx, WEEK, { weekly, availability: avail });
  assert.ok(!r.starters.some((s) => s.name === rb.name),
    "an OUT player was started under the trained artifact");
  assert.ok(r.starters.some((s) => s.name === wr.name),
    "a QUESTIONABLE player was benched -- he plays more often than not, and the projection must not " +
    "be allowed to become the availability check");
});
