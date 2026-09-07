// The single local store. better-sqlite3 (synchronous, WAL). One writer at a time; readers
// never block. Every consumer -- the engine, the app main, the ingesters -- opens the same file.
// The agent reaches it through a SQLite MCP server (later); everyone else opens directly.
import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey } from "../draft/values.js";
import { DEFAULT_SCORING, type ScoringRules } from "../draft/scoring.js";
import { DEFAULT_LEVERS, type Levers } from "../draft/levers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = process.env.FF_DB ?? "data/ff.db";

export type DB = Database.Database;

/** Open (creating if needed) the store, set WAL, and apply the idempotent schema. */
export function openDb(path: string = DEFAULT_DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  if (!getSetting(db, "config")) setSetting(db, "config", JSON.stringify(DEFAULT_CONFIG)); // seed the single config
  if (!db.prepare(`SELECT 1 FROM draft WHERE draft_id = 'local'`).get()) {          // seed the app's working draft session
    db.prepare(`INSERT INTO draft (draft_id, kind, season, status, started_at, updated_at) VALUES ('local', 'local', ?, 'active', ?, ?)`)
      .run(DEFAULT_CONFIG.season, nowIso(), nowIso());
  }
  return db;
}

/** Apply schema.sql. CREATE ... IF NOT EXISTS throughout, so re-running is a no-op. */
export function migrate(db: DB): void {
  db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
  addColumns(db);
}

/**
 * Additive column migrations.
 *
 * schema.sql is `CREATE TABLE IF NOT EXISTS` throughout, which means a new column added there
 * reaches a FRESH store and never an existing one -- the table already exists, so the statement is
 * skipped in silence and the column is simply absent. Every query naming it then fails at runtime on
 * exactly the machines that have real data. So a new column needs an explicit ALTER as well, and
 * this is the one place they live.
 *
 * Idempotent by inspection rather than by catching an error, because `duplicate column name` and a
 * genuinely malformed ALTER both arrive as the same exception type and swallowing one hides the
 * other.
 */
function addColumns(db: DB): void {
  const WANT: [string, string, string][] = [
    // ESPN's numeric team id. ownership stored only the manager's display name and abbrev, so
    // nothing in the store could answer "which of these sixteen rosters is MINE" -- league.team_id
    // holds the number and there was no column to join it to.
    ["ownership", "team_id", "TEXT"],
  ];
  for (const [table, col, type] of WANT) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.length) continue;                       // table not created yet; schema.sql owns that
    if (cols.some((c) => c.name === col)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

/** ISO-8601 UTC timestamp -- the store's timestamp convention (spec-data-model). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Upsert a settings row. */
export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

// --- app config (the single source for budget/slots/flex_ok/season), stored as one settings JSON ---
export const DEFAULT_CONFIG = {
  season: 2026, budget: 200, teams: 16,
  slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
  flex_ok: ["RB", "WR", "TE"],
  playoffTeams: 6,   // seeds into the backtest bracket (league_sync sets the real count)
  regWeeks: 14,      // fantasy regular-season length before playoffs
  scoring: "HALF", // STD | HALF | PPR -- selects the Boris/ADP/market consensus VARIANT
  // the actual per-stat scoring model that tailors OUR points/values (populated by league_sync)
  scoring_rules: DEFAULT_SCORING as ScoringRules,
  // tunable knobs (tiers, K/DST cap, bidding, sleeper cutoff) -- visible + assistant-writable
  levers: DEFAULT_LEVERS as Levers,
};
export type AppConfig = typeof DEFAULT_CONFIG;
export function getConfig(db: DB): AppConfig {
  const raw = getSetting(db, "config");
  if (raw) {
    try {
      const s = JSON.parse(raw);
      // deep-merge the nested knob objects so a partial stored value never drops keys
      return { ...DEFAULT_CONFIG, ...s, levers: { ...DEFAULT_LEVERS, ...(s.levers ?? {}) }, scoring_rules: { ...DEFAULT_SCORING, ...(s.scoring_rules ?? {}) } };
    } catch { /* fall through */ }
  }
  return { ...DEFAULT_CONFIG };
}
export function setConfig(db: DB, cfg: Partial<AppConfig>): void {
  setSetting(db, "config", JSON.stringify({ ...getConfig(db), ...cfg }));
}

// --- my roster (the drafted team) -- keyed by draft_id ('local' for the app's working team) ---
export type RosterEntry = { name: string; price: number };
export function setMyRoster(db: DB, draftId: string, roster: RosterEntry[]): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM my_roster WHERE draft_id = ?`).run(draftId);
    const ins = db.prepare(`INSERT OR REPLACE INTO my_roster (draft_id, player_id, name, slot, price) VALUES (?, ?, ?, ?, ?)`);
    for (const r of roster) ins.run(draftId, nameKey(r.name), r.name, "", Math.round(r.price) || 0); // player_id = name_key, joins player_value
  });
  tx();
}
export function getMyRoster(db: DB, draftId: string): RosterEntry[] {
  return (db.prepare(`SELECT name, price FROM my_roster WHERE draft_id = ?`).all(draftId) as RosterEntry[]);
}

// --- action log (the D3 audit trail: every agent ACTION is logged planned -> done/failed) ---
export function logAction(db: DB, a: { runId?: string; runType: string; action: string; detail?: unknown }): number {
  const info = db.prepare(
    `INSERT INTO action_log (ts, run_id, run_type, action, detail_json, status) VALUES (?, ?, ?, ?, ?, 'planned')`,
  ).run(nowIso(), a.runId ?? null, a.runType, a.action, JSON.stringify(a.detail ?? {}));
  return info.lastInsertRowid as number;
}
export function completeAction(db: DB, id: number, status: "done" | "failed" | "skipped", reason?: string): void {
  db.prepare(`UPDATE action_log SET status = ?, reason = ? WHERE id = ?`).run(status, reason ?? null, id);
}
export function recentActions(db: DB, limit = 10): { ts: string; action: string; status: string; detail_json: string; reason: string }[] {
  return db.prepare(`SELECT ts, action, status, detail_json, reason FROM action_log ORDER BY id DESC LIMIT ?`).all(limit) as never;
}

// --- agent token usage (feeds the budget governor) ---
export function appendUsage(db: DB, u: { runId?: string; runType: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void {
  db.prepare(
    `INSERT INTO usage_log (ts, run_id, run_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(nowIso(), u.runId ?? null, u.runType, u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0);
}

// --- live draft snapshot (the engine's per-tick state; agent reads it) ---
export function writeDraftState(db: DB, draftId: string, state: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO draft_state (draft_id, updated_at, round, paused, on_block_player, on_block_pos, bid, live_inflation, our_budget, our_spent, our_filled, state_json)
     VALUES (@draft_id, @updated_at, @round, @paused, @on_block_player, @on_block_pos, @bid, @live_inflation, @our_budget, @our_spent, @our_filled, @state_json)
     ON CONFLICT(draft_id) DO UPDATE SET updated_at=excluded.updated_at, round=excluded.round, paused=excluded.paused,
       on_block_player=excluded.on_block_player, on_block_pos=excluded.on_block_pos, bid=excluded.bid,
       live_inflation=excluded.live_inflation, our_budget=excluded.our_budget, our_spent=excluded.our_spent,
       our_filled=excluded.our_filled, state_json=excluded.state_json`,
  ).run({
    draft_id: draftId, updated_at: nowIso(),
    round: (state.round as number) ?? null, paused: state.paused ? 1 : 0,
    on_block_player: (state.onBlockPlayer as string) ?? null, on_block_pos: (state.onBlockPos as string) ?? null,
    bid: (state.bid as number) ?? null, live_inflation: (state.liveInflation as number) ?? null,
    our_budget: (state.ourBudget as number) ?? null, our_spent: (state.ourSpent as number) ?? null,
    our_filled: (state.ourFilled as number) ?? null, state_json: JSON.stringify(state),
  });
}
