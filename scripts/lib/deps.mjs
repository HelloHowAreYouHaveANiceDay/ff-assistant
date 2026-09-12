// PHASE 4 (A6 continuous loop): the DEPENDENCY FINGERPRINT that turns the hand-maintained
// re-measurement registry (docs/edges.md) into a MECHANICAL one.
//
// An arbiter result in data/experiments.jsonl is only true CONDITIONAL on the inputs it read: the
// history it replayed, the raw signals it priced, the stored levers, and the CODE that defines the
// backtest. When any of those shifts, the result is STALE until re-run -- exactly the rule the edges.md
// registry states in prose. This computes a single deterministic hash over that dependency set, so a
// checker can recompute it later and SEE whether it moved, instead of a human remembering to.
//
// DESIGN RULE: never UNDER-flag. It is safe to re-run a still-valid experiment (waste), catastrophic to
// trust a stale one (a wrong number in a durable record). So the manifest is deliberately BROAD -- any
// change to a file that DEFINES the draft arbiter flags every draft-arbiter experiment stale, even if
// that particular edit could not have moved the number. Over-flagging is the correct direction here.
//
// CHEAP BY CONSTRUCTION: CSVs and code are hashed by content (they are small); DB tables are versioned
// by (row count, max fetched_at) rather than a full row hash -- every ingest path upserts fetched_at
// (ON CONFLICT ... SET fetched_at=excluded.fetched_at), so a refresh always bumps it, and a checker
// that hashed 6k+ rows on every call would be too slow to run on every refresh.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- the draft-arbiter dependency manifest ----------------------------------------------------------
// Everything `ff backtest --full --no-lookahead --inflation [...]` reads or is defined by. The four
// consensus-blend experiments and the A3.1 references all live under this one manifest.
export const DRAFT_ARBITER_DEPS = {
  // Replayed history + the bot book. Content-hashed (these are modest CSV/JSON files).
  files: [
    "data/history-points.csv",   // the season point totals the projection/pool is built from
    "data/history-weekly.csv",   // weekly scoring the sim scores lineups against
    "data/managers.json",        // the bot field
  ],
  // Raw signals the arbiter can price, plus the stored levers. Versioned by (rows, max fetched_at).
  tables: [
    "raw_fftoday_proj",          // the consensus-blend signal
    "raw_nfl_draft_pick",        // rookie draft-capital pricing
  ],
  // The per-fold trained artifacts (--projection artifact). Directory content-hash (file names+sizes+mtimes).
  dirs: ["data/fold-artifacts-2b"],
  // The CODE that DEFINES the backtest. A change here can move any number, so all are in the fingerprint.
  code: [
    "src/ff.ts",                       // the backtest command + the consensus-blend lever
    "src/draft/backtest.ts",
    "src/draft/sim.ts",
    "src/draft/strategy.ts",
    "src/draft/levers.ts",
    "src/draft/values.ts",
    "src/draft/rookieModel.ts",
    "src/model/projector.ts",          // artifact-mode projection
    "src/inseason/lineup.ts",          // --full real lineup optimizer
  ],
};

function hashFile(p) {
  if (!existsSync(p)) return `MISSING:${p}`;
  return sha(readFileSync(p)).slice(0, 16);
}

// A directory's content version: sorted (name, size, mtimeMs) of its files. Catches a regenerated
// artifact set (new mtime/size) without reading every byte of every artifact.
function hashDir(p) {
  if (!existsSync(p)) return `MISSING:${p}`;
  const entries = readdirSync(p).filter((f) => !f.startsWith(".")).sort()
    .map((f) => { const st = statSync(`${p}/${f}`); return `${f}:${st.size}:${Math.round(st.mtimeMs)}`; });
  return sha(entries.join("|")).slice(0, 16);
}

// A DB table's cheap version: (row count, max fetched_at). Requires a `fetched_at` column (every raw_*
// ingest has one); falls back to a full ordered-row hash for a table without it.
function tableVersion(db, table) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.length) return `MISSING:${table}`;
    const n = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    if (cols.includes("fetched_at")) {
      const mx = db.prepare(`SELECT MAX(fetched_at) m FROM ${table}`).get().m ?? "";
      return `${n}:${mx}`;
    }
    // no freshness column -> ordered content hash (only used for small tables)
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    return `${n}:${sha(JSON.stringify(rows)).slice(0, 16)}`;
  } catch {
    return `ERR:${table}`;
  }
}

/**
 * Fingerprint the draft-arbiter dependency set. Returns { hash, parts } where parts is the per-input
 * breakdown (so a checker can show WHICH input drifted, not just that something did). Deterministic.
 * The stored levers are included via the `settings` config row when a db handle is supplied.
 */
export function fingerprintDraftArbiter(db) {
  const parts = {};
  for (const f of DRAFT_ARBITER_DEPS.files) parts[`file:${f}`] = hashFile(f);
  for (const d of DRAFT_ARBITER_DEPS.dirs) parts[`dir:${d}`] = hashDir(d);
  for (const c of DRAFT_ARBITER_DEPS.code) parts[`code:${c}`] = hashFile(c);
  if (db) {
    for (const t of DRAFT_ARBITER_DEPS.tables) parts[`table:${t}`] = tableVersion(db, t);
    try {
      const cfg = db.prepare("SELECT value FROM settings WHERE key = 'config'").get();
      parts["config:settings.config"] = cfg ? sha(String(cfg.value)).slice(0, 16) : "UNSET";
    } catch { parts["config:settings.config"] = "ERR"; }
  }
  const hash = sha(JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k]]))).slice(0, 16);
  return { hash, parts };
}
