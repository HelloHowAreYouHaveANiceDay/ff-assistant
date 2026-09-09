/**
 * NESTED-BY-SEASON EVALUATION OF THE WEEKLY MODEL, and a decision metric that is not RMSE.
 *
 * WHY RMSE IS NOT THE ANSWER. Nobody sets a lineup by minimising squared error. A manager picks
 * two of five receivers, and the only thing that matters is whether the two he picks outscore the
 * two the other model would have picked. A model can be meaningfully better on RMSE while choosing
 * the same eleven men every week, and a model can be worse on RMSE while getting the ORDERING right
 * where the roster is actually deciding. So the harness reports both, and the one it treats as the
 * decision is LINEUP REGRET: draw many random legal rosters from the week's pool, set each one's
 * lineup by each model's projection, and score the ACTUAL points of the starters it chose.
 *
 * THE UNIT OF ANALYSIS IS THE SEASON, and the rosters within a season are common random numbers --
 * every model sees the SAME drawn roster, so "share of rosters where our lineup beat the baseline's"
 * is a paired statistic rather than a difference of two independent averages. That is the same
 * discipline CLAUDE.md records for the championship backtest, for the same reason: 300 rosters over
 * 14 seasons is not 4200 independent observations.
 *
 * EVERY MODEL GOES THROUGH THE SAME CODE PATH. The baselines are not reimplemented here:
 *   (a) season line alone   -- the season-line-only artifact, through projectWeekly.
 *   (b) the SHIPPED week()  -- src/projections.ts makeProjections().week(), the function the app
 *                              actually calls, fed a POINT-IN-TIME defence table instead of the
 *                              whole-season data/def-ratings.csv. That substitution is deliberate
 *                              and is the only change: scoring the shipped path with a defence
 *                              rating computed over all of season Y would put week w's own results
 *                              in week w's baseline, and beating a baseline that cheats is not a
 *                              result. The ARITHMETIC is the shipped arithmetic.
 *   (c) trailing-4-week mean -- the folk model, and the one prediction W3 says should lose.
 *   (d) zero                 -- a model that projects 0 for everyone. It exists ONLY as a positive
 *                              control on the lineup metric: a metric that cannot make this lose is
 *                              not measuring lineup quality.
 *
 * THE BASELINES GET A SPREAD, MEASURED THE SAME WAY. CRPS and coverage need a distribution and a
 * point prediction has none. Each baseline's p10/p50/p90 are its point prediction times the
 * empirical quantiles of actual/prediction for that position, measured ON THE TRAINING SEASONS ONLY
 * -- never on the held-out season. Identical procedure for every baseline, so the comparison cannot
 * be an artefact of one of them having been handed a better spread.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/db.js";
import { makeProjections } from "../projections.js";
import { optimalLineup, type RosterPlayer } from "../inseason/lineup.js";
import { mulberry32 } from "../draft/sim.js";
import {
  loadWeeklyArtifact, projectWeekly, seasonLineOnlyArtifact,
  type WeeklyArtifact, type WeeklyProjRow,
} from "./projector.js";
import { loadWeeklyRows, type WeeklyRow } from "./features.js";

export const MODELS = ["weekly", "season_line", "shipped_week", "trailing4", "zero"] as const;
export type ModelName = typeof MODELS[number];
/** The model every gain is quoted AGAINST. It is the thing that ships today. */
export const BASELINE: ModelName = "shipped_week";

const POS_SCORED = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Roster shapes the lineup metric is drawn over. `min` is the positional minimum a legal random
 *  roster must contain; the remainder is filled from RB/WR/TE, which is what a real bench is. */
export const SCENARIOS: { name: string; size: number; slots: string[]; min: Record<string, number> }[] = [
  { name: "standard-15", size: 15, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST"],
    min: { QB: 2, RB: 4, WR: 4, TE: 2, K: 1, DST: 1 } },
  { name: "deep-18", size: 18, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST"],
    min: { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, DST: 1 } },
];

export interface Scored {
  n: number;
  rmse: number;
  crps: number;
  /** Share of actuals inside [p10, p90]. Nominal 0.80, and THIS is the number the gate reads. */
  coverage: number;
  /**
   * The same share over NON-ZERO weeks only. Reported beside `coverage` because the zero atom makes
   * the pooled number hard to read on its own: about 40% of the rostered non-bye weeks scored here
   * land at zero (29.5% of the narrower set the model trains on),
   * the p10 head is clamped at exactly 0 so it can reach the atom, and an actual of 0 is therefore
   * always inside [0, p90]. Those weeks are genuinely covered -- the interval does contain the value
   * -- but they push the pooled figure above nominal for a reason that is a property of the target
   * distribution rather than of the model's calibration. Both are reported; neither replaces the other.
   */
  coverageNonZero: number;
  bias: number;
}

export interface WeeklyEvalResult {
  seasons: number[];
  trainSeasons: number[];
  features: string;
  featuresUsed: string[];
  pendingDataTrack: string[];
  pooled: Record<string, Scored>;
  byPos: Record<string, Record<string, Scored>>;
  byBand: Record<string, Record<string, Scored>>;
  bySeason: Record<string, Record<string, Scored>>;
  lineup: Record<string, Record<string, { meanCaptured: number; winShare: number; drawnRosters: number }>>;
  predictions: { id: string; claim: string; held: boolean | null; evidence: string }[];
  gate: { passed: boolean; reason: string; ships: "weekly" | "season_line_only" };
}

export interface Pred { mean: number; p10: number; p50: number; p90: number }
export interface Scored1 { key: string; pos: string; band: string; season: number; week: number; actual: number; by: Record<string, Pred> }

const pinball = (q: number, y: number, z: number) => (y >= z ? q * (y - z) : (1 - q) * (z - y));

/**
 * CRPS from the three shipped quantile heads, by the quantile decomposition:
 * CRPS = 2 * integral of pinball over q, approximated by 2 * the mean pinball loss at the quantile
 * levels the model actually publishes. It is an approximation, it is the SAME approximation for
 * every model here, and it is the only one available for a model whose distribution is three numbers.
 */
const crps1 = (y: number, p: Pred) =>
  2 * (pinball(0.10, y, p.p10) + pinball(0.50, y, p.p50) + pinball(0.90, y, p.p90)) / 3;

export function score(rows: { actual: number; p: Pred }[]): Scored {
  if (!rows.length) return { n: 0, rmse: NaN, crps: NaN, coverage: NaN, coverageNonZero: NaN, bias: NaN };
  let se = 0, cr = 0, cov = 0, bi = 0, nz = 0, covNz = 0;
  for (const r of rows) {
    se += (r.actual - r.p.mean) ** 2;
    cr += crps1(r.actual, r.p);
    const inside = r.actual >= r.p.p10 && r.actual <= r.p.p90;
    if (inside) cov++;
    if (r.actual > 0) { nz++; if (inside) covNz++; }
    bi += r.p.mean - r.actual;
  }
  const n = rows.length;
  return { n, rmse: Math.sqrt(se / n), crps: cr / n, coverage: cov / n, coverageNonZero: nz ? covNz / nz : NaN, bias: bi / n };
}

/** Preseason-line rank band, within position and season. Point-in-time on purpose: banding by the
 *  player's FINISH would stratify the report by the outcome, which makes every band's conclusion a
 *  statement about hindsight. */
function bandOf(rank: number): string {
  if (rank <= 12) return "1-12";
  if (rank <= 24) return "13-24";
  if (rank <= 48) return "25-48";
  return "49+";
}

interface SeasonRows { rows: WeeklyRow[]; actual: Map<string, number>; bye: Set<string>; band: Map<string, string> }

/** One season's feature rows plus the actuals, keyed (feat_key|week). A bye row is EXCLUDED from
 *  everything: every model knows about a bye equally, from the schedule, so including them would
 *  inflate every model's apparent skill with the same free lunch. */
function loadSeason(db: DB, season: number): SeasonRows {
  const rows = loadWeeklyRows(db, season).filter((r) => POS_SCORED.includes(r.pos));
  const raw = db.prepare(
    "SELECT feat_key, week, pts, is_bye, season_line_pg, pos FROM feat_player_week_model WHERE season = ?",
  ).all(season) as { feat_key: string; week: number; pts: number | null; is_bye: number | null; season_line_pg: number | null; pos: string }[];
  const actual = new Map<string, number>();
  const bye = new Set<string>();
  const lineOf = new Map<string, { pos: string; line: number }>();
  for (const r of raw) {
    const k = `${r.feat_key}|${r.week}`;
    if (r.is_bye) { bye.add(k); continue; }
    // A week a rostered player did not play is a REAL ZERO for a lineup, not a missing observation.
    // Dropping it would delete exactly the weeks a good weekly model is supposed to see coming.
    actual.set(k, r.pts ?? 0);
    if (r.season_line_pg != null && !lineOf.has(r.feat_key)) lineOf.set(r.feat_key, { pos: r.pos, line: r.season_line_pg });
  }
  const byPos = new Map<string, { key: string; line: number }[]>();
  for (const [key, v] of lineOf) (byPos.get(v.pos) ?? byPos.set(v.pos, []).get(v.pos)!).push({ key, line: v.line });
  const band = new Map<string, string>();
  for (const list of byPos.values()) {
    list.sort((a, b) => b.line - a.line);
    list.forEach((p, i) => band.set(p.key, bandOf(i + 1)));
  }
  return { rows: rows.filter((r) => !bye.has(`${r.feat_key}|${r.week}`)), actual, bye, band };
}

/** The point predictions of every model, for one season. Distributions are added afterwards. */
function pointPredictions(season: SeasonRows, artifact: WeeklyArtifact, lineOnly: WeeklyArtifact): Map<string, Record<ModelName, number>> {
  const out = new Map<string, Record<ModelName, number>>();
  const put = (k: string, m: ModelName, v: number) => {
    const cur = out.get(k) ?? out.set(k, {} as Record<ModelName, number>).get(k)!;
    cur[m] = v;
  };
  const proj = (a: WeeklyArtifact): WeeklyProjRow[] => projectWeekly({ artifact: a, rows: season.rows });
  for (const r of proj(artifact)) put(`${r.feat_key}|${r.week}`, "weekly", r.mean);
  for (const r of proj(lineOnly)) put(`${r.feat_key}|${r.week}`, "season_line", r.mean);

  // (b) THE SHIPPED PATH, called as the app calls it. `seasonPoints` is keyed by feat_key rather
  // than display name -- makeProjections keys by whatever string it is handed, and a display name
  // collides across positions, which would silently give two men one projection.
  const byWeek = new Map<number, WeeklyRow[]>();
  for (const r of season.rows) (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)!).push(r);
  for (const [week, rows] of byWeek) {
    const defRatings = new Map<string, number>();
    for (const r of rows) {
      const d = r.f.dvp_mult;
      if (r.opponent && d != null && Number.isFinite(d)) defRatings.set(`${r.opponent}|${r.pos}`, d);
    }
    // gamesPerSeason 1: season_line_pg is ALREADY per game, and makeProjections divides by games.
    // Handing it 17 here would divide the line a second time -- the exact double-application the
    // season projector's multiplicative stage exists to prevent, one horizon down.
    const p = makeProjections({
      seasonPoints: rows.filter((r) => r.season_line_pg != null)
        .map((r) => ({ name: r.feat_key, pos: r.pos, season: r.season_line_pg! })),
      defRatings, gamesPerSeason: 1,
    });
    for (const r of rows) {
      const k = `${r.feat_key}|${week}`;
      if (r.season_line_pg != null) put(k, "shipped_week", p.week(r.feat_key, r.pos, r.opponent ?? undefined));
      // (c) trailing-4: the folk model. Falls back to points-to-date and then to the season line,
      // because in week 1 it HAS no trailing window and pretending it projects 0 would beat it by
      // handing it a straw man.
      const t4 = r.f.t4_mean ?? r.f.td_ppg ?? r.season_line_pg;
      if (t4 != null) put(k, "trailing4", t4);
      put(k, "zero", 0);
    }
  }
  return out;
}

/** Empirical quantiles of actual/prediction, per position, measured on the TRAINING seasons only. */
type SpreadTable = Record<string, Record<string, { p10: number; p50: number; p90: number }>>;

function quantile(a: number[], q: number): number {
  if (!a.length) return 1;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

function measureSpread(seasons: SeasonRows[], preds: Map<string, Record<ModelName, number>>[]): SpreadTable {
  const acc: Record<string, Record<string, number[]>> = {};
  for (let i = 0; i < seasons.length; i++) {
    const posOf = new Map(seasons[i].rows.map((r) => [`${r.feat_key}|${r.week}`, r.pos]));
    for (const [k, byModel] of preds[i]) {
      const y = seasons[i].actual.get(k);
      const pos = posOf.get(k);
      if (y == null || !pos) continue;
      for (const m of MODELS) {
        const p = byModel[m];
        if (p == null || !(p > 0)) continue;
        ((acc[m] ??= {})[pos] ??= []).push(y / p);
      }
    }
  }
  const out: SpreadTable = {};
  for (const [m, byPos] of Object.entries(acc)) {
    out[m] = {};
    for (const [pos, v] of Object.entries(byPos)) {
      out[m][pos] = { p10: quantile(v, 0.10), p50: quantile(v, 0.50), p90: quantile(v, 0.90) };
    }
  }
  return out;
}

/** Attach a distribution to every model's point prediction. The TRAINED model brings its own from
 *  the artifact and is NOT rescaled; every baseline is scaled by the training-season table. */
function withSpread(
  season: SeasonRows, artifact: WeeklyArtifact, lineOnly: WeeklyArtifact,
  points: Map<string, Record<ModelName, number>>, spread: SpreadTable,
): Scored1[] {
  const trained = new Map<string, Pred>();
  for (const r of projectWeekly({ artifact, rows: season.rows })) {
    trained.set(`${r.feat_key}|${r.week}`, { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  const lineQ = new Map<string, Pred>();
  for (const r of projectWeekly({ artifact: lineOnly, rows: season.rows })) {
    lineQ.set(`${r.feat_key}|${r.week}`, { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  const out: Scored1[] = [];
  for (const r of season.rows) {
    const k = `${r.feat_key}|${r.week}`;
    const y = season.actual.get(k);
    const pt = points.get(k);
    if (y == null || !pt) continue;
    const by: Record<string, Pred> = {};
    for (const m of MODELS) {
      const v = pt[m];
      if (v == null || !Number.isFinite(v)) continue;
      if (m === "weekly") { const p = trained.get(k); if (p) by[m] = p; continue; }
      if (m === "season_line") { const p = lineQ.get(k); if (p) by[m] = p; continue; }
      const q = spread[m]?.[r.pos] ?? { p10: 0.3, p50: 0.9, p90: 1.9 };
      by[m] = { mean: v, p10: v * q.p10, p50: v * q.p50, p90: v * q.p90 };
    }
    if (!by.weekly || !by[BASELINE]) continue;   // score only rows every model can speak to
    out.push({ key: r.feat_key, pos: r.pos, band: season.band.get(r.feat_key) ?? "49+", season: r.season, week: r.week, actual: y, by });
  }
  return out;
}

/**
 * THE DECISION METRIC. Draw random legal rosters, set each one's lineup with each model, score the
 * ACTUAL points of the men it started.
 *
 * Common random numbers: every model sees the same drawn roster, so `winShare` is a paired
 * statistic. The RNG is seeded from (season, week, scenario, draw) so a rerun reproduces every
 * roster exactly -- a lineup metric that resamples between two runs cannot tell a real gain from
 * a re-draw.
 */
export function lineupRegret(
  scored: Scored1[], rosters: number, opts: { models?: string[]; baseline?: string } = {},
): Record<string, Record<string, { meanCaptured: number; winShare: number; drawnRosters: number }>> {
  // The model list is DERIVED FROM THE DATA, not read off the MODELS constant. A metric hardcoded to
  // the production model names is one a test cannot exercise with a control model, and a metric no
  // control can be run through is one whose verdict nobody has ever seen be wrong.
  const models = opts.models ?? [...new Set(scored.flatMap((s) => Object.keys(s.by)))].sort();
  const baseline = opts.baseline ?? (models.includes(BASELINE) ? BASELINE : models[0]);
  const byWeek = new Map<string, Scored1[]>();
  for (const s of scored) (byWeek.get(`${s.season}|${s.week}`) ?? byWeek.set(`${s.season}|${s.week}`, []).get(`${s.season}|${s.week}`)!).push(s);
  const out: Record<string, Record<string, { meanCaptured: number; winShare: number; drawnRosters: number }>> = {};

  for (const sc of SCENARIOS) {
    const totals: Record<string, number> = {};
    const wins: Record<string, number> = {};
    let drawn = 0;
    for (const [wk, pool] of byWeek) {
      const byPos = new Map<string, Scored1[]>();
      for (const p of pool) (byPos.get(p.pos) ?? byPos.set(p.pos, []).get(p.pos)!).push(p);
      const enough = Object.entries(sc.min).every(([p, n]) => (byPos.get(p)?.length ?? 0) >= n);
      if (!enough) continue;
      const [sYr, sWk] = wk.split("|").map(Number);
      for (let d = 0; d < rosters; d++) {
        const rng = mulberry32(sYr * 100003 + sWk * 1009 + d * 31 + sc.size);
        const roster: Scored1[] = [];
        const taken = new Set<Scored1>();
        const drawFrom = (pos: string, n: number) => {
          const list = byPos.get(pos) ?? [];
          for (let i = 0; i < n && taken.size < list.length + roster.length; i++) {
            let pick: Scored1 | undefined;
            for (let tries = 0; tries < 50 && !pick; tries++) {
              const c = list[Math.floor(rng() * list.length)];
              if (c && !taken.has(c)) pick = c;
            }
            if (pick) { taken.add(pick); roster.push(pick); }
          }
        };
        for (const [pos, n] of Object.entries(sc.min)) drawFrom(pos, n);
        const filler = ["RB", "WR", "TE"];
        while (roster.length < sc.size) {
          const before = roster.length;
          drawFrom(filler[Math.floor(rng() * filler.length)], 1);
          if (roster.length === before) break;         // pool exhausted; a short roster is legal
        }
        if (roster.length < sc.slots.length) continue;
        drawn++;
        const actualOf = new Map(roster.map((r) => [r.key + "|" + r.week, r.actual]));
        const captured: Record<string, number> = {};
        for (const m of models) {
          const players: RosterPlayer[] = roster
            .filter((r) => r.by[m])
            .map((r) => ({ name: r.key + "|" + r.week, pos: r.pos, proj: r.by[m].mean, available: true }));
          if (players.length < sc.slots.length) continue;
          const res = optimalLineup(players, sc.slots);
          let pts = 0;
          for (const st of res.starters) pts += actualOf.get(st.name) ?? 0;
          captured[m] = pts;
          totals[m] = (totals[m] ?? 0) + pts;
        }
        const base = captured[baseline];
        if (base != null) for (const m of models) if (captured[m] != null && captured[m] > base) wins[m] = (wins[m] ?? 0) + 1;
      }
    }
    out[sc.name] = {};
    for (const m of models) {
      out[sc.name][m] = {
        meanCaptured: drawn ? (totals[m] ?? 0) / drawn : NaN,
        winShare: drawn ? (wins[m] ?? 0) / drawn : NaN,
        drawnRosters: drawn,
      };
    }
  }
  return out;
}

export interface EvalOpts {
  dbPath?: string;
  seasons: number[];
  trainSeasons: number[];
  rosters?: number;
  features?: string;
  json?: boolean;
  keepArtifacts?: string;
}

/** Train one holdout artifact by shelling out to the Python trainer -- the same binary the shipped
 *  artifact came from, so the thing evaluated is the thing that would ship. */
function trainHoldout(dbPath: string, trainSeasons: number[], holdout: number, features: string, out: string): WeeklyArtifact | null {
  const lo = Math.min(...trainSeasons), hi = Math.max(...trainSeasons);
  try {
    execFileSync("uv", [
      "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_weekly.py",
      "--db", dbPath, "--seasons", `${lo}-${hi}`, "--holdout-season", String(holdout),
      "--features", features, "--out", out, "--quiet",
    ], { stdio: "pipe" });
  } catch (e) {
    throw new Error(`train_weekly failed for holdout ${holdout}: ${e instanceof Error ? e.message : e}`);
  }
  return existsSync(out) ? loadWeeklyArtifact(JSON.parse(readFileSync(out, "utf8"))) : null;
}

function lineOnlyFor(db: DB, trainSeasons: number[], holdout: number): WeeklyArtifact {
  // Ratio quantiles measured on the TRAINING seasons only -- never on the holdout, and never on the
  // season being scored. Measured here rather than shelled out because it is one SQL aggregate and
  // a second trainer invocation per fold would double the harness's runtime for nothing.
  const ins = trainSeasons.filter((s) => s !== holdout);
  // COALESCE(pts, 0) over non-bye weeks: the SAME population the trainer fits and this harness
  // scores. Measuring the floor's spread on appearances only would give it a systematically
  // narrower, higher band than the model it is the baseline for, which is a difference in the
  // measurement rather than in the models.
  const rows = db.prepare(
    `SELECT pos, COALESCE(pts, 0.0) / season_line_pg AS r FROM feat_player_week_model
      WHERE COALESCE(is_bye, 0) = 0 AND season_line_pg > 0 AND season IN (${ins.map(() => "?").join(",")})`,
  ).all(...ins) as { pos: string; r: number }[];
  const byPos: Record<string, number[]> = {};
  for (const r of rows) (byPos[r.pos] ??= []).push(r.r);
  const q: Record<string, { p10: number; p50: number; p90: number }> = {};
  for (const [pos, v] of Object.entries(byPos)) {
    q[pos] = { p10: quantile(v, 0.10), p50: quantile(v, 0.50), p90: quantile(v, 0.90) };
  }
  return loadWeeklyArtifact(seasonLineOnlyArtifact({ positions: Object.keys(q), seasons: ins, quantiles: q }));
}

export async function evaluateWeekly(opts: EvalOpts): Promise<WeeklyEvalResult> {
  const dbPath = opts.dbPath ?? "data/ff.db";
  const rosters = opts.rosters ?? 300;
  const features = opts.features ?? "all";
  const dir = opts.keepArtifacts ?? mkdtempSync(join(tmpdir(), "ff-weekly-eval-"));
  const db = openDb(dbPath);
  const all: Scored1[] = [];
  let featuresUsed: string[] = [];
  try {
    // The spread table for the baselines is measured on the TRAINING seasons, once, with the
    // FULL-DATA artifact -- it is a property of each baseline's calibration, not of a fold.
    const fullArt = loadWeeklyArtifact(JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")));
    featuresUsed = fullArt.features.map((f) => f.name);
    const trainOnly = opts.trainSeasons.filter((s) => !opts.seasons.includes(s));
    const spreadSeasons = (trainOnly.length ? trainOnly : opts.trainSeasons.slice(0, 2)).map((s) => loadSeason(db, s));
    const spreadLine = lineOnlyFor(db, opts.trainSeasons, -1);
    const spread = measureSpread(spreadSeasons, spreadSeasons.map((s) => pointPredictions(s, fullArt, spreadLine)));

    for (const yr of opts.seasons) {
      const art = trainHoldout(dbPath, opts.trainSeasons, yr, features, join(dir, `weekly-${yr}.json`));
      if (!art) throw new Error(`no artifact produced for holdout ${yr}`);
      // The population is a CONTRACT and this is where it is checked. This harness scores every
      // non-bye week with a did-not-play week as a zero; an artifact fitted on appearances only is
      // answering a different question, and the gap would show up as a model defect rather than as
      // the mismatch it is.
      if (art.population !== "rostered") {
        throw new Error(
          `artifact for holdout ${yr} was fitted on population "${art.population}" but this harness ` +
          "scores every non-bye week with a did-not-play week as a zero. Retrain with " +
          "--population rostered, or the bias and coverage below measure the mismatch, not the model.");
      }
      if (art.seasons.includes(yr)) {
        throw new Error(`artifact for holdout ${yr} lists ${yr} among its training seasons -- the ` +
          "holdout was not removed, and every number below would be in-sample");
      }
      const lineOnly = lineOnlyFor(db, opts.trainSeasons, yr);
      const s = loadSeason(db, yr);
      if (!s.rows.length) continue;
      all.push(...withSpread(s, art, lineOnly, pointPredictions(s, art, lineOnly), spread));
    }
  } finally {
    db.close();
    if (!opts.keepArtifacts) rmSync(dir, { recursive: true, force: true });
  }

  const cut = (rows: Scored1[]) => Object.fromEntries(MODELS.map((m) =>
    [m, score(rows.filter((r) => r.by[m]).map((r) => ({ actual: r.actual, p: r.by[m] })))]));

  const pooled = cut(all);
  const byPos: Record<string, Record<string, Scored>> = {};
  for (const p of POS_SCORED) { const r = all.filter((x) => x.pos === p); if (r.length) byPos[p] = cut(r); }
  const byBand: Record<string, Record<string, Scored>> = {};
  for (const b of ["1-12", "13-24", "25-48", "49+"]) { const r = all.filter((x) => x.band === b); if (r.length) byBand[b] = cut(r); }
  const bySeason: Record<string, Record<string, Scored>> = {};
  for (const yr of opts.seasons) { const r = all.filter((x) => x.season === yr); if (r.length) bySeason[String(yr)] = cut(r); }
  const lineup = lineupRegret(all, rosters);

  // ---- PRE-REGISTERED PREDICTIONS. Recorded as held or failed, not quietly re-stated. ----
  const w1Fails = POS_SCORED.filter((p) => byPos[p] && !(byPos[p].weekly.crps < byPos[p][BASELINE].crps));
  const std = lineup["standard-15"];
  const gain = std ? std.weekly.meanCaptured - std[BASELINE].meanCaptured : NaN;
  const predictions = [
    {
      id: "W1",
      claim: "with the columns available now, the trained weekly model beats the shipped week() baseline on CRPS in EVERY position",
      held: w1Fails.length === 0,
      evidence: w1Fails.length === 0
        ? "beaten in all " + Object.keys(byPos).length + " positions"
        : "not beaten at " + w1Fails.map((p) => `${p} (${byPos[p].weekly.crps.toFixed(3)} vs ${byPos[p][BASELINE].crps.toFixed(3)})`).join(", "),
    },
    {
      id: "W2",
      claim: "its lineup-regret gain over the shipped baseline is under 2 points per week",
      held: Number.isFinite(gain) ? gain < 2 : null,
      evidence: Number.isFinite(gain) ? `${gain.toFixed(2)} points per lineup (standard-15)` : "no rosters drawn",
    },
    {
      id: "W3",
      claim: "the trailing-4-week mean is WORSE than the season line alone on RMSE",
      held: pooled.trailing4.n && pooled.season_line.n ? pooled.trailing4.rmse > pooled.season_line.rmse : null,
      evidence: `trailing4 ${pooled.trailing4.rmse.toFixed(3)} vs season_line ${pooled.season_line.rmse.toFixed(3)}`,
    },
  ];

  // ---- THE GATE. Beat baseline (b) on pooled CRPS, and coverage in [0.75, 0.85]. ----
  const beat = pooled.weekly.crps < pooled[BASELINE].crps;
  const covOk = pooled.weekly.coverage >= 0.75 && pooled.weekly.coverage <= 0.85;
  // The gate is the PRE-REGISTERED one and it is not moved to fit the result. Where it fails on
  // coverage alone, the atom-free figure is reported beside it as an explicit POST HOC observation,
  // labelled as such -- it does not change what ships. Quietly re-specifying a gate the moment it
  // bites is how a harness stops being able to tell anyone anything.
  const covNzOk = pooled.weekly.coverageNonZero >= 0.75 && pooled.weekly.coverageNonZero <= 0.85;
  const postHoc = !covOk && covNzOk
    ? ` POST HOC, NOT PART OF THE GATE: over non-zero weeks the same statistic reads ` +
      `${pooled.weekly.coverageNonZero.toFixed(3)}, against ${pooled[BASELINE].coverageNonZero.toFixed(3)} ` +
      `for ${BASELINE}. The pooled figure is inflated by the zero atom sitting on a p10 of exactly 0 ` +
      "-- those weeks really are inside the interval. The gate was specified without that in mind and " +
      "is left exactly as specified."
    : "";
  const gate = {
    passed: beat && covOk,
    ships: (beat && covOk ? "weekly" : "season_line_only") as "weekly" | "season_line_only",
    reason: (beat && covOk
      ? `pooled CRPS ${pooled.weekly.crps.toFixed(4)} < ${pooled[BASELINE].crps.toFixed(4)} and coverage ${pooled.weekly.coverage.toFixed(3)} in [0.75, 0.85]`
      : [
        beat ? null : `pooled CRPS ${pooled.weekly.crps.toFixed(4)} does not beat ${BASELINE}'s ${pooled[BASELINE].crps.toFixed(4)}`,
        covOk ? null : `coverage ${pooled.weekly.coverage.toFixed(3)} is outside [0.75, 0.85]`,
      ].filter(Boolean).join("; ")) + postHoc,
  };

  return {
    seasons: opts.seasons, trainSeasons: opts.trainSeasons, features,
    featuresUsed,
    pendingDataTrack: ["injury_status_friday", "depth_chart_rank", "teammates_out",
      "prior_snap_share", "prior_route_share", "vegas_implied_team_total"],
    pooled, byPos, byBand, bySeason, lineup, predictions, gate,
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");

function table(title: string, rows: Record<string, Record<string, Scored>>): string {
  const out = [title, "  " + pad("group", 10) + pad("model", 14) + "      n     RMSE     CRPS    cover  cov(>0)     bias"];
  for (const [g, byModel] of Object.entries(rows)) {
    for (const m of MODELS) {
      const s = byModel[m]; if (!s || !s.n) continue;
      out.push("  " + pad(g, 10) + pad(m, 14) + String(s.n).padStart(7) + num(s.rmse).padStart(9) +
        num(s.crps).padStart(9) + num(s.coverage).padStart(9) + num(s.coverageNonZero).padStart(9) +
        num(s.bias).padStart(9));
    }
  }
  return out.join("\n");
}

export function formatWeeklyReport(r: WeeklyEvalResult): string {
  const out: string[] = [];
  out.push(`weekly evaluation -- holdout seasons ${r.seasons[0]}-${r.seasons[r.seasons.length - 1]}, ` +
    `trained on ${r.trainSeasons[0]}-${r.trainSeasons[r.trainSeasons.length - 1]} minus the holdout`);
  out.push(`features measured with: ${r.featuresUsed.join(", ")}`);
  out.push(`waiting on the data track: ${r.pendingDataTrack.join(", ")}`);
  out.push("");
  out.push(table("POOLED", { all: r.pooled }));
  out.push("");
  out.push(table("BY POSITION", r.byPos));
  out.push("");
  out.push(table("BY PRESEASON-LINE RANK BAND", r.byBand));
  out.push("");
  out.push("LINEUP REGRET (actual points of the starters each model chose; winShare is paired vs " + BASELINE + ")");
  out.push("  " + pad("scenario", 14) + pad("model", 14) + "  captured   winShare   rosters");
  for (const [sc, byModel] of Object.entries(r.lineup)) {
    for (const m of MODELS) {
      const s = byModel[m]; if (!s || !Number.isFinite(s.meanCaptured)) continue;
      out.push("  " + pad(sc, 14) + pad(m, 14) + num(s.meanCaptured, 2).padStart(10) +
        num(s.winShare, 3).padStart(11) + String(s.drawnRosters).padStart(10));
    }
  }
  out.push("");
  out.push("PRE-REGISTERED PREDICTIONS");
  for (const p of r.predictions) {
    out.push(`  ${p.id}  ${p.held === null ? "UNMEASURED" : p.held ? "HELD  " : "FAILED"}  ${p.claim}`);
    out.push(`        ${p.evidence}`);
  }
  out.push("");
  out.push(`GATE: ${r.gate.passed ? "PASSED" : "FAILED"} -- ships the ${r.gate.ships} artifact. ${r.gate.reason}`);
  return out.join("\n");
}
