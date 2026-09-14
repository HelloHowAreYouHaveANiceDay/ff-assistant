import { test } from "node:test";
import assert from "node:assert/strict";
// The admission effect-size floor lives beside the arbiter primitives it reuses (seasonEffect).
import { admissionVerdict } from "../scripts/lib/arbiter.mjs";

// 18 seasons of synthetic per-season TRAINED pinball. Baseline flat at 12.0; each case perturbs the
// candidate. Deterministic "noise" so the seeded bootstrap in seasonEffect gives a stable verdict.
const SEASONS = Array.from({ length: 18 }, (_, i) => 2008 + i);
const base = new Map(SEASONS.map((s) => [s, 12.0]));
// wiggle in [-0.5, 0.5], deterministic per index.
const wig = (i: number) => (((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5;
const cand = (fn: (s: number, i: number) => number) => new Map(SEASONS.map((s, i) => [s, fn(s, i)]));

test("admission floor: a CLEAR, consistent improvement is ADMITTED", () => {
  const c = cand((_s, i) => 12.0 - 0.28 + 0.03 * wig(i)); // ~0.28 better, low variance
  const v = admissionVerdict(c, base, SEASONS);
  assert.ok(v.improvement > 0.2, `improvement ${v.improvement}`);
  assert.ok(v.improvement > v.floor, `improvement ${v.improvement} must clear floor ${v.floor}`);
  assert.equal(v.pass, true);
});

test("FAULT: a tiny improvement swamped by variance is REJECTED (the contract_year shape)", () => {
  // mean improvement ~0.01 but big season-to-season swings -> inside the floor.
  const c = cand((_s, i) => 12.0 - 0.01 + 0.45 * (i % 2 === 0 ? 1 : -1) + 0.05 * wig(i));
  const v = admissionVerdict(c, base, SEASONS);
  assert.ok(Math.abs(v.improvement) < 0.05, `improvement ${v.improvement}`);
  assert.ok(v.floor > Math.abs(v.improvement), `floor ${v.floor} must exceed improvement ${v.improvement}`);
  assert.equal(v.pass, false);
});

test("FAULT: a NULL candidate (zero-mean noise) is REJECTED", () => {
  const c = cand((_s, i) => 12.0 + 0.3 * wig(i)); // no real improvement
  const v = admissionVerdict(c, base, SEASONS);
  assert.equal(v.pass, false);
});

test("FAULT: a candidate that is WORSE (higher pinball) is REJECTED", () => {
  const c = cand(() => 12.2); // uniformly worse
  const v = admissionVerdict(c, base, SEASONS);
  assert.ok(v.improvement < 0, `improvement ${v.improvement} should be negative`);
  assert.equal(v.pass, false);
});

test("the floor can be tuned, and a slack floor admits what the strict floor rejects", () => {
  const c = cand((_s, i) => 12.0 - 0.06 + 0.05 * wig(i)); // modest, low-noise improvement
  const strict = admissionVerdict(c, base, SEASONS, { floorK: 2.9 });
  const slack = admissionVerdict(c, base, SEASONS, { floorK: 0.5 });
  assert.ok(slack.floor < strict.floor);
  // sanity: the same improvement, only the bar moved.
  assert.equal(strict.improvement.toFixed(6), slack.improvement.toFixed(6));
});
