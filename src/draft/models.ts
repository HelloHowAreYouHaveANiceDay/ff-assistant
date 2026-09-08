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
    what: "real player-SEASON trajectories by preseason positional rank (schema 2) -- the pools the " +
      "simulator draws whole seasons from, so injuries, busts and breakouts persist across weeks",
    check: (j) => {
      if (Number(j.schema) < 2) {
        return "schema 1 -- this file stores a FLAT bag of weekly scores per rank, which forces the " +
          "simulator to draw weeks independently and understates season-total spread by 1.6-2.8x " +
          "(RB1 sd 47 against a real 108). Refit with scripts/fit-bootstrap.mjs.";
      }
      const pos = (j.pos ?? {}) as Record<string, Record<string, unknown>>;
      if (Object.keys(pos).length < 4) return "expected pools for at least 4 positions";
      // KEYED ON THE SHAPE, not just the version number. A file could carry `schema: 2` and still
      // hold schema-1 contents -- a hand-edited field, or a fitter half-migrated -- and the version
      // alone cannot tell those apart. Every pool entry must be an ARRAY of trajectories.
      for (const [p, byRank] of Object.entries(pos)) {
        const first = Object.values(byRank)[0];
        if (!Array.isArray(first) || !Array.isArray(first[0])) {
          return `${p} pools are not arrays of trajectories -- schema 2 stores one array per ` +
            `player-season, schema 1 stored a flat list of weekly scores`;
        }
      }
      return null;
    },
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
    what: "prior-season usage relative to rank -- per position: QB attempts+rush yards, others first downs+target share",
    check: (j) => {
      const pos = (j.pos ?? {}) as Record<string, { feats?: string[] } | null>;
      if (Number(j.schema) < 2) {
        return "schema 1 -- this file measures a quarterback's workload with target share and receiving " +
          "first downs, which he has none of. Refit with scripts/fit-opportunity.mjs.";
      }
      // THE GUARD THAT REPLACED A WRONG ONE. This slot previously read `if (amp.QB > 0.15) return
      // "QB amplitude -- measured signal is ~0"`, which enforced an artifact: the ~0 came from
      // measuring QB usage with receiver columns, so the guard's job was to keep the fix out. Keyed
      // on a MAGNITUDE, it could not tell a bad refit from a corrected one.
      //
      // Keyed instead on the thing itself: a quarterback must not be scored on pass-catching
      // columns. That is a signal the broken case is structurally incapable of satisfying, and it
      // stays correct whatever the amplitude turns out to be on the next refit.
      const qb = pos.QB?.feats ?? [];
      if (qb.some((f) => f === "ts" || f === "fd")) {
        return `QB is being scored on ${qb.join("+")} -- target share and receiving first downs describe a pass catcher, not a passer`;
      }
      if (!qb.includes("attempts")) return `QB features ${qb.join("+") || "(none)"} do not include passing volume`;
      // The pass catchers must NOT have been switched onto the passing columns by the same edit.
      for (const p of ["RB", "WR", "TE"]) {
        const f = pos[p]?.feats ?? [];
        if (f.length && !f.includes("ts")) return `${p} features ${f.join("+")} -- expected target share`;
      }
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
