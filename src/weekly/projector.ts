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
 * THE ZERO ATOM, and the choice, stated out loud. Weekly fantasy points are zero-inflated even
 * among players who dressed: a receiver with no catches scores zero, and about a fifth of played
 * weeks land near it. Two treatments are defensible -- a two-part model (probability of a zero week
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

export interface WeeklyArtifact {
  schema: number;
  kind: "weekly";
  fittedFrom: string;
  fittedAt?: string;
  seasons: number[];
  holdoutSeason: number | null;
  /** The denominator. Recorded so the loader and the trainer cannot disagree about what the ratio
   *  was a ratio TO. */
  target: "ratio_to_season_line";
  /** Season lines below this were excluded from TRAINING (the ratio is noise over a small number).
   *  It is not a serve-time behaviour: a small line still projects, it just projects small. */
  trainMinLine: number;
  features: WeeklyFeatureSpec[];
  coef: Record<string, Record<WeeklyHead, Record<string, number>>>;
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
  expect: Record<WeeklyHead, number>;
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

const SCHEMA = 1;

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
  const out: WeeklyProjRow[] = [];
  for (const row of rows) {
    const line = row.season_line_pg;
    if (line == null || !Number.isFinite(line) || line <= 0) continue;
    const byPos = a.coef[row.pos];
    if (!byPos) continue;
    const x = a.features.map((s) => weeklyFeatureValue(s, row));
    const head = (h: WeeklyHead): number => {
      const c = byPos[h];
      if (!c) return NaN;
      let lin = c.intercept ?? 0;
      for (let i = 0; i < a.features.length; i++) lin += (c[a.features[i].name] ?? 0) * x[i];
      return line * Math.min(a.clamps.hi, Math.max(a.clamps.lo, lin));
    };
    const mean = head("mean");
    if (!Number.isFinite(mean)) continue;
    out.push({
      feat_key: row.feat_key, player_sk: row.player_sk, name: row.name, pos: row.pos,
      season: row.season, week: row.week,
      mean, p10: head("p10"), p50: head("p50"), p90: head("p90"),
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
  if (!a.coef || typeof a.coef !== "object" || !Object.keys(a.coef).length) bad("no per-position coefficients");
  for (const [pos, heads] of Object.entries(a.coef)) {
    for (const h of WEEKLY_HEADS) {
      const c = heads?.[h];
      if (!c || typeof c !== "object") bad(`${pos}: no coefficients for head '${h}' -- every artifact must produce a mean and three quantiles`);
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
    for (const h of WEEKLY_HEADS) {
      const got = rows[0][h], want = g.expect[h];
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
    schema: SCHEMA, kind: "weekly", fittedFrom: "seasonLineOnlyArtifact (no fitted coefficients)",
    seasons: opts.seasons, holdoutSeason: null, target: "ratio_to_season_line",
    trainMinLine: 0, features: [], coef, clamps: { lo: 0, hi: 100 },
    notes: "season-line-only: the weekly projection IS the preseason season line per game. The " +
      "floor that ships when a trained artifact fails its gate, so a failed model degrades to " +
      "something stated instead of to something silently worse.",
  };
}
