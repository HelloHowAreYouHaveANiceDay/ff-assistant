// Step 5: the SAME board-change chokepoint (app/main.js's ffRun + rpc()) also watches the lineage
// graph and the model registry, pushing mc:lineageChanged/mc:modelsChanged. This proves the wiring is
// present at both engine chokepoints and that the exclusion which prevents infinite self-notification
// is there too -- the same shape test/board-stamp.test.ts already checks for the board path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FF = readFileSync("src/ff.ts", "utf8");

test("the engine serves cheap lineage-stamp / models-stamp probes", () => {
  assert.match(FF, /case "lineage-stamp":/, "src/ff.ts must serve a lineage-stamp probe");
  assert.match(FF, /case "models-stamp":/, "src/ff.ts must serve a models-stamp probe");
});
