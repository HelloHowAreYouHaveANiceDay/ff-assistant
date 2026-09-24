/**
 * THE POINT-IN-TIME WEEKLY FEATURE VIEW.
 *
 * `feat_player_week_model` is what a weekly model trains and serves from. It exists as a separate
 * table from `feat_player_week` (which src/features/build.ts owns and this file never writes)
 * because the two answer different questions: that one is the raw week fact -- schedule, usage to
 * date, target -- and this one is the derived view, every column of which needs an explicit as-of
 * rule beside it or it is a leak waiting to happen.
 *
 * WHY THE DISCIPLINE IS THE WHOLE JOB HERE. A weekly model that sees one hour past the first kickoff
 * looks superb and is worth nothing. Season-level lookahead is loud -- a season projection that
 * knows the season is obviously wrong. Weekly lookahead is quiet: opponent defence-versus-position
 * computed "for season Y" instead of "for weeks before w of season Y" is a one-character difference
 * in a GROUP BY, it raises no error, and it puts a piece of week w's own result into week w's
 * feature. So:
 *
 *   as_of = the day BEFORE the week's FIRST kickoff anywhere in the league.
 *
 * Not the day before this team's game -- that is what feat_player_week uses, and it is correct for
 * that table's purpose, but it would let a Monday-night player's row carry Sunday's results. The
 * league-wide anchor is strictly earlier and therefore strictly safer, and it is the same date for
 * every row in a week, which is what makes "no feature in week w moved" a checkable statement.
 *
 * EVERY COLUMN'S RULE IS IN A COMMENT BESIDE IT in buildWeekModelFeatures. The leakage guard
 * (test/weekly-leakage.test.ts) does not trust those comments: it perturbs week w's own source rows
 * and asserts nothing in week w changes, and it was fault-injected by computing DvP through week w
 * and watching it fire.
 *
 * WHAT IS DELIBERATELY ABSENT. Injury status, depth-chart rank, snap and route share, teammates out
 * and the Vegas implied total from a live odds feed are the DATA TRACK's `feat_player_week_context`.
 * They are not built here and not guessed at. `WEEKLY_FEATURE_FIELDS` is the published dictionary
 * and `PENDING_DATA_TRACK_FIELDS` names the ones waiting, so the trainer, the evaluator and the
 * report all read the same list rather than three copies of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../db/db.js";
import { buildPopulation, POPULATION_COLUMN } from "./population.js";
import { nameKey } from "../draft/values.js";
import { fetchCsvCached, URLS, cacheTag, canonTeam, pick } from "../data/nflverse.js";
import { loadArtifact, type ProjectionArtifact } from "../model/projector.js";
import { backtestProjection, boardProjection } from "../model/features.js";
import { fitRookieCurve, rookieProjections } from "../draft/rookieModel.js";
import { STREAM_FIELD_NAMES, presentStreamFields } from "./streamingFields.js";
import { buildSourceResolver } from "../features/sources/resolve.js";
// TYPE-ONLY, and it must stay that way: formatResolve.ts imports projector.ts (for the two weekly
// artifact filename constants) and projector.ts imports THIS file, so a VALUE import here closes a
// runtime cycle and the artifact table hits a TDZ error at module load. A type import is erased.
import type { ModelHandle } from "../data/formatResolve.js";
import { dataPath } from "../data/paths.js";
import { ARTIFACT_FILE } from "../data/projections.js";

/** The positions a weekly model has an opinion about. Same list src/features/build.ts uses. */
export const WEEKLY_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * THE PUBLISHED DICTIONARY of weekly feature columns. The trainer emits names; the TypeScript
 * evaluator validates them against THIS list. That is the check a name-keyed contract cannot pass by
 * accident -- the same one src/model/projector.ts makes for the season model, and for the same
 * reason: a renamed feature that silently scores zero keeps both sides green while they disagree.
 */
export const WEEKLY_FEATURE_FIELDS = [
  "td_games", "td_ppg", "t4_mean", "t4_sd",
  "td_fd", "td_ts", "td_attempts", "td_rush_yards",
  "rz_share_td",   // rolling season-to-date red-zone touch share (pbp), point-in-time -- 2026-09-15 candidate
  "prior_vol_cv",  // prior-season weekly CV (volatility), always-present -- 2026-09-15 candidate
  // PRIOR-SEASON ROLE SHAPE (2026-09-23 candidates, scripts/segment-screen.mjs). Archetype, not
  // level: how DEEP a receiver was targeted and how CONCENTRATED his team's target share was on
  // him, both from the completed prior season, so both are knowable on September 1.
  "prior_air_yards_share", "prior_wopr",
  // THE WEEKLY EXPERT CONSENSUS (M2a, 2026-09-16 candidate). FantasyPros' WEEKLY positional consensus
  // rank and its dispersion, from `ranking_history` where `ecr_type = 'wp'`, taken from the LATEST
  // scrape dated at or before this team's Friday cutoff. See `ecrWeekTable` for the as-of rule and
  // the era bound: the archive's weekly scrapes exist for 2020-2024 ONLY, so every other season is
  // MISSING by construction and the live season has no row at all.
  "ecr_wk_rank", "ecr_wk_sd",
  // THE PANEL ASYMMETRY (2026-09-24 candidate). Same source and cadence as the two above; see
  // ecrWeekTable for the definition and for why sd cannot carry it.
  "ecr_wk_skew",
  "home", "spread_line", "total_line", "implied_team_total", "days_rest",
  "season_line_pg", "week_no",
  // ---- THE AVAILABILITY BLOCK, from feat_player_week_context (the data track). See CONTEXT_FIELDS
  // below for each column's as-of rule; they are NOT on the same anchor as the columns above and
  // that difference is stated rather than buried.
  "prior_snap_share", "prior_route_share", "depth_rank", "teammates_out",
  "inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "inj_feed",
  // ---- THE STREAMING BLOCK, from feat_player_week_stream (src/weekly/streamingFeatures.ts). What
  // the OPPONENT allows and what the stadium is, as of the day before the week's first kickoff. The
  // names are written out here as literals rather than spread from STREAM_FIELD_NAMES because this
  // array is `as const` and drives a union type; `test/streaming-features.test.ts` asserts the two
  // lists agree, which is the check a spread would have made unnecessary and a typo makes essential.
  "opp_pa_pos", "opp_pa_pos_n", "opp_def_sacks_pg", "opp_def_takeaways_pg",
  "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg",
  "opp_off_sacks_allowed_pg", "opp_off_giveaways_pg",
  "opp_implied_total", "roof_dome", "team_fga_pg", "team_pat_pg",
] as const;
export type WeeklyFeatureField = typeof WEEKLY_FEATURE_FIELDS[number];

/**
 * THE AVAILABILITY COLUMNS, their storage type, and the AS-OF RULE each one is keyed with.
 *
 * THE ANCHOR IS DIFFERENT FROM THE REST OF THIS TABLE AND THAT MATTERS. Everything above is keyed to
 * `as_of` = the day before the week's FIRST kickoff, league-wide, which is the strictly-safest
 * anchor and the same date for every row in a week. These come from `feat_player_week_context`,
 * which is keyed PER TEAM: the injury pair at this team's kickoff minus two days, depth and usage at
 * this team's kickoff minus one. For a team playing Sunday that is LATER than the league-wide
 * anchor by up to four days.
 *
 * That is a real widening and it is accepted deliberately, for a reason that is checkable rather
 * than a matter of taste: the later anchor is still strictly before THIS PLAYER'S OWN KICKOFF, which
 * is the only thing a lineup decision needs, and the information it admits (a Friday injury
 * designation) is not derived from any game's result. What it must not admit is week w's SCORING,
 * and that is exactly what test/weekly-leakage.test.ts asserts -- extended in Phase 2d to perturb
 * the raw injury rows themselves, so a column that read a report filed after the cutoff would fire.
 *
 * `inj_feed` exists because the alternative is a fabricated fact. From 2025 the nflverse injury feed
 * stopped publishing a report DATE, so `feat_player_week_context` drops every 2025 report (an undated
 * row cannot be placed on either side of a cutoff) and every injury column reads NULL. Without a
 * feed indicator a model reads that as "nobody in the league was hurt in 2025", which is worse than
 * missing data because it is confidently wrong. `inj_feed` is 0 for exactly those league-weeks.
 */
export const CONTEXT_FIELDS: { name: WeeklyFeatureField; sql: string; asOf: string }[] = [
  { name: "prior_snap_share", sql: "REAL", asOf: "offense_pct in the last week he PLAYED before w; carried forward" },
  { name: "prior_route_share", sql: "REAL", asOf: "charted pass plays / team pass plays, same rule; participation feed starts 2016" },
  { name: "depth_rank", sql: "INTEGER", asOf: "depth chart at (this team's kickoff - 1 day)" },
  { name: "teammates_out", sql: "INTEGER", asOf: "same team, same position, listed Out at (this team's kickoff - 2 days)" },
  { name: "inj_out", sql: "INTEGER", asOf: "report_status_fri == 'Out' at (kickoff - 2 days)" },
  { name: "inj_doubtful", sql: "INTEGER", asOf: "report_status_fri == 'Doubtful', same cutoff" },
  { name: "inj_questionable", sql: "INTEGER", asOf: "report_status_fri in Questionable/Probable, same cutoff" },
  { name: "prac_dnp", sql: "INTEGER", asOf: "practice_status_fri == did not participate, same cutoff" },
  { name: "prac_limited", sql: "INTEGER", asOf: "practice_status_fri == limited, same cutoff" },
  { name: "inj_feed", sql: "INTEGER", asOf: "1 where the injury feed published ANY dated report for this league-week" },
];

/**
 * Columns the DATA TRACK owns and this table STILL does not have. Named here so a report can say
 * which measurement was made without them rather than implying the model saw everything.
 *
 * The Wednesday injury pair is on this list and it is the surprise of Phase 2d. The columns exist,
 * `buildWeekContext` fills them with a cutoff of (kickoff - 4 days), and they are EMPTY: eleven
 * `report_status_wed` values and 389 `practice_status_wed` values across 133,892 player-weeks,
 * because the feed's dated filings land at kickoff minus two or later. A model declaring them would
 * fit an intercept on 0.008% of its rows and the report would say "Wednesday practice status did not
 * help", which would be a fact about the feed dressed up as a fact about football.
 */
export const PENDING_DATA_TRACK_FIELDS = [
  "report_status_wed", "practice_status_wed", "vegas_implied_team_total_live",
] as const;

/** How hard DvP is pulled toward 1.0, in team-games of league-average prior. */
export const DVP_SHRINK = 4;
/** How many team-games of credit the PRIOR season's DvP is worth. Non-zero because week 1 of a
 *  season otherwise has no matchup information at all, and last year's defence is weak evidence
 *  rather than no evidence -- but it decays out fast as the current season accumulates. */
export const DVP_PRIOR_WEIGHT = 6;

const finite = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : x;

/**
 * ADD THE AVAILABILITY COLUMNS TO AN EXISTING STORE.
 *
 * schema.sql is CREATE TABLE IF NOT EXISTS throughout, so a column added to the CREATE reaches a
 * fresh store and never an existing one -- the table is already there, the statement is skipped in
 * silence, and every query naming the column fails at runtime on exactly the machines that have real
 * data. So the ALTER is explicit, idempotent BY INSPECTION rather than by swallowing an exception
 * (a duplicate-column error and a malformed ALTER arrive as the same type), and it runs on every
 * build rather than in a migration someone has to remember.
 */
export function ensureContextColumns(db: DB): void {
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .map((c) => c.name));
  if (!have.size) return;                              // table not created yet; schema.sql owns that
  for (const c of CONTEXT_FIELDS) {
    if (!have.has(c.name)) db.exec(`ALTER TABLE feat_player_week_model ADD COLUMN ${c.name} ${c.sql}`);
  }
  // The M2a consensus pair, for the same reason: `weekModelInsertSql` names them, so a store created
  // before they were added to schema.sql would fail the INSERT rather than write a NULL.
  for (const c of ECR_WEEK_FIELDS) {
    if (!have.has(c)) db.exec(`ALTER TABLE feat_player_week_model ADD COLUMN ${c} REAL`);
  }
}

/** What the availability block holds for one row, before it is written. */
export type ContextRow = Record<string, number | null>;

const EMPTY_CONTEXT: ContextRow = Object.fromEntries(CONTEXT_FIELDS.map((c) => [c.name, null]));

/** Normalised injury/practice buckets. The feed's strings are matched EXACTLY where it publishes a
 *  controlled vocabulary and by prefix where it publishes a sentence ("Did Not Participate In
 *  Practice"). An unrecognised string produces all-zero indicators rather than being silently
 *  folded into the nearest bucket. */
function injuryIndicators(status: string | null, practice: string | null): Record<string, number> {
  const s = (status ?? "").trim();
  const p = (practice ?? "").trim().toLowerCase();
  return {
    inj_out: s === "Out" ? 1 : 0,
    inj_doubtful: s === "Doubtful" ? 1 : 0,
    // Probable was retired from the report after 2015 and Questionable absorbed it. Folding them
    // together is what makes one coefficient mean the same thing across the whole span; keeping them
    // apart would fit a 2013-2015 indicator and a 2016+ indicator and call them one feature.
    inj_questionable: s === "Questionable" || s === "Probable" ? 1 : 0,
    prac_dnp: p.startsWith("did not participate") || p.startsWith("out (") ? 1 : 0,
    prac_limited: p.startsWith("limited") ? 1 : 0,
  };
}

/**
 * THE AVAILABILITY BLOCK for one season, keyed (week|player_sk).
 *
 * Returns an empty map where `feat_player_week_context` has no rows for the season, which is a
 * different statement from "everyone was healthy" and is why `inj_feed` is computed per LEAGUE-WEEK
 * from the presence of any dated report at all rather than per player from his own NULL.
 */
export function contextFor(db: DB, season: number): Map<string, ContextRow> {
  const out = new Map<string, ContextRow>();
  const rows = db.prepare(
    `SELECT week, player_sk, prior_snap_share, prior_route_share, depth_rank, teammates_out,
            report_status_fri, practice_status_fri
       FROM feat_player_week_context WHERE season = ?`,
  ).all(season) as {
    week: number; player_sk: number; prior_snap_share: number | null; prior_route_share: number | null;
    depth_rank: number | null; teammates_out: number | null;
    report_status_fri: string | null; practice_status_fri: string | null;
  }[];
  // Which league-weeks the feed actually spoke in. A week where NOBODY carries a status is a silent
  // feed, not a healthy league: 2025 has 6,068 injury rows and not one of them is dated, so every
  // status is NULL for reasons that have nothing to do with who could play.
  const spoke = new Set<number>();
  for (const r of rows) if (r.report_status_fri || r.practice_status_fri) spoke.add(r.week);
  for (const r of rows) {
    out.set(`${r.week}|${r.player_sk}`, {
      prior_snap_share: r.prior_snap_share, prior_route_share: r.prior_route_share,
      depth_rank: r.depth_rank,
      teammates_out: spoke.has(r.week) ? (r.teammates_out ?? 0) : null,
      ...(spoke.has(r.week)
        ? injuryIndicators(r.report_status_fri, r.practice_status_fri)
        : { inj_out: null, inj_doubtful: null, inj_questionable: null, prac_dnp: null, prac_limited: null }),
      inj_feed: spoke.has(r.week) ? 1 : 0,
    });
  }
  return out;
}

/** feat_key, exactly as src/features/build.ts forms it, so the two tables join. */
export const weekFeatKey = (sk: string | null, name: string, pos: string): string =>
  sk ?? `NK:${nameKey(name)}|${pos}`;

interface RawWeek {
  feat_key: string; player_sk: string | null; season: number; week: number;
  name: string; pos: string; team: string | null; opponent: string | null;
  home: number | null; is_bye: number | null;
  spread_line: number | null; total_line: number | null; implied_team_total: number | null;
  td_games: number | null; td_fd: number | null; td_ts: number | null;
  td_attempts: number | null; td_rush_yards: number | null; td_pts: number | null;
  pts: number | null;
}

export interface ScheduleInfo {
  /** (season|week) -> the day before the week's FIRST kickoff. */
  weekAsOf: Map<string, string>;
  /** (season|team|week) -> gameday ISO. */
  teamGameDay: Map<string, string>;
  /** (season|team) -> number of REG games. */
  teamGames: Map<string, number>;
}

/** Read the schedules feed (cached under data/cache) into the three lookups the builder needs. */
export async function loadSchedule(seasons: number[]): Promise<ScheduleInfo> {
  const want = new Set(seasons.flatMap((y) => [y - 1, y]));
  const rows = await fetchCsvCached(URLS.schedules, cacheTag.schedules);
  const firstDay = new Map<string, string>();
  const teamGameDay = new Map<string, string>();
  const teamGames = new Map<string, number>();
  for (const g of rows) {
    const yr = Number(pick(g, "season"));
    if (!want.has(yr) || pick(g, "game_type") !== "REG") continue;
    const wk = Number(pick(g, "week")); if (!wk) continue;
    const day = pick(g, "gameday"); if (!day) continue;
    const home = canonTeam(pick(g, "home_team")), away = canonTeam(pick(g, "away_team"));
    const k = `${yr}|${wk}`;
    const cur = firstDay.get(k);
    if (!cur || day < cur) firstDay.set(k, day);
    for (const t of [home, away]) {
      teamGameDay.set(`${yr}|${t}|${wk}`, day);
      teamGames.set(`${yr}|${t}`, (teamGames.get(`${yr}|${t}`) ?? 0) + 1);
    }
  }
  const weekAsOf = new Map<string, string>();
  for (const [k, day] of firstDay) {
    const t = Date.parse(`${day}T00:00:00Z`);
    weekAsOf.set(k, Number.isFinite(t) ? new Date(t - 864e5).toISOString().slice(0, 10) : day);
  }
  return { weekAsOf, teamGameDay, teamGames };
}

/**
 * The PRESEASON season projection, per game, for one season.
 *
 * Historical seasons go through the BACKTEST path: the pool is season Y-1's finishers, each looked
 * up in season Y's point-in-time conditional curve at his Y-1 finish rank. That is the projection
 * the board would have produced in the August of Y, and it is available from 2010 (the first season
 * with enough prior pairs to fit a curve). The current season goes through the BOARD path instead,
 * because that is what the live board is: consensus rank, and the only source that knows about a
 * rookie.
 *
 * Divided by the team's number of scheduled games -- 16 before 2021, 17 after -- read from the
 * published schedule rather than hardcoded, because a hardcoded 17 would silently inflate every
 * pre-2021 per-game line by 6%.
 *
 * INHERITED LIMIT, stated rather than buried: the shipped artifact's `age_factor` and `opp_factor`
 * are fitted once over all seasons, so the season line carries the same mild cross-season lookahead
 * the shipped board carries. It is not introduced here and it is identical across every model and
 * baseline this track compares, so it cannot manufacture a difference between them -- but it is not
 * zero, and a weekly conclusion should not be leaned on past the third decimal because of it.
 */
export function preseasonLinePerGame(
  db: DB, season: number, artifact: ProjectionArtifact, sched: ScheduleInfo, currentSeason: number,
): Map<string, number> {
  const rows = season >= currentSeason
    ? boardProjection(db, season, artifact, `${season}-09-01`)
    : backtestProjection(db, season, artifact, `${season}-09-01`);
  // Games per team, from the schedule. Where a season is not in the feed at all, fall back to the
  // era default rather than dropping every row -- and say which by returning nothing for that team.
  const gamesFor = (team: string | null): number => {
    const g = team ? sched.teamGames.get(`${season}|${team}`) : undefined;
    return g && g > 0 ? g : (season >= 2021 ? 17 : 16);
  };
  const teamOf = new Map<string, string | null>();
  for (const r of db.prepare("SELECT feat_key, team FROM feat_player_season WHERE season = ?")
    .all(season) as { feat_key: string; team: string | null }[]) teamOf.set(r.feat_key, r.team);

  const out = new Map<string, number>();
  for (const r of rows) {
    const key = weekFeatKey(r.player_sk, r.name, r.pos);
    const g = gamesFor(teamOf.get(key) ?? null);
    if (Number.isFinite(r.mean) && g > 0) out.set(key, r.mean / g);
  }
  // ROOKIE FALLBACK. The BACKTEST path (season < currentSeason) prices players by prior-season rank, so
  // a rookie -- who has none -- is absent and his season_line_pg is left NULL, which drops him from the
  // weekly scorecard, the in-season harness and every decision experiment. Give him a draft-capital line
  // (src/draft/rookieModel.ts, leakage-clean: the curve is fit on rookies from BEFORE this season). The
  // BOARD path (live) already prices rookies via ECR consensus rank, so this only fills the backtest gap.
  if (season < currentSeason) {
    const curve = fitRookieCurve(db, { beforeSeason: season });
    for (const rp of rookieProjections(db, season, curve)) {
      const key = weekFeatKey(rp.player_sk, rp.name, rp.pos);
      if (out.has(key)) continue;                 // already priced (e.g. a rare rank) -- do not override
      const g = gamesFor(teamOf.get(key) ?? null);
      if (g > 0) out.set(key, rp.points / g);
    }
  }
  return out;
}

/**
 * Opponent defence-versus-position, as a multiplier, POINT IN TIME.
 *
 * For (season Y, week w, defence T, position P) it is a weighted mean of three things:
 *   - what T has allowed per game to P in weeks 1..w-1 of Y, weight = T's games so far;
 *   - what T allowed per game to P over ALL of Y-1, weight DVP_PRIOR_WEIGHT;
 *   - 1.0 (league average), weight DVP_SHRINK.
 * Each term is expressed as a ratio to the LEAGUE's allowed-per-game over the same window, so the
 * three are commensurable and the scoring era divides out.
 *
 * The one thing that makes this a point-in-time quantity rather than a leak is the `week < w` bound,
 * and it is worth being explicit that it is doing all the work: computing the same statistic over
 * the whole season -- which is what data/def-ratings.csv is, and what almost every published DvP
 * table is -- puts week w's own scoring inside week w's feature.
 */
export function dvpTable(db: DB, season: number): {
  /** (week|team|pos) -> { mult, n } for every week 1..max. */
  get(week: number, team: string, pos: string): { mult: number; n: number } | null;
} {
  interface Row { week: number; opponent: string | null; pos: string; pts: number | null }
  const cur = db.prepare(
    "SELECT week, opponent, pos, pts FROM feat_player_week WHERE season = ? AND pts IS NOT NULL AND opponent IS NOT NULL",
  ).all(season) as Row[];
  const prior = db.prepare(
    "SELECT week, opponent, pos, pts FROM feat_player_week WHERE season = ? AND pts IS NOT NULL AND opponent IS NOT NULL",
  ).all(season - 1) as Row[];

  const maxWeek = Math.max(1, ...cur.map((r) => r.week));

  // Cumulative allowed points and cumulative opponent-games, per (team, pos), by week.
  // teamWeeks: how many weeks a defence has actually faced anyone -- the honest denominator, because
  // a bye week must not count as a game in which zero points were allowed.
  const allowedByWeek = new Map<string, number>();      // `${team}|${pos}|${week}` -> pts
  const facedByWeek = new Map<string, number>();        // `${team}|${week}` -> 1 if faced anyone
  const leagueByWeek = new Map<string, number>();       // `${pos}|${week}` -> pts
  const leagueTeamWeeks = new Map<string, number>();    // `${week}` -> team-games
  for (const r of cur) {
    const t = r.opponent!;
    allowedByWeek.set(`${t}|${r.pos}|${r.week}`, (allowedByWeek.get(`${t}|${r.pos}|${r.week}`) ?? 0) + (r.pts ?? 0));
    facedByWeek.set(`${t}|${r.week}`, 1);
    leagueByWeek.set(`${r.pos}|${r.week}`, (leagueByWeek.get(`${r.pos}|${r.week}`) ?? 0) + (r.pts ?? 0));
  }
  for (const k of facedByWeek.keys()) {
    const wk = k.split("|")[1];
    leagueTeamWeeks.set(wk, (leagueTeamWeeks.get(wk) ?? 0) + 1);
  }

  // Prior season, whole-season ratio per (team, pos).
  const priorRatio = new Map<string, number>();
  {
    const allowed = new Map<string, number>(), faced = new Map<string, number>();
    const lg = new Map<string, number>();
    let teamWeeks = 0;
    const seenTeamWeek = new Set<string>();
    for (const r of prior) {
      const t = r.opponent!;
      allowed.set(`${t}|${r.pos}`, (allowed.get(`${t}|${r.pos}`) ?? 0) + (r.pts ?? 0));
      lg.set(r.pos, (lg.get(r.pos) ?? 0) + (r.pts ?? 0));
      const tw = `${t}|${r.week}`;
      if (!seenTeamWeek.has(tw)) { seenTeamWeek.add(tw); teamWeeks++; faced.set(t, (faced.get(t) ?? 0) + 1); }
    }
    if (teamWeeks > 0) {
      for (const [k, v] of allowed) {
        const [t, p] = k.split("|");
        const n = faced.get(t) ?? 0;
        const lgPg = (lg.get(p) ?? 0) / teamWeeks;
        if (n > 0 && lgPg > 0) priorRatio.set(k, (v / n) / lgPg);
      }
    }
  }

  // Prefix sums so a lookup for week w is O(1) and, more importantly, is written ONCE. A per-call
  // re-scan with its own bound is how one call site ends up including week w.
  const preAllowed = new Map<string, number[]>();   // `${team}|${pos}` -> cumulative through week i
  const preFaced = new Map<string, number[]>();     // `${team}` -> cumulative games through week i
  const preLeague = new Map<string, number[]>();    // `${pos}` -> cumulative through week i
  const preTeamWeeks: number[] = new Array(maxWeek + 1).fill(0);
  const ensure = (m: Map<string, number[]>, k: string) =>
    m.get(k) ?? m.set(k, new Array(maxWeek + 1).fill(0)).get(k)!;
  for (let w = 1; w <= maxWeek; w++) {
    preTeamWeeks[w] = preTeamWeeks[w - 1] + (leagueTeamWeeks.get(String(w)) ?? 0);
  }
  for (const k of new Set([...allowedByWeek.keys()].map((s) => s.split("|").slice(0, 2).join("|")))) {
    const a = ensure(preAllowed, k);
    for (let w = 1; w <= maxWeek; w++) a[w] = a[w - 1] + (allowedByWeek.get(`${k}|${w}`) ?? 0);
  }
  for (const t of new Set([...facedByWeek.keys()].map((s) => s.split("|")[0]))) {
    const a = ensure(preFaced, t);
    for (let w = 1; w <= maxWeek; w++) a[w] = a[w - 1] + (facedByWeek.get(`${t}|${w}`) ?? 0);
  }
  for (const p of new Set([...leagueByWeek.keys()].map((s) => s.split("|")[0]))) {
    const a = ensure(preLeague, p);
    for (let w = 1; w <= maxWeek; w++) a[w] = a[w - 1] + (leagueByWeek.get(`${p}|${w}`) ?? 0);
  }

  return {
    get(week, team, pos) {
      const upTo = Math.min(Math.max(week - 1, 0), maxWeek);   // STRICTLY BEFORE week w.
      const n = upTo > 0 ? (preFaced.get(team)?.[upTo] ?? 0) : 0;
      const lgPts = upTo > 0 ? (preLeague.get(pos)?.[upTo] ?? 0) : 0;
      const lgTw = upTo > 0 ? preTeamWeeks[upTo] : 0;
      const lgPg = lgTw > 0 ? lgPts / lgTw : 0;
      const terms: [number, number][] = [[DVP_SHRINK, 1]];
      if (n > 0 && lgPg > 0) {
        const allowed = (preAllowed.get(`${team}|${pos}`)?.[upTo] ?? 0) / n;
        terms.push([n, allowed / lgPg]);
      }
      const pr = priorRatio.get(`${team}|${pos}`);
      if (pr != null && Number.isFinite(pr)) terms.push([DVP_PRIOR_WEIGHT, pr]);
      const wsum = terms.reduce((s, t) => s + t[0], 0);
      if (!(wsum > 0)) return null;
      return { mult: terms.reduce((s, t) => s + t[0] * t[1], 0) / wsum, n };
    },
  };
}

/**
 * ROLLING RED-ZONE TOUCH SHARE, point-in-time. From raw_pbp_player_week: the player's season-to-date
 * (weeks STRICTLY BEFORE w) red-zone touches (rz_carries + rz_targets) over his team's, i.e. "is he
 * CURRENTLY the red-zone option" -- a role LEVEL orthogonal to the total snap/route usage already in
 * the model (a back can lead the backfield in snaps yet not get the goal-line work, and vice versa).
 *
 * Same `week - 1` prefix-sum discipline as dvpTable -- the bound is the only thing between this column
 * and a leak. Keyed by SURROGATE KEY (via the source resolver, gsis -> sk), the same key feat_player_week
 * uses; the team denominator is that week's team, cumulative (a traded player's early touches sit under
 * his old team, a small and rare imprecision, as with the season route-share).
 */
export function rzShareTable(db: DB, season: number): {
  get(week: number, sk: string | number | null, team: string | null): number | null;
} {
  const resolver = buildSourceResolver(db);
  const rows = db.prepare(
    `SELECT gsis_id, week, team, (rz_carries + rz_targets) rz FROM raw_pbp_player_week WHERE season = ?`,
  ).all(season) as { gsis_id: string; week: number; team: string | null; rz: number }[];
  let maxWeek = 1;
  const bySk = new Map<string, number[]>();     // sk  -> weekly rz touches (index = week)
  const byTeam = new Map<string, number[]>();   // team-> weekly rz touches
  const ensure = (m: Map<string, number[]>, k: string) => (m.get(k) ?? m.set(k, []).get(k)!);
  for (const r of rows) {
    if (r.week == null || !(r.rz > 0)) continue;
    if (r.week > maxWeek) maxWeek = r.week;
    const team = canonTeam(r.team ?? "");
    if (team) { const a = ensure(byTeam, team); a[r.week] = (a[r.week] ?? 0) + r.rz; }
    const res = resolver.resolve({ gsis: r.gsis_id });
    if (res.sk == null) continue;
    const a = ensure(bySk, String(res.sk)); a[r.week] = (a[r.week] ?? 0) + r.rz;
  }
  // prefix-sum in place: a[w] becomes the cumulative through week w.
  const cum = (m: Map<string, number[]>) => {
    for (const a of m.values()) for (let w = 1; w <= maxWeek; w++) a[w] = (a[w] ?? 0) + (a[w - 1] ?? 0);
  };
  cum(bySk); cum(byTeam);
  return {
    get(week, sk, team) {
      const upTo = Math.min(Math.max(week - 1, 0), maxWeek);   // STRICTLY BEFORE week w.
      if (upTo <= 0 || sk == null || !team) return null;
      const t = byTeam.get(canonTeam(team)); const den = t ? (t[upTo] ?? 0) : 0;
      if (!(den > 0)) return null;                             // team has no red-zone snaps yet -> unknown, not 0
      const p = bySk.get(String(sk)); const num = p ? (p[upTo] ?? 0) : 0;
      return num / den;
    },
  };
}

/**
 * PRIOR-SEASON VOLATILITY (2026-09-15 candidate), scale-free: the player's Y-1 weekly coefficient of
 * variation (SD/mean of his played weeks), keyed by surrogate key. Constant across season Y and known
 * before it starts, so leak-safe and ALWAYS present at serve (unlike the form block) -- it exists to
 * inform the SPREAD the quantile heads predict, especially early when `t4_sd` is still empty. CV, not
 * SD, so it is a pure boom/bust signal rather than a level proxy (the pre-filter showed raw SD is
 * 0.58-correlated with the level the model already carries).
 */
/**
 * PRIOR-SEASON ROLE SHAPE, per player: air-yards share and WOPR, read straight off
 * `feat_player_season` for season-1.
 *
 * These are ARCHETYPE columns, not level columns, and that is the point of adding them. The
 * segment screen (scripts/segment-screen.mjs) found both carrying residual signal the served
 * artifact does not have: prior air-yards share at 3.4x its own shuffle null for WR on the MEAN
 * and 3.2x on the BAND (deep threats are genuinely boom/bust), and prior WOPR at 4.1x on the MEAN
 * for WR. Neither is a segment result -- both fired on MAIN, which means the honest reading is
 * "an ordinary missing feature", and they are wired as ordinary features here rather than as
 * machinery for splitting heads.
 *
 * POINT IN TIME BY CONSTRUCTION, and cheaply so: every `prior_*` column on `feat_player_season` is
 * derived from the COMPLETED season-1 and the row itself is pinned as-of September 1. There is no
 * week-of-season accumulation to get wrong here, which is the one thing that makes this pair
 * cheaper to trust than the rolling opponent block.
 *
 * Keyed by `player_sk`. Never by name -- this repo has paid twice for name-keyed joins.
 */
export function priorSeasonRole(db: DB, season: number): Map<string, { airShare: number | null; wopr: number | null }> {
  const out = new Map<string, { airShare: number | null; wopr: number | null }>();
  for (const r of db.prepare(
    `SELECT player_sk, prior_air_yards_share AS a, prior_wopr AS w
       FROM feat_player_season WHERE season = ? AND player_sk IS NOT NULL`,
  ).all(season) as { player_sk: string; a: number | null; w: number | null }[]) {
    out.set(String(r.player_sk), {
      airShare: r.a == null || !Number.isFinite(Number(r.a)) ? null : Number(r.a),
      wopr: r.w == null || !Number.isFinite(Number(r.w)) ? null : Number(r.w),
    });
  }
  return out;
}

export function priorSeasonVol(db: DB, season: number): Map<string, number> {
  const rows = db.prepare(
    "SELECT player_sk, pts FROM feat_player_week WHERE season = ? AND player_sk IS NOT NULL AND pts IS NOT NULL AND pts > 0",
  ).all(season - 1) as { player_sk: string; pts: number }[];
  const by = new Map<string, number[]>();
  for (const r of rows) (by.get(String(r.player_sk)) ?? by.set(String(r.player_sk), []).get(String(r.player_sk))!).push(r.pts);
  const out = new Map<string, number>();
  for (const [sk, arr] of by) {
    if (arr.length < 6) continue;                         // too few games for a stable CV
    const m = arr.reduce((s, x) => s + x, 0) / arr.length;
    if (!(m > 0)) continue;
    const sd = Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
    out.set(sk, sd / m);
  }
  return out;
}

/**
 * THE WEEKLY EXPERT CONSENSUS, POINT IN TIME (M2a candidate, 2026-09-16).
 *
 * `ranking_history` with `ecr_type = 'wp'` is FantasyPros' WEEKLY POSITIONAL consensus: for one
 * scrape date and one position, `ecr` is already the within-position consensus rank (RB1 = 1.08 on
 * 2023-10-13 is Christian McCaffrey), `sd` the dispersion of the expert panel around it. It is the
 * one feed on this table that is a FORECAST rather than an accumulation -- it embeds injury news,
 * role changes and matchup reads days before a box score does -- which is the whole hypothesis.
 *
 * THE AS-OF RULE, and it is the availability block's anchor rather than the league-wide one.
 * The value is read from the LATEST `wp` scrape dated at or before `cutoff`, where cutoff is THIS
 * TEAM'S kickoff minus two days -- the same cutoff `feat_player_week_context` uses for the Friday
 * injury report, and for the same reason: it is strictly before this player's own kickoff, which is
 * the only thing a lineup decision needs. The league-wide `as_of` (the day before the week's FIRST
 * kickoff, i.e. Wednesday) would be too early to admit a Friday scrape at all, and this feed is
 * scraped on Fridays -- so the strictly-safest anchor would produce an empty column rather than a
 * safer one. A team playing Thursday gets a cutoff of Tuesday and therefore the PREVIOUS week's
 * scrape, stale by seven days; that is what was actually knowable, and it is left stale rather than
 * quietly advanced.
 *
 * STALENESS IS A REFUSAL, not a carry-forward. If the newest qualifying scrape is more than
 * ECR_WEEK_MAX_AGE_DAYS old the value is NULL: a bye-week gap or a mid-season hole in the archive
 * must not hand the model a three-week-old opinion wearing this week's name.
 *
 * A PLAYER ABSENT FROM THE QUALIFYING SCRAPE IS NULL, not backfilled from an older one. The list is
 * the panel's answer for that week; a man who is not on it has no weekly consensus, and reaching
 * back for his rank from an earlier week would report a stale opinion as a current one.
 *
 * ERA BOUND, stated rather than discovered later: the archive holds `wp` scrapes for **2020-2024
 * only** (2019 carries a single stray December date). 2012-2019 and 2025-2026 are MISSING BY
 * CONSTRUCTION -- there is no live weekly-consensus path in this store, so a model fitted on this
 * column serves nothing forward until one exists. Same shape as `feat_injury_horizon` (docs/weekly.md
 * section 5), and it must be read the same way.
 */
export const ECR_WEEK_MAX_AGE_DAYS = 8;
/** The weekly-consensus feed's own position vocabulary -> ours. It publishes kickers as both. */
const ECR_POS_ALIAS: Record<string, string> = { PK: "K", DEF: "DST", "D/ST": "DST" };

export function ecrWeekTable(db: DB, season: number): {
  /** `cutoff` is an ISO date: this team's kickoff minus two days. */
  get(cutoff: string, name: string, pos: string): { ecr: number; sd: number | null; skew: number | null } | null;
  /** The scrape dates the season carries, ascending. Reported, so an empty column is never silent. */
  dates: string[];
} {
  const rows = db.prepare(
    `SELECT scrape_date, player_id, pos, ecr, sd, best, worst FROM ranking_history
      WHERE source = 'fantasypros' AND ecr_type = 'wp' AND season = ?`,
  ).all(season) as {
    scrape_date: string; player_id: string; pos: string; ecr: number;
    sd: number | null; best: number | null; worst: number | null;
  }[];
  // date -> `${name_key}|${pos}` -> value. One map per scrape so a lookup can never silently mix two.
  const byDate = new Map<string, Map<string, { ecr: number; sd: number | null; skew: number | null }>>();
  for (const r of rows) {
    const pos = ECR_POS_ALIAS[(r.pos ?? "").toUpperCase()] ?? (r.pos ?? "").toUpperCase();
    if (!WEEKLY_POS.includes(pos)) continue;                 // IDP lists exist here; we field none
    const m = byDate.get(r.scrape_date) ?? byDate.set(r.scrape_date, new Map()).get(r.scrape_date)!;
    // A player ranked twice at one position on one date cannot happen (it is the primary key), so
    // the first writer wins and there is nothing to reconcile.
    // THE PANEL SHAPE, which `sd` cannot express: a standard deviation is a moment and says
    // nothing about WHICH SIDE the disagreement sits on. +1 means every dissenting voice is
    // BELOW the consensus (downside risk); -1 means they are all above it (unpriced upside).
    // MEASURED: skew correlates -0.012 with sd and keeps 96.9% of its spread after regressing
    // out the two ECR columns already fitted -- a separate dimension of the SAME external
    // source, which is the provenance that separated the one admitted weekly feature from four
    // derived rejects (docs/validation.md, 2026-09-24).
    // Narrowed with locals rather than a non-null assertion: `worst > best` is a REAL condition
    // here (the panel can agree exactly, and then the shape is undefined, not zero) and a `!`
    // would hide that a row with no spread must be NULL rather than 0.
    const lo = r.best, hi = r.worst;
    const skew = lo != null && hi != null && hi > lo
      ? ((hi - r.ecr) - (r.ecr - lo)) / (hi - lo)
      : null;
    m.set(`${r.player_id}|${pos}`, { ecr: r.ecr, sd: r.sd, skew });
  }
  const dates = [...byDate.keys()].sort();
  const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
  return {
    dates,
    get(cutoff, name, pos) {
      if (!cutoff || !dates.length) return null;
      // The latest scrape at or before the cutoff. Linear from the end is fine: <=20 dates a season.
      let chosen: string | null = null;
      for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= cutoff) { chosen = dates[i]; break; }
      if (!chosen) return null;
      const age = dayOf(cutoff) - dayOf(chosen);
      if (!Number.isFinite(age) || age > ECR_WEEK_MAX_AGE_DAYS) return null;
      return byDate.get(chosen)!.get(`${nameKey(name)}|${pos}`) ?? null;
    },
  };
}

/** This team's kickoff minus two days -- the cutoff `ecrWeekTable` is read at, and the same cutoff
 *  the Friday injury report uses. NULL where the team has no scheduled game (a bye), which is a row
 *  the decision population excludes anyway. */
export function ecrWeekCutoff(sched: ScheduleInfo, season: number, team: string | null, week: number): string | null {
  const day = team ? sched.teamGameDay.get(`${season}|${team}|${week}`) : undefined;
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 2 * 864e5).toISOString().slice(0, 10) : null;
}

/**
 * THE UPSERT, GENERATED FROM ONE COLUMN LIST rather than typed out twice.
 *
 * There were two copies of this statement -- the historical builder's and the forward builder's --
 * and adding ten columns to a hand-written INSERT/VALUES/DO-UPDATE triple in two places is four
 * opportunities to leave one column off one list, which SQLite reports as nothing at all: the row
 * writes, the column stays NULL, and the model quietly trains without it. One list, three renderings.
 */
const WEEK_MODEL_BASE_COLS = [
  "feat_key", "player_sk", "season", "week", "as_of", "name", "pos", "team", "opponent", "home",
  "is_bye", "season_line_pg", "td_games", "td_ppg", "t4_mean", "t4_sd", "td_fd", "td_ts",
  "td_attempts", "td_rush_yards", "rz_share_td", "prior_vol_cv",
  "prior_air_yards_share", "prior_wopr", "ecr_wk_rank", "ecr_wk_sd", "ecr_wk_skew",
  "dvp_mult", "dvp_n", "spread_line", "total_line",
  "implied_team_total", "days_rest", "pts",
];
/** The three columns the conflict target keys on, which must not appear in the SET clause. */
const WEEK_MODEL_KEY_COLS = new Set(["season", "week", "feat_key"]);

export function weekModelInsertSql(): string {
  const cols = [...WEEK_MODEL_BASE_COLS, ...CONTEXT_FIELDS.map((c) => c.name), "updated_at"];
  const params = cols.map((c) => (c === "updated_at" ? "@now" : `@${c}`));
  const set = cols.filter((c) => !WEEK_MODEL_KEY_COLS.has(c)).map((c) => `${c}=excluded.${c}`);
  return `INSERT INTO feat_player_week_model (${cols.join(", ")}) VALUES (${params.join(",")})\n` +
    `ON CONFLICT(season, week, feat_key) DO UPDATE SET ${set.join(", ")}`;
}

export interface BuildOpts {
  dbPath?: string;
  seasons: number[];
  /** The season treated as LIVE (board path for the season line). Defaults to the max season built. */
  currentSeason?: number;
  artifactPath?: string;
  /** PER-SEASON PROJECTION ARTIFACTS, EACH BLIND TO ITS OWN SEASON, for the HISTORICAL seasons'
   *  lines (2026-09-14). `<dir>/artifact-<season>.json`, as `ff evaluate-projection --keep-artifacts`
   *  writes them or as the trainer's `--holdout-season` does one at a time. Until D16 every historical
   *  season's line was projected with the single all-history artifact -- a model that had seen the
   *  season it was projecting -- which was recorded as a "mild" inherited lookahead when the artifact
   *  was a ridge on two multiplicative factors. The served projector is now a boosted ensemble that
   *  memorises far more of each season, so the same shortcut would hand the weekly trainer lines that
   *  know their own outcome and teach it to lean on the line in a way the honest live line cannot
   *  repay. A historical season with no artifact in the directory falls back to the shipped artifact
   *  and the build SAYS SO, loudly, per season. The live season always uses the shipped artifact,
   *  which has not seen it. */
  artifactDir?: string;
  /** WHICH FORMAT's projector anchors the season line, when `artifactPath` is not given outright.
   *  Omitted = the incumbent, so every existing caller is unchanged. `artifactDir` is deliberately
   *  NOT defaulted from this handle: the blind fold set is a deliberate, named choice at the call
   *  site (D17), and quietly supplying one would change the incumbent's weekly table. */
  model?: ModelHandle;
  log?: (s: string) => void;
  /** A pre-loaded schedule, so a test can be hermetic. Production callers omit it and the feed is
   *  read from the nflverse cache. */
  sched?: ScheduleInfo;
  /** Skip the preseason season line (it needs feat_player_season + feat_curve). Used by the leakage
   *  guard, whose fixture has no season history -- and it is safe there BECAUSE the season line is
   *  frozen at Y-09-01 and identical in every week, so it is structurally incapable of carrying
   *  week-w information either way. */
  noSeasonLine?: boolean;
  /** Fault-injection switch used ONLY by the leakage guard's positive control: when true the DvP
   *  window includes week w itself, which is the leak the guard exists to detect. Never set by
   *  production callers -- and the guard asserts the honest setting does NOT fire. */
  leakDvpThroughWeek?: boolean;
}

export interface BuildResult {
  rows: number;
  perSeason: { season: number; rows: number; withLine: number; withDvp: number; withPts: number }[];
}

/**
 * Load the artifact the season line is projected with. Same file the board ships -- FOR THIS FORMAT.
 *
 * The default used to be `dataPath("projection-artifact.json")`, i.e. the incumbent ESPN projector,
 * whichever format's weekly table was being built (F-4). Building a Yahoo weekly table anchored on a
 * half-PPR season line is a column that looks right, has full coverage, and is wrong for every row.
 * `model` names the format; omitted, it is still the incumbent, so the ESPN path is unchanged.
 */
export function loadWeeklyBaseArtifact(path?: string, model?: ModelHandle): ProjectionArtifact {
  // JUSTIFIED dataPath (WP3 grep): the INCUMBENT default when no format handle is passed -- the
  // same file `INCUMBENT_MODEL.path("projection")` resolves to, written this way only because the
  // value import would close the cycle described above. A format handle overrides it.
  const p = path ?? (model ? model.require("projection") : dataPath(ARTIFACT_FILE));
  return loadArtifact(JSON.parse(readFileSync(p, "utf8")));
}

/**
 * BUILD. One row per (season, week, player) that `feat_player_week` already holds, with the derived
 * point-in-time columns added.
 */
export async function buildWeekModelFeatures(opts: BuildOpts): Promise<BuildResult> {
  const db = openDb(opts.dbPath);
  try { return await buildInto(db, opts); } finally { db.close(); }
}

export async function buildInto(db: DB, opts: BuildOpts): Promise<BuildResult> {
  const seasons = [...opts.seasons].sort((a, b) => a - b);
  const current = opts.currentSeason ?? Math.max(...seasons);
  const artifact = opts.noSeasonLine ? null : loadWeeklyBaseArtifact(opts.artifactPath, opts.model);
  const sched = opts.sched ?? await loadSchedule(seasons);
  const now = nowIso();
  const log = opts.log ?? ((s: string) => console.log(s));

  // Which artifact projects a season's line. A historical season gets its own blind artifact from
  // `artifactDir` when one exists; the live season and any season without one get the shipped
  // artifact. The choice is printed per season because a leaky line and an honest one produce the
  // same column with the same coverage, and only this line tells them apart.
  const artifactFor = (season: number): ProjectionArtifact | null => {
    if (!artifact) return null;
    if (season < current && opts.artifactDir) {
      const p = join(opts.artifactDir, `artifact-${season}.json`);
      if (existsSync(p)) {
        const a = loadArtifact(JSON.parse(readFileSync(p, "utf8")));
        if (a.holdoutSeason !== season) {
          throw new Error(`${p} declares holdoutSeason ${a.holdoutSeason} but would project ${season} -- ` +
            "an artifact that saw the season it projects is lookahead, not a season line");
        }
        log(`  ${season}: season line from ${p} (blind to ${season})`);
        return a;
      }
    }
    if (season < current) {
      log(`  ${season}: WARNING season line from the shipped artifact (holdoutSeason ${artifact.holdoutSeason ?? "none"}) ` +
        `-- it has SEEN ${season}; pass --artifact-dir with a blind artifact-${season}.json for an honest line`);
    } else {
      log(`  ${season}: season line from the shipped artifact (live season, board path)`);
    }
    return artifact;
  };

  ensureContextColumns(db);
  const ins = db.prepare(weekModelInsertSql());

  const res: BuildResult = { rows: 0, perSeason: [] };
  for (const season of seasons) {
    const art = artifactFor(season);
    const line = art ? preseasonLinePerGame(db, season, art, sched, current) : new Map<string, number>();
    const dvp = dvpTable(db, season);
    const rzShare = rzShareTable(db, season);
    const priorVol = priorSeasonVol(db, season);
    const priorRole = priorSeasonRole(db, season);
    const ecrWk = ecrWeekTable(db, season);
    const ctx = contextFor(db, season);
    const raw = db.prepare(
      `SELECT feat_key, player_sk, season, week, name, pos, team, opponent, home, is_bye,
              spread_line, total_line, implied_team_total, td_games, td_fd, td_ts, td_attempts,
              td_rush_yards, td_pts, pts
         FROM feat_player_week WHERE season = ? ORDER BY feat_key, week`,
    ).all(season) as RawWeek[];

    // Per-player weekly actuals, for the trailing window. Read ONCE, and every use of it below is
    // bounded by `< week`; that bound is the only thing between this column and a perfect model.
    const byKey = new Map<string, Map<number, number>>();
    for (const r of raw) {
      if (r.pts == null) continue;
      (byKey.get(r.feat_key) ?? byKey.set(r.feat_key, new Map()).get(r.feat_key)!).set(r.week, r.pts);
    }

    let withLine = 0, withDvp = 0, withPts = 0, n = 0;
    db.transaction(() => {
      // REPLACE THE SEASON. The upsert keys on `feat_key`, which IS the surrogate key, so a rebuild
      // after the keys move cannot reach the old rows and simply doubles the table.
      db.prepare("DELETE FROM feat_player_week_model WHERE season = ?").run(season);
      for (const r of raw) {
        if (!WEEKLY_POS.includes(r.pos)) continue;
        // as_of: the day before the week's FIRST kickoff, league-wide. Falls back to the season's
        // September 1 anchor rather than to a fabricated date when the schedule has no day at all.
        const asOf = sched.weekAsOf.get(`${season}|${r.week}`) ?? `${season}-09-01`;

        // trailing-4: the last <=4 games PLAYED strictly before week w. Games played, not weeks --
        // a bye or an inactive week is not a zero, and counting it as one would drag every returning
        // player's trailing mean down by a quarter.
        const played = byKey.get(r.feat_key);
        const prior: number[] = [];
        if (played) {
          for (let w = r.week - 1; w >= 1 && prior.length < 4; w--) {
            const v = played.get(w); if (v != null) prior.push(v);
          }
        }
        const t4mean = prior.length ? prior.reduce((s, x) => s + x, 0) / prior.length : null;
        const t4sd = prior.length >= 2
          ? Math.sqrt(prior.reduce((s, x) => s + (x - t4mean!) ** 2, 0) / prior.length)
          : null;

        // days_rest: days between this team's previous scheduled game and this one. Schedule-derived,
        // so it is known in August; NULL in a team's first game of the season rather than a
        // made-up 7.
        let daysRest: number | null = null;
        if (r.team) {
          const thisDay = sched.teamGameDay.get(`${season}|${r.team}|${r.week}`);
          let prevDay: string | undefined;
          for (let w = r.week - 1; w >= 1 && !prevDay; w--) prevDay = sched.teamGameDay.get(`${season}|${r.team}|${w}`);
          if (thisDay && prevDay) {
            const d = (Date.parse(`${thisDay}T00:00:00Z`) - Date.parse(`${prevDay}T00:00:00Z`)) / 864e5;
            daysRest = Number.isFinite(d) && d > 0 ? d : null;
          }
        }

        // DvP for the OPPONENT defence: weeks strictly before w of season Y, blended with all of
        // Y-1 and shrunk toward 1.0. `leakDvpThroughWeek` is the guard's positive control and is
        // never set in production -- it moves the bound to `<= w`, i.e. the leak itself.
        const dvpWeek = opts.leakDvpThroughWeek ? r.week + 1 : r.week;
        const d = r.opponent ? dvp.get(dvpWeek, r.opponent, r.pos) : null;

        const row = {
          feat_key: r.feat_key, player_sk: r.player_sk, season, week: r.week, as_of: asOf,
          name: r.name, pos: r.pos, team: r.team, opponent: r.opponent,
          home: r.home, is_bye: r.is_bye ?? 0,
          // season line: preseason (as-of Y-09-01) projection / scheduled games. Frozen before
          // week 1, identical in every week of the season -- deliberately, because it is the
          // "what we thought in August" anchor the weekly ratio is measured against.
          season_line_pg: finite(line.get(r.feat_key) ?? null),
          // usage and points TO DATE come straight from feat_player_week, which accumulates AFTER
          // writing each row (see src/features/build.ts). They are week 1..w-1 by construction.
          td_games: r.td_games ?? 0,
          td_ppg: finite(r.td_pts),
          t4_mean: finite(t4mean), t4_sd: finite(t4sd),
          td_fd: finite(r.td_fd), td_ts: finite(r.td_ts),
          td_attempts: finite(r.td_attempts), td_rush_yards: finite(r.td_rush_yards),
          // rolling red-zone touch share to date (weeks < w), point-in-time via the prefix-sum bound.
          rz_share_td: finite(rzShare.get(r.week, r.player_sk, r.team)),
          // prior-season weekly CV (volatility), constant across the season and always known.
          prior_vol_cv: finite(r.player_sk != null ? priorVol.get(String(r.player_sk)) ?? null : null),
          // prior-season role shape, constant across the season and knowable on September 1.
          prior_air_yards_share: finite(r.player_sk != null ? priorRole.get(String(r.player_sk))?.airShare ?? null : null),
          prior_wopr: finite(r.player_sk != null ? priorRole.get(String(r.player_sk))?.wopr ?? null : null),
          // WEEKLY EXPERT CONSENSUS as of this team's kickoff minus two days. NULL outside 2020-2024,
          // which is the whole archive, and NULL for anyone the panel did not rank that week.
          ...(() => {
            const e = ecrWk.get(ecrWeekCutoff(sched, season, r.team, r.week) ?? "", r.name, r.pos);
            return { ecr_wk_rank: e ? e.ecr : null, ecr_wk_sd: e ? finite(e.sd) : null,
                     ecr_wk_skew: e ? finite(e.skew) : null };
          })(),
          dvp_mult: d ? d.mult : null, dvp_n: d ? d.n : null,
          // schedule and market columns as published preseason / pre-kickoff.
          spread_line: finite(r.spread_line), total_line: finite(r.total_line),
          implied_team_total: finite(r.implied_team_total),
          days_rest: daysRest,
          // TARGET. Not a feature; the loader below never selects it into a feature row.
          pts: finite(r.pts),
          // THE AVAILABILITY BLOCK, joined by surrogate key. A row with no surrogate key (a
          // synthetic DST) gets NULLs rather than zeros: "we cannot look him up" is not "he is fit".
          ...EMPTY_CONTEXT,
          ...(r.player_sk != null ? ctx.get(`${r.week}|${Number(r.player_sk)}`) ?? {} : {}),
          now,
        };
        ins.run(row);
        n++;
        if (row.season_line_pg != null) withLine++;
        if (row.dvp_mult != null) withDvp++;
        if (row.pts != null) withPts++;
      }
    })();
    res.rows += n;
    res.perSeason.push({ season, rows: n, withLine, withDvp, withPts });
  }
  // THE DECISION POPULATION IS A COLUMN ON THIS TABLE, so it is built HERE rather than in a step
  // somebody has to remember. It is derived from what was just written (the preseason line ranks)
  // plus Track B's roster feed, so it can only be correct after the rows exist. Both the Python
  // trainer and the TypeScript harness select on this flag; see src/weekly/population.ts.
  buildPopulation(db, opts.seasons);
  return res;
}

/** COVERAGE, per column per season. What a report quotes instead of assuming a column is populated. */
export function weeklyCoverage(db: DB, seasons?: number[]): {
  season: number; rows: number; cols: Record<string, number>;
}[] {
  const cols = [
    "season_line_pg", "td_games", "td_ppg", "t4_mean", "t4_sd", "td_fd", "td_ts",
    "td_attempts", "td_rush_yards", "dvp_mult", "home", "spread_line", "total_line",
    "implied_team_total", "days_rest", "pts", "ecr_wk_rank", "ecr_wk_sd", "ecr_wk_skew",
    ...CONTEXT_FIELDS.map((c) => c.name),
  ];
  // A column this store does not HAVE reports 0, exactly like a column it has and never filled.
  // Both are "the model did not see it", which is what a coverage table is for.
  const present = new Set<string>([
    ...presentContextFields(db).map((c) => String(c.name)), ...presentEcrWeekFields(db)]);
  const isContext = new Set<string>([
    ...CONTEXT_FIELDS.map((c) => String(c.name)), ...ECR_WEEK_FIELDS]);
  const where = seasons?.length ? ` WHERE season IN (${seasons.map(() => "?").join(",")})` : "";
  const sel = cols.map((c) =>
    (!isContext.has(c) || present.has(c) ? `SUM(${c} IS NOT NULL)` : "0") + ` AS ${c}`).join(", ");
  const rows = db.prepare(
    `SELECT season, COUNT(*) AS rows_n, ${sel} FROM feat_player_week_model${where} GROUP BY season ORDER BY season`,
  ).all(...(seasons ?? [])) as Record<string, number>[];
  return rows.map((r) => ({
    season: r.season, rows: r.rows_n,
    cols: Object.fromEntries(cols.map((c) => [c, r[c] ?? 0])),
  }));
}

/** The column list `weeklyCoverage` reports on, derived once so the live tripwire below cannot
 *  drift from the season table it is compared against. */
export const COVERAGE_COLUMNS: string[] = [
  "season_line_pg", "td_games", "td_ppg", "t4_mean", "t4_sd", "td_fd", "td_ts",
  "td_attempts", "td_rush_yards", "dvp_mult", "home", "spread_line", "total_line",
  "implied_team_total", "days_rest", "ecr_wk_rank", "ecr_wk_sd", "ecr_wk_skew",
  ...CONTEXT_FIELDS.map((c) => String(c.name)),
];

/** One column's live-week coverage against the band the same week carried in prior seasons. */
export interface LiveCoverageRow {
  column: string;
  /** Share of the live week's decision-population rows carrying the column, 0..1. */
  live: number;
  /** The same share in each prior season at the SAME week, and its min/max. */
  prior: { season: number; share: number }[];
  bandLo: number; bandHi: number;
  /** `dark` = the column is empty live and the band says it should not be. `below` = present but
   *  materially under the band. `ok` = inside or above it. `none` = the band itself is empty, so
   *  there is nothing to compare against and silence means nothing. */
  status: "ok" | "below" | "dark" | "none";
}

/**
 * THE LIVE-WEEK COVERAGE TRIPWIRE (WP17).
 *
 * `weeklyCoverage` reports per SEASON, which is exactly the resolution at which the 2026 regression
 * hid: the season average of a live season with two weeks in it is dominated by future weeks that
 * legitimately carry nothing, so a column that went dark at the serve looks like an ordinary
 * partially-built season. The ablation found it only because somebody queried one week by hand.
 *
 * So this compares the LIVE WEEK against what the SAME WEEK carried in prior seasons -- the only
 * comparison in which "100% NULL" is distinguishable from "not published yet at this point in the
 * year". A column dark live with a healthy band is the shape that cost -0.71 points per lineup per
 * week, undetected, for the whole of 2026 so far.
 *
 * `bandLo` is the prior seasons' MINIMUM, not their mean: the question is whether the live week is
 * outside anything ever seen at this point in a season, and a mean would let one bad year widen the
 * gate. A column with no prior coverage at all reports `none` rather than a pass -- silence from a
 * feed that has never spoken is not evidence.
 */
export function liveWeekCoverage(db: DB, season: number, week: number, priorSeasons = 3): LiveCoverageRow[] {
  const present = new Set<string>([
    ...presentContextFields(db).map((c) => String(c.name)), ...presentEcrWeekFields(db)]);
  const isContext = new Set<string>([
    ...CONTEXT_FIELDS.map((c) => String(c.name)), ...ECR_WEEK_FIELDS]);
  const cols = COVERAGE_COLUMNS.filter((c) => !isContext.has(c) || present.has(c));
  const havePop = (db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .some((c) => c.name === POPULATION_COLUMN);
  // The DECISION population, which is what a lineup is set from. Falling back to the whole table on
  // a store without the flag keeps this readable on an old copy rather than throwing.
  const where = `season = ? AND week = ? AND COALESCE(is_bye, 0) = 0${havePop ? ` AND COALESCE(${POPULATION_COLUMN}, 0) = 1` : ""}`;
  const sel = cols.map((c) => `SUM(${c} IS NOT NULL) AS ${c}`).join(", ");
  const q = db.prepare(`SELECT COUNT(*) AS rows_n, ${sel} FROM feat_player_week_model WHERE ${where}`);
  const shareOf = (s: number): Record<string, number> | null => {
    const r = q.get(s, week) as Record<string, number>;
    if (!r || !r.rows_n) return null;
    return Object.fromEntries(cols.map((c) => [c, (r[c] ?? 0) / r.rows_n]));
  };
  const liveRow = shareOf(season);
  const priors: { season: number; cols: Record<string, number> }[] = [];
  for (let s = season - priorSeasons; s < season; s++) {
    const r = shareOf(s);
    if (r) priors.push({ season: s, cols: r });
  }
  return cols.map((c) => {
    const prior = priors.map((p) => ({ season: p.season, share: p.cols[c] }));
    const shares = prior.map((p) => p.share);
    const bandLo = shares.length ? Math.min(...shares) : 0;
    const bandHi = shares.length ? Math.max(...shares) : 0;
    const live = liveRow ? liveRow[c] : 0;
    let status: LiveCoverageRow["status"] = "ok";
    if (!shares.length || bandHi < 0.05) status = "none";
    else if (live < 0.01) status = "dark";
    else if (live < bandLo - 0.10) status = "below";
    return { column: c, live, prior, bandLo, bandHi, status };
  });
}

/** One feature row in evaluator shape. `pts` is NOT here: the target cannot be read by accident. */
export interface WeeklyRow {
  feat_key: string; player_sk: string | null; season: number; week: number;
  name: string; pos: string; team: string | null; opponent: string | null;
  season_line_pg: number | null;
  /** DvP is NO LONGER a weekly-model feature (D19: neutral under boosting, dropped from the feature
   *  dictionary and the trainer). It survives here as a dormant stored column ONLY so the scorecard's
   *  legacy `shipped_week` comparison arm (makeProjections + defRatings) is unchanged; the served
   *  `weekly` model never reads it. */
  dvp_mult: number | null;
  f: Partial<Record<WeeklyFeatureField, number | null>>;
}

/**
 * Which availability columns THIS store actually has.
 *
 * `ensureContextColumns` adds them on every build, so a store that has been built is complete. A
 * store that has not -- a hermetic test fixture, an old copy -- has the table without them, and
 * naming a missing column in a SELECT is a hard SQLite error rather than a NULL. Reading the columns
 * that exist and returning NULL for the rest says "this store does not carry that" in the one form
 * every consumer already handles, which is the same thing a store that carries it and has no value
 * says. The difference between the two is reported by `weeklyCoverage`, and the trainer REFUSES to
 * fit a two-part model when they are absent rather than quietly fitting without them.
 */
/**
 * The M2a consensus columns, IF this store has them.
 *
 * Same reasoning as `presentContextFields`, and it is not hypothetical: a per-format `features.db`
 * built before 2026-09-16 has the table without these two columns, and naming a missing column in a
 * SELECT is a hard SQLite error rather than a NULL -- so a hard-coded select would take down the
 * SERVING path (`projectStreamingWith` reads through this loader) on every store that has not been
 * migrated. A store that lacks them reads NULL, which is the same statement the 2025+ seasons make.
 */
export const ECR_WEEK_FIELDS = ["ecr_wk_rank", "ecr_wk_sd", "ecr_wk_skew"] as const;
export function presentEcrWeekFields(db: DB): string[] {
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .map((c) => c.name));
  return ECR_WEEK_FIELDS.filter((c) => have.has(c));
}

export function presentContextFields(db: DB): typeof CONTEXT_FIELDS {
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .map((c) => c.name));
  return CONTEXT_FIELDS.filter((c) => have.has(c.name));
}

/**
 * Load feature rows for one (season, week) -- or a whole season when `week` is omitted.
 *
 * THE STREAMING BLOCK IS JOINED HERE, NOT AT THE CALL SITE, and that is the difference between a
 * serving path that works and one that silently degrades. Every declared feature the loader does not
 * supply falls back on its artifact-declared `missing` default, which for a centred column is "exactly
 * league average" -- so a streaming artifact served through a loader that forgot the join would
 * produce a plausible number for every player and no error anywhere. One join, in the one function
 * both the projector and the evaluator read through.
 *
 * A store WITHOUT the streaming table reads every streaming column as NULL, which is the same
 * statement a store that has the table and no value makes. `streamCoverage` is what separates them.
 */
export function loadWeeklyRows(db: DB, season: number, week?: number): WeeklyRow[] {
  const present = presentContextFields(db);
  const ecrWk = presentEcrWeekFields(db);
  const stream = presentStreamFields(db);
  const rows = db.prepare(
    `SELECT m.feat_key, m.player_sk, m.season, m.week, m.name, m.pos, m.team, m.opponent, m.home,
            m.season_line_pg, m.td_games, m.td_ppg, m.t4_mean, m.t4_sd, m.td_fd, m.td_ts,
            m.td_attempts, m.td_rush_yards, m.rz_share_td, m.prior_vol_cv,
            m.prior_air_yards_share, m.prior_wopr,
            m.dvp_mult, m.dvp_n, m.spread_line, m.total_line,
            m.implied_team_total, m.days_rest
            ${ecrWk.length ? ", " + ecrWk.map((c) => `m.${c}`).join(", ") : ""}
            ${present.length ? ", " + present.map((c) => `m.${c.name}`).join(", ") : ""}
            ${stream.length ? ", " + stream.map((c) => `s.${c}`).join(", ") : ""}
       FROM feat_player_week_model m
       ${stream.length
      ? "LEFT JOIN feat_player_week_stream s ON s.season = m.season AND s.week = m.week AND s.feat_key = m.feat_key"
      : ""}
      WHERE m.season = ?${week == null ? "" : " AND m.week = ?"}
      ORDER BY m.week, m.pos, m.name`,
  ).all(...(week == null ? [season] : [season, week])) as Record<string, unknown>[];
  return rows.map((r) => ({
    feat_key: String(r.feat_key), player_sk: (r.player_sk as string | null) ?? null,
    season: Number(r.season), week: Number(r.week),
    name: String(r.name ?? ""), pos: String(r.pos ?? ""),
    team: (r.team as string | null) ?? null, opponent: (r.opponent as string | null) ?? null,
    season_line_pg: r.season_line_pg == null ? null : Number(r.season_line_pg),
    dvp_mult: r.dvp_mult == null ? null : Number(r.dvp_mult),
    f: {
      td_games: r.td_games == null ? null : Number(r.td_games),
      td_ppg: r.td_ppg == null ? null : Number(r.td_ppg),
      t4_mean: r.t4_mean == null ? null : Number(r.t4_mean),
      t4_sd: r.t4_sd == null ? null : Number(r.t4_sd),
      td_fd: r.td_fd == null ? null : Number(r.td_fd),
      td_ts: r.td_ts == null ? null : Number(r.td_ts),
      td_attempts: r.td_attempts == null ? null : Number(r.td_attempts),
      td_rush_yards: r.td_rush_yards == null ? null : Number(r.td_rush_yards),
      rz_share_td: r.rz_share_td == null ? null : Number(r.rz_share_td),
      prior_vol_cv: r.prior_vol_cv == null ? null : Number(r.prior_vol_cv),
      prior_air_yards_share: r.prior_air_yards_share == null ? null : Number(r.prior_air_yards_share),
      prior_wopr: r.prior_wopr == null ? null : Number(r.prior_wopr),
      ecr_wk_rank: r.ecr_wk_rank == null ? null : Number(r.ecr_wk_rank),
      ecr_wk_skew: r.ecr_wk_skew == null ? null : Number(r.ecr_wk_skew),
      ecr_wk_sd: r.ecr_wk_sd == null ? null : Number(r.ecr_wk_sd),
      home: r.home == null ? null : Number(r.home),
      spread_line: r.spread_line == null ? null : Number(r.spread_line),
      total_line: r.total_line == null ? null : Number(r.total_line),
      implied_team_total: r.implied_team_total == null ? null : Number(r.implied_team_total),
      days_rest: r.days_rest == null ? null : Number(r.days_rest),
      season_line_pg: r.season_line_pg == null ? null : Number(r.season_line_pg),
      week_no: Number(r.week),
      ...Object.fromEntries(CONTEXT_FIELDS.map((c) =>
        [c.name, r[c.name] == null ? null : Number(r[c.name])])),
      ...Object.fromEntries(STREAM_FIELD_NAMES.map((c) =>
        [c, r[c] == null ? null : Number(r[c])])),
      // (the map above covers every declared field; the ones this store lacks were never selected
      // and land as null, which is the same statement a NULL cell makes)
    },
  }));
}

// ==================================================================================================
// THE LIVE SEASON.
//
// buildInto above builds from `feat_player_week`, which is built from `history-weekly.csv`, which is
// built from games that have been PLAYED. In September of a live season that table is empty for the
// current year, so the weekly model would have nothing to serve from in exactly the month it matters
// -- the failure mode where a harness is excellent on history and cannot answer a question about
// this Sunday.
//
// So the forward builder assembles the same rows from what DOES exist before kickoff: the published
// schedule, the board's preseason season line, the prior season's defence, and whatever weeks of the
// current season have already been played. Every column keeps the as-of rule it has above; nothing
// new is invented. A week with no line published yet carries NULL, not a mean.
// ==================================================================================================

export interface ForwardOpts {
  dbPath?: string;
  season: number;
  artifactPath?: string;
  /** The format whose projector anchors the season line. Omitted = the incumbent (unchanged). */
  model?: ModelHandle;
  sched?: ScheduleInfo;
  /** Read the live spread/total for the imminent week from `team_odds` where the schedules feed has
   *  not published one. Off by default because team_odds carries ONE week -- whichever was last
   *  synced -- and applying it to every week would date-stamp the wrong game. */
  useTeamOdds?: boolean;
}

export interface ForwardResult {
  season: number; weeks: number; rows: number; players: number;
  withLine: number; withLines: number; playedWeeks: number[];
}

/**
 * Build `feat_player_week_model` for a season that has not finished (or has not started).
 *
 * The universe is the BOARD -- every player the current consensus ranks -- because that is who
 * exists in September. A completed season's universe is everyone who was scored, and using that
 * rule here would produce an empty table.
 */
export async function buildForwardWeeks(opts: ForwardOpts): Promise<ForwardResult> {
  const db = openDb(opts.dbPath);
  try { return await buildForwardInto(db, opts); } finally { db.close(); }
}

export async function buildForwardInto(db: DB, opts: ForwardOpts): Promise<ForwardResult> {
  const season = opts.season;
  const artifact = loadWeeklyBaseArtifact(opts.artifactPath, opts.model);
  const sched = opts.sched ?? await loadSchedule([season]);
  const now = nowIso();

  // The board: the season line, from the LIVE path (consensus rank), which is the only source that
  // knows about a rookie.
  const line = preseasonLinePerGame(db, season, artifact, sched, season);
  const board = db.prepare(
    "SELECT feat_key, player_sk, name, pos, team FROM feat_player_season WHERE season = ? AND pos IS NOT NULL",
  ).all(season) as { feat_key: string; player_sk: string | null; name: string; pos: string; team: string | null }[];

  // Weeks: every REG week the schedule publishes for this season.
  const weeks = [...new Set([...sched.weekAsOf.keys()]
    .filter((k) => k.startsWith(`${season}|`)).map((k) => Number(k.split("|")[1])))].sort((a, b) => a - b);

  // Per-team schedule, from that team's side, straight off the feed.
  const feed = await fetchCsvCached(URLS.schedules, cacheTag.schedules);
  const game = new Map<string, { opp: string; home: number; spread: number | null; total: number | null; implied: number | null }>();
  for (const g of feed) {
    if (Number(pick(g, "season")) !== season || pick(g, "game_type") !== "REG") continue;
    const wk = Number(pick(g, "week")); if (!wk) continue;
    const home = canonTeam(pick(g, "home_team")), away = canonTeam(pick(g, "away_team"));
    const numOrNull = (v: string) => (v === "" || v == null || v === "NA" || !Number.isFinite(Number(v)) ? null : Number(v));
    const sp = numOrNull(String(g.spread_line ?? "")), tl = numOrNull(String(g.total_line ?? ""));
    const half = tl != null ? tl / 2 : null;
    game.set(`${home}|${wk}`, { opp: away, home: 1, spread: sp, total: tl, implied: half != null && sp != null ? half + sp / 2 : null });
    game.set(`${away}|${wk}`, { opp: home, home: 0, spread: sp != null ? -sp : null, total: tl, implied: half != null && sp != null ? half - sp / 2 : null });
  }

  // Live odds, for the ONE week team_odds describes. It is a snapshot of the imminent week and
  // carries no week number, so it is applied only where the feed has published nothing -- and only
  // to the earliest week that still has no line, which is the week it can only be about.
  const odds = new Map<string, { spread: number; total: number; implied: number }>();
  if (opts.useTeamOdds) {
    for (const r of db.prepare("SELECT team, spread, total, implied_total FROM team_odds").all() as
      { team: string; spread: number | null; total: number | null; implied_total: number | null }[]) {
      if (r.spread != null && r.total != null) {
        odds.set(canonTeam(r.team), { spread: r.spread, total: r.total, implied: r.implied_total ?? r.total / 2 - r.spread / 2 });
      }
    }
  }
  const firstUnpriced = weeks.find((w) => board.some((p) => p.team && game.get(`${p.team}|${w}`) && game.get(`${p.team}|${w}`)!.spread == null)) ?? -1;

  // Whatever of this season has already been played, for the to-date and trailing columns.
  const playedRows = db.prepare(
    "SELECT feat_key, week, pts, td_games, td_fd, td_ts, td_attempts, td_rush_yards, td_pts FROM feat_player_week WHERE season = ? AND pts IS NOT NULL",
  ).all(season) as { feat_key: string; week: number; pts: number; td_games: number | null; td_fd: number | null; td_ts: number | null; td_attempts: number | null; td_rush_yards: number | null; td_pts: number | null }[];
  const played = new Map<string, Map<number, typeof playedRows[number]>>();
  for (const r of playedRows) (played.get(r.feat_key) ?? played.set(r.feat_key, new Map()).get(r.feat_key)!).set(r.week, r);
  const playedWeeks = [...new Set(playedRows.map((r) => r.week))].sort((a, b) => a - b);

  // THE TO-DATE RATIOS, READ FROM THIS WEEK'S OWN ROW (WP17).
  //
  // They used to be read off the last PLAYED row before this week, and that was silently always
  // NULL: `feat_player_week`'s to-date columns accumulate AFTER the row is written, so the last
  // played row before week w carries "through w-2", and in week 2 -- the first week these columns
  // can say anything -- the last played row is week 1, whose to-date span is empty by construction.
  // The forward board writes a row for EVERY week of the live season, and week w's row already holds
  // weeks 1..w-1, which is exactly the point-in-time quantity. So read that, and keep the old
  // last-played-row value as the fallback for a (season, week) the board has no row for.
  const toDate = new Map<string, { td_fd: number | null; td_ts: number | null; td_attempts: number | null; td_rush_yards: number | null }>();
  for (const r of db.prepare(
    "SELECT feat_key, week, td_fd, td_ts, td_attempts, td_rush_yards FROM feat_player_week WHERE season = ?",
  ).all(season) as { feat_key: string; week: number; td_fd: number | null; td_ts: number | null; td_attempts: number | null; td_rush_yards: number | null }[]) {
    toDate.set(`${r.feat_key}|${r.week}`, r);
  }

  const dvp = dvpTable(db, season);
  const rzShare = rzShareTable(db, season);
  const priorVol = priorSeasonVol(db, season);
  const priorRole = priorSeasonRole(db, season);
  // The live season has NO weekly-consensus rows in `ranking_history` (the archive stops in 2024), so
  // this reads empty and every forward row is NULL. That is the honest state and it is why the column
  // is a candidate rather than a serve: see `ecrWeekTable`'s era bound.
  const ecrWk = ecrWeekTable(db, season);

  ensureContextColumns(db);
  const ins = db.prepare(weekModelInsertSql());
  const ctx = contextFor(db, season);

  let rows = 0, withLine = 0, withLines = 0;
  db.transaction(() => {
    // REPLACE THE FORWARD SEASON. Same reason as the historical pass: the upsert key contains the
    // surrogate key, so rows written under keys that have since moved survive a rebuild invisibly.
    db.prepare("DELETE FROM feat_player_week_model WHERE season = ?").run(season);
    for (const p of board) {
      if (!WEEKLY_POS.includes(p.pos)) continue;
      const hist = played.get(p.feat_key);
      for (const week of weeks) {
        const g = p.team ? game.get(`${p.team}|${week}`) : undefined;
        const asOf = sched.weekAsOf.get(`${season}|${week}`) ?? `${season}-09-01`;
        const prior: number[] = [];
        if (hist) for (let w = week - 1; w >= 1 && prior.length < 4; w--) { const v = hist.get(w); if (v) prior.push(v.pts); }
        const t4mean = prior.length ? prior.reduce((s, x) => s + x, 0) / prior.length : null;
        const t4sd = prior.length >= 2 ? Math.sqrt(prior.reduce((s, x) => s + (x - t4mean!) ** 2, 0) / prior.length) : null;
        // to-date columns come from the LAST played row before this week, which already carries
        // "through w-1" by construction (src/features/build.ts accumulates after writing).
        let td: typeof playedRows[number] | undefined;
        if (hist) for (let w = week - 1; w >= 1 && !td; w--) td = hist.get(w);
        const games = hist ? [...hist.keys()].filter((w) => w < week).length : 0;
        const ptsSoFar = hist ? [...hist.entries()].filter(([w]) => w < week).reduce((s, [, v]) => s + v.pts, 0) : 0;

        let daysRest: number | null = null;
        if (p.team) {
          const thisDay = sched.teamGameDay.get(`${season}|${p.team}|${week}`);
          let prevDay: string | undefined;
          for (let w = week - 1; w >= 1 && !prevDay; w--) prevDay = sched.teamGameDay.get(`${season}|${p.team}|${w}`);
          if (thisDay && prevDay) {
            const d = (Date.parse(`${thisDay}T00:00:00Z`) - Date.parse(`${prevDay}T00:00:00Z`)) / 864e5;
            daysRest = Number.isFinite(d) && d > 0 ? d : null;
          }
        }

        const o = week === firstUnpriced && p.team ? odds.get(p.team) : undefined;
        const spread = g?.spread ?? o?.spread ?? null;
        const total = g?.total ?? o?.total ?? null;
        const implied = g?.implied ?? o?.implied ?? null;
        const d = g?.opp ? dvp.get(week, g.opp, p.pos) : null;

        ins.run({
          feat_key: p.feat_key, player_sk: p.player_sk, season, week, as_of: asOf,
          name: p.name, pos: p.pos, team: p.team, opponent: g?.opp ?? null,
          home: g ? g.home : null, is_bye: g ? 0 : 1,
          season_line_pg: finite(line.get(p.feat_key) ?? null),
          td_games: games, td_ppg: games ? ptsSoFar / games : null,
          t4_mean: finite(t4mean), t4_sd: finite(t4sd),
          ...(() => {
            const own = toDate.get(`${p.feat_key}|${week}`) ?? td ?? null;
            return {
              td_fd: finite(own?.td_fd ?? null), td_ts: finite(own?.td_ts ?? null),
              td_attempts: finite(own?.td_attempts ?? null), td_rush_yards: finite(own?.td_rush_yards ?? null),
            };
          })(),
          rz_share_td: finite(rzShare.get(week, p.player_sk, p.team)),
          prior_vol_cv: finite(p.player_sk != null ? priorVol.get(String(p.player_sk)) ?? null : null),
          prior_air_yards_share: finite(p.player_sk != null ? priorRole.get(String(p.player_sk))?.airShare ?? null : null),
          prior_wopr: finite(p.player_sk != null ? priorRole.get(String(p.player_sk))?.wopr ?? null : null),
          ...(() => {
            const e = ecrWk.get(ecrWeekCutoff(sched, season, p.team, week) ?? "", p.name, p.pos);
            return { ecr_wk_rank: e ? e.ecr : null, ecr_wk_sd: e ? finite(e.sd) : null,
                     ecr_wk_skew: e ? finite(e.skew) : null };
          })(),
          dvp_mult: d ? d.mult : null, dvp_n: d ? d.n : null,
          spread_line: spread, total_line: total, implied_team_total: implied,
          days_rest: daysRest,
          pts: finite(hist?.get(week)?.pts ?? null),
          ...EMPTY_CONTEXT,
          ...(p.player_sk != null ? ctx.get(`${week}|${Number(p.player_sk)}`) ?? {} : {}),
          now,
        });
        rows++;
        if (line.get(p.feat_key) != null) withLine++;
        if (spread != null) withLines++;
      }
    }
  })();

  // THE POPULATION IS REBUILT BECAUSE THE ROWS WERE. This path DELETEs the season and rewrites it,
  // which would otherwise leave `in_population` NULL for the live season -- and a NULL there is
  // indistinguishable from "never built", which is what the trainer and the harness refuse on. It
  // matters most for the season a decision is actually being made in.
  buildPopulation(db, [season]);

  return { season, weeks: weeks.length, rows, players: board.length, withLine, withLines, playedWeeks };
}
