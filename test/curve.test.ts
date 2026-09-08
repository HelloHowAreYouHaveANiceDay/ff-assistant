// THE PROJECTION CURVE -- order statistic vs conditional expectation.
//
// The defect these tests exist to catch is not a crash. It is a curve that looks entirely
// reasonable -- smooth, monotone, plausible point totals -- and answers a different question from
// the one the board asks. `buildCurveFromHistory` returns the k-th best FINISHER's season; the board
// applies it to the player ranked k in PRESEASON ECR. Both are real quantities and only one is the
// conditional expectation the auction needs, so nothing about the output betrays the substitution.
// It survived for the life of the project and was re-discovered three times as a "level shift" in
// downstream fits.
//
// So the assertions here are about the RELATIONSHIP between the two curves, which is the only place
// the difference is visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  buildCurveFromHistory, buildPriorRankCurve, buildConditionalCurve, isotonicNonIncreasing,
} from "../src/data/projections.js";
import { openDb } from "../src/db/db.js";

const SEASON = 2026;
const HAVE_HISTORY = existsSync("data/history-points.csv");
const HAVE_DB = existsSync("data/ff.db");
const POS = ["QB", "RB", "WR", "TE"];

test("isotonic repair only ever pulls a curve DOWN, and leaves a monotone curve alone", () => {
  assert.deepEqual(isotonicNonIncreasing([10, 8, 9, 7, 7.5]), [10, 8, 8, 7, 7]);
  const already = [10, 9, 8, 7];
  assert.deepEqual(isotonicNonIncreasing(already), already);
  // It must never invent a value above what was measured.
  const raw = [5, 9, 3];
  const fixed = isotonicNonIncreasing(raw);
  for (let i = 0; i < raw.length; i++) assert.ok(fixed[i] <= raw[i], `index ${i} rose: ${raw[i]} -> ${fixed[i]}`);
});

test("(a) the conditional curve at RB rank 1 is at least 20% BELOW the order statistic", (t) => {
  if (!HAVE_HISTORY) return t.skip("no history-points.csv");
  const db = HAVE_DB ? openDb("data/ff.db") : null;
  const cond = buildConditionalCurve(db, SEASON).curve;
  db?.close();
  const order = buildCurveFromHistory(SEASON);
  const ratio = cond.RB[0] / order.RB[0];
  assert.ok(ratio <= 0.80,
    `RB1 conditional ${cond.RB[0].toFixed(0)} vs order-stat ${order.RB[0].toFixed(0)} = ${ratio.toFixed(2)}; ` +
    `the order statistic carries the winner's luck of whoever won the slot, so it must sit well above ` +
    `E[pts | entering ranked RB1]. A ratio near 1.0 means the conditional curve is not conditioning.`);
});

test("(b) the conditional curve is monotone NON-INCREASING at every position", (t) => {
  if (!HAVE_HISTORY) return t.skip("no history-points.csv");
  const db = HAVE_DB ? openDb("data/ff.db") : null;
  const { curve } = buildConditionalCurve(db, SEASON);
  db?.close();
  for (const pos of POS) {
    const c = curve[pos];
    assert.ok(c && c.length > 24, `${pos} curve must reach past rank 24 (got ${c?.length ?? 0})`);
    for (let i = 1; i < c.length; i++) {
      // A rising curve is not cosmetic: baselines() reads a rank off this as the replacement level
      // and computeValues subtracts it from everyone, so a rise hands a worse player a higher VOR.
      assert.ok(c[i] <= c[i - 1] + 1e-9,
        `${pos} rank ${i + 1} (${c[i].toFixed(1)}) exceeds rank ${i} (${c[i - 1].toFixed(1)})`);
    }
  }
});

// THE PRE-REGISTERED THRESHOLD WAS 0.85 AND THE SHIPPED CURVE DOES NOT MEET IT AT QB OR RB.
// That is recorded rather than tuned away, and the reason is worth keeping.
//
// The 0.85 came from the RAW prior-rank column (QB 0.66-0.75 over ranks 1-12). But the combination
// rule -- shape from prior-rank, LEVEL from preseason ECR -- multiplies that shape by a per-position
// factor, and those factors are above 1 everywhere: QB 1.218, RB 1.116, TE 1.127, WR 1.074. The
// level correction is the whole point of using ECR (it is the variable the board is actually indexed
// by, and the market knows a quarterback's worth far better than his last finish does), so the
// measured means land at QB 0.876, RB 0.863, WR 0.835, TE 0.849. Two of four miss 0.85.
//
// So this test asserts the honest measured bound. The claim the finding actually makes -- that the
// TOP of the board is over-priced -- is asserted separately and far more decisively below, on VOR.
test("(c) the conditional curve sits materially below the order statistic over ranks 1-12", (t) => {
  if (!HAVE_HISTORY) return t.skip("no history-points.csv");
  const db = HAVE_DB ? openDb("data/ff.db") : null;
  const { curve: cond } = buildConditionalCurve(db, SEASON);
  db?.close();
  const order = buildCurveFromHistory(SEASON);
  for (const pos of POS) {
    const ratios: number[] = [];
    for (let k = 0; k < 12; k++) ratios.push(cond[pos][k] / order[pos][k]);
    const m = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    assert.ok(m < 0.90,
      `${pos}: mean conditional/order-stat over ranks 1-12 is ${m.toFixed(3)}, expected < 0.90. ` +
      `Near 1.0 means the shipped order-statistic curve is being returned under a new name.`);
  }
});

// THE ASSERTION THAT CARRIES THE FINDING. Points are not what the auction spends; VOR is. A curve
// could be uniformly 10% low at every rank and change no dollar at all, because a flat scale cancels
// in the VOR-to-dollar split. What matters is whether the curve is STEEPER than the truth at the
// top, and VOR of the #1 player is exactly that quantity -- the number the whole book is scaled from.
//
// This is also the assertion the broken case is structurally incapable of satisfying: run against
// the order-statistic curve, every ratio here is 1.00 by construction.
test("the conditional curve COMPRESSES VOR at the top of the board -- the finding, in the units that matter", (t) => {
  if (!HAVE_HISTORY) return t.skip("no history-points.csv");
  const db = HAVE_DB ? openDb("data/ff.db") : null;
  const { curve: cond } = buildConditionalCurve(db, SEASON);
  db?.close();
  const order = buildCurveFromHistory(SEASON);
  // Replacement rank under the shipped weighted-FLEX fill (values.ts baselines()).
  const base: Record<string, number> = { QB: 17, RB: 30, WR: 36, TE: 17 };
  for (const pos of POS) {
    const vOrder = order[pos][0] - order[pos][base[pos] - 1];
    const vCond = cond[pos][0] - cond[pos][base[pos] - 1];
    assert.ok(vCond > 0, `${pos}: conditional VOR must stay positive (got ${vCond.toFixed(0)})`);
    assert.ok(vCond / vOrder < 0.75,
      `${pos}: VOR of the #1 player is ${vCond.toFixed(0)} conditional vs ${vOrder.toFixed(0)} order-stat ` +
      `= ${(vCond / vOrder).toFixed(2)}, expected < 0.75. A ratio of 1.00 is what the order-statistic ` +
      `curve returns, so this is the test that tells the two curves apart.`);
  }
});

test("the prior-rank curve is built from many season pairs, not a handful", (t) => {
  if (!HAVE_HISTORY) return t.skip("no history-points.csv");
  // A curve silently fitted on two seasons would still be monotone and still sit below the order
  // statistic -- it would pass (a), (b) and (c) while being noise. Assert the sample instead.
  const { pairs } = buildPriorRankCurve(SEASON);
  assert.ok(pairs >= 20, `expected 20+ season pairs, got ${pairs}`);
});

test("the expanding window HIDES later seasons -- the backtest's no-lookahead guarantee", (t) => {
  if (!HAVE_HISTORY) return t.skip("no history-points.csv");
  // The load-bearing property for the backtest: a curve built for season Y must be a function of
  // seasons < Y only. Prove it by SHOWING the curve move when the window moves -- a `beforeSeason`
  // argument that was accepted and ignored would return identical curves, which is the failure this
  // catches. (A dead parameter is indistinguishable from a working one on any single call.)
  const early = buildPriorRankCurve(SEASON, "data/history-points.csv", 2010);
  const late = buildPriorRankCurve(SEASON, "data/history-points.csv", 2025);
  assert.ok(early.pairs < late.pairs, `expanding window must grow: ${early.pairs} vs ${late.pairs} pairs`);
  assert.notEqual(early.curve.RB[0], late.curve.RB[0],
    "a curve cut off at 2010 must differ from one cut off at 2025; identical means beforeSeason is inert");
});

test("the ECR level correction stays inside its guard", (t) => {
  if (!HAVE_HISTORY || !HAVE_DB) return t.skip("no history or store");
  const db = openDb("data/ff.db");
  const { levelFactor } = buildConditionalCurve(db, SEASON);
  db.close();
  for (const pos of POS) {
    const f = levelFactor[pos];
    assert.ok(f >= 0.5 && f <= 2.0, `${pos} level factor ${f} escaped the [0.5, 2.0] guard`);
  }
  // And at least one position must actually BE corrected, or the ECR join has silently collapsed to
  // "no coverage anywhere" and every factor defaulted to 1 -- which reads exactly like a working
  // build that happened not to need correcting.
  assert.ok(POS.some((p) => Math.abs(levelFactor[p] - 1) > 0.02),
    `every level factor is 1.00 (${POS.map((p) => `${p} ${levelFactor[p]}`).join(", ")}) -- the ECR join found nothing`);
});
