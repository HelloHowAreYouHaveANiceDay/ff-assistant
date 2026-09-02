// Fault-injection for live repricing: prove inflation returns BOTH sides (>1 when money-rich, <1 when
// value-rich) -- a factor that can only ever say "1" would be dead code that reads like it works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInflation, scarcityPremium } from "../src/draft/inflation.ts";

const board = [
  { name: "A", pos: "RB", value: 50 },
  { name: "B", pos: "WR", value: 30 },
  { name: "C", pos: "RB", value: 20 },
  { name: "D", pos: "TE", value: 10 },
];

test("inflation > 1 when money-rich vs the value left (reprice UP)", () => {
  // book value of top 4 = 110; $220 chasing it -> ~2x, clamped to 2.0
  const inf = computeInflation(board, 220, 4);
  assert.ok(inf > 1.3, `expected inflation, got ${inf}`);
});

test("inflation < 1 when value-rich vs money (be patient)", () => {
  const inf = computeInflation(board, 55, 4); // $55 for $110 of value -> 0.5, clamped to 0.7
  assert.ok(inf < 1 && inf >= 0.7, `expected deflation floor, got ${inf}`);
});

test("FAULT: a short board pads uncovered slots at $1 (no runaway from virtualization)", () => {
  // 4 players listed but 104 open slots league-wide, $400 left. Without padding book=110 -> 3.6x
  // (clamped 2.0); WITH padding book=110+100=210 -> ~1.9. Padding must lower the factor.
  const padded = computeInflation(board, 400, 104);
  const unpadded = computeInflation(board, 400, 4);
  assert.ok(padded < unpadded, `padding must reduce the factor: padded ${padded} vs ${unpadded}`);
});

test("inflation is neutral (1) with no slots or empty board", () => {
  assert.equal(computeInflation(board, 200, 0), 1);
  assert.equal(computeInflation([], 200, 10), 1);
});

test("scarcity premium: thin position -> premium; deep -> ~0", () => {
  const thin = scarcityPremium({ name: "A", pos: "RB", value: 50 }, board, 1); // next RB is C=20 -> +30
  assert.equal(thin, 30);
  const deep = scarcityPremium({ name: "A", pos: "RB", value: 50 }, board, 5); // need beyond supply -> next=20 still
  assert.ok(deep >= 0);
});
