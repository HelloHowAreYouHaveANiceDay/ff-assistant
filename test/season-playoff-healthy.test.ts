/**
 * TWO DEFECTS IN THE PARAMETRIC PATH (the fantasy PLAYOFF weeks, and any caller without a bootstrap),
 * found 2026-09-25 by measuring a forced one-QB lineup's expected playoff week:
 *
 *  1. THE WEEKLY DRAW WAS NOT A NORMAL. `sampleWeek` was handed a closure returning the SAME keyed
 *     uniform on every call, so Box-Muller drew u === v and the lognormal week came out ~8% above its
 *     mean. Fixed (`perfRng`); `FF_SIM_PERF_RNG_LEGACY=1` restores it for the gate's control arm.
 *  2. THE INJURY DOUBLE COUNT. A per-week mean is per SCHEDULED week (missed games already zeros), so
 *     drawing injuries on top put a man's expected week at mean x pHealthy. `FF_SIM_PLAYOFF_HEALTHY=1`
 *     scores a healthy week at mean / pHealthy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput } from "../src/draft/season.js";
import { fixtureCtx, vm } from "./fixtures/copilot-league.js";

const ctx = fixtureCtx();
// Two one-QB teams, one slot: the lineup is forced, so playoff-week points are exactly the QB's draws.
const teams: SeasonTeamInput[] = [0, 1].map((i) => ({ id: `t${i}`, name: `t${i}`, roster: [{ name: `Solo QB ${i}`, pos: "QB", proj: 170, team: `NFL${i}`, bye: null }] }));
const PER_WEEK = 170 / 17;
const pHealthy = Math.min(1, vm.pos.QB.avail[0] / (16 / 17));

function playoffWeekMean(env: Record<string, string>): number {
  const keys = ["FF_SIM_PLAYOFF_HEALTHY", "FF_SIM_PERF_RNG_LEGACY"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const odds = simulateSeasons(teams, ctx.weeks, vm, {
      ...ctx.opts(6000, 5), slots: ["QB"], flexOk: [], projSd: 0, replacement: undefined, poolRank: undefined,
      bootstrap: undefined, playoffWeekStrength: true, allowIncompleteRosters: true, playoffTeams: 2,
    });
    return odds.reduce((a, o) => a + o.playoffWeekPts, 0) / odds.length / 3;
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; }
  }
}

test("defect 1 reproduced: the legacy frozen-uniform draw runs ~8% above the mean", () => {
  const legacy = playoffWeekMean({ FF_SIM_PERF_RNG_LEGACY: "1" });
  const fixed = playoffWeekMean({});
  assert.ok(legacy > fixed * 1.04, `legacy ${legacy.toFixed(3)} vs fixed ${fixed.toFixed(3)}`);
});

test("shipped (fixed draw, double count still on): a playoff week is mean x pHealthy", () => {
  const m = playoffWeekMean({});
  assert.ok(Math.abs(m - PER_WEEK * pHealthy) < 0.2, `got ${m.toFixed(3)} vs ${(PER_WEEK * pHealthy).toFixed(3)}`);
});

test("FF_SIM_PLAYOFF_HEALTHY=1: a playoff week's expectation is the per-scheduled-week mean itself", () => {
  const m = playoffWeekMean({ FF_SIM_PLAYOFF_HEALTHY: "1" });
  assert.ok(Math.abs(m - PER_WEEK) < 0.2, `got ${m.toFixed(3)} vs ${PER_WEEK}`);
});
