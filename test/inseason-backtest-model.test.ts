// STEP 3: the three backtests' arithmetic, and the gates that decide whether anything ships.
//
// These are hermetic unit tests on the pure pieces. The backtests themselves run against the real
// store and are reported in docs/in-season-backtest.md; what is testable here is that the estimator
// recovers a known answer, that the summary statistics mean what their names say, and -- the part
// that matters -- that the SHIP GATE can actually return both of its answers. A gate that has only
// ever refused is indistinguishable from a gate that is broken shut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ols, summarizeByPosition, crossValidate, priorPrediction, type PromotionRow } from "../src/inseason/backtest/promotion.js";
import { seasonBootstrap, mean, median } from "../src/inseason/backtest/lineup.js";

const row = (o: Partial<PromotionRow>): PromotionRow => ({
  season: 2020, week: 5, team: "AAA", pos: "RB",
  starterSk: "1", starterName: "S", starterT4: 10,
  backupSk: "2", backupName: "B", backupT4: 5,
  backupPriorSnapPct: 0.4, impliedTotal: 24,
  ptsW: 12, snapPctW: 0.7, next4Mean: 10, next4Games: 4, ...o,
});

test("OLS recovers coefficients it was given, exactly", () => {
  // y = 3 + 2*x1 - 1*x2, no noise. An estimator that cannot recover a noiseless line is not one
  // whose null result on real data means anything.
  const X: number[][] = [], y: number[] = [];
  for (let i = 0; i < 40; i++) {
    const x1 = (i % 7) + 1, x2 = ((i * 3) % 5) + 1;
    X.push([1, x1, x2]);
    y.push(3 + 2 * x1 - x2);
  }
  const w = ols(X, y);
  assert.ok(Math.abs(w[0] - 3) < 1e-3, `intercept ${w[0]}`);
  assert.ok(Math.abs(w[1] - 2) < 1e-3, `b1 ${w[1]}`);
  assert.ok(Math.abs(w[2] + 1) < 1e-3, `b2 ${w[2]}`);
});

test("the shipped handcuff prior is applied as handcuff.ts states it", () => {
  // 0.922*backup + 0.402*lead. If the two ever disagree, the gate below is grading the wrong model.
  assert.ok(Math.abs(priorPrediction(row({ backupT4: 10, starterT4: 20 })) - (0.922 * 10 + 0.402 * 20)) < 1e-9);
});

test("shareOfStarter is a RATIO OF MEANS, and differs from the mean of ratios when it should", () => {
  // One event with a tiny denominator: the mean of ratios explodes, the ratio of means does not.
  // Both are reported by the summariser precisely because they are not the same number.
  const rows = [
    row({ ptsW: 5, starterT4: 10 }),
    row({ ptsW: 5, starterT4: 10 }),
    row({ ptsW: 5, starterT4: 0.5 }),
  ];
  const s = summarizeByPosition(rows).find((x) => x.pos === "RB")!;
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.shareOfStarter - 15 / 20.5) < 1e-3, `ratio of means ${s.shareOfStarter}`);
  // The mean-of-ratios column drops the tiny denominator (its floor is 3 points a game), so it sees
  // two events at exactly 0.5.
  assert.equal(s.ratioN, 2);
  assert.ok(Math.abs(s.meanRatio - 0.5) < 1e-9);
});

test("FAULT INJECTION: the ship gate can PASS -- fed data the new features explain perfectly", () => {
  // The real answer is that the new model does NOT beat the shipped prior, and a gate that can only
  // ever say that is dead code. Here the outcome IS a clean function of the new features and is
  // unrelated to the backup's own form, which is the prior's main input, so the new model must win.
  const rows: PromotionRow[] = [];
  for (let s = 2018; s <= 2024; s++) {
    for (let i = 0; i < 12; i++) {
      const starterT4 = 4 + (i % 9);
      const snap = 0.1 * (i % 8);
      rows.push(row({
        season: s, week: 3 + i, starterT4, backupPriorSnapPct: snap, impliedTotal: 22,
        backupT4: 30 - i,                                   // deliberately anti-correlated with y
        ptsW: 1 + 1.5 * starterT4 + 10 * snap,
      }));
    }
  }
  const cv = crossValidate(rows, "RB");
  assert.ok(cv.folds >= 5, `only ${cv.folds} folds`);
  assert.ok(cv.rmseNew < cv.rmsePrior,
    `the gate cannot pass: new ${cv.rmseNew} vs prior ${cv.rmsePrior} on data the new features generate exactly`);
  assert.ok(cv.rmseNew < 1e-6, `the fit is not exact: ${cv.rmseNew}`);
});

test("FAULT INJECTION: the ship gate FAILS when the prior is the true model", () => {
  const rows: PromotionRow[] = [];
  for (let s = 2018; s <= 2024; s++) {
    for (let i = 0; i < 12; i++) {
      const backupT4 = 2 + (i % 11), starterT4 = 3 + ((i * 5) % 13);
      rows.push(row({
        season: s, week: 3 + i, backupT4, starterT4,
        backupPriorSnapPct: 0.5, impliedTotal: 22,
        ptsW: 0.922 * backupT4 + 0.402 * starterT4,
      }));
    }
  }
  const cv = crossValidate(rows, "RB");
  assert.ok(cv.rmsePrior < 1e-9, `the prior should be exact on its own generating process, got ${cv.rmsePrior}`);
  assert.ok(cv.rmseNew > cv.rmsePrior, "the gate passed a model that is worse than the incumbent");
});

test("the season bootstrap resamples SEASONS, not rows", () => {
  // Two seasons, one strongly positive and one strongly negative. Resampling seasons must produce
  // an interval wide enough to contain both season means; resampling rows would not.
  const rows = [
    ...Array.from({ length: 200 }, () => ({ season: 2018, toolGain: 5 })),
    ...Array.from({ length: 200 }, () => ({ season: 2019, toolGain: -5 })),
  ];
  const b = seasonBootstrap(rows, 500);
  assert.equal(b.seasons, 2);
  assert.ok(Math.abs(b.mean) < 1e-9);
  assert.ok(b.lo <= -4.9 && b.hi >= 4.9, `interval [${b.lo}, ${b.hi}] is too tight -- it is resampling rows`);
});

test("mean and median are the ordinary ones, including the even case", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(mean([]), 0);
});
