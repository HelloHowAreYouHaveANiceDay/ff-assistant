// Roster-composition guards on the FULL sim path (draftFieldSeats), on the real data files.
// These lock in finding #1: the agent must not stockpile bench K/DST. Removing the bench-K/DST
// guard in strategy.ts makes the "exactly 2" assertion fail (>2 K/DST) -- the fault-injection lever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const readCsv = (p: string) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map<string, number>();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));

// The live default bidding dials (cmdAutoDraft / DEFAULT_LEVERS): reserve 15 / maxShare 0.35 /
// premium 2 / maxKDst 2. Re-verified under the weighted-FLEX curve on 2026-09-03 (docs/validation.md
// 3x3 sweep); an earlier comment here said reserve 20, which stopped being the live default when a
// live mock showed reserve 20 strands budget once the room pays > $20/starter.
const cfg = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2 };

test("SIM COMPOSITION: our team drafts EXACTLY 2 K/DST across 20 seeds (no bench K/DST)", () => {
  const counts: number[] = [];
  for (let s = 1; s <= 20; s++) {
    const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE);
    counts.push(picks.filter((p) => p.team === 0 && (p.pos === "K" || p.pos === "DST")).length);
  }
  assert.ok(counts.every((c) => c === 2), `expected exactly 2 K/DST every seed, got ${counts.join(" ")}`);
});

// Step 9c (offline half): "the agent no longer chases mid-TEs", measured on the REAL 2026 data
// through the full sim draft path. The even-split curve gave TE 11 phantom starting slots, so our
// team stockpiled them; the weighted curve should not.
//
// THE ABSOLUTE THRESHOLD WENT STALE AND IS NOT BEING WIDENED IN PLACE (2026-09-08, Phase 2b).
// It was `mean <= 2.5`, chosen to sit between two measured regimes (weighted 2.02 / even-split
// 3.02). Shipping the trained projection artifact moved BOTH regimes up together -- weighted 2.9,
// even-split 3.5 -- because the elite RB tier came down ~18% (which is exactly what the residual
// slices said it should: an RB entering top-6 finished 35 points under his projection) and TE is
// therefore relatively dearer. A constant calibrated against one build's output cannot tell that
// apart from a broken curve; this is the same failure the top-TE dollar ceiling in
// scripts/value-gates.mjs already had, and it was fixed there the same way.
//
// So the guard is re-keyed on the RELATIVE claim it was always really making -- the weighted curve
// rosters FEWER tight ends than the even split -- which is scale-free and which the broken case is
// structurally incapable of satisfying. The absolute ceiling stays, loosened to a level that still
// catches a runaway (a full bench of tight ends) rather than one that encodes a build.
//
// THE ABSOLUTE SHIFT IS A REPORTED FINDING, not a suppressed one: see docs/validation.md.
import { computeValues, DEFAULT_VALUE_LEAGUE } from "../src/draft/values.ts";

const teStats = (vals: Map<string, number>) => {
  const counts: number[] = [], kdstMax: number[] = [];
  const c = { ...cfg, values: Object.fromEntries(vals) };
  for (let s = 1; s <= 20; s++) {
    const { picks } = draftFieldSeats(points, vals, c, s, SIM_LEAGUE);
    const mine = picks.filter((p) => p.team === 0);
    counts.push(mine.filter((p) => p.pos === "TE").length);
    kdstMax.push(Math.max(0, ...mine.filter((p) => p.pos === "K" || p.pos === "DST").map((p) => p.price)));
  }
  return { mean: counts.reduce((a, b) => a + b, 0) / counts.length, max: Math.max(...counts), kdst: Math.max(...kdstMax) };
};

const evenValues = () => new Map(computeValues(points, DEFAULT_VALUE_LEAGUE, 2, false).map((v) => [v.name, v.value]));

test("SIM COMPOSITION: the weighted curve rosters FEWER TEs than the even split", () => {
  const w = teStats(ourValues), e = teStats(evenValues());
  // The claim, stated as a comparison between the two curves on identical seeds and identical
  // projections, so a projection-level shift moves both sides and cannot fake a pass.
  assert.ok(w.mean < e.mean - 0.3,
    `weighted mean ${w.mean} vs even-split ${e.mean} -- the weighted curve must visibly reduce TE ` +
    `stockpiling. If these have converged, the phantom-FLEX-slot fix has stopped mattering.`);
  // A LOOSE absolute ceiling: half the roster in tight ends is a runaway whatever the projection
  // says. Deliberately not a tight number -- a tight one encodes one build's output and goes stale.
  assert.ok(w.mean <= 3.5, `mean TEs per draft ${w.mean} is a runaway, not a preference`);
  assert.ok(w.max <= 5, `rostered ${w.max} TEs on a single seed`);
});

// FI, permanent: the same comparison must be able to FAIL. Running the even-split table through the
// shipped side of the assertion is what proves the guard measures the curve rather than something
// incidental about the data.
test("SIM COMPOSITION FAULT: the even split DOES stockpile more TEs (guard is connected)", () => {
  const e = teStats(evenValues()), w = teStats(ourValues);
  assert.ok(!(e.mean < w.mean - 0.3),
    `swapping the arms must not also pass -- even-split ${e.mean}, weighted ${w.mean}`);
  assert.ok(e.mean > w.mean, `even-split should over-roster TEs (${e.mean} vs ${w.mean})`);
});

// End-to-end version of the strategy unit test: across 20 real drafts, no K or DST ever costs > $2.
test("SIM COMPOSITION: no K/DST is ever bought above the $2 cap on the full draft path", () => {
  assert.ok(teStats(ourValues).kdst <= 2, "a K/DST cleared $2 -- the maxBid cap is not binding live");
});
