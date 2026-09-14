/**
 * NESTED CROSS-VALIDATION THAT RUNS THE SHIPPED CODE.
 *
 * scripts/nested-cv.mjs measured a model. It did not measure OUR model: it reimplemented the curve,
 * the age multiplier and the opportunity multiplier internally, in JavaScript, with its own season
 * range and its own name-keyed join. So the validation harness and the shipped projection could
 * disagree about what a projection even IS -- and for the life of the project they did. The harness
 * had been fitting E[y | rank] all along while the board applied an order statistic, which is Phase
 * 1's Finding A discovered from the other end.
 *
 * Here, every number comes from the shipped path:
 *
 *   the TRAINER is invoked as a subprocess, once per outer fold, with --holdout-season Y, so the
 *   coefficients, the transform centres, the bucket means and the alpha search are ALL re-derived
 *   without ever seeing Y;
 *   the artifact is loaded through the SHIPPED loader, which refuses anything it cannot evaluate;
 *   the projection comes from projectSeason, the same function the board calls.
 *
 * THREE RUNGS, all scored by one function, because a comparison between two things measured by two
 * pieces of code is not a comparison:
 *
 *   carry      last season's points, carried forward. The free baseline.
 *   curve      the curve-only artifact -- the point-in-time curve times the shipped multipliers.
 *   trained    the fitted artifact for this fold.
 *
 * WHAT COUNTS AS BEATING SOMETHING. R-squared against the season mean is a soft bar that any model
 * knowing rank clears. The bar that matters is the CURVE, because the curve is free.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { pMap, withCpuSlot, defaultCpuConcurrency, cpuBudget } from "../util/pool.js";
const execFileP = promisify(execFile);
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/db.js";
import { loadArtifact, projectSeason, type ProjectionArtifact, type ProjRow } from "./projector.js";
import { loadFeatureRows } from "./features.js";
import { buildCurveOnlyArtifact } from "./build.js";
import { embargoedSeasons } from "./embargo.js";

// THE 60+ BAND IS NOT DECORATION. It holds 42% of the scored rows in this store -- prior-year WRs
// run to rank 225 -- and it was reported nowhere, so a model that was never fitted out there and
// projected there anyway looked fine in every band that was printed while losing 7 RMSE points
// overall. A band nobody prints is a band nobody checks.
export const RANK_BANDS: [string, number, number][] = [
  ["1-6", 1, 6], ["7-12", 7, 12], ["13-24", 13, 24], ["25-40", 25, 40], ["41-60", 41, 60],
  ["60+", 61, 9999],
];
export const bandOf = (rank: number): string => RANK_BANDS.find(([, lo, hi]) => rank >= lo && rank <= hi)?.[0] ?? "60+";

export interface Scored {
  n: number; rmse: number; r2: number; crps: number;
  cover10: number; cover90: number; bias: number;
}

export interface EvalRow {
  season: number; name: string; pos: string; rank: number; band: string;
  actual: number; base: number | null;
  mean: number; p10: number; p50: number; p90: number;
  resid: number;
  // COLD-START (WS3): true for a player in his FIRST projectable season -- i.e. his only prior-season
  // history is his rookie year (draft_year === season - 1). These are the cold-start cases the pooled
  // CV metric over-rewards; `cmdEvaluateProjection` reports them split from returning veterans.
  isNew: boolean;
}

/**
 * PINBALL LOSS over the three quantiles, reported as `crps`.
 *
 * It is NOT the continuous ranked probability score and is not called one anywhere a reader could
 * mistake it: CRPS integrates over the whole predictive distribution and we ship three quantiles.
 * The mean pinball loss across those three is the standard discrete stand-in and it is a proper
 * scoring rule, which is the property that matters -- it cannot be improved by lying about
 * uncertainty. Naming it CRPS without saying so would be the sort of quiet substitution this
 * project has already paid for once, in the curve.
 */
function pinball(actual: number, q: number, pred: number): number {
  const d = actual - pred;
  return d >= 0 ? q * d : (q - 1) * d;
}

export function score(rows: EvalRow[]): Scored {
  if (!rows.length) return { n: 0, rmse: NaN, r2: NaN, crps: NaN, cover10: NaN, cover90: NaN, bias: NaN };
  const mean = rows.reduce((a, r) => a + r.actual, 0) / rows.length;
  let ss = 0, sst = 0, pb = 0, c10 = 0, c90 = 0, bias = 0;
  for (const r of rows) {
    ss += (r.actual - r.mean) ** 2;
    sst += (r.actual - mean) ** 2;
    pb += (pinball(r.actual, 0.10, r.p10) + pinball(r.actual, 0.50, r.p50) + pinball(r.actual, 0.90, r.p90)) / 3;
    if (r.actual >= r.p10) c10++;
    if (r.actual <= r.p90) c90++;
    bias += r.mean - r.actual;
  }
  return {
    n: rows.length, rmse: Math.sqrt(ss / rows.length), r2: sst > 0 ? 1 - ss / sst : NaN,
    crps: pb / rows.length, cover10: c10 / rows.length, cover90: c90 / rows.length,
    bias: bias / rows.length,
  };
}

/** Actual season points for the holdout, keyed the way the feature rows are keyed. `isNew` marks a
 *  player whose only prior-season history is his rookie year (draft_year === season - 1) -- the
 *  cold-start regime (WS3). A null draft_year is an established veteran with no coverage, so NOT new. */
function targets(db: DB, season: number): Map<string, { pts: number; rank: number; isNew: boolean }> {
  const m = new Map<string, { pts: number; rank: number; isNew: boolean }>();
  for (const r of db.prepare(
    "SELECT name, pos, pts, prior_pos_rank, draft_year FROM feat_player_season WHERE season = ? AND pts IS NOT NULL",
  ).all(season) as { name: string; pos: string; pts: number; prior_pos_rank: number | null; draft_year: number | null }[]) {
    if (r.prior_pos_rank == null) continue;
    m.set(`${r.pos}|${r.name}`, { pts: r.pts, rank: r.prior_pos_rank, isNew: r.draft_year != null && r.draft_year === season - 1 });
  }
  return m;
}

function toEvalRows(season: number, proj: ProjRow[], tgt: Map<string, { pts: number; rank: number; isNew: boolean }>, bases: Map<string, number | null>): EvalRow[] {
  const out: EvalRow[] = [];
  for (const p of proj) {
    const t = tgt.get(`${p.pos}|${p.name}`);
    if (!t) continue;                     // no scored season -> nothing to score against
    out.push({
      season, name: p.name, pos: p.pos, rank: t.rank, band: bandOf(t.rank),
      actual: t.pts, base: bases.get(`${p.pos}|${p.name}`) ?? null,
      mean: p.mean, p10: p.p10, p50: p.p50, p90: p.p90, resid: t.pts - p.mean,
      isNew: t.isNew,
    });
  }
  return out;
}

/** CARRY-FORWARD, the free baseline: last season's points, with quantiles from the pooled ratio of
 *  actual to prior points. Scored by the SAME function as the other two rungs, which is the only way
 *  the three numbers are comparable. */
function carryForward(db: DB, season: number, q: { p10: number; p50: number; p90: number }): ProjRow[] {
  return (db.prepare(
    "SELECT name, pos, player_sk, prior_pts FROM feat_player_season WHERE season = ? AND prior_pts IS NOT NULL AND prior_pos_rank IS NOT NULL",
  ).all(season) as { name: string; pos: string; player_sk: string | null; prior_pts: number }[])
    .map((r) => ({
      player_sk: r.player_sk, name: r.name, pos: r.pos,
      mean: r.prior_pts, p10: r.prior_pts * q.p10, p50: r.prior_pts * q.p50, p90: r.prior_pts * q.p90,
    }));
}

function carryQuantiles(db: DB, holdout: number): { p10: number; p50: number; p90: number } {
  const v = (db.prepare(
    "SELECT pts / prior_pts r FROM feat_player_season WHERE pts IS NOT NULL AND prior_pts > 20 AND season <> ? AND prior_pos_rank <= 36",
  ).all(holdout) as { r: number }[]).map((x) => x.r).sort((a, b) => a - b);
  const at = (p: number) => {
    if (!v.length) return 1;
    const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  return { p10: at(0.10), p50: at(0.50), p90: at(0.90) };
}

/**
 * The rungs. Phase 2a carried a fourth, `bare` -- the curve with its multiplicative stage emptied --
 * because the feature screen's positive control ("age must correlate with the residual") could not
 * fire against a curve that already had the age multiplier applied to it. THE MULTIPLICATIVE STAGE
 * IS GONE (Phase 2b), so `curve` IS bare: the projection is the point-in-time curve and nothing
 * else. The rung was removed rather than kept as a synonym, because two names for one thing is how a
 * comparison between them comes to be reported as a finding.
 */
export type Rung = "carry" | "curve" | "trained";
export const RUNGS: Rung[] = ["carry", "curve", "trained"];

export interface FoldResult {
  season: number;
  rows: Record<Rung, EvalRow[]>;
  trainerOk: boolean;
  note?: string;
  /** RUNG 5 (ladder): a CHALLENGER learner's holdout predictions, read from the sidecar the trainer
   *  writes beside the fold artifact under `--challenger gbm`, scored by the same `score()` on the
   *  same targets. A screen only -- the board never reads it -- so it is a separate optional field
   *  rather than a Rung, and absent unless the trainer was asked for it. */
  challenger?: EvalRow[];
}

export async function evaluateProjection(opts: {
  dbPath?: string; seasons: number[];
  trainerSeasons?: string;
  keepArtifacts?: string;
  /** ADJACENT-SEASON EMBARGO (WS3). 0 (default) = the shipped per-fold artifacts (no embargo). N>=1
   *  passes `--embargo N` to the trainer so each fold's artifact is also blind to the N seasons just
   *  before its held-out season -- use it to build data/fold-artifacts-2b-embargo for the arbiter. */
  embargo?: number;
  /** Max folds whose trainer subprocess runs at once (default cores-1, capped by the global cpuBudget).
   *  Folds are independent + identity-keyed by season, so concurrency cannot change the output --
   *  pMap returns input order and test/pool.test.ts pins concurrency 1 == concurrency N. */
  concurrency?: number;
  /** EXTRA TRAINER FLAGS (the pre-deep-learning ladder, 2026-09-14). A rung below the feature queue
   *  is a change in HOW the trainer fits -- shrinkage, pooling, a basis -- i.e. a flag, not a column.
   *  `scripts/gate-variant.mjs` passes the two arms' flags here and applies the WS1 verdict to them.
   *  Echoed in the header like --add-features, so the reader is told which model the numbers are. */
  trainerArgs?: string[];
  log?: (s: string) => void;
}): Promise<FoldResult[]> {
  const log = opts.log ?? console.log;
  const embargo = opts.embargo ?? 0;
  const trainerArgs = opts.trainerArgs ?? [];
  if (trainerArgs.length) log(`  TRAINER VARIANT: extra trainer args [${trainerArgs.join(" ")}]. Every number below is that model's, not the shipped one's.`);
  if (embargo > 0) log(`  ADJACENT-SEASON EMBARGO: --embargo ${embargo}; each fold also drops the ${embargo} season(s) before its holdout from training.`);
  // Read ONCE and echoed, so every fold in a run fits the same model and the reader is told which.
  const addFeatures = (process.env.FF_ADD_FEATURES ?? "").trim();
  // LEAVE-ONE-OUT (admit-feature --remove): the symmetric case -- fit the shipped design MINUS a named
  // default column, so the difference vs the untouched default is that feature's own contribution.
  const removeFeatures = (process.env.FF_REMOVE_FEATURES ?? "").trim();
  log(addFeatures
    ? `  ADMISSION RUN: the trainer is fitting with --add-features ${addFeatures}. Every number below ` +
      "is that model's, not the shipped one's."
    : "  baseline run: no --add-features (set FF_ADD_FEATURES to admit an extension column)");
  if (removeFeatures) log(`  LEAVE-ONE-OUT: the trainer is fitting with --remove-features ${removeFeatures} (shipped design minus that column).`);
  const dir = opts.keepArtifacts ?? mkdtempSync(join(tmpdir(), "ff-eval-"));
  const db = openDb(opts.dbPath);
  // Every fold's db reads are SYNCHRONOUS better-sqlite3 calls, so they cannot interleave across folds
  // -- the only await is the trainer subprocess. That is why one shared read handle is safe under the
  // fan-out, and why concurrency stays a subprocess-level speedup with byte-identical fold outputs.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? defaultCpuConcurrency(), opts.seasons.length || 1));
  if (concurrency > 1) log(`  fold fan-out: up to ${concurrency} trainer subprocesses at once (global cpu budget ${cpuBudget.limit}).`);

  const runFold = async (yr: number): Promise<FoldResult | null> => {
    const tgt = targets(db, yr);
    if (!tgt.size) { log(`  ${yr}: no scored rows -- skipped`); return null; }

    // --- rung 2: the curve-only artifact, fitted on seasons strictly BEFORE this one ----------
    // Point-in-time, matching the trainer. A baseline fitted on a wider window than the model it
    // is the baseline for flatters exactly the wrong side of the comparison.
    const { artifact: curveArt } = buildCurveOnlyArtifact({
      dbPath: opts.dbPath, from: 1999, to: 2025, base: "curve_value_prior",
      holdoutSeason: yr, pointInTime: true,
    });
    const curveFeat = loadFeatureRows(db, { season: yr, rankBasis: "prior", base: "curve_value_prior" });
    const bases = new Map(curveFeat.map((f) => [`${f.pos}|${f.name}`, f.base]));
    const curveRows = toEvalRows(yr, projectSeason({ season: yr, asOf: `${yr}-09-01`, artifact: curveArt, features: curveFeat }), tgt, bases);
    if (!curveRows.length) { log(`  ${yr}: no curve at any rank -- skipped`); return null; }

    // --- rung 3: the TRAINER, as a subprocess, blind to this season ---------------------------
    const artPath = join(dir, `artifact-${yr}.json`);
    let trained: ProjectionArtifact | null = null;
    let challengerRows: EvalRow[] | undefined;
    let note: string | undefined;
    try {
      // withCpuSlot holds one slot of the process-wide budget for the trainer, so a candidates-x-folds
      // nesting (admit-feature over this) can never spawn more python than the machine has cores.
      // OMP/BLAS pinned to 1 thread: the trainer is single-core by design, so N parallel folds must
      // stay N single-core processes, not N*cores oversubscribing.
      await withCpuSlot(() => execFileP("uv", [
        "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_projection.py",
        "--db", opts.dbPath ?? "data/ff.db", "--seasons", opts.trainerSeasons ?? "1999-2025",
        "--holdout-season", String(yr), "--out", artPath, "--quiet",
        // ADJACENT-SEASON EMBARGO (WS3): only added when > 0, so the default fold artifact is
        // byte-identical to the pre-WS3 one. The produced artifact is guarded below.
        ...(embargo > 0 ? ["--embargo", String(embargo)] : []),
        // THE ADMISSION LEVER (Phase 2d). One candidate at a time, re-measured under the full
        // nested evaluation rather than on the residuals it was screened against. It is an
        // environment variable rather than a flag because the CLI surface is owned elsewhere this
        // phase; the report header PRINTS it, so a run cannot quietly be a different model from
        // the one the reader thinks they are looking at -- which is the only property that matters.
        ...(addFeatures ? ["--add-features", addFeatures] : []),
        // LEAVE-ONE-OUT (symmetric to --add-features; the report header printed it above).
        ...(removeFeatures ? ["--remove-features", removeFeatures] : []),
        // TRAINER VARIANT flags (gate-variant.mjs); empty by default, so the shipped fold is unchanged.
        ...trainerArgs,
      ], {
        timeout: 1800000,
        env: { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
      }));
      if (existsSync(artPath)) trained = loadArtifact(JSON.parse(readFileSync(artPath, "utf8")));
      // RUNG 5 sidecar (only present when the trainer ran with --challenger): scored exactly like the
      // linear rung, against the same targets and bases, by the same function.
      const chPath = artPath + ".challenger.json";
      if (existsSync(chPath)) {
        const ch = JSON.parse(readFileSync(chPath, "utf8")) as { rows: Omit<ProjRow, "player_sk">[] };
        challengerRows = toEvalRows(yr, ch.rows.map((r) => ({ ...r, player_sk: null })), tgt, bases);
      }
      // EMBARGO GUARD (WS3). Prove the trainer actually applied the embargo, rather than trusting
      // that the flag was wired: none of the embargoed seasons may appear in the fitted artifact's
      // training `seasons`. This is the consumer checking the producer's emitted bytes -- a
      // `--embargo` that the Python side silently dropped fails HERE, loudly, not silently.
      if (trained && embargo > 0) {
        const leaked = embargoedSeasons(yr, embargo).filter((s) => trained!.seasons.includes(s));
        if (leaked.length) {
          throw new Error(`embargo ${embargo} not honoured for holdout ${yr}: training seasons still include ${leaked.join(",")}`);
        }
      }
    } catch (e) { note = `trainer failed: ${(e as Error).message.split("\n")[0]}`; }

    let trainedRows: EvalRow[] = [];
    if (trained) {
      const f = loadFeatureRows(db, {
        season: yr, rankBasis: "prior", base: trained.base, curve: trained.curve,
      });
      trainedRows = toEvalRows(yr, projectSeason({ season: yr, asOf: `${yr}-09-01`, artifact: trained, features: f }), tgt, bases);
    }

    // --- rung 1: carry-forward ---------------------------------------------------------------
    const carryRows = toEvalRows(yr, carryForward(db, yr, carryQuantiles(db, yr)), tgt, bases);

    const sel = trained?.curveVariant
      ? "  variant " + Object.entries(trained.curveVariant)
        .map(([p, v]) => `${p}:w${v.window}${v.monotone ? "m" : "-"}L${v.levelWeight}/${v.form[0]}`).join(" ")
      : "";
    log(`  ${yr}: carry ${carryRows.length}  curve ${curveRows.length}  trained ${trainedRows.length}` + sel + (note ? `  (${note})` : ""));
    return { season: yr, rows: { carry: carryRows, curve: curveRows, trained: trainedRows }, trainerOk: !!trained, note,
      ...(challengerRows ? { challenger: challengerRows } : {}) };
  };

  try {
    // Input-order results (pMap contract); skipped folds come back null and are filtered out, so the
    // returned array matches the pre-fan-out sequential order exactly.
    const folds = await pMap(opts.seasons, (yr) => runFold(yr), { concurrency });
    return folds.filter((f): f is FoldResult => f != null);
  } finally {
    db.close();
    if (!opts.keepArtifacts) rmSync(dir, { recursive: true, force: true });
  }
}

export const pool = (folds: FoldResult[], rung: Rung): EvalRow[] => folds.flatMap((f) => f.rows[rung]);
