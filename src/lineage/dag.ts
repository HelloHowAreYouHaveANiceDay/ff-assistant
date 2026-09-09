// THE LINEAGE GRAPH, COMPUTED -- not enumerated -- from the two registries that already know what
// reads and writes what: `src/data/ingest.ts` (RAW_ASSETS + L1_ASSETS, the raw/L1 producers) and
// `src/lineage/registry.ts` (PRODUCERS, the feature builders + trainers + scorecard). Every node and
// edge on the Data page traces back to one of those declarations; there is no third list a table can
// fall out of sync with.
//
// Nodes: every table any producer reads or writes, every artifact file any producer or the model
// registry (`src/draft/models.ts`) writes, and one node per external source id a producer reads
// (`src_*`, matching the ids the Data page's curated source nodes already use).
//
// Edges: producer.reads -> producer.writes, for every producer (a raw/L1 asset, a feature builder, a
// trainer, or the scorecard). An external source is just another `reads` entry, so `src_fp -> player`
// falls out of the same rule as `stg_player -> board` -- no special-cased "source" edge type.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RAW_ASSETS, L1_ASSETS } from "../data/ingest.js";
import { PRODUCERS } from "./registry.js";
import { MODELS } from "../draft/models.js";
import type { DB } from "../db/db.js";

/** Every table name `CREATE TABLE IF NOT EXISTS <name>` declares in the schema -- the ground truth
 *  for "is this a real base table", used by `danglingReads` to tell a genuine schema table (e.g.
 *  `league`, seeded outside any declared producer) from a producer's typo. Read from the file rather
 *  than a retyped list, for the same reason the rest of this module reads registries instead of
 *  enumerating. */
export function schemaTables(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "db", "schema.sql"), "utf8");
  const names = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_0-9]+)/g)].map((m) => m[1]);
  return new Set(names);
}

export type LineageKind = "external" | "raw" | "staging" | "feature" | "identity" | "consumer" | "model" | "scorecard" | "table" | "artifact" | "mart";

export interface LineageNode {
  id: string;
  kind: LineageKind;
  /** Present only for a real SQLite table. */
  rows?: number;
  updated?: string | null;
  /** Present only for a model artifact file (from MODELS/modelStatus). */
  fittedAt?: string | null;
  seasons?: string | null;
}
export interface LineageEdge { from: string; to: string; producer: string }

export interface LineageProducerDecl { id: string; reads: string[]; writes: string[] }

/** All declared producers, pulled from both registries into one shape. Exported so tests (and the
 *  `ff lineage` / `lineage` serve method) work from the SAME list this module derives the graph from. */
export function allProducers(): LineageProducerDecl[] {
  const out: LineageProducerDecl[] = [];
  for (const a of RAW_ASSETS) out.push({ id: `ingest-source ${a.id}`, reads: a.reads, writes: a.writes });
  for (const a of L1_ASSETS) out.push({ id: `ingest-source ${a.id}`, reads: a.reads, writes: a.writes });
  for (const p of PRODUCERS) out.push({ id: p.id, reads: p.reads, writes: p.writes });
  return out;
}

const isExternal = (id: string) => id.startsWith("src_");
const isArtifact = (id: string) => /\.json$|\.csv$/.test(id);

function kindFor(id: string, writtenBy: Set<string>, readBy: Set<string>): LineageKind {
  if (isExternal(id)) return "external";
  if (isArtifact(id)) return "artifact";
  if (id.startsWith("raw_")) return "raw";
  if (id.startsWith("scorecard_")) return "scorecard";
  if (id.startsWith("feat_")) return "feature";
  if (id.startsWith("stg_")) return "staging";
  if (id.startsWith("player_") || id === "player") return "identity";
  if (id === "board" || id === "player_value" || id === "player_value_position") return "mart";
  if (!writtenBy.size && readBy.size) return "consumer";
  return "table";
}

/** Freshness column candidates, in the order the existing `data-sources` serve method tries them
 *  (see src/ff.ts `case "data-sources"`). Not every table has one; a table with none just gets a
 *  row count. */
const FRESH_COLS = ["updated_at", "fetched_at", "scraped", "created_at", "scored_at", "as_of"];

function tableStats(db: DB, table: string): { rows: number; updated: string | null } | null {
  for (const col of [null, ...FRESH_COLS]) {
    try {
      const sql = col
        ? `SELECT count(*) c, max(${col}) u FROM ${table}`
        : `SELECT count(*) c FROM ${table}`;
      const r = db.prepare(sql).get() as { c: number; u?: string | null };
      return { rows: r.c, updated: r.u ?? null };
    } catch { /* try the next column, or fall through to "table does not exist" */ }
  }
  return null;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  producers: LineageProducerDecl[];
}

/** THE DERIVATION. `db` is optional so the graph's SHAPE (nodes + edges) can be computed and tested
 *  without a store -- freshness/row counts are simply omitted when it is absent. */
export function computeLineage(db?: DB): LineageGraph {
  const producers = allProducers();
  const writtenBy = new Map<string, Set<string>>();
  const readBy = new Map<string, Set<string>>();
  const allIds = new Set<string>();
  for (const p of producers) {
    for (const r of p.reads) { allIds.add(r); (readBy.get(r) ?? readBy.set(r, new Set()).get(r)!).add(p.id); }
    for (const w of p.writes) { allIds.add(w); (writtenBy.get(w) ?? writtenBy.set(w, new Set()).get(w)!).add(p.id); }
  }
  // Every model artifact is a node too, even one no producer above declares writing (a python trainer
  // not yet in PRODUCERS, or a retired file kept for the record) -- the model registry is itself a
  // source of truth for "this artifact exists", and the Model page's job is exactly to show it.
  for (const m of MODELS) allIds.add(m.file);

  const nodes: LineageNode[] = [];
  for (const id of [...allIds].sort()) {
    const node: LineageNode = { id, kind: kindFor(id, writtenBy.get(id) ?? new Set(), readBy.get(id) ?? new Set()) };
    if (db && node.kind !== "external" && node.kind !== "artifact") {
      const stats = tableStats(db, id);
      if (stats) { node.rows = stats.rows; node.updated = stats.updated; }
    }
    nodes.push(node);
  }

  const edges: LineageEdge[] = [];
  for (const p of producers) {
    const writeSet = new Set(p.writes);
    for (const r of p.reads) {
      // A read that is ALSO one of this producer's own writes is the producer maintaining
      // consistency across its own tables in one pass (e.g. `assemble` reads and rewrites both
      // player_value and player_value_position together) -- not a cross-producer dependency, and
      // drawing it as one creates a same-producer cycle out of tables that are written simultaneously
      // rather than in sequence.
      if (writeSet.has(r)) continue;
      for (const w of p.writes) edges.push({ from: r, to: w, producer: p.id });
    }
  }

  return { nodes, edges, producers };
}

/** Every table the given served-table list names that this graph produces no node for. Empty is the
 *  contract; a non-empty result is the exact failure Phase 2d already fixed once for the hand-written
 *  Data-page list -- this is the same guard one layer down, at the registry that now feeds it. */
export function unplacedServedTables(servedTables: string[], graph: LineageGraph): string[] {
  const placed = new Set(graph.nodes.map((n) => n.id));
  return servedTables.filter((t) => !placed.has(t)).sort();
}

/** Every table a producer declares reading that is neither produced by another declared producer nor
 *  a real table in the schema (passed in as `knownTables`) nor an external source id. This is the
 *  fault-injection target for "a producer that reads a table nobody writes": add a bad declaration
 *  and this must name it. */
export function danglingReads(graph: LineageGraph, knownTables: Set<string>): string[] {
  const writes = new Set(graph.edges.map((e) => e.to));
  const bad = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === "external" || n.kind === "artifact") continue;
    if (writes.has(n.id)) continue;         // something writes it -- fine
    if (knownTables.has(n.id)) continue;    // a real base table (e.g. `league`, seeded outside a producer)
    bad.add(n.id);
  }
  return [...bad].sort();
}

/** True if the reads/writes graph has a cycle (Kahn's algorithm). A lineage DAG that is not acyclic
 *  cannot be topologically drawn and means some producer declared writing a table it also reads
 *  from a DIFFERENT producer's output in a loop. */
export function hasCycle(graph: LineageGraph): boolean {
  const adj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) { adj.set(n.id, new Set()); indeg.set(n.id, 0); }
  for (const e of graph.edges) {
    if (e.from === e.to) continue; // a producer reading and rewriting its own table is not a cycle here
    if (!adj.get(e.from)!.has(e.to)) { adj.get(e.from)!.add(e.to); indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1); }
  }
  const q = [...graph.nodes.map((n) => n.id)].filter((id) => (indeg.get(id) ?? 0) === 0);
  let seen = 0;
  while (q.length) {
    const id = q.pop()!;
    seen++;
    for (const nx of adj.get(id) ?? []) {
      indeg.set(nx, (indeg.get(nx) ?? 0) - 1);
      if (indeg.get(nx) === 0) q.push(nx);
    }
  }
  return seen !== graph.nodes.length;
}
