// THE MODEL PAGE'S GRAPH IS THE REGISTRY, NOT A CURATED LIST OF BOXES -- and this proves it.
//
// The graph was a hardcoded MODEL_NODES/MODEL_EDGES pair in app/renderer/app.js, and it went stale
// the way every hand-maintained enumeration does: it drew age-curve and opportunity as live feeders
// of the projection for months after Phase 2b retired them, and had no box for the seven models
// added since. Now src/lineage/modelGraph.ts GENERATES one node per registered model, so a new model
// gets a box with no renderer change. The two assertions that keep the CURATED half (the edges)
// honest are:
//
//   1. ANTI-ROT: every generated model/rejected node is named by at least one edge. A model added to
//      the registry but wired into no edge is a floating box, and this fails -- which is the whole
//      point: you cannot add a model and silently leave it off the graph. This is the guard the old
//      hardcoded list never had.
//   2. PASS-THROUGH + FAULT INJECTION: the renderer draws exactly the served nodes/edges, none
//      invented, none dropped except an edge naming a node that does not exist.
//
// Runs the REAL bytes of app/renderer/app.js -- the functions are cut out by name and evaluated --
// rather than a copy, the same way test/dag-derivation.test.ts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeModelGraph } from "../src/lineage/modelGraph.js";
import { MODELS, EVALUATED_NOT_SHIPPED } from "../src/draft/models.js";

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

interface Node { id: string; name: string; kind: string; sub: string }
interface Graph { graph: { nodes: Node[]; edges: [string, string][] } }
interface Api {
  modelGraphNodes(d: Graph): Node[];
  modelGraphEdges(d: Graph, nodes?: Node[]): [string, string][];
}

function load(): Api {
  const src = [
    extractFn(SRC, "modelGraphNodes"),
    extractFn(SRC, "modelGraphEdges"),
    "return { modelGraphNodes, modelGraphEdges };",
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(src)() as Api;
}

test("every registered model and every evaluated-not-shipped model has a node", () => {
  const { nodes } = computeModelGraph();
  const ids = new Set(nodes.map((n) => n.id));
  for (const m of MODELS) assert.ok(ids.has(m.key), `registry model "${m.key}" has no node on the model graph`);
  for (const r of EVALUATED_NOT_SHIPPED) assert.ok(ids.has(r.key), `rejected model "${r.key}" has no node on the model graph`);
});

test("ANTI-ROT: every model/rejected node is wired by at least one edge -- a new registry entry cannot be a floating box", () => {
  const { nodes, edges } = computeModelGraph();
  const named = new Set(edges.flatMap((e) => e));
  const registryIds = new Set<string>([...MODELS.map((m) => m.key), ...EVALUATED_NOT_SHIPPED.map((r) => r.key)]);
  for (const n of nodes) {
    if (!registryIds.has(n.id)) continue; // structural nodes are allowed to be curated freely
    assert.ok(named.has(n.id), `model node "${n.id}" is on the graph but named by no edge -- wire it in src/lineage/modelGraph.ts EDGES`);
  }
});

test("every edge names two real nodes -- no dangling curated edge", () => {
  const { nodes, edges } = computeModelGraph();
  const ids = new Set(nodes.map((n) => n.id));
  for (const [a, b] of edges) {
    assert.ok(ids.has(a), `edge source "${a}" is not a node`);
    assert.ok(ids.has(b), `edge target "${b}" is not a node`);
  }
});

test("a node's kind is derived from the registry status, never re-decided in the graph", () => {
  const byId = Object.fromEntries(computeModelGraph().nodes.map((n) => [n.id, n]));
  for (const m of MODELS) {
    const want = m.status === "retired" ? "retired" : m.status === "unused" ? "unused" : "model";
    assert.equal(byId[m.key].kind, want, `model "${m.key}" (status ${m.status ?? "shipped"}) drew as kind ${byId[m.key].kind}`);
  }
  // The retired pair specifically -- the exact boxes the old hardcoded graph drew as live "model"
  // feeders of the projection. If either reverts to "model", the stale topology is back.
  assert.equal(byId["age-curve"].kind, "retired");
  assert.equal(byId["opportunity"].kind, "retired");
});

test("PASS-THROUGH: the renderer draws exactly the served nodes and edges", () => {
  const api = load();
  const served = computeModelGraph();
  const d: Graph = { graph: served };
  const nodes = api.modelGraphNodes(d);
  assert.deepEqual(nodes.map((n) => n.id).sort(), served.nodes.map((n) => n.id).sort(),
    "modelGraphNodes dropped or invented a node relative to the served graph");
  const drawn = api.modelGraphEdges(d, nodes).map(([a, b]) => `${a}->${b}`).sort();
  const wanted = served.edges.map(([a, b]) => `${a}->${b}`).sort();
  assert.deepEqual(drawn, wanted, "modelGraphEdges dropped or invented an edge relative to the served graph");
});

test("FAULT INJECTION: an edge naming a node that does not exist is dropped, and ONLY that one", () => {
  const api = load();
  const d: Graph = {
    graph: {
      nodes: [{ id: "a", name: "a", kind: "source", sub: "" }, { id: "b", name: "b", kind: "model", sub: "" }],
      edges: [["a", "b"], ["a", "ghost"]],
    },
  };
  const drawn = api.modelGraphEdges(d, api.modelGraphNodes(d));
  assert.deepEqual(drawn, [["a", "b"]], "a dangling edge either leaked through or took a valid edge with it");
});
