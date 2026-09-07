import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons } from "../src/draft/season.js";
import { buildSchedule } from "../src/draft/schedule.js";

// A season simulator that is quietly wrong still prints a plausible table. These assert the
// conservation laws, then the POSITIVE controls -- that it can actually distinguish a good roster
// from a bad one, and that the projection-error knob does what it claims. A simulator that returns
// 1/16 for everyone would satisfy every conservation law and be useless.

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
const vm = {
  tiers: 4,
  unfitted: ["K", "DST"],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, {
    cv: [0.6, 0.9, 1.2, 1.3], avail: [0.9, 0.75, 0.5, 0.3], skew: [0.5, 0.8, 1.0, 1.0], fitted: p !== "K" && p !== "DST",
  }])),
};

/** 16 teams; `strongTeam` gets doubled projections so it MUST dominate. */
function makeTeams(strongTeam = -1, mult = 2) {
  return Array.from({ length: 16 }, (_, i) => ({
    id: String(i), name: `T${i}`,
    roster: [
      ["QB", 300], ["RB", 250], ["RB", 200], ["WR", 240], ["WR", 210],
      ["WR", 180], ["TE", 150], ["K", 120], ["DST", 110], ["RB", 90], ["WR", 85], ["TE", 80],
    ].map(([pos, pts]) => ({ name: `${pos}${pts}-t${i}`, pos: pos as string, proj: (i === strongTeam ? mult : 1) * (pts as number), bye: null })),
  }));
}
const sched = buildSchedule(16, 14, 4).weeks;
const base = { weeks: 14, playoffTeams: 7, slots: SLOTS, projSd: 0.30, trials: 300, seed: 11 };

test("conservation: wins, playoff shares and titles all balance", () => {
  const odds = simulateSeasons(makeTeams(), sched, vm, base);
  const wins = odds.reduce((a, r) => a + r.meanWins, 0);
  assert.ok(Math.abs(wins - (14 * 16) / 2) < 0.5, `total wins ${wins}, want 112`);
  const po = odds.reduce((a, r) => a + r.playoffs, 0);
  assert.ok(Math.abs(po - 7) < 0.02, `playoff shares sum ${po}, want 7`);
  const ch = odds.reduce((a, r) => a + r.champion, 0);
  assert.ok(Math.abs(ch - 1) < 0.02, `champion shares sum ${ch}, want 1`);
});

test("POSITIVE CONTROL: with identical rosters nobody has an edge (~7/16 each)", () => {
  const odds = simulateSeasons(makeTeams(), sched, vm, base);
  for (const r of odds) {
    assert.ok(r.playoffs > 0.25 && r.playoffs < 0.63,
      `${r.name} at ${r.playoffs.toFixed(3)} -- identical rosters should sit near 7/16 = 0.44`);
  }
});

test("POSITIVE CONTROL: a roster with DOUBLE the projections must dominate", () => {
  const odds = simulateSeasons(makeTeams(3), sched, vm, base);
  const strong = odds.find((r) => r.id === "3")!;
  const rest = odds.filter((r) => r.id !== "3");
  assert.ok(strong.playoffs > 0.95, `dominant roster only reaches ${strong.playoffs.toFixed(3)} playoff odds`);
  assert.ok(strong.champion > Math.max(...rest.map((r) => r.champion)) * 2,
    "dominant roster should more than double the best rival's title odds");
  assert.ok(strong.meanWins > 11, `dominant roster wins only ${strong.meanWins.toFixed(1)}`);
});

test("projection error COMPRESSES the gap between a strong and a weak roster", () => {
  // The first version of this test asserted the opposite -- that projSd WIDENS the spread of playoff
  // odds across identical rosters -- and it failed, correctly. With identical rosters the error is
  // redrawn every trial, so it creates no PERSISTENT team differences; both spreads were just Monte
  // Carlo noise. The real mechanism only shows up when rosters actually differ: uncertainty about
  // who is good pulls the strong team down and the weak team up, because in some simulated worlds
  // the projections were wrong about both. That is exactly why our own odds RISE from 45.5% to
  // 50.1% when projSd goes 0 -> 0.30: we are a below-average roster, and doubt helps us.
  // A MODERATE edge (x1.15), not the x2 used elsewhere: a doubled roster saturates at 100% playoff
  // odds, where compression is arithmetically invisible. Measured gaps at x1.15 are 49.8 -> 35.7 ->
  // 29.8pp for projSd 0 / 0.30 / 0.45; at x2.00 they are 60.0 / 60.0 / 60.0. The second version of
  // this test failed for exactly that reason -- the mechanism was fine, the fixture was saturated.
  const teams = makeTeams(3, 1.15);
  const opt = { ...base, trials: 500 };
  const certain = simulateSeasons(teams, sched, vm, { ...opt, projSd: 0 });
  const unsure = simulateSeasons(teams, sched, vm, { ...opt, projSd: 0.45 });
  const gap = (o: typeof certain) => {
    const strong = o.find((r) => r.id === "3")!.playoffs;
    const rest = o.filter((r) => r.id !== "3");
    return strong - rest.reduce((a, r) => a + r.playoffs, 0) / rest.length;
  };
  assert.ok(gap(unsure) < gap(certain),
    `projection error should shrink the strong-vs-field gap: certain ${gap(certain).toFixed(3)}, unsure ${gap(unsure).toFixed(3)}`);
});

test("byes cost points: a team whose players all share a bye scores less", () => {
  const teams = makeTeams();
  teams[5].roster = teams[5].roster.map((p) => ({ ...p, bye: 7 }));
  const odds = simulateSeasons(teams, sched, vm, { ...base, projSd: 0 });
  const hit = odds.find((r) => r.id === "5")!;
  const others = odds.filter((r) => r.id !== "5");
  assert.ok(hit.meanPoints < Math.min(...others.map((r) => r.meanPoints)),
    "a team with an all-hands bye week must score fewest points");
});
