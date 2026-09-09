/**
 * NESTED-BY-SEASON EVALUATION OF THE PER-POSITION STREAMING MODELS, and a decision metric that is
 * neither RMSE nor a lineup: STREAMING REGRET.
 *
 * WHY A THIRD METRIC. `ff evaluate-weekly`'s decision metric is lineup regret -- draw a legal roster,
 * set it by each model, score the starters. That is the right question for a roster you already own.
 * It is the WRONG question for streaming, because the men a streaming decision is about are by
 * definition NOT on any roster: the whole act is "who, of the people nobody has, do I start at
 * quarterback / kicker / defence this week". A model can be better at ordering a roster and no better
 * at picking out of a pool, and lineup regret cannot tell those apart -- the pool players are barely
 * in the drawn rosters at all.
 *
 * So the metric is: for each (season, week, position) take the FREE-AGENT POOL, ask each model for
 * its single best pick, and score the points that man ACTUALLY scored. Mean points per week, and the
 * share of weeks the model's pick strictly beat the pick you would have made by reading the preseason
 * board. That is the decision, in the units of the decision.
 *
 * THE POOL IS AN APPROXIMATION AND IT IS STATED, NOT BURIED. A real free-agent pool is what sixteen
 * managers happened to leave, which this store only knows for the live season. So the pool is
 * approximated as everyone outside the top N at the position by PRESEASON SEASON LINE, with N =
 * 16 x (starters + typical bench depth) at that position -- see POOL_DEPTH. Two properties make the
 * approximation usable rather than convenient: it is POINT-IN-TIME (the preseason line, frozen in
 * August, not the finish -- ranking by the outcome would make every pick a statement about
 * hindsight), and it is IDENTICAL for every model, so it cannot manufacture a difference between
 * them. What it gets wrong is the direction of that error: a real pool is churnier than this one, so
 * a real streaming decision has slightly better options available than this metric offers. It
 * understates every model equally.
 *
 * If Track B's `fact_fa_pool_week` exists in the store, it is PREFERRED and the report says so --
 * that table is the real thing and this is the stand-in for it.
 *
 * EVERY MODEL GOES THROUGH THE SAME CODE PATH, and the control is the point:
 *   streaming        the artifact from tools/train_streaming.py with all twelve opponent columns.
 *   two_part         THE SAME TRAINER with `--features weekly-only`, i.e. the same positions, the
 *                    same two-part structure, the same folds, and the twelve columns REMOVED. This
 *                    is what P41 is measured against, and it is the only honest control: comparing
 *                    against the SHIPPED weekly artifact would confound the opponent block with
 *                    "K and DST stopped being intercepts", which is a different change.
 *   shipped_week     src/projections.ts week(), fed a point-in-time defence table. The baseline the
 *                    gate's clause (a) is quoted against, exactly as in evaluate.ts.
 *   season_line      the preseason line per game -- the floor, and the pick a manager makes by
 *                    reading the board.
 *   trailing4        the folk model: whoever has been hot.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/db.js";
import { makeProjections } from "../projections.js";
import { loadWeeklyArtifact, projectWeekly, type WeeklyArtifact } from "./projector.js";
import { loadWeeklyRows, type WeeklyRow } from "./features.js";
import { STREAM_FIELD_NAMES, presentStreamFields } from "./streamingFeatures.js";
import {
  score, GATE_COV_POS, GATE_ZERO_TOL, type Pred, type Scored,
} from "./evaluate.js";

export const STREAM_MODELS = ["streaming", "two_part", "shipped_week", "season_line", "trailing4"] as const;
export type StreamModel = typeof STREAM_MODELS[number];
/** The model clause (a) is quoted against. The thing that ships today. */
export const STREAM_BASELINE: StreamModel = "shipped_week";
/** The control the opponent block's own contribution is measured against. */
export const STREAM_CONTROL: StreamModel = "two_part";

export const STREAM_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * HOW DEEP A 16-TEAM LEAGUE ROSTERS EACH POSITION, and therefore where the pool starts.
 *
 * Derived from this league's own shape rather than picked: 16 teams, starting slots
 * QB/RB/RB/WR/WR/TE/FLEX/K/DST with four bench spots that in practice go to running backs, receivers
 * and the occasional second tight end or quarterback. So a team carries about 1.5 quarterbacks, five
 * backs, five receivers, two tight ends, one kicker and one defence. Multiplying by sixteen gives the
 * rank past which a man is, in an average week, available.
 *
 * These are ROUND NUMBERS ON PURPOSE and the report says so. A tighter number would be false
 * precision -- what a league actually rosters moves week to week -- and the metric is not sensitive
 * to it in the way it looks: every model draws from the SAME pool, so the boundary decides how HARD
 * the problem is, not who wins it. `--pool-depth` scales all six at once so the sensitivity can be
 * checked rather than assumed.
 */
export const POOL_DEPTH: Record<string, number> = { QB: 24, RB: 80, WR: 80, TE: 32, K: 16, DST: 16 };

export interface StreamPick {
  model: string;
  /** Mean ACTUAL points of the man this model picked out of the pool, over the scored weeks. */
  meanActual: number;
  /** Share of weeks this model's pick strictly beat the season-line pick's actual points. */
  winShareVsLine: number;
  /** Share of weeks it strictly beat the CONTROL model's pick -- what the opponent block bought. */
  winShareVsControl: number;
  weeks: number;
}

export interface StreamGateClause { id: "a" | "b" | "c"; claim: string; passed: boolean; evidence: string }
export interface StreamGate {
  pos: string;
  passed: boolean;
  ships: "streaming" | "previous";
  clauses: StreamGateClause[];
}

export interface StreamingEvalResult {
  seasons: number[];
  trainSeasons: number[];
  poolSource: "fact_fa_pool_week" | "season-line approximation";
  poolDepth: Record<string, number>;
  streamColumns: string[];
  pooled: Record<string, Scored>;
  byPos: Record<string, Record<string, Scored>>;
  regret: Record<string, StreamPick[]>;
  predictions: { id: string; claim: string; held: boolean | null; evidence: string }[];
  gates: StreamGate[];
  ships: string[];
}

// --------------------------------------------------------------------------------------------
// FOLD TRAINING
// --------------------------------------------------------------------------------------------

/** Train one holdout artifact by shelling out to the Python trainer -- the same binary a shipped
 *  artifact would come from, so the thing evaluated is the thing that would ship. */
function trainFold(
  dbPath: string, trainSeasons: number[], holdout: number, features: string, out: string,
): WeeklyArtifact {
  const lo = Math.min(...trainSeasons), hi = Math.max(...trainSeasons);
  try {
    execFileSync("uv", [
      "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_streaming.py",
      "--db", dbPath, "--seasons", `${lo}-${hi}`, "--holdout-season", String(holdout),
      "--features", features, "--out", out, "--quiet",
    ], { stdio: "pipe" });
  } catch (e) {
    throw new Error(`train_streaming failed for holdout ${holdout} (${features}): ${e instanceof Error ? e.message : e}`);
  }
  if (!existsSync(out)) throw new Error(`no artifact produced for holdout ${holdout} (${features})`);
  const a = loadWeeklyArtifact(JSON.parse(readFileSync(out, "utf8")));
  // THE POPULATION IS A CONTRACT AND THIS IS WHERE IT IS CHECKED. This harness scores every non-bye
  // week with a did-not-play week as a zero; an artifact fitted on appearances only answers a
  // different question and the gap would read as a model defect rather than as the mismatch it is.
  if (a.population !== "rostered") {
    throw new Error(`holdout ${holdout} artifact was fitted on population "${a.population}"`);
  }
  if (a.seasons.includes(holdout)) {
    throw new Error(`holdout ${holdout} is among the artifact's training seasons -- the holdout was ` +
      "not removed, and every number below would be in-sample");
  }
  return a;
}

// --------------------------------------------------------------------------------------------
// ONE SEASON'S ROWS AND ACTUALS
// --------------------------------------------------------------------------------------------

interface SeasonRows {
  rows: WeeklyRow[];
  actual: Map<string, number>;
  /** feat_key -> that player's rank within his position by PRESEASON line, 1 = best. */
  rank: Map<string, number>;
}

function loadSeason(db: DB, season: number): SeasonRows {
  const rows = loadWeeklyRows(db, season).filter((r) => STREAM_POS.includes(r.pos));
  const raw = db.prepare(
    "SELECT feat_key, week, pts, is_bye, season_line_pg, pos FROM feat_player_week_model WHERE season = ?",
  ).all(season) as { feat_key: string; week: number; pts: number | null; is_bye: number | null; season_line_pg: number | null; pos: string }[];
  const actual = new Map<string, number>();
  const bye = new Set<string>();
  const lineOf = new Map<string, { pos: string; line: number }>();
  for (const r of raw) {
    const k = `${r.feat_key}|${r.week}`;
    if (r.is_bye) { bye.add(k); continue; }
    // A week a rostered player did not play is a REAL ZERO for a manager who started him, not a
    // missing observation -- and for a streaming pick it is the whole downside of the decision.
    actual.set(k, r.pts ?? 0);
    if (r.season_line_pg != null && !lineOf.has(r.feat_key)) lineOf.set(r.feat_key, { pos: r.pos, line: r.season_line_pg });
  }
  const byPos = new Map<string, { key: string; line: number }[]>();
  for (const [key, v] of lineOf) (byPos.get(v.pos) ?? byPos.set(v.pos, []).get(v.pos)!).push({ key, line: v.line });
  const rank = new Map<string, number>();
  for (const list of byPos.values()) {
    list.sort((a, b) => b.line - a.line);
    list.forEach((p, i) => rank.set(p.key, i + 1));
  }
  return { rows: rows.filter((r) => !bye.has(`${r.feat_key}|${r.week}`)), actual, rank };
}

/** Empirical quantiles of actual/prediction, per position, measured on the TRAINING seasons only.
 *  A point forecast has no distribution and CRPS needs one; every baseline gets the same treatment,
 *  so the comparison cannot be an artefact of one having been handed a better spread. */
type SpreadTable = Record<string, Record<string, { p10: number; p50: number; p90: number }>>;

function quantile(a: number[], q: number): number {
  if (!a.length) return 1;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** The shipped `week()` path and the two point baselines, for one season. Keyed (feat_key|week). */
function pointBaselines(season: SeasonRows): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const put = (k: string, m: string, v: number) => {
    (out.get(k) ?? out.set(k, {}).get(k)!)[m] = v;
  };
  const byWeek = new Map<number, WeeklyRow[]>();
  for (const r of season.rows) (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)!).push(r);
  for (const [week, rows] of byWeek) {
    const defRatings = new Map<string, number>();
    for (const r of rows) {
      const d = r.f.dvp_mult;
      if (r.opponent && d != null && Number.isFinite(d)) defRatings.set(`${r.opponent}|${r.pos}`, d);
    }
    // gamesPerSeason 1: season_line_pg is ALREADY per game and makeProjections divides by games.
    const p = makeProjections({
      seasonPoints: rows.filter((r) => r.season_line_pg != null)
        .map((r) => ({ name: r.feat_key, pos: r.pos, season: r.season_line_pg! })),
      defRatings, gamesPerSeason: 1,
    });
    for (const r of rows) {
      const k = `${r.feat_key}|${week}`;
      if (r.season_line_pg != null) {
        put(k, "shipped_week", p.week(r.feat_key, r.pos, r.opponent ?? undefined));
        put(k, "season_line", r.season_line_pg);
      }
      // trailing-4 falls back to points-to-date and then to the line: in week 1 it HAS no trailing
      // window, and pretending it projects 0 would beat it by handing it a straw man.
      const t4 = r.f.t4_mean ?? r.f.td_ppg ?? r.season_line_pg;
      if (t4 != null) put(k, "trailing4", t4);
    }
  }
  return out;
}

function measureSpread(seasons: SeasonRows[]): SpreadTable {
  const acc: Record<string, Record<string, number[]>> = {};
  for (const s of seasons) {
    const posOf = new Map(s.rows.map((r) => [`${r.feat_key}|${r.week}`, r.pos]));
    for (const [k, byModel] of pointBaselines(s)) {
      const y = s.actual.get(k), pos = posOf.get(k);
      if (y == null || !pos) continue;
      for (const [m, v] of Object.entries(byModel)) {
        if (!(v > 0)) continue;
        ((acc[m] ??= {})[pos] ??= []).push(y / v);
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

interface Row1 {
  key: string; pos: string; season: number; week: number; actual: number;
  line: number; rank: number; t4: number;
  by: Record<string, Pred>;
}

// --------------------------------------------------------------------------------------------
// STREAMING REGRET
// --------------------------------------------------------------------------------------------

/**
 * Does the store carry Track B's real free-agent pool? If so it is used and the report names it;
 * otherwise the season-line approximation is used and the report names THAT. What must never happen
 * is the number being quoted without the reader knowing which pool produced it.
 */
export function faPoolTable(db: DB): boolean {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='fact_fa_pool_week'",
  ).get();
}

/**
 * THE DECISION METRIC. One pick per (season, week, position), scored by what the man actually did.
 *
 * `winShareVsLine` is a PAIRED statistic: both models pick from the same pool in the same week, so it
 * is the share of matched comparisons the model won, not a difference of two averages -- the same
 * discipline CLAUDE.md records for the championship backtest. Weeks where the two models pick the
 * SAME MAN are neither a win nor a loss and are the large majority; the metric is concentrated in the
 * weeks where the models disagree, which is exactly where a streaming decision is a decision.
 */
export function streamingRegret(
  rows: Row1[], poolDepth: Record<string, number>, models: string[],
): Record<string, StreamPick[]> {
  const byPos: Record<string, StreamPick[]> = {};
  for (const pos of STREAM_POS) {
    const depth = poolDepth[pos] ?? 0;
    const pool = rows.filter((r) => r.pos === pos && r.rank > depth);
    if (!pool.length) continue;
    const byWeek = new Map<string, Row1[]>();
    for (const r of pool) (byWeek.get(`${r.season}|${r.week}`) ?? byWeek.set(`${r.season}|${r.week}`, []).get(`${r.season}|${r.week}`)!).push(r);
    const total: Record<string, number> = {};
    const winLine: Record<string, number> = {};
    const winCtrl: Record<string, number> = {};
    let weeks = 0;
    for (const [, list] of byWeek) {
      // A week with nobody in the pool is not a week where every model scored zero -- it is a week
      // with no decision to make, and scoring it would dilute every model toward the same number.
      if (list.length < 2) continue;
      const pickBy = (f: (r: Row1) => number | null): Row1 | null => {
        let best: Row1 | null = null, bestV = -Infinity;
        for (const r of list) {
          const v = f(r);
          if (v == null || !Number.isFinite(v)) continue;
          if (v > bestV) { bestV = v; best = r; }
        }
        return best;
      };
      const picks: Record<string, Row1 | null> = {};
      for (const m of models) picks[m] = pickBy((r) => r.by[m]?.mean ?? null);
      picks.season_line_pick = pickBy((r) => r.line);
      picks.trailing4_pick = pickBy((r) => r.t4);
      if (!picks.season_line_pick) continue;
      weeks++;
      const linePts = picks.season_line_pick.actual;
      const ctrl = picks[STREAM_CONTROL];
      for (const m of [...models, "season_line_pick", "trailing4_pick"]) {
        const p = picks[m];
        if (!p) continue;
        total[m] = (total[m] ?? 0) + p.actual;
        if (p.actual > linePts) winLine[m] = (winLine[m] ?? 0) + 1;
        if (ctrl && p.actual > ctrl.actual) winCtrl[m] = (winCtrl[m] ?? 0) + 1;
      }
    }
    if (!weeks) continue;
    byPos[pos] = [...models, "season_line_pick", "trailing4_pick"].map((m) => ({
      model: m,
      meanActual: (total[m] ?? 0) / weeks,
      winShareVsLine: (winLine[m] ?? 0) / weeks,
      winShareVsControl: (winCtrl[m] ?? 0) / weeks,
      weeks,
    }));
  }
  return byPos;
}

// --------------------------------------------------------------------------------------------
// THE GATE, PER POSITION
// --------------------------------------------------------------------------------------------

/**
 * THE PRE-REGISTERED WEEKLY GATE, APPLIED PER POSITION AND NOT RE-SPECIFIED.
 *
 *   (a) CRPS beats the shipped baseline;
 *   (b) coverage CONDITIONAL ON pts > 0 in [0.70, 0.90];
 *   (c) the predicted share of zero weeks is within 0.03 of the actual share.
 *
 * These are exactly the clauses `weeklyGate` applies, with the POOLED half of each clause dropped,
 * because a gate applied to one position has no pooled quantity -- the position IS the population.
 * The bands and the tolerance are imported from evaluate.ts rather than retyped, so a clause cannot
 * be quietly loosened here while the weekly track's stays where it is. They are constants and not
 * arguments for the reason recorded there: a gate whose thresholds are arguments is a gate a caller
 * can widen at the moment it bites.
 */
export function streamingGate(pos: string, m: Scored, base: Scored): StreamGate {
  const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
  const aOk = Number.isFinite(m?.crps) && Number.isFinite(base?.crps) && m.crps < base.crps;
  const covOk = Number.isFinite(m?.coverageNonZero)
    && m.coverageNonZero >= GATE_COV_POS[0] && m.coverageNonZero <= GATE_COV_POS[1];
  const dZero = Math.abs((m?.zeroPred ?? NaN) - (m?.zeroActual ?? NaN));
  const cOk = Number.isFinite(dZero) && dZero <= GATE_ZERO_TOL;
  const clauses: StreamGateClause[] = [
    { id: "a", passed: aOk, claim: `${pos} CRPS beats the shipped ${STREAM_BASELINE} baseline`,
      evidence: `${f(m?.crps, 4)} vs ${f(base?.crps, 4)}` },
    { id: "b", passed: covOk, claim: `${pos} coverage conditional on pts > 0 in [${GATE_COV_POS.join(", ")}]`,
      evidence: `${f(m?.coverageNonZero)}` },
    { id: "c", passed: cOk, claim: `${pos} predicted zero-week share within ${GATE_ZERO_TOL} of actual`,
      evidence: `predicted ${f(m?.zeroPred)} vs actual ${f(m?.zeroActual)} (off by ${f(dZero)})` },
  ];
  const passed = clauses.every((c) => c.passed);
  return { pos, passed, ships: passed ? "streaming" : "previous", clauses };
}

// --------------------------------------------------------------------------------------------
// THE HARNESS
// --------------------------------------------------------------------------------------------

export interface StreamingEvalOpts {
  dbPath?: string;
  seasons: number[];
  trainSeasons: number[];
  keepArtifacts?: string;
  poolScale?: number;
}

export async function evaluateStreaming(opts: StreamingEvalOpts): Promise<StreamingEvalResult> {
  const dbPath = opts.dbPath ?? "data/ff.db";
  const dir = opts.keepArtifacts ?? mkdtempSync(join(tmpdir(), "ff-streaming-eval-"));
  const db = openDb(dbPath);
  const all: Row1[] = [];
  let poolSource: StreamingEvalResult["poolSource"] = "season-line approximation";
  let streamColumns: string[] = [];
  try {
    streamColumns = presentStreamFields(db);
    if (streamColumns.length !== STREAM_FIELD_NAMES.length) {
      throw new Error(
        `this store carries ${streamColumns.length} of ${STREAM_FIELD_NAMES.length} streaming ` +
        "columns. Run `ff build-streaming-features` -- an evaluation of a streaming model on a " +
        "store without the streaming columns measures the weekly model and reports it as this one.");
    }
    poolSource = faPoolTable(db) ? "fact_fa_pool_week" : "season-line approximation";

    const trainOnly = opts.trainSeasons.filter((s) => !opts.seasons.includes(s));
    const spreadSeasons = (trainOnly.length ? trainOnly : opts.trainSeasons.slice(0, 2)).map((s) => loadSeason(db, s));
    const spread = measureSpread(spreadSeasons);

    for (const yr of opts.seasons) {
      const streamArt = trainFold(dbPath, opts.trainSeasons, yr, "all", join(dir, `stream-${yr}.json`));
      const ctrlArt = trainFold(dbPath, opts.trainSeasons, yr, "weekly-only", join(dir, `control-${yr}.json`));
      // THE CONTROL MUST ACTUALLY BE A CONTROL. A `--features weekly-only` run that still carried
      // the streaming columns would make every P41 number a comparison of a model with itself, and
      // the two artifacts would be near-identical in a way nothing else here would notice.
      const ctrlHas = ctrlArt.features.map((f) => f.name).filter((n) => STREAM_FIELD_NAMES.includes(n));
      if (ctrlHas.length) {
        throw new Error(`the ${yr} control artifact still declares streaming columns (${ctrlHas.join(", ")}) ` +
          "-- it is not a control, and every difference measured against it would be zero by construction");
      }
      const streamHas = streamArt.features.map((f) => f.name).filter((n) => STREAM_FIELD_NAMES.includes(n));
      if (streamHas.length !== STREAM_FIELD_NAMES.length) {
        throw new Error(`the ${yr} streaming artifact declares only ${streamHas.length} of ` +
          `${STREAM_FIELD_NAMES.length} streaming columns -- it is not the model being claimed`);
      }

      const s = loadSeason(db, yr);
      if (!s.rows.length) continue;
      const pts = pointBaselines(s);
      const streamP = new Map<string, Pred>();
      for (const r of projectWeekly({ artifact: streamArt, rows: s.rows })) {
        streamP.set(`${r.feat_key}|${r.week}`, { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90, pZero: r.pZero });
      }
      const ctrlP = new Map<string, Pred>();
      for (const r of projectWeekly({ artifact: ctrlArt, rows: s.rows })) {
        ctrlP.set(`${r.feat_key}|${r.week}`, { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90, pZero: r.pZero });
      }
      for (const r of s.rows) {
        const k = `${r.feat_key}|${r.week}`;
        const y = s.actual.get(k);
        const pt = pts.get(k);
        const sp = streamP.get(k), cp = ctrlP.get(k);
        if (y == null || !pt || !sp || !cp || r.season_line_pg == null) continue;
        const by: Record<string, Pred> = { streaming: sp, two_part: cp };
        for (const m of ["shipped_week", "season_line", "trailing4"]) {
          const v = pt[m];
          if (v == null || !Number.isFinite(v)) continue;
          const q = spread[m]?.[r.pos] ?? { p10: 0.3, p50: 0.9, p90: 1.9 };
          by[m] = { mean: v, p10: v * q.p10, p50: v * q.p50, p90: v * q.p90 };
        }
        if (!by[STREAM_BASELINE]) continue;      // score only rows every model can speak to
        all.push({
          key: r.feat_key, pos: r.pos, season: r.season, week: r.week, actual: y,
          line: r.season_line_pg, rank: s.rank.get(r.feat_key) ?? 9999,
          t4: r.f.t4_mean ?? r.f.td_ppg ?? r.season_line_pg,
          by,
        });
      }
    }
  } finally {
    db.close();
    if (!opts.keepArtifacts) rmSync(dir, { recursive: true, force: true });
  }

  const cut = (rows: Row1[]) => Object.fromEntries(STREAM_MODELS.map((m) =>
    [m, score(rows.filter((r) => r.by[m]).map((r) => ({ actual: r.actual, p: r.by[m] })))]));
  const pooled = cut(all);
  const byPos: Record<string, Record<string, Scored>> = {};
  for (const p of STREAM_POS) { const r = all.filter((x) => x.pos === p); if (r.length) byPos[p] = cut(r); }

  const scale = opts.poolScale ?? 1;
  const depth = Object.fromEntries(Object.entries(POOL_DEPTH).map(([k, v]) => [k, Math.max(1, Math.round(v * scale))]));
  const regret = streamingRegret(all, depth, ["streaming", STREAM_CONTROL, "shipped_week", "trailing4"]);

  // ---- THE PRE-REGISTERED PREDICTIONS. Recorded as held or failed, never quietly re-stated. ----
  const pick = (pos: string, m: string) => regret[pos]?.find((x) => x.model === m);
  const gainOverLine = (pos: string) => {
    const s = pick(pos, "streaming"), l = pick(pos, "season_line_pick");
    return s && l ? s.meanActual - l.meanActual : NaN;
  };
  const gainOverControl = (pos: string) => {
    const s = pick(pos, "streaming"), c = pick(pos, STREAM_CONTROL);
    return s && c ? s.meanActual - c.meanActual : NaN;
  };
  const p40Pos = ["QB", "K", "DST"], p41Pos = ["RB", "WR", "TE"];
  const p40 = p40Pos.map((p) => [p, gainOverLine(p)] as const);
  const p41 = p41Pos.map((p) => [p, gainOverControl(p)] as const);
  const dstS = byPos.DST?.streaming, dstC = byPos.DST?.two_part;
  const p42Improve = dstS && dstC && Number.isFinite(dstC.crps) && dstC.crps > 0
    ? (dstC.crps - dstS.crps) / dstC.crps : NaN;

  const predictions = [
    {
      id: "P40",
      claim: "for QB, K and DST the streaming model's pick out of the free-agent pool beats the best-by-season-line pick by at least 1.0 point per week",
      held: p40.every(([, v]) => Number.isFinite(v)) ? p40.every(([, v]) => v >= 1.0) : null,
      evidence: p40.map(([p, v]) => `${p} ${Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "-"}`).join("; "),
    },
    {
      id: "P41",
      claim: "for RB, WR and TE the opponent features add LESS than 0.5 point per week over the same two-part model without them",
      held: p41.every(([, v]) => Number.isFinite(v)) ? p41.every(([, v]) => v < 0.5) : null,
      evidence: p41.map(([p, v]) => `${p} ${Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "-"}`).join("; "),
    },
    {
      id: "P42",
      claim: "DST CRPS improves by at least 5% with the opponent's implied total and turnover rates, over the two-part model without them",
      held: Number.isFinite(p42Improve) ? p42Improve >= 0.05 : null,
      evidence: Number.isFinite(p42Improve)
        ? `${(100 * p42Improve).toFixed(1)}% (${dstS!.crps.toFixed(4)} vs ${dstC!.crps.toFixed(4)})`
        : "DST was not scored under both models",
    },
  ];

  const gates = STREAM_POS.filter((p) => byPos[p]).map((p) => streamingGate(p, byPos[p].streaming, byPos[p][STREAM_BASELINE]));
  return {
    seasons: opts.seasons, trainSeasons: opts.trainSeasons,
    poolSource, poolDepth: depth, streamColumns,
    pooled, byPos, regret, predictions, gates,
    ships: gates.filter((g) => g.passed).map((g) => g.pos),
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");

export function formatStreamingReport(r: StreamingEvalResult): string {
  const out: string[] = [];
  out.push(`streaming evaluation -- holdout seasons ${r.seasons[0]}-${r.seasons[r.seasons.length - 1]}, ` +
    `trained on ${r.trainSeasons[0]}-${r.trainSeasons[r.trainSeasons.length - 1]} minus the holdout`);
  out.push(`streaming columns: ${r.streamColumns.join(", ")}`);
  out.push(`free-agent pool: ${r.poolSource}; depth ` +
    Object.entries(r.poolDepth).map(([p, n]) => `${p} ${n}`).join(", "));
  out.push("");
  const table = (title: string, rows: Record<string, Record<string, Scored>>) => {
    out.push(title);
    out.push("  " + pad("group", 8) + pad("model", 14) +
      "      n     RMSE     CRPS  cov(>0)     bias   zeroP   zeroA");
    for (const [g, byModel] of Object.entries(rows)) {
      for (const m of STREAM_MODELS) {
        const s = byModel[m]; if (!s || !s.n) continue;
        out.push("  " + pad(g, 8) + pad(m, 14) + String(s.n).padStart(7) + num(s.rmse).padStart(9) +
          num(s.crps).padStart(9) + num(s.coverageNonZero).padStart(9) + num(s.bias).padStart(9) +
          num(s.zeroPred).padStart(8) + num(s.zeroActual).padStart(8));
      }
    }
  };
  table("POOLED", { all: r.pooled });
  out.push("");
  table("BY POSITION", r.byPos);
  out.push("");
  out.push("STREAMING REGRET (actual points of the ONE man each model picked out of the pool)");
  out.push("  " + pad("pos", 5) + pad("model", 18) + "  meanPts   vs line   winVsLine  winVsCtrl    weeks");
  for (const [pos, list] of Object.entries(r.regret)) {
    const line = list.find((x) => x.model === "season_line_pick");
    for (const p of list) {
      const d = line ? p.meanActual - line.meanActual : NaN;
      out.push("  " + pad(pos, 5) + pad(p.model, 18) + num(p.meanActual, 2).padStart(9) +
        (Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(2) : "-").padStart(10) +
        num(p.winShareVsLine, 3).padStart(12) + num(p.winShareVsControl, 3).padStart(11) +
        String(p.weeks).padStart(9));
    }
  }
  out.push("");
  out.push("PRE-REGISTERED PREDICTIONS");
  for (const p of r.predictions) {
    out.push(`  ${p.id}  ${p.held === null ? "UNMEASURED" : p.held ? "HELD  " : "FAILED"}  ${p.claim}`);
    out.push(`        ${p.evidence}`);
  }
  out.push("");
  out.push("THE GATE, PER POSITION (the weekly gate's clauses, applied to one position at a time)");
  for (const g of r.gates) {
    out.push(`  ${pad(g.pos, 5)} ${g.passed ? "PASS" : "FAIL"} -- ships the ${g.ships} model`);
    for (const c of g.clauses) out.push(`        (${c.id}) ${c.passed ? "pass" : "FAIL"}  ${c.claim}: ${c.evidence}`);
  }
  out.push("");
  out.push(`SHIPS THE STREAMING MODEL AT: ${r.ships.length ? r.ships.join(", ") : "(no position passed)"}` +
    `; every other position keeps the artifact it had.`);
  return out.join("\n");
}
