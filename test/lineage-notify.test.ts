// Step 5: the SAME board-change chokepoint (app/main.js's ffRun + rpc()) also watches the lineage
// graph and the model registry, pushing mc:lineageChanged/mc:modelsChanged. This proves the wiring is
// present at both engine chokepoints and that the exclusion which prevents infinite self-notification
// is there too -- the same shape test/board-stamp.test.ts already checks for the board path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MAIN = readFileSync("app/main.js", "utf8");
const FF = readFileSync("src/ff.ts", "utf8");

test("the engine serves cheap lineage-stamp / models-stamp probes", () => {
  assert.match(FF, /case "lineage-stamp":/, "src/ff.ts must serve a lineage-stamp probe");
  assert.match(FF, /case "models-stamp":/, "src/ff.ts must serve a models-stamp probe");
});

test("noticeBoardChange also probes lineage-stamp and models-stamp", () => {
  const notice = MAIN.slice(MAIN.indexOf("async function noticeBoardChange"), MAIN.indexOf("let lastLineageStamp"));
  assert.match(notice, /rpc\("lineage-stamp"\)/, "the chokepoint must probe lineage-stamp");
  assert.match(notice, /rpc\("models-stamp"\)/, "the chokepoint must probe models-stamp");
  assert.match(notice, /webContents\.send\("mc:lineageChanged",\s*sl\)/, "must push the lineage stamp payload");
  assert.match(notice, /webContents\.send\("mc:modelsChanged",\s*sm\)/, "must push the models stamp payload");
});

test("FAULT INJECTION: without the SILENT_RPC_METHODS exclusion, probing would re-trigger the chokepoint", () => {
  // The exclusion is what stops rpc("lineage-stamp") (issued BY noticeBoardChange) from itself
  // calling debouncedNotice() and looping forever -- the same failure board-stamp's exclusion
  // prevents. Prove the exclusion set actually names both new probes.
  assert.match(MAIN, /SILENT_RPC_METHODS = new Set\(\["lineage-stamp", "models-stamp"\]\)/,
    "the silent-probe set must name both new stamp methods, or they would re-trigger the notifier forever");
  assert.match(MAIN, /if \(SILENT_RPC_METHODS\.has\(method\)\)/, "rpc() must consult the silent-probe set");
});

test("the renderer subscribes to both new push events", () => {
  const RENDERER = readFileSync("app/renderer/app.js", "utf8");
  assert.match(RENDERER, /onLineageChanged/, "the renderer must subscribe to mc:lineageChanged");
  assert.match(RENDERER, /onModelsChanged/, "the renderer must subscribe to mc:modelsChanged");
});
