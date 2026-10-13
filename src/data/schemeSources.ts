/**
 * SCHEME RAW INGESTERS (2026-10-12) -- the play-grain tables behind the "scheme fit" question.
 *
 * Three feeds, three tables, one function each, same rules as src/data/rawSources.ts (exactly what the
 * source gave, no identity resolution, `as_of` = the game day from raw_nfl_game, a season that 404s is
 * recorded not thrown). All three are keyed by the nflverse (season, game_id, play_id), so the feature
 * layer can join "which coverage was this" (raw_play_scheme), "was it play-action" (raw_ftn_play) and
 * "who was targeted, what happened" (raw_pbp_play) without a name join. See the schema comment above
 * raw_play_scheme for why the play grain is kept this time.
 *
 * Each row mapper is a PURE function (row -> record | null), unit-tested on synthetic rows in
 * test/schemeSources.test.ts; the ingesters only wrap them in the fetch/cache loop.
 *
 * COVERAGE, measured 2026-10-12 against the nflverse release API:
 *   raw_play_scheme  2016-2025 (pbp_participation; NO 2026 file is published)
 *   raw_ftn_play     2022-2026 (live season included, ~1 week behind)
 *   raw_pbp_play     2016-2026 (live season included)
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import { canonTeam, pick, participationUrl, pbpUrl, ftnUrl, rawTag } from "./nflverse.js";
import { num, int, str, perSeasonFeed, seasonRange, totalOf, type IngestReport } from "./rawSources.js";

/** "TRUE"/"true"/"1"/"1.0" -> 1, "FALSE"/"0" -> 0, anything else (NA, blank) -> null. */
export function bool01(s: string): number | null {
  if (s == null) return null;
  const t = s.trim().toLowerCase();
  if (t === "true") return 1;
  if (t === "false") return 0;
  const n = num(s);
  return n == null ? null : (n !== 0 ? 1 : 0);
}

type Rec = Record<string, string | number | null>;

/** An upsert over `cols` keyed by (season, game_id, play_id); every other column is overwritten. */
function upsert(db: DB, table: string, cols: string[]) {
  const key = new Set(["season", "game_id", "play_id"]);
  const all = [...cols, "fetched_at"];
  return db.prepare(
    `INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map((c) => "@" + c).join(", ")})
     ON CONFLICT(season, game_id, play_id) DO UPDATE SET
       ${all.filter((c) => !key.has(c)).map((c) => `${c}=excluded.${c}`).join(", ")}`,
  );
}

function gameMeta(db: DB): Map<string, { week: number | null; gameday: string | null }> {
  const m = new Map<string, { week: number | null; gameday: string | null }>();
  for (const g of db.prepare("SELECT game_id, week, gameday FROM raw_nfl_game").all() as { game_id: string; week: number | null; gameday: string | null }[]) {
    m.set(g.game_id, { week: g.week, gameday: g.gameday });
  }
  return m;
}

// ==================================================================================================
// raw_play_scheme -- nflverse pbp_participation, play grain.
// ==================================================================================================

export const SCHEME_COLS = [
  "season", "week", "game_id", "play_id", "team", "as_of",
  "offense_formation", "offense_personnel", "defense_personnel",
  "defenders_in_box", "number_of_pass_rushers", "n_offense", "n_defense",
  "ngs_air_yards", "time_to_throw", "was_pressure",
  "route", "defense_man_zone_type", "defense_coverage_type",
];

/** PURE. A participation row -> a raw_play_scheme record, or null when it cannot be keyed. The week
 *  comes from raw_nfl_game (the participation file carries none). */
export function mapSchemePlay(season: number, r: Record<string, string>, meta: Map<string, { week: number | null; gameday: string | null }>): Rec | null {
  const gameId = str(pick(r, "nflverse_game_id")); const playId = int(pick(r, "play_id"));
  if (!gameId || playId == null) return null;
  const m = meta.get(gameId);
  return {
    season, week: m?.week ?? null, game_id: gameId, play_id: playId,
    team: canonTeam(pick(r, "possession_team")) || null, as_of: m?.gameday ?? null,
    offense_formation: str(pick(r, "offense_formation")), offense_personnel: str(pick(r, "offense_personnel")),
    defense_personnel: str(pick(r, "defense_personnel")),
    defenders_in_box: int(pick(r, "defenders_in_box")), number_of_pass_rushers: int(pick(r, "number_of_pass_rushers")),
    n_offense: int(pick(r, "n_offense")), n_defense: int(pick(r, "n_defense")),
    ngs_air_yards: num(pick(r, "ngs_air_yards")), time_to_throw: num(pick(r, "time_to_throw")),
    was_pressure: bool01(pick(r, "was_pressure")),
    route: str(pick(r, "route")), defense_man_zone_type: str(pick(r, "defense_man_zone_type")),
    defense_coverage_type: str(pick(r, "defense_coverage_type")),
  };
}

export async function ingestRawPlayScheme(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  try {
    const now = nowIso(); const meta = gameMeta(db); const ins = upsert(db, "raw_play_scheme", SCHEME_COLS);
    const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 2016), participationUrl, rawTag.participation, opts.refresh ?? false, (season, rows) => {
      let n = 0;
      for (const r of rows) { const rec = mapSchemePlay(season, r, meta); if (!rec) continue; ins.run({ ...rec, fetched_at: now }); n++; }
      return n;
    });
    return { table: "raw_play_scheme", seasons, total: totalOf(seasons) };
  } finally { db.close(); }
}

// ==================================================================================================
// raw_ftn_play -- FTN charting, play grain.
// ==================================================================================================

const FTN_BOOLS = [
  "is_no_huddle", "is_motion", "is_play_action", "is_screen_pass", "is_rpo", "is_trick_play",
  "is_qb_out_of_pocket", "is_interception_worthy", "is_throw_away", "is_catchable_ball",
  "is_contested_ball", "is_created_reception", "is_drop", "is_qb_sneak", "is_qb_fault_sack",
];
export const FTN_COLS = [
  "season", "week", "game_id", "play_id", "as_of", "ftn_play_id",
  "starting_hash", "qb_location", "n_offense_backfield", "n_defense_box",
  ...FTN_BOOLS, "read_thrown", "n_blitzers", "n_pass_rushers", "date_pulled",
];

/** PURE. An FTN row -> a raw_ftn_play record keyed by the NFLVERSE play id, or null if unkeyable. */
export function mapFtnPlay(season: number, r: Record<string, string>, meta: Map<string, { week: number | null; gameday: string | null }>): Rec | null {
  const gameId = str(pick(r, "nflverse_game_id")); const playId = int(pick(r, "nflverse_play_id"));
  if (!gameId || playId == null) return null;
  const m = meta.get(gameId);
  const rec: Rec = {
    season, week: int(pick(r, "week")) ?? m?.week ?? null, game_id: gameId, play_id: playId,
    as_of: m?.gameday ?? null, ftn_play_id: int(pick(r, "ftn_play_id")),
    starting_hash: str(pick(r, "starting_hash")), qb_location: str(pick(r, "qb_location")),
    n_offense_backfield: int(pick(r, "n_offense_backfield")), n_defense_box: int(pick(r, "n_defense_box")),
    read_thrown: str(pick(r, "read_thrown")), n_blitzers: int(pick(r, "n_blitzers")),
    n_pass_rushers: int(pick(r, "n_pass_rushers")), date_pulled: str(pick(r, "date_pulled")),
  };
  for (const b of FTN_BOOLS) rec[b] = bool01(pick(r, b));
  return rec;
}

export async function ingestRawFtn(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  try {
    const now = nowIso(); const meta = gameMeta(db); const ins = upsert(db, "raw_ftn_play", FTN_COLS);
    const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 2022), ftnUrl, rawTag.ftn, opts.refresh ?? false, (season, rows) => {
      let n = 0;
      for (const r of rows) { const rec = mapFtnPlay(season, r, meta); if (!rec) continue; ins.run({ ...rec, fetched_at: now }); n++; }
      return n;
    });
    return { table: "raw_ftn_play", seasons, total: totalOf(seasons) };
  } finally { db.close(); }
}

// ==================================================================================================
// raw_pbp_play -- slim play grain from nflverse play-by-play.
// ==================================================================================================

export const PBP_PLAY_COLS = [
  "season", "week", "game_id", "play_id", "as_of", "season_type", "posteam", "defteam", "play_type",
  "qtr", "down", "ydstogo", "yardline_100", "score_differential", "wp",
  "shotgun", "no_huddle", "qb_dropback", "qb_scramble", "sack",
  "pass_attempt", "rush_attempt", "complete_pass",
  "pass_length", "pass_location", "run_location", "run_gap",
  "passer_id", "receiver_id", "rusher_id",
  "yards_gained", "air_yards", "yards_after_catch", "epa", "touchdown",
  "cp", "xpass", "pass_oe",
];

/** PURE. A pbp row -> a raw_pbp_play record. Only SCRIMMAGE plays (a pass or a run, sacks and
 *  scrambles included as the source flags them) are kept; kicks, timeouts, penalties-only -> null. */
export function mapPbpPlay(season: number, r: Record<string, string>, gameday: Map<string, string | null>): Rec | null {
  const gameId = str(pick(r, "game_id")); const playId = int(pick(r, "play_id"));
  if (!gameId || playId == null) return null;
  const pt = str(pick(r, "play_type"));
  const passAtt = bool01(pick(r, "pass_attempt")), rushAtt = bool01(pick(r, "rush_attempt"));
  if (pt !== "pass" && pt !== "run" && passAtt !== 1 && rushAtt !== 1) return null;
  return {
    season, week: int(pick(r, "week")), game_id: gameId, play_id: playId, as_of: gameday.get(gameId) ?? null,
    season_type: str(pick(r, "season_type")), posteam: canonTeam(pick(r, "posteam")) || null,
    defteam: canonTeam(pick(r, "defteam")) || null, play_type: pt,
    qtr: int(pick(r, "qtr")), down: int(pick(r, "down")), ydstogo: int(pick(r, "ydstogo")),
    yardline_100: int(pick(r, "yardline_100")), score_differential: int(pick(r, "score_differential")), wp: num(pick(r, "wp")),
    shotgun: bool01(pick(r, "shotgun")), no_huddle: bool01(pick(r, "no_huddle")), qb_dropback: bool01(pick(r, "qb_dropback")),
    qb_scramble: bool01(pick(r, "qb_scramble")), sack: bool01(pick(r, "sack")),
    pass_attempt: passAtt, rush_attempt: rushAtt, complete_pass: bool01(pick(r, "complete_pass")),
    pass_length: str(pick(r, "pass_length")), pass_location: str(pick(r, "pass_location")),
    run_location: str(pick(r, "run_location")), run_gap: str(pick(r, "run_gap")),
    passer_id: str(pick(r, "passer_player_id")), receiver_id: str(pick(r, "receiver_player_id")), rusher_id: str(pick(r, "rusher_player_id")),
    yards_gained: num(pick(r, "yards_gained")), air_yards: num(pick(r, "air_yards")), yards_after_catch: num(pick(r, "yards_after_catch")),
    epa: num(pick(r, "epa")), touchdown: bool01(pick(r, "touchdown")),
    cp: num(pick(r, "cp")), xpass: num(pick(r, "xpass")), pass_oe: num(pick(r, "pass_oe")),
  };
}

export async function ingestRawPbpPlay(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  try {
    const now = nowIso();
    const gameday = new Map<string, string | null>();
    for (const [id, m] of gameMeta(db)) gameday.set(id, m.gameday);
    const ins = upsert(db, "raw_pbp_play", PBP_PLAY_COLS);
    const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 2016), pbpUrl, rawTag.pbp, opts.refresh ?? false, (season, rows) => {
      let n = 0;
      for (const r of rows) { const rec = mapPbpPlay(season, r, gameday); if (!rec) continue; ins.run({ ...rec, fetched_at: now }); n++; }
      return n;
    });
    return { table: "raw_pbp_play", seasons, total: totalOf(seasons) };
  } finally { db.close(); }
}
