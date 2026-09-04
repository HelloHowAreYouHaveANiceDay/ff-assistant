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
// team stockpiled them; the weighted curve should not. Thresholds sit between the two measured
// regimes (weighted mean 2.02 / old mean 3.02 over 40 seeds), not on a knife edge.
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

test("SIM COMPOSITION: the weighted curve stops our team stockpiling TEs", () => {
  const s = teStats(ourValues);
  assert.ok(s.mean <= 2.5, `mean TEs per draft should be ~2, got ${s.mean}`);
  assert.ok(s.max <= 4, `should never roster 5 TEs, got ${s.max}`);
});

// FI, permanent: the SAME assertions against an even-split value table must FAIL. This is what
// proves the guard measures the curve rather than something incidental about the data.
test("SIM COMPOSITION FAULT: the old even-split curve DOES stockpile TEs (guard is connected)", () => {
  const even = new Map(computeValues(points, DEFAULT_VALUE_LEAGUE, 2, false).map((v) => [v.name, v.value]));
  const s = teStats(even);
  assert.ok(s.mean > 2.5, `even-split should over-roster TEs (mean ${s.mean}) -- if this fails the arms no longer differ`);
});

// End-to-end version of the strategy unit test: across 20 real drafts, no K or DST ever costs > $2.
test("SIM COMPOSITION: no K/DST is ever bought above the $2 cap on the full draft path", () => {
  assert.ok(teStats(ourValues).kdst <= 2, "a K/DST cleared $2 -- the maxBid cap is not binding live");
});
