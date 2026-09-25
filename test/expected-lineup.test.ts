/**
 * THE SHARED EXPECTED-LINEUP MODEL (src/inseason/expectedLineup.ts) -- used by the live waiver verb
 * and by the waiver decision replay. Three contracts:
 *   1. absent options = the D42 arithmetic (byes only, empty slot 0), exactly;
 *   2. `replacement` scores an unfillable slot at the replacement level instead of zero;
 *   3. `availByPos` gives a BENCH man value (he covers missed starts) while leaving a lone starter's
 *      own expectation where it was (he scores rate / a when he plays, with probability a).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedLineupPoints, type ExpLineupPlayer } from "../src/inseason/expectedLineup.js";

const SLOTS = ["QB", "WR", "K"];
const base = (): ExpLineupPlayer[] => [
  { name: "Q1", pos: "QB", rate: 15, bye: 6 },
  { name: "W1", pos: "WR", rate: 12, bye: 7 },
  { name: "K1", pos: "K", rate: 7, bye: 8 },
];
const W = { slots: SLOTS, from: 3, to: 10, firstWk: 3 };

test("absent options reproduce the D42 sum: byes only, an empty slot scores zero", () => {
  // 8 weeks; each starter misses exactly his bye week.
  const want = 15 * 7 + 12 * 7 + 7 * 7;
  assert.equal(expectedLineupPoints(base(), W), want);
});

test("replacement: the bye week's empty slot scores the replacement level, not zero", () => {
  const rep = { QB: 10, WR: 5, K: 6 };
  const got = expectedLineupPoints(base(), { ...W, replacement: rep });
  assert.equal(got, 15 * 7 + 12 * 7 + 7 * 7 + 10 + 5 + 6);
  // So a second kicker covering K1's bye is worth his rate MINUS the replacement, not his whole rate.
  const two = [...base(), { name: "K2", pos: "K", rate: 6.5, bye: 11 }];
  const gain = expectedLineupPoints(two, { ...W, replacement: rep }) - got;
  assert.ok(Math.abs(gain - (6.5 - 6)) < 1e-9, `second kicker gain ${gain}`);
});

test("availByPos: a bench WR gains value covering missed starts; a lone starter's expectation is unchanged", () => {
  const avail = { QB: 1, WR: 0.9, K: 1 };
  const o = { ...W, availByPos: avail, draws: 400, seed: 3 };
  // Lone starter: E[plays * rate/a] = rate, so the total stays near the D42 sum (MC tolerance).
  const lone = expectedLineupPoints(base(), o);
  const d42 = 15 * 7 + 12 * 7 + 7 * 7;
  assert.ok(Math.abs(lone - d42) < 3, `lone-starter total ${lone.toFixed(2)} vs ${d42}`);
  // A bench WR (rate 6) is worth 0 under D42 (he never starts)...
  const withBench = [...base(), { name: "W2", pos: "WR", rate: 6, bye: 9 }];
  assert.equal(expectedLineupPoints(withBench, W) - d42, 6 * 0 + 6 /* covers W1's bye week 7 */);
  // ...and MORE with injuries: he also covers W1's missed weeks (~10% of 6 future weeks x ~6.7/wk).
  const gainInj = expectedLineupPoints(withBench, o) - lone;
  assert.ok(gainInj > 6 + 1.5, `bench gain with injuries ${gainInj.toFixed(2)} should exceed the bye-only 6`);
});

test("this week is never drawn: its play rate and lock apply as stated", () => {
  const o = { ...W, from: 3, to: 3, availByPos: { QB: 0.5, WR: 0.5, K: 0.5 }, draws: 50 };
  // Week 3 is the known week: no injury draw, so the total is exactly the rates.
  assert.equal(expectedLineupPoints(base(), o), 15 + 12 + 7);
  const q = base(); q[2] = { ...q[2], playRate: 0.645 };
  assert.ok(Math.abs(expectedLineupPoints(q, o) - (15 + 12 + 7 * 0.645)) <= 0.05, "optimalLineup rounds totalProj to 0.1");
  const l = base(); l[2] = { ...l[2], locked: true };
  assert.equal(expectedLineupPoints(l, o), 15 + 12);
});
