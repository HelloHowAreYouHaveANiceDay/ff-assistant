/**
 * THE WEEKLY PROJECTOR -- a pure function from (artifact, feature rows) to weekly projections.
 *
 * Same shape and same reasoning as src/model/projector.ts, one horizon down. Training happens in
 * Python (tools/train_weekly.py) because quantile regression is a linear program; serving happens
 * here because the engine runs inside an Electron app on a machine with no Python, in the middle of
 * a live season. The seam between them is the artifact, and a seam is exactly where a producer and
 * a consumer drift apart while both stay green -- so the artifact carries a GOLDEN BLOCK and this
 * loader refuses an artifact whose golden rows it cannot reproduce to 1e-6.
 *
 * WHAT IS FITTED, AND WHY IT IS A RATIO. The target is `pts / season_line_pg`: the week's actual
 * points as a multiple of what the preseason season projection said this player was worth per game.
 * The season line is a strong, honest predictor that already encodes who the player is; fitting
 * points directly would spend the model's capacity re-learning talent. Predicting the ratio makes
 * every coefficient a statement about what the season line gets WRONG week to week, which is the
 * only thing a weekly model can add.
 *
 * THE ZERO ATOM, and the choice, stated out loud. Weekly fantasy points are zero-inflated twice over:
 * a rostered man can fail to play at all, and a receiver who plays can catch nothing. MEASURED, on
 * 2010-2025 rostered non-bye weeks: 29.5% of the rows the model trains on score at or below 1.0
 * point, and about 40% of everything the harness scores does (the difference is the training floor
 * on the season line, which excludes the deep bench where a zero is near-certain).
 * Two treatments are defensible -- a two-part model (probability of a zero week
 * from availability signals, times the ratio given a real week), or quantile heads that can reach
 * zero. THIS ARTIFACT USES QUANTILE HEADS, with the clamp floor at exactly 0 rather than the season
 * model's 0.01, so p10 is free to sit on the atom and does. The reason is not elegance: the
 * availability signals that would drive a two-part model's first stage -- injury designation, depth
 * chart rank, whether the man ahead of him is out -- are the DATA TRACK's `feat_player_week_context`
 * and do not exist yet. Fitting a zero-probability stage on to-date scoring alone is fitting the
 * consequence of an injury instead of the injury, and it would look like structure while measuring
 * the same thing the mean head already sees. When those columns land, the two-part model becomes
 * worth measuring; `--zero-model` is the flag it will arrive under, and until then the honest form
 * is the one that does not pretend to information it lacks.
 */
import { WEEKLY_FEATURE_FIELDS, type WeeklyFeatureField } from "./features.js";

/**
 * WHICH WEEKLY ARTIFACT IS THE SHIPPED ONE, in ONE place because it was in two and they disagreed.
 *
 * Until the final integration `lineupRecommend` loaded `weekly-artifact-lineonly.json` (the floor)
 * and `ff scorecard` loaded `weekly-artifact.json` (the two-part challenger), each with the filename
 * typed inline. So the model the season's forward record was accruing for was NOT the model the
 * lineup was served from, and nothing said so: both files load through the same loader, both
 * validate, and both produce plausible numbers. The scorecard's whole purpose is to be the one
 * measurement that cannot be gamed after the fact, and it was measuring a model nobody used.
 *
 * The floor ships because it is what passed. Phase 2d re-ran the corrected weekly gate on both
 * candidates and BOTH failed clause (c) -- see `MODELS` in src/draft/models.ts for the measured
 * numbers -- so the season-line-only artifact remains the shipped one, exactly as before.
 *
 * The challenger is not thrown away. `ff scorecard` snapshots it under its own kind so the live
 * season accrues out-of-sample evidence for it, which is the only kind of evidence left: the
 * historical folds have all been used.
 */
export const SHIPPED_WEEKLY_ARTIFACT = "weekly-artifact-lineonly.json";
export const CHALLENGER_WEEKLY_ARTIFACT = "weekly-artifact.json";

export type WeeklyHead = "mean" | "p10" | "p50" | "p90";
export const WEEKLY_HEADS: WeeklyHead[] = ["mean", "p10", "p50", "p90"];

/**
 * Transforms. `ratio_to_line` divides the raw value by the row's own season line, which is how a
 * "he has been running hot" feature is expressed without re-learning talent: a trailing mean of 18
 * means something completely different for a 6-point-a-game tight end and an 18-point-a-game
 * quarterback, and the undivided column would make the model learn talent a second time.
 */
export type WeeklyTransform = "identity" | "center" | "indicator" | "ratio_to_line";

export interface WeeklyFeatureSpec {
  name: WeeklyFeatureField;
  transform: WeeklyTransform;
  center?: number;
  scale?: number;
  /** The POST-TRANSFORM value used when the input is null. Required and required to be EXPLICIT: a
   *  missing input silently becoming 0 means "exactly league average" wherever a feature is centred
   *  and "he saw no work at all" where it is not -- a guess wearing the costume of a default. */
  missing: number;
}

/**
 * WHICH MODEL THE ARTIFACT CARRIES, and it changes the arithmetic below rather than just labelling it.
 *
 * "quantile"  -- one set of heads (mean, p10, p50, p90) fitted on the POOLED target, zeros included,
 *                with the clamp floor at 0 so p10 can sit on the atom. Phase 2c's model.
 * "two-part"  -- P(zero week) from a logistic stage on availability signals, times the ratio GIVEN
 *                he played from a second stage fitted on played weeks only. The published quantiles
 *                are the MIXTURE's, which is what makes p10 exactly 0 whenever the zero probability
 *                exceeds 0.10 -- a thing a pooled quantile fit cannot say, because 0.10 is the
 *                smallest level it publishes no matter how certain the zero is.
 */
export type WeeklyZeroModel = "quantile" | "two-part";

/** Grid level -> head name. `q05`, `q10`, ..., so a head name cannot be a float that round-trips
 *  differently through JSON on the two sides of the seam. */
export const gridHead = (q: number): string => `q${String(Math.round(q * 100)).padStart(2, "0")}`;

export interface WeeklyArtifact {
  schema: number;
  kind: "weekly";
  /** Absent means "quantile" -- but a schema-2 artifact always states it. */
  zeroModel?: WeeklyZeroModel;
  /** The quantile levels the SECOND stage was fitted at, ascending. Two-part artifacts only. */
  quantileGrid?: number[];
  fittedFrom: string;
  fittedAt?: string;
  seasons: number[];
  holdoutSeason: number | null;
  /** The denominator. Recorded so the loader and the trainer cannot disagree about what the ratio
   *  was a ratio TO. */
  target: "ratio_to_season_line";
  /**
   * WHICH WEEKS THE MODEL WAS FITTED ON, and it is a contract, not a note.
   *
   * "rostered" is every non-bye week, with a week the man did not play scored as the ZERO it is for
   * the manager who started him. "played" is appearances only, which makes the model an estimator of
   * E[points | he plays] -- systematically too high for exactly the players a lineup should be
   * benching. The first evaluation pass measured that mismatch as a +0.8 to +1.7 point bias and 0.57
   * coverage against a nominal 0.80, with nothing wrong on either side: the two were answering
   * different questions and both were internally consistent. So the population is recorded on the
   * artifact and a consumer that scores a different one refuses it rather than reporting the gap as
   * a model defect.
   */
  population: "rostered" | "played";
  /** Season lines below this were excluded from TRAINING (the ratio is noise over a small number).
   *  It is not a serve-time behaviour: a small line still projects, it just projects small. */
  trainMinLine: number;
  features: WeeklyFeatureSpec[];
  /** Per position, per HEAD, per feature. A quantile artifact's heads are exactly WEEKLY_HEADS; a
   *  two-part artifact's are `zero` (a LOGIT), `mean` (E[ratio | played]) and one per grid level. */
  coef: Record<string, Record<string, Record<string, number>>>;
  /** [lo, hi] on the RATIO. lo is 0, not a small positive number: the quantile heads must be able
   *  to reach the zero atom, and a floor of 0.01 would quietly turn every zero week into a small
   *  positive projection that no metric would flag. */
  clamps: { lo: number; hi: number };
  golden?: WeeklyGoldenRow[];
  notes?: string;
}

export interface WeeklyGoldenRow {
  pos: string;
  line: number;
  f: Partial<Record<WeeklyFeatureField, number | null>>;
  expect: Record<string, number>;
}

export interface WeeklyProjRow {
  feat_key: string;
  player_sk: string | null;
  name: string;
  pos: string;
  season: number;
  week: number;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  /** P(zero week). Present only for a two-part artifact -- the model that has one. A quantile
   *  artifact does NOT get a fabricated one here; the evaluator reads its ladder instead, which is
   *  an honest statement of what that model can and cannot claim. */
  pZero?: number;
}

export interface WeeklyInputRow {
  feat_key: string;
  player_sk: string | null;
  name: string;
  pos: string;
  season: number;
  week: number;
  season_line_pg: number | null;
  f: Partial<Record<WeeklyFeatureField, number | null>>;
}

const SCHEMA = 2;

/** The default second-stage grid. Written ON the artifact; this is only the fallback for reading one
 *  that somehow omits it, and the loader refuses that case rather than using it silently. */
export const DEFAULT_QUANTILE_GRID = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.90];

const logistic = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Evaluate one spec against one row. Exported so the golden check and the projector cannot drift
 *  into two implementations of the same transform. Mirrored in tools/train_weekly.py. */
export function weeklyFeatureValue(
  spec: WeeklyFeatureSpec, row: { f: WeeklyInputRow["f"]; season_line_pg: number | null },
): number {
  const raw = row.f[spec.name];
  if (raw == null || !Number.isFinite(raw)) return spec.missing;
  switch (spec.transform) {
    case "identity": return raw;
    case "indicator": return raw ? 1 : 0;
    case "center": {
      const s = spec.scale ?? 1;
      return s === 0 ? spec.missing : (raw - (spec.center ?? 0)) / s;
    }
    case "ratio_to_line": {
      const line = row.season_line_pg;
      // A line at or below zero makes the ratio meaningless rather than large, which is a different
      // statement from "the input was missing" and gets the same explicit default either way.
      if (line == null || !(line > 0)) return spec.missing;
      return raw / line;
    }
    default: return spec.missing;
  }
}

/**
 * THE PROJECTOR. Pure: no file reads, no network, no clock.
 *
 * A row with no season line produces NO projection rather than a zero. "We have no preseason line
 * for this man" is not a projection of zero points, and recording it as one would put a real number
 * into the lineup optimiser that nothing downstream could tell apart from a measured projection.
 */
export function projectWeekly(opts: { artifact: WeeklyArtifact; rows: WeeklyInputRow[] }): WeeklyProjRow[] {
  const { artifact: a, rows } = opts;
  const twoPart = a.zeroModel === "two-part";
  const grid = a.quantileGrid ?? DEFAULT_QUANTILE_GRID;
  const out: WeeklyProjRow[] = [];
  for (const row of rows) {
    const line = row.season_line_pg;
    if (line == null || !Number.isFinite(line) || line <= 0) continue;
    const byPos = a.coef[row.pos];
    if (!byPos) continue;
    const x = a.features.map((s) => weeklyFeatureValue(s, row));
    /** The raw linear predictor of one head. NaN when the head is absent, which the caller turns
     *  into "no projection" rather than into a zero. */
    const lin = (h: string): number => {
      const c = byPos[h];
      if (!c) return NaN;
      let v = c.intercept ?? 0;
      for (let i = 0; i < a.features.length; i++) v += (c[a.features[i].name] ?? 0) * x[i];
      return v;
    };
    const clamped = (h: string): number => {
      const v = lin(h);
      return Number.isFinite(v) ? Math.min(a.clamps.hi, Math.max(a.clamps.lo, v)) : NaN;
    };

    if (!twoPart) {
      const mean = line * clamped("mean");
      if (!Number.isFinite(mean)) continue;
      out.push({
        feat_key: row.feat_key, player_sk: row.player_sk, name: row.name, pos: row.pos,
        season: row.season, week: row.week,
        mean, p10: line * clamped("p10"), p50: line * clamped("p50"), p90: line * clamped("p90"),
      });
      continue;
    }

    // ---- THE TWO-PART MIXTURE. F(y) = pZero + (1 - pZero) * F_played(y). ----
    const z = lin("zero");
    const ratio = clamped("mean");
    if (!Number.isFinite(z) || !Number.isFinite(ratio)) continue;
    const pZero = logistic(z);
    // E[points] = P(he plays) * E[ratio | he plays] * line. The mean head of a two-part artifact is
    // the CONDITIONAL mean, so leaving the (1 - pZero) factor off would project every injured
    // player at his healthy rate -- which is the exact failure the two-part split exists to fix.
    const mean = line * (1 - pZero) * ratio;
    if (!Number.isFinite(mean)) continue;

    // The grid's values, clamped and made non-decreasing. A quantile crossing is a property of
    // fitting each level independently, not a statement about the distribution, and a p50 below p10
    // would silently invert every coverage number downstream.
    const vals: number[] = [];
    let prev = a.clamps.lo;
    for (const g of grid) {
      const v = clamped(gridHead(g));
      const m = Number.isFinite(v) ? Math.max(prev, v) : prev;
      vals.push(m);
      prev = m;
    }
    /** The mixture's q-quantile, in RATIO units. */
    const mixQ = (q: number): number => {
      if (pZero >= 1) return 0;
      const qp = (q - pZero) / (1 - pZero);
      if (!(qp > 0)) return 0;                       // the atom swallows this quantile level entirely
      // Anchored at (0, 0): the conditional distribution's floor is the clamp floor, which is 0.
      if (qp >= grid[grid.length - 1]) return vals[vals.length - 1];
      let lo = 0, loV = 0;
      for (let i = 0; i < grid.length; i++) {
        if (qp <= grid[i]) {
          const span = grid[i] - lo;
          return span > 0 ? loV + (vals[i] - loV) * ((qp - lo) / span) : vals[i];
        }
        lo = grid[i]; loV = vals[i];
      }
      return vals[vals.length - 1];
    };
    out.push({
      feat_key: row.feat_key, player_sk: row.player_sk, name: row.name, pos: row.pos,
      season: row.season, week: row.week,
      mean, p10: line * mixQ(0.10), p50: line * mixQ(0.50), p90: line * mixQ(0.90), pZero,
    });
  }
  return out;
}

/**
 * LOAD AND VALIDATE. An artifact this evaluator cannot FULLY evaluate is REFUSED, loudly.
 *
 * The failure this prevents is the quiet one: a renamed feature, an unknown transform or a missing
 * quantile head all degrade to "that coefficient contributes 0", which produces a slightly different
 * projection and no error at all.
 */
export function loadWeeklyArtifact(json: unknown, opts: { checkGolden?: boolean; tol?: number } = {}): WeeklyArtifact {
  const bad = (m: string): never => { throw new Error(`weekly artifact: ${m}`); };
  const a = json as WeeklyArtifact;
  if (!a || typeof a !== "object") bad("not an object");
  if (a.kind !== "weekly") bad(`kind is ${JSON.stringify(a.kind)}, expected "weekly"`);
  if (Number(a.schema) !== SCHEMA) bad(`schema ${a.schema}, this evaluator understands ${SCHEMA}`);
  if (a.target !== "ratio_to_season_line") bad(`unknown target ${JSON.stringify(a.target)}`);
  if (!["rostered", "played"].includes(a.population)) {
    bad(`population is ${JSON.stringify(a.population)}, expected "rostered" or "played". An artifact ` +
      "that does not say which weeks it was fitted on cannot be checked against the weeks it is scored on.");
  }
  if (!Array.isArray(a.features)) bad("features must be an array");
  const known = new Set<string>(WEEKLY_FEATURE_FIELDS);
  const seen = new Set<string>();
  for (const s of a.features) {
    if (!s || typeof s.name !== "string") bad("a feature has no name");
    if (!known.has(s.name)) {
      bad(`feature ${JSON.stringify(s.name)} is not one this evaluator can compute. ` +
        `Known fields: ${[...known].join(", ")}. A renamed feature must be renamed on BOTH sides -- ` +
        "silently scoring it as zero is how a producer and a consumer stay green while disagreeing.");
    }
    if (seen.has(s.name)) bad(`feature ${s.name} appears twice`);
    seen.add(s.name);
    if (!["identity", "center", "indicator", "ratio_to_line"].includes(s.transform)) {
      bad(`feature ${s.name}: unknown transform ${JSON.stringify(s.transform)}`);
    }
    if (typeof s.missing !== "number" || !Number.isFinite(s.missing)) {
      bad(`feature ${s.name}: 'missing' must be an explicit finite number`);
    }
    if (s.transform === "center" && !(Number(s.scale) > 0)) bad(`feature ${s.name}: 'center' needs a positive scale`);
  }
  // WHICH HEADS THIS ARTIFACT MUST CARRY, decided by the model it says it is. An artifact that
  // declares two-part and ships pooled quantile heads would otherwise load, project through the
  // mixture arithmetic with `zero` missing, and produce no rows at all for every player -- a total
  // failure that looks exactly like an empty week.
  const twoPart = a.zeroModel === "two-part";
  if (a.zeroModel != null && !["quantile", "two-part"].includes(a.zeroModel)) {
    bad(`zeroModel is ${JSON.stringify(a.zeroModel)}, expected "quantile" or "two-part"`);
  }
  let grid: number[] = [];
  if (twoPart) {
    grid = a.quantileGrid ?? [];
    if (!Array.isArray(grid) || grid.length < 3) {
      bad("a two-part artifact must publish its second-stage quantileGrid -- the consumer interpolates " +
        "the mixture on it, and guessing the levels the trainer used is exactly the drift the golden " +
        "block exists to catch");
    }
    for (let i = 0; i < grid.length; i++) {
      if (!(grid[i] > 0 && grid[i] < 1)) bad(`quantileGrid[${i}] = ${grid[i]} is not a quantile level in (0, 1)`);
      if (i && !(grid[i] > grid[i - 1])) bad("quantileGrid must be strictly ascending");
    }
  }
  const requiredHeads = twoPart ? ["zero", "mean", ...grid.map(gridHead)] : (WEEKLY_HEADS as string[]);

  if (!a.coef || typeof a.coef !== "object" || !Object.keys(a.coef).length) bad("no per-position coefficients");
  for (const [pos, heads] of Object.entries(a.coef)) {
    for (const h of requiredHeads) {
      const c = heads?.[h];
      if (!c || typeof c !== "object") {
        bad(`${pos}: no coefficients for head '${h}'. A ${a.zeroModel ?? "quantile"} artifact must ` +
          `carry every one of: ${requiredHeads.join(", ")}`);
      }
      if (typeof c.intercept !== "number") bad(`${pos}.${h}: no intercept`);
      for (const s of a.features) if (typeof c[s.name] !== "number") bad(`${pos}.${h}: no coefficient for feature '${s.name}'`);
      for (const k of Object.keys(c)) if (k !== "intercept" && !seen.has(k)) bad(`${pos}.${h}: coefficient '${k}' names no declared feature`);
    }
  }
  if (!a.clamps || !(a.clamps.lo >= 0) || !(a.clamps.hi > a.clamps.lo)) {
    bad("clamps must be [lo, hi] with lo >= 0 < hi -- lo must be allowed to be exactly 0 so the " +
      "quantile heads can reach the zero atom");
  }
  if (!(Number(a.trainMinLine) >= 0)) bad("trainMinLine must be a non-negative number");
  if (opts.checkGolden !== false && a.golden?.length) checkWeeklyGolden(a, opts.tol ?? 1e-6);
  return a;
}

/** THE CONTRACT TEST, carried ON the artifact. See tools/train_weekly.py for the producing side. */
export function checkWeeklyGolden(a: WeeklyArtifact, tol = 1e-6): void {
  for (const [i, g] of (a.golden ?? []).entries()) {
    const rows = projectWeekly({
      artifact: { ...a, golden: [] },
      rows: [{
        feat_key: `golden-${i}`, player_sk: null, name: `golden-${i}`, pos: g.pos,
        season: 0, week: 0, season_line_pg: g.line, f: g.f,
      }],
    });
    if (!rows.length) throw new Error(`weekly artifact: golden row ${i} (${g.pos}) produced no projection`);
    // pZero is checked too, and NOT optionally: the two-part model's whole claim lives in that
    // number, and a consumer that computed it differently while agreeing on the mean and quantiles
    // to 1e-6 would be a consumer that had reimplemented the mixture backwards and got lucky.
    const heads: (keyof WeeklyProjRow)[] = [...WEEKLY_HEADS, ...(a.zeroModel === "two-part" ? ["pZero" as const] : [])];
    for (const h of heads) {
      const got = rows[0][h] as number, want = g.expect[h];
      if (want == null) {
        throw new Error(`weekly artifact: golden row ${i} (${g.pos}) has no expected value for head '${h}'`);
      }
      if (!(Math.abs(got - want) <= tol)) {
        throw new Error(
          `weekly artifact: golden row ${i} (${g.pos}) head '${h}' -- trainer said ${want}, ` +
          `this evaluator says ${got} (difference ${Math.abs(got - want)}, tolerance ${tol}). ` +
          "The two sides implement the same model differently; do not ship either until they agree.");
      }
    }
  }
}

/**
 * THE SEASON-LINE-ONLY ARTIFACT: every coefficient zero, the mean intercept 1.0, so the projection
 * IS the season line per game. It is the honest floor -- what ships when the trained model fails its
 * gate -- and it exists so that "the weekly model did not beat the baseline" degrades to something
 * stated rather than to something silently worse.
 *
 * `quantiles` are the empirical ratio quantiles where the caller measured them and collapse onto
 * 1.0 where it did not, which says "we have no spread" rather than inventing one.
 */
export function seasonLineOnlyArtifact(opts: {
  positions: string[]; seasons: number[];
  population?: "rostered" | "played";
  quantiles?: Record<string, { p10: number; p50: number; p90: number }>;
}): WeeklyArtifact {
  const coef: WeeklyArtifact["coef"] = {};
  for (const p of opts.positions) {
    const q = opts.quantiles?.[p] ?? { p10: 1, p50: 1, p90: 1 };
    coef[p] = {
      mean: { intercept: 1 }, p10: { intercept: q.p10 },
      p50: { intercept: q.p50 }, p90: { intercept: q.p90 },
    };
  }
  return {
    schema: SCHEMA, kind: "weekly", zeroModel: "quantile",
    fittedFrom: "seasonLineOnlyArtifact (no fitted coefficients)",
    seasons: opts.seasons, holdoutSeason: null, target: "ratio_to_season_line",
    population: opts.population ?? "rostered",
    trainMinLine: 0, features: [], coef, clamps: { lo: 0, hi: 100 },
    notes: "season-line-only: the weekly projection IS the preseason season line per game. The " +
      "floor that ships when a trained artifact fails its gate, so a failed model degrades to " +
      "something stated instead of to something silently worse.",
  };
}
