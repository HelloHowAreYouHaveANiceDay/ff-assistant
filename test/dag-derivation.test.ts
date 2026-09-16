// THE STATUS PAGE'S LINEAGE NODES ARE THE LINEAGE JSON, NOT A CURATED LIST -- and this proves it.
//
// Phase 2d made the node LIST derived from `data-sources`' served table names, which had itself
// fallen behind by thirteen tables. A later pass finished the job: the renderer no longer knows what
// a table is FOR (no WH_CURATED/WH_DERIVE/WH_EDGES), it only renders whatever `window.mc.lineage()`
// (src/lineage/dag.ts's computeLineage()) serves. So the assertion here is not "the graph has the
// right shape" -- that would be the same enumeration one layer up -- it is that `lineageNodes` is a
// PASS-THROUGH: every node the engine served reaches the page, none invented, none dropped.
//
// WP14 (2026-09-16) CUT THE EDGES HALF WITH THE DAG CANVAS. docs/ui-audit-2026-09-16.md 5.4 cuts
// "the DAG canvas with per-asset materialize buttons" -- its rebuild button duplicated
// `ff ingest-source <id>` and the drawing needed a 48 KB vendored dagre. Status renders the same
// nodes as a FRESHNESS table instead, so `lineageEdges` and its dangling-edge fault-injection tests
// went with the drawing that consumed them. The node pass-through property still matters and is
// still tested here, because a Status page that quietly filtered assets would hide a stale one.
//
// Runs the REAL bytes of app/renderer/app.js -- the function is cut out by name and evaluated --
// rather than a copy pasted into the test, for the same reason test/stale-banner.test.ts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeLineage } from "../src/lineage/dag.js";

const SRC = readFileSync("app/renderer/app.js", "utf8");

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found in app/renderer/app.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

interface Node { id: string; kind: string; rows?: number; updated?: string | null; materialize?: string }
interface Edge { from: string; to: string; producer: string }
interface Graph { nodes: Node[]; edges: Edge[]; producers: unknown[] }

function load(): (graph: Graph) => Node[] {
  return new Function(extractFn(SRC, "lineageNodes") + "\nreturn lineageNodes;")() as (g: Graph) => Node[];
}

test("every node the engine's REAL lineage graph serves reaches the Status page", () => {
  const lineageNodes = load();
  const graph = computeLineage() as unknown as Graph; // no db -- shape only, which is all this checks
  assert.ok(graph.nodes.length > 10, "the fixture must be a real graph for the comparison to mean anything");
  assert.deepEqual(lineageNodes(graph).map((n) => n.id).sort(), graph.nodes.map((n) => n.id).sort(),
    "lineageNodes dropped or invented a node relative to the served graph");
});

test("a brand new node the engine starts serving appears with no renderer change", () => {
  const lineageNodes = load();
  const graph: Graph = {
    nodes: [{ id: "a", kind: "raw" }, { id: "b", kind: "feature" }],
    edges: [{ from: "a", to: "b", producer: "test" }],
    producers: [],
  };
  assert.deepEqual(lineageNodes(graph).map((n) => n.id), ["a", "b"]);
});

// FAULT INJECTION. A pass-through assertion is a comparison, and a comparison whose inputs never
// reach it agrees forever -- so prove the comparison can disagree.
test("FAULT INJECTION: a node missing from the served graph does not reappear on the page", () => {
  const lineageNodes = load();
  const full: Graph = {
    nodes: [{ id: "a", kind: "raw" }, { id: "b", kind: "feature" }, { id: "c", kind: "mart" }],
    edges: [], producers: [],
  };
  const withoutOne: Graph = { ...full, nodes: full.nodes.filter((n) => n.id !== "c") };
  assert.deepEqual(lineageNodes(withoutOne).map((n) => n.id), ["a", "b"],
    "the removed node reappeared -- lineageNodes is not a pass-through");
});

test("FAULT INJECTION: an absent graph yields nothing rather than throwing", () => {
  const lineageNodes = load();
  assert.deepEqual(lineageNodes(null as unknown as Graph), []);
  assert.deepEqual(lineageNodes({} as Graph), []);
});
