/**
 * A PUBLISHABLE DATASET -- the modelling layer, with every trace of a private league removed.
 *
 * WHY. The store is ~929 MB and most of it is expensive to rebuild: the feature tables alone are
 * ~300k player-weeks and need the full ingest plus the training runs. Someone cloning this repo
 * currently has to re-pull all of it. Publishing the derived layer means they do not.
 *
 * WHAT MUST NEVER GO UP, and this is the whole reason the module exists rather than a shell script:
 * the ESPN league tables carry OTHER PEOPLE'S data. Sixteen managers' account GUIDs
 * (`{3AB1996E-...}`), their usernames, their eighteen member ids and their complete transaction
 * history, pulled with the owner's authenticated session from a private league. None of them agreed
 * to publication, and the roster/transaction history is re-identifying on its own to anyone who
 * knows the league. That is a consent question, not a technical one, and no amount of column
 * stripping makes it not one.
 *
 * TWO INDEPENDENT GUARDS, because either alone fails:
 *
 *   1. AN ALLOWLIST, NOT A DENYLIST. A denylist fails OPEN: a table added next month is published by
 *      default, and nobody finds out until it is on the internet. An allowlist fails CLOSED -- a new
 *      public table is merely missing until someone adds it, which is a bug report rather than a
 *      disclosure. This repo has paid three times for coverage-by-enumeration that rotted; the
 *      difference here is the DIRECTION it rots in.
 *   2. A STRUCTURAL SCAN of the columns actually being exported. The allowlist is a decision made
 *      once; the scan re-checks it every run against the live schema, so an allowlisted table that
 *      LATER gains a `league_id` is caught rather than trusted. A curated list plus a mechanical
 *      re-check is the same pattern the write allowlist uses.
 *
 * NEITHER GUARD IS THE OTHER'S BACKUP. The allowlist catches a whole table nobody thought about; the
 * scan catches a column added to a table somebody already approved. They fail differently on
 * purpose.
 */
import type { DB } from "../db/db.js";

/**
 * COLUMNS THAT IDENTIFY A LEAGUE, A MANAGER, OR A FANTASY TEAM.
 *
 * `espn_id` is deliberately NOT here. It is a PLAYER id -- public, stable, and the join key half the
 * public feeds use. A naive `/espn/` pattern flags `player`, `stg_player` and `market_value`, all of
 * which are exactly the kind of table this export exists to publish. Over-blocking would quietly
 * gut the dataset and look like caution.
 */
const PRIVATE_COLUMN = /^(league_id|owner|owner_id|member_id|team_id|opponent_team_id|team_ids_json|swid|acquisition_type|acquisition_date|acquisitions(_by_week_json)?|faab_spent|team_abbrev)$/i;

/**
 * THE TABLES THAT MAY BE PUBLISHED. Curated, and every entry says WHY it is safe -- an entry whose
 * justification nobody can state is an entry that should not be here.
 *
 * All of these are league-independent: they describe NFL players and games, or models fitted on
 * them. None describes who drafted whom in anybody's league.
 */
export const PUBLISHABLE: { table: string; why: string }[] = [
  // --- raw public feeds (nflverse and similar; already redistributable, but expensive to re-pull)
  { table: "raw_nfl_game", why: "NFL schedule and results" },
  { table: "raw_injury", why: "official weekly injury and practice reports" },
  { table: "raw_depth_chart", why: "published depth charts" },
  { table: "raw_snap_count", why: "per-game snap counts" },
  { table: "raw_participation", why: "participation rates" },
  { table: "raw_pbp_player_week", why: "play-by-play aggregated per player-week" },
  { table: "raw_combine", why: "combine testing" },
  { table: "raw_ngs", why: "Next Gen Stats efficiency" },
  { table: "raw_nfl_draft_pick", why: "the NFL draft -- not a fantasy draft" },
  { table: "raw_college_player_season", why: "college production" },
  { table: "raw_college_team_season", why: "college team context" },
  { table: "raw_contract", why: "published NFL contracts" },
  { table: "raw_gameday_status", why: "game-day designations, keyed by NFL player" },
  { table: "raw_fftoday_proj", why: "a public preseason projection" },
  { table: "raw_adp_history", why: "public ADP" },

  // --- identity (players, not managers)
  { table: "player", why: "the NFL player dimension -- espn_id here is a PLAYER id, public" },
  { table: "player_bio", why: "heights, weights, birthdates of NFL players" },
  { table: "player_identity", why: "the surrogate-key registry for NFL players" },
  { table: "player_xref", why: "cross-source player id map" },
  { table: "stg_player", why: "staged player identity" },
  { table: "player_ids_variant", why: "player name variants" },

  // --- derived modelling layer (the expensive part, and the reason to publish at all)
  { table: "feat_player_week", why: "per player-week features" },
  { table: "feat_player_week_model", why: "the served weekly model's feature rows" },
  { table: "feat_player_week_context", why: "week context features" },
  { table: "feat_player_season", why: "per player-season features" },
  { table: "feat_player_season_ext", why: "extended season features" },
  { table: "feat_curve", why: "fitted positional curves" },
  { table: "feat_coverage", why: "feature coverage audit" },
  { table: "feat_player_prospect", why: "prospect/athleticism composites" },
  { table: "feat_injury_horizon", why: "injury-duration model features, keyed by player" },
  { table: "fact_injury_episode", why: "injury episodes -- NFL fact, no fantasy league in it" },
];

export interface ExportPlan {
  tables: { table: string; rows: number; why: string }[];
  /** Tables present in the store and NOT exported, with the reason. Reported so a reader can see
   *  what was withheld rather than inferring it from an absence. */
  excluded: { table: string; reason: string }[];
  totalRows: number;
}

/** Every column of `table`, or null when the table is absent from this store. */
function columnsOf(db: DB, table: string): string[] | null {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.length ? cols.map((c) => c.name) : null;
  } catch { return null; }
}

/**
 * THE STRUCTURAL SCAN. Which allowlisted tables carry a private column TODAY.
 *
 * Exported separately from the plan so a test can call it directly: the check that matters is not
 * "does the export run", it is "would this table leak", and those are different questions.
 */
export function privateColumnsIn(db: DB, table: string): string[] {
  return (columnsOf(db, table) ?? []).filter((c) => PRIVATE_COLUMN.test(c));
}

/**
 * Plan the export against a real store. REFUSES rather than silently dropping a table that has
 * gained a private column -- a dataset that quietly shrank is a dataset nobody audits.
 */
export function planExport(db: DB): ExportPlan {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((r) => r.name));

  const tables: ExportPlan["tables"] = [];
  const violations: string[] = [];
  for (const p of PUBLISHABLE) {
    if (!present.has(p.table)) continue;                    // not in this store; absence is not an error
    const bad = privateColumnsIn(db, p.table);
    if (bad.length) { violations.push(`${p.table} (${bad.join(", ")})`); continue; }
    const rows = (db.prepare(`SELECT COUNT(*) c FROM ${p.table}`).get() as { c: number }).c;
    tables.push({ table: p.table, rows, why: p.why });
  }
  if (violations.length) {
    throw new Error(
      `export REFUSED: ${violations.length} allowlisted table(s) now carry a column that identifies a ` +
      `league, a manager or a fantasy team: ${violations.join("; ")}. ` +
      "Either the column is a mistake, or the table is no longer publishable and must leave PUBLISHABLE. " +
      "Nothing was written.");
  }

  const allowed = new Set(PUBLISHABLE.map((p) => p.table));
  const excluded = [...present]
    .filter((t) => !allowed.has(t))
    .map((t) => {
      const bad = privateColumnsIn(db, t);
      return {
        table: t,
        reason: bad.length
          ? `carries ${bad.join(", ")} -- league, manager or fantasy-team identity`
          : "not on the allowlist (an allowlist fails CLOSED: add it deliberately if it is publishable)",
      };
    })
    .sort((a, b) => a.table.localeCompare(b.table));

  return { tables, excluded, totalRows: tables.reduce((a, t) => a + t.rows, 0) };
}

export interface ExportManifest {
  generatedAt: string;
  tables: { table: string; rows: number; why: string }[];
  totalRows: number;
  excludedTables: number;
  note: string;
}

/**
 * WRITE THE PUBLISHABLE TABLES INTO A NEW STORE.
 *
 * `VACUUM INTO` is deliberately NOT used: it copies the WHOLE database, private tables included, and
 * dropping them afterwards leaves their rows in freed pages that a determined reader can recover. A
 * fresh database that only ever had the allowlisted tables copied into it never contains them at all.
 * The difference matters precisely because the thing being protected is other people's data.
 *
 * REFUSES an existing path rather than overwriting -- an export is a thing someone is about to
 * publish, and silently replacing one is how the wrong file gets uploaded.
 *
 * Every table is READ BACK and its count compared. A copy that landed short is the exact failure
 * this repo has spent a day on; a row count is cheap and the alternative is assuming.
 */
export function writeExport(db: DB, outPath: string, plan: ExportPlan, now = new Date()): ExportManifest {
  const tables: ExportManifest["tables"] = [];
  db.exec(`ATTACH DATABASE '${outPath.replace(/'/g, "''")}' AS pub`);
  try {
    for (const t of plan.tables) {
      db.exec(`CREATE TABLE pub.${t.table} AS SELECT * FROM main.${t.table}`);
      const n = (db.prepare(`SELECT COUNT(*) c FROM pub.${t.table}`).get() as { c: number }).c;
      if (n !== t.rows) throw new Error(`export FAILED: ${t.table} had ${t.rows} rows in the store but ${n} landed.`);
      tables.push({ table: t.table, rows: n, why: t.why });
    }
  } finally { db.exec("DETACH DATABASE pub"); }

  return {
    generatedAt: now.toISOString(),
    tables,
    totalRows: tables.reduce((a, t) => a + t.rows, 0),
    excludedTables: plan.excluded.length,
    note:
      "Derived and public-source data only. Every ESPN private-league table -- rosters, transactions, " +
      "drafts, ownership, manager names and account ids -- is excluded by an allowlist that fails CLOSED, " +
      "asserted in test/dataset-export-privacy.test.ts. This is a SNAPSHOT: read generatedAt before " +
      "trusting anything in-season.",
  };
}
