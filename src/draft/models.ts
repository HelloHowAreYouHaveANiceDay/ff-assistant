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
import { loadArtifact } from "../model/projector.js";
import { loadWeeklyArtifact, SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT } from "../weekly/projector.js";
import { loadPriceModel } from "../model/price.js";
import { loadInjuryHorizonArtifact } from "../inseason/injuryHorizon.js";

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
    key: "projection", file: "projection-artifact.json", required: true,
    // Measured by `ff evaluate-projection --seasons 2008-2025`: the SHIPPED projector, the trainer
    // re-invoked blind to each held-out season and fitted only on seasons BEFORE it, scored against
    // two baselines computed by the same code path, pooled over 14 held-out seasons. R-squared of
    // the trained artifact 0.542 against carry-forward's 0.432, with curve-only between them at
    // 0.497. It was 0.520 (lift 0.0880) before Phase 2d admitted `depth_rank_sep1` and
    // `contract_year`, and the whole of that move is at quarterback: QB R-squared 0.600 against
    // curve-only's 0.479, an RMSE of 76.8 against 87.9.
    nestedLift: 0.1100, claimedLift: null,
    what: "the projection ARTIFACT the board and the backtest both evaluate. It carries its OWN " +
      "curve -- window, monotone repair and ECR level weight selected per position by " +
      "forward-chaining inner CV -- plus named features with per-position coefficients and " +
      "p10/p50/p90 heads fitted over ranks 1-60. The TRAINED artifact ships: it passed the " +
      "pre-registered P5 gate on the pooled 2015-2025 holdouts at " +
      "RMSE 52.79 vs curve-only 55.54, pinball 12.02 vs 13.16, coverage 0.760 in [0.75, 0.85] " +
      "with every rank band in [0.70, 0.90]. THOSE ARE THE PHASE 2D NUMBERS and they are quoted " +
      "here because two features were admitted in that phase and the registry still carried the " +
      "figures from before them: `depth_rank_sep1` (the September depth-chart rank, the strongest " +
      "candidate the screen has ever produced at rho -0.186) took RMSE 54.17 -> 52.79 and pinball " +
      "12.31 -> 12.03, and `contract_year` took pinball 12.03 -> 12.02 with RMSE unchanged. Almost " +
      "all of the gain is at QUARTERBACK -- 76.8 against 82.4 -- which is where a September depth " +
      "chart says the most: a starter is a starter, a backup scores nothing, and a curve indexed on " +
      "last year's finish cannot see a job change. `contract_year` clears the keep-rule by 0.01 of " +
      "pinball and is recorded that way rather than dressed up; a rule with no effect-size floor " +
      "will eventually admit noise. The 54.17 line was itself 54.32 / 12.39 / 0.764 before Phase 2c " +
      "reconciled the surrogate keys",
    check: (j) => {
      // Loaded through the SHIPPED loader, not re-validated here. A second validator in the registry
      // would be a second opinion about the same contract, and the two would drift -- which is the
      // failure this artifact's golden block exists to prevent one layer down.
      try {
        const a = loadArtifact(j);
        if (!a.golden?.length) {
          return "no golden block -- nothing checks that the trainer and this evaluator agree, which " +
            "is the one failure a producer shipping its own validator cannot catch";
        }
        return null;
      } catch (e) { return (e as Error).message; }
    },
  },
  // ------------------------------------------------------------------------------------------
  // THE WEEKLY PAIR. Two artifacts, one shipped and one not, and the registry carries both because
  // the interesting fact about the weekly track is WHICH ONE SHIPS AND WHY -- and that fact lived
  // only in docs/validation.md, where nothing checks it against the files on disk.
  //
  // Both were put through the same pre-registered gate on the same 14 held-out seasons and 112,782
  // player-weeks (`ff evaluate-weekly`), whose three clauses are:
  //   (a) pooled CRPS beats the shipped `week()` baseline;
  //   (b) coverage CONDITIONAL ON pts > 0 in [0.75, 0.85] pooled and [0.70, 0.90] per position;
  //   (c) the predicted share of zero weeks is within 0.03 of actual, pooled and per position.
  // Clause (b) is conditional on a real week because the clamp floor is exactly 0, p10 sits on the
  // zero atom, an actual of 0 is therefore always inside [0, p90], and 41.9% of scored rows are
  // zeros -- no improvement can bring unconditional coverage into band, only being worse about
  // zeros can. The band was corrected BEFORE the run and against the previous run's numbers.
  // ------------------------------------------------------------------------------------------
  {
    key: "weekly", file: SHIPPED_WEEKLY_ARTIFACT, required: true, nestedLift: null, claimedLift: null,
    what: "THE SHIPPED weekly model, and it is the FLOOR: mean intercept exactly 1.0, so the " +
      "projection IS the preseason season line per game. Its quantile intercepts are the empirical " +
      "ratio quantiles on the training seasons -- a measured spread rather than an invented one. " +
      "`lineupRecommend` and `ff scorecard`'s `weekly` kind both load THIS file, by one constant " +
      "(SHIPPED_WEEKLY_ARTIFACT); they loaded different files until the final integration, so the " +
      "season's forward record was accruing for a model nobody was served from. Measured pooled " +
      "over 2012-2025, 112,782 player-weeks: RMSE 5.928, CRPS 2.671, coverage(>0) 0.825, against " +
      "the legacy `week()` path's 5.927 / 2.664 / 0.804. It ships not because it is good but " +
      "because it is what passed: every trained candidate so far has failed clause (c)",
    check: (j) => {
      try {
        // Loaded through the SHIPPED loader, which is what refuses an artifact of the old schema:
        // a weekly artifact declaring schema 1 stores a different coefficient shape, and scoring it
        // with this evaluator would silently treat every unknown head as contributing zero.
        const a = loadWeeklyArtifact(j);
        if (a.zeroModel && a.zeroModel !== "quantile") {
          return `zeroModel ${a.zeroModel} -- the SHIPPED slot must hold the floor, and the floor is ` +
            "a quantile artifact. A two-part model here would put the failed challenger on the lineup path.";
        }
        if (!a.golden?.length) return "no golden block -- nothing checks that the trainer and this evaluator agree";
        return null;
      } catch (e) { return (e as Error).message; }
    },
  },
  {
    key: "weekly-challenger", file: CHALLENGER_WEEKLY_ARTIFACT, required: false, nestedLift: null, claimedLift: null,
    what: "THE CHALLENGER, and it FAILED its gate by five thousandths. Two-part: a per-position " +
      "logistic on P(pts <= 0) over the whole rostered population, then ridge for E[ratio | played] " +
      "with pinball quantile heads at seven levels. On the same 14 folds it beats every baseline on " +
      "every accuracy metric by a wide margin -- RMSE 5.268 against the floor's 5.928, CRPS 2.150 " +
      "against 2.671, deep-18 lineup 72.31 points against the shipped path's 66.22, which is W4's " +
      "+6.08 -- and it is not served, because clause (c) is a calibration clause and it misses: " +
      "predicted zero-week share 0.384 against an actual 0.419, off by 0.035 against a tolerance of " +
      "0.030, and outside per position at RB (0.031), WR (0.039) and TE (0.074). (a) PASS 2.1500 vs " +
      "2.6642; (b) PASS 0.798 pooled with every position in band; (c) FAIL. The tolerance was NOT " +
      "widened to 0.04 -- a tolerance chosen after seeing 0.035 is not a tolerance -- and the miss " +
      "is a bounded next job: the first stage is a plain logistic and its intercept is the only " +
      "thing between 0.384 and 0.419. The quantile-head candidate it replaced failed the same clause " +
      "by 0.287, and for the opposite reason: a model whose p10 sits on the atom claims P(zero) = " +
      "0.10 and CANNOT SAY MORE. `ff scorecard` snapshots this artifact under its own " +
      "`weekly_challenger` kind from week 2 of 2026, so the live season accrues out-of-sample " +
      "evidence for it -- the only evidence left, the historical folds having all been used",
    check: (j) => {
      try {
        const a = loadWeeklyArtifact(j);
        // Keyed on the THING, not on a name: the challenger slot exists to hold a model the floor is
        // not. An artifact here with no zero stage is the floor wearing the challenger's filename,
        // and every scorecard row it produced would duplicate the shipped one while looking like
        // independent evidence.
        if (a.zeroModel !== "two-part") {
          return `zeroModel ${a.zeroModel ?? "quantile"} -- the challenger slot holds the model the ` +
            "gate refused, and a quantile artifact here would snapshot the floor's own numbers as " +
            "the challenger's for the rest of the season";
        }
        if (!a.quantileGrid?.length) return "a two-part artifact with no quantile grid -- the second stage published no ladder";
        if (!a.golden?.length) return "no golden block -- nothing checks that the trainer and this evaluator agree";
        return null;
      } catch (e) { return (e as Error).message; }
    },
  },
  {
    key: "price", file: "price-model.json", required: false, nestedLift: null, claimedLift: null,
    what: "what THIS room pays, fitted on the 1,102 real picks in fact_draft_pick for 2020-2025 -- " +
      "a hurdle model (logistic P(price > $1), then the share of the room's money given he clears " +
      "it) with a monotone per-position rank table. Leave-one-season-out MAE $3.72 over those six " +
      "seasons against $7.42 for the `rank` book and $7.61 for `vor`, 65% of picks within $3. " +
      "2018 and 2019 are DELIBERATELY EXCLUDED: the ECR archive does not reach them, so every pick " +
      "in them is unranked and `no_consensus` absorbs 'star' along with 'unknown' -- training on " +
      "all eight seasons takes the same rotation from $3.72 to $6.38. On the held-out 2026 draft " +
      "it scores $4.70 against $5.59 for `rank` and $7.23 for `vor`, and it still overpays the top " +
      "twelve by $4.1. Selectable as `--bot-book price`; NOT the default, which is still `vor` -- " +
      "i.e. our own valuation function, which the same measurement shows overpays the top twelve " +
      "by $23 a man",
    check: (j) => {
      try {
        const a = loadPriceModel(j);
        if (!a.golden?.length) return "no golden block -- nothing checks that the trainer and this evaluator agree";
        if (a.seasons.length < 3) return `fitted on ${a.seasons.length} drafts -- a room's price model wants more`;
        return null;
      } catch (e) { return (e as Error).message; }
    },
  },
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
    what: "same-team teammate correlation, imposed via a TWO-LEVEL Gaussian copula since Phase 2b: " +
      "one draw couples which SEASON each teammate has, a second permutes which WEEK inside it his " +
      "big games land in. The pairs below were fitted on same-week residuals, and applying them only " +
      "at the season level (Phase 1) left the same-week figure at +0.107 against a fitted +0.348 " +
      "-- defect D4. Restored to +0.347 / +0.210 / +0.209 (QB-WR / QB-TE / K-DST) with every " +
      "marginal and every season total unchanged; see scripts/verify-marginal.mjs",
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
    key: "injury-duration", file: "injury-duration-artifact.json", required: false,
    // The lift is a LOG-LOSS REDUCTION, not an R-squared, and it is the mean of the four horizons'
    // reductions against the DESIGNATION-ONLY baseline: 0.0472 / 0.0315 / 0.0243 / 0.0236 at
    // k = 1/2/3/4, pooled over held-out seasons 2015-2024, each fitted on seasons strictly before
    // its own. Against the tier rate the copilot used before it -- 1 - (1-missProb)^k -- the
    // reductions are 0.571 / 0.461 / 0.705 / 1.047, which says less about this model than about
    // asking an unconditional season-long availability rate a conditional weekly question.
    nestedLift: 0.0317, claimedLift: null,
    what: "P(he misses the next k games), k = 1..4, given Friday's designation, practice status, " +
      "injury type, how long the episode has already run and his position and age. Four separately " +
      "fitted L2 logistics over 21,757 point-in-time player-weeks (feat_injury_horizon, 2010-2024), " +
      "with the injury type collapsed into declared buckets INSIDE the fold. Fitted by " +
      "tools/train_injury_duration.py, evaluated by src/inseason/injuryHorizon.ts, and the two are " +
      "held together by a golden block at 1e-6. TWO PRE-REGISTERED PREDICTIONS FAILED and the " +
      "artifact carries the result rather than a refit: the gain over the designation is LARGEST at " +
      "k=1 (P59 said it would be under 0.02; it is 0.047) and SHRINKS with k (P60 said it would " +
      "exceed 0.05 at k=4; it is 0.024). Ablation says why: the injury TYPE is worth 0.001-0.002 " +
      "out of sample, while the practice status is worth 0.026 at k=1, so what a Friday report adds " +
      "beyond the designation is mostly whether he practised -- not what is wrong with him. " +
      "CONSUMED BY `depthRisk` and `handcuffs`; the weekly trainer does NOT read the table yet",
    check: (j) => {
      // Loaded through the SHIPPED loader for the reason the projection entry gives: a second
      // validator here would be a second opinion about the same contract and the two would drift.
      try {
        const a = loadInjuryHorizonArtifact(j);
        if (!a.golden?.length) {
          return "no golden block -- nothing checks that tools/train_injury_duration.py and " +
            "src/inseason/injuryHorizon.ts agree, which is the one failure a producer shipping its " +
            "own validator cannot catch";
        }
        if (!a.baselineDesignation) {
          return "no designation-only baseline on the artifact -- the consumer would then have " +
            "nothing to compare its own numbers against except a baseline refitted somewhere else";
        }
        return null;
      } catch (e) { return (e as Error).message; }
    },
  },
  // ------------------------------------------------------------------------------------------
  // RETIRED FROM THE PROJECTOR PATH (Phase 2b). Both files remain on disk and both still validate,
  // because a recorded number whose source has been deleted is a number nobody can check. NOTHING
  // READS THEM: `src/model/features.ts` no longer opens either, and `loadArtifact` REFUSES an
  // artifact that declares a multiplicative stage, so a half-migration fails loudly instead of
  // shipping a projection that is silently missing a factor it says it has.
  //
  // Why they had to go rather than be refitted: both were fitted OUTSIDE every fold, by their own
  // scripts, against their own curves -- and the opportunity amplitudes against a curve that had
  // seen the future, which is defect D1. A model that reaches for a fitted file on disk cannot be
  // cross-validated, because it is the same file in every fold. Age is now a coefficient of the
  // trainer; usage enters as a ratio to its rank bucket's mean over training seasons only. D1 is
  // resolved BY CONSTRUCTION, and the point-in-time per-position usage lift is measured in the
  // fold and recorded on the artifact as `usageLiftRmse` (RMSE points, season-grouped CV inside
  // the training window): QB +0.06, RB +0.19, WR +0.33, TE +0.46.
  // ------------------------------------------------------------------------------------------
  {
    key: "age-curve", file: "age-curve.json", required: false, nestedLift: 0.0069, claimedLift: 0.0154,
    what: "RETIRED (Phase 2b) -- points relative to prior-year rank, by age. Kept for the record; " +
      "age is now a fitted feature of the projection artifact and nothing reads this file",
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
    what: "RETIRED (Phase 2b, and it is defect D1's resolution) -- prior-season usage relative to " +
      "rank. Its amplitudes were fitted against a curve that had seen the future; usage is now a " +
      "point-in-time ratio-to-bucket-mean feature of the projection artifact and nothing reads this file",
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
