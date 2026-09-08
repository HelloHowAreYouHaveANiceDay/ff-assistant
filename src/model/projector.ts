/**
 * ONE PROJECTOR. A pure function from (artifact, feature rows) to projections, called by the board
 * and by the backtest so that neither can quietly project differently from the other.
 *
 * WHAT WAS WRONG. The shipped projection was a curve looked up by rank and then multiplied by two
 * hand-built factors, each with its own fit script, its own artifact, its own clamp and its own
 * amplitude -- and each APPLIED BY THE CONSUMER. `projections.ts` multiplied age and opportunity in;
 * so, separately and with slightly different arguments, did `cmdBacktest`. Adding a third feature
 * meant a third fit script, a third artifact, and a third pair of call sites to keep in step. The
 * modelling side could not absorb a feature, which is the actual reason the measurement loop kept
 * finding things nobody could ship.
 *
 * THE CONTRACT. `projectSeason` reads nothing from disk and makes no network call. Everything it
 * needs arrives as an argument, which is what lets two callers be tested against each other for
 * byte-identical output -- a test that is worth nothing if either side can reach for a file.
 *
 * THE MODEL FORM is deliberately small enough to evaluate here in a dot product: a per-position
 * linear predictor over NAMED features, clamped, multiplying a BASE column that the feature row
 * carries (the point-in-time curve value). Quantiles are three more coefficient vectors of the same
 * shape. Anything that needed a tree ensemble would need an evaluator shipped beside it and a golden
 * test to prove the two agree, and the artifact schema says so out loud.
 */

/** THE PUBLISHED DICTIONARY of feature fields. An artifact naming anything not in here is REFUSED.
 *  This is the check that a name-keyed contract cannot pass by accident: the trainer emits names,
 *  and they are validated against the consumer's own list rather than against a symptom. */
export const FEATURE_FIELDS = [
  "age", "prior_pos_rank", "prior_pts", "prior_games",
  "prior_fd", "prior_ts", "prior_attempts", "prior_rush_yards",
  "prior_air_yards_share", "prior_wopr",
  "team_changed", "draft_round", "draft_pick", "draft_age",
  "ecr_pos_rank", "ecr_sd",
] as const;
export type FeatureField = typeof FEATURE_FIELDS[number];

/** The multiplicative-stage fields. Kept separate from FEATURE_FIELDS because they are not
 *  regression inputs -- they are already-fitted multipliers, and mixing the two vocabularies is how
 *  a factor ends up applied twice. */
export const FACTOR_FIELDS = ["age_factor", "opp_factor"] as const;
export type FactorField = typeof FACTOR_FIELDS[number];

export interface FeatureRow {
  player_sk: string | null;
  name: string;
  pos: string;
  /** The point-in-time curve value this projection is scaled from. Null = no curve at this rank, and
   *  the row produces no projection rather than a zero that looks like a real one. */
  base: number | null;
  /** The within-position rank the base was read at -- the bucket key for relative features. */
  rank: number | null;
  f: Partial<Record<FeatureField, number | null>>;
  factors: Record<FactorField, number>;
}

export type Head = "mean" | "p10" | "p50" | "p90";
export const HEADS: Head[] = ["mean", "p10", "p50", "p90"];

export type Transform = "identity" | "center" | "ratio_to_bucket_mean" | "indicator";

export interface FeatureSpec {
  name: FeatureField;
  transform: Transform;
  /** center/scale for "center". A scale of 0 is refused rather than dividing by it. */
  center?: number;
  scale?: number;
  /** For "ratio_to_bucket_mean": pos -> bucket index -> mean, plus the bucket width and the floor
   *  below which the denominator is meaningless rather than small. */
  bucketMeans?: Record<string, Record<string, number>>;
  bucket?: number;
  floor?: number;
  /** The POST-TRANSFORM value used when the input is null. Required, and required to be explicit:
   *  a missing input silently becoming 0 means "this player is two standard deviations young"
   *  wherever the feature is centred, which is a guess wearing the costume of a default. */
  missing: number;
}

export interface ProjectionArtifact {
  schema: number;
  kind: "projection";
  fittedFrom: string;
  fittedAt?: string;
  seasons: number[];
  holdoutSeason: number | null;
  /** Which curve column the feature loader must put in `base`. Recorded on the artifact so the
   *  loader and the trainer cannot disagree about what the offset was. */
  base: "curve_value_prior" | "curve_value_ecr" | "curve_value_orderstat";
  features: FeatureSpec[];
  /** Factor fields multiplied in AFTER the linear stage, in this order. The curve-only artifact
   *  declares both, which is exactly what the pre-Phase-2a board did; a trained artifact that
   *  regresses on age declares neither, because doing both would apply age twice. */
  multiplicative: FactorField[];
  coef: Record<string, Record<Head, Record<string, number>>>;
  clamps: { lo: number; hi: number };
  golden?: GoldenRow[];
  notes?: string;
}

export interface GoldenRow {
  pos: string;
  base: number;
  rank: number | null;
  f: Partial<Record<FeatureField, number | null>>;
  factors?: Partial<Record<FactorField, number>>;
  expect: Record<Head, number>;
}

export interface ProjRow {
  player_sk: string | null;
  name: string;
  pos: string;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

const SCHEMA = 1;

/** Evaluate one feature spec against one row. Exported so the golden check and the projector cannot
 *  drift into two implementations of the same transform. */
export function featureValue(spec: FeatureSpec, row: { f: FeatureRow["f"]; pos: string; rank: number | null }): number {
  const raw = row.f[spec.name];
  if (raw == null || !Number.isFinite(raw)) return spec.missing;
  switch (spec.transform) {
    case "identity": return raw;
    case "indicator": return raw ? 1 : 0;
    case "center": {
      const s = spec.scale ?? 1;
      return s === 0 ? spec.missing : (raw - (spec.center ?? 0)) / s;
    }
    case "ratio_to_bucket_mean": {
      if (row.rank == null || !spec.bucketMeans || !spec.bucket) return spec.missing;
      const b = Math.floor((row.rank - 1) / spec.bucket);
      const m = spec.bucketMeans[row.pos]?.[String(b)];
      // A bucket whose typical usage is at or below the floor makes the ratio explode, and for a
      // position/rank where nobody sees that kind of work it is meaningless rather than large.
      if (m == null || !(m > (spec.floor ?? 0))) return spec.missing;
      return raw / m;
    }
    default: return spec.missing;
  }
}

/**
 * THE PROJECTOR. Pure: no file reads, no network, no clock.
 *
 * A row with no `base` produces NO projection at all rather than a zero. A zero projection is a real
 * number that flows into VOR, the baselines and the auction book; "we have no curve at this rank" is
 * not a projection of zero points and must not be recorded as one.
 */
export function projectSeason(opts: {
  season: number;
  asOf: string;
  artifact: ProjectionArtifact;
  features: FeatureRow[];
}): ProjRow[] {
  const { artifact: a, features } = opts;
  const out: ProjRow[] = [];
  for (const row of features) {
    if (row.base == null || !Number.isFinite(row.base) || row.base <= 0) continue;
    const byPos = a.coef[row.pos];
    if (!byPos) continue;                       // the artifact has no opinion about this position
    const x = a.features.map((s) => featureValue(s, row));
    let mult = 1;
    for (const k of a.multiplicative) {
      const v = row.factors[k];
      mult *= Number.isFinite(v) && v > 0 ? v : 1;
    }
    const head = (h: Head): number => {
      const c = byPos[h];
      if (!c) return NaN;
      let lin = c.intercept ?? 0;
      for (let i = 0; i < a.features.length; i++) lin += (c[a.features[i].name] ?? 0) * x[i];
      const clamped = Math.min(a.clamps.hi, Math.max(a.clamps.lo, lin));
      return row.base! * clamped * mult;
    };
    const mean = head("mean");
    if (!Number.isFinite(mean)) continue;
    out.push({
      player_sk: row.player_sk, name: row.name, pos: row.pos,
      mean, p10: head("p10"), p50: head("p50"), p90: head("p90"),
    });
  }
  return out;
}

/**
 * LOAD AND VALIDATE. An artifact the evaluator cannot FULLY evaluate is REFUSED, loudly.
 *
 * The failure this prevents is the quiet one: a renamed feature, an unknown transform or a missing
 * quantile head all degrade to "that coefficient contributes 0", which produces a slightly different
 * projection and no error at all. A projection that is silently 4% low is far more expensive than
 * one that refuses to load.
 */
export function loadArtifact(json: unknown, opts: { checkGolden?: boolean; tol?: number } = {}): ProjectionArtifact {
  const bad = (m: string): never => { throw new Error(`projection artifact: ${m}`); };
  const a = json as ProjectionArtifact;
  if (!a || typeof a !== "object") bad("not an object");
  if (a.kind !== "projection") bad(`kind is ${JSON.stringify(a.kind)}, expected "projection"`);
  if (Number(a.schema) !== SCHEMA) bad(`schema ${a.schema}, this evaluator understands ${SCHEMA}`);
  if (!["curve_value_prior", "curve_value_ecr", "curve_value_orderstat"].includes(a.base)) bad(`unknown base column ${JSON.stringify(a.base)}`);
  if (!Array.isArray(a.features)) bad("features must be an array");
  const known = new Set<string>(FEATURE_FIELDS);
  const seen = new Set<string>();
  for (const s of a.features) {
    if (!s || typeof s.name !== "string") bad("a feature has no name");
    if (!known.has(s.name)) {
      bad(`feature ${JSON.stringify(s.name)} is not one this evaluator can compute. ` +
        `Known fields: ${[...known].join(", ")}. A renamed feature must be renamed on BOTH sides ` +
        `-- silently scoring it as zero is how a producer and a consumer stay green while disagreeing.`);
    }
    if (seen.has(s.name)) bad(`feature ${s.name} appears twice`);
    seen.add(s.name);
    if (!["identity", "center", "ratio_to_bucket_mean", "indicator"].includes(s.transform)) bad(`feature ${s.name}: unknown transform ${JSON.stringify(s.transform)}`);
    if (typeof s.missing !== "number" || !Number.isFinite(s.missing)) bad(`feature ${s.name}: 'missing' must be an explicit finite number`);
    if (s.transform === "center" && !(Number(s.scale) > 0)) bad(`feature ${s.name}: 'center' transform needs a positive scale`);
    if (s.transform === "ratio_to_bucket_mean" && (!s.bucketMeans || !(Number(s.bucket) > 0))) bad(`feature ${s.name}: 'ratio_to_bucket_mean' needs bucketMeans and a bucket width`);
  }
  for (const k of a.multiplicative ?? []) {
    if (!(FACTOR_FIELDS as readonly string[]).includes(k)) bad(`multiplicative stage names ${JSON.stringify(k)}, which is not a factor field`);
  }
  if (!a.coef || typeof a.coef !== "object" || !Object.keys(a.coef).length) bad("no per-position coefficients");
  for (const [pos, heads] of Object.entries(a.coef)) {
    for (const h of HEADS) {
      const c = heads?.[h];
      if (!c || typeof c !== "object") bad(`${pos}: no coefficients for head '${h}' -- every artifact must produce a mean and three quantiles`);
      if (typeof c.intercept !== "number") bad(`${pos}.${h}: no intercept`);
      for (const s of a.features) {
        if (typeof c[s.name] !== "number") bad(`${pos}.${h}: no coefficient for feature '${s.name}'`);
      }
      for (const k of Object.keys(c)) {
        if (k !== "intercept" && !seen.has(k)) bad(`${pos}.${h}: coefficient '${k}' names no declared feature`);
      }
    }
  }
  if (!a.clamps || !(a.clamps.lo > 0) || !(a.clamps.hi >= a.clamps.lo)) bad("clamps must be a positive [lo, hi]");
  if (opts.checkGolden !== false && a.golden?.length) checkGolden(a, opts.tol ?? 1e-6);
  return a;
}

/**
 * THE CONTRACT TEST, carried ON the artifact.
 *
 * The trainer writes five fixture rows together with its OWN predictions for them. Running them back
 * through this evaluator is the only thing that can catch a Python-side transform the TypeScript side
 * implements differently -- which is the exact failure mode of a producer that ships its own
 * validator: it grades its own homework and passes forever while every consumer rejects its output.
 */
export function checkGolden(a: ProjectionArtifact, tol = 1e-6): void {
  for (const [i, g] of (a.golden ?? []).entries()) {
    const rows = projectSeason({
      season: 0, asOf: "", artifact: { ...a, golden: [] },
      features: [{
        player_sk: null, name: `golden-${i}`, pos: g.pos, base: g.base, rank: g.rank ?? null,
        f: g.f,
        factors: {
          age_factor: g.factors?.age_factor ?? 1,
          opp_factor: g.factors?.opp_factor ?? 1,
        },
      }],
    });
    if (!rows.length) throw new Error(`projection artifact: golden row ${i} (${g.pos}) produced no projection`);
    for (const h of HEADS) {
      const got = rows[0][h], want = g.expect[h];
      if (!(Math.abs(got - want) <= tol)) {
        throw new Error(
          `projection artifact: golden row ${i} (${g.pos}) head '${h}' -- trainer said ${want}, ` +
          `this evaluator says ${got} (difference ${Math.abs(got - want)}, tolerance ${tol}). ` +
          `The two sides implement the same model differently; do not ship either until they agree.`);
      }
    }
  }
}

/** The curve-only artifact: every non-intercept coefficient zero, the two shipped multipliers in the
 *  multiplicative stage. It reproduces the pre-Phase-2a board exactly, and it is what the projector
 *  falls back to ON PURPOSE rather than degrading silently -- `project()` refuses to run without an
 *  artifact at all, and this is the honest floor to hand it. */
export function curveOnlyArtifact(opts: {
  positions: string[]; seasons: number[];
  base?: ProjectionArtifact["base"];
  quantiles?: Record<string, { p10: number; p50: number; p90: number }>;
}): ProjectionArtifact {
  const coef: ProjectionArtifact["coef"] = {};
  for (const p of opts.positions) {
    const q = opts.quantiles?.[p] ?? { p10: 1, p50: 1, p90: 1 };
    coef[p] = {
      mean: { intercept: 1 },
      p10: { intercept: q.p10 },
      p50: { intercept: q.p50 },
      p90: { intercept: q.p90 },
    };
  }
  return {
    schema: SCHEMA, kind: "projection", fittedFrom: "curveOnlyArtifact (no fitted coefficients)",
    seasons: opts.seasons, holdoutSeason: null, base: opts.base ?? "curve_value_ecr",
    features: [], multiplicative: ["age_factor", "opp_factor"],
    coef, clamps: { lo: 0.01, hi: 100 },
    notes: "curve-only: the projection IS the point-in-time curve, times the shipped age and " +
      "opportunity multipliers. Quantile intercepts are ratio quantiles of actual/curve where the " +
      "caller supplied them and 1.0 where it did not, in which case the three quantiles collapse " +
      "onto the mean and say so rather than inventing a spread.",
  };
}
