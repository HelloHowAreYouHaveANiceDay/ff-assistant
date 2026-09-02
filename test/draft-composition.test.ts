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

// The live default bidding dials (cmdAutoDraft): reserve 5 / maxShare 0.6 / premium 2.
const cfg = { values: Object.fromEntries(ourValues), starterReserve: 5, benchReserve: 1, premium: 2, maxShare: 0.6 };

test("SIM COMPOSITION: our team drafts EXACTLY 2 K/DST across 20 seeds (no bench K/DST)", () => {
  const counts: number[] = [];
  for (let s = 1; s <= 20; s++) {
    const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE);
    counts.push(picks.filter((p) => p.team === 0 && (p.pos === "K" || p.pos === "DST")).length);
  }
  assert.ok(counts.every((c) => c === 2), `expected exactly 2 K/DST every seed, got ${counts.join(" ")}`);
});
