/**
 * DST SAME-GAME CONFLICT FLAG. Our defense is negatively correlated with the offense it FACES, so
 * starting the DST AND an offensive player in the same NFL game partly cancels them. lineupRecommend
 * flags it when given the week's NFL schedule (`nflOpp`).
 *
 * FAULT-INJECTED BOTH WAYS, because a guard that can only ever stay silent is indistinguishable from a
 * passing one: (1) a real conflict MUST produce the flag naming both men; (2) a clean schedule MUST
 * NOT; (3) with no schedule map the behaviour is unchanged (no flag). Without (2) and (3) a flag that
 * fires on everything, or on nothing, would pass (1) and look correct.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineupRecommend } from "../src/inseason/copilot.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";

const WEEK = 3;
// A controlled roster: the DST is Minnesota, a STARTING WR is Green Bay -- the team Minnesota plays in
// the conflict schedule. Projections are set so both are locked into the starting lineup.
const myRoster = [
  { name: "Passer Ari", pos: "QB", team: "ARI", proj: 300, bye: null },
  { name: "Runner One", pos: "RB", team: "BUF", proj: 250, bye: null },
  { name: "Runner Two", pos: "RB", team: "DAL", proj: 200, bye: null },
  { name: "Star Green", pos: "WR", team: "GB", proj: 240, bye: null },   // shares MIN's game
  { name: "Wide Kansas", pos: "WR", team: "KC", proj: 210, bye: null },
  { name: "Wide Seattle", pos: "WR", team: "SEA", proj: 180, bye: null },
  { name: "Tight Philly", pos: "TE", team: "PHI", proj: 150, bye: null },
  { name: "Kicker Jet", pos: "K", team: "NYJ", proj: 120, bye: null },
  { name: "My Defense", pos: "DST", team: "MIN", proj: 110, bye: null },
  { name: "Bench Rb", pos: "RB", team: "TEN", proj: 90, bye: null },
  { name: "Bench Wr", pos: "WR", team: "CAR", proj: 85, bye: null },
  { name: "Bench Te", pos: "TE", team: "LV", proj: 80, bye: null },
];

function ctxWithMyRoster() {
  const ctx = fixtureCtx();
  ctx.teams[ctx.meIdx] = { ...ctx.teams[ctx.meIdx], roster: myRoster.map((p) => ({ ...p })) };
  return ctx;
}

test("both the DST and the WR it shares an NFL game with are starters, so the flag CAN fire", () => {
  const r = lineupRecommend(ctxWithMyRoster(), WEEK);
  const names = new Set(r.starters.map((s) => s.name));
  assert.ok(names.has("My Defense"), "the DST must be a starter for this test to mean anything");
  assert.ok(names.has("Star Green"), "the GB WR must be a starter for this test to mean anything");
});

test("a real same-game conflict FIRES the flag, naming both men", () => {
  const nflOpp = new Map([["MIN", "GB"], ["GB", "MIN"], ["ARI", "LAR"], ["BUF", "NYJ"]]);
  const r = lineupRecommend(ctxWithMyRoster(), WEEK, { nflOpp });
  const hit = r.flags.filter((f) => f.startsWith("DST conflict:"));
  assert.equal(hit.length, 1, `expected exactly one DST-conflict flag, got ${hit.length}: ${r.flags.join(" | ")}`);
  assert.match(hit[0], /My Defense/);
  assert.match(hit[0], /Star Green \(WR\)/);
  assert.match(hit[0], /MIN vs GB/);
});

test("a CLEAN schedule (DST plays a team we do not roster) fires NOTHING -- not a guard that always fires", () => {
  const nflOpp = new Map([["MIN", "CHI"], ["GB", "DET"], ["ARI", "LAR"]]);
  const r = lineupRecommend(ctxWithMyRoster(), WEEK, { nflOpp });
  assert.equal(r.flags.filter((f) => f.startsWith("DST conflict:")).length, 0, r.flags.join(" | "));
});

test("no schedule map => no flag, so existing callers are unchanged", () => {
  const r = lineupRecommend(ctxWithMyRoster(), WEEK);
  assert.equal(r.flags.filter((f) => f.startsWith("DST conflict:")).length, 0);
});
