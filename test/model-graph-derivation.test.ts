// THE MODEL GRAPH IS THE REGISTRY, NOT A CURATED LIST OF BOXES -- and this proves it.
//
// WP14 (2026-09-16) REMOVED THE RENDERER HALF. The Model page and its dagre canvas are cut
// (docs/ui-audit-2026-09-16.md 5.4: the graph, the fitted-models table and the value trace are
// `ff model-page --json` and docs/validation.md, and three of its sections had been rendering as
// empty headers for days), so `modelGraphNodes`/`modelGraphEdges` no longer exist in app.js and the
// two pass-through/fault-injection tests that drove them went with the drawing they protected.
// EVERYTHING BELOW IS THE ENGINE HALF AND IT ALL STAYS -- the anti-rot guard in particular, which is
// what stops a newly registered model from being a floating box, and which the old hardcoded list
// never had.
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
//   2. Every curated edge names two real nodes, and every node's kind is derived from the registry
//      status rather than re-decided in the graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeModelGraph } from "../src/lineage/modelGraph.js";
import { MODELS, EVALUATED_NOT_SHIPPED } from "../src/draft/models.js";

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
