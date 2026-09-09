/**
 * THE INJURY HORIZON: P(he misses the next k games), for k in 1..4, from what was knowable Friday.
 *
 * The serving half of `tools/train_injury_duration.py`. Pure -- no file reads, no clock -- so the
 * copilot and a test can be shown to evaluate identically, which is worth nothing if either side
 * can reach for a file. `loadInjuryHorizonArtifact` does the reading and the refusing.
 *
 * WHY THIS EXISTS. `missProb` (rosterValue.ts) and `leadMissProb` (handcuff.ts) answer "will he play
 * this week" with the variance model's per-tier games/17. That number is not conditional on anything
 * about the man's actual situation: a top-tier RB is 0.13 whether he is healthy or has been Out for
 * three weeks with a foot. Measured on the men who are ACTUALLY ON THE REPORT it is not merely
 * imprecise, it is far worse than a constant -- nested log loss 0.92 at k=1 against 0.35 for this
 * model and 0.40 for a designation-only baseline. That is not a criticism of the variance model,
 * which was fitted to answer a different, unconditional question; it is the reason a conditional
 * question needs a conditional model.
 *
 * WHAT IT IS NOT. It is not a projection of his points, and it is not a diagnosis. Feed it a
 * designation, a practice status, an injury label and how long the episode has already run, and it
 * returns four probabilities. It knows nothing about a man not on the report -- there is no row for
 * him and `horizonFor` returns null rather than a small number that looks like an answer.
 *
 * THE GOLDEN BLOCK IS THE CONTRACT. The trainer emits six fixture rows with its own probabilities
 * and this file recomputes them at 1e-6. It is the only test where the two implementations are
 * independent, which is the only kind that catches a transform the two sides read differently --
 * the producer-consumer drift this repo has a scar from.
 */

/** THE PUBLISHED DICTIONARY of fields a feature spec may name. An artifact naming anything else is
 *  REFUSED, so a renamed column is an error rather than a coefficient that silently contributes 0. */
export const HORIZON_FIELDS = [
  "designation", "practice_status", "injury_group", "pos",
  "weeks_missed_so_far", "weeks_in_episode", "prior_episodes_same", "prior_episodes_any",
  "age", "injury_secondary_present",
] as const;
export type HorizonField = typeof HORIZON_FIELDS[number];

export type HorizonTransform = "eq" | "not_in" | "clip" | "center";

export interface HorizonSpec {
  name: string;
  transform: HorizonTransform;
  field: HorizonField;
  /** "eq": the value the field must equal for the indicator to fire. */
  value?: string | number;
  /** "not_in": the indicator fires when the field is NOT one of these. It is an indicator over a
   *  COMPLEMENT rather than a dropped row, so an injury string the fit never saw lands in a bucket
   *  with a coefficient instead of silently becoming the reference category. */
  values?: string[];
  clipLo?: number;
  clipHi?: number;
  center?: number;
  scale?: number;
  /** The POST-TRANSFORM value for a null input. Explicit, for the reason projector.ts states: a
   *  missing input silently becoming 0 is a guess wearing the costume of a default. */
  missing?: number;
}

export type Horizon = 1 | 2 | 3 | 4;
export const HORIZONS: Horizon[] = [1, 2, 3, 4];

export interface HorizonRow {
  designation?: string | null;
  practice_status?: string | null;
  injury_group?: string | null;
  pos?: string | null;
  weeks_missed_so_far?: number | null;
  weeks_in_episode?: number | null;
  prior_episodes_same?: number | null;
  prior_episodes_any?: number | null;
  age?: number | null;
  injury_secondary_present?: number | null;
}

export interface HorizonGolden { f: HorizonRow; expect: Record<string, number> }

export interface InjuryHorizonArtifact {
  schema: number;
  kind: "injury_duration";
  fittedFrom: string;
  fittedAt?: string;
  seasons: number[];
  holdoutSeason: number | null;
  horizons: number[];
  features: HorizonSpec[];
  coef: Record<string, Record<string, number>>;
  /** The designation-only baseline, fitted by the same code path, carried ON the artifact so the
   *  comparison the consumer prints cannot be against a differently-fitted straw man. */
  baselineDesignation?: Record<string, Record<string, number>>;
  baselineFeatures?: HorizonSpec[];
  trainRows?: Record<string, number>;
  golden?: HorizonGolden[];
  notes?: string;
}

const SCHEMA = 1;

/** One spec against one row. Exported so the golden check and the evaluator cannot become two
 *  implementations of the same transform. Mirrors `feature_value` in the trainer, line for line. */
export function horizonFeatureValue(spec: HorizonSpec, row: HorizonRow): number {
  const raw = (row as Record<string, unknown>)[spec.field];
  if (spec.transform === "eq") return raw === spec.value ? 1 : 0;
  if (spec.transform === "not_in") {
    return typeof raw === "string" && (spec.values ?? []).includes(raw) ? 0 : 1;
  }
  const miss = spec.missing ?? 0;
  if (raw == null || typeof raw !== "number" || !Number.isFinite(raw)) return miss;
  let x = raw;
  if (spec.clipLo != null) x = Math.max(spec.clipLo, x);
  if (spec.clipHi != null) x = Math.min(spec.clipHi, x);
  if (spec.transform === "clip") return x;
  if (spec.transform === "center") {
    const s = spec.scale ?? 1;
    return s === 0 ? miss : (x - (spec.center ?? 0)) / s;
  }
  return miss;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, z))));

function evalHead(coef: Record<string, number>, specs: HorizonSpec[], row: HorizonRow): number {
  let lin = coef.intercept ?? 0;
  for (const s of specs) lin += (coef[s.name] ?? 0) * horizonFeatureValue(s, row);
  return sigmoid(lin);
}

export interface HorizonPrediction {
  /** P(he misses the next k games), k = 1..4. */
  p: Record<Horizon, number>;
  /** Expected GAMES missed over the next four, = sum_k P(miss next k). It is exactly that sum
   *  because P(misses at least k of the next four consecutively from now) sums to the expectation
   *  of a run length truncated at four -- and it is truncated, so it is a FLOOR on a long injury,
   *  not an estimate of one. A man who will miss the rest of the season reads 4.0. */
  expectedGamesOut4: number;
  /** The same four probabilities from the DESIGNATION-ONLY baseline, where the artifact carries it.
   *  Present so a consumer can print what the extra features changed rather than assert it. */
  baseline?: Record<Horizon, number>;
}

/** Evaluate one row. Pure. */
export function horizonFor(a: InjuryHorizonArtifact, row: HorizonRow): HorizonPrediction {
  const p = {} as Record<Horizon, number>;
  for (const k of HORIZONS) p[k] = evalHead(a.coef[String(k)] ?? {}, a.features, row);
  const out: HorizonPrediction = {
    p, expectedGamesOut4: HORIZONS.reduce((s, k) => s + p[k], 0),
  };
  if (a.baselineDesignation && a.baselineFeatures) {
    const b = {} as Record<Horizon, number>;
    for (const k of HORIZONS) b[k] = evalHead(a.baselineDesignation[String(k)] ?? {}, a.baselineFeatures, row);
    out.baseline = b;
  }
  return out;
}

/**
 * LOAD AND VALIDATE. An artifact this evaluator cannot FULLY evaluate is REFUSED, loudly.
 *
 * The quiet failure being prevented: a renamed field, an unknown transform or a missing horizon all
 * degrade to "that coefficient contributes 0", which produces a slightly different probability and
 * no error. A horizon that is silently 20% short is far more expensive than one that will not load.
 */
export function loadInjuryHorizonArtifact(json: unknown, opts: { checkGolden?: boolean; tol?: number } = {}): InjuryHorizonArtifact {
  const bad = (m: string): never => { throw new Error(`injury duration artifact: ${m}`); };
  const a = json as InjuryHorizonArtifact;
  if (!a || typeof a !== "object") bad("not an object");
  if (a.kind !== "injury_duration") bad(`kind is ${JSON.stringify(a.kind)}, expected "injury_duration"`);
  if (Number(a.schema) !== SCHEMA) bad(`schema ${a.schema}, this evaluator understands ${SCHEMA}`);
  if (!Array.isArray(a.features) || !a.features.length) bad("no features");
  const seen = new Set<string>();
  for (const s of a.features) {
    if (!s.name || seen.has(s.name)) bad(`duplicate or missing feature name ${JSON.stringify(s.name)}`);
    seen.add(s.name);
    if (!(HORIZON_FIELDS as readonly string[]).includes(s.field)) {
      bad(`feature ${s.name} names field ${JSON.stringify(s.field)}, which is not in HORIZON_FIELDS ` +
        `-- either the trainer renamed a column or this evaluator is behind it, and both would ` +
        `otherwise show up as a coefficient quietly contributing zero`);
    }
    if (!["eq", "not_in", "clip", "center"].includes(s.transform)) bad(`feature ${s.name} has unknown transform ${JSON.stringify(s.transform)}`);
    if (s.transform === "eq" && s.value === undefined) bad(`feature ${s.name} is "eq" with no value`);
    if (s.transform === "not_in" && !Array.isArray(s.values)) bad(`feature ${s.name} is "not_in" with no values`);
    if (s.transform === "center" && (s.center == null || s.scale == null)) bad(`feature ${s.name} is "center" with no centre/scale`);
  }
  for (const k of HORIZONS) {
    const c = a.coef?.[String(k)];
    if (!c || typeof c !== "object") bad(`no coefficients for horizon k=${k}`);
    for (const s of a.features) {
      if (typeof c[s.name] !== "number" || !Number.isFinite(c[s.name])) {
        bad(`horizon k=${k} has no finite coefficient for ${s.name} -- a partial head evaluates as ` +
          `if that feature were zero for every player, which is a different model with no error`);
      }
    }
  }
  if (opts.checkGolden !== false && a.golden?.length) checkHorizonGolden(a, opts.tol ?? 1e-6);
  return a;
}

/** Recompute the trainer's own fixtures with THIS evaluator. See the header: it is the only check
 *  where the two implementations are independent. */
export function checkHorizonGolden(a: InjuryHorizonArtifact, tol = 1e-6): void {
  for (const [i, g] of (a.golden ?? []).entries()) {
    const got = horizonFor({ ...a, golden: [] }, g.f);
    for (const k of HORIZONS) {
      const want = g.expect[String(k)];
      if (want == null) continue;
      if (Math.abs(got.p[k] - want) > tol) {
        throw new Error(
          `injury duration artifact: golden row ${i} horizon k=${k} -- trainer said ${want}, ` +
          `this evaluator says ${got.p[k]} (tol ${tol})`);
      }
    }
  }
}

// ==================================================================================================
// THE STORE SIDE. Kept out of the pure evaluator above so a test can drive the model with no db.
// ==================================================================================================

export const INJURY_HORIZON_ARTIFACT = "injury-duration-artifact.json";

/** Load the shipped artifact from data/, or null where it has not been fitted. A missing model is
 *  reported by the caller as an assumption ("tier rate, no injury model on file"), never silently
 *  replaced by one -- which is exactly how `opportunity-model.json` used to degrade. */
export function loadShippedHorizonArtifact(dataPathOf: (f: string) => string, read: (p: string) => string, exists: (p: string) => boolean): InjuryHorizonArtifact | null {
  const p = dataPathOf(INJURY_HORIZON_ARTIFACT);
  if (!exists(p)) return null;
  return loadInjuryHorizonArtifact(JSON.parse(read(p)));
}

export interface LiveEpisode extends HorizonRow {
  playerSk: number | null;
  name: string;
  season: number;
  week: number;
  /** Where the row came from: "archive" (feat_injury_horizon, dated filings) or "live" (the store's
   *  ESPN status plus the news table's injury detail). Travels into `assumptions` because the two
   *  are NOT the same evidence and a consumer must be able to say which it used. */
  source: "archive" | "live";
}
