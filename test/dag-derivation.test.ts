// THE DATA PAGE'S NODES AND EDGES ARE THE LINEAGE JSON, NOT A CURATED LIST -- and this proves it.
//
// Phase 2d made the node LIST derived from `data-sources`' served table names, which had itself
// fallen behind by thirteen tables. This pass finished the job: the renderer no longer knows what a
// table is FOR (no WH_CURATED/WH_DERIVE/WH_EDGES), it only lays out whatever `window.mc.lineage()`
// (src/lineage/dag.ts's computeLineage()) serves. So the assertion here is not "the graph has the
// right shape" -- that would be the same enumeration one layer up -- it is:
//
//   1. `lineageNodes`/`lineageEdges` are PASS-THROUGHS: every node and every edge the engine served
//      reaches the drawing code, none invented, none dropped.
//   2. FAULT INJECTION: a served edge that this file's own logic would have to filter (a dangling
//      one) is dropped and ONLY that one; an edge deliberately removed from a fixture before it ever
//      reaches the renderer does not reappear.
//
// Runs the REAL bytes of app/renderer/app.js -- the functions are cut out by name and evaluated --
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
interface Api {
  lineageNodes(graph: Graph): Node[];
  lineageEdges(graph: Graph, nodes?: Node[]): [string, string][];
}

function load(): Api {
  const src = [
    extractFn(SRC, "lineageNodes"),
    extractFn(SRC, "lineageEdges"),
    "return { lineageNodes, lineageEdges };",
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(src)() as Api;
}

test("every node and edge the engine's REAL lineage graph serves reaches the Data page's drawing code", () => {
  const api = load();
  const graph = computeLineage() as unknown as Graph; // no db -- shape only, which is all this checks
  const nodes = api.lineageNodes(graph);
  assert.deepEqual(nodes.map((n) => n.id).sort(), graph.nodes.map((n) => n.id).sort(),
    "lineageNodes dropped or invented a node relative to the served graph");
  const edges = api.lineageEdges(graph, nodes);
  const served = graph.edges.map((e) => `${e.from}->${e.to}`).sort();
  const drawn = edges.map(([a, b]) => `${a}->${b}`).sort();
  assert.deepEqual(drawn, served, "lineageEdges dropped or invented an edge relative to the served graph");
});

test("a brand new node/edge pair the engine starts serving appears with no renderer change", () => {
  const api = load();
  const graph: Graph = {
    nodes: [{ id: "a", kind: "raw" }, { id: "b", kind: "feature" }],
    edges: [{ from: "a", to: "b", producer: "test" }],
    producers: [],
  };
  const nodes = api.lineageNodes(graph);
  assert.deepEqual(nodes.map((n) => n.id), ["a", "b"]);
  assert.deepEqual(api.lineageEdges(graph, nodes), [["a", "b"]]);
});

test("FAULT INJECTION: an edge removed from the served graph before it reaches the renderer does not reappear", () => {
  const api = load();
  const full: Graph = {
    nodes: [{ id: "a", kind: "raw" }, { id: "b", kind: "feature" }, { id: "c", kind: "mart" }],
    edges: [{ from: "a", to: "b", producer: "p1" }, { from: "b", to: "c", producer: "p2" }],
    producers: [],
  };
  const withoutOne: Graph = { ...full, edges: full.edges.filter((e) => e.to !== "c") };
  const drawn = api.lineageEdges(withoutOne, api.lineageNodes(withoutOne));
  assert.deepEqual(drawn, [["a", "b"]], "the removed b->c edge reappeared -- lineageEdges is not a pass-through");
});

test("FAULT INJECTION: an edge naming a node that does not exist is dropped, and ONLY that one", () => {
  const api = load();
  const graph: Graph = {
    nodes: [{ id: "a", kind: "raw" }, { id: "b", kind: "feature" }],
    edges: [{ from: "a", to: "b", producer: "p1" }, { from: "a", to: "nonexistent", producer: "bad" }],
    producers: [],
  };
  const nodes = api.lineageNodes(graph);
  const drawn = api.lineageEdges(graph, nodes);
  assert.deepEqual(drawn, [["a", "b"]], "a dangling edge either leaked through or took a valid edge with it");
});
