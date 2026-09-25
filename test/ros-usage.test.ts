/**
 * THE D41 USAGE CORRECTION to the rest-of-season blend (src/draft/rosBlend.ts `rosUsageAdjust`).
 *
 * The blend could not see a role change: a backup priced at 0.6 pts/g whose snap share jumped when
 * the starter got hurt stayed ~1 pt/g. These pin the guard rails and the one direction the screen
 * established for running backs (scripts/ros-usage-screen.mjs, RB slice +0.148 over the no-snap
 * recalibration, 11/13 seasons).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadRosUsage, rosUsageAdjust, type RosUsage } from "../src/draft/rosBlend.js";

const base = { pos: "RB", line: 0.6, k: 2, snap: 0.51, ts: 0.05, trend: 0.33 };

test("rosUsageAdjust: no artifact, no played week, or an unfitted position all return exactly 0", () => {
  assert.equal(rosUsageAdjust(base, null), 0);
  const fake: RosUsage = { features: ["line"], coef: { RB: [1, 1] } };
  assert.equal(rosUsageAdjust({ ...base, k: 0 }, fake), 0, "k = 0 has nothing to correct and the screen never fit it");
  assert.equal(rosUsageAdjust({ ...base, pos: "K" }, fake), 0);
  assert.equal(rosUsageAdjust(base, fake), 1 + 0.6, "the linear form is intercept + coef * feature");
});

test("RB: a backup whose snap share ROSE is priced above the same man with a flat, low share", { skip: !existsSync("data/ros-usage.json") && "no served artifact on this clone" }, () => {
  const u = loadRosUsage("data/ros-usage.json")!;
  assert.ok(u, "the served artifact did not load");
  const rising = rosUsageAdjust(base, u);
  const flat = rosUsageAdjust({ ...base, snap: 0.15, trend: 0 }, u);
  assert.ok(rising > flat + 1, `a role change was not priced: rising ${rising.toFixed(2)} vs flat ${flat.toFixed(2)}`);
});
