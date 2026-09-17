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

/**
 * THE BOOSTED HEADS (schema 2 + `learner: "gbm"`; Q1, 2026-09-14). Same machinery as
 * src/model/projector.ts one horizon up, and the same reason it exists: the weekly model was
 * ENTIRELY LINEAR, so every weekly feature had only ever been screened by a linear model. A boosted
 * artifact carries, PER POSITION, the ordered feature names its trees index (the position's POS_GATED
 * `keep` set) and one ensemble per served head. A head's raw value is `baseline + sum over trees of
 * the leaf`, which reproduces scikit-learn's predict() for the regressor heads (mean, the quantile
 * grid) and decision_function() for the `zero` classifier head -- the logit the two-part mixture
 * consumes. The learning rate is folded into the leaf values on the Python side, and the golden block
 * carries the trainer's OWN predictions, so this walker is checked against the producer.
 *
 * The linear `coef` heads are STILL present for every boosted position (the loader requires them and
 * they are the fallback); the boosted heads override them at serve for exactly the heads they name.
 */
export interface WeeklyBoostedTree {
  feature: number[]; threshold: number[]; left: number[]; right: number[];
  value: number[]; leaf: boolean[]; missingLeft: boolean[];
}
export interface WeeklyBoostedHead { baseline: number; trees: WeeklyBoostedTree[] }
export interface WeeklyBoostedPos { features: string[]; heads: Record<string, WeeklyBoostedHead> }
export interface WeeklyBoostedBlock {
  learner: "gbm";
  /** Positions with boosted heads; every one also has linear `coef` heads. */
  positions: string[];
  params?: Record<string, number | string>;
  perPos: Record<string, WeeklyBoostedPos>;
}

/** One tree's leaf value for a REDUCED design vector (the position's own feature order). */
export function weeklyTreeValue(t: WeeklyBoostedTree, x: number[]): number {
  let i = 0;
  for (;;) {
    if (t.leaf[i]) return t.value[i];
    const v = x[t.feature[i]];
    i = Number.isNaN(v) ? (t.missingLeft[i] ? t.left[i] : t.right[i]) : (v <= t.threshold[i] ? t.left[i] : t.right[i]);
  }
}

/** A head's raw (pre-clamp, pre-base) prediction: baseline plus every tree's leaf. */
export function weeklyBoostedRaw(h: WeeklyBoostedHead, x: number[]): number {
  let s = h.baseline;
  for (const t of h.trees) s += weeklyTreeValue(t, x);
  return s;
}

/**
 * THE BAND CALIBRATION (D32, 2026-09-17) -- a MULTIPLICATIVE conformal scale on the served p10/p90,
 * per position, carried ON the artifact and applied here.
 *
 * WHAT IT FIXES. The lineup stress test (docs/lineup-stress-2026-09-17.md, finding 5-a) measured the
 * served band against 23,657 realised rostered player-weeks: coverage 0.814 against a nominal 0.80,
 * which is fine, but the two MISSES are not symmetric -- 11.8% of weeks land above p90 against a
 * nominal 10%, and it is worse at RB (14.2%) and on the bench (13.9%). A band that is short on the
 * upside understates the boom candidate against the safe one, which is exactly the trade a start/sit
 * decision is.
 *
 * WHY MULTIPLICATIVE AND NOT ADDITIVE, AND IT IS THE WHOLE DESIGN. The standard split-conformal
 * correction (D16, the season heads) is ADDITIVE: shift the head by the q-quantile of (y - pred).
 * Applied here it would destroy the thing the two-part model exists for. The published p10 is EXACTLY
 * 0 wherever P(zero week) exceeds 0.10 -- the zero atom -- and 24.6% of the scored rows realise
 * exactly 0. A positive additive offset lifts every one of those p10s off the floor, and every
 * ruled-out man's realised 0 becomes a "below p10" miss: the injury-designated cell would go from
 * 0.0% below p10 to ~100%. A scale leaves 0 at 0 by construction, so the atom survives and the
 * correction acts only where the model claims a non-degenerate bound.
 *
 * SO THE LOWER SIDE IS SOLVED ON THE ROWS WHERE A BOUND IS CLAIMED, and this is stated rather than
 * hidden. With an atom at 0 and a quarter of the population realising exactly 0, P(Y < p10) = 10%
 * pooled is NOT ATTAINABLE and a calibration that chased it would be fitting a target that is wrong:
 * p10 = 0 with P(Y < 0) = 0 is the CORRECT 10th percentile of a distribution with 24.6% of its mass
 * at 0. The offsets solve P(Y > s90*p90) = 0.10 pooled, and P(Y < s10*p10 | p10 > 0) = 0.10 on the
 * rows that claim a positive floor. The pooled lower miss is then 0.10 times the share of rows with
 * p10 > 0, which is a measurement of the atom rather than a defect of the band.
 *
 * WHERE THE NUMBERS COME FROM: TRAIN-ONLY, OUT-OF-FOLD (the D16 pattern). tools/train_weekly.py
 * refits the served stack on player-grouped folds of the TRAINING rows, builds each held-out row's
 * MIXTURE p10/p90 exactly as this file does, and takes the conformal scale from those. Nothing here
 * sees a held-out season, and fitting the scale on the model's own in-sample band -- which is
 * narrower than it will be on unseen rows -- is the error the out-of-fold split exists to avoid.
 *
 * THE MEDIAN AND THE MEAN ARE NOT TOUCHED. This is a statement about the interval, not about the
 * point estimate; a calibration that moved p50 would be a model change wearing a calibration's name,
 * and the promotion gate asserts p50/mean are byte-identical across the swap.
 *
 * ABSENT = THE OLD BAND, BYTE-FOR-BYTE. An artifact with no `bandCalibration`, and a position with
 * no entry in one, serves exactly what it served before -- so an old file keeps its meaning instead
 * of silently claiming a calibration it does not have.
 */
export interface WeeklyBandOffsets {
  /** Multiply the served p10 RATIO by this. 1 = untouched. */
  p10: number;
  /** Multiply the served p90 RATIO by this. 1 = untouched. */
  p90: number;
  /** Out-of-fold rows the scale was solved on, and how many of them claimed a positive p10. */
  n: number;
  nLo?: number;
}
export interface WeeklyBandCalibration {
  /** The only method this evaluator implements. A file naming another one is REFUSED rather than
   *  served through this arithmetic, because a scale and a shift are not interchangeable. */
  method: "conformal-scale";
  /** The two levels the scales were solved for. Recorded so the producer and the consumer cannot
   *  disagree about which tail each offset belongs to. */
  levels: { lo: number; hi: number };
  /** Player-grouped folds used on the TRAINING rows. 0 would mean "not fitted" and is refused. */
  k: number;
  fittedOn?: string;
  /** pos -> scales. A position absent here is served UNCALIBRATED. */
  perPos: Record<string, WeeklyBandOffsets>;
  notes?: string;
}

export interface WeeklyArtifact {
  schema: number;
  kind: "weekly";
  /** WHICH LEARNER PRODUCES THE FITTED POSITIONS' SERVED HEADS. Absent or "linear": the linear `coef`
   *  heads. "gbm": the `boosted` ensembles for the positions they name, linear heads for the rest
   *  (K/DST stay intercept-only). */
  learner?: "linear" | "gbm";
  boosted?: WeeklyBoostedBlock;
  /** Absent means "quantile" -- but a schema-2 artifact always states it. */
  zeroModel?: WeeklyZeroModel;
  /** The quantile levels the SECOND stage was fitted at, ascending. Two-part artifacts only. */
  quantileGrid?: number[];
  /** THE BAND CALIBRATION (D32). Absent on every artifact written before it existed, and an absent
   *  field serves the OLD band byte-for-byte -- see `WeeklyBandCalibration`. */
  bandCalibration?: WeeklyBandCalibration;
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
   *  It is not a serve-time behaviour: a small line still projects, it just projects small.
   *  0 once `rowFilter` is "in_population" -- the line cut is no longer the rule. */
  trainMinLine: number;
  /**
   * WHICH ROWS THE TRAINER SELECTED, and it is the SECOND half of the population contract.
   *
   * `population` above says whether a did-not-play week counted as a zero. This says WHICH PLAYERS
   * were in the set at all, and it is recorded because getting it wrong is invisible: an artifact
   * fitted on `season_line_pg >= 3` and scored on every non-bye row is internally consistent on both
   * sides and off by 0.11 to 0.21 in zero rate between them, which is what failed clause (c) of the
   * weekly gate at RB, WR and TE. See src/weekly/population.ts.
   *
   *   "season_line_pg"  the old cut: `season_line_pg >= trainMinLine`.
   *   "in_population"   the decision population -- rostered, or a plausible pickup. The harness
   *                     filters its scored rows by the SAME flag column, so the two sets are equal
   *                     by construction rather than by agreement.
   *
   * ABSENT on an artifact written before this field existed, and read as "season_line_pg" so an old
   * file keeps its true meaning rather than silently claiming the new one.
   */
  rowFilter?: "season_line_pg" | "in_population";
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

/** The BOOSTED evaluator: identical to weeklyFeatureValue for a PRESENT value, but a MISSING one
 *  returns NaN instead of spec.missing. HistGradientBoosting's trees have a native per-split missing
 *  direction, so feeding NaN lets a boosted head treat "no report" as its own case and fall back on
 *  the always-present anchors -- rather than routing a mean-imputed vector into a leaf that the
 *  all-imputed live-serve combination never trained (the D19 forward-serve collapse). The linear
 *  heads still read weeklyFeatureValue (imputation is correct for an additive model); ONLY the boosted
 *  reduced design uses this. Mirrored, byte-for-byte, by feature_value_nan() in tools/train_weekly.py. */
export function weeklyFeatureValueBoosted(
  spec: WeeklyFeatureSpec, row: { f: WeeklyInputRow["f"]; season_line_pg: number | null },
): number {
  const raw = row.f[spec.name];
  if (raw == null || !Number.isFinite(raw)) return NaN;
  switch (spec.transform) {
    case "identity": return raw;
    case "indicator": return raw ? 1 : 0;
    case "center": {
      const s = spec.scale ?? 1;
      return s === 0 ? NaN : (raw - (spec.center ?? 0)) / s;
    }
    case "ratio_to_line": {
      const line = row.season_line_pg;
      if (line == null || !(line > 0)) return NaN;
      return raw / line;
    }
    default: return NaN;
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
  // The boosted heads serve the positions they name; every other position (and any head a boosted
  // position does not carry) stays linear. `featIdx` maps a feature name to its column in the full
  // design so a position's reduced vector can be built in the boosted head-set's own `features` order.
  const boosted = a.learner === "gbm" ? a.boosted ?? null : null;
  const featIdx = boosted ? new Map<string, number>(a.features.map((s, i) => [s.name, i])) : null;
  // THE BAND CALIBRATION (D32), per position. Null where the artifact carries none, which is every
  // artifact written before the field existed -- and those serve exactly what they served before.
  const bandCal = a.bandCalibration?.perPos ?? null;
  for (const row of rows) {
    const line = row.season_line_pg;
    if (line == null || !Number.isFinite(line) || line <= 0) continue;
    const byPos = a.coef[row.pos];
    if (!byPos) continue;
    const x = a.features.map((s) => weeklyFeatureValue(s, row));
    const bpos = boosted?.perPos[row.pos] ?? null;
    // The boosted reduced design uses the NaN evaluator (native missing handling), NOT the imputed `x`
    // the linear heads read. Built in the boosted head-set's own feature order, once per row. Mirrors
    // tools/train_weekly.py evaluate()'s x_nan/xb.
    const xNan = bpos ? a.features.map((s) => weeklyFeatureValueBoosted(s, row)) : null;
    const xb = bpos && xNan ? bpos.features.map((n) => xNan[featIdx!.get(n)!]) : null;
    /** The raw predictor of one head: the boosted ensemble walk where this position carries a boosted
     *  head, the linear dot product otherwise. NaN when the head is absent, which the caller turns
     *  into "no projection" rather than into a zero. */
    const lin = (h: string): number => {
      if (bpos && xb && bpos.heads[h]) return weeklyBoostedRaw(bpos.heads[h], xb);
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
    /**
     * THE CALIBRATED BAND, in RATIO units (D32). A SCALE, so a p10 sitting on the zero atom stays on
     * it -- see `WeeklyBandCalibration` for why an additive shift is the wrong instrument here.
     * The result is re-clamped to the artifact's own [lo, hi] and is not allowed to cross the median,
     * which is left exactly where the model put it: a quantile crossing introduced BY a calibration
     * would invert every coverage number the calibration exists to fix.
     */
    const cb = bandCal?.[row.pos] ?? null;
    const calBand = (v: number, side: "lo" | "hi", med: number): number => {
      if (!cb || !Number.isFinite(v)) return v;
      const s = side === "lo" ? cb.p10 : cb.p90;
      if (!Number.isFinite(s)) return v;
      const w = Math.min(a.clamps.hi, Math.max(a.clamps.lo, v * s));
      if (!Number.isFinite(med)) return w;
      return side === "lo" ? Math.min(w, med) : Math.max(w, med);
    };

    if (!twoPart) {
      const mean = line * clamped("mean");
      if (!Number.isFinite(mean)) continue;
      const med = clamped("p50");
      out.push({
        feat_key: row.feat_key, player_sk: row.player_sk, name: row.name, pos: row.pos,
        season: row.season, week: row.week,
        mean,
        p10: line * calBand(clamped("p10"), "lo", med),
        p50: line * med,
        p90: line * calBand(clamped("p90"), "hi", med),
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
      mean,
      p10: line * calBand(mixQ(0.10), "lo", mixQ(0.50)),
      p50: line * mixQ(0.50),
      p90: line * calBand(mixQ(0.90), "hi", mixQ(0.50)),
      pZero,
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
  // THE BAND CALIBRATION (D32). Absent is fine and means the old band. PRESENT and malformed is
  // refused rather than partly applied: a scale silently read as 0 collapses the band to the median
  // at that position, and a scale read as 1 is a calibration that is not there -- both produce
  // plausible numbers and neither produces an error.
  if (a.bandCalibration != null) {
    const bc = a.bandCalibration;
    if (bc.method !== "conformal-scale") {
      bad(`bandCalibration.method is ${JSON.stringify(bc.method)}, and this evaluator implements only ` +
        '"conformal-scale" (a MULTIPLICATIVE scale on the p10/p90 ratios). A scale and an additive ' +
        "shift are not interchangeable -- an additive one lifts every p10 off the zero atom -- so a " +
        "file naming another method is refused rather than served through this arithmetic.");
    }
    if (!bc.levels || !(bc.levels.lo > 0 && bc.levels.lo < 1) || !(bc.levels.hi > bc.levels.lo && bc.levels.hi < 1)) {
      bad("bandCalibration.levels must be {lo, hi} quantile levels with 0 < lo < hi < 1");
    }
    if (!(Number(bc.k) >= 2)) bad("bandCalibration.k must be at least 2 -- a calibration fitted in-sample is narrower than the band it corrects, which is the error it exists to remove");
    if (!bc.perPos || typeof bc.perPos !== "object") bad("bandCalibration carries no perPos block");
    for (const [pos, o] of Object.entries(bc.perPos)) {
      if (!a.coef[pos]) bad(`bandCalibration names position ${pos}, which the artifact has no heads for`);
      for (const h of ["p10", "p90"] as const) {
        const v = (o as WeeklyBandOffsets)[h];
        if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) {
          bad(`bandCalibration.perPos.${pos}.${h} must be a finite POSITIVE scale (1 = untouched), got ${JSON.stringify(v)}`);
        }
      }
    }
  }
  if (a.rowFilter != null && !["season_line_pg", "in_population"].includes(a.rowFilter)) {
    bad(`rowFilter is ${JSON.stringify(a.rowFilter)}, expected "season_line_pg" or "in_population". ` +
      "An artifact that does not say which rows it was fitted on cannot be checked against the rows " +
      "it is scored on, and that mismatch is exactly what failed the weekly gate's zero-share clause.");
  }
  // THE BOOSTED BLOCK. A learner that says "gbm" without ensembles, or heads that index outside the
  // position's declared feature list, or a boosted position with no linear fallback heads, is refused
  // -- the same discipline the golden block enforces on arithmetic, applied to structure.
  if (a.learner != null && !["linear", "gbm"].includes(a.learner)) bad(`unknown learner ${JSON.stringify(a.learner)}`);
  if (a.learner === "gbm") {
    const bb = a.boosted;
    if (!bb || bb.learner !== "gbm") bad('learner is "gbm" but the artifact carries no boosted block');
    if (!Array.isArray(bb!.positions) || !bb!.positions.length) bad("boosted block names no positions");
    for (const p of bb!.positions) {
      if (!a.coef[p]) bad(`boosted block names position ${p}, which has no linear fallback heads`);
      const bp = bb!.perPos?.[p];
      if (!bp || !Array.isArray(bp.features) || !bp.heads) bad(`boosted position ${p} has no perPos features/heads`);
      for (const n of bp!.features) if (!seen.has(n)) bad(`boosted position ${p}: feature '${n}' names no declared feature`);
      const width = bp!.features.length;
      // Exactly the heads the served model reads: `zero`, `mean`, and one per grid level for two-part.
      const need = twoPart ? ["zero", "mean", ...grid.map(gridHead)] : (WEEKLY_HEADS as string[]);
      for (const h of need) {
        const bh = bp!.heads[h];
        if (!bh || typeof bh.baseline !== "number" || !Number.isFinite(bh.baseline) || !Array.isArray(bh.trees)) {
          bad(`boosted position ${p} head '${h}' is missing or has no finite baseline`);
        }
        if (!bh.trees.length) bad(`boosted position ${p} head '${h}' has no trees -- a constant wearing a learner's name`);
        for (const [ti, t] of bh.trees.entries()) {
          const n = t.leaf?.length;
          if (!n || [t.feature, t.threshold, t.left, t.right, t.value, t.missingLeft].some((arr) => arr?.length !== n)) {
            bad(`boosted position ${p} head '${h}' tree ${ti}: node arrays disagree about the node count`);
          }
          for (let i = 0; i < n; i++) {
            if (t.leaf[i]) { if (!Number.isFinite(t.value[i])) bad(`boosted ${p}.${h} tree ${ti} node ${i}: non-finite leaf value`); continue; }
            if (!(t.feature[i] >= 0 && t.feature[i] < width)) bad(`boosted ${p}.${h} tree ${ti} node ${i}: feature index ${t.feature[i]} outside the ${width}-wide reduced design`);
            if (!(t.left[i] >= 0 && t.left[i] < n && t.right[i] >= 0 && t.right[i] < n)) bad(`boosted ${p}.${h} tree ${ti} node ${i}: child index out of range`);
            if (!Number.isFinite(t.threshold[i])) bad(`boosted ${p}.${h} tree ${ti} node ${i}: non-finite threshold`);
          }
        }
      }
    }
  } else if (a.boosted) {
    bad('the artifact carries a boosted block but does not declare learner "gbm" -- one of the two is a leftover');
  }
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
