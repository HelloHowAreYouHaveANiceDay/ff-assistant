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

// The frozen list of real schema tables this pipeline deliberately does NOT describe: live league
// state (draft/roster/matchup/ownership), identity-resolution caches, and operational logs. None of
// these is a feature/model producer's input or output -- they are written by draft-day/live-league
// code paths this Data page was never meant to draw. Every entry here was checked by hand (Integration
// pass 5) against `git grep 'INSERT INTO <table>'` to confirm it really is one of those, not a
// Programme-3 table someone forgot to register.
const OUT_OF_SCOPE_TABLES = new Set([
  "action_log", "draft", "draft_state", "fact_matchup", "identity_rekey",
  "my_roster", "ownership", "player_ids", "player_ids_variant", "settings",
  // ingest_audit is a cross-cutting VALIDATION log written by every source after it writes its data
  // (src/data/validatedIngest.ts), not a data node any producer reads -- an operational log like
  // action_log, not a feature/model table.
  "ingest_audit",
]);

test("every served table has a producer or is external -- every real schema table not on the frozen out-of-scope list is a node the graph produces", () => {
  const graph = computeLineage();
  const known = schemaTables();
  const missing = unplacedServedTables([...known].filter((t) => !OUT_OF_SCOPE_TABLES.has(t)), graph);
  assert.deepEqual(missing, [],
    `schema table(s) with no declared producer and not on the out-of-scope list -- declare a ` +
    `producer for these (never widen the exclusion list to silence this): ${missing.join(", ")}`);
});

test("FAULT INJECTION: the out-of-scope list is doing real work, not silencing a clean check by accident", () => {
  const graph = computeLineage();
  const known = schemaTables();
  // Remove one real exclusion (`my_roster`) and confirm the guard actually names it -- proving the
  // exclusion list is load-bearing, not a no-op next to an already-empty result.
  const withoutOneExclusion = new Set(OUT_OF_SCOPE_TABLES);
  withoutOneExclusion.delete("my_roster");
  const missing = unplacedServedTables([...known].filter((t) => !withoutOneExclusion.has(t)), graph);
  assert.ok(missing.includes("my_roster"), "removing 'my_roster' from the exclusion list did not surface it as missing a producer");
});
