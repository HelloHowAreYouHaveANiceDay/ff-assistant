// The single local store. better-sqlite3 (synchronous, WAL). One writer at a time; readers
// never block. Every consumer -- the engine, the app main, the ingesters -- opens the same file.
// The agent reaches it through a SQLite MCP server (later); everyone else opens directly.
import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey } from "../draft/values.js";
import { DEFAULT_SCORING, type ScoringRules } from "../draft/scoring.js";
import { DEFAULT_LEVERS, type Levers } from "../draft/levers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = process.env.FF_DB ?? "data/ff.db";

export type DB = Database.Database;

/**
 * WHICH STORE ARE WE ACTUALLY ON, and does its data root agree with it?
 *
 * There are two ways to run: dev opens `data/ff.db` with sidecars in `data/`; a packaged install
 * redirects BOTH the DB (`FF_DB`) and the data root (`FF_DATA`) into a writable userData dir. They
 * agree only because the app injects both together. A CLI run by hand with `FF_DB` set but `FF_DATA`
 * unset (or vice versa) splits them: the DB lands in one place and its points.csv / cache /
 * live-state.json in another, and nothing said so. This surfaces the split rather than letting it be
 * discovered as "the scorecard is empty on this clone". `split` is true when the DB's directory and
 * the resolved data root are not the same folder.
 */
export function storeInfo(path: string = DEFAULT_DB_PATH): { dbPath: string; dbDir: string; dataRoot: string; split: boolean } {
  const dbDir = resolve(dirname(path));
  const dataRoot = resolve(process.env.FF_DATA ?? "data");
  return { dbPath: resolve(path), dbDir, dataRoot, split: dbDir !== dataRoot };
}

let WARNED_SPLIT = false;
function warnStoreSplitOnce(path: string): void {
  if (WARNED_SPLIT) return;
  const s = storeInfo(path);
  if (!s.split) return;
  WARNED_SPLIT = true;
  console.error(
    `WARNING: the store and its data root are in DIFFERENT folders -- DB ${s.dbPath} but FF_DATA ` +
    `${s.dataRoot}. Sidecars (points.csv, data/cache, live-state.json) will not sit beside the DB, ` +
    "which is how a clone ends up looking empty. Set FF_DB and FF_DATA to the same root, or unset both.",
  );
}

/** Open (creating if needed) the store, set WAL, and apply the idempotent schema. */
export function openDb(path: string = DEFAULT_DB_PATH): DB {
  warnStoreSplitOnce(path);
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
    // The surrogate player key on the CONSUMER tables. Additive rather than a new PK: board and
    // player_value are still written and read by name_key everywhere, and swapping the primary key
    // under live consumers is a much larger change than giving them the stable id to migrate onto.
    ["board", "player_sk", "INTEGER"],
    ["player_value", "player_sk", "INTEGER"],
    // This season's own finish rank, which the following season reads as prior_pos_rank.
    ["feat_player_season", "pos_rank", "INTEGER"],
    // OWN-SEASON usage, per game. `prior_*` on season Y's row is Y-1 usage; these are Y's own, and
    // they exist because the backtest's pool is season Y-1's players -- a man who never posts a
    // season Y row (retired, hurt in camp) had every usage feature NULL, which is defect D3.
    // Reading HIS Y-1 row's own_* columns is the same quantity the Y row's prior_* would have held.
    ["feat_player_season", "own_fd", "REAL"],
    ["feat_player_season", "own_ts", "REAL"],
    ["feat_player_season", "own_attempts", "REAL"],
    ["feat_player_season", "own_rush_yards", "REAL"],
    ["feat_player_season", "own_air_yards_share", "REAL"],
    ["feat_player_season", "own_wopr", "REAL"],
    ["feat_player_season", "own_games_usage", "INTEGER"],
    // A crosswalk key that stands for more than one real person. See player_ids_variant.
    ["player_ids", "ambiguous", "INTEGER"],
    // WHERE A CONTEXT ROW CAME FROM, and it is load-bearing rather than descriptive.
    //
    // `feat_player_week_context` now has TWO builders under two different guarantees. The historical
    // one places every injury designation by the date the team FILED it, so a Friday status is
    // provably backed by a filing dated at or before that Friday -- an invariant a leakage test
    // asserts. The live one reads a status FEED, which publishes a current state and one timestamp
    // and files nothing, so its rows cannot satisfy that back-join and never will: `raw_injury`
    // holds no rows at all for a season nobody has archived.
    //
    // Without this column the leakage guard sees the live rows, finds no filing behind them, and
    // reports a leak that is not one -- and the only ways to quiet it would be to weaken the guard
    // (which then also absorbs a real leak) or to infer provenance from the SHAPE of `as_of`, which
    // is an implicit convention two lines of code apart. So the row says which builder wrote it, and
    // each guarantee is asserted against the rows it actually applies to.
    ["feat_player_week_context", "source", "TEXT"],
    // The PFR id, carried into staging so the snap-count feed resolves through the SAME map as
    // everything else instead of a parallel route through player_ids that can disagree with it.
    ["stg_player", "pfr_id", "TEXT"],
    // AUCTION STATE AT THE MOMENT OF THE PICK. A price means one thing with $180 and 15 slots left
    // and another with $12 and 2, and a price model that cannot see the difference is fitting the
    // average of two different games.
    ["fact_draft_pick", "money_remaining", "INTEGER"],
    ["fact_draft_pick", "slots_remaining", "INTEGER"],
    ["fact_draft_pick", "season_total_money", "INTEGER"],
    // The share of the ROOM'S money this pick took. 14-team and 16-team seasons are $2,800 and
    // $3,200 rooms, and comparing raw dollars across them compares two different currencies.
    ["fact_draft_pick", "price_share", "REAL"],
    // THE LEAGUE'S FORMAT, PER SEASON. Not one format with a season column bolted on -- the format
    // is the thing that CHANGES, and the calibration had been assuming it did not.
    //
    // Phase 2c scored playoff-berth predictions for 2018-2025 against a constant 7-team field. This
    // league ran a SIX-team field from 2018 to 2020 (and 14 teams, and one division), so the
    // constant told the scorer that eight of fourteen teams missed the playoffs when in fact eight
    // of fourteen did -- a berth is 43% likely in a 6-of-14 season and 44% in a 7-of-16 one, and the
    // seeding rule differs outright: one division cannot have division winners. Every one of these
    // columns is read from ESPN's own history settings, per season, and none is defaulted.
    //
    // They go on `raw_league_season` by ALTER rather than in schema.sql because schema.sql is only
    // ever reached by a FRESH store (every statement is CREATE ... IF NOT EXISTS), so a new column
    // added there lands on nobody's existing database.
    ["raw_league_season", "reg_weeks", "INTEGER"],
    ["raw_league_season", "playoff_teams", "INTEGER"],
    ["raw_league_season", "playoff_round_weeks", "INTEGER"],
    ["raw_league_season", "playoff_reseed", "INTEGER"],
    ["raw_league_season", "seeding_rule", "TEXT"],
    ["raw_league_season", "division_count", "INTEGER"],
    // ...and carried onto the modelled layer, so a scorer joins one table rather than reaching back
    // into raw.
    ["fact_team_season", "reg_weeks", "INTEGER"],
    ["fact_team_season", "playoff_teams", "INTEGER"],
    ["fact_team_season", "playoff_reseed", "INTEGER"],
    ["fact_team_season", "seeding_rule", "TEXT"],
    ["fact_team_season", "division_count", "INTEGER"],
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
  // THE CALENDAR IS NOT A DEFAULT. `format` is null on a fresh store and is written by
  // `ff format sync` (read from ESPN) or `ff format set` (owner override); every consumer reads it
  // through effectiveFormat(), which THROWS when it is absent rather than substituting 14/7/record.
  //
  // playoffTeams/regWeeks remain as MIRRORS of the block, for the readers that predate it (the MCP
  // league_sync tool, scripts/read-config.mjs). They are written from `format` and must never be
  // written independently of it -- two numbers for one fact is how the fact stops being one.
  format: null as unknown as import("../league/types.js").LeagueFormat | null,
  // What ESPN said, KEPT even while an owner override is in force -- so `ff format show` can print
  // both blocks and say which one is being used, instead of the override erasing its own evidence.
  formatEspn: null as unknown as import("../league/types.js").LeagueFormat | null,
  playoffTeams: 6,   // MIRROR of format.playoffTeams
  regWeeks: 14,      // MIRROR of format.regWeeks
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
