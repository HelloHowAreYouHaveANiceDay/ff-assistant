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
  // THE COMMUNITY CROSSWALK, and the most important table in this export for anyone else.
  // DynastyProcess's map (served as `nflreadr::load_ff_playerids()` / `ffscrapr::dp_playerids()`)
  // is what the fantasy-data ecosystem joins on. Omitting it -- which the first version of this
  // allowlist did -- left the dataset keyed ONLY on a surrogate that means nothing outside this
  // snapshot. Every id in it is a PLAYER id; there is no league or manager in the table.
  { table: "player_ids", why: "the DynastyProcess cross-platform player id map (gsis/mfl/sportradar/pfr/sleeper/espn/yahoo/fantasypros)" },

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
  /** `dim_player_key`: how many players got a stable external id, and by which route. */
  keyDimension: { rows: number; byRoute: Record<string, number>; unkeyedFeatureRows: number };
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
 *
 * `db` MUST BE A WRITABLE HANDLE, even though nothing in `main` is modified: SQLite refuses to
 * ATTACH a writable database to a read-only connection. The CLI hides this because `openDb` is
 * read-write; a caller that opened the store read-only for safety gets `unable to open database`,
 * which names the TARGET and reads like a permissions problem with the output path.
 */
export function writeExport(db: DB, outPath: string, plan: ExportPlan, now = new Date()): ExportManifest {
  const tables: ExportManifest["tables"] = [];
  let keyDim: { rows: number; byRoute: Record<string, number>; unkeyedFeatureRows: number } = { rows: 0, byRoute: {}, unkeyedFeatureRows: 0 };
  db.exec(`ATTACH DATABASE '${outPath.replace(/'/g, "''")}' AS pub`);
  try {
    for (const t of plan.tables) {
      db.exec(`CREATE TABLE pub.${t.table} AS SELECT * FROM main.${t.table}`);
      const n = (db.prepare(`SELECT COUNT(*) c FROM pub.${t.table}`).get() as { c: number }).c;
      if (n !== t.rows) throw new Error(`export FAILED: ${t.table} had ${t.rows} rows in the store but ${n} landed.`);
      tables.push({ table: t.table, rows: n, why: t.why });
    }
    // THE KEY BRIDGE, last, because it reads the tables just copied.
    keyDim = buildKeyDimension(db);
  } finally { db.exec("DETACH DATABASE pub"); }

  return {
    generatedAt: now.toISOString(),
    tables,
    totalRows: tables.reduce((a, t) => a + t.rows, 0),
    excludedTables: plan.excluded.length,
    keyDimension: keyDim,
    note:
      "Derived and public-source data only. Every ESPN private-league table -- rosters, transactions, " +
      "drafts, ownership, manager names and account ids -- is excluded by an allowlist that fails CLOSED, " +
      "asserted in test/dataset-export-privacy.test.ts. This is a SNAPSHOT: read generatedAt before " +
      "trusting anything in-season.",
  };
}

/**
 * A RESOLVED KEY DIMENSION, built at export time: one row per `player_sk` in this snapshot,
 * carrying every external id we can reach for him.
 *
 * WHY IT IS BUILT RATHER THAN SHIPPED AS-IS. `player_sk` is a MINTED SURROGATE and it is
 * SNAPSHOT-LOCAL: an identity rebuild reassigns it. Measured on this store's own `identity_rekey`
 * log, a single rebuild moved 11,974 of 12,021 keys. So a consumer who joins release N on
 * `player_sk` and then upgrades to release N+1 silently joins the wrong players -- the worst kind of
 * breakage, because every row still matches something.
 *
 * The fix is not to stabilise `player_sk` (that is a change to the identity registry, not to an
 * export). It is to publish the BRIDGE, so nobody has to use the surrogate as a durable key:
 * `gsis_id` for NFL stats, `mfl_id` / `sportradar_id` / `pfr_id` / `sleeper_id` / `espn_id` /
 * `yahoo_id` / `fantasypros_id` for everything else. Those are stable across releases and across
 * tools, which is the entire point of the DynastyProcess crosswalk the community already shares.
 *
 * TWO RESOLUTION ROUTES, strongest first, and the route is RECORDED per row rather than assumed:
 *   1. `player_xref` gsis -> the crosswalk. Exact, and reaches 2,671 of 3,790 (70.5%).
 *   2. the staged `name_key` -> the crosswalk. Reaches 3,783 (99.8%).
 * Route 2 is a name join, which this repo distrusts on principle -- so it is applied ONLY after
 * route 1 has missed, and `resolved_by` says which was used so a consumer can discount the weaker
 * one. A row reachable by neither is still emitted, with nulls, rather than dropped: a player with
 * no external id is information, and silently shrinking the dimension would hide him.
 *
 * DST KEYS ARE ALREADY STABLE. `DST:ARI` is deterministic by construction, so it needs no bridge
 * and gets `resolved_by = 'dst-synthetic'`. That is worth saying out loud: the 32 defences are the
 * only keys in this dataset that are safe to join on directly across releases.
 */
export interface DuplicateKey { name: string; position: string; keyWithIds: string; orphanKey: string; orphanSeasons: string }

export function buildKeyDimension(db: DB): {
  rows: number; byRoute: Record<string, number>; unkeyedFeatureRows: number; duplicates: DuplicateKey[];
} {
  db.exec("DROP TABLE IF EXISTS pub.dim_player_key");
  db.exec(`CREATE TABLE pub.dim_player_key (
    player_sk TEXT PRIMARY KEY, name TEXT, position TEXT, resolved_by TEXT,
    gsis_id TEXT, mfl_id TEXT, sportradar_id TEXT, pfr_id TEXT,
    sleeper_id TEXT, espn_id TEXT, yahoo_id TEXT, fantasypros_id TEXT)`);

  db.exec(`INSERT INTO pub.dim_player_key
    SELECT k.player_sk, k.name, k.pos,
      CASE WHEN k.player_sk LIKE 'DST:%' THEN 'dst-synthetic'
           WHEN g.gsis_id IS NOT NULL THEN 'xref-gsis'
           WHEN n.name_key IS NOT NULL THEN 'staged-name-key'
           WHEN d.sk IS NOT NULL THEN 'xref-direct'
           ELSE 'unresolved' END,
      COALESCE(g.gsis_id, n.gsis_id, d.gsis_id), COALESCE(g.mfl_id, n.mfl_id),
      COALESCE(g.sportradar_id, n.sportradar_id), COALESCE(g.pfr_id, n.pfr_id, d.pfr_id),
      COALESCE(g.sleeper_id, n.sleeper_id, d.sleeper_id), COALESCE(g.espn_id, n.espn_id, d.espn_id),
      COALESCE(g.yahoo_id, n.yahoo_id), COALESCE(g.fantasypros_id, n.fantasypros_id, d.fantasypros_id)
    -- ONE ROW PER KEY. SELECT DISTINCT player_sk, name, pos fanned out: 45 keys carry more than
    -- one (name, pos) across the season -- a position reclassification, a name respelling -- and a
    -- key with NULL sk carries 154. Both broke the PRIMARY KEY. Grouping by the key is the fix; the
    -- NULL keys are dropped here because a row with no key cannot be put in a key dimension, and
    -- they are COUNTED in the manifest rather than silently disappearing.
    FROM (SELECT player_sk, MIN(name) name, MIN(pos) pos FROM main.feat_player_week
           WHERE player_sk IS NOT NULL GROUP BY player_sk) k
    LEFT JOIN (
      SELECT x.player_sk AS sk, MIN(p.gsis_id) gsis_id, MIN(p.mfl_id) mfl_id,
             MIN(p.sportradar_id) sportradar_id, MIN(p.pfr_id) pfr_id, MIN(p.sleeper_id) sleeper_id,
             MIN(p.espn_id) espn_id, MIN(p.yahoo_id) yahoo_id, MIN(p.fantasypros_id) fantasypros_id
        FROM main.player_xref x JOIN main.player_ids p ON p.gsis_id = x.source_id
       WHERE x.source='gsis' GROUP BY x.player_sk) g
      ON g.sk = CAST(k.player_sk AS INTEGER) AND k.player_sk NOT LIKE 'DST:%'
    LEFT JOIN (
      -- AMBIGUOUS NAME KEYS ARE EXCLUDED, not resolved. player_ids.ambiguous marks a name key
      -- shared by more than one real player, and joining on one would attach somebody elses ids
      -- silently, to a row that still looks fully populated. That is worse than a null, so the
      -- row stays unresolved and says so. GROUP BY because a name key can still reach several
      -- staged rows; MIN is arbitrary among identical ids and the ambiguous ones are already gone.
      SELECT s.player_sk AS sk, MIN(p.gsis_id) gsis_id, MIN(p.mfl_id) mfl_id,
             MIN(p.sportradar_id) sportradar_id, MIN(p.pfr_id) pfr_id, MIN(p.sleeper_id) sleeper_id,
             MIN(p.espn_id) espn_id, MIN(p.yahoo_id) yahoo_id, MIN(p.fantasypros_id) fantasypros_id,
             MIN(p.name_key) name_key
        FROM main.stg_player s JOIN main.player_ids p ON p.name_key = s.name_key
       WHERE COALESCE(p.ambiguous, 0) = 0
       GROUP BY s.player_sk) n
      ON n.sk = CAST(k.player_sk AS INTEGER) AND k.player_sk NOT LIKE 'DST:%'
    LEFT JOIN (
      -- THE IDS THE REGISTRY ALREADY HOLDS FOR THIS EXACT KEY (reported 2026-09-19).
      --
      -- Both routes above reach an id only THROUGH player_ids -- the first uses a gsis from
      -- player_xref as a lookup key into it, the second a name key. A player the DynastyProcess map
      -- does not carry therefore came out "unresolved" with every column NULL even though
      -- player_xref held five perfectly good stable ids for that same player_sk. 38 of the 96
      -- unresolved keys were in exactly that state.
      --
      -- Marvin Harrison Jr. is the case that shows why this route has to exist rather than the name
      -- route being loosened: player_ids has no row for his gsis, and his name key resolves to
      -- Marvin Harrison SR., which is correctly marked "ambiguous" and correctly refused above.
      -- The only safe ids for him are the ones the identity registry already attached to his key.
      --
      -- It is LAST in every COALESCE, so no row that either player_ids route resolved changes its
      -- ids; this only fills nulls. player_xref carries five sources, so mfl, sportradar and yahoo
      -- are not reachable this way and stay NULL -- five ids beat none, and a partial row says which
      -- route produced it.
      SELECT x.player_sk AS sk,
             MIN(CASE WHEN x.source = 'gsis'        THEN x.source_id END) gsis_id,
             MIN(CASE WHEN x.source = 'pfr'         THEN x.source_id END) pfr_id,
             MIN(CASE WHEN x.source = 'sleeper'     THEN x.source_id END) sleeper_id,
             MIN(CASE WHEN x.source = 'espn'        THEN x.source_id END) espn_id,
             MIN(CASE WHEN x.source = 'fantasypros' THEN x.source_id END) fantasypros_id
        FROM main.player_xref x GROUP BY x.player_sk) d
      ON d.sk = CAST(k.player_sk AS INTEGER) AND k.player_sk NOT LIKE 'DST:%'`);

  const rows = (db.prepare("SELECT COUNT(*) c FROM pub.dim_player_key").get() as { c: number }).c;
  // Rows the feature table could not key at all. Reported, because "the dimension has 3,823 rows"
  // and "3,823 of 3,977 players are keyable" are different claims and only one of them is true.
  const unkeyed = (db.prepare(
    "SELECT COUNT(*) c FROM main.feat_player_week WHERE player_sk IS NULL").get() as { c: number }).c;
  const byRoute: Record<string, number> = {};
  for (const r of db.prepare("SELECT resolved_by, COUNT(*) n FROM pub.dim_player_key GROUP BY resolved_by").all() as { resolved_by: string; n: number }[]) {
    byRoute[r.resolved_by] = r.n;
  }
  // ---- DUPLICATE KEYS FROM AN IDENTITY REBUILD, REPORTED AND NOT MERGED (2026-09-19) ----------
  //
  // A rebuild can mint a SECOND key for a player without reattaching his xref rows, and the new key
  // is the one carrying the current season. The dimension then covers the old key -- fully populated,
  // looking healthy -- while a consumer joining on it silently loses this year.
  //
  // THEY ARE REPORTED RATHER THAN COLLAPSED, and the reason is in the data. Merging on (name,
  // position) looks obviously right and is not: `Irv Smith TE` is TWO PEOPLE, the 1999 rows and the
  // 2019-2023 rows, and a merge on that pair would fuse a father and a son into one player who
  // played across four decades. `player_ids` already marks that name key "ambiguous" and both id
  // routes already refuse it, which is the same judgement reached deliberately upstream.
  //
  // Nor can these keys be rescued by an id route: the ones seen here carry NO player_xref rows and
  // NO player_ids row for their name key, so there is nothing to attach. Inventing a link would be
  // the exact failure this dimension exists to prevent -- a row that still looks fully populated
  // while pointing at somebody else. So the export STATES the defect and lets the consumer decide.
  const duplicates = db.prepare(`
    SELECT a.name AS name, a.pos AS position, a.player_sk AS keyWithIds, b.player_sk AS orphanKey,
           (SELECT GROUP_CONCAT(DISTINCT f.season) FROM main.feat_player_week f
             WHERE f.player_sk = b.player_sk) AS orphanSeasons
      FROM (SELECT player_sk, MIN(name) name, MIN(pos) pos FROM main.feat_player_week
             WHERE player_sk IS NOT NULL GROUP BY player_sk) a
      JOIN (SELECT player_sk, MIN(name) name, MIN(pos) pos FROM main.feat_player_week
             WHERE player_sk IS NOT NULL GROUP BY player_sk) b
        ON a.name = b.name AND a.pos = b.pos
       AND CAST(a.player_sk AS INTEGER) < CAST(b.player_sk AS INTEGER)
     WHERE a.player_sk NOT LIKE 'DST:%'
       AND EXISTS (SELECT 1 FROM main.player_xref x WHERE x.player_sk = CAST(a.player_sk AS INTEGER))
       AND NOT EXISTS (SELECT 1 FROM main.player_xref x WHERE x.player_sk = CAST(b.player_sk AS INTEGER))
     ORDER BY a.name`).all() as DuplicateKey[];

  return { rows, byRoute, unkeyedFeatureRows: unkeyed, duplicates };
}
