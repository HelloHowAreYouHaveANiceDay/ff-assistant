// THE DATA PAGE'S NODE LIST IS DERIVED FROM WHAT THE ENGINE SERVES, AND THIS PROVES IT.
//
// It used to be a hand-written array, and it had fallen thirteen tables behind `data-sources`: the
// whole RAW layer and the whole EXTENSION FEATURE layer were being fetched, counted and dropped,
// because nobody had typed a node for them. A page whose job is "show what data exists" was showing
// a snapshot of what data used to exist. That is coverage-by-enumeration and it rots by
// construction: nothing fails when reality outgrows the list.
//
// So the assertions here are not "the list has the right entries" -- that is the same enumeration
// one layer up. They are:
//
//   1. EVERY asset the engine serves gets a node. Fed the engine's REAL served table list, the
//      derivation leaves nothing unplaced.
//   2. A BRAND NEW asset, never seen before, gets a node without anyone editing the renderer. This
//      is the property that makes the list self-maintaining.
//   3. FAULT INJECTION: when the derivation DOES drop something, `whUnplacedAssets` says so. A guard
//      that can only ever return "all placed" is dead code that reads exactly like a passing guard.
//
// It runs the REAL bytes of app/renderer/app.js -- the functions are cut out by name and evaluated
// -- rather than a copy pasted into the test, for the same reason test/stale-banner.test.ts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("app/renderer/app.js", "utf8");

/** Cut one top-level `function name(...) { ... }` or `const NAME = ...;` out of the source. */
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

/** Cut a top-level `const NAME = <expr>;` by matching brackets from the `=`. */
function extractConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `const ${name} not found in app/renderer/app.js`);
  let i = src.indexOf("=", start) + 1, depth = 0, seen = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") { depth++; seen = true; }
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0 && seen) return src.slice(start, i + 1);
  }
  throw new Error(`could not find the end of const ${name}`);
}

interface Node { id: string; name: string; table?: string; kind: string; sub?: string; up?: string | null }
interface Api {
  whDagNodes(tables: Record<string, unknown>): Node[];
  whUnplacedAssets(tables: Record<string, unknown>, nodes: Node[]): string[];
  whDagEdges(nodes: Node[]): [string, string][];
}

function load(): Api {
  const src = [
    extractConst(SRC, "WH_CURATED"),
    extractConst(SRC, "WH_DERIVE"),
    extractConst(SRC, "WH_EDGES"),
    extractFn(SRC, "whDagNodes"),
    extractFn(SRC, "whUnplacedAssets"),
    extractFn(SRC, "whDagEdges"),
    "return { whDagNodes, whUnplacedAssets, whDagEdges };",
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(src)() as Api;
}

/**
 * THE ENGINE'S OWN LIST, read from src/ff.ts rather than retyped.
 *
 * This is the point of the whole exercise: if the test hardcoded the table names it would be a
 * second enumeration to keep in sync, which is the defect being fixed wearing a lab coat. The names
 * are scraped out of the `data-sources` handler's TS array, so adding a table there makes this test
 * demand a node for it.
 */
function servedTables(): string[] {
  const ff = readFileSync("src/ff.ts", "utf8");
  const at = ff.indexOf('case "data-sources"');
  assert.ok(at >= 0, "the data-sources handler was not found in src/ff.ts");
  const open = ff.indexOf("const TS: [string, string][] = [", at);
  assert.ok(open >= 0, "the data-sources table registry was not found -- this test is reading the wrong thing");
  const close = ff.indexOf("\n          ];", open);
  const block = ff.slice(open, close);
  const names = [...block.matchAll(/\["([a-z_0-9]+)",\s*"/g)].map((m) => m[1]);
  assert.ok(names.length > 20, `only ${names.length} tables scraped out of the registry -- the scrape is broken`);
  return names;
}

const asTables = (names: string[]) =>
  Object.fromEntries(names.map((n) => [n, { rows: 1, updated: "2026-09-01T00:00:00Z" }]));

test("every asset the engine serves gets a node -- nothing the registry lists is dropped", () => {
  const api = load();
  const names = servedTables();
  const tables = asTables(names);
  const nodes = api.whDagNodes(tables);
  const unplaced = api.whUnplacedAssets(tables, nodes);
  assert.deepEqual(unplaced, [],
    "the engine serves these tables and the Data page draws no node for them: " + unplaced.join(", "));
  // And the layers the hand-written list had lost must actually be there now, as their own kinds
  // rather than folded into a generic bucket.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const t of ["raw_nfl_game", "raw_injury", "raw_snap_count", "raw_participation"]) {
    assert.equal(byId.get(t)?.kind, "raw", `${t} is not on the graph as a raw-layer node`);
  }
  for (const t of ["feat_player_week_context", "feat_player_season_ext", "feat_coverage"]) {
    assert.equal(byId.get(t)?.kind, "feature", `${t} is not on the graph as a feature node`);
  }
  // The curated marts keep their curated behaviour -- deriving must not have flattened them.
  assert.equal(byId.get("board")?.kind, "mart");
  assert.equal((byId.get("player") as Node & { mat?: string })?.mat, "ecr",
    "the click-to-rebuild id on a curated landing table was lost in the derivation");
});

test("a BRAND NEW asset appears without anyone editing the renderer", () => {
  const api = load();
  // A table that exists nowhere in this repo. If the node list were still enumerated it could not
  // possibly place this, which is precisely the failure mode being fixed.
  const tables = asTables([...servedTables(), "feat_player_week_model", "raw_pff_grade", "wholly_unknown_thing"]);
  const nodes = api.whDagNodes(tables);
  assert.deepEqual(api.whUnplacedAssets(tables, nodes), []);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("feat_player_week_model")?.kind, "feature");
  assert.equal(byId.get("raw_pff_grade")?.kind, "raw");
  // A name matching no rule still gets a node. Falling through to nothing would be the exact bug.
  assert.ok(byId.has("wholly_unknown_thing"),
    "a served table matching no naming rule was dropped -- an unrecognised asset must still appear");
});

test("FAULT INJECTION: when a node IS missing, whUnplacedAssets says so", () => {
  const api = load();
  const tables = asTables(servedTables());
  const nodes = api.whDagNodes(tables).filter((n) => n.table !== "raw_injury" && n.table !== "board");
  const unplaced = api.whUnplacedAssets(tables, nodes);
  assert.deepEqual(unplaced, ["board", "raw_injury"],
    "two nodes were removed and the guard did not name them -- it cannot detect the omission it " +
    "exists to detect, so its clean verdict in the test above means nothing");
  // And it must be able to return its EMPTY value against the same input with the nodes restored,
  // or it is a function that always complains.
  assert.deepEqual(api.whUnplacedAssets(tables, api.whDagNodes(tables)), []);
});

test("every derived edge names two nodes that exist, so dagre cannot be handed a dangling id", () => {
  const api = load();
  const tables = asTables(servedTables());
  const nodes = api.whDagNodes(tables);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = api.whDagEdges(nodes);
  assert.ok(edges.length > 0, "no edges were produced at all");
  for (const [a, b] of edges) {
    assert.ok(ids.has(a) && ids.has(b), `edge ${a} -> ${b} names a node that is not on the graph`);
  }
  // The raw layer must actually reach the feature layer, or the page draws two disconnected islands
  // and answers "where did this feature come from" with silence.
  assert.ok(edges.some(([a, b]) => a.startsWith("raw_") && b.startsWith("feat_")),
    "no raw -> feature edge was produced");
});
