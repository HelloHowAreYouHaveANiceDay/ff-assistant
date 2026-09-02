// Fault-injection for live repricing: prove inflation returns BOTH sides (>1 when money-rich, <1 when
// value-rich) -- a factor that can only ever say "1" would be dead code that reads like it works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInflation, scarcityPremium, positionInflationFactors } from "../src/draft/inflation.ts";

const board = [
  { name: "A", pos: "RB", value: 50 },
  { name: "B", pos: "WR", value: 30 },
  { name: "C", pos: "RB", value: 20 },
  { name: "D", pos: "TE", value: 10 },
];

test("inflation > 1 when money-rich vs the value left (reprice UP)", () => {
  // book value of top 4 = 110; $220 chasing it -> 2x, clamped to the 1.4 ceiling ([0.8,1.4] band).
  const inf = computeInflation(board, 220, 4);
  assert.ok(inf > 1.3, `expected inflation, got ${inf}`);
});

test("inflation < 1 when value-rich vs money (be patient)", () => {
  const inf = computeInflation(board, 55, 4); // $55 for $110 of value -> 0.5, clamped to the 0.8 floor
  assert.ok(inf < 1 && inf >= 0.8, `expected deflation floor 0.8, got ${inf}`);
});

test("FAULT: a short board pads uncovered slots at $1 (no runaway from virtualization)", () => {
  // 4 players listed but 10 open slots league-wide, $150 left. Without padding book=110 -> 1.36; WITH
  // padding book=110+6=116 -> 1.29. Both inside [0.8,1.4] so the padding reduction stays visible.
  const padded = computeInflation(board, 150, 10);
  const unpadded = computeInflation(board, 150, 4);
  assert.ok(padded < unpadded, `padding must reduce the factor: padded ${padded} vs ${unpadded}`);
});

test("inflation is neutral (1) with no slots or empty board", () => {
  assert.equal(computeInflation(board, 200, 0), 1);
  assert.equal(computeInflation([], 200, 10), 1);
});

test("FAULT: per-position factor fades an overpaid position, leans into a cheap one", () => {
  // WR paid way over book (overpaid), RB paid under book (cheap). Enough samples to beat the prior.
  const drafted = [
    ...Array.from({ length: 8 }, () => ({ pos: "WR", price: 40, value: 20 })), // WR at 2x book
    ...Array.from({ length: 8 }, () => ({ pos: "RB", price: 20, value: 40 })), // RB at 0.5x book
  ];
  const f = positionInflationFactors(drafted, { minSample: 4 });
  assert.ok(f.WR < 0.95, `overpaid WR should get a fade factor <1, got ${f.WR}`);
  assert.ok(f.RB > 1.05, `cheap RB should get a lean-in factor >1, got ${f.RB}`);
});

test("FAULT: too few picks -> no factors (don't trust a tiny sample)", () => {
  assert.deepEqual(positionInflationFactors([{ pos: "WR", price: 40, value: 20 }]), {});
});

test("scarcity premium: thin position -> premium; deep -> ~0", () => {
  const thin = scarcityPremium({ name: "A", pos: "RB", value: 50 }, board, 1); // next RB is C=20 -> +30
  assert.equal(thin, 30);
  const deep = scarcityPremium({ name: "A", pos: "RB", value: 50 }, board, 5); // need beyond supply -> next=20 still
  assert.ok(deep >= 0);
});
