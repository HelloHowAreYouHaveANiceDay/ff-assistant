/**
 * `SeasonTeamInput.rosterByWeek` (2026-09-25) -- week w's lineup comes from week w's roster. Built for
 * the roster-move headroom oracle in `season-calibration.mjs` (FF_SIM_ORACLE_ROSTERS). Two contracts:
 * absent, the simulator is unchanged; present, a man who joins later actually plays for the team.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput } from "../src/draft/season.js";
import { fixtureCtx, vm } from "./fixtures/copilot-league.js";

const ctx = fixtureCtx();
const run = (teams: SeasonTeamInput[]) => simulateSeasons(teams, ctx.weeks, vm, { ...ctx.opts(400, 3), allowIncompleteRosters: true });

test("absent rosterByWeek: identical to the plain roster run", () => {
  const a = run(ctx.teams), b = run(ctx.teams.map((t) => ({ ...t })));
  assert.deepEqual(a.map((o) => [o.meanPoints, o.playoffs]), b.map((o) => [o.meanPoints, o.playoffs]));
});

test("a man who joins in week 5 plays from week 5: points rise, and only for that team", () => {
  const base = run(ctx.teams);
  const me = ctx.teams[0];
  const qbIdx = me.roster.findIndex((p) => p.pos === "QB");
  const star = { ...me.roster[qbIdx], name: "Late Star QB", proj: me.roster[qbIdx].proj * 3, bye: null };
  const later = me.roster.map((p, i) => (i === qbIdx ? star : p));
  const byWeek: Record<number, typeof me.roster> = {};
  for (let w = 5; w <= ctx.weeks.length; w++) byWeek[w] = later;
  const withOracle = run([{ ...me, rosterByWeek: byWeek }, ...ctx.teams.slice(1)]);
  assert.ok(withOracle[0].meanPoints > base[0].meanPoints + 20, `${withOracle[0].meanPoints} vs ${base[0].meanPoints}`);
  // Every OTHER team keeps its own roster and its own draws; common random numbers keep their points
  // close (their opponents change, their own scoring does not).
  for (let i = 1; i < base.length; i++) assert.ok(Math.abs(withOracle[i].meanPoints - base[i].meanPoints) < 1e-6, `team ${i} points moved`);
});
