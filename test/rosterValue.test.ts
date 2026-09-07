// Roster value under availability. The whole reason this module exists is that the OBVIOUS metric --
// optimal lineup on point projections -- values depth at exactly zero, so these tests are mostly
// about proving depth is worth something and that an unfillable mandatory slot is punished.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRoster, missProb } from "../src/inseason/rosterValue.js";
import { optimalLineup } from "../src/inseason/lineup.js";
import type { VarianceModel } from "../src/draft/season.js";

const VM: VarianceModel = {
  tiers: 4, unfitted: [],
  pos: {
    RB: { cv: [0.6, 0.9, 1.3, 1.3], avail: [0.8712, 0.7296, 0.4883, 0.2641], skew: [0.5, 0.9, 1, 1], fitted: true },
    WR: { cv: [0.6, 0.9, 1.3, 1.3], avail: [0.90, 0.80, 0.60, 0.40], skew: [0.5, 0.9, 1, 1], fitted: true },
  },
};
const SLOTS = ["QB", "RB", "WR", "TE", "FLEX"];
const FLEX = ["RB", "WR", "TE"];
const p = (name: string, pos: string, proj: number, frac = 0.05) => ({ name, pos, proj, poolRankFrac: frac });
const CORE = [p("qb", "QB", 18), p("rb1", "RB", 15), p("wr1", "WR", 14), p("te1", "TE", 10), p("wr2", "WR", 12)];

test("a backup is worth MORE THAN ZERO -- the whole point of the module", () => {
  const thin = scoreRoster(CORE, SLOTS, FLEX, VM, { sims: 300 });
  const deep = scoreRoster([...CORE, p("rb2", "RB", 6)], SLOTS, FLEX, VM, { sims: 300 });
  assert.ok(deep.expected > thin.expected,
    `adding a backup must raise expected points: ${thin.expected.toFixed(2)} -> ${deep.expected.toFixed(2)}`);
  // And prove the OLD metric really is blind to him, so this test is guarding a real difference
  // rather than restating something the point-estimate lineup already knew.
  const lineupOnly = (players: typeof CORE) =>
    optimalLineup(players.map((x) => ({ ...x, available: true })), SLOTS, FLEX).starters.reduce((a, x) => a + x.proj, 0);
  assert.equal(lineupOnly([...CORE, p("rb2", "RB", 6)]), lineupOnly(CORE),
    "the point-estimate lineup must be UNCHANGED by the backup -- that blindness is why this module exists");
});

test("an unfillable mandatory slot shows up as an empty-slot rate", () => {
  const oneRb = scoreRoster(CORE, SLOTS, FLEX, VM, { sims: 300 });
  assert.ok(oneRb.emptySlotRate > 0.02, `a one-RB roster must sometimes field an empty RB slot, got ${oneRb.emptySlotRate}`);
  const twoRb = scoreRoster([...CORE, p("rb2", "RB", 6)], SLOTS, FLEX, VM, { sims: 300 });
  assert.ok(twoRb.emptySlotRate < oneRb.emptySlotRate, "a second RB must reduce it");
});

test("depth helps the FLOOR more than the mean -- that is what insurance is", () => {
  const thin = scoreRoster(CORE, SLOTS, FLEX, VM, { sims: 500 });
  const deep = scoreRoster([...CORE, p("rb2", "RB", 6)], SLOTS, FLEX, VM, { sims: 500 });
  const dMean = deep.expected - thin.expected, dFloor = deep.p10 - thin.p10;
  assert.ok(dFloor > dMean, `insurance should lift the bad case more than the average: floor +${dFloor.toFixed(2)} vs mean +${dMean.toFixed(2)}`);
});

test("common random numbers: the same roster and seed give the identical score", () => {
  const a = scoreRoster(CORE, SLOTS, FLEX, VM, { sims: 200, seed: 42 });
  const b = scoreRoster(CORE, SLOTS, FLEX, VM, { sims: 200, seed: 42 });
  assert.deepEqual(a, b, "without this, two close rosters differ by which sim drew a worse season");
});

test("the bye is divided out of the fitted availability, not applied twice", () => {
  // avail is games/17 and already contains the bye; a weekly injury rate must divide it back out.
  // 1 - 0.8712/(16/17) = 0.0742. Applying avail directly would give 0.1288 -- benching everyone twice.
  const m = missProb(VM, "RB", 0.01);
  assert.ok(Math.abs(m - 0.0742) < 0.002, `expected ~0.074 after the bye correction, got ${m}`);
  assert.ok(Math.abs(m - 0.1288) > 0.01, "0.1288 means the bye was applied twice");
});

test("miss probability rises with depth in the pool", () => {
  assert.ok(missProb(VM, "RB", 0.95) > missProb(VM, "RB", 0.01) * 3);
});

test("an unknown position falls back to a stated default rather than crashing", () => {
  assert.equal(missProb(VM, "TE", 0.5), 0.10);
});
