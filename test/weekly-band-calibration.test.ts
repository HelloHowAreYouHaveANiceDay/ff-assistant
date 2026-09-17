/**
 * D32 -- THE BAND CALIBRATION, on the CONSUMER side.
 *
 * The artifact carries a per-position multiplicative scale on the served p10/p90 and
 * `src/weekly/projector.ts` applies it. Four things have to be true and each one below is asserted
 * with the failure it guards against injected, because a calibration is exactly the kind of change
 * that produces plausible numbers whichever way it is wrong:
 *
 *   1. ABSENT means the OLD band, byte-for-byte. An artifact written before the field existed must
 *      serve what it always served -- and the control for that assertion is the same artifact WITH a
 *      field, which must differ.
 *   2. The MEDIAN AND THE MEAN ARE NOT TOUCHED. A calibration that moved the point estimate is a
 *      model change wearing a calibration's name.
 *   3. The ZERO ATOM SURVIVES. This is why the scale is multiplicative: an additive offset would
 *      lift every p10 that sits on the atom off the floor and make every ruled-out man's realised 0
 *      a below-p10 miss. A p10 of exactly 0 must stay exactly 0 under ANY scale.
 *   4. A MALFORMED calibration is REFUSED, not partly applied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectWeekly, loadWeeklyArtifact, seasonLineOnlyArtifact,
  type WeeklyArtifact, type WeeklyInputRow, type WeeklyBandCalibration,
} from "../src/weekly/projector.js";

/** A minimal, valid quantile artifact: p10 = 0.4x the line, p50 = 1.0x, p90 = 1.8x. */
function quantArtifact(): WeeklyArtifact {
  const a = seasonLineOnlyArtifact({ positions: ["RB", "WR"], seasons: [2024] });
  for (const pos of ["RB", "WR"]) {
    a.coef[pos] = { mean: { intercept: 1 }, p10: { intercept: 0.4 }, p50: { intercept: 1 }, p90: { intercept: 1.8 } };
  }
  return a;
}

const row = (pos: string, line: number): WeeklyInputRow => ({
  feat_key: `${pos}-1`, player_sk: null, name: `${pos} One`, pos, season: 2024, week: 5,
  season_line_pg: line, f: {},
});

const cal = (perPos: WeeklyBandCalibration["perPos"]): WeeklyBandCalibration =>
  ({ method: "conformal-scale", levels: { lo: 0.10, hi: 0.90 }, k: 5, perPos });

// ---------------------------------------------------------------------------------------------
// 1. ABSENT = unchanged, and the control that the field does anything at all.
// ---------------------------------------------------------------------------------------------

test("an artifact with NO bandCalibration projects exactly what it always did", () => {
  const a = quantArtifact();
  assert.equal(a.bandCalibration, undefined);
  const [p] = projectWeekly({ artifact: a, rows: [row("RB", 10)] });
  assert.equal(p.p10, 4);
  assert.equal(p.p50, 10);
  assert.equal(p.p90, 18);
  assert.equal(p.mean, 10);
});

test("CONTROL: the same artifact WITH a calibration produces a different band -- the field is connected", () => {
  const a = { ...quantArtifact(), bandCalibration: cal({ RB: { p10: 1.5, p90: 1.25, n: 1000 } }) };
  const [p] = projectWeekly({ artifact: a, rows: [row("RB", 10)] });
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) < 1e-9, `${got} != ${want}`);
  near(p.p10, 6);                    // 0.4 * 1.5 * 10
  near(p.p90, 22.5);                 // 1.8 * 1.25 * 10
  // ...and a position the calibration does NOT name is served uncalibrated, in the same call.
  const [w] = projectWeekly({ artifact: a, rows: [row("WR", 10)] });
  assert.equal(w.p10, 4);
  assert.equal(w.p90, 18);
});

// ---------------------------------------------------------------------------------------------
// 2. The point estimate is not the calibration's business.
// ---------------------------------------------------------------------------------------------

test("the MEAN and the MEDIAN are byte-identical across the calibration", () => {
  const base = quantArtifact();
  const rows = [row("RB", 10), row("RB", 3.5), row("WR", 22)];
  const before = projectWeekly({ artifact: base, rows });
  const after = projectWeekly({
    artifact: { ...base, bandCalibration: cal({ RB: { p10: 1.4, p90: 1.3, n: 1 }, WR: { p10: 0.8, p90: 1.9, n: 1 } }) },
    rows,
  });
  assert.equal(before.length, after.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].mean, before[i].mean);
    assert.equal(after[i].p50, before[i].p50);
    assert.notEqual(after[i].p90, before[i].p90);   // the control: SOMETHING moved
  }
});

// ---------------------------------------------------------------------------------------------
// 3. The zero atom, which is the whole reason this is a scale and not a shift.
// ---------------------------------------------------------------------------------------------

test("a p10 sitting on the ZERO ATOM stays exactly 0 under any scale", () => {
  const a = quantArtifact();
  a.coef.RB.p10 = { intercept: 0 };                   // the atom: the model says the floor is zero
  for (const s of [1.0001, 1.5, 4, 100]) {
    const [p] = projectWeekly({ artifact: { ...a, bandCalibration: cal({ RB: { p10: s, p90: 1, n: 1 } }) }, rows: [row("RB", 12)] });
    assert.equal(p.p10, 0, `scale ${s} lifted the atom off the floor -- an additive offset would, and that is why this is a scale`);
  }
});

test("the calibrated band never crosses the median", () => {
  const a = quantArtifact();
  // A scale big enough to push p10 (0.4) past p50 (1.0), and one small enough to pull p90 under it.
  const [p] = projectWeekly({
    artifact: { ...a, bandCalibration: cal({ RB: { p10: 9, p90: 0.1, n: 1 } }) },
    rows: [row("RB", 10)],
  });
  assert.equal(p.p50, 10);
  assert.equal(p.p10, 10, "p10 must be clamped at the median, never above it");
  assert.equal(p.p90, 10, "p90 must be clamped at the median, never below it");
});

test("the calibrated band is re-clamped to the artifact's own [lo, hi]", () => {
  const a = quantArtifact();
  a.clamps = { lo: 0, hi: 2 };
  const [p] = projectWeekly({ artifact: { ...a, bandCalibration: cal({ RB: { p10: 1, p90: 5, n: 1 } }) }, rows: [row("RB", 10)] });
  assert.equal(p.p90, 20, "1.8 * 5 = 9 must clamp to hi = 2, i.e. 20 points on a 10-point line");
});

// ---------------------------------------------------------------------------------------------
// 4. A malformed calibration is refused. FAULT INJECTION, one per rule.
// ---------------------------------------------------------------------------------------------

const withCal = (c: unknown): unknown => ({ ...quantArtifact(), golden: [], bandCalibration: c });

test("the loader ACCEPTS a well-formed calibration -- the positive control for every refusal below", () => {
  const a = loadWeeklyArtifact(withCal(cal({ RB: { p10: 1.1, p90: 1.2, n: 10 } })));
  assert.equal(a.bandCalibration?.perPos.RB.p90, 1.2);
});

test("the loader REFUSES an unknown method -- a shift and a scale are not interchangeable", () => {
  assert.throws(() => loadWeeklyArtifact(withCal({ ...cal({ RB: { p10: 1, p90: 1, n: 1 } }), method: "conformal-shift" })),
    /method[\s\S]*conformal-scale/);
});

test("the loader REFUSES a non-positive scale -- 0 would collapse the band onto the median", () => {
  assert.throws(() => loadWeeklyArtifact(withCal(cal({ RB: { p10: 0, p90: 1, n: 1 } }))), /finite POSITIVE scale/);
  assert.throws(() => loadWeeklyArtifact(withCal(cal({ RB: { p10: 1, p90: -1, n: 1 } }))), /finite POSITIVE scale/);
});

test("the loader REFUSES k < 2 -- an in-sample band correction is narrower than the thing it corrects", () => {
  assert.throws(() => loadWeeklyArtifact(withCal({ ...cal({ RB: { p10: 1, p90: 1, n: 1 } }), k: 0 })), /bandCalibration.k/);
});

test("the loader REFUSES a calibration naming a position the artifact has no heads for", () => {
  assert.throws(() => loadWeeklyArtifact(withCal(cal({ QB: { p10: 1, p90: 1, n: 1 } }))), /names position QB/);
});

test("the loader REFUSES bad levels", () => {
  assert.throws(() => loadWeeklyArtifact(withCal({ ...cal({ RB: { p10: 1, p90: 1, n: 1 } }), levels: { lo: 0.9, hi: 0.1 } })), /levels/);
});

// ---------------------------------------------------------------------------------------------
// 5. THE GOLDEN CONTRACT. The trainer computes its golden rows AFTER attaching the calibration, so
//    a consumer that failed to apply it -- or applied it differently -- is refused by the same block
//    that already catches a renamed feature. Injected here by writing a golden row that expects the
//    UNCALIBRATED band on a calibrated artifact.
// ---------------------------------------------------------------------------------------------

test("the golden block CATCHES a consumer that ignores the calibration", () => {
  const a = quantArtifact();
  a.golden = [{ pos: "RB", line: 10, f: {}, expect: { mean: 10, p10: 4, p50: 10, p90: 18 } }];
  loadWeeklyArtifact({ ...a });                                     // uncalibrated: the golden holds
  assert.throws(
    () => loadWeeklyArtifact({ ...a, bandCalibration: cal({ RB: { p10: 1.5, p90: 1.25, n: 1 } }) }),
    /golden row 0 \(RB\)/,
    "a golden block written without the calibration must be refused on a calibrated artifact",
  );
});
