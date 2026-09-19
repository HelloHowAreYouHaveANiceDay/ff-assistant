/**
 * IMPORT A PUBLISHED DATASET -- the inverse of datasetExport.ts, and the place the key footgun lives.
 *
 * WHY IT EXISTS. `export-dataset` shipped; the other half did not, so every consumer wrote a bespoke
 * script (three times now) to get a release into a local store. Each one had to rediscover the same
 * hazard, and the bespoke scripts are exactly where it gets rediscovered wrong.
 *
 * THE HAZARD, STATED ONCE AND ENFORCED BELOW:
 *
 *   `player_sk` IS SNAPSHOT-LOCAL. It is a minted AUTOINCREMENT surrogate. The release's key 11775
 *   and your store's key 11775 are two different players, and an identity rebuild reassigns them --
 *   this store's own `identity_rekey` log records one rebuild moving 11,974 of 12,021 keys.
 *
 *   A straight `INSERT ... SELECT` from the release into a store that already has identities
 *   therefore attaches the release's rows to WHOEVER HOLDS THAT NUMBER LOCALLY. Every row still
 *   matches something, nothing errors, and the corruption is silent and total. That is the bug class
 *   the crosswalk commit fixed on the export side; this is the import side of the same wound.
 *
 * SO THE ONLY BRIDGE IS A STABLE ID. Every remap goes release `dim_player_key` -> a stable external
 * id (gsis, then pfr, sleeper, espn, fantasypros, mfl) -> local `player_xref` -> local `player_sk`.
 * A row whose player cannot be bridged is COUNTED and dropped or nulled by explicit choice; it is
 * never guessed at.
 *
 * TWO MODES, because they are genuinely different problems:
 *
 *   FRESH  the target has no player identities of its own. The release's keys are adopted wholesale
 *          -- they are internally consistent, and there is nothing to collide with. This is the
 *          "new clone should not have to re-pull everything" case, and it needs no bridge at all.
 *   MERGE  the target already has identities. Every `player_sk` is remapped through the bridge. Rows
 *          that cannot be bridged are reported per table rather than quietly dropped.
 *
 * AND AN ALLOWLIST ON THE WAY IN, not only on the way out. The export's allowlist protects the
 * PUBLISHER; this one protects the IMPORTER, who is running a file they did not build. A dataset
 * that happens to carry a `league` or `ownership` table -- hand-edited, or built by a fork -- must
 * not be able to write it into somebody's store. Same rule, opposite direction, and it fails CLOSED:
 * a table not on the list is skipped and named.
 */
import type { DB } from "../db/db.js";
import { PUBLISHABLE } from "./datasetExport.js";

/** The external ids the bridge will try, in order. First hit wins, and the order is a claim about
 *  reliability: gsis is nflverse's own key, mfl is the crosswalk's row key, the rest are platform
 *  ids that are stable but occasionally recycled. */
export const BRIDGE_SOURCES: { column: string; xrefSource: string }[] = [
  { column: "gsis_id", xrefSource: "gsis" },
  { column: "pfr_id", xrefSource: "pfr" },
  { column: "sleeper_id", xrefSource: "sleeper" },
  { column: "espn_id", xrefSource: "espn" },
  { column: "fantasypros_id", xrefSource: "fantasypros" },
];

export type UnmappedPolicy = "skip" | "null";

/**
 * TABLES THAT DEFINE IDENTITY, and are therefore NOT MERGEABLE.
 *
 * `player_identity` is the surrogate registry itself; `player_xref` and `stg_player` are the maps
 * that give those surrogates meaning. Importing another store's copies into a store that already has
 * its own is not a merge -- it is two registries claiming the same key space. Remapping them through
 * the bridge does not help, because the bridge is BUILT from them: you would be rewriting the map
 * using the map.
 *
 * So in MERGE mode they are refused BY NAME. In FRESH mode they are exactly what you want -- the
 * target has no identities, and adopting the release's registry wholesale is the point.
 */
export const IDENTITY_TABLES = ["player_identity", "player_xref", "stg_player"];

export interface TablePlan {
  table: string;
  srcRows: number;
  /** Rows whose player_sk bridged to a local key. Equals srcRows for tables with no player_sk. */
  mapped: number;
  /** Rows whose player was not resolvable locally. */
  unmapped: number;
  hasPlayerSk: boolean;
}

export interface ImportPlan {
  mode: "fresh" | "merge";
  tables: TablePlan[];
  /** Tables in the file that are NOT on the allowlist -- named, never imported. */
  refused: string[];
  /** Tables on the allowlist that the file does not carry. */
  absent: string[];
  /** Identity-defining tables skipped because this is a MERGE. See IDENTITY_TABLES. */
  identityRefused: string[];
  /** release player_sk -> local player_sk. Empty in fresh mode. */
  bridge: Map<string, string>;
  bridgeBy: Record<string, number>;
  unbridgeable: number;
  totalRows: number;
}

/** Does this file look like something `export-dataset` produced? */
export function assertPublishedDataset(db: DB): void {
  const has = (t: string): boolean =>
    !!(db.prepare("SELECT 1 FROM src.sqlite_master WHERE type='table' AND name = ?").get(t));
  if (!has("dim_player_key")) {
    throw new Error(
      "this file has no `dim_player_key`, so it is not a dataset `ff export-dataset` produced -- or it " +
      "predates the crosswalk. Without it there is no way to bridge its player keys to yours, and " +
      "importing on `player_sk` alone would attach its rows to the wrong players in your store.",
    );
  }
}

/** Does the TARGET already have identities of its own? Decides fresh vs merge. */
export function targetHasIdentities(db: DB): boolean {
  try {
    const r = db.prepare("SELECT COUNT(*) c FROM player_identity").get() as { c: number };
    return r.c > 0;
  } catch { return false; }             // no such table -> a fresh store
}

/**
 * BUILD THE BRIDGE: release key -> local key, via a stable id.
 *
 * `DST:<TEAM>` keys pass through unchanged and are counted separately. They are deterministic by
 * construction -- the only keys in a release that ARE safe to carry across -- so bridging them
 * through an external id would be inventing work and a failure mode.
 */
export function buildBridge(db: DB): { bridge: Map<string, string>; by: Record<string, number>; unbridgeable: number } {
  const bridge = new Map<string, string>();
  const by: Record<string, number> = { "dst-passthrough": 0 };
  let unbridgeable = 0;

  const local = db.prepare("SELECT player_sk FROM player_xref WHERE source = ? AND source_id = ?");
  const rows = db.prepare(
    `SELECT player_sk, ${BRIDGE_SOURCES.map((s) => s.column).join(", ")} FROM src.dim_player_key`,
  ).all() as Record<string, string | null>[];

  for (const r of rows) {
    const key = String(r.player_sk);
    if (key.startsWith("DST:")) { bridge.set(key, key); by["dst-passthrough"]++; continue; }
    let hit: string | null = null;
    for (const s of BRIDGE_SOURCES) {
      const id = r[s.column];
      if (!id) continue;
      const got = local.get(s.xrefSource, String(id)) as { player_sk: number } | undefined;
      if (got?.player_sk != null) {
        hit = String(got.player_sk);
        by[s.xrefSource] = (by[s.xrefSource] ?? 0) + 1;
        break;
      }
    }
    if (hit) bridge.set(key, hit); else unbridgeable++;
  }
  return { bridge, by, unbridgeable };
}

const columnsOf = (db: DB, schema: string, table: string): string[] => {
  try { return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name); }
  catch { return []; }
};

/**
 * PLAN THE IMPORT. Reads only; nothing is written.
 *
 * The caller must have ATTACHed the release as `src`. Kept that way rather than opening the file
 * here so the plan and the write run against the SAME attached database -- planning one file and
 * writing another is the two-samples mistake this repo has recorded.
 */
export function planImport(db: DB, opts: { mode?: "fresh" | "merge" } = {}): ImportPlan {
  assertPublishedDataset(db);
  const mode = opts.mode ?? (targetHasIdentities(db) ? "merge" : "fresh");

  const present = new Set(
    (db.prepare("SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((r) => r.name));

  const allowed = new Set([...PUBLISHABLE.map((p) => p.table), "dim_player_key"]);
  const refused = [...present].filter((t) => !allowed.has(t)).sort();
  const absent = [...allowed].filter((t) => !present.has(t)).sort();

  const { bridge, by, unbridgeable } = mode === "merge"
    ? buildBridge(db)
    : { bridge: new Map<string, string>(), by: {}, unbridgeable: 0 };

  const identityRefused = mode === "merge" ? IDENTITY_TABLES.filter((t) => present.has(t)) : [];

  const tables: TablePlan[] = [];
  let totalRows = 0;
  for (const t of [...present].filter((x) => allowed.has(x) && !identityRefused.includes(x)).sort()) {
    const srcRows = (db.prepare(`SELECT COUNT(*) c FROM src."${t}"`).get() as { c: number }).c;
    totalRows += srcRows;
    const hasPlayerSk = columnsOf(db, "src", t).includes("player_sk");
    let mapped = srcRows, unmapped = 0;
    if (hasPlayerSk && mode === "merge") {
      // Counted by asking the bridge, not by re-deriving the join -- the count and the write must
      // come from the same rule or the report describes an import that did not happen.
      const keys = db.prepare(`SELECT player_sk k, COUNT(*) n FROM src."${t}" GROUP BY player_sk`).all() as { k: string | null; n: number }[];
      mapped = 0; unmapped = 0;
      for (const row of keys) {
        if (row.k != null && bridge.has(String(row.k))) mapped += row.n; else unmapped += row.n;
      }
    }
    tables.push({ table: t, srcRows, mapped, unmapped, hasPlayerSk });
  }

  return { mode, tables, refused, absent, identityRefused, bridge, bridgeBy: by, unbridgeable, totalRows };
}

export interface ImportResult { written: Record<string, number>; dropped: Record<string, number> }

/**
 * APPLY THE PLAN. Requires a WRITABLE target.
 *
 * Wrapped in ONE transaction: a half-imported store is worse than an unimported one, because it
 * looks populated. `INSERT OR REPLACE` so re-running a release is idempotent rather than a primary
 * key error -- importing the same file twice should be a no-op, not a failure.
 */
export function writeImport(
  db: DB, plan: ImportPlan, opts: { onUnmapped?: UnmappedPolicy } = {},
): ImportResult {
  const onUnmapped = opts.onUnmapped ?? "skip";
  const written: Record<string, number> = {};
  const dropped: Record<string, number> = {};

  const run = db.transaction(() => {
    for (const t of plan.tables) {
      const cols = columnsOf(db, "src", t.table).filter((c) => columnsOf(db, "main", t.table).includes(c));
      if (!cols.length) { dropped[t.table] = t.srcRows; continue; }
      const quoted = cols.map((c) => `"${c}"`).join(", ");

      if (!t.hasPlayerSk || plan.mode === "fresh") {
        // No key to remap: a straight copy is CORRECT here, and only here.
        const r = db.prepare(`INSERT OR REPLACE INTO main."${t.table}" (${quoted}) SELECT ${quoted} FROM src."${t.table}"`).run();
        written[t.table] = r.changes;
        continue;
      }

      // MERGE + player_sk: every row goes through the bridge, one at a time. Slower than a set-based
      // copy and deliberately so -- the set-based version is the silent-corruption bug.
      const ins = db.prepare(`INSERT OR REPLACE INTO main."${t.table}" (${quoted}) VALUES (${cols.map(() => "?").join(", ")})`);
      const sel = db.prepare(`SELECT ${quoted} FROM src."${t.table}"`);
      let w = 0, d = 0;
      for (const row of sel.iterate() as Iterable<Record<string, unknown>>) {
        const src = row.player_sk == null ? null : String(row.player_sk);
        const local = src == null ? null : plan.bridge.get(src) ?? null;
        if (local == null) {
          if (onUnmapped === "skip") { d++; continue; }
          row.player_sk = null;                 // kept, but honestly unkeyed
        } else {
          row.player_sk = local;
        }
        ins.run(cols.map((c) => row[c] as never));
        w++;
      }
      written[t.table] = w; dropped[t.table] = d;
    }
  });
  run();
  return { written, dropped };
}
