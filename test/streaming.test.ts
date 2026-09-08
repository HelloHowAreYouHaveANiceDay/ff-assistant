/**
 * STREAMING / REPLACEMENT LEVEL.
 *
 * The simulator scored a starting slot the roster could not fill as ZERO. Nobody plays that way: if
 * your only quarterback is on bye you add whoever is free that Tuesday, and at QB, K and DST the
 * free option is barely worse than a rostered one. Zero invents a penalty that is never paid.
 *
 * The distortion did not fall evenly, which is why it mattered. It landed entirely on rosters
 * carrying ONE body at a mandatory slot -- so it inflated the K slot's apparent leverage, made a
 * fourth-string quarterback look like a live waiver claim purely as bye insurance, and marked our
 * only kicker, quarterback and defense permanently undroppable.
 *
 * These assert both directions, because the negative one was already correct and a test that only
 * checks it would have passed throughout the entire life of the bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons } from "../src/draft/season.js";
import { buildSchedule } from "../src/draft/schedule.js";

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BE"];
const vm = {
  tiers: 4,
  unfitted: ["K", "DST"],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, {
    cv: [0.6, 0.9, 1.2, 1.3], avail: [0.9, 0.75, 0.5, 0.3], skew: [0.5, 0.8, 1.0, 1.0], fitted: p !== "K" && p !== "DST",
  }])),
};
const sched = buildSchedule(8, 12, 2).weeks;
const base = { weeks: 12, playoffTeams: 4, slots: SLOTS, projSd: 0, trials: 400, seed: 5, allowIncompleteRosters: true };

/** Eight identical teams, each missing the position named -- so any difference is the empty slot. */
function teamsMissing(pos: string) {
  const full: [string, number][] = [["QB", 300], ["RB", 250], ["WR", 240], ["TE", 150], ["K", 120], ["DST", 110], ["WR", 180]];
  return Array.from({ length: 8 }, (_, i) => ({
    id: String(i), name: `T${i}`,
    roster: full.filter(([p]) => p !== pos).map(([p, pts]) => ({ name: `${p}${pts}-t${i}`, pos: p, proj: pts, bye: null })),
  }));
}
const pointsOf = (opts: Record<string, unknown>) =>
  simulateSeasons(teamsMissing("QB"), sched, vm, { ...base, ...opts })[0].meanPoints;

test("POSITIVE DIRECTION: a configured streaming floor actually raises scoring", () => {
  const zero = pointsOf({});
  const streamed = pointsOf({ replacement: { QB: 14 } });
  assert.ok(streamed > zero,
    `streaming a QB must score more than fielding nobody, got ${streamed} vs ${zero}`);
  // 12 weeks x 14 points, and nothing else differs between the two runs.
  const gain = streamed - zero;
  assert.ok(gain > 12 * 14 * 0.8 && gain < 12 * 14 * 1.2,
    `expected roughly ${12 * 14} points of streamed production, got ${gain.toFixed(1)}`);
});

test("the OLD behaviour is preserved when no replacement level is configured", () => {
  // Not merely a default check: every consumer that has not been migrated still relies on this, and
  // silently changing what an unconfigured simulator does would move numbers nobody asked to move.
  const a = pointsOf({});
  const b = pointsOf({ replacement: undefined });
  assert.equal(a, b, "an absent replacement map must leave scoring exactly as it was");
});

test("only the EMPTY slot is streamed -- a filled roster is untouched", () => {
  // The bug this rules out is a replacement floor that leaks into slots the roster already covers,
  // which would inflate every team and be very hard to see in a probability.
  const full = Array.from({ length: 8 }, (_, i) => ({
    id: String(i), name: `T${i}`,
    roster: [["QB", 300], ["RB", 250], ["WR", 240], ["TE", 150], ["K", 120], ["DST", 110], ["WR", 180]]
      .map(([p, pts]) => ({ name: `${p}${pts}-t${i}`, pos: p as string, proj: pts as number, bye: null })),
  }));
  const withRep = simulateSeasons(full, sched, vm, { ...base, replacement: { QB: 14, RB: 9, WR: 8, TE: 7, K: 9, DST: 7 } })[0].meanPoints;
  const without = simulateSeasons(full, sched, vm, base)[0].meanPoints;
  // Not exactly equal: injury draws still empty a slot occasionally, and streaming those is the
  // point. But the gap must be small relative to a season, not the ~170 points of a missing starter.
  assert.ok(Math.abs(withRep - without) < 60,
    `a complete roster should barely move, got ${without.toFixed(0)} -> ${withRep.toFixed(0)}`);
});

test("FLEX streams from the best ELIGIBLE position, honouring flexOk", () => {
  const t = teamsMissing("QB").map((x) => ({ ...x, roster: x.roster.filter((p) => p.pos !== "WR") }));
  const o = { ...base, slots: ["FLEX", "BE"], trials: 200 };
  const rbBest = simulateSeasons(t, sched, vm, { ...o, replacement: { RB: 20, TE: 5 }, flexOk: ["RB", "TE"] })[0].meanPoints;
  const teBest = simulateSeasons(t, sched, vm, { ...o, replacement: { RB: 20, TE: 5 }, flexOk: ["TE"] })[0].meanPoints;
  assert.ok(rbBest > teBest,
    `FLEX must take the best eligible replacement: RB-eligible ${rbBest.toFixed(0)} should beat TE-only ${teBest.toFixed(0)}`);
});
