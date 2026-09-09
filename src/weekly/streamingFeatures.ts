/**
 * WHAT THE OPPONENT ALLOWS, AS OF THE WEEK -- the point-in-time streaming feature view.
 *
 * `feat_player_week_model` (src/weekly/features.ts) answers "what do we know about this PLAYER before
 * kickoff". This table answers the other half of a streaming decision: "what do we know about the
 * team he is playing, and about the stadium he is playing in". They are two tables rather than twelve
 * more columns on one because they have different SOURCES (a team-level stats feed rather than the
 * player-week facts), a different failure mode (a feed that does not cover a season leaves twelve
 * columns NULL at once) and a different owner -- and because a new column on a table another track is
 * building concurrently is a merge conflict waiting to happen.
 *
 * THE POINT-IN-TIME RULE IS THE SAME ONE AND IT IS THE WHOLE JOB.
 *
 *   as_of = the day BEFORE the week's FIRST kickoff anywhere in the league.
 *
 * Every accumulated column here is bounded by `week < w` of season Y, blended with ALL of Y-1, and
 * shrunk toward the league mean over the same current window. The `week < w` bound is doing all the
 * work: the same statistic computed "for season Y" is a one-character difference in a GROUP BY, it
 * raises no error, and it puts week w's own result inside week w's feature. `scripts/streaming-leak-
 * audit.mjs` recomputes these columns independently and moves the bound to `<= w` as a positive
 * control; `test/streaming-leakage.test.ts` perturbs week w's own source rows and asserts nothing in
 * week w moved, with `leakOpponentThroughWeek` as the fault injection that proves the guard can fire.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY SAYING SO MATTERS MORE THAN THE COLUMN WOULD.
 *
 *   TEMPERATURE AND WIND. `raw_nfl_game` carries `temp` and `wind` and schema.sql says out loud what
 *   they are: OBSERVED, "not knowable before kickoff at all". A forecast is a different quantity from
 *   an observation and this store holds no forecast feed -- so the columns are NOT built. Building
 *   them from the observed values would be the single most attractive leak available here: wind is a
 *   real and large effect on a kicker, the model would find it, and every backtest number would
 *   improve for a reason that cannot exist on a Saturday. `roof` is on the same table and IS built,
 *   because a stadium's roof is knowable when the schedule is published.
 *
 *   RED-ZONE DRIVE RATE, for the kicker. There is no drive-level feed in this store, and a "red-zone
 *   rate" assembled from box-score totals would be an invented quantity wearing the name of a
 *   measured one. What the kicker's opportunity actually is -- how often his own team lines up a
 *   field goal and an extra point -- IS in the team-week feed, so `team_fga_pg` and `team_pat_pg` are
 *   built instead and the substitution is stated here rather than in a footnote.
 *
 *   HOME, DAYS_REST and the player's own TEAM IMPLIED TOTAL. All three already exist on
 *   `feat_player_week_model` (`home`, `days_rest`, `implied_team_total`) under the same as-of rule. A
 *   second copy under a second name would be two features fitting one effect and splitting its
 *   coefficient, which is exactly the reading problem W6 ran into one horizon up.
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import { fetchCsvCached, teamWeekUrl, cacheTag, canonTeam, pick } from "../data/nflverse.js";
import { WEEKLY_POS } from "./features.js";
import { STREAM_FIELDS, STREAM_FIELD_NAMES, presentStreamFields } from "./streamingFields.js";

export { STREAM_FIELDS, STREAM_FIELD_NAMES, presentStreamFields };

/**
 * THE BLEND, and it is the same shape `dvpTable` uses one file over, deliberately.
 *
 * value = [ n_cur * mean_cur + PRIOR_WEIGHT * mean_prior + SHRINK * leagueMean ] / (sum of weights)
 *
 * `n_cur` is the number of team-games inside season Y that are STRICTLY BEFORE week w, so week 1
 * carries no current-season term at all and the column is last year's defence pulled toward the
 * league -- weak evidence rather than no evidence, which is the honest state of a week-1 matchup.
 * The shrink target is the LEAGUE MEAN over the same window rather than 1.0, because these columns
 * are in absolute units (points, sacks, yards) and not ratios; a ratio would hide the scale that
 * makes an opponent's implied total comparable to a kicker's field-goal rate.
 */
export const STREAM_SHRINK = 4;
export const STREAM_PRIOR_WEIGHT = 6;

const finite = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : x;

const numOf = (v: unknown): number | null => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "NA" || s === "NULL") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ==================================================================================================
// THE TEAM-WEEK FEED.
// ==================================================================================================

/** One team's box-score line for one game, reduced to the eight quantities this table needs. */
export interface TeamWeekRow {
  season: number;
  week: number;
  team: string;
  opponent: string | null;
  passYards: number | null;
  rushYards: number | null;
  sacksSuffered: number | null;
  giveaways: number | null;
  defSacks: number | null;
  defTakeaways: number | null;
  fgAtt: number | null;
  patAtt: number | null;
}

/**
 * Read nflverse `stats_team_week_<season>.csv` for the seasons asked for AND their predecessors.
 *
 * A MISSING SEASON IS RETURNED AS NOTHING, NOT AS ZERO. `fetchCsvCached` throws on a 404 and every
 * caller in this repo wraps a feed fetch in a swallow, which is right for a season that does not
 * exist and indistinguishable from a typo in the filename -- so the count of rows actually read is
 * returned beside the rows, and `buildStreamInto` reports it per season. A column that is NULL
 * because the feed is missing and a column that is NULL because a team had no game are the same
 * value; the coverage table is the only thing that separates them.
 */
export async function loadTeamWeek(seasons: number[]): Promise<{ rows: TeamWeekRow[]; bySeason: Map<number, number> }> {
  const want = [...new Set(seasons.flatMap((y) => [y - 1, y]))].sort((a, b) => a - b);
  const rows: TeamWeekRow[] = [];
  const bySeason = new Map<number, number>();
  for (const y of want) {
    let raw: Record<string, string>[] = [];
    try {
      raw = await fetchCsvCached(teamWeekUrl(y), cacheTag.teamWeek(y));
    } catch {
      bySeason.set(y, 0);
      continue;
    }
    let n = 0;
    for (const r of raw) {
      // REG only. A playoff week carries the same week numbers in some feeds and would silently
      // append postseason games to a regular-season average.
      const type = String(pick(r, "season_type") ?? "").toUpperCase();
      if (type && type !== "REG") continue;
      const week = numOf(pick(r, "week"));
      const team = canonTeam(String(pick(r, "team") ?? ""));
      if (!week || !team) continue;
      const ints = numOf(r.passing_interceptions);
      const fumLost = numOf(r.fumbles_lost_total);
      const defInt = numOf(r.def_interceptions);
      const defFumRec = numOf(r.fumble_recovery_opp);
      rows.push({
        season: y, week,
        team,
        opponent: (() => { const o = String(pick(r, "opponent_team") ?? ""); return o ? canonTeam(o) : null; })(),
        passYards: numOf(r.passing_yards),
        rushYards: numOf(r.rushing_yards),
        sacksSuffered: numOf(r.sacks_suffered),
        // A giveaway is an interception thrown plus a fumble LOST. `fumbles_total` counts fumbles
        // the offence recovered itself, which cost it nothing and is not a takeaway for anybody.
        giveaways: ints == null && fumLost == null ? null : (ints ?? 0) + (fumLost ?? 0),
        defSacks: numOf(r.def_sacks),
        // A TAKEAWAY is an interception plus an OPPONENT'S fumble recovered. `def_fumbles` in this
        // feed is fumbles the defence was involved in, not possessions gained, and using it would
        // count a forced fumble the offence fell on as a turnover that never happened.
        defTakeaways: defInt == null && defFumRec == null ? null : (defInt ?? 0) + (defFumRec ?? 0),
        fgAtt: numOf(r.fg_att),
        patAtt: numOf(r.pat_att),
      });
      n++;
    }
    bySeason.set(y, n);
  }
  return { rows, bySeason };
}

// ==================================================================================================
// THE ACCUMULATORS.
// ==================================================================================================

/** One blended, shrunk team quantity, looked up by (week, team). */
interface TeamStat { get(week: number, team: string): number | null }

/**
 * Build a point-in-time blended accumulator for ONE team-level quantity.
 *
 * `valueOf` extracts the quantity from a team's own box-score line; `attributeTo` says whose column
 * it belongs to -- the team itself (its own offence, its own kicking) or its opponent (what a defence
 * allowed). Separating those two is the whole reason this is one function rather than eight copies:
 * "passing yards allowed by T" is "the passing yards of whoever played T", and getting that
 * inversion wrong in one of eight hand-written loops is a bug nothing would notice.
 */
function teamAccumulator(
  cur: TeamWeekRow[], prior: TeamWeekRow[], maxWeek: number,
  valueOf: (r: TeamWeekRow) => number | null,
  attributeTo: "self" | "opponent",
): TeamStat {
  const keyOf = (r: TeamWeekRow): string | null => (attributeTo === "self" ? r.team : r.opponent);

  // Per (team, week) sums inside season Y, then prefix-summed ONCE. A per-call re-scan with its own
  // bound is how one call site ends up including week w.
  const sumByWeek = new Map<string, number>();     // `${team}|${week}`
  const gamesByWeek = new Map<string, number>();
  const leagueByWeek = new Map<number, number>();
  const leagueGamesByWeek = new Map<number, number>();
  for (const r of cur) {
    const k = keyOf(r); const v = valueOf(r);
    if (!k || v == null) continue;
    sumByWeek.set(`${k}|${r.week}`, (sumByWeek.get(`${k}|${r.week}`) ?? 0) + v);
    gamesByWeek.set(`${k}|${r.week}`, (gamesByWeek.get(`${k}|${r.week}`) ?? 0) + 1);
    leagueByWeek.set(r.week, (leagueByWeek.get(r.week) ?? 0) + v);
    leagueGamesByWeek.set(r.week, (leagueGamesByWeek.get(r.week) ?? 0) + 1);
  }
  const teams = new Set([...sumByWeek.keys()].map((s) => s.split("|")[0]));
  const preSum = new Map<string, number[]>(), preGames = new Map<string, number[]>();
  for (const t of teams) {
    const s = new Array(maxWeek + 1).fill(0), g = new Array(maxWeek + 1).fill(0);
    for (let w = 1; w <= maxWeek; w++) {
      s[w] = s[w - 1] + (sumByWeek.get(`${t}|${w}`) ?? 0);
      g[w] = g[w - 1] + (gamesByWeek.get(`${t}|${w}`) ?? 0);
    }
    preSum.set(t, s); preGames.set(t, g);
  }
  const preLg = new Array(maxWeek + 1).fill(0), preLgG = new Array(maxWeek + 1).fill(0);
  for (let w = 1; w <= maxWeek; w++) {
    preLg[w] = preLg[w - 1] + (leagueByWeek.get(w) ?? 0);
    preLgG[w] = preLgG[w - 1] + (leagueGamesByWeek.get(w) ?? 0);
  }

  // The PRIOR season, whole-season, per team; plus its league mean, which is the fallback shrink
  // target in week 1 where the current window is empty and has no league mean of its own.
  const priorSum = new Map<string, number>(), priorGames = new Map<string, number>();
  let priorLg = 0, priorLgG = 0;
  for (const r of prior) {
    const k = keyOf(r); const v = valueOf(r);
    if (!k || v == null) continue;
    priorSum.set(k, (priorSum.get(k) ?? 0) + v);
    priorGames.set(k, (priorGames.get(k) ?? 0) + 1);
    priorLg += v; priorLgG++;
  }
  const priorLeagueMean = priorLgG > 0 ? priorLg / priorLgG : null;

  return {
    get(week, team) {
      const upTo = Math.min(Math.max(week - 1, 0), maxWeek);   // STRICTLY BEFORE week w.
      const n = upTo > 0 ? (preGames.get(team)?.[upTo] ?? 0) : 0;
      const lgG = upTo > 0 ? preLgG[upTo] : 0;
      const leagueMean = lgG > 0 ? preLg[upTo] / lgG : priorLeagueMean;
      // No league mean from either window means this quantity has no evidence at all in this store.
      // NULL says that; a zero would say "the league allows nothing", which no consumer could tell
      // apart from a measured value.
      if (leagueMean == null) return null;
      const terms: [number, number][] = [[STREAM_SHRINK, leagueMean]];
      if (n > 0) terms.push([n, (preSum.get(team)?.[upTo] ?? 0) / n]);
      const pg = priorGames.get(team) ?? 0;
      if (pg > 0) terms.push([STREAM_PRIOR_WEIGHT, (priorSum.get(team) ?? 0) / pg]);
      const wsum = terms.reduce((s, t) => s + t[0], 0);
      return wsum > 0 ? terms.reduce((s, t) => s + t[0] * t[1], 0) / wsum : null;
    },
  };
}

/**
 * Fantasy points allowed per game, per (opponent defence, position), in POINTS.
 *
 * `dvpTable` in features.ts is the RATIO version of this and is already a declared feature. This is
 * the absolute one, and the difference is not cosmetic for a streaming decision: a multiplier of 1.15
 * means one thing against a quarterback and another against a defence, and the K and DST heads have
 * no per-player line to multiply it back onto in the first place -- they were two intercepts, which
 * is exactly what section 3 of docs/weekly.md reports as the reason those two positions were a tie.
 */
function paByPos(
  cur: { week: number; opponent: string | null; pos: string; pts: number | null }[],
  prior: { week: number; opponent: string | null; pos: string; pts: number | null }[],
  maxWeek: number,
): { get(week: number, team: string, pos: string): { value: number | null; n: number } } {
  const sumByWeek = new Map<string, number>();      // `${team}|${pos}|${week}`
  const facedByWeek = new Map<string, number>();    // `${team}|${week}` -> 1
  const lgByWeek = new Map<string, number>();       // `${pos}|${week}`
  const lgFacedByWeek = new Map<number, number>();
  for (const r of cur) {
    if (!r.opponent || r.pts == null) continue;
    sumByWeek.set(`${r.opponent}|${r.pos}|${r.week}`, (sumByWeek.get(`${r.opponent}|${r.pos}|${r.week}`) ?? 0) + r.pts);
    facedByWeek.set(`${r.opponent}|${r.week}`, 1);
    lgByWeek.set(`${r.pos}|${r.week}`, (lgByWeek.get(`${r.pos}|${r.week}`) ?? 0) + r.pts);
  }
  for (const k of facedByWeek.keys()) {
    const w = Number(k.split("|")[1]);
    lgFacedByWeek.set(w, (lgFacedByWeek.get(w) ?? 0) + 1);
  }
  const pre = (m: Map<string, number>, keys: Set<string>) => {
    const out = new Map<string, number[]>();
    for (const k of keys) {
      const a = new Array(maxWeek + 1).fill(0);
      for (let w = 1; w <= maxWeek; w++) a[w] = a[w - 1] + (m.get(`${k}|${w}`) ?? 0);
      out.set(k, a);
    }
    return out;
  };
  const preSum = pre(sumByWeek, new Set([...sumByWeek.keys()].map((s) => s.split("|").slice(0, 2).join("|"))));
  const preFaced = pre(facedByWeek, new Set([...facedByWeek.keys()].map((s) => s.split("|")[0])));
  const preLg = pre(lgByWeek, new Set([...lgByWeek.keys()].map((s) => s.split("|")[0])));
  const preLgFaced = new Array(maxWeek + 1).fill(0);
  for (let w = 1; w <= maxWeek; w++) preLgFaced[w] = preLgFaced[w - 1] + (lgFacedByWeek.get(w) ?? 0);

  // Prior season, whole season.
  const pSum = new Map<string, number>(), pFaced = new Map<string, number>(), pLg = new Map<string, number>();
  const seenTw = new Set<string>();
  let pTeamWeeks = 0;
  for (const r of prior) {
    if (!r.opponent || r.pts == null) continue;
    pSum.set(`${r.opponent}|${r.pos}`, (pSum.get(`${r.opponent}|${r.pos}`) ?? 0) + r.pts);
    pLg.set(r.pos, (pLg.get(r.pos) ?? 0) + r.pts);
    const tw = `${r.opponent}|${r.week}`;
    if (!seenTw.has(tw)) { seenTw.add(tw); pTeamWeeks++; pFaced.set(r.opponent, (pFaced.get(r.opponent) ?? 0) + 1); }
  }

  return {
    get(week, team, pos) {
      const upTo = Math.min(Math.max(week - 1, 0), maxWeek);   // STRICTLY BEFORE week w.
      const n = upTo > 0 ? (preFaced.get(team)?.[upTo] ?? 0) : 0;
      const lgG = upTo > 0 ? preLgFaced[upTo] : 0;
      const leagueMean = lgG > 0
        ? (preLg.get(pos)?.[upTo] ?? 0) / lgG
        : (pTeamWeeks > 0 ? (pLg.get(pos) ?? 0) / pTeamWeeks : null);
      if (leagueMean == null) return { value: null, n };
      const terms: [number, number][] = [[STREAM_SHRINK, leagueMean]];
      if (n > 0) terms.push([n, (preSum.get(`${team}|${pos}`)?.[upTo] ?? 0) / n]);
      const pf = pFaced.get(team) ?? 0;
      if (pf > 0) terms.push([STREAM_PRIOR_WEIGHT, (pSum.get(`${team}|${pos}`) ?? 0) / pf]);
      const wsum = terms.reduce((s, t) => s + t[0], 0);
      return { value: wsum > 0 ? terms.reduce((s, t) => s + t[0] * t[1], 0) / wsum : null, n };
    },
  };
}

// ==================================================================================================
// THE TABLE.
// ==================================================================================================

const STREAM_BASE_COLS = ["feat_key", "player_sk", "season", "week", "as_of", "pos", "team", "opponent"];
const STREAM_KEY_COLS = new Set(["season", "week", "feat_key"]);

/**
 * THE UPSERT, GENERATED FROM ONE COLUMN LIST. Same reasoning as `weekModelInsertSql`: a hand-written
 * INSERT/VALUES/DO-UPDATE triple is three chances to leave a column off one list, which SQLite
 * reports as nothing at all -- the row writes, the column stays NULL, and the model trains without it.
 */
export function streamInsertSql(): string {
  const cols = [...STREAM_BASE_COLS, ...STREAM_FIELD_NAMES, "updated_at"];
  const params = cols.map((c) => (c === "updated_at" ? "@now" : `@${c}`));
  const set = cols.filter((c) => !STREAM_KEY_COLS.has(c)).map((c) => `${c}=excluded.${c}`);
  return `INSERT INTO feat_player_week_stream (${cols.join(", ")}) VALUES (${params.join(",")})\n` +
    `ON CONFLICT(season, week, feat_key) DO UPDATE SET ${set.join(", ")}`;
}

/**
 * CREATE THE TABLE AND ADD ANY MISSING COLUMN, on every build.
 *
 * schema.sql is CREATE TABLE IF NOT EXISTS throughout, so a column added to the CREATE reaches a
 * fresh store and never an existing one: the statement is skipped in silence and every query naming
 * the column fails at runtime on exactly the machines that have real data. So the ALTER is explicit
 * and idempotent BY INSPECTION rather than by swallowing an exception -- a duplicate-column error and
 * a malformed ALTER arrive as the same type.
 *
 * WHY THE KEY IS (season, week, feat_key) AND NOT (player_sk, season, week). 189 of the 157,650 rows
 * in `feat_player_week_model` for 2012-2025 carry a NULL `player_sk` (a receiver or tight end the
 * identity registry could not resolve), and a NULL inside a SQLite primary key does not conflict with
 * another NULL -- so keying on the surrogate would let the same man write two rows and would drop the
 * join to the model table, which keys on `feat_key`. `player_sk` is carried as a column, because that
 * is what the availability block joins on.
 */
export function ensureStreamTable(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS feat_player_week_stream (
       feat_key TEXT, player_sk TEXT, season INTEGER, week INTEGER, as_of TEXT,
       pos TEXT, team TEXT, opponent TEXT,
       ${STREAM_FIELDS.map((f) => `${f.name} ${f.sql}`).join(", ")},
       updated_at TEXT,
       PRIMARY KEY (season, week, feat_key));
     CREATE INDEX IF NOT EXISTS idx_fpws_pos ON feat_player_week_stream (season, week, pos);`,
  );
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_stream)").all() as { name: string }[])
    .map((c) => c.name));
  for (const f of STREAM_FIELDS) {
    if (!have.has(f.name)) db.exec(`ALTER TABLE feat_player_week_stream ADD COLUMN ${f.name} ${f.sql}`);
  }
}

export interface StreamBuildOpts {
  dbPath?: string;
  seasons: number[];
  /** Pre-loaded team-week facts, so a test can be hermetic. Production callers omit it. */
  teamWeek?: TeamWeekRow[];
  /**
   * FAULT-INJECTION SWITCH used ONLY by the leakage guard's positive control: when true every
   * accumulated window includes week w itself, which is the leak this table's whole discipline exists
   * to prevent. Never set by a production caller -- and the guard asserts the honest setting does NOT
   * fire, which is the half that makes the firing mean something.
   */
  leakOpponentThroughWeek?: boolean;
}

export interface StreamBuildResult {
  rows: number;
  teamWeekRows: Map<number, number>;
  perSeason: { season: number; rows: number; cols: Record<string, number> }[];
}

export async function buildStreamFeatures(opts: StreamBuildOpts): Promise<StreamBuildResult> {
  const db = openDb(opts.dbPath);
  try { return await buildStreamInto(db, opts); } finally { db.close(); }
}

export async function buildStreamInto(db: DB, opts: StreamBuildOpts): Promise<StreamBuildResult> {
  const seasons = [...opts.seasons].sort((a, b) => a - b);
  const tw = opts.teamWeek ?? (await loadTeamWeek(seasons)).rows;
  const teamWeekRows = new Map<number, number>();
  for (const r of tw) teamWeekRows.set(r.season, (teamWeekRows.get(r.season) ?? 0) + 1);
  const now = nowIso();

  ensureStreamTable(db);
  const ins = db.prepare(streamInsertSql());
  const res: StreamBuildResult = { rows: 0, teamWeekRows, perSeason: [] };

  for (const season of seasons) {
    // The universe is exactly `feat_player_week_model`'s rows for the season, so the two tables join
    // one-to-one on (season, week, feat_key) and a streaming feature can never exist for a
    // player-week the weekly model has no row for.
    const base = db.prepare(
      `SELECT feat_key, player_sk, week, as_of, pos, team, opponent, total_line, implied_team_total
         FROM feat_player_week_model WHERE season = ? ORDER BY week, feat_key`,
    ).all(season) as {
      feat_key: string; player_sk: string | null; week: number; as_of: string | null;
      pos: string; team: string | null; opponent: string | null;
      total_line: number | null; implied_team_total: number | null;
    }[];
    if (!base.length) { res.perSeason.push({ season, rows: 0, cols: {} }); continue; }

    const slack = opts.leakOpponentThroughWeek ? 1 : 0;
    const maxWeek = Math.max(1, ...base.map((r) => r.week)) + slack;

    const curTw = tw.filter((r) => r.season === season);
    const priorTw = tw.filter((r) => r.season === season - 1);
    const acc = {
      opp_def_sacks_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.defSacks, "self"),
      opp_def_takeaways_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.defTakeaways, "self"),
      // ALLOWED is the OPPONENT'S production, attributed to the defence that faced it.
      opp_pass_yds_allowed_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.passYards, "opponent"),
      opp_rush_yds_allowed_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.rushYards, "opponent"),
      opp_off_sacks_allowed_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.sacksSuffered, "self"),
      opp_off_giveaways_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.giveaways, "self"),
      team_fga_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.fgAtt, "self"),
      team_pat_pg: teamAccumulator(curTw, priorTw, maxWeek, (r) => r.patAtt, "self"),
    };

    const weekRows = (yr: number) => db.prepare(
      "SELECT week, opponent, pos, pts FROM feat_player_week WHERE season = ? AND pts IS NOT NULL AND opponent IS NOT NULL",
    ).all(yr) as { week: number; opponent: string | null; pos: string; pts: number | null }[];
    const pa = paByPos(weekRows(season), weekRows(season - 1), maxWeek);

    // ROOF. From the schedule feed as already stored -- a stadium's roof is knowable when the fixture
    // list is published, unlike `temp` and `wind` on the same table, which are observed and excluded.
    const roof = new Map<string, string>();
    for (const g of db.prepare(
      "SELECT week, home_team, away_team, roof FROM raw_nfl_game WHERE season = ? AND game_type = 'REG' AND roof IS NOT NULL",
    ).all(season) as { week: number; home_team: string; away_team: string; roof: string }[]) {
      if (!g.week) continue;
      roof.set(`${canonTeam(g.home_team)}|${g.week}`, g.roof);
      roof.set(`${canonTeam(g.away_team)}|${g.week}`, g.roof);
    }
    const DOME = new Set(["dome", "closed", "indoors"]);

    const cols: Record<string, number> = Object.fromEntries(STREAM_FIELD_NAMES.map((n) => [n, 0]));
    let n = 0;
    db.transaction(() => {
      // REPLACE THE SEASON, for the same reason the model table does: the upsert key contains
      // `feat_key`, so rows written under keys that have since moved survive a rebuild invisibly and
      // simply double the table.
      db.prepare("DELETE FROM feat_player_week_stream WHERE season = ?").run(season);
      for (const r of base) {
        if (!WEEKLY_POS.includes(r.pos)) continue;
        const w = r.week + slack;
        const opp = r.opponent;
        const paV = opp ? pa.get(w, opp, r.pos) : { value: null, n: 0 };
        const oppTotal = r.total_line != null && r.implied_team_total != null
          ? r.total_line - r.implied_team_total : null;
        const rf = r.team ? roof.get(`${r.team}|${r.week}`) : undefined;
        const row: Record<string, unknown> = {
          feat_key: r.feat_key, player_sk: r.player_sk, season, week: r.week,
          as_of: r.as_of ?? `${season}-09-01`, pos: r.pos, team: r.team, opponent: opp,
          opp_pa_pos: finite(paV.value), opp_pa_pos_n: paV.n,
          opp_def_sacks_pg: opp ? finite(acc.opp_def_sacks_pg.get(w, opp)) : null,
          opp_def_takeaways_pg: opp ? finite(acc.opp_def_takeaways_pg.get(w, opp)) : null,
          opp_pass_yds_allowed_pg: opp ? finite(acc.opp_pass_yds_allowed_pg.get(w, opp)) : null,
          opp_rush_yds_allowed_pg: opp ? finite(acc.opp_rush_yds_allowed_pg.get(w, opp)) : null,
          opp_off_sacks_allowed_pg: opp ? finite(acc.opp_off_sacks_allowed_pg.get(w, opp)) : null,
          opp_off_giveaways_pg: opp ? finite(acc.opp_off_giveaways_pg.get(w, opp)) : null,
          opp_implied_total: finite(oppTotal),
          roof_dome: rf == null ? null : (DOME.has(String(rf).toLowerCase()) ? 1 : 0),
          team_fga_pg: r.team ? finite(acc.team_fga_pg.get(w, r.team)) : null,
          team_pat_pg: r.team ? finite(acc.team_pat_pg.get(w, r.team)) : null,
          now,
        };
        ins.run(row);
        n++;
        for (const c of STREAM_FIELD_NAMES) if (row[c] != null) cols[c]++;
      }
    })();
    res.rows += n;
    res.perSeason.push({ season, rows: n, cols });
  }
  return res;
}

/** COVERAGE, per column per season -- what a report quotes instead of assuming a column is filled. */
export function streamCoverage(db: DB, seasons?: number[]): { season: number; rows: number; cols: Record<string, number> }[] {
  const present = presentStreamFields(db);
  if (!present.length) return [];
  const where = seasons?.length ? ` WHERE season IN (${seasons.map(() => "?").join(",")})` : "";
  const sel = STREAM_FIELD_NAMES
    .map((c) => (present.includes(c) ? `SUM(${c} IS NOT NULL)` : "0") + ` AS ${c}`).join(", ");
  const rows = db.prepare(
    `SELECT season, COUNT(*) AS rows_n, ${sel} FROM feat_player_week_stream${where} GROUP BY season ORDER BY season`,
  ).all(...(seasons ?? [])) as Record<string, number>[];
  return rows.map((r) => ({
    season: r.season, rows: r.rows_n,
    cols: Object.fromEntries(STREAM_FIELD_NAMES.map((c) => [c, r[c] ?? 0])),
  }));
}

/** The streaming columns for one (season, week), keyed by feat_key. Used by the serving path so the
 *  projector sees the same columns the trainer fitted -- a column the loader silently omits would
 *  fall back on its declared `missing` default and produce a plausible, wrong number. */
export function loadStreamRows(db: DB, season: number, week?: number): Map<string, Record<string, number | null>> {
  const present = presentStreamFields(db);
  const out = new Map<string, Record<string, number | null>>();
  if (!present.length) return out;
  const rows = db.prepare(
    `SELECT feat_key, ${present.join(", ")} FROM feat_player_week_stream
      WHERE season = ?${week == null ? "" : " AND week = ?"}`,
  ).all(...(week == null ? [season] : [season, week])) as Record<string, unknown>[];
  for (const r of rows) {
    out.set(String(r.feat_key), Object.fromEntries(
      STREAM_FIELD_NAMES.map((c) => [c, r[c] == null ? null : Number(r[c])]),
    ));
  }
  return out;
}
