// THE DECISION METRIC, AND ITS POSITIVE CONTROLS.
//
// `lineupRegret` is the number this track is steered by, so the first thing to establish is that it
// can DISCRIMINATE. Three fault injections, each of which a broken metric would pass:
//
//   1. A model that projects ZERO for everyone must lose decisively. A metric wired to the wrong
//      field, or one that scores the projection instead of the actual, would score it identically to
//      every other model and never say a word.
//   2. An ORACLE that projects each player's actual points must WIN, and must beat every real model.
//      This is the other end of the range: a metric that cannot return its positive value is dead
//      code that reads exactly like a metric that is passing.
//   3. The metric must be PAIRED -- two runs over the same input must produce identical rosters, or
//      a "gain" is indistinguishable from a re-draw.
//
// `score` gets the same treatment: a distribution that is too narrow must under-cover, and CRPS must
// prefer the sharper of two calibrated forecasts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineupRegret, score, SCENARIOS, type Scored1, type Pred } from "../src/weekly/evaluate.js";

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
/** Deterministic pseudo-actuals with real spread, so a good ordering is worth points. */
const actualFor = (i: number, w: number) => ((i * 37 + w * 101) % 41) * 0.6;

function fixture(): Scored1[] {
  const out: Scored1[] = [];
  let i = 0;
  for (let w = 1; w <= 6; w++) {
    for (const pos of POS) {
      const n = pos === "K" || pos === "DST" ? 6 : 16;
      for (let p = 0; p < n; p++, i++) {
        const actual = actualFor(i, w);
        const flat = (v: number): Pred => ({ mean: v, p10: v * 0.3, p50: v * 0.9, p90: v * 1.9 });
        out.push({
          key: `${pos}${p}`, pos, band: "1-12", season: 2099, week: w, actual,
          by: {
            // "good" knows the actual plus REAL noise; "bad" is a constant; "zero" is zero;
            // "oracle" is the actual exactly. The noise has to reorder players -- an earlier version
            // used `actual * 0.8 + 3`, a monotone transform, which produces the oracle's ordering
            // exactly and made the two tie at 140.50. A lineup metric only ever sees the ORDER.
            good: flat(Math.max(0, actual + (((i * 61) % 23) - 11))),
            bad: flat(8),
            zero: { mean: 0, p10: 0, p50: 0, p90: 0 },
            oracle: flat(actual),
          },
        });
      }
    }
  }
  return out;
}

test("FAULT INJECTION: a model that projects zero for everyone loses the lineup metric decisively", () => {
  const r = lineupRegret(fixture(), 40);
  const sc = SCENARIOS[0].name;
  assert.ok(r[sc].zero.drawnRosters > 0, "no rosters were drawn -- the metric measured nothing");
  assert.ok(r[sc].zero.meanCaptured < r[sc].good.meanCaptured,
    `a zero-for-everyone model captured ${r[sc].zero.meanCaptured.toFixed(2)} against a real model's ` +
    `${r[sc].good.meanCaptured.toFixed(2)} -- a lineup metric that cannot make this lose is not ` +
    "measuring lineup quality");
  assert.ok(r[sc].zero.meanCaptured < r[sc].oracle.meanCaptured);
  // A CONSTANT projection and a zero projection are the SAME MODEL as far as a lineup is concerned:
  // both rank every player equally, so both start the same men. They must tie exactly, and a metric
  // that separates them is reading something other than the ordering -- the projected total, most
  // likely, which is not what a lineup captures.
  assert.equal(r[sc].zero.meanCaptured, r[sc].bad.meanCaptured,
    "a zero projection and a constant projection produced different lineups -- the metric is reading " +
    "something other than the ordering");
});

test("POSITIVE CONTROL: an oracle wins the lineup metric, so it can return its high value too", () => {
  const r = lineupRegret(fixture(), 40);
  const sc = SCENARIOS[0].name;
  assert.ok(r[sc].oracle.meanCaptured > r[sc].good.meanCaptured,
    `an oracle captured ${r[sc].oracle.meanCaptured.toFixed(2)} and a noisy model ` +
    `${r[sc].good.meanCaptured.toFixed(2)} -- a metric that only ever punishes cannot reward, and ` +
    "one that cannot reward is not measuring anything");
  assert.ok(r[sc].oracle.meanCaptured > r[sc].bad.meanCaptured);
});

test("the lineup draw is COMMON RANDOM NUMBERS: the same input gives the same rosters twice", () => {
  const a = lineupRegret(fixture(), 25);
  const b = lineupRegret(fixture(), 25);
  assert.deepEqual(a, b,
    "two runs over identical input disagreed -- the roster draw is not seeded, so any 'gain' this " +
    "metric reports is indistinguishable from a re-draw");
});

test("score(): a too-narrow interval under-covers, and CRPS prefers the sharper calibrated forecast", () => {
  const ys = Array.from({ length: 2000 }, (_, i) => ((i * 7919) % 101) * 0.2);   // 0..20, uniform-ish
  const wide = ys.map((y) => ({ actual: y, p: { mean: 10, p10: 1, p50: 10, p90: 19 } }));
  const narrow = ys.map((y) => ({ actual: y, p: { mean: 10, p10: 9, p50: 10, p90: 11 } }));
  const sWide = score(wide), sNarrow = score(narrow);
  assert.ok(sNarrow.coverage < 0.3,
    `a [9, 11] interval over a 0-20 spread covered ${sNarrow.coverage.toFixed(3)} -- the coverage ` +
    "statistic cannot see an interval that is far too narrow");
  assert.ok(sWide.coverage > 0.8);
  assert.ok(sWide.crps < sNarrow.crps, "CRPS preferred the badly-narrow forecast");

  // And the sharper of two forecasts that are BOTH calibrated must win on CRPS -- otherwise the
  // metric is only measuring width and would reward a model that says "somewhere between 0 and 100".
  const sharp = ys.map((y) => ({ actual: y, p: { mean: y, p10: y - 1, p50: y, p90: y + 1 } }));
  assert.ok(score(sharp).crps < sWide.crps, "CRPS did not prefer a sharp, correct forecast");
  assert.ok(Number.isNaN(score([]).crps), "an empty group must not report a number");
});

test("coverage and coverageNonZero differ exactly by the zero atom sitting on a p10 of 0", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => ({ actual: 0, p: { mean: 5, p10: 0, p50: 4, p90: 12 } })),
    ...Array.from({ length: 20 }, () => ({ actual: 30, p: { mean: 5, p10: 0, p50: 4, p90: 12 } })),
  ];
  const s = score(rows);
  assert.equal(s.coverage, 0.5, "the zero weeks must count as covered -- the interval does contain 0");
  assert.equal(s.coverageNonZero, 0,
    "coverageNonZero must exclude them, or the two statistics are the same number twice");
});
