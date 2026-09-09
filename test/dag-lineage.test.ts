// THE LINEAGE GRAPH IS COMPUTED FROM TWO REGISTRIES, NOT ENUMERATED -- this proves it stays
// consistent with the schema and with itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineage, unplacedServedTables, danglingReads, hasCycle, schemaTables, allProducers, type LineageGraph, type LineageProducerDecl } from "../src/lineage/dag.js";

test("every declared producer's reads/writes land as nodes, and the graph has no dangling read", () => {
  const graph = computeLineage();
  assert.ok(graph.nodes.length > 20, "too few nodes -- the registries did not load");
  const known = schemaTables();
  const bad = danglingReads(graph, known);
  assert.deepEqual(bad, [], `producer(s) read a table nobody writes and that is not in the schema: ${bad.join(", ")}`);
});

test("the graph is acyclic", () => {
  const graph = computeLineage();
  assert.equal(hasCycle(graph), false, "the lineage graph has a cycle -- some producer's writes feed back into its own reads");
});

test("every table this repo's schema declares that a producer touches is a real schema table", () => {
  const graph = computeLineage();
  const known = schemaTables();
  for (const n of graph.nodes) {
    if (n.kind === "external" || n.kind === "artifact") continue;
    assert.ok(known.has(n.id), `lineage node ${n.id} (${n.kind}) is not a table in src/db/schema.sql`);
  }
});

test("FAULT INJECTION: a producer that reads a table nobody writes and is not in the schema is named", () => {
  const graph = computeLineage();
  const injected: LineageGraph = {
    ...graph,
    nodes: [...graph.nodes, { id: "totally_made_up_table", kind: "table" }],
    edges: [...graph.edges, { from: "totally_made_up_table", to: "board", producer: "fault-injection" }],
  };
  const bad = danglingReads(injected, schemaTables());
  assert.ok(bad.includes("totally_made_up_table"), "the guard did not name the injected dangling read");
  // and it must return clean on the REAL graph, or it is a function that always complains
  assert.deepEqual(danglingReads(graph, schemaTables()), []);
});

test("FAULT INJECTION: unplacedServedTables names a served table the graph drops", () => {
  const graph = computeLineage();
  const served = [...graph.nodes.filter((n) => n.kind !== "external" && n.kind !== "artifact").map((n) => n.id), "some_table_the_graph_never_heard_of"];
  const unplaced = unplacedServedTables(served, graph);
  assert.deepEqual(unplaced, ["some_table_the_graph_never_heard_of"]);
  assert.deepEqual(unplacedServedTables(served.slice(0, -1), graph), []);
});

test("allProducers returns both registries' declarations, non-empty on each side", () => {
  const producers = allProducers();
  const ids = producers.map((p: LineageProducerDecl) => p.id);
  assert.ok(ids.some((i) => i.startsWith("ingest-source")), "no ingest.ts producers made it into the graph");
  assert.ok(ids.includes("assemble"), "no src/lineage/registry.ts producers made it into the graph");
});
