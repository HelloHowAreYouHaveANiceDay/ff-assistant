/**
 * A KNOWN DESIGNATION TURNED INTO SIMULATED WEEKS MISSED.
 *
 * The thing this must get right, and the thing a careless version gets wrong, is PERSISTENCE. The
 * horizon model publishes a CUMULATIVE survival curve -- P(miss the next k games) -- and the obvious
 * move is to convert it to four per-week probabilities and draw them independently. That reproduces
 * exactly the i.i.d. error the seam exists to fix, and it looks CORRECT ON THE MEAN: the expected
 * weeks missed comes out the same. What differs is the variance and the shape, and a playoff
 * probability is made of variance.
 *
 * So the tests below assert the episode is CONTIGUOUS and that the drawn lengths reproduce the
 * curve, not merely that the average is plausible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { drawEpisodeLength, missedWeeks, tailHazardFrom, type HorizonCurve } from "../src/draft/knownInjury.js";

const CURVE: HorizonCurve = [0.90, 0.70, 0.50, 0.35];
const TAIL = 0.72;

test("the drawn lengths REPRODUCE the survival curve", () => {
  // The contract: over many uniforms, the share of draws with length >= k must equal the curve's
  // own P(miss >= k). This is what makes the episode draw a faithful reading of the model rather
  // than a plausible-looking approximation of it.
  const N = 20000;
  const lens: number[] = [];
  for (let i = 0; i < N; i++) lens.push(drawEpisodeLength(CURVE, (i + 0.5) / N, TAIL, 20));
  for (let k = 1; k <= 4; k++) {
    const share = lens.filter((l) => l >= k).length / N;
    assert.ok(Math.abs(share - CURVE[k - 1]) < 0.01,
      `P(miss >= ${k}) should be ${CURVE[k - 1]} but the draw gives ${share.toFixed(3)}`);
  }
});

test("an episode is CONTIGUOUS -- that is what distinguishes it from i.i.d. weekly draws", () => {
  // Four independent weekly draws would scatter the missed weeks. An injury does not.
  const w = [...missedWeeks(CURVE, 0.1, TAIL, 5, 17)].sort((a, b) => a - b);
  assert.ok(w.length >= 4, `expected a long episode at u=0.1, got ${w.length}`);
  assert.equal(w[0], 5, "the episode starts at the week the designation is about");
  for (let i = 1; i < w.length; i++) assert.equal(w[i], w[i - 1] + 1, "weeks must be consecutive");
});

test("a LOW uniform means a long episode and a HIGH one means none -- monotone", () => {
  // Both directions of the lever. If long and short draws came out the same, every assertion above
  // about the curve would still pass on a broken mapping.
  const lens = [0.05, 0.25, 0.45, 0.65, 0.85, 0.99].map((u) => drawEpisodeLength(CURVE, u, TAIL, 20));
  for (let i = 1; i < lens.length; i++) {
    assert.ok(lens[i] <= lens[i - 1], `length must not increase with u: ${lens.join(",")}`);
  }
  assert.ok(lens[0] > lens[lens.length - 1], "the extremes must actually differ");
  assert.equal(drawEpisodeLength(CURVE, 0.99, TAIL, 20), 0, "above P(miss>=1) he plays");
});

test("NO CURVE means no weeks missed -- the default path is untouched", () => {
  // Every player without a designation takes this branch, which is why the seam is cheap and why a
  // simulation with no designations must be bit-identical to one built before the seam existed.
  assert.equal(missedWeeks(null, 0.01, TAIL, 1, 17).size, 0);
});

test("the episode is clipped to the horizon it was asked about", () => {
  // A season has a last week. An episode must not run past it, or a man is "out" in weeks nobody
  // simulates and the count of missed weeks stops meaning anything.
  const w = missedWeeks(CURVE, 0.001, TAIL, 15, 17);
  assert.ok(w.size <= 3, `from week 15 through 17 at most 3 weeks can be missed, got ${w.size}`);
  assert.ok(![...w].some((x) => x > 17));
});

test("the tail EXTRAPOLATES past k=4 rather than stopping there", () => {
  // The owner's decision (2026-09-19). A model that said nothing past four weeks and therefore
  // returned four would cap every season-ending injury at a month, which is a systematic
  // understatement of exactly the cases that decide a season.
  const long = drawEpisodeLength(CURVE, 0.001, TAIL, 20);
  assert.ok(long > 4, `a very low uniform must extend past the model's horizon, got ${long}`);
  // And a tail hazard of zero must stop at 4 -- proving the extrapolation is the tail doing it.
  assert.equal(drawEpisodeLength(CURVE, 0.001, 0, 20), 4);
});

test("REAL DATA: the tail hazard is MEASURED, and the per-group split is only used where it is real", { skip: !existsSync("data/ff.db") && "no data/ff.db" }, () => {
  const db = new Database("data/ff.db", { readonly: true });
  try {
    const eps = db.prepare(
      "SELECT injury_group, weeks_missed FROM fact_injury_episode WHERE weeks_missed IS NOT NULL",
    ).all() as { injury_group: string | null; weeks_missed: number | null }[];
    if (eps.length < 1000) return;
    const h = tailHazardFrom(eps);
    assert.ok(h.n > 500, `only ${h.n} episodes reached 4 weeks -- too thin to fit a tail`);
    // A hazard is a probability. A value outside (0,1) would be an arithmetic error that still
    // produces finite episode lengths, so it is asserted rather than assumed.
    assert.ok(h.pooled > 0 && h.pooled < 1, `pooled hazard ${h.pooled} is not a probability`);
    for (const [g, v] of Object.entries(h.byGroup)) {
      assert.ok(v > 0 && v < 1, `${g} hazard ${v} is not a probability`);
    }
    // THE THINNESS GUARD, both directions: groups below the minimum must be ABSENT (so the pool is
    // used), and raising the minimum must remove some -- otherwise the guard is not doing anything.
    const strict = tailHazardFrom(eps, { minEpisodes: 100000 });
    assert.equal(Object.keys(strict.byGroup).length, 0, "an unreachable minimum must leave no group");
    assert.ok(Object.keys(h.byGroup).length > 0, "at the real minimum some groups must qualify");
  } finally { db.close(); }
});
