/**
 * THE MODEL REGISTRY: one place that knows what we have fitted, what it is worth, and whether it is
 * still trustworthy.
 *
 * WHY. Six fitted artifacts drive every number this system produces -- the rank-outcome pools, the
 * variance model, teammate correlation, opponent correlation, the age curve and the opportunity
 * model. Each was loaded ad hoc by whatever consumer needed it, with its own fallback behaviour
 * (some throw, some return null, some silently skip), and the only record of what a model is WORTH
 * lived in a commit message. Two consequences, both real:
 *
 *   - A missing or stale model degrades silently. opportunity-model.json absent means every factor
 *     returns 1 and the board looks completely normal.
 *   - The measured lift drifted from the shipped claim. The age curve was described as +0.0154
 *     R-squared for weeks; nested CV puts it at +0.0069, because the original number came from a
 *     loop that also chose the model's own amplitudes. The honest figure belongs ON the artifact,
 *     not in a commit nobody re-reads.
 *
 * So each model declares its provenance and its HONEST measured lift, and `validateModels` checks
 * the things that would otherwise fail quietly.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dataPath } from "../data/paths.js";

export interface ModelSpec {
  key: string;
  file: string;
  what: string;
  /** Required: the system cannot produce a number without it. */
  required: boolean;
  /** Out-of-sample lift, measured under NESTED cross-validation where one exists. Null = not a
   *  predictive model (a sampler or a variance fit), so a lift figure would be meaningless. */
  nestedLift: number | null;
  /** What was originally claimed, kept so the gap stays visible rather than being quietly edited
   *  away. Null where the two agree or nothing was claimed. */
  claimedLift: number | null;
  check?: (json: Record<string, unknown>) => string | null;
}

export const MODELS: ModelSpec[] = [
  {
    key: "rank-outcomes", file: "rank-outcomes.json", required: true, nestedLift: null, claimedLift: null,
    what: "real weekly outcomes by preseason positional rank -- the bootstrap pools the simulator draws from",
    check: (j) => (j.pos && Object.keys(j.pos as object).length >= 4 ? null : "expected pools for at least 4 positions"),
  },
  {
    key: "variance-model", file: "variance-model.json", required: true, nestedLift: null, claimedLift: null,
    what: "per-position, per-tier weekly CV, skew and availability",
    check: (j) => {
      const pos = j.pos as Record<string, { avail: number[] }> | undefined;
      if (!pos?.RB?.avail?.length) return "RB availability missing";
      // Availability must DECLINE with tier. A flat or rising curve means the fit inverted, and the
      // simulator would treat deep bench players as the most durable on the roster.
      const a = pos.RB.avail;
      return a[0] > a[a.length - 1] ? null : `RB availability does not decline across tiers: ${a.join(", ")}`;
    },
  },
  {
    key: "correlation", file: "correlation-model.json", required: true, nestedLift: null, claimedLift: null,
    what: "same-team teammate correlation, imposed via a Gaussian copula",
    check: (j) => {
      const p = (j.pairs ?? {}) as Record<string, number>;
      const qbwr = p["QB-WR"] ?? p["WR-QB"];
      return typeof qbwr === "number" && qbwr > 0.15 ? null : `QB-WR correlation ${qbwr} is implausibly low (measured +0.348)`;
    },
  },
  {
    key: "opponent-correlation", file: "opponent-correlation.json", required: false, nestedLift: null, claimedLift: null,
    what: "cross-team correlation in the same NFL game -- MEASURED BUT NOT YET WIRED INTO THE SIMULATOR",
  },
  {
    key: "age-curve", file: "age-curve.json", required: false, nestedLift: 0.0069, claimedLift: 0.0154,
    what: "points relative to prior-year rank, by age",
    check: (j) => {
      const pos = j.pos as Record<string, Record<string, number>> | undefined;
      if (!pos) return "no fitted positions";
      // Every multiplier inside the clamp. A value outside it means the amplitude scaling was skipped
      // and the board would move on an unshrunk fit.
      for (const [p, byAge] of Object.entries(pos)) {
        for (const [a, f] of Object.entries(byAge)) {
          if (!(f > 0.7 && f < 1.35)) return `${p} age ${a} multiplier ${f} is outside the clamp`;
        }
      }
      return (j.bySk && Object.keys(j.bySk as object).length > 1000)
        ? null : "bySk map missing or tiny -- the stable-key path is not populated";
    },
  },
  {
    key: "opportunity", file: "opportunity-model.json", required: false, nestedLift: 0.0095, claimedLift: 0.0186,
    what: "prior-season usage relative to rank (first downs, target share)",
    check: (j) => {
      const amp = (j.amplitude ?? {}) as Record<string, number>;
      // QB measured ~0 across 20 seasons. A large QB amplitude means a refit wrote an unmeasured
      // signal straight through, and QB sits at the top of the board where a dollar error is largest.
      if ((amp.QB ?? 0) > 0.15) return `QB amplitude ${amp.QB} -- measured signal is ~0`;
      return (j.bySk && Object.keys(j.bySk as object).length > 1000)
        ? null : "bySk map missing or tiny -- the stable-key path is not populated";
    },
  },
];

/**
 * MODELS THAT WERE BUILT, MEASURED, AND DELIBERATELY NOT SHIPPED.
 *
 * Without this, "K and DST are unfitted" reads as "nobody got round to it", and the next person to
 * notice that a kicker's projection is just his rank-curve value will spend the same week finding
 * the same nothing. A negative result is only worth what it saves, and it saves nothing if it is not
 * written down where the gap is visible.
 */
export const EVALUATED_NOT_SHIPPED = [
  {
    key: "kdst", positions: ["K", "DST"], date: "2026-09-08",
    fitBy: "scripts/fit-kdst.mjs", screenedBy: "scripts/kdst-sweep.mjs",
    nestedLift: { K: -0.0073, DST: -0.0041 },
    naiveLift: { K: -0.0058, DST: 0.0071 },
    why:
      "A screen over the fg_*/pat_* and def_* columns found correlations with the residual (K longAttRate " +
      "+0.128, DST vegasImpliedPts +0.121 among others), and NONE of it survived nested cross-validation. " +
      "DST went from +0.0071 naive to -0.0041 once feature selection happened inside the fold -- a selection " +
      "effect larger than the entire naive lift. K was already negative before nesting. The per-fold picks " +
      "were also unstable: the folds chose fgAtt+avgWind, not the longAttRate+patPct the whole-data screen " +
      "picked, which is what an unstable correlation looks like from the inside. " +
      "The fit harness was verified able to detect a planted signal (R2 0.44 at K, 0.35 at DST) before the " +
      "null was accepted, so this is a measurement and not a silence. " +
      "NOTE THIS DOES NOT MEAN THE SLOTS ARE UNIMPORTANT: kdst-leverage.mjs puts the K slot second only to " +
      "QB in title probability swung on our roster. Both can be true, and together they say something " +
      "useful -- take the best-ranked kicker available and spend no further thought on him, because the " +
      "value is in not carrying a bad one, not in out-predicting the rank.",
  },
] as const;

export interface ModelStatus {
  key: string; file: string; what: string; required: boolean;
  present: boolean; ageDays: number | null; sizeKb: number | null;
  fittedFrom: string | null; seasons: string | null;
  nestedLift: number | null; claimedLift: number | null;
  problem: string | null;
}

export function modelStatus(): ModelStatus[] {
  return MODELS.map((m) => {
    const p = dataPath(m.file);
    if (!existsSync(p)) {
      return { ...m, present: false, ageDays: null, sizeKb: null, fittedFrom: null, seasons: null, problem: m.required ? "MISSING and required" : "missing" };
    }
    const st = statSync(p);
    let json: Record<string, unknown> = {};
    let problem: string | null = null;
    try { json = JSON.parse(readFileSync(p, "utf8")); } catch (e) { problem = `unparseable: ${(e as Error).message}`; }
    if (!problem && m.check) problem = m.check(json);
    const seasons = Array.isArray(json.seasons) ? `${(json.seasons as unknown[]).length} seasons` : null;
    return {
      ...m, present: true,
      ageDays: Math.round((Date.now() - st.mtimeMs) / 864e5),
      sizeKb: Math.round(st.size / 1024),
      fittedFrom: typeof json.fittedFrom === "string" ? json.fittedFrom : null,
      seasons, problem,
    };
  });
}

/** Throws when anything REQUIRED is missing or failing -- for callers that must not run degraded. */
export function validateModels(): void {
  const bad = modelStatus().filter((s) => s.required && (!s.present || s.problem));
  if (bad.length) {
    throw new Error(`model registry: ${bad.map((b) => `${b.key} (${b.problem})`).join("; ")}`);
  }
}
