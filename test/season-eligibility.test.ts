import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "../src/draft/season.js";

/**
 * THE LAST SEAM OF TRACK D: does `eligible` survive into the SEASON SIMULATOR's lineup?
 *
 * Track D turned position into a set through valuation, the live lineup optimiser and the
 * roster-legality check, and stopped at `SeasonPlayer` -- so `simulateSeasons` went on slotting a
 * dual-eligible man at one position only. Nothing failed: the simulator fields "(empty)" at a slot
 * it cannot fill and scores it at the replacement level, which is a plausible number.
 *
 * SO THE TEST HAS TO BE A DIFFERENCE, NOT AN ASSERTION ABOUT ONE RUN. Two identical rosters, one
 * whose swing man carries `eligible: ["TE", "WR"]` and one whose does not, on a roster that is SHORT
 * AT WR and long at TE. If the field reaches the optimiser the first roster fills its WR slot and
 * scores more; if the field is dropped at the seam the two are identical, which is exactly what the
 * broken version produced.
 *
 * Every stochastic input is pinned: `projSd: 0` (no projection-error draw), a variance model with
 * cv 0 and avail 1 (no weekly noise, nobody ever out), no byes. The two arms then differ only by the
 * eligibility field, so any difference in points IS the effect.
 */

/** A degenerate variance model: zero dispersion, everyone always available, no skew. */
const VM: VarianceModel = {
  tiers: 4,
  unfitted: [],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [
    p, { cv: [0, 0, 0, 0], avail: [1, 1, 1, 1], skew: [0, 0, 0, 0], fitted: true },
  ])),
};

const SLOTS = ["QB", "RB", "WR", "TE", "BE"];

/**
 * A roster SHORT AT WR and LONG AT TE. `Swing` is the man in question: his position is TE, and the
 * lineup already has a better TE, so the only way he is worth anything is if he can fill the WR slot.
 */
function roster(swingEligible: string[] | undefined) {
  return [
    { name: "Q", pos: "QB", proj: 300, bye: null },
    { name: "R", pos: "RB", proj: 200, bye: null },
    { name: "T", pos: "TE", proj: 150, bye: null },
    { name: "Swing", pos: "TE", proj: 120, bye: null, ...(swingEligible ? { eligible: swingEligible } : {}) },
    { name: "K", pos: "K", proj: 1, bye: null },
  ];
}

/** Two teams so there is a schedule to play; the opponent is deliberately identical in both arms. */
function league(swingEligible: string[] | undefined): SeasonTeamInput[] {
  return [
    { id: "1", name: "US", roster: roster(swingEligible) },
    { id: "2", name: "THEM", roster: roster(undefined) },
  ];
}

const WEEKS: [number, number][][] = [[[0, 1]], [[0, 1]], [[0, 1]]];

const run = (swingEligible: string[] | undefined) => simulateSeasons(league(swingEligible), WEEKS, VM, {
  weeks: WEEKS.length, playoffTeams: 2, slots: SLOTS, projSd: 0, trials: 1, seed: 11,
  // The CONTROL arm is deliberately short at WR -- that is the whole fixture -- and the legality
  // check would otherwise (correctly) refuse it. See the separate test below, which asserts that
  // the check ITSELF is eligibility-aware.
  allowIncompleteRosters: true,
})[0];

test("a DUAL-ELIGIBLE player is slotted where the simulated roster is short", () => {
  const without = run(undefined);
  const withElig = run(["TE", "WR"]);

  // POSITIVE CONTROL FIRST: the arm with no eligibility must genuinely leave WR empty. If it did
  // not, the comparison below would be between two full lineups and could not fail.
  // `proj` is a SEASON total and the simulator scores one WEEK, so every figure below is /17.
  const NFL_WEEKS = 17;
  const perWeek = (r: { meanPoints: number }) => r.meanPoints / WEEKS.length;
  const close = (a: number, b: number, why: string) =>
    assert.ok(Math.abs(a - b) < 1e-9, `${why} (got ${a}, expected ${b})`);

  close(perWeek(without), (300 + 200 + 150) / NFL_WEEKS,
    "the control roster should be short exactly one WR -- if it is not, the fixture proves nothing");
  close(perWeek(withElig), (300 + 200 + 150 + 120) / NFL_WEEKS,
    "the dual-eligible man did not reach the WR slot -- `eligible` is dropped between SeasonPlayer and optimalLineup");

  assert.ok(withElig.meanPoints > without.meanPoints,
    "eligibility made no difference at all, which is what the broken seam produced");
});

test("the LEGALITY CHECK inside the simulator is eligibility-aware too", () => {
  // Without `allowIncompleteRosters` the control roster must be REFUSED (it really has no WR) and
  // the dual-eligible one must be ACCEPTED (its swing man covers the slot). This is the positive
  // half: a check that only ever refuses is indistinguishable from one that is broken.
  const opts = { weeks: WEEKS.length, playoffTeams: 2, slots: SLOTS, projSd: 0, trials: 1, seed: 11 };
  // BOTH teams get the same treatment here: the scoring fixture deliberately leaves the opponent
  // short, and a mixed league would fail for the opponent's reason rather than ours.
  const both = (e: string[] | undefined): SeasonTeamInput[] => [
    { id: "1", name: "US", roster: roster(e) },
    { id: "2", name: "THEM", roster: roster(e) },
  ];
  assert.throws(() => simulateSeasons(both(undefined), WEEKS, VM, opts), /has 0 WR/,
    "a roster genuinely short at WR must still be refused");
  assert.doesNotThrow(() => simulateSeasons(both(["TE", "WR"]), WEEKS, VM, opts),
    "a roster whose dual-eligible man covers WR was refused -- the check is not reading `eligible`");
});

test("FAULT INJECTION: an eligibility set that does NOT include the short position changes nothing", () => {
  // The guard must be sensitive to the CONTENT of the set, not merely to the field being present.
  // A version that filled any short slot with any dual-eligible man would pass the test above.
  const irrelevant = run(["TE", "QB"]);
  const without = run(undefined);
  assert.equal(irrelevant.meanPoints, without.meanPoints,
    "a TE/QB swing man filled a WR slot -- eligibility is being ignored rather than read");
});
