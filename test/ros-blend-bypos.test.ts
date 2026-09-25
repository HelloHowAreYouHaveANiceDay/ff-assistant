/**
 * PER-POSITION ROS BLEND WEIGHT (2026-09-25). The pooled K=6 was fitted on QB/RB/WR/TE and borrowed by
 * DST, where it is worse than ignoring the season; `byPos` lets a position carry its own fit. Absent,
 * every position must get the pooled K -- that is the byte-identical guarantee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRosBlend, rosKFor, rosPerGame } from "../src/draft/rosBlend.js";

const write = (j: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), "rosblend-")), "ros-blend.json");
  writeFileSync(p, JSON.stringify(j));
  return p;
};

test("byPos: a fitted position uses its own weight, every other position the pooled K", () => {
  const { blend } = loadRosBlend(write({ K: 6, byPos: { DST: 20 } }));
  assert.equal(rosKFor(blend, "DST"), 20);
  assert.equal(rosKFor(blend, "K"), 6);
  assert.equal(rosKFor(blend, "WR"), 6);
  // What it does to a hot start: 2 weeks at 14.55 on a 6.0 line.
  const hot = rosPerGame(6, 2, 29.1, rosKFor(blend, "DST"))!;
  const pooled = rosPerGame(6, 2, 29.1, 6)!;
  assert.ok(hot < pooled, "the DST weight must shrink a hot start harder than the pooled one");
  assert.ok(Math.abs(hot - (20 * 6 + 29.1) / 22) < 1e-9);
});

test("byPos absent: every position gets the pooled K (byte-identical to before)", () => {
  const { blend } = loadRosBlend(write({ K: 6 }));
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) assert.equal(rosKFor(blend, pos), 6);
});

test("byPos: a negative or non-numeric weight is refused by name", () => {
  assert.throws(() => loadRosBlend(write({ K: 6, byPos: { DST: -1 } })), /byPos\.DST/);
  assert.throws(() => loadRosBlend(write({ K: 6, byPos: { DST: "lots" } })), /byPos\.DST/);
});
