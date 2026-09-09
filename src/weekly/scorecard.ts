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
import { openDb, nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import {
  loadWeeklyArtifact, projectWeekly, seasonLineOnlyArtifact,
  SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT, type WeeklyArtifact,
} from "./projector.js";
import { loadWeeklyRows, loadSchedule, type ScheduleInfo } from "./features.js";
import { makeProjections } from "../projections.js";
import { score, lineupRegret, type Scored1, type Pred } from "./evaluate.js";
import { fetchEspnWeekly, storeEspnWeekly } from "./espnProjections.js";

export const SCORECARD_MODELS = ["weekly", "season_line", "shipped_week", "trailing4", "espn"] as const;
export type ScorecardModel = typeof SCORECARD_MODELS[number];
/** The model the weekly gains are quoted against, matching src/weekly/evaluate.ts. */
export const SC_BASELINE: ScorecardModel = "shipped_week";

/**
 * THE DUAL SNAPSHOT, and why there are two kinds rather than a sixth model.
 *
 * `weekly` is the SHIPPED path: every model in it is served from the artifact the lineup is actually
 * served from (`SHIPPED_WEEKLY_ARTIFACT`), so the record accrues for the thing a decision was made
 * on. `weekly_challenger` is the two-part model that FAILED clause (c) of the pre-registered gate by
 * five thousandths -- the same players, the same week, the same frozen `as_of`, projected from
 * `CHALLENGER_WEEKLY_ARTIFACT`.
 *
 * Two kinds, not one kind with an extra model, because they answer different questions and the
 * lineup-regret baseline inside a kind only means something when every model in it was available to
 * choose from. Mixing an unshipped model into `weekly` would make its lineup column read as a
 * lineup somebody could have set.
 */
export const SCORECARD_KINDS = ["weekly", "weekly_challenger"] as const;
export type ScorecardKind = typeof SCORECARD_KINDS[number];

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

export interface ScorecardOpts {
  dbPath?: string;
  season: number;
  /** Take the snapshot for the imminent week. */
  snapshot?: boolean;
  /** Score every week whose games are all settled. */
  score?: boolean;
  /** Also read ESPN's own weekly projection through the app bridge. */
  espn?: boolean;
  /** Snapshot a specific week rather than the imminent one. */
  week?: number;
  /** The date the run is anchored to. Injectable so a test can drive the refusal path. */
  today?: string;
  /** The SHIPPED weekly artifact, the one `lineupRecommend` serves from. Defaults to
   *  `SHIPPED_WEEKLY_ARTIFACT`; overridable only so a test can drive a fixture. */
  artifactPath?: string;
  /** The challenger, snapshotted under its own kind. Defaults to `CHALLENGER_WEEKLY_ARTIFACT`. */
  challengerArtifactPath?: string;
  rosters?: number;
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
  /** The `weekly_challenger` kind: the two-part model, same players, same frozen as-of. */
  challenger: { week: number | null; taken: number; skipped: string | null };
  espn: { attempted: boolean; ok: boolean; reason: string; stored: number };
  seasonKind: { taken: number; skipped: string | null };
  oddsKind: { taken: number; skipped: string | null };
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
function weeklyPredictions(db: DB, season: number, week: number, artifact: WeeklyArtifact, lineOnly: WeeklyArtifact) {
  const rows = loadWeeklyRows(db, season, week).filter((r) => r.season_line_pg != null);
  const out = new Map<string, { name: string; pos: string; by: Partial<Record<ScorecardModel, Pred>> }>();
  const put = (k: string, name: string, pos: string, m: ScorecardModel, p: Pred) => {
    const cur = out.get(k) ?? out.set(k, { name, pos, by: {} }).get(k)!;
    cur.by[m] = p;
  };
  for (const r of projectWeekly({ artifact, rows })) {
    put(r.feat_key, r.name, r.pos, "weekly", { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  for (const r of projectWeekly({ artifact: lineOnly, rows })) {
    put(r.feat_key, r.name, r.pos, "season_line", { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  // The SHIPPED path, called as the app calls it. gamesPerSeason 1 because season_line_pg is already
  // per game -- handing it 17 would divide the line a second time.
  const defRatings = new Map<string, number>();
  for (const r of rows) {
    const d = r.f.dvp_mult;
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
export function scoreOdds(db: DB, season: number): OddsScored {
  const rows = db.prepare(
    "SELECT model, subject, value FROM scorecard_prediction WHERE season = ? AND kind = 'odds'",
  ).all(season) as { model: string; subject: string; value: number }[];
  const teamsRows = db.prepare(
    "SELECT team_id, made_playoffs, champion, playoff_seed, final_rank, settled FROM fact_team_season WHERE season = ?",
  ).all(season) as { team_id: string; made_playoffs: number | null; champion: number | null; playoff_seed: number | null; final_rank: number | null; settled: number | null }[];

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
  for (const [model, uniform] of [["playoff", field / n], ["title", 1 / n]] as ["playoff" | "title", number][]) {
    // Probabilities are stored in PERCENT, matching `seasonOdds`; the actual is 0 or 1. Dividing at
    // scoring time rather than at snapshot time is deliberate -- the stored row stays the number a
    // human recognises.
    const scored = rows.filter((r) => r.model === model)
      .map((r) => ({ p: Math.min(1, Math.max(0, r.value / 100)), y: outcome.get(String(r.subject))?.[model] ?? null }))
      .filter((r): r is { p: number; y: number } => r.y != null);
    if (!scored.length) continue;
    const uni = scored.map((r) => ({ p: uniform, y: r.y }));
    const b = brier(scored), ub = brier(uni);
    models.push({
      model, n: scored.length,
      brier: b, logLoss: logLoss(scored),
      uniformBrier: ub, uniformLogLoss: logLoss(uni),
      skill: 1 - b / ub,
      reliability: reliability(scored),
    });
  }
  if (!models.length) {
    return empty(`the frozen rows for ${season} join no team in fact_team_season -- the subject is a team id and nothing matched`);
  }
  return { season, teams: n, models, skipped: null };
}

export async function runScorecard(opts: ScorecardOpts): Promise<ScorecardResult> {
  const db = openDb(opts.dbPath);
  const today = opts.today ?? iso(new Date());
  const notes: string[] = [];
  const res: ScorecardResult = {
    season: opts.season, today, imminentWeek: null,
    snapshot: { week: null, taken: 0, skipped: null, byModel: {} },
    challenger: { week: null, taken: 0, skipped: null },
    espn: { attempted: false, ok: false, reason: "not attempted", stored: 0 },
    seasonKind: { taken: 0, skipped: null },
    oddsKind: { taken: 0, skipped: null },
    scored: [], seasonScored: null, oddsScored: null, notes,
  };
  try {
    const sched = opts.sched ?? await loadSchedule([opts.season]);
    const imm = imminentWeek(sched, opts.season, today);
    res.imminentWeek = imm;
    // THE SHIPPED ARTIFACT, by the same constant `lineupRecommend` reads. See SHIPPED_WEEKLY_ARTIFACT.
    const artifact = loadWeeklyArtifact(JSON.parse(readFileSync(opts.artifactPath ?? dataPath(SHIPPED_WEEKLY_ARTIFACT), "utf8")));
    const lineOnly = lineOnlyArtifactFor(db, opts.season);
    // The challenger is OPTIONAL on disk. Absent, the kind is skipped and says so -- it must never
    // fall back to the shipped artifact, which would silently record the floor's own numbers as the
    // challenger's and make the two look identical for the rest of the season.
    let challenger: WeeklyArtifact | null = null;
    let challengerWhy: string | null = null;
    try {
      challenger = loadWeeklyArtifact(JSON.parse(readFileSync(opts.challengerArtifactPath ?? dataPath(CHALLENGER_WEEKLY_ARTIFACT), "utf8")));
    } catch (e) {
      challengerWhy = `no challenger artifact to snapshot (${(e as Error).message})`;
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
          const lg = (db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id?: string } | undefined)?.league_id;
          const f = await fetchEspnWeekly({ season: opts.season, week, leagueId: lg });
          res.espn.ok = f.ok; res.espn.reason = f.reason;
          if (f.ok) res.espn.stored = storeEspnWeekly(db, f.rows, asOf);
        }
        const preds = weeklyPredictions(db, opts.season, week, artifact, lineOnly);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO scorecard_prediction
             (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
           VALUES (@season,@week,'weekly',@model,@subject,@name,@pos,@value,@p10,@p90,@asOf,@now)`,
        );
        const now = nowIso();
        db.transaction(() => {
          for (const [key, v] of preds) {
            for (const m of SCORECARD_MODELS) {
              const p = v.by[m];
              if (!p || !Number.isFinite(p.mean)) continue;
              const info = ins.run({
                season: opts.season, week, model: m, subject: key, name: v.name, pos: v.pos,
                value: p.mean, p10: Number.isFinite(p.p10) ? p.p10 : null,
                p90: Number.isFinite(p.p90) ? p.p90 : null, asOf, now,
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
               (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
             VALUES (@season,@week,'weekly_challenger','two_part',@subject,@name,@pos,@value,@p10,@p90,@asOf,@now)`,
          );
          const nowC = nowIso();
          const rowsC = loadWeeklyRows(db, opts.season, week).filter((r) => r.season_line_pg != null);
          db.transaction(() => {
            for (const p of projectWeekly({ artifact: challenger!, rows: rowsC })) {
              if (!Number.isFinite(p.mean)) continue;
              const info = insC.run({
                season: opts.season, week, subject: p.feat_key, name: p.name, pos: p.pos,
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
             (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
           VALUES (@season,0,'season','season_line',@subject,@name,@pos,@value,NULL,NULL,@asOf,@now)`,
        );
        const now = nowIso();
        const asOf = `${opts.season}-09-01`;
        db.transaction(() => {
          for (const r of seasonRows) {
            // The season total, not the per-game line: what is scored against is points-to-date at
            // season end, and storing the per-game figure would need a games count nobody has yet.
            const info = insS.run({ season: opts.season, subject: r.feat_key, name: r.name, pos: r.pos, value: r.line * r.weeks, asOf, now });
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
          const insO = db.prepare(
            `INSERT OR IGNORE INTO scorecard_prediction
               (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
             VALUES (@season,0,'odds',@model,@subject,@name,NULL,@value,NULL,NULL,@asOf,@now)`,
          );
          const now = nowIso();
          db.transaction(() => {
            for (const r of rows) {
              for (const [model, value] of [["playoff", r.playoffPct], ["title", r.titlePct]] as [string, number][]) {
                if (!Number.isFinite(value)) continue;
                const info = insO.run({ season: opts.season, model, subject: r.subject, name: r.name, value, asOf: today, now });
                if (info.changes) res.oddsKind.taken++;
              }
            }
          })();
          if (!res.oddsKind.taken) {
            notes.push("the odds kind was already snapshotted -- it is written once, so a re-run is a no-op rather than a rewrite.");
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
          "SELECT model, subject, name, pos, value, p10, p90 FROM scorecard_prediction WHERE season = ? AND week = ? AND kind = ?",
        ).all(opts.season, week, kind) as { model: string; subject: string; name: string; pos: string; value: number; p10: number | null; p90: number | null }[];
        if (!frozen.length) {
          if (kind === "weekly") notes.push(`week ${week} is settled but was never snapshotted -- nothing to score`);
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
        const companions = kind === "weekly" ? [] : db.prepare(
          "SELECT model, subject, name, pos, value, p10, p90 FROM scorecard_prediction WHERE season = ? AND week = ? AND kind = 'weekly'",
        ).all(opts.season, week) as typeof frozen;
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
        `INSERT INTO scorecard_result (season, week, kind, model, metric, value, n, scored_at)
         VALUES (@season,@week,@kind,@model,@metric,@value,@n,@now)
         ON CONFLICT(season, week, kind, model, metric) DO UPDATE SET
           value=excluded.value, n=excluded.n, scored_at=excluded.scored_at`,
      );
      const now = nowIso();
      db.transaction(() => {
        for (const r of res.scored) {
          for (const [metric, value] of [["rmse", r.rmse], ["crps", r.crps], ["coverage", r.coverage],
            ["lineup_pts", r.lineupPts], ["lineup_win_share", r.lineupWinShare]] as [string, number][]) {
            if (Number.isFinite(value)) insR.run({ season: opts.season, week: r.week, kind: r.kind, model: r.model, metric, value, n: r.n, now });
          }
        }
      })();

      // ---- the season kind, scored against points to date. ----
      const sp = db.prepare(
        "SELECT subject, value FROM scorecard_prediction WHERE season = ? AND kind = 'season'",
      ).all(opts.season) as { subject: string; value: number }[];
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
      const od = scoreOdds(db, opts.season);
      res.oddsScored = od;
      if (od.skipped) notes.push(`odds accrual: ${od.skipped}`);
      else {
        const insO = db.prepare(
          `INSERT INTO scorecard_result (season, week, kind, model, metric, value, n, scored_at)
           VALUES (@season,0,'odds',@model,@metric,@value,@n,@now)
           ON CONFLICT(season, week, kind, model, metric) DO UPDATE SET
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
              if (Number.isFinite(value)) insO.run({ season: opts.season, model: m.model, metric, value, n: m.n, now: nowO });
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
  out.push(`  weekly kind serves ${SHIPPED_WEEKLY_ARTIFACT} -- the SAME artifact lineupRecommend serves from`);
  if (r.challenger.skipped) out.push(`  challenger:  week ${r.challenger.week ?? "-"}: SKIPPED -- ${r.challenger.skipped}`);
  else out.push(`  challenger:  week ${r.challenger.week}: ${r.challenger.taken} rows from ${CHALLENGER_WEEKLY_ARTIFACT} (kind weekly_challenger, model two_part), series starts week ${CHALLENGER_FIRST_WEEK}`);
  out.push(`  season kind: ${r.seasonKind.taken} rows${r.seasonKind.skipped ? " -- " + r.seasonKind.skipped : ""}`);
  out.push(`  odds kind:   ${r.oddsKind.taken} rows${r.oddsKind.skipped ? " -- " + r.oddsKind.skipped : ""}`);
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
