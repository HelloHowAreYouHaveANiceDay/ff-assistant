// DIM-1856: the CANDIDATE mixture mean (FF_WEEKLY_MEAN_SOURCE=mixture, src/weekly/projector.ts).
// `mixtureMean` must be the exact mean of the curve the win-probability sampler draws from
// (`quantileFn`), the switch must move the MEAN ONLY, and "head" must be the serve unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { loadWeeklyRows } from "../src/weekly/features.js";
import { loadWeeklyArtifact, mixtureMean, projectWeekly } from "../src/weekly/projector.js";
import { quantileFn } from "../src/inseason/winprob.js";

const ART = "data/weekly-artifact.json";
const ready = existsSync(ART) && existsSync("data/ff.db");

/** Midpoint-rule integral of the sampler's inverse CDF -- an independent route to the same number. */
function sampledMean(band: Parameters<typeof mixtureMean>[0]): number {
  const q = quantileFn({ mean: 0, ...band });
  const n = 200_000;
  let s = 0;
  for (let i = 0; i < n; i++) s += q((i + 0.5) / n);
  return s / n;
}

test("mixtureMean equals the mean of winprob's quantileFn (atom, knots, tail)", () => {
  const cases = [
    { p10: 4, p50: 11, p90: 22, pZero: 0.03, knots: { u: [0.03, 0.0785, 0.127, 0.224, 0.321, 0.515, 0.709, 0.903], v: [0, 3.1, 4.4, 6.6, 8.5, 11.2, 14.9, 22.1] } },
    { p10: 0, p50: 0, p90: 6, pZero: 0.62, knots: { u: [0.62, 0.639, 0.658, 0.696, 0.734, 0.81, 0.886, 0.962], v: [0, 0.4, 0.9, 1.7, 2.6, 4.1, 5.9, 9.3] } },
    { p10: 2, p50: 5, p90: 9, pZero: 0 },            // no knots: the three served levels
    { p10: 5, p50: 9, p90: 10, pZero: 0.02 },        // tight top: the 0.25*top tail branch
    { p10: 0, p50: 0, p90: 0, pZero: 0.99 },         // near-certain zero: the 0.5 tail floor
  ];
  for (const c of cases) {
    const want = sampledMean(c), got = mixtureMean(c);
    assert.ok(Math.abs(got - want) < 1e-6, `mixtureMean ${got} vs sampled ${want}`);
  }
});

function run(source: "head" | "mixture") {
  const prev = process.env.FF_WEEKLY_MEAN_SOURCE;
  process.env.FF_WEEKLY_MEAN_SOURCE = source;
  try {
    const db = openDb("data/ff.db");
    try {
      const rows = loadWeeklyRows(db as never, 2026, 4);
      return projectWeekly({ artifact: loadWeeklyArtifact(JSON.parse(readFileSync(ART, "utf8"))), rows });
    } finally { db.close(); }
  } finally { if (prev === undefined) delete process.env.FF_WEEKLY_MEAN_SOURCE; else process.env.FF_WEEKLY_MEAN_SOURCE = prev; }
}

test("mixture mean: moves the mean only, equals mixtureMean of each knotted row, leaves band-rebuilt rows alone", (t) => {
  if (!ready) return t.skip("no served artifact / store");
  const head = run("head"), mix = run("mixture");
  assert.equal(mix.length, head.length);
  const byKey = new Map(head.map((r) => [`${r.week}|${r.feat_key}`, r]));
  let moved = 0;
  for (const x of mix) {
    const c = byKey.get(`${x.week}|${x.feat_key}`)!;
    assert.ok(c, `row ${x.name} missing from the control`);
    assert.equal(x.p10, c.p10); assert.equal(x.p50, c.p50); assert.equal(x.p90, c.p90); assert.equal(x.pZero, c.pZero);
    if (c.bandUncapped || !c.knots) { assert.equal(x.mean, c.mean, `${x.name}: a band-rebuilt row was re-sourced`); continue; }
    const want = mixtureMean(c);
    // The served D49 floor still applies after the source switch.
    const floored = (c.pZero ?? 0) < 0.5 && c.p50 > 0 ? Math.max(want, c.p50) : want;
    assert.ok(Math.abs(x.mean - floored) < 1e-9, `${x.name}: mean ${x.mean} != mixture ${floored}`);
    if (Math.abs(x.mean - c.mean) > 0.5) moved++;
  }
  // POSITIVE CONTROL: the switch must actually move served means on the live week (Wilson et al.).
  assert.ok(moved > 0, "the mixture mean moved nothing -- a dead lever reads exactly like a null");
});

test("D50: the SERVED artifact carries meanSource mixture, so the serve uses it with no env switch -- and still loads (golden)", (t) => {
  if (!ready) return t.skip("no served artifact / store");
  const json = JSON.parse(readFileSync(ART, "utf8"));
  assert.equal(json.meanSource, "mixture", "data/weekly-artifact.json does not carry meanSource: mixture");
  const prev = process.env.FF_WEEKLY_MEAN_SOURCE; delete process.env.FF_WEEKLY_MEAN_SOURCE;
  try {
    const db = openDb("data/ff.db");
    try {
      const rows = loadWeeklyRows(db as never, 2026, 4);
      const served = projectWeekly({ artifact: loadWeeklyArtifact(json), rows });   // loads => golden passed
      const mix = run("mixture");
      const byKey = new Map(mix.map((r) => [`${r.week}|${r.feat_key}`, r]));
      for (const r of served) assert.equal(r.mean, byKey.get(`${r.week}|${r.feat_key}`)!.mean, `${r.name}: served mean is not the mixture mean`);
    } finally { db.close(); }
  } finally { if (prev === undefined) delete process.env.FF_WEEKLY_MEAN_SOURCE; else process.env.FF_WEEKLY_MEAN_SOURCE = prev; }
});
