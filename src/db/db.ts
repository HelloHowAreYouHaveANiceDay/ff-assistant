// The single local store. better-sqlite3 (synchronous, WAL). One writer at a time; readers
// never block. Every consumer -- the engine, the app main, the ingesters -- opens the same file.
// The agent reaches it through a SQLite MCP server (later); everyone else opens directly.
import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey } from "../draft/values.js";
import { DEFAULT_SCORING, type ScoringRules, type KickerRules, type DefenseRules } from "../draft/scoring.js";
import { DEFAULT_LEVERS, type Levers } from "../draft/levers.js";
import { scoringKey, INCUMBENT_SCORING_KEY } from "../data/formatKey.js";

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
  // THE APP'S WORKING DRAFT SESSION, LEAGUE-QUALIFIED (S-13). It used to be the bare id `'local'`, one
  // row shared by every league in the store -- so the board you drafted in the Yahoo tab and the board
  // you drafted in the ESPN tab were the same team, and `my_roster` had no way to say which league a
  // $47 Ja'Marr Chase belonged to. `localDraftId` makes it `local:<leagueId>`.
  const lg = activeLeagueId(db);
  const seedId = localDraftId(lg);
  if (!db.prepare(`SELECT 1 FROM draft WHERE draft_id = ?`).get(seedId)) {
    db.prepare(`INSERT INTO draft (draft_id, kind, league_id, season, status, started_at, updated_at) VALUES (?, 'local', ?, ?, 'active', ?, ?)`)
      .run(seedId, lg, DEFAULT_CONFIG.season, nowIso(), nowIso());
  }
  return db;
}

/**
 * The app's working draft session for ONE league. A store with two leagues has two of them.
 *
 * `null` (a fresh clone with no league synced) keeps the bare `'local'` id, so a store that has never
 * seen a league behaves exactly as it always did rather than growing a session called `local:null`.
 */
export function localDraftId(leagueId: string | null | undefined): string {
  return leagueId ? `local:${leagueId}` : "local";
}

/** Apply schema.sql. CREATE ... IF NOT EXISTS throughout, so re-running is a no-op. */
// Phase 2b (2026-09-15): the per-league HISTORY/state tables that must COEXIST across leagues get
// `league_id` prepended to their PK. board/player_value/player_value_position are deliberately NOT here
// -- they are regenerable, read pervasively, and stay single-slot "active-league cache" (rebuilt on a
// league switch), which avoids a pervasive reader cascade. docs/multi-league-refactor.md.
// GENUINELY per-league (a second league writes its own rows here). NOT team_odds (NFL game odds are
// the same for every fantasy league) and NOT scorecard_* (they measure the shared MODEL's accuracy,
// not a league) -- those are SHARED and must NOT be partitioned by league.
//
// WP2 (S-5, 2026-09-16) ADDED THE LAST THREE. `fact_draft_pick`, `fact_team_season` and `fact_matchup`
// each CARRIED a `league_id` column and left it out of the PRIMARY KEY -- `(season, team_name,
// pick_order)`, `(season, team_id)`, `(season, week, home_id)`. A column that is not in the key does
// not partition anything: two leagues' 2024 team 8 are the same row, and the upserts in picks.ts would
// have overwritten one league's history with the other's the first time both were built. The refactor
// doc listed all three as "already keyed", which is why nobody looked.
const LEAGUE_ID_PK_TABLES = [
  "fact_roster_week", "fact_lineup_week", "fact_fa_pool_week", "fact_waiver_claim", "decision_snapshot",
  "fact_draft_pick", "fact_team_season", "fact_matchup",
];

export function migrate(db: DB): void {
  db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
  addColumns(db);
  backfillLeagueConfig(db);
  migrateLeagueIdPk(db);
  migrateLocalDraftId(db);
  migrateScorecardFormatKey(db);
  migrateBoardStamp(db);
}

/**
 * Phase 2b: rebuild each history table with `league_id` prepended to its PRIMARY KEY, backfilling the
 * existing rows to the active league (all existing data is the one ESPN league's). SQLite cannot add a
 * PK column in place, so this is a create-copy-drop-rename per table, under one transaction with FKs
 * off. IDEMPOTENT: a table that already has `league_id` is skipped, so this is a no-op after the first
 * run and on a fresh store (schema.sql already creates the new shape).
 */
interface ColInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

const pkOf = (cols: ColInfo[]): string[] =>
  cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

function migrateLeagueIdPk(db: DB): void {
  const backfill = activeLeagueId(db);                  // null on a fresh store -> only empty tables get rebuilt
  const todo = LEAGUE_ID_PK_TABLES.filter((t) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as ColInfo[];
    if (!cols.length) return false;                     // table not created yet; schema.sql owns that
    // THE TEST IS THE KEY, NOT THE COLUMN (S-5). The old predicate skipped any table that merely HAD a
    // `league_id` column, which is exactly the three tables that carried one outside the key -- so the
    // migration reported itself done on the tables that needed it most.
    if (pkOf(cols)[0] === "league_id") return false;    // already migrated
    if (backfill) return true;
    // no active league: only safe to rebuild an EMPTY table (a fresh store); rows with no league to
    // attribute them to are left for the next open once a league exists.
    return (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c === 0;
  });
  if (!todo.length) return;
  const tag = backfill ?? "__unknown__";               // only ever applied to 0 rows when backfill is null
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const t of todo) {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all() as ColInfo[];
        const before = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
        const pk = pkOf(cols);
        // A table that already HAS the column keeps it (and its position moves to the front); one that
        // does not gains it. Either way `league_id` leads the new key exactly once.
        const rest = cols.filter((c) => c.name !== "league_id");
        const hadCol = rest.length !== cols.length;
        const colDDL = ['"league_id" TEXT NOT NULL',
          ...rest.map((c) => `"${c.name}" ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ""}`)];
        const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t) as { sql: string }[];
        const restNames = rest.map((c) => `"${c.name}"`).join(", ");
        const newPk = ["league_id", ...pk.filter((c) => c !== "league_id")].map((c) => `"${c}"`).join(", ");
        db.exec(`CREATE TABLE "${t}__ml" (${colDDL.join(", ")}, PRIMARY KEY (${newPk}))`);
        // An existing row whose `league_id` is NULL is attributed to the backfill league, the same rule
        // a table with no column at all gets -- a NOT NULL key column cannot take the NULL through.
        db.prepare(
          `INSERT INTO "${t}__ml" ("league_id", ${restNames}) ` +
          `SELECT ${hadCol ? `COALESCE("league_id", ?)` : "?"}, ${restNames} FROM "${t}"`,
        ).run(tag);
        db.exec(`DROP TABLE "${t}"`);
        db.exec(`ALTER TABLE "${t}__ml" RENAME TO "${t}"`);
        // RECREATE THE INDEXES, AND PROVE IT. `DROP TABLE` takes the table's indexes with it, and the
        // recreation used to sit in a bare try/catch whose comment claimed "schema.sql will do it next
        // open" -- schema.sql had ALREADY run, two lines earlier in `migrate`, so a swallowed failure
        // here turned an index into a silent full table scan that nothing would ever report.
        for (const ix of idx) db.exec(ix.sql);
        const after = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
        if (after !== before) throw new Error(`migrateLeagueIdPk: ${t} lost rows (${before} -> ${after})`);
        const nIdx = (db.prepare(
          `SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
        ).get(t) as { c: number }).c;
        if (nIdx !== idx.length) throw new Error(`migrateLeagueIdPk: ${t} has ${nIdx} explicit indexes, expected ${idx.length}`);
      }
    })();
  } finally { db.pragma("foreign_keys = ON"); }
}

/**
 * S-13: the app's working draft session was the bare id `'local'`, shared by every league.
 *
 * Renames it to `local:<activeLeague>` across the four tables that key on it, once. Idempotent: a
 * store with no `'local'` row (or no league) is untouched. FKs are off for the rename because
 * `draft_state`/`my_roster` REFERENCE `draft(draft_id)` with no ON UPDATE CASCADE.
 */
function migrateLocalDraftId(db: DB): void {
  const lg = activeLeagueId(db);
  if (!lg) return;
  let stale: boolean;
  try { stale = !!db.prepare(`SELECT 1 FROM draft WHERE draft_id = 'local'`).get(); } catch { return; }
  if (!stale) return;
  const want = localDraftId(lg);
  if (db.prepare(`SELECT 1 FROM draft WHERE draft_id = ?`).get(want)) return;  // both exist: leave the old row alone
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.prepare(`UPDATE draft SET draft_id = ?, league_id = COALESCE(league_id, ?) WHERE draft_id = 'local'`).run(want, lg);
      for (const t of ["draft_state", "draft_pick", "my_roster"]) {
        // `draft_pick` is created by the draft runtime, not by schema.sql, so it can legitimately be
        // absent. Checked by inspection rather than by catching, so a REAL failure still surfaces.
        const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
        if (!cols.length) continue;
        db.prepare(`UPDATE "${t}" SET draft_id = ? WHERE draft_id = 'local'`).run(want);
      }
    })();
  } finally { db.pragma("foreign_keys = ON"); }
}

/** The incumbent ESPN league's scoring key -- an ALIAS of the single source, `INCUMBENT_SCORING_KEY`
 *  in src/data/formatKey.ts, which pins it AND asserts it against `DEFAULT_SCORING` at module load
 *  (WP3). It was a second literal here; two literals for one fact is how a re-key half-lands. Kept
 *  under its old name because the storage migrations below read as "the key these rows were written
 *  under", which is what it means to them. */
export const ESPN_SCORING_KEY: string = INCUMBENT_SCORING_KEY;

/**
 * I-5: `scorecard_prediction` / `scorecard_result` gain `format_key` at the head of the PRIMARY KEY.
 *
 * The two tables measure a MODEL's accuracy, which is per FORMAT and not per league -- two leagues on
 * identical rules should and do share a row. But the PK was `(season, week, kind, model, subject)` with
 * `INSERT OR IGNORE` everywhere, so the SECOND format to freeze a player-week was silently dropped, and
 * an `odds` subject (a team id) collided outright across platforms. Sharing is right per format and a
 * fabrication across formats.
 *
 * Existing rows are backfilled with the ESPN scoring key, which is ASSERTED to be what the active
 * league's rules actually hash to -- a backfill that stamps a guessed provenance is the same defect at
 * one remove.
 */
function migrateScorecardFormatKey(db: DB): void {
  const todo = ["scorecard_prediction", "scorecard_result"].filter((t) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as ColInfo[];
    return cols.length > 0 && pkOf(cols)[0] !== "format_key";
  });
  if (!todo.length) return;
  const rows = todo.reduce((a, t) => a + (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c, 0);
  const id = activeLeagueId(db);
  const key = scoringKey(getConfig(db, id).scoring_rules);
  if (rows && key !== ESPN_SCORING_KEY) {
    throw new Error(
      `migrateScorecardFormatKey: ${rows} existing scorecard row(s) were all written under the ESPN ` +
      `half-PPR rules (${ESPN_SCORING_KEY}), but league ${id ?? "?"}'s scoring hashes to ${key}. Backfilling ` +
      "them with that key would stamp the wrong provenance on the only out-of-sample record this repo owns.",
    );
  }
  db.transaction(() => {
    for (const t of todo) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as ColInfo[];
      const before = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
      const rest = cols.filter((c) => c.name !== "format_key");
      const hadCol = rest.length !== cols.length;
      const colDDL = ['"format_key" TEXT NOT NULL',
        ...rest.map((c) => `"${c.name}" ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ""}`)];
      const newPk = ["format_key", ...pkOf(cols).filter((c) => c !== "format_key")].map((c) => `"${c}"`).join(", ");
      const restNames = rest.map((c) => `"${c.name}"`).join(", ");
      db.exec(`CREATE TABLE "${t}__fk" (${colDDL.join(", ")}, PRIMARY KEY (${newPk}))`);
      db.prepare(
        `INSERT INTO "${t}__fk" ("format_key", ${restNames}) ` +
        `SELECT ${hadCol ? `COALESCE("format_key", ?)` : "?"}, ${restNames} FROM "${t}"`,
      ).run(ESPN_SCORING_KEY);
      db.exec(`DROP TABLE "${t}"`);
      db.exec(`ALTER TABLE "${t}__fk" RENAME TO "${t}"`);
      const after = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
      if (after !== before) throw new Error(`migrateScorecardFormatKey: ${t} lost rows (${before} -> ${after})`);
    }
  })();
}

// ============================================================================================
// S-8: THE BOARD STAMP. `board`, `player_value` and `player_value_position` stay single-slot --
// regenerable, read in dozens of places, and partitioning them would mean a pervasive reader
// cascade. What they could NOT do was say WHOSE they are: 529 rows of ESPN half-PPR auction dollars
// were served unchanged to a Yahoo superflex league, because `setActiveLeagueId` wrote two settings
// and stopped. A stamp plus a refusal is the cheap half of that: the numbers are either this
// league's or nobody gets them.
// ============================================================================================

export interface BoardStamp {
  leagueId: string;
  season?: number;
  scoringKey?: string;
  builtAt?: string;
  /** The board was CLEARED for this league and the rebuild has not succeeded yet. Readers refuse by
   *  name rather than serving the previous league's dollars. */
  pending?: boolean;
}

export function getBoardStamp(db: DB): BoardStamp | null {
  const raw = getSetting(db, "board_stamp");
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as BoardStamp;
    return s && typeof s.leagueId === "string" ? s : null;
  } catch { return null; }
}

export function setBoardStamp(db: DB, s: BoardStamp): void {
  setSetting(db, "board_stamp", JSON.stringify(s));
}

/** Rows in the single-slot board. Cheap, and the three tables are written together. */
function boardRowCount(db: DB): number {
  try { return (db.prepare("SELECT COUNT(*) c FROM board").get() as { c: number }).c; } catch { return 0; }
}

/**
 * REFUSE to serve the board to a league it was not built for.
 *
 * A missing stamp WITH rows present is also a refusal: it means the board predates the stamp and this
 * process cannot say whose it is. The one-time migration below stamps an existing board with the
 * ACTIVE league, so on a real store that state is reached only by hand-editing settings.
 */
export function assertBoardFor(db: DB, leagueId: string | null | undefined, what = "the board"): void {
  if (!leagueId) return;                       // a store with no league has no other league to confuse it with
  const stamp = getBoardStamp(db);
  if (stamp?.pending) {
    throw new Error(
      `board not built for league ${stamp.leagueId} -- it was cleared on the league switch and the rebuild ` +
      "has not succeeded (run `ff assemble --league " + stamp.leagueId + "`). " + what + " is unavailable.",
    );
  }
  if (!boardRowCount(db)) return;              // an empty board is its own, visible failure in every reader
  if (!stamp) {
    throw new Error(
      `${what}: the board carries no league stamp, so nothing can say which league's dollars these are ` +
      `-- run \`ff assemble --league ${leagueId}\` to rebuild and stamp it.`,
    );
  }
  if (stamp.leagueId !== leagueId) {
    throw new Error(
      `board is built for league ${stamp.leagueId}, not ${leagueId} -- run \`ff league-set-active ${leagueId}\` ` +
      `(rebuild) or \`ff assemble --league ${leagueId}\``,
    );
  }
}

/** One-time: an existing board has no stamp and IS the active league's (there has only ever been one
 *  league's board in any store this code has run on). Stamp it rather than refuse every reader. */
function migrateBoardStamp(db: DB): void {
  if (getBoardStamp(db)) return;
  if (!boardRowCount(db)) return;
  const id = activeLeagueId(db);
  if (!id) return;
  const cfg = getConfig(db, id);
  setBoardStamp(db, { leagueId: id, season: cfg.season, scoringKey: scoringKey(cfg.scoring_rules), builtAt: nowIso() });
}

/** Phase 2a backfill: copy the legacy single `config` into the active league's per-league key
 *  (`config:<leagueId>`) once, so an existing store's current league keeps its config. Idempotent. */
function backfillLeagueConfig(db: DB): void {
  try {
    const id = activeLeagueId(db);
    if (!id) return;                                   // no league synced yet -> legacy `config` still serves
    const perLeague = getSetting(db, `config:${id}`);
    const legacy = getSetting(db, "config");
    if (!perLeague && legacy) setSetting(db, `config:${id}`, legacy);
  } catch { /* league table not present on a bare store */ }
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
    // WHICH LEAGUE AN ACTION WAS TAKEN IN (S-13/I-7). The D3 audit trail had no league column at all,
    // so with two leagues in one store "what did the copilot do?" could not be answered per league --
    // and a wrong-league action would have been indistinguishable in the log from a right one.
    ["action_log", "league_id", "TEXT"],
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
    // FRONTIER CANDIDATES on feat_player_season_ext (2026-09-14). Prior-season / Sep-1, so safe at the
    // anchor; declared as --add-features candidates only, never default. See docs/feature-frontier.md.
    ["feat_player_season_ext", "prior_out_games", "REAL"],
    ["feat_player_season_ext", "prior_yac_oe", "REAL"],
    ["feat_player_season_ext", "prior_ryoe", "REAL"],
    ["feat_player_season_ext", "prior_cpoe", "REAL"],
    ["feat_player_season_ext", "qb_changed", "INTEGER"],
    // PBP SITUATIONAL-OPPORTUNITY candidates (2026-09-15). Prior-season high-value-touch shares from
    // raw_pbp_player_week -- the TD-equity signal the volume shares (wopr/carry_share) dilute. Declared
    // as --add-features candidates only, never default until each clears the paired-season floor.
    ["feat_player_season_ext", "prior_rz_touch_share", "REAL"],
    ["feat_player_season_ext", "prior_gtg_carry_share", "REAL"],
    ["feat_player_season_ext", "prior_ez_target_share", "REAL"],
    // Volume-ORTHOGONAL pbp candidates (2026-09-15): TD-over-expected (the regression residual) and
    // average depth of target. Built to sidestep the collinearity that nulled the share candidates.
    ["feat_player_season_ext", "prior_td_oe", "REAL"],
    ["feat_player_season_ext", "prior_adot", "REAL"],
    // TEAM-ENVIRONMENT candidates (2026-09-15): the scheme/pace/RZ environment a player sits in.
    ["feat_player_season_ext", "prior_team_pass_rate", "REAL"],
    ["feat_player_season_ext", "prior_team_plays_pg", "REAL"],
    ["feat_player_season_ext", "prior_team_rz_pg", "REAL"],
    // WEEKLY candidates (2026-09-15): rolling season-to-date red-zone touch share, and prior-season volatility.
    ["feat_player_week_model", "rz_share_td", "REAL"],
    ["feat_player_week_model", "prior_vol_cv", "REAL"],
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
  // HOW THE LEAGUE IS STOCKED. "auction" for every ESPN league this repo has ever run, and the
  // default, so an existing store is byte-identical. A snake league prices nothing in dollars, so the
  // auction-only verbs (auto-draft, values-as-dollars, sim/backtest) refuse on it BY NAME rather than
  // quietly reporting auction values for a draft that has none.
  //
  // `platform` is deliberately NOT here. It is a property of the LEAGUE ROW (`league.platform`), read
  // through LeagueContext; storing it in the config as well is two sources for one fact, and that is
  // exactly how `openLeague` came to dispatch on a field AppConfig does not have (S-12).
  draftType: "auction" as "auction" | "snake",
  // the actual per-stat scoring model that tailors OUR points/values (populated by league_sync)
  scoring_rules: DEFAULT_SCORING as ScoringRules,
  // K AND DST SCORING, DECLARED (WP3). These were being WRITTEN by `league_sync` and READ by the
  // format scripts while being absent from this type, so every reader reached them through a cast and
  // the compiler could not tell a typo from a field. They matter now because `scoringKeyFor` folds
  // them into the format key when a league overrides them: an undeclared field cannot be part of an
  // identity. `null` means "this league declares none" -- Yahoo 129048 rosters no K and no DST -- and
  // is elided from the key exactly like a value equal to the default, because both produce the same
  // target (history.ts scores K/DST rows under the defaults either way).
  kicker: null as KickerRules | null,
  defense: null as DefenseRules | null,
  // tunable knobs (tiers, K/DST cap, bidding, sleeper cutoff) -- visible + assistant-writable
  levers: DEFAULT_LEVERS as Levers,
};
export type AppConfig = typeof DEFAULT_CONFIG;
/** The active league = the most-recently-synced one, or null on a store that has never synced a league.
 *  Inlined here (not imported from leagueHistory) to avoid a db<->leagueHistory import cycle. */
export function activeLeagueId(db: DB): string | null {
  try {
    // Explicit selection (set by a league-tab click) wins, if it names a real league; otherwise fall
    // back to the most-recently-synced one. Kept separate from `last_synced_at` so switching the active
    // league in the UI does not masquerade as a fresh sync (which ingest/staleness logic keys on).
    const sel = getSetting(db, "active_league");
    if (sel && db.prepare("SELECT 1 FROM league WHERE league_id = ?").get(sel)) return String(sel);
    const r = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id?: string } | undefined;
    return r?.league_id ? String(r.league_id) : null;
  } catch { return null; }   // fresh store before the league table exists
}
export function setActiveLeagueId(db: DB, leagueId: string): void {
  setSetting(db, "active_league", leagueId);
  setActiveLeagueConfig(db, leagueId);   // point the legacy config mirror at the newly-active league
}

const configKey = (leagueId: string | null): string => (leagueId ? `config:${leagueId}` : "config");

/**
 * MULTI-LEAGUE CONFIG. Source of truth is the per-league key `config:<leagueId>`.
 *
 * THE FALLBACK THAT HAD TO GO (S-7, 2026-09-16). An EXPLICIT id whose key is absent used to fall back
 * to the legacy `config` MIRROR -- which holds ANOTHER league's config. That is how the Yahoo league
 * came to carry ESPN's playoff calendar, ESPN's half-PPR scoring rules, ESPN's divisions and ESPN's
 * team ids: `getConfig(db, "129048")` returned league 462233's config, and `setConfig` then merged the
 * new league's handful of edits on top of it and stored the result as a fact. A config inherited from
 * a different league is not a default, it is a fabrication, and it passes every shape check there is.
 *
 * So: an explicit id reads ONLY its own key, and falls back to DEFAULT_CONFIG -- which is wrong in a
 * visible, uniform way (no format block at all, so `effectiveFormat` THROWS) rather than wrong in a way
 * that looks configured. Resolution with NO id is unchanged: active league's key, then the legacy
 * mirror, then defaults.
 *
 * The legacy `config` key survives as a DERIVED MIRROR of the active league, written by `setConfig` and
 * `setActiveLeagueConfig`, so anything outside this repo that reads it still sees something sane. No
 * code in src/ or scripts/ reads it any more.
 */
export function getConfig(db: DB, leagueId?: string | null): AppConfig {
  // `null` means "this store has no league" (a fresh clone), NOT "a league I named" -- it keeps the
  // legacy path so a config-only caller on a bare store behaves as it always has. Only a real id is
  // treated as an explicit, isolated request.
  const explicit = typeof leagueId === "string" && leagueId.length > 0;
  const raw = explicit
    ? getSetting(db, configKey(leagueId as string))
    : ((): string | undefined => {
      const id = activeLeagueId(db);
      return (id ? getSetting(db, configKey(id)) : undefined) ?? getSetting(db, "config");
    })();
  if (raw) {
    try {
      const s = JSON.parse(raw);
      // deep-merge the nested knob objects so a partial stored value never drops keys
      return { ...DEFAULT_CONFIG, ...s, levers: { ...DEFAULT_LEVERS, ...(s.levers ?? {}) }, scoring_rules: { ...DEFAULT_SCORING, ...(s.scoring_rules ?? {}) } };
    } catch { /* fall through */ }
  }
  return { ...DEFAULT_CONFIG };
}
/**
 * Write a config patch for ONE league.
 *
 * REFUSES rather than writing a league-less config (S-11). The old `!id` branch wrote the legacy mirror
 * alone -- a config belonging to no league, which the next `getConfig` for ANY league could inherit.
 * There is no such thing as a config that is not some league's config.
 */
export function setConfig(db: DB, cfg: Partial<AppConfig>, leagueId?: string | null): void {
  const explicit = typeof leagueId === "string" && leagueId.length > 0;
  const id = explicit ? (leagueId as string) : activeLeagueId(db);
  if (!id) {
    throw new Error(
      "setConfig: no league to write the config for -- pass an explicit leagueId, or sync a league first " +
      "(a config that belongs to no league is the mirror every other league used to inherit).",
    );
  }
  const merged = JSON.stringify({ ...getConfig(db, id), ...cfg });
  setSetting(db, configKey(id), merged);
  // Keep the legacy `config` mirror pointed at the ACTIVE league. DERIVED, never read by this repo.
  if (id === activeLeagueId(db)) setSetting(db, "config", merged);
}

/** Point the legacy `config` mirror at a league's config -- called when the active league changes.
 *  DERIVED ONLY: as of 2026-09-16 nothing in src/ or scripts/ reads that key, it is kept so anything
 *  outside this repo still sees a sane value. `test/config-isolation-faultinject.test.ts` corrupts it
 *  and asserts every per-league read is unaffected, which is what "no reader left" actually means. */
export function setActiveLeagueConfig(db: DB, leagueId: string): void {
  const raw = getSetting(db, configKey(leagueId));
  if (raw) setSetting(db, "config", raw);
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
export function logAction(db: DB, a: { runId?: string; runType: string; action: string; detail?: unknown; leagueId?: string | null }): number {
  // `leagueId` omitted falls back to the ACTIVE league rather than NULL: every action this repo takes
  // is taken in SOME league, and a NULL here would be a row that cannot be attributed later.
  const lg = a.leagueId !== undefined ? a.leagueId : activeLeagueId(db);
  const info = db.prepare(
    `INSERT INTO action_log (ts, league_id, run_id, run_type, action, detail_json, status) VALUES (?, ?, ?, ?, ?, ?, 'planned')`,
  ).run(nowIso(), lg ?? null, a.runId ?? null, a.runType, a.action, JSON.stringify(a.detail ?? {}));
  return info.lastInsertRowid as number;
}
export function completeAction(db: DB, id: number, status: "done" | "failed" | "skipped", reason?: string): void {
  db.prepare(`UPDATE action_log SET status = ?, reason = ? WHERE id = ?`).run(status, reason ?? null, id);
}
/** The last `limit` actions IN ONE LEAGUE. `leagueId` omitted = the active league; pass `null` for
 *  every league (which is what "what has this store done?" means, and nothing else should want). */
export function recentActions(db: DB, limit = 10, leagueId?: string | null | undefined): { ts: string; action: string; status: string; detail_json: string; reason: string }[] {
  const lg = leagueId === undefined ? activeLeagueId(db) : leagueId;
  if (lg == null) return db.prepare(`SELECT ts, action, status, detail_json, reason FROM action_log ORDER BY id DESC LIMIT ?`).all(limit) as never;
  // Rows written before `action_log.league_id` existed carry NULL; they belong to the one league this
  // store had, so they are included rather than silently dropped from the audit trail.
  return db.prepare(
    `SELECT ts, action, status, detail_json, reason FROM action_log
      WHERE league_id = ? OR league_id IS NULL ORDER BY id DESC LIMIT ?`,
  ).all(lg, limit) as never;
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
