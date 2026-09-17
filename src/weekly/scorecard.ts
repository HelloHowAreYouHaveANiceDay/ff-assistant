/**
 * THE FORWARD SCORECARD: what we predicted, what happened, accruing weekly.
 *
 * Everything else in this repo is a backtest. A backtest is a claim about a model measured by the
 * person who built it, on data that already existed when he built it, and every safeguard in
 * CLAUDE.md exists because that arrangement keeps producing numbers that do not survive contact with
 * a new season. The scorecard is the one measurement that cannot be gamed after the fact, and it
 * gets its integrity from ONE property:
 *
 *   A PREDICTION IS WRITTEN ONCE, BEFORE KICKOFF, AND NEVER UPDATED.
 *
 * `scorecard_prediction` is INSERT OR IGNORE. Re-running the snapshot is a no-op rather than a
 * rewrite, so a model that is improved mid-season cannot retroactively improve its record; it can
 * only start a new one. `scorecard_result` is the opposite -- freely rebuildable -- because scoring
 * is a pure function of a frozen prediction and a settled actual, and a rebuildable score with a
 * frozen prediction is exactly the right way round.
 *
 * THE SNAPSHOT REFUSES TO RUN LATE. If the week's first kickoff has passed, the snapshot for that
 * week is not taken. A "prediction" written after the games is the single failure this whole file
 * exists to prevent, and it would leave no trace: the row would look exactly like an honest one.
 *
 * THREE KINDS.
 *   weekly -- per player, per week: our model, the season line, the shipped week() path, trailing-4,
 *             and ESPN's own number where the bridge could read it.
 *   season -- per player, once: the preseason season projection, scored against points-to-date.
 *   odds   -- per team, once: playoff and title probability, scored by Brier once the season
 *             resolves. Written only where the store actually holds such a number; this file does
 *             not manufacture one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, nowIso, activeLeagueId, getConfig, type DB } from "../db/db.js";
import { scoringKeyFor } from "../data/formatKey.js";
import {
  loadWeeklyArtifact, projectWeekly, seasonLineOnlyArtifact,
  CHALLENGER_WEEKLY_ARTIFACT, type WeeklyArtifact,
} from "./projector.js";
import { loadWeeklyRows, loadSchedule, type ScheduleInfo } from "./features.js";
import { makeProjections } from "../projections.js";
import { score, lineupRegret, type Scored1, type Pred } from "./evaluate.js";
import { fetchEspnWeekly, storeEspnWeekly } from "./espnProjections.js";
import {
  projectStreamingWith, topStreamPick, serveTable, weeklyArtifactPath,
  STREAM_SERVE_POS, WEEKLY_SERVE_SWITCHED_ON,
} from "./streamingServe.js";
import { POOL_DEPTH } from "./streamingEvaluate.js";
// THE SUNDAY RE-READ (M2c) reuses the two rules it must not fork: `normalizeStatus` decides who is
// startable everywhere in this repo (DOUBTFUL is OUT, QUESTIONABLE is not), and `optimalLineup` is
// the assignment the copilot serves. A second copy of either here would let the scorecard and the
// lineup surface disagree about the same week.
import { normalizeStatus } from "../inseason/copilot.js";
import { optimalLineup } from "../inseason/lineup.js";
import { startingTemplate, buildEspnResolver } from "../features/sources/rosterState.js";

export const SCORECARD_MODELS = ["weekly", "season_line", "shipped_week", "trailing4", "espn"] as const;
export type ScorecardModel = typeof SCORECARD_MODELS[number];
/** The model the weekly gains are quoted against, matching src/weekly/evaluate.ts. */
export const SC_BASELINE: ScorecardModel = "shipped_week";

/**
 * THE DUAL SNAPSHOT, and why there are two kinds rather than a sixth model.
 *
 * `weekly` is the SHIPPED path: its `weekly` model is served, PER POSITION, from whatever
 * `WEEKLY_SERVE` in streamingServe.ts says serves that position -- the same table `lineupRecommend`
 * and the stream picks read -- so the record accrues for the thing a decision was actually made on.
 * `weekly_challenger` is the two-part model for EVERY position, snapshotted on the same players, in
 * the same week, with the same frozen `as_of`, projected from `CHALLENGER_WEEKLY_ARTIFACT`.
 *
 * The challenger stays whole-field even where the two-part model now SHIPS at a position. That is
 * deliberate: an unbroken series is the only thing that lets the two be compared over the season, and
 * a challenger that quietly stopped covering the positions it won would leave a record that flatters
 * it by omission.
 *
 * Two kinds, not one kind with an extra model, because they answer different questions and the
 * lineup-regret baseline inside a kind only means something when every model in it was available to
 * choose from. Mixing an unshipped model into `weekly` would make its lineup column read as a
 * lineup somebody could have set.
 */
export const SCORECARD_KINDS = ["weekly", "weekly_challenger", "weekly_ecr_candidate", "weekly_sunday", "stream"] as const;
export type ScorecardKind = typeof SCORECARD_KINDS[number];

/**
 * THE `weekly_ecr_candidate` KIND: A FORWARD RECORD FOR A MODEL THAT IS NOT SERVED (M2b, 2026-09-16).
 *
 * `data/weekly-artifact.candidate-ecr.json` is the shipped weekly recipe plus two columns --
 * `ecr_wk_rank` / `ecr_wk_sd`, the point-in-time weekly expert consensus (M2a,
 * docs/weekly-ecr-screen-2026-09-16.md). It is a CANDIDATE awaiting owner sign-off and it serves
 * nothing: it is absent from `WEEKLY_SERVE`, from `ARTIFACT_OF`, and from every default.
 *
 * WHY IT IS FROZEN ANYWAY, AND WHY THAT IS THE POINT. The admission evidence so far is a backtest --
 * exactly the arrangement the header of this file says keeps producing numbers that do not survive a
 * new season. The only measurement that cannot be gamed is a prediction written before kickoff, and
 * a prediction can only be written before a kickoff that has not happened. Waiting for the sign-off
 * to start the record would mean the record starts weeks late, and the weeks it missed can never be
 * recovered -- so the candidate's week is frozen NOW, on the same players, in the same week, with
 * the same `as_of` as the shipped and challenger rows, under its own kind so it can never be
 * mistaken for a lineup somebody could have set.
 *
 * IF THE SIGN-OFF SAYS NO, the series is a record of a model that was rejected, which is worth
 * keeping and costs nothing. If it says YES, the promoted model arrives with out-of-sample evidence
 * that predates its own promotion. Both readings need the rows to exist before the decision.
 *
 * SAME REFUSALS AS EVERY OTHER KIND: `INSERT OR IGNORE` (re-freezing writes nothing), and it sits
 * inside the same late-snapshot guard, so a week whose first kickoff has passed is not written.
 * The artifact is OPTIONAL on disk: absent, the kind is skipped and says so -- it must never fall
 * back to the shipped artifact, which would record the incumbent's numbers under the candidate's
 * name and make the two look identical forever.
 *
 * 2026-09-17 -- THE SIGN-OFF SAID YES (D27 APPLIED, WP16b). From the promotion week on, the SERVED
 * `weekly` kind IS the consensus model: `CHALLENGER_WEEKLY_ARTIFACT` now carries the 27-feature
 * design, and `WEEKLY_SERVE` already named that file at QB/RB/WR/TE, so nothing in the table moved.
 * Two consequences a later reader must not have to reconstruct:
 *
 *   - The `weekly_ecr_candidate` rows for the weeks BEFORE the promotion (2026 week 2 is the only
 *     one) are the PRE-PROMOTION RECORD -- a genuine out-of-sample prediction of this model made
 *     while a DIFFERENT model was being served. They are frozen and are not rewritten.
 *   - From the promotion week on the two series are the SAME MODEL and will converge to within the
 *     row set each kind selects. That is expected, not a bug, and the kind is deliberately LEFT
 *     RUNNING: a broken series cannot be compared with itself across the change, which is the same
 *     rule the challenger kind states about its own whole-field record.
 *
 * `runScorecard` says so in a NOTE at snapshot time rather than leaving it to this comment, and the
 * note is derived from the served artifact's own feature list, so it cannot outlive the fact.
 */
export const ECR_CANDIDATE_WEEKLY_ARTIFACT = "weekly-artifact.candidate-ecr.json";

/** The two columns whose presence in a fitted artifact means it is the D27 consensus model. Named
 *  once, read from the artifact's own feature list -- never a version number somebody must remember
 *  to bump. */
export const ECR_WEEKLY_FEATURES = ["ecr_wk_rank", "ecr_wk_sd"] as const;

/**
 * THE `stream` KIND: ONE PICK PER POSITION PER WEEK, frozen before kickoff.
 *
 * The other two kinds freeze a projection for every player. This one freezes a DECISION -- "of the
 * men nobody rosters, this is who I would start at kicker this week" -- because that is what the
 * streaming model is for, and a record of its projections would not be a record of its picks. A
 * model can be better calibrated across five hundred players and pick the wrong defence every week.
 *
 * TWO ROWS PER POSITION, and the second is what makes the first mean anything: `<pos>` is the
 * serving model's pick and `<pos>_line` is the pick a manager makes by reading the preseason board.
 * Freezing only ours would leave a number with no referent, and adding the comparison in January
 * would be adding it after the games.
 *
 * IT OBEYS THE SAME REFUSAL AS EVERYTHING ELSE HERE. It is written inside the same guarded block, so
 * a week whose first kickoff has passed is not snapshotted at all -- there is no backfill path, by
 * construction rather than by discipline.
 */
export const STREAM_SCORECARD_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * THE FIRST WEEK THE CHALLENGER MAY BE SNAPSHOTTED FOR, and it is 2 for a concrete reason.
 *
 * 2026 week 1 was snapshotted on 2026-09-08, before the split existed, when `ff scorecard` loaded
 * the two-part artifact for the model it called `weekly`. Predictions are written once and never
 * updated, so that row stands and cannot be corrected -- writing a week-1 challenger row now, after
 * Thursday's kickoff, would be exactly the after-the-fact prediction this file exists to refuse, and
 * back-filling a floor row for week 1 would be worse still.
 *
 * So the clean dual series starts at week 2, and `formatScorecard` says so rather than leaving a
 * reader to infer from a gap that week 1 is missing by accident. The general late-snapshot refusal
 * would already stop a week-1 write today; this is the narrower statement that stays true tomorrow.
 */
export const CHALLENGER_FIRST_WEEK = 2;

/**
 * THE SNAPSHOT ROW'S METADATA COLUMN, added by ALTER for the same reason every other late column is:
 * schema.sql is CREATE TABLE IF NOT EXISTS throughout and only ever reaches a fresh store.
 *
 * It carries, on each `weekly`/`weekly` row, the artifact that produced THAT row and the date the
 * serve table last changed. Without it a series that switches model mid-season shows a step change
 * in its numbers with nothing in the record saying why, and the explanation would have to be
 * reconstructed from git history against a table whose whole point is that it cannot be edited.
 */
export const SCORECARD_META_COLUMN = "meta";

/**
 * WHOSE ACCURACY IS THIS (I-5). A scorecard row belongs to a FORMAT (the scoring rules that produced
 * the prediction) and, for the `odds` kind, to a LEAGUE (the team ids are that league's). Both are
 * resolved here, once, so no reader has to guess and no writer can stamp a row with neither.
 *
 * Omitted = the active league and its scoring key, which is what every existing caller means.
 */
export function scorecardScope(
  db: DB, scope?: { formatKey?: string; leagueId?: string | null },
): { formatKey: string; leagueId: string | null } {
  const leagueId = scope?.leagueId ?? activeLeagueId(db);
  // `scoringKeyFor`, not `scoringKey(rules)`: the same function the resolver keys directories by, so a
  // league that overrides its kicker or defense table cannot be stamped with the default format's key.
  const cfg = getConfig(db, leagueId);
  const formatKey = scope?.formatKey ?? scoringKeyFor({ rules: cfg.scoring_rules, kicker: cfg.kicker, defense: cfg.defense });
  return { formatKey, leagueId };
}

export function ensureScorecardMetaColumn(db: DB): void {
  const have = new Set((db.prepare("PRAGMA table_info(scorecard_prediction)").all() as { name: string }[])
    .map((c) => c.name));
  if (!have.size) return;                             // table not created yet; schema.sql owns that
  if (!have.has(SCORECARD_META_COLUMN)) {
    db.exec(`ALTER TABLE scorecard_prediction ADD COLUMN ${SCORECARD_META_COLUMN} TEXT`);
  }
}

export interface ScorecardOpts {
  dbPath?: string;
  season: number;
  /** Take the snapshot for the imminent week. */
  snapshot?: boolean;
  /** Score every week whose games are all settled. */
  score?: boolean;
  /** Also read ESPN's own weekly projection through the app bridge. */
  espn?: boolean;
  /** WHICH LEAGUE the optional ESPN baseline pull is for. Omitted = the ACTIVE league. */
  leagueId?: string | null;
  /** Snapshot a specific week rather than the imminent one. */
  week?: number;
  /** The date the run is anchored to. Injectable so a test can drive the refusal path. */
  today?: string;
  /** The SHIPPED weekly artifact, the one `lineupRecommend` serves from. Defaults to
   *  `SHIPPED_WEEKLY_ARTIFACT`; overridable only so a test can drive a fixture. */
  artifactPath?: string;
  /** The challenger, snapshotted under its own kind. Defaults to `CHALLENGER_WEEKLY_ARTIFACT`. */
  challengerArtifactPath?: string;
  /** The ECR candidate (M2b), snapshotted under `weekly_ecr_candidate`. Defaults to the FORMAT's
   *  `ECR_CANDIDATE_WEEKLY_ARTIFACT`; absent on disk, the kind is skipped and says so. */
  ecrCandidateArtifactPath?: string;
  /**
   * WHICH FREEZE OF THE ODDS THIS IS. 0 (the default) is the preseason snapshot. A later number
   * writes a SECOND series rather than touching the first, which is the only honest way to record
   * that the league changed its own format after the preseason rows were frozen.
   */
  oddsVintage?: number;
  rosters?: number;
  /** The rank past which a man counts as available, per position, for the `stream` kind. Defaults to
   *  streamingEvaluate's POOL_DEPTH; overridable only so a test can drive a small fixture. */
  poolDepth?: Record<string, number>;
  /** A pre-loaded schedule, so a test can drive the late-snapshot refusal without a network read. */
  sched?: ScheduleInfo;
  /**
   * THE PRE-SEASON ODDS, supplied by the caller rather than computed here.
   *
   * The `odds` kind is one playoff and one title probability per team, frozen once before kickoff
   * and scored by Brier at season end. Producing it means running the season simulation against the
   * league's REAL schedule, which needs the app bridge -- exactly the kind of live, authenticated
   * read this file has no business doing, and exactly the kind of thing a test must be able to
   * replace with a fixture. So the scorecard takes a provider and writes what it returns.
   *
   * Omitted, the kind is skipped and says so. Returning an empty array is also honest and is
   * recorded as a skip, never as a snapshot of nothing.
   */
  oddsProvider?: () => Promise<OddsSnapshotRow[]> | OddsSnapshotRow[];
}

/** One team's pre-season odds. Probabilities are in PERCENT, matching `seasonOdds`; the Brier
 *  scorer divides by 100 at scoring time, where the actual is 0 or 1. */
export interface OddsSnapshotRow {
  /** Stable per-team id -- the league's team id, not a display name, which owners change. */
  subject: string;
  name: string;
  playoffPct: number;
  titlePct: number;
}

export interface ScorecardResult {
  season: number;
  today: string;
  imminentWeek: number | null;
  snapshot: { week: number | null; taken: number; skipped: string | null; byModel: Record<string, number> };
  /**
   * pos -> artifact file the `weekly` kind's `weekly` model was served from, for THIS run. It is on
   * the result and on every snapshotted row's metadata because a per-position ship decision makes
   * "which model said this" impossible to infer from the number, and a series whose model changes
   * mid-season has to say WHEN and to WHAT rather than leaving a step change to be explained later.
   */
  servedBy?: Record<string, string>;
  /** The `weekly_challenger` kind: the two-part model, same players, same frozen as-of. */
  challenger: { week: number | null; taken: number; skipped: string | null };
  /** The `weekly_ecr_candidate` kind (M2b): the unserved ECR candidate, same players, same as_of. */
  ecrCandidate: { week: number | null; taken: number; skipped: string | null; artifact: string | null };
  /** The `stream` kind: one pick per position out of the pool, plus the board's pick beside it. */
  stream: { week: number | null; taken: number; skipped: string | null; artifactByPos: Record<string, string> };
  espn: { attempted: boolean; ok: boolean; reason: string; stored: number };
  seasonKind: { taken: number; skipped: string | null };
  oddsKind: { taken: number; skipped: string | null; vintage?: number };
  scored: {
    week: number; kind: ScorecardKind; model: string; n: number; rmse: number; crps: number; coverage: number;
    lineupPts: number; lineupWinShare: number;
  }[];
  seasonScored: { n: number; rmse: number; note: string } | null;
  /** The `odds` accrual. Null until the season resolves; `skipped` says why when it is. */
  oddsScored: OddsScored | null;
  notes: string[];
}

/** One model's score against the outcome it settles on, beside the floor it must beat. */
export interface OddsModelScore {
  model: "playoff" | "title";
  /**
   * WHICH SNAPSHOT THIS IS. The odds are frozen more than once in a season: preseason (`week` 0),
   * and again after the format changed under us in September 2026 (`week` 1). Both are scored, and
   * they are scored SEPARATELY -- pooling a preseason forecast with a post-week-1 one produces a
   * Brier that belongs to neither, and the whole point of a second vintage is to see whether the
   * later one is better.
   */
  vintageWeek: number;
  asOf: string | null;
  n: number;
  brier: number;
  logLoss: number;
  uniformBrier: number;
  uniformLogLoss: number;
  /** 1 - brier/uniformBrier. POSITIVE means the frozen odds beat a flat prior; negative means they
   *  were worse than knowing nothing, which is a real and reportable outcome. */
  skill: number;
  reliability: { lo: number; hi: number; n: number; predicted: number; observed: number }[];
}
export interface OddsScored {
  season: number;
  teams: number;
  models: OddsModelScore[];
  skipped: string | null;
}

/**
 * TODAY, IN THE LOCAL CALENDAR. Not `toISOString().slice(0, 10)`, which is UTC.
 *
 * This is not pedantry, it cost the first live run. At 22:50 on 2026-09-08 in this timezone the UTC
 * date is already 2026-09-09, so the harness read week 1 -- whose as-of is 2026-09-08, the day before
 * its Thursday kickoff -- as ALREADY PLAYED, refused to snapshot it, and silently snapshotted week 2
 * instead. Nothing errored. The scorecard would have opened the season having frozen a week-2
 * prediction made before week 1 and no prediction at all for week 1, which is the worst of both:
 * a missing record and a needlessly bad one. The comparison is against a football gameday, and a
 * football gameday is a local-calendar date.
 */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The imminent week: the earliest REG week of the season whose first kickoff is still ahead. */
export function imminentWeek(sched: ScheduleInfo, season: number, today: string): number | null {
  const weeks = [...sched.weekAsOf.keys()].filter((k) => k.startsWith(`${season}|`))
    .map((k) => ({ week: Number(k.split("|")[1]), asOf: sched.weekAsOf.get(k)! }))
    .sort((a, b) => a.week - b.week);
  for (const w of weeks) if (w.asOf >= today) return w.week;
  return null;
}

/** Weeks all of whose games have a settled result in the feature table. */
function settledWeeks(db: DB, season: number, sched: ScheduleInfo, today: string): number[] {
  const rows = db.prepare(
    "SELECT week, COUNT(*) n, SUM(pts IS NOT NULL) scored FROM feat_player_week_model WHERE season = ? GROUP BY week",
  ).all(season) as { week: number; n: number; scored: number }[];
  const out: number[] = [];
  for (const r of rows) {
    const asOf = sched.weekAsOf.get(`${season}|${r.week}`);
    // "Settled" means the week's games are behind us AND someone scored in it. Either alone is not
    // enough: a week can be in the past with an unbuilt history file, which is missing data rather
    // than a week of zeros, and scoring it would record every model as catastrophically wrong.
    if (asOf && asOf < today && r.scored > 0) out.push(r.week);
  }
  return out.sort((a, b) => a - b);
}

/** Every model's prediction for one (season, week), from the feature table. */
function weeklyPredictions(
  db: DB, season: number, week: number, served: Map<string, WeeklyArtifact>,
  servedBy: Record<string, string>, lineOnly: WeeklyArtifact,
) {
  const rows = loadWeeklyRows(db, season, week).filter((r) => r.season_line_pg != null);
  const out = new Map<string, { name: string; pos: string; by: Partial<Record<ScorecardModel, Pred>> }>();
  const put = (k: string, name: string, pos: string, m: ScorecardModel, p: Pred) => {
    const cur = out.get(k) ?? out.set(k, { name, pos, by: {} }).get(k)!;
    cur.by[m] = p;
  };
  // THE `weekly` MODEL IS SERVED PER POSITION, through `WEEKLY_SERVE`. It used to be one artifact
  // for all six, which was correct while one artifact served all six and becomes a silent lie the
  // moment the gate is applied per position: the scorecard would freeze the floor's number for a
  // position `lineupRecommend` serves from the streaming model, and the forward record would accrue
  // for a model nobody was served from -- the one failure a scorecard cannot survive.
  // THE MAPPING IS PASSED IN, not recomputed from `artifactForPos`. A caller overriding the whole
  // table with one fixture file (a test) produces a mapping no serve-table lookup can reproduce, and
  // recomputing it here silently matched NOTHING and stored an empty snapshot -- which three tests
  // caught only because they assert a non-empty result rather than a successful run.
  for (const [file, art] of served) {
    const serves = new Set(Object.entries(servedBy).filter(([, f]) => f === file).map(([p]) => p));
    const subset = rows.filter((r) => serves.has(r.pos));
    if (!subset.length) continue;
    for (const r of projectWeekly({ artifact: art, rows: subset })) {
      put(r.feat_key, r.name, r.pos, "weekly", { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
    }
  }
  for (const r of projectWeekly({ artifact: lineOnly, rows })) {
    put(r.feat_key, r.name, r.pos, "season_line", { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  // The SHIPPED path, called as the app calls it. gamesPerSeason 1 because season_line_pg is already
  // per game -- handing it 17 would divide the line a second time.
  const defRatings = new Map<string, number>();
  for (const r of rows) {
    const d = r.dvp_mult;
    if (r.opponent && d != null && Number.isFinite(d)) defRatings.set(`${r.opponent}|${r.pos}`, d);
  }
  const shipped = makeProjections({
    seasonPoints: rows.map((r) => ({ name: r.feat_key, pos: r.pos, season: r.season_line_pg! })),
    defRatings, gamesPerSeason: 1,
  });
  for (const r of rows) {
    const v = shipped.week(r.feat_key, r.pos, r.opponent ?? undefined);
    put(r.feat_key, r.name, r.pos, "shipped_week", { mean: v, p10: NaN, p50: NaN, p90: NaN });
    const t4 = r.f.t4_mean ?? r.f.td_ppg ?? r.season_line_pg!;
    put(r.feat_key, r.name, r.pos, "trailing4", { mean: t4, p10: NaN, p50: NaN, p90: NaN });
  }
  // ESPN. TWO THINGS TO KNOW BEFORE READING ITS SCORE.
  //
  // (1) POPULATION. Our weekly model is fitted on `rostered` weeks, so it prices in the chance the
  // man does not play; ESPN's published number reads like a projection conditioned on playing. On
  // 2026 week 1, over the 430 players both cover, our mean is 5.22 and ESPN's 5.95. When the week is
  // scored, ESPN will look biased high against rostered actuals, and that is a difference in the
  // question being answered, not a defect. Read CRPS and lineup regret, not the bias column.
  //
  // (2) THE JOIN is by name+position, not by surrogate key: raw_espn_projection carries ESPN's own
  // id, which nothing in the identity registry maps yet, and inventing a mapping here would silently
  // attach one man's projection to another. A name+pos join misses the collisions Phase 1 fixed on
  // the board and that is stated rather than hidden -- the row count is reported (430 of 523).
  const espn = db.prepare(
    "SELECT name, pos, proj_pts FROM raw_espn_projection WHERE season = ? AND week = ?",
  ).all(season, week) as { name: string; pos: string; proj_pts: number }[];
  if (espn.length) {
    const byName = new Map(espn.map((e) => [`${e.name.toLowerCase()}|${e.pos}`, e.proj_pts]));
    for (const r of rows) {
      const v = byName.get(`${r.name.toLowerCase()}|${r.pos}`);
      if (v != null) put(r.feat_key, r.name, r.pos, "espn", { mean: v, p10: NaN, p50: NaN, p90: NaN });
    }
  }
  return out;
}

function lineOnlyArtifactFor(db: DB, season: number): WeeklyArtifact {
  // Quantiles measured on seasons STRICTLY BEFORE the one being scored. Measuring them on the live
  // season would put its own results into its own baseline.
  const rows = db.prepare(
    `SELECT pos, COALESCE(pts, 0.0) / season_line_pg AS r FROM feat_player_week_model
      WHERE COALESCE(is_bye, 0) = 0 AND season_line_pg > 0 AND season < ?`,
  ).all(season) as { pos: string; r: number }[];
  const byPos: Record<string, number[]> = {};
  for (const r of rows) (byPos[r.pos] ??= []).push(r.r);
  const q: Record<string, { p10: number; p50: number; p90: number }> = {};
  const quant = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : 1;
  };
  for (const [pos, v] of Object.entries(byPos)) q[pos] = { p10: quant(v, 0.10), p50: quant(v, 0.50), p90: quant(v, 0.90) };
  // No prior season in this store at all -- a fresh install, or a fixture. The positions then come
  // from the live season and the quantiles collapse onto 1.0, which is seasonLineOnlyArtifact's
  // stated "we have no spread" rather than an invented one. Building an artifact with no positions
  // instead would be refused by the loader and take the whole scorecard down over a missing baseline.
  if (!Object.keys(q).length) {
    const live = db.prepare(
      "SELECT DISTINCT pos FROM feat_player_week_model WHERE season = ? AND pos IS NOT NULL",
    ).all(season) as { pos: string }[];
    const positions = live.map((r) => r.pos);
    if (!positions.length) {
      throw new Error(`scorecard: no feature rows for ${season} -- build the weekly features first`);
    }
    return loadWeeklyArtifact(seasonLineOnlyArtifact({ positions, seasons: [season - 1] }));
  }
  return loadWeeklyArtifact(seasonLineOnlyArtifact({ positions: Object.keys(q), seasons: [season - 1], quantiles: q }));
}

const BRIER_BINS = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 1.0001];

/**
 * SCORE THE FROZEN PRESEASON ODDS, once the season has actually resolved.
 *
 * WHAT THIS CLOSES. The snapshot path for the `odds` kind shipped in Phase 2c and the SCORING path
 * did not, so thirty-two write-once rows sat in the store that nothing could ever turn into a
 * number. A prediction nobody can score is a record, not a prediction, and the difference is
 * invisible until the season ends -- which is exactly when it is too late to notice.
 *
 * TWO MODELS, NEVER MIXED. `playoff` and `title` settle on different facts (a seed, a championship)
 * and a Brier score over a mixture of the two would be a number with no interpretation. They are
 * scored separately, each against its own uniform floor: `field/teams` for the berth and `1/teams`
 * for the title. That floor is not decoration -- Phase 2c measured this simulator BEATING it on the
 * playoff berth and LOSING to it on the champion over 114 team-seasons, and the accrual exists to
 * find out whether that holds on a season nobody had seen when the numbers were frozen.
 *
 * IT REFUSES ON AN UNSETTLED SEASON. An in-progress season's placeholder `final_rank` looks exactly
 * like a result, so the gate is the data's own `settled` flag plus the two facts a finished season
 * must show: every team has a final rank, and exactly one of them won. Scoring early would record a
 * verdict on a season that has not happened.
 */
export function scoreOdds(db: DB, season: number, scope?: { formatKey?: string; leagueId?: string | null }): OddsScored {
  // ONE FORMAT, ONE LEAGUE (I-5/S-9). An `odds` subject is a TEAM ID, which is unique inside one
  // league and nowhere else -- ESPN 1-18 and Yahoo 1-12 overlap outright -- so both halves of this
  // join have to name whose season they are scoring.
  const { formatKey, leagueId } = scorecardScope(db, scope);
  const rows = db.prepare(
    "SELECT model, subject, value, week, as_of FROM scorecard_prediction WHERE format_key = ? AND season = ? AND kind = 'odds'",
  ).all(formatKey, season) as { model: string; subject: string; value: number; week: number; as_of: string | null }[];
  const teamsRows = db.prepare(
    "SELECT team_id, made_playoffs, champion, playoff_seed, final_rank, settled FROM fact_team_season WHERE league_id = ? AND season = ?",
  ).all(leagueId, season) as { team_id: string; made_playoffs: number | null; champion: number | null; playoff_seed: number | null; final_rank: number | null; settled: number | null }[];

  const empty = (skipped: string): OddsScored => ({ season, teams: teamsRows.length, models: [], skipped });
  if (!rows.length) return empty(`no frozen 'odds' rows for ${season} -- nothing was ever snapshotted, so there is nothing to score`);
  if (!teamsRows.length) return empty(`fact_team_season has no rows for ${season} -- run \`ff build-picks\` to derive the league's own outcomes`);
  const champions = teamsRows.filter((t) => t.champion).length;
  const ranked = teamsRows.filter((t) => t.final_rank != null).length;
  const seeded = teamsRows.filter((t) => t.playoff_seed != null).length;
  if (!teamsRows.every((t) => t.settled) || ranked !== teamsRows.length || champions !== 1 || seeded === 0) {
    return empty(
      `${season} has not resolved: ${teamsRows.filter((t) => t.settled).length}/${teamsRows.length} teams settled, ` +
      `${ranked} with a final rank, ${seeded} with a playoff seed, ${champions} champion(s). ` +
      "An in-progress season's placeholder rank looks exactly like a result, so the frozen odds are left unscored.",
    );
  }

  const field = teamsRows.filter((t) => t.made_playoffs).length || teamsRows.filter((t) => t.playoff_seed != null).length;
  const n = teamsRows.length;
  const outcome = new Map(teamsRows.map((t) => [String(t.team_id), { playoff: t.made_playoffs ? 1 : 0, title: t.champion ? 1 : 0 }]));

  const brier = (a: { p: number; y: number }[]) => a.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / a.length;
  const logLoss = (a: { p: number; y: number }[]) => -a.reduce((s, r) => {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, r.p));
    return s + (r.y ? Math.log(p) : Math.log(1 - p));
  }, 0) / a.length;
  const reliability = (a: { p: number; y: number }[]) => {
    const out: OddsModelScore["reliability"] = [];
    for (let i = 0; i < BRIER_BINS.length - 1; i++) {
      const b = a.filter((r) => r.p >= BRIER_BINS[i] && r.p < BRIER_BINS[i + 1]);
      if (!b.length) continue;
      out.push({
        lo: BRIER_BINS[i], hi: Math.min(1, BRIER_BINS[i + 1]), n: b.length,
        predicted: b.reduce((s, r) => s + r.p, 0) / b.length,
        observed: b.reduce((s, r) => s + r.y, 0) / b.length,
      });
    }
    return out;
  };

  const models: OddsModelScore[] = [];
  // Every VINTAGE of the snapshot, oldest first. `week` is the snapshot's own key, so a season with
  // one preseason freeze behaves exactly as before and a season with two produces two scored series.
  const vintages = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  for (const vw of vintages) {
    for (const [model, uniform] of [["playoff", field / n], ["title", 1 / n]] as ["playoff" | "title", number][]) {
      // Probabilities are stored in PERCENT, matching `seasonOdds`; the actual is 0 or 1. Dividing at
      // scoring time rather than at snapshot time is deliberate -- the stored row stays the number a
      // human recognises.
      const mine = rows.filter((r) => r.model === model && r.week === vw);
      const scored = mine
        .map((r) => ({ p: Math.min(1, Math.max(0, r.value / 100)), y: outcome.get(String(r.subject))?.[model] ?? null }))
        .filter((r): r is { p: number; y: number } => r.y != null);
      if (!scored.length) continue;
      const uni = scored.map((r) => ({ p: uniform, y: r.y }));
      const b = brier(scored), ub = brier(uni);
      models.push({
        model, vintageWeek: vw, asOf: mine[0]?.as_of ?? null, n: scored.length,
        brier: b, logLoss: logLoss(scored),
        uniformBrier: ub, uniformLogLoss: logLoss(uni),
        skill: 1 - b / ub,
        reliability: reliability(scored),
      });
    }
  }
  if (!models.length) {
    return empty(`the frozen rows for ${season} join no team in fact_team_season -- the subject is a team id and nothing matched`);
  }
  return { season, teams: n, models, skipped: null };
}

export async function runScorecard(opts: ScorecardOpts): Promise<ScorecardResult> {
  const db = openDb(opts.dbPath);
  // RESOLVED ONCE, THREADED (I-5). `format_key` stamps every prediction and every scored row with the
  // scoring rules it was produced under; without it a second format's rows were silently dropped by
  // `INSERT OR IGNORE` and every read mixed two models' accuracy under one name.
  const { resolveLeagueContext } = await import("../data/leagueContext.js");
  const lctx = resolveLeagueContext(db, opts.leagueId);
  // AND THE ARTIFACTS THAT PRODUCE THE PREDICTIONS COME FROM THE SAME FORMAT (F-4/WP3). They were
  // read through `dataPath`, so a second format's scorecard would have stamped `format_key` with ITS
  // key while scoring the INCUMBENT's models -- a provenance label on somebody else's numbers, which
  // is worse than no label at all.
  const { resolveFormat } = await import("../data/formatResolve.js");
  const fmt = resolveFormat(db, lctx.leagueId);
  const fmtKey = fmt.scoringKey;
  const today = opts.today ?? iso(new Date());
  const notes: string[] = [];
  const res: ScorecardResult = {
    season: opts.season, today, imminentWeek: null,
    snapshot: { week: null, taken: 0, skipped: null, byModel: {} },
    challenger: { week: null, taken: 0, skipped: null },
    ecrCandidate: { week: null, taken: 0, skipped: null, artifact: null },
    stream: { week: null, taken: 0, skipped: null, artifactByPos: {} },
    espn: { attempted: false, ok: false, reason: "not attempted", stored: 0 },
    seasonKind: { taken: 0, skipped: null },
    oddsKind: { taken: 0, skipped: null },
    scored: [], seasonScored: null, oddsScored: null, notes,
  };
  try {
    const sched = opts.sched ?? await loadSchedule([opts.season]);
    const imm = imminentWeek(sched, opts.season, today);
    res.imminentWeek = imm;
    // WHAT SERVES EACH POSITION, from the one table in streamingServe.ts. `opts.artifactPath`
    // overrides the lot with a single file, which is how a test drives a fixture -- and it is the
    // ONLY way to get a one-artifact snapshot, so a production run cannot accidentally take one.
    const served = new Map<string, WeeklyArtifact>();
    if (opts.artifactPath) {
      served.set(opts.artifactPath, loadWeeklyArtifact(JSON.parse(readFileSync(opts.artifactPath, "utf8"))));
    } else {
      for (const file of new Set(Object.values(serveTable()))) {
        try {
          served.set(file, loadWeeklyArtifact(JSON.parse(readFileSync(weeklyArtifactPath(fmt.model, file), "utf8"))));
        } catch (e) {
          // NAMED, never silently skipped: a position whose artifact will not load must not fall
          // through to another model's numbers under the same `weekly` label.
          notes.push(`could not load ${file}, so the positions it serves are absent from this ` +
            `snapshot rather than served by something else (${(e as Error).message})`);
        }
      }
    }
    res.servedBy = opts.artifactPath
      ? Object.fromEntries(STREAM_SERVE_POS.map((p) => [p, opts.artifactPath!]))
      : serveTable();
    const lineOnly = lineOnlyArtifactFor(db, opts.season);
    // The challenger is OPTIONAL on disk. Absent, the kind is skipped and says so -- it must never
    // fall back to the shipped artifact, which would silently record the floor's own numbers as the
    // challenger's and make the two look identical for the rest of the season.
    let challenger: WeeklyArtifact | null = null;
    let challengerWhy: string | null = null;
    try {
      challenger = loadWeeklyArtifact(JSON.parse(readFileSync(opts.challengerArtifactPath ?? fmt.model.path("weekly"), "utf8")));
    } catch (e) {
      challengerWhy = `no challenger artifact to snapshot (${(e as Error).message})`;
    }

    // THE ECR CANDIDATE (M2b). Resolved beside the FORMAT's own weekly artifact -- not through
    // `dataPath` -- for the F-4/WP3 reason every other artifact here is: a Yahoo scorecard must not
    // freeze rows produced by the incumbent's half-PPR model under the Yahoo format key. It is NOT
    // in `ARTIFACT_OF`/`WEEKLY_SERVE` and must not be: it serves nothing.
    const ecrCandPath = opts.ecrCandidateArtifactPath
      ?? join(dirname(fmt.model.path("weekly")), ECR_CANDIDATE_WEEKLY_ARTIFACT);
    let ecrCandidate: WeeklyArtifact | null = null;
    let ecrCandidateWhy: string | null = null;
    try {
      ecrCandidate = loadWeeklyArtifact(JSON.parse(readFileSync(ecrCandPath, "utf8")));
      res.ecrCandidate.artifact = ecrCandPath;
    } catch (e) {
      ecrCandidateWhy = `no ECR candidate artifact at ${ecrCandPath} -- the kind is skipped rather than served by something else (${(e as Error).message})`;
    }

    // ---------------- SNAPSHOT ----------------
    if (opts.snapshot !== false) {
      const week = opts.week ?? imm;
      res.snapshot.week = week;
      const asOf = week != null ? sched.weekAsOf.get(`${opts.season}|${week}`) : undefined;
      if (week == null) {
        res.snapshot.skipped = `no week of ${opts.season} still has its first kickoff ahead of ${today}`;
      } else if (!asOf) {
        res.snapshot.skipped = `the schedule feed has no gameday for ${opts.season} week ${week}`;
      } else if (asOf < today) {
        // THE REFUSAL. A prediction written after kickoff is indistinguishable from an honest one in
        // the table, so it is refused here rather than flagged later.
        res.snapshot.skipped = `week ${week} kicked off on ${asOf} (as-of), which is before ${today} -- ` +
          "refusing to write a 'prediction' after the games. A prediction snapshotted late leaves no " +
          "trace in the row and would silently flatter every model in it.";
      } else {
        if (opts.espn) {
          res.espn.attempted = true;
          // ONE RESOLVER -- the ESPN baseline pull must be for the league this scorecard is about,
          // not for whichever row synced most recently.
          const f = await fetchEspnWeekly({ season: opts.season, week, leagueId: lctx.leagueId ?? undefined });
          res.espn.ok = f.ok; res.espn.reason = f.reason;
          if (f.ok) {
            res.espn.stored = storeEspnWeekly(db, f.rows, asOf);
            // Record the write, and flag a COLLAPSE against a prior good pull. Not fatal: the ESPN
            // baseline is optional (the bridge is often down), so a skip is a recorded skip, not a
            // failed scorecard -- but a pull that silently drops from 500 rows to 5 is worth a mark.
            const { auditIngest } = await import("../data/validatedIngest.js");
            auditIngest(db, {
              source: "espn-weekly-projection", season: opts.season, rowsWritten: res.espn.stored,
              readback: () => (db.prepare("SELECT count(*) AS c FROM raw_espn_projection WHERE season=? AND week=?").get(opts.season, week) as { c: number }).c,
              policy: { minFractionOfPrev: 0.5 },
            });
          }
        }
        const preds = weeklyPredictions(db, opts.season, week, served, res.servedBy ?? serveTable(), lineOnly);
        ensureScorecardMetaColumn(db);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO scorecard_prediction
             (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at, ${SCORECARD_META_COLUMN})
           VALUES (@fk,@season,@week,'weekly',@model,@subject,@name,@pos,@value,@p10,@p90,@asOf,@now,@meta)`,
        );
        const now = nowIso();
        // WHICH ARTIFACT PRODUCED THIS ROW, plus the date the mapping last changed. Only on the
        // `weekly` model: the other four are baselines with no artifact behind them, and writing a
        // serve-table name beside a baseline would claim a provenance it does not have.
        //
        // THE FILENAME IS NOT AN IDENTITY, AND WP16b IS THE PROOF. D27 promoted a different model
        // into the SAME file (`CHALLENGER_WEEKLY_ARTIFACT`, 25 features -> 27 with the consensus),
        // so a stamp of the name alone reads identically across a change of model and leaves a step
        // change in a write-once series unexplainable. The artifact's own `fittedAt` and feature
        // count are read OFF THE FILE THAT PRODUCED THIS ROW, so a promotion cannot leave them
        // stale the way a hand-bumped date can.
        const metaFor = (model: string, pos: string): string | null => {
          if (model !== "weekly") return null;
          const file = res.servedBy?.[pos] ?? null;
          const art = file ? served.get(file) : null;
          return JSON.stringify({
            artifact: file, switchedOn: WEEKLY_SERVE_SWITCHED_ON,
            fittedAt: (art as { fittedAt?: string } | null)?.fittedAt ?? null,
            features: art?.features.length ?? null,
            // WHETHER THE BAND THIS ROW'S p10/p90 CAME FROM WAS CALIBRATED (D32). Without it a
            // calibrated and an uncalibrated artifact of the same design and the same `fittedAt` are
            // INDISTINGUISHABLE in the series -- and D32 promoted on the same day as D30, so that is
            // not a hypothetical. `null` for an artifact that carries none, which is what every row
            // before this said by omission.
            bandCal: art?.bandCalibration
              ? { method: art.bandCalibration.method, k: art.bandCalibration.k, pos: Object.keys(art.bandCalibration.perPos).sort().join("/") }
              : null,
          });
        };
        db.transaction(() => {
          for (const [key, v] of preds) {
            for (const m of SCORECARD_MODELS) {
              const p = v.by[m];
              if (!p || !Number.isFinite(p.mean)) continue;
              const info = ins.run({
                fk: fmtKey, season: opts.season, week, model: m, subject: key, name: v.name, pos: v.pos,
                value: p.mean, p10: Number.isFinite(p.p10) ? p.p10 : null,
                p90: Number.isFinite(p.p90) ? p.p90 : null, asOf, now, meta: metaFor(m, v.pos),
              });
              if (info.changes) { res.snapshot.taken++; res.snapshot.byModel[m] = (res.snapshot.byModel[m] ?? 0) + 1; }
            }
          }
        })();
        if (!res.snapshot.taken) {
          notes.push(`week ${week} was already snapshotted -- predictions are written once and never ` +
            "updated, so a re-run is a no-op rather than a rewrite.");
        }

        // ---- weekly_challenger: the two-part model, same players, same as_of, its own kind. ----
        res.challenger.week = week;
        if (!challenger) {
          res.challenger.skipped = challengerWhy;
        } else if (week < CHALLENGER_FIRST_WEEK) {
          res.challenger.skipped =
            `the challenger series starts at week ${CHALLENGER_FIRST_WEEK}. Week ${week} of ${opts.season} ` +
            "was snapshotted before the shipped/challenger split existed, when this command loaded the " +
            "two-part artifact for the model it called `weekly`; that row is frozen and writing a " +
            "challenger row for the same week now would be a prediction made after kickoff.";
        } else {
          const insC = db.prepare(
            `INSERT OR IGNORE INTO scorecard_prediction
               (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
             VALUES (@fk,@season,@week,'weekly_challenger','two_part',@subject,@name,@pos,@value,@p10,@p90,@asOf,@now)`,
          );
          const nowC = nowIso();
          const rowsC = loadWeeklyRows(db, opts.season, week).filter((r) => r.season_line_pg != null);
          db.transaction(() => {
            for (const p of projectWeekly({ artifact: challenger!, rows: rowsC })) {
              if (!Number.isFinite(p.mean)) continue;
              const info = insC.run({
                fk: fmtKey, season: opts.season, week, subject: p.feat_key, name: p.name, pos: p.pos,
                value: p.mean, p10: Number.isFinite(p.p10) ? p.p10 : null,
                p90: Number.isFinite(p.p90) ? p.p90 : null, asOf, now: nowC,
              });
              if (info.changes) res.challenger.taken++;
            }
          })();
          if (!res.challenger.taken) {
            notes.push(`week ${week}'s challenger snapshot was already taken -- written once, like every other prediction here.`);
          }
        }

        // ---- weekly_ecr_candidate: the UNSERVED ECR candidate, same players, same as_of. ----
        // Same shape as the challenger block above, deliberately: same row set (`loadWeeklyRows`
        // filtered to a season line, which is the trainer's own row filter), same frozen `as_of`,
        // same INSERT OR IGNORE. The ONE difference is that this model is not served anywhere, which
        // is exactly why the record has to start before the decision rather than after it.
        res.ecrCandidate.week = week;
        if (!ecrCandidate) {
          res.ecrCandidate.skipped = ecrCandidateWhy;
        } else {
          const insE = db.prepare(
            `INSERT OR IGNORE INTO scorecard_prediction
               (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at, ${SCORECARD_META_COLUMN})
             VALUES (@fk,@season,@week,'weekly_ecr_candidate','ecr_candidate',@subject,@name,@pos,@value,@p10,@p90,@asOf,@now,@meta)`,
          );
          const nowE = nowIso();
          // The artifact's own stamp travels with every row. A candidate that is retrained during
          // the season would otherwise leave a series whose step change has no explanation in a
          // table that cannot be edited -- the same reason the `weekly` rows carry `servedBy`.
          const metaE = JSON.stringify({
            artifact: ECR_CANDIDATE_WEEKLY_ARTIFACT, path: ecrCandPath,
            fittedAt: (ecrCandidate as { fittedAt?: string }).fittedAt ?? null,
            features: ecrCandidate.features.length, served: false,
          });
          const rowsE = loadWeeklyRows(db, opts.season, week).filter((r) => r.season_line_pg != null);
          db.transaction(() => {
            for (const p of projectWeekly({ artifact: ecrCandidate!, rows: rowsE })) {
              if (!Number.isFinite(p.mean)) continue;
              const info = insE.run({
                fk: fmtKey, season: opts.season, week, subject: p.feat_key, name: p.name, pos: p.pos,
                value: p.mean, p10: Number.isFinite(p.p10) ? p.p10 : null,
                p90: Number.isFinite(p.p90) ? p.p90 : null, asOf, now: nowE, meta: metaE,
              });
              if (info.changes) res.ecrCandidate.taken++;
            }
          })();
          if (!res.ecrCandidate.taken) {
            notes.push(`week ${week}'s ECR-candidate snapshot was already taken -- written once, like every other prediction here.`);
          }
          // IS THE CANDIDATE NOW THE SERVED MODEL? Read from the SERVED artifacts' own feature
          // lists, not from a date or a version anybody has to remember to bump. After D27 the two
          // series are the same model and a later reader comparing them must know that.
          const consensusServes = [...served.values()]
            .some((a) => {
              const names = new Set<string>(a.features.map((s) => s.name));
              return ECR_WEEKLY_FEATURES.every((f) => names.has(f));
            });
          if (consensusServes) {
            notes.push(`from week ${week} the served \`weekly\` kind IS the consensus model (D27, ` +
              `promoted ${WEEKLY_SERVE_SWITCHED_ON}): the artifact serving it carries ` +
              `${ECR_WEEKLY_FEATURES.join("/")}. The \`weekly_ecr_candidate\` rows for earlier weeks are the ` +
              "PRE-PROMOTION record of this same model and are not rewritten; from here the two series " +
              "converge, which is expected, and the kind is left running so the record is unbroken.");
          }
        }

        // ---- the `stream` kind: one pick per position, out of the approximate free-agent pool. ----
        res.stream.week = week;
        const proj = projectStreamingWith(db, opts.season, week, fmt.model);
        if (!proj) {
          res.stream.skipped = `no weekly feature rows for ${opts.season} week ${week} -- nothing to pick from`;
        } else {
          res.stream.artifactByPos = proj.artifactByPos;
          const picks = topStreamPick(proj.rows, opts.poolDepth ?? POOL_DEPTH);
          const insP = db.prepare(
            `INSERT OR IGNORE INTO scorecard_prediction
               (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
             VALUES (@fk,@season,@week,'stream',@model,@subject,@name,@pos,@value,@p10,@p90,@asOf,@now)`,
          );
          const nowP = nowIso();
          db.transaction(() => {
            for (const pos of STREAM_SCORECARD_POS) {
              const p = picks[pos];
              if (!p) continue;
              for (const [model, r, v] of [
                [pos, p.model, p.model?.mean],
                [`${pos}_line`, p.line, p.line?.mean],
              ] as [string, typeof p.model, number | undefined][]) {
                if (!r || v == null || !Number.isFinite(v)) continue;
                const info = insP.run({
                  // `fk` is not optional: the statement above binds @fk, and WP2 made format_key
                  // part of the PK. This call site was the one of six the migration missed, so the
                  // whole scorecard routine threw `Missing named parameter "fk"` -- invisibly, every
                  // 15 minutes, from the in-app scheduler (WP14, test/scorecard-stream-fk.test.ts).
                  fk: fmtKey,
                  season: opts.season, week, model, subject: r.feat_key, name: r.name, pos: r.pos,
                  value: v, p10: Number.isFinite(r.p10) ? r.p10 : null,
                  p90: Number.isFinite(r.p90) ? r.p90 : null, asOf, now: nowP,
                });
                if (info.changes) res.stream.taken++;
              }
            }
          })();
          if (!res.stream.taken) {
            notes.push(`week ${week}'s streaming picks were already frozen -- written once, like every other prediction here.`);
          }
        }
      }

      // ---- season kind: the preseason season projection, one row per player. ----
      const seasonRows = db.prepare(
        `SELECT feat_key, name, pos, MAX(season_line_pg) AS line, COUNT(*) AS weeks
           FROM feat_player_week_model WHERE season = ? AND season_line_pg IS NOT NULL GROUP BY feat_key`,
      ).all(opts.season) as { feat_key: string; name: string; pos: string; line: number; weeks: number }[];
      if (!seasonRows.length) {
        res.seasonKind.skipped = `no season lines for ${opts.season} -- run \`ff build-weekly-features\` first`;
      } else {
        const insS = db.prepare(
          `INSERT OR IGNORE INTO scorecard_prediction
             (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
           VALUES (@fk,@season,0,'season','season_line',@subject,@name,@pos,@value,NULL,NULL,@asOf,@now)`,
        );
        const now = nowIso();
        const asOf = `${opts.season}-09-01`;
        db.transaction(() => {
          for (const r of seasonRows) {
            // The season total, not the per-game line: what is scored against is points-to-date at
            // season end, and storing the per-game figure would need a games count nobody has yet.
            const info = insS.run({ fk: fmtKey, season: opts.season, subject: r.feat_key, name: r.name, pos: r.pos, value: r.line * r.weeks, asOf, now });
            if (info.changes) res.seasonKind.taken++;
          }
        })();
      }

      // ---- odds kind: playoff and title probability per team, once, before kickoff. ----
      //
      // What is NOT done here is as important as what is. `team_odds` carries a game spread and a
      // total, not a playoff or title probability, and manufacturing one from the spread would give
      // the Brier accrual a number we invented to measure -- our own arithmetic, scored as though it
      // were a forecast. So the probabilities come from the season simulation via `oddsProvider`,
      // or the kind stays empty and says why.
      //
      // Two rows per team, `playoff` and `title`, as separate models: they settle on different
      // facts (a seed, a championship) and a Brier score over a mixture of the two would be a
      // number with no interpretation.
      if (!opts.oddsProvider) {
        res.oddsKind.skipped =
          "no odds provider was supplied. The 'odds' kind needs a playoff and title probability per " +
          "team, which comes from the season simulation against the league's REAL schedule (the app " +
          "bridge) -- pass --odds. It is left EMPTY rather than derived from team_odds, which carries " +
          "a game spread and total: a Brier score accrued against a number we invented would measure " +
          "our own arithmetic.";
      } else {
        const rows = await opts.oddsProvider();
        if (!rows.length) {
          res.oddsKind.skipped = "the odds provider returned no teams -- nothing was written, rather than a snapshot of nothing";
        } else {
          // THE SNAPSHOT'S VINTAGE. `week` on an odds row is not a game week, it is which FREEZE
          // this is: 0 is the preseason one, and a later number is a re-snapshot taken after
          // something changed that the preseason rows could not have known. It exists because the
          // commissioner shortened the 2026 regular season AFTER the preseason odds were frozen, so
          // those rows describe a bracket the league will not play -- and rewriting them is exactly
          // what a write-once record must never do. `--odds-vintage N` writes a second series
          // instead, scored separately against the same outcome.
          //
          // A vintage that already exists is a NO-OP, not an overwrite: INSERT OR IGNORE plus a
          // primary key that includes `week`.
          const vintage = opts.oddsVintage ?? 0;
          const insO = db.prepare(
            `INSERT OR IGNORE INTO scorecard_prediction
               (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
             VALUES (@fk,@season,@vintage,'odds',@model,@subject,@name,NULL,@value,NULL,NULL,@asOf,@now)`,
          );
          const now = nowIso();
          db.transaction(() => {
            for (const r of rows) {
              for (const [model, value] of [["playoff", r.playoffPct], ["title", r.titlePct]] as [string, number][]) {
                if (!Number.isFinite(value)) continue;
                const info = insO.run({ fk: fmtKey, season: opts.season, vintage, model, subject: r.subject, name: r.name, value, asOf: today, now });
                if (info.changes) res.oddsKind.taken++;
              }
            }
          })();
          res.oddsKind.vintage = vintage;
          if (!res.oddsKind.taken) {
            notes.push(`the odds kind was already snapshotted at vintage ${vintage} -- it is written once, so a re-run is a no-op rather than a rewrite.`);
          }
        }
      }
    }

    // ---------------- SCORE ----------------
    if (opts.score !== false) {
      const weeks = settledWeeks(db, opts.season, sched, today);
      if (!weeks.length) notes.push(`no settled weeks of ${opts.season} to score as of ${today}`);
      const all: Scored1[] = [];
      // Both kinds are scored, each against its own frozen rows. The challenger is scored SEPARATELY
      // rather than joined into the weekly table: its lineup column is what a lineup would have been
      // worth had it been served, which is a counterfactual, and putting it in the same table as the
      // shipped models would read as a lineup somebody could have set.
      for (const [week, kind] of weeks.flatMap((w) => SCORECARD_KINDS.map((k) => [w, k] as [number, ScorecardKind]))) {
        const frozen = db.prepare(
          "SELECT model, subject, name, pos, value, p10, p90 FROM scorecard_prediction WHERE format_key = ? AND season = ? AND week = ? AND kind = ?",
        ).all(fmtKey, opts.season, week, kind) as { model: string; subject: string; name: string; pos: string; value: number; p10: number | null; p90: number | null }[];
        if (!frozen.length) {
          if (kind === "weekly") notes.push(`week ${week} is settled but was never snapshotted -- nothing to score`);
          else if (kind === "stream") notes.push(`week ${week} has no frozen streaming picks -- nothing to score for ${kind}`);
          else if (kind === "weekly_ecr_candidate") notes.push(`week ${week} has no ECR-candidate snapshot -- nothing to score for ${kind}`);
          // A week with no Sunday re-read is the NORMAL case for every week before the routine
          // existed, and for any week the window was missed. It is said once and plainly rather than
          // left as a gap a reader has to interpret.
          else if (kind === "weekly_sunday") notes.push(`week ${week} has no Sunday re-read (kind weekly_sunday) -- nothing to score for it`);
          else if (week >= CHALLENGER_FIRST_WEEK) notes.push(`week ${week} has no challenger snapshot -- nothing to score for ${kind}`);
          continue;
        }
        const actual = new Map<string, number>();
        for (const r of db.prepare(
          "SELECT feat_key, pts, is_bye FROM feat_player_week_model WHERE season = ? AND week = ?",
        ).all(opts.season, week) as { feat_key: string; pts: number | null; is_bye: number | null }[]) {
          if (!r.is_bye) actual.set(r.feat_key, r.pts ?? 0);
        }
        // THE CHALLENGER NEEDS A BASELINE IN THE SAME ROW SET, or its lineup column is unscoreable:
        // `lineupRegret` measures points captured against `SC_BASELINE`, and the challenger kind
        // holds exactly one model. So the shipped kind's frozen rows for the SAME WEEK are loaded
        // alongside it -- read-only, purely as the comparison set. They are not re-scored here (the
        // `weekly` pass above already did that); only this kind's own models are pushed.
        // The `stream` kind gets NO companions. Its rows are one PICK per position -- a different
        // subject each week -- so joining the weekly kind's per-player projections beside them would
        // put a projection for a man nobody picked into a table about who was picked, and
        // lineupRegret would then draw rosters out of six players. The challenger needs them (its
        // lineup column is scored against SC_BASELINE and it holds exactly one model); this does not.
        // `weekly_ecr_candidate` needs them for the SAME reason the challenger does and on the same
        // terms: it holds exactly one model, so without the shipped kind's rows beside it its lineup
        // column has nothing to be regret against and is left NaN.
        // `weekly_sunday` is in this set for the SAME reason and with the same consequence: it holds
        // one model per window and its lineup column only means something against the Friday rows it
        // is a re-read OF. Without the companions its `lineup_pts` would be NaN, which is exactly the
        // number the whole M2c workflow exists to produce.
        const WHOLE_FIELD_KINDS = new Set<ScorecardKind>(["weekly_challenger", "weekly_ecr_candidate", "weekly_sunday"]);
        const companions = !WHOLE_FIELD_KINDS.has(kind) ? [] : db.prepare(
          "SELECT model, subject, name, pos, value, p10, p90 FROM scorecard_prediction WHERE format_key = ? AND season = ? AND week = ? AND kind = 'weekly'",
        ).all(fmtKey, opts.season, week) as typeof frozen;
        const bySubject = new Map<string, Scored1>();
        for (const f of [...frozen, ...companions]) {
          const y = actual.get(f.subject);
          if (y == null) continue;
          const s = bySubject.get(f.subject) ?? bySubject.set(f.subject, {
            key: f.subject, pos: f.pos, band: "all", season: opts.season, week, actual: y, by: {},
          }).get(f.subject)!;
          // A point-only model gets no interval, and its CRPS and coverage are therefore not
          // reported. Fabricating a band here would let a point forecast score as a distribution.
          s.by[f.model] = {
            mean: f.value,
            p10: f.p10 ?? NaN, p50: f.value, p90: f.p90 ?? NaN,
          };
        }
        if (kind === "weekly") all.push(...bySubject.values());

        const models = [...new Set(frozen.map((f) => f.model))].sort();
        const lrModels = [...new Set([...models, ...companions.map((f) => f.model)])].sort();
        // Without the baseline present, lineup regret has nothing to be regret AGAINST. Reporting
        // whatever it returns in that state would be a number with no referent, so the columns are
        // left NaN and say nothing rather than saying something unfounded.
        const canLineup = lrModels.includes(SC_BASELINE);
        const lr = canLineup ? lineupRegret([...bySubject.values()], opts.rosters ?? 200, { models: lrModels, baseline: SC_BASELINE }) : {};
        const sc = Object.keys(lr)[0];
        for (const m of models) {
          const rows = [...bySubject.values()].filter((r) => r.by[m]).map((r) => ({ actual: r.actual, p: r.by[m] }));
          const hasBand = rows.length > 0 && rows.every((r) => Number.isFinite(r.p.p10) && Number.isFinite(r.p.p90));
          const s = score(rows);
          res.scored.push({
            week, kind, model: m, n: s.n, rmse: s.rmse,
            crps: hasBand ? s.crps : NaN, coverage: hasBand ? s.coverage : NaN,
            lineupPts: (sc ? lr[sc]?.[m]?.meanCaptured : undefined) ?? NaN,
            lineupWinShare: (sc ? lr[sc]?.[m]?.winShare : undefined) ?? NaN,
          });
        }
      }

      // Persist the scored rows. Rebuildable BY DESIGN, unlike the predictions.
      const insR = db.prepare(
        `INSERT INTO scorecard_result (format_key, season, week, kind, model, metric, value, n, scored_at)
         VALUES (@fk,@season,@week,@kind,@model,@metric,@value,@n,@now)
         ON CONFLICT(format_key, season, week, kind, model, metric) DO UPDATE SET
           value=excluded.value, n=excluded.n, scored_at=excluded.scored_at`,
      );
      const now = nowIso();
      db.transaction(() => {
        for (const r of res.scored) {
          for (const [metric, value] of [["rmse", r.rmse], ["crps", r.crps], ["coverage", r.coverage],
            ["lineup_pts", r.lineupPts], ["lineup_win_share", r.lineupWinShare]] as [string, number][]) {
            if (Number.isFinite(value)) insR.run({ fk: fmtKey, season: opts.season, week: r.week, kind: r.kind, model: r.model, metric, value, n: r.n, now });
          }
        }
      })();

      // ---- the season kind, scored against points to date. ----
      const sp = db.prepare(
        "SELECT subject, value FROM scorecard_prediction WHERE format_key = ? AND season = ? AND kind = 'season'",
      ).all(fmtKey, opts.season) as { subject: string; value: number }[];
      if (sp.length && weeks.length) {
        const todate = new Map<string, number>();
        for (const r of db.prepare(
          `SELECT feat_key, SUM(COALESCE(pts, 0.0)) AS p FROM feat_player_week_model
            WHERE season = ? AND week <= ? AND COALESCE(is_bye,0)=0 GROUP BY feat_key`,
        ).all(opts.season, Math.max(...weeks)) as { feat_key: string; p: number }[]) todate.set(r.feat_key, r.p);
        const share = Math.max(...weeks) / 17;
        const pairs = sp.filter((r) => todate.has(r.subject))
          .map((r) => ({ pred: r.value * share, act: todate.get(r.subject)! }));
        if (pairs.length) {
          const rmse = Math.sqrt(pairs.reduce((s, p) => s + (p.pred - p.act) ** 2, 0) / pairs.length);
          res.seasonScored = {
            n: pairs.length, rmse,
            note: `preseason season projection prorated to ${Math.max(...weeks)}/17 of a season, ` +
              "against points scored so far. Prorating is the only honest comparison mid-season and " +
              "it assumes an even scoring rate, which is a stated approximation, not a measurement.",
          };
        }
      }

      // ---- the odds kind, scored once the season has resolved. ----
      const od = scoreOdds(db, opts.season, { formatKey: fmtKey, leagueId: lctx.leagueId });
      res.oddsScored = od;
      if (od.skipped) notes.push(`odds accrual: ${od.skipped}`);
      else {
        const insO = db.prepare(
          `INSERT INTO scorecard_result (format_key, season, week, kind, model, metric, value, n, scored_at)
           VALUES (@fk,@season,0,'odds',@model,@metric,@value,@n,@now)
           ON CONFLICT(format_key, season, week, kind, model, metric) DO UPDATE SET
             value=excluded.value, n=excluded.n, scored_at=excluded.scored_at`,
        );
        const nowO = nowIso();
        db.transaction(() => {
          for (const m of od.models) {
            for (const [metric, value] of [
              ["brier", m.brier], ["log_loss", m.logLoss],
              ["uniform_brier", m.uniformBrier], ["uniform_log_loss", m.uniformLogLoss],
              ["skill", m.skill],
            ] as [string, number][]) {
              if (Number.isFinite(value)) insO.run({ fk: fmtKey, season: opts.season, model: m.model, metric, value, n: m.n, now: nowO });
            }
          }
        })();
      }
    }
  } finally { db.close(); }
  return res;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");

export function formatScorecard(r: ScorecardResult): string {
  const out: string[] = [];
  out.push(`SCORECARD ${r.season} -- as of ${r.today}; imminent week ${r.imminentWeek ?? "(none)"}`);
  out.push("");
  out.push("SNAPSHOT (written once, never updated)");
  if (r.snapshot.skipped) out.push(`  week ${r.snapshot.week ?? "-"}: SKIPPED -- ${r.snapshot.skipped}`);
  else {
    out.push(`  week ${r.snapshot.week}: ${r.snapshot.taken} new prediction rows`);
    for (const [m, n] of Object.entries(r.snapshot.byModel)) out.push(`    ${pad(m, 14)} ${n}`);
  }
  // The dual snapshot, stated every run rather than inferred from a gap in the table.
  if (r.servedBy) {
    out.push("  weekly kind, per position (the table lineupRecommend and the stream picks read):");
    for (const [pos, file] of Object.entries(r.servedBy)) out.push(`    ${pad(pos, 5)} ${file}`);
    out.push(`    mapping in force since ${WEEKLY_SERVE_SWITCHED_ON}`);
  }
  if (r.challenger.skipped) out.push(`  challenger:  week ${r.challenger.week ?? "-"}: SKIPPED -- ${r.challenger.skipped}`);
  else out.push(`  challenger:  week ${r.challenger.week}: ${r.challenger.taken} rows from ${CHALLENGER_WEEKLY_ARTIFACT} (kind weekly_challenger, model two_part), series starts week ${CHALLENGER_FIRST_WEEK}`);
  if (r.ecrCandidate?.skipped) out.push(`  ecr cand:    week ${r.ecrCandidate.week ?? "-"}: SKIPPED -- ${r.ecrCandidate.skipped}`);
  else if (r.ecrCandidate) {
    out.push(`  ecr cand:    week ${r.ecrCandidate.week}: ${r.ecrCandidate.taken} rows from ${ECR_CANDIDATE_WEEKLY_ARTIFACT} ` +
      "(kind weekly_ecr_candidate, model ecr_candidate) -- NOT SERVED; a forward record for an admission awaiting sign-off");
  }
  // OPTIONAL ACCESS ON PURPOSE. `formatScorecard` is also called on hand-built result objects, and a
  // formatter that throws on a field a caller did not supply turns a reporting concern into a crash
  // at the end of a run that has already written its predictions.
  if (r.stream?.skipped) out.push(`  stream:      week ${r.stream.week ?? "-"}: SKIPPED -- ${r.stream.skipped}`);
  else if (r.stream) {
    out.push(`  stream:      week ${r.stream.week}: ${r.stream.taken} rows (one pick per position, plus the board's pick beside it)`);
    const served = Object.entries(r.stream.artifactByPos ?? {}).map(([p, a]) => `${p} ${a}`).join(", ");
    if (served) out.push(`               served by: ${served}`);
  }
  out.push(`  season kind: ${r.seasonKind.taken} rows${r.seasonKind.skipped ? " -- " + r.seasonKind.skipped : ""}`);
  out.push(`  odds kind:   ${r.oddsKind.taken} rows${r.oddsKind.vintage != null ? ` at vintage ${r.oddsKind.vintage}` : ""}${r.oddsKind.skipped ? " -- " + r.oddsKind.skipped : ""}`);
  out.push(`  espn:        ${r.espn.attempted ? (r.espn.ok ? `${r.espn.stored} stored` : "not stored") : "not attempted"} -- ${r.espn.reason}`);
  out.push("");
  out.push("SCORED WEEKS");
  if (!r.scored.length) out.push("  (nothing settled yet)");
  else {
    out.push("  " + pad("week", 6) + pad("kind", 20) + pad("model", 14) + "      n     RMSE     CRPS    cover   lineup  winShare");
    for (const s of r.scored) {
      out.push("  " + pad(String(s.week), 6) + pad(s.kind, 20) + pad(s.model, 14) + String(s.n).padStart(7) +
        num(s.rmse).padStart(9) + num(s.crps).padStart(9) + num(s.coverage).padStart(9) +
        num(s.lineupPts, 2).padStart(9) + num(s.lineupWinShare).padStart(10));
    }
  }
  if (r.seasonScored) {
    out.push("");
    out.push(`SEASON KIND: n=${r.seasonScored.n}, RMSE ${r.seasonScored.rmse.toFixed(2)}`);
    out.push(`  ${r.seasonScored.note}`);
  }
  if (r.oddsScored) {
    out.push("");
    if (r.oddsScored.skipped) {
      out.push(`ODDS ACCRUAL: not scored -- ${r.oddsScored.skipped}`);
    } else {
      out.push(`ODDS ACCRUAL, ${r.oddsScored.season} (${r.oddsScored.teams} teams)`);
      out.push("  " + pad("model", 10) + "     n" + "    Brier" + " uniform" + " logLoss" + " uniform" + "    skill");
      for (const m of r.oddsScored.models) {
        out.push("  " + pad(m.model, 10) + String(m.n).padStart(6) +
          num(m.brier, 4).padStart(9) + num(m.uniformBrier, 4).padStart(8) +
          num(m.logLoss, 4).padStart(8) + num(m.uniformLogLoss, 4).padStart(8) +
          `${(100 * m.skill).toFixed(1)}%`.padStart(9));
      }
      out.push("  skill is 1 - Brier/uniform: POSITIVE beats a flat prior, NEGATIVE is worse than knowing nothing.");
      for (const m of r.oddsScored.models) {
        out.push(`  reliability, ${m.model}: ` + m.reliability
          .map((b) => `${(100 * b.lo).toFixed(0)}-${(100 * b.hi).toFixed(0)}% n=${b.n} pred ${(100 * b.predicted).toFixed(1)}% obs ${(100 * b.observed).toFixed(1)}%`)
          .join("; "));
      }
    }
  }
  if (r.notes.length) {
    out.push("");
    out.push("NOTES");
    for (const n of r.notes) out.push(`  ${n}`);
  }
  return out.join("\n");
}

// ==================================================================================================
// THE SUNDAY RE-READ: kind `weekly_sunday` (M2c, 2026-09-16)
// ==================================================================================================
//
// WHAT IT IS FOR. `scripts/availability-gap.mjs` measures the gap this closes: of the zero-scoring
// men our lineup starts, the largest recoverable class is the GAME-DAY INACTIVE -- no Friday
// designation, zero snaps. The managers beat us there because they read the 11:30 ET inactive list
// and our board is a Friday snapshot. The remedy is not a better model, it is a SECOND READ.
//
// WHY IT IS A NEW KIND RATHER THAN A REWRITE. The `weekly` rows for the week are already frozen and
// `scorecard_prediction` is INSERT OR IGNORE by design, so "update the projection with Sunday news"
// is not available and must not be: a record that can be improved after the fact is not a record.
// The Sunday read is therefore a SEPARATE, equally write-once series, on the SAME players, in the
// SAME week, whose only difference from the Friday rows is the availability information. When the
// week settles, `ff scorecard` scores both against the same actuals and the season accrues the
// paired evidence -- Friday lineup, Sunday lineup, actual -- one week at a time.
//
// THE ROWS ARE COPIED FROM THE FROZEN `weekly` ROWS, NOT RE-PROJECTED. That is deliberate and it is
// what makes the comparison mean anything: if the Sunday rows were re-projected, a difference
// between the two series could be the re-read OR a week's worth of new feature rows, and nothing in
// the table would say which. Copying the frozen value and zeroing exactly the men the game-day feed
// rules out isolates the one variable. A man with a game-day OUT gets value 0, which is what
// "benched" means to `lineupRegret`: it will never pick him, and he cannot flatter the series by
// scoring after being written off.
//
// THE WINDOW RULE, and it is a REFUSAL, not a preference. The read is only worth taking inside the
// short interval where the inactive list exists and the lineup can still be changed: from
// `SUNDAY_LEAD_MINUTES` before a Sunday kickoff until that kickoff. Two windows, because the league
// plays in two waves -- the early games (the 13:00 ET block) and the late ones (16:00 ET and after)
// -- and a man in the late wave is still benchable at 15:00 when the early wave has already kicked
// off. Outside both, `resolveSundayWindow` refuses BY NAME and says what the windows were. A freeze
// taken at any other time would be a "Sunday re-read" that read nothing new, filed under a name that
// claims it did.
//
// CLOCK. Everything here is AMERICA/NEW_YORK, because `raw_nfl_game.gametime` is, and because a
// football kickoff is an ET fact rather than a UTC one. The machine's own timezone is never used;
// `etClock` converts explicitly and `opts.now` injects an ET wall clock for tests and dry-runs.
// This is the same failure the `iso()` helper above documents, one timezone further out.

/** The kind, its two models, and the lead time, named once so nothing retypes a string. */
export const SUNDAY_KIND = "weekly_sunday" as const;
export type SundayWindowName = "early" | "late";
export const SUNDAY_MODEL: Record<SundayWindowName, string> = { early: "sunday_early", late: "sunday_late" };
/** How long before a kickoff the window opens. 90 minutes puts the early read at 11:30 ET against a
 *  13:00 ET first kickoff, which is when the league-wide inactive list is published. */
export const SUNDAY_LEAD_MINUTES = 90;
/** The boundary between the two waves, in ET. A game at or after this is "late". */
export const SUNDAY_LATE_FROM = "16:00";

const hm2min = (hm: string): number => {
  const [h, m] = hm.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
const min2hm = (t: number): string => {
  const w = ((t % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
};

/**
 * NOW, IN ET, as a calendar day and a wall clock. Never `toISOString`, never the machine's local
 * time: this machine is not guaranteed to be in ET and the schedule table is.
 */
export function etClock(now: Date = new Date()): { day: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");          // en-CA emits 24 for midnight
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hm: `${hour}:${get("minute")}` };
}

/** One re-read opportunity: when the wave kicks off and when reading it becomes worth doing. */
export interface SundayWindow { name: SundayWindowName; kickoff: string; opens: string; games: number }

/**
 * THE WINDOWS FOR ONE ET CALENDAR DAY, from the schedule the store already holds.
 *
 * Returns `week: null` when the day carries no REG Sunday game, which is the honest answer on a
 * Wednesday and the one the routine's refusal is built on. The weekday test is against
 * `raw_nfl_game.weekday`, not against a date computation, so a Saturday slate late in the season
 * cannot be silently treated as a Sunday.
 */
export function sundayWindowsFor(db: DB, season: number, day: string): { week: number | null; windows: SundayWindow[] } {
  const rows = db.prepare(
    `SELECT week, gametime, COUNT(*) AS n FROM raw_nfl_game
      WHERE season = ? AND game_type = 'REG' AND gameday = ? AND weekday = 'Sunday'
        AND gametime IS NOT NULL AND gametime <> ''
      GROUP BY week, gametime ORDER BY gametime`,
  ).all(season, day) as { week: number; gametime: string; n: number }[];
  if (!rows.length) return { week: null, windows: [] };
  const week = rows[0].week;
  const boundary = hm2min(SUNDAY_LATE_FROM);
  const pick = (late: boolean): SundayWindow | null => {
    const sub = rows.filter((r) => (hm2min(r.gametime) >= boundary) === late);
    if (!sub.length) return null;
    const kickoff = sub[0].gametime;                                 // ordered by gametime already
    return {
      name: late ? "late" : "early", kickoff,
      opens: min2hm(hm2min(kickoff) - SUNDAY_LEAD_MINUTES),
      games: sub.filter((r) => r.gametime === kickoff).reduce((s, r) => s + r.n, 0),
    };
  };
  return { week, windows: [pick(false), pick(true)].filter((w): w is SundayWindow => w != null) };
}

export interface SundayWindowVerdict {
  day: string; hm: string;
  week: number | null;
  windows: SundayWindow[];
  window: SundayWindow | null;
  /** Null when a window is open. Otherwise the reason, naming the windows that exist. */
  refused: string | null;
}

/**
 * IS A RE-READ DUE RIGHT NOW? The one gate, so the CLI verb, the routine and the test all ask the
 * same question of the same schedule.
 */
export function resolveSundayWindow(
  db: DB, season: number, opts: { now?: string; nowDate?: Date } = {},
): SundayWindowVerdict {
  // `now` is an ET wall clock, injected. "2026-09-20T11:45" and "2026-09-20 11:45" both parse; a
  // bare date is midnight, which is outside every window and refuses, correctly.
  let day: string, hm: string;
  if (opts.now) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(opts.now.trim());
    if (!m) throw new Error(`--now must be an ET wall clock like 2026-09-20T11:45, got "${opts.now}"`);
    day = m[1]; hm = m[2] ?? "00:00";
  } else {
    const c = etClock(opts.nowDate);
    day = c.day; hm = c.hm;
  }
  const { week, windows } = sundayWindowsFor(db, season, day);
  const v: SundayWindowVerdict = { day, hm, week, windows, window: null, refused: null };
  if (week == null) {
    v.refused = `${day} is not an NFL Sunday in season ${season} -- raw_nfl_game carries no dated REG ` +
      "Sunday game that day, so there is no inactive list to re-read and nothing to freeze.";
    return v;
  }
  const t = hm2min(hm);
  v.window = windows.find((w) => t >= hm2min(w.opens) && t < hm2min(w.kickoff)) ?? null;
  if (!v.window) {
    v.refused = `${day} ${hm} ET is outside every re-read window for week ${week}. The windows are ` +
      windows.map((w) => `${w.name} ${w.opens}-${w.kickoff} ET`).join(" and ") +
      ` (${SUNDAY_LEAD_MINUTES} minutes before each wave's first kickoff). A freeze taken outside them ` +
      "would be filed as a Sunday re-read having read nothing the Friday rows did not already have.";
  }
  return v;
}

/** One slot that changed hands between the Friday lineup and the Sunday one. `outPos` is the SLOT
 *  (QB, FLEX, ...), because the question is which hole opened, not which position the man plays. */
export interface SundaySwap { out: string; outPos: string; in: string | null; inPos: string | null; deltaProj: number }

export interface SundayFreezeResult {
  season: number;
  week: number | null;
  day: string; hm: string;
  window: SundayWindowName | null;
  /** The frozen `as_of`: the ET moment the re-read was taken. Not the week's Friday anchor. */
  asOf: string | null;
  /** Rows written. Zero on a re-run: the kind is written once, like every other prediction here. */
  taken: number;
  /** How many of those rows were zeroed by a game-day OUT, and who. */
  benched: { subject: string; name: string; pos: string; status: string }[];
  /** What the re-read does to OUR lineup, computed on the same frozen projections. Empty when the
   *  league has no roster rows for the week -- said, never inferred. */
  swaps: SundaySwap[];
  swapNote: string | null;
  skipped: string | null;
  windows: SundayWindow[];
}

/**
 * WHO THE GAME-DAY FEED RULES OUT, as `feat_key` (the subject a frozen row is keyed by).
 *
 * `normalizeStatus` is imported from the copilot rather than re-implemented: it is the rule that
 * decides who is startable everywhere else in this repo (DOUBTFUL counts as OUT, QUESTIONABLE stays
 * startable), and a second copy here would let the scorecard and the lineup disagree about who can
 * play -- which is the exact defect the whole availability path exists to prevent.
 */
export function gamedayOutSubjects(db: DB, season: number, week: number): Map<string, { name: string; status: string }> {
  const out = new Map<string, { name: string; status: string }>();
  const rows = db.prepare(
    `SELECT g.status AS status, COALESCE(g.name, m.name) AS name, m.feat_key AS feat_key
       FROM raw_gameday_status g
       JOIN feat_player_week_model m
         ON m.season = g.season AND m.week = g.week AND CAST(m.player_sk AS TEXT) = CAST(g.player_sk AS TEXT)
      WHERE g.season = ? AND g.week = ? AND g.status IS NOT NULL AND m.feat_key IS NOT NULL`,
  ).all(season, week) as { status: string; name: string | null; feat_key: string }[];
  for (const r of rows) {
    if (normalizeStatus(r.status) !== "OUT") continue;               // QUESTIONABLE stays startable
    out.set(r.feat_key, { name: r.name ?? r.feat_key, status: r.status });
  }
  return out;
}

/**
 * OUR LINEUP, BEFORE AND AFTER THE RE-READ, on the frozen projections.
 *
 * This is the part a reader cares about: not "23 rows were written" but "it benches Smith and starts
 * Jones". It is computed from the league's OWN roster rows and starting template, through the same
 * `optimalLineup` the copilot serves from -- so a swap printed here is a swap the lineup surface
 * would make, not a second implementation's opinion.
 */
function sundaySwaps(
  db: DB, leagueId: string | null, season: number, week: number,
  proj: Map<string, number>, posOf: Map<string, string>, outSubjects: Map<string, { name: string; status: string }>,
): { swaps: SundaySwap[]; note: string | null } {
  if (!leagueId) return { swaps: [], note: "no league resolved -- the lineup swap was not computed" };
  const lg = db.prepare("SELECT team_id FROM league WHERE league_id = ?").get(leagueId) as { team_id: string | null } | undefined;
  if (!lg?.team_id) return { swaps: [], note: `league ${leagueId} has no team_id -- we hold no seat in it, so there is no lineup to move` };
  const roster = db.prepare(
    `SELECT espn_player_id, name, position, lineup_slot_id FROM raw_league_roster_week
      WHERE league_id = ? AND season = ? AND week = ? AND team_id = ?`,
  ).all(leagueId, season, week, lg.team_id) as { espn_player_id: string; name: string; position: string; lineup_slot_id: number }[];
  if (!roster.length) {
    return { swaps: [], note: `no raw_league_roster_week rows for league ${leagueId} ${season} week ${week} -- the swap was not computed rather than computed on an empty roster` };
  }
  const template = startingTemplate(db, leagueId, season);
  if (!template.length) return { swaps: [], note: `league ${leagueId} has no derivable starting template for ${season}` };

  // espn id -> player_sk -> feat_key, through `buildEspnResolver` -- the SAME four-stage resolver the
  // roster-state builder uses, not a hand-rolled xref lookup. That matters for exactly the case a
  // hand-rolled one gets wrong: a team defence has no xref row at all, because ESPN keys it under a
  // negative id (-16000 minus the proTeamId), and the resolver turns that into the `DST:ABBR` key the
  // frozen rows are subjects of. A roster that half-resolves would silently build a lineup out of the
  // half that did, so an unmatched man is COUNTED and named in the note.
  const resolver = buildEspnResolver(db);
  const keyOfSk = new Map<string, string>();
  for (const r of db.prepare(
    "SELECT CAST(player_sk AS TEXT) sk, feat_key FROM feat_player_week_model WHERE season = ? AND week = ? AND player_sk IS NOT NULL",
  ).all(season, week) as { sk: string; feat_key: string }[]) keyOfSk.set(r.sk, r.feat_key);

  let unmatched = 0;
  const build = (applyOut: boolean) => {
    const players: { name: string; pos: string; proj: number; available: boolean }[] = [];
    for (const r of roster) {
      if (r.lineup_slot_id === 21) continue;                        // IR is not startable
      const sk = resolver.resolve(String(r.espn_player_id), r.name, r.position)?.sk;
      // A DST resolves straight to its own `DST:ABBR` feat_key; everyone else goes through the week's
      // feature rows. `proj.has` is the final gate: a man with no frozen row has no projection and
      // must not enter either lineup at zero, which would read as a benching.
      let key = sk ? keyOfSk.get(sk) : undefined;
      if (!key && sk && proj.has(sk)) key = sk;
      if (!key) { if (!applyOut) unmatched++; continue; }
      players.push({
        name: `${r.name}#${key}`, pos: posOf.get(key) ?? r.position,
        proj: proj.get(key) ?? 0,
        available: !(applyOut && outSubjects.has(key)),
      });
    }
    return optimalLineup(players, template, ["RB", "WR", "TE"]);
  };
  const before = build(false), after = build(true);
  const nameOf = (s: { name: string }) => s.name.split("#")[0];
  // DIFFED PER SLOT, not by zipping the dropped list against the added list. Both lineups come from
  // the same template in the same order, so slot i is the same slot on both sides; pairing by list
  // index instead reports "OUT the quarterback -> IN a receiver", which is not what happened and
  // reads as a rule that swaps across positions. The slot says which hole the replacement filled.
  const swaps: SundaySwap[] = [];
  for (let i = 0; i < before.starters.length && i < after.starters.length; i++) {
    const b = before.starters[i], a = after.starters[i];
    if (b.name === a.name) continue;
    swaps.push({
      out: b.name === "(empty)" ? `(empty ${b.slot})` : nameOf(b), outPos: b.slot,
      in: a.name === "(empty)" ? null : nameOf(a), inPos: a.name === "(empty)" ? null : a.pos,
      deltaProj: Math.round(((a.name === "(empty)" ? 0 : a.proj) - (b.name === "(empty)" ? 0 : b.proj)) * 100) / 100,
    });
  }
  const note = unmatched ? `${unmatched} rostered player(s) matched no frozen row and were left out of BOTH lineups` : null;
  return { swaps, note };
}

export interface SundayFreezeOpts {
  season: number;
  /** The ET wall clock. Injected by tests and by `--now`; omitted, the real clock in ET. */
  now?: string;
  leagueId?: string | null;
  /** Take the window's verdict but write nothing. The refusal is evaluated either way. */
  dryRun?: boolean;
}

/**
 * FREEZE THE SUNDAY RE-READ. Write-once, windowed, and a no-op on a second call in the same window.
 *
 * The order of the refusals is the order of the reasons: no window -> nothing to re-read; no Friday
 * rows -> nothing to re-read AGAINST. Neither is an error, both are reported, and a caller that
 * treats a skip as a failure is wrong about what this is: most invocations, on most days, correctly
 * do nothing.
 */
export function freezeSundayKind(db: DB, opts: SundayFreezeOpts): SundayFreezeResult {
  const v = resolveSundayWindow(db, opts.season, { now: opts.now });
  const res: SundayFreezeResult = {
    season: opts.season, week: v.week, day: v.day, hm: v.hm,
    window: v.window?.name ?? null, asOf: null, taken: 0, benched: [], swaps: [], swapNote: null,
    skipped: v.refused, windows: v.windows,
  };
  if (v.refused || !v.window || v.week == null) return res;
  const week = v.week;
  const { formatKey, leagueId } = scorecardScope(db, { leagueId: opts.leagueId });

  const frozen = db.prepare(
    `SELECT subject, name, pos, value, p10, p90 FROM scorecard_prediction
      WHERE format_key = ? AND season = ? AND week = ? AND kind = 'weekly' AND model = 'weekly'`,
  ).all(formatKey, opts.season, week) as { subject: string; name: string; pos: string; value: number; p10: number | null; p90: number | null }[];
  if (!frozen.length) {
    res.skipped = `week ${week} has no frozen \`weekly\` rows for format ${formatKey} -- a Sunday re-read is ` +
      "a re-read OF the Friday snapshot, and there is nothing to re-read against. Run `ff scorecard` before kickoff.";
    return res;
  }

  const outSubjects = gamedayOutSubjects(db, opts.season, week);
  const asOf = `${v.day}T${v.hm}:00`;                                // ET wall clock, the re-read moment
  res.asOf = asOf;
  const model = SUNDAY_MODEL[v.window.name];

  const proj = new Map<string, number>(), posOf = new Map<string, string>();
  for (const f of frozen) { proj.set(f.subject, f.value); posOf.set(f.subject, f.pos); }
  for (const f of frozen) {
    const o = outSubjects.get(f.subject);
    if (o) res.benched.push({ subject: f.subject, name: f.name, pos: f.pos, status: o.status });
  }
  const sw = sundaySwaps(db, leagueId, opts.season, week, proj, posOf, outSubjects);
  res.swaps = sw.swaps; res.swapNote = sw.note;

  if (opts.dryRun) {
    res.skipped = `--dry-run: ${frozen.length} row(s) WOULD be frozen under kind ${SUNDAY_KIND} model ${model} at ${asOf} ET; nothing was written.`;
    return res;
  }

  ensureScorecardMetaColumn(db);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO scorecard_prediction
       (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at, ${SCORECARD_META_COLUMN})
     VALUES (@fk,@season,@week,'${SUNDAY_KIND}',@model,@subject,@name,@pos,@value,@p10,@p90,@asOf,@now,@meta)`,
  );
  const now = nowIso();
  db.transaction(() => {
    for (const f of frozen) {
      const o = outSubjects.get(f.subject);
      const info = ins.run({
        fk: formatKey, season: opts.season, week, model,
        subject: f.subject, name: f.name, pos: f.pos,
        // ZEROED, not omitted. An omitted row would shrink the population the lineup is drawn from
        // and make the Sunday series look better by having fewer men to get wrong.
        value: o ? 0 : f.value,
        p10: o ? 0 : f.p10, p90: o ? 0 : f.p90,
        asOf, now,
        meta: JSON.stringify({
          window: v.window!.name, kickoff: v.window!.kickoff, opens: v.window!.opens, tz: "America/New_York",
          rereadOf: "weekly/weekly", benched: o ? o.status : null, source: o ? "gameday(espn)" : null,
        }),
      });
      if (info.changes) res.taken++;
    }
  })();
  if (!res.taken) {
    res.skipped = `week ${week}'s ${v.window.name} Sunday re-read was already frozen -- it is written once, ` +
      "so a second call in the same window is a no-op rather than a rewrite.";
  }
  return res;
}

export function formatSunday(r: SundayFreezeResult): string {
  const out: string[] = [];
  out.push(`SUNDAY RE-READ ${r.season} -- ${r.day} ${r.hm} ET`);
  if (r.windows.length) {
    out.push(`  week ${r.week} windows: ` + r.windows.map((w) => `${w.name} ${w.opens}-${w.kickoff} ET (${w.games} games)`).join(", "));
  }
  out.push(`  window: ${r.window ?? "NONE -- outside every re-read window"}`);
  if (r.skipped) out.push(`  SKIPPED: ${r.skipped}`);
  else out.push(`  froze ${r.taken} row(s) under kind ${SUNDAY_KIND} at as_of ${r.asOf} (write-once)`);
  out.push(`  game-day OUT on the frozen population: ${r.benched.length}` +
    (r.benched.length ? ` -- ${r.benched.slice(0, 12).map((b) => `${b.name} (${b.pos}, ${b.status})`).join(", ")}` : ""));
  if (r.swaps.length) {
    out.push("  OUR LINEUP MOVES:");
    for (const s of r.swaps) out.push(`    OUT ${s.out} (${s.outPos})  ->  IN ${s.in ?? "(empty)"} (${s.inPos ?? "-"})  proj ${s.deltaProj >= 0 ? "+" : ""}${s.deltaProj}`);
  } else {
    out.push("  OUR LINEUP MOVES: none" + (r.swapNote ? ` -- ${r.swapNote}` : ""));
  }
  if (r.swaps.length && r.swapNote) out.push(`  note: ${r.swapNote}`);
  return out.join("\n");
}
