# The unified evaluation model: one potential function, one ledger

Recon + first-principles redesign (2026-09-12). Answers: is there ONE rigorous model that makes the
draft arbiter and the in-season harness the same engine? Yes. This is the design; the build is staged.

## The problem

Two evaluation systems that independently converged on the same core statistic (CRN pairing + season
bootstrap + a control) but are separate code, separate metrics, and only one has the surrogate / PBO /
drift-ledger discipline:
- DRAFT: simulate the auction + a drafted roster over a season; terminal metric = championship (binary,
  near-lottery, low-power on ~25 seasons); fitted SURROGATE INDEX for power, CPCV+PBO, drift-ledger.
- IN-SEASON: for a GIVEN historical roster, evaluate one weekly decision as a POLICY (baseline vs
  variant); metric = realized POINTS (continuous, high-power) or simulated playoff-Δ; season bootstrap +
  control. No surrogate/PBO/ledger.

## The unifying insight

**The whole season is ONE Markov decision process.** State `s` = (roster, league context, week).
Every decision surface -- a draft bid, a weekly lineup, a waiver claim, a trade -- is a POLICY choosing
an action `a` that transitions `s -> s'`. The terminal reward is the championship. So draft and
in-season are not two problems; they are decisions at different points in one trajectory.

**The single value of ANY decision is its effect on the potential `Φ(s) = E[championship | s]`.** This
one function unifies everything:
- `Φ` is exactly the fitted **surrogate index** (E[champ | roster-state features]) -- already built for
  the draft, needs roster-state features to serve in-season.
- A decision's value = `ΔΦ = Φ(s') - Φ(s)` -- the change in championship probability it produces. Draft
  and in-season decisions are valued on the SAME scale (win-probability points), against the SAME
  terminal objective, with the SAME instrument.
- `Φ` is a POTENTIAL FUNCTION, so shaping the sparse terminal reward with it is theoretically clean
  (potential-based reward shaping is policy-invariant), and it is the variance-reduction MODEL that
  gives power on 25 seasons.

## Prior-art anchors (each maps directly)

- **Off-policy / counterfactual policy evaluation (OPE).** Evaluating a policy variant from logged/
  simulated history is exactly OPE. Our engine is a **doubly-robust** estimator (Jiang & Li 2016): the
  CRN-paired direct comparison is the low-bias term, `Φ` is the low-variance model term. DR is the
  principled way to combine them -- and names precisely why the surrogate helps without biasing us.
  (arXiv:1511.03722; MRDR arXiv:1802.03493.)
- **Potential-based reward shaping (Ng, Harada & Russell 1999).** A potential `Φ(s)` turns a sparse
  terminal reward into dense per-decision signal `ΔΦ` WITHOUT changing the optimal policy (policy
  invariance). Our surrogate index IS the potential; `ΔΦ` is the shaped reward; this is the theory that
  licenses crediting each decision by its win-prob change.
- **Fantasy season as an MDP.** Established: FPL as a belief-state MDP with Bayesian Q-learning +
  multi-dimensional knapsack (arXiv:2505.02170); MIP models over draft + weekly lineups jointly; "formal
  in-season methods that weigh the SEASON-LONG impact of weekly moves." The season-as-one-MDP frame is
  standard, not novel to us.
- **Surrogate index / variance reduction** (Athey-Chetty-Imbens; CUPED; deflated Sharpe -- docs/redesign/
  power-and-surrogate.md). `Φ` is the surrogate; CRN + control variates fight the small-sample wall.

## The architecture it implies

ONE engine, two producers:
- **ONE potential `Φ` = E[champ | roster-state]**, fitted with roster-COMPOSITION features (enrich the
  trial dump: weekly-point variance/consistency, bench/positional structure -- the deferred "richer
  features" item is a PREREQUISITE, not optional), and surrogacy-validated on BOTH the draft AND the
  in-season state distributions (they differ -- see failure modes).
- **ONE analysis core** (CRN-paired OPE + season bootstrap CI + power floor + PBO) -- generalise cpcv's
  guts into `scripts/lib/arbiter.mjs`, metric-agnostic, reading a common CRN trial schema
  `(season, seed, ...metrics)`.
- **ONE ledger** (experiments.jsonl) with fingerprint PROFILES (`draft` deps vs `weekly` deps in
  deps.mjs) + spec (incl. a `runner` so `--rerun-stale` reconstructs either producer).
- **TWO producers** that emit CRN trials in the common schema: the draft backtest (already does) and the
  in-season harness (add a `--dump-trials` that emits per-(season,seed) `ΔΦ` and terminal champ).
- **Metric aligned to the terminal objective everywhere:** draft and in-season BOTH report terminal
  champ/playoffs (the arbiter) with `Φ`/`ΔΦ` as the high-power surrogate -- the in-season harness stops
  grading on raw POINTS (which carries the top-heavy paradox) and grades on `ΔΦ` (validated to convert).

## Failure modes (honest)

1. **`Φ` mis-fit → mis-credited decisions.** PBRS policy-invariance is exact only for the TRUE value
   function; an approximate `Φ` is a heuristic potential. Mitigate: validate surrogacy (does `ΔΦ` track
   realised champ-Δ across interventions) on EACH state distribution, as we did for the draft.
2. **State-distribution shift.** The draft `Φ` was fit on end-of-draft rosters; in-season states are
   mid-season, injury-thinned, partial. `Φ` must be re-fit / re-validated on in-season states, or it
   extrapolates badly. This is the OPE distribution-shift problem by another name.
3. **Different effective sample sizes & correlation.** Draft = 25 seasons × 1 team (n≈25, the wall).
   In-season = 25 seasons × many teams × weeks -- far more decisions (more power for `Φ`-level effects),
   BUT the TERMINAL reward is still one-per-season and shared across a team's weekly decisions, so
   season-level bootstrap remains the honest unit for terminal claims; decision-level power is real only
   for the intermediate `ΔΦ`.
4. **Credit-assignment leakage.** A weekly decision's `ΔΦ` and the draft's `ΔΦ` both touch the same
   terminal champ; summing them naively double-counts. Keep them as SEPARATE experiments against a fixed
   baseline, not an additive attribution, unless a proper per-decision advantage decomposition is built.
5. **`Φ` needs roster-state features we don't yet dump.** Raw (wins, regPoints, playoffs) is enough for
   a draft-roster `Φ` but likely too coarse for weekly states. The richer-feature build gates this.

## FOUNDATIONAL CHECK #4 -- RESULT (2026-09-12): state-Φ does NOT work; use the outcome-surrogate

We enriched the trial dump with PROJECTED roster-structure (projTotal, projStart, projBench, projHHI --
`src/draft/backtest.ts`) and fit state-Φ = E[champ | projected structure], vs outcome-Φ = E[champ |
wins,regPoints,playoffs] (`scripts/state-phi-check.mjs`). Three checks, all negative for state-Φ:
- **AUC 0.501** (state-Φ) vs 0.696 (outcome-Φ), leave-season-out. Projected structure has ~ZERO
  within-strategy champ-predictive power. Diagnostic: the features VARY (CV 0.06-0.22) with the RIGHT
  signs (projHHI corr −0.063, top-heavy bad) but corr with champ is 0.02-0.07, vs 0.30-0.33 for realized
  wins/regPoints.
- **Wrong SIGN on bench-discount** in the surrogacy check: state-Φ +0.47 while champ −4.67 -- a real
  paradox (bench-discount-off adds structural "depth" state-Φ rewards while it weakens the starters).
- Root cause (FUNDAMENTAL, not tuning): within a fixed strategy every trial drafts a similar-QUALITY
  roster; which SPECIFIC trial wins the title is realized luck (weekly variance + injuries + single-elim
  bracket), which no projected structure can see. A per-state value function is orthogonal to the
  outcome by construction. **The cheap instant-roster-score Φ is dead.**

IMPLICATION: the unification does NOT rest on a state-value function. It uses the OUTCOME-SURROGATE /
doubly-robust form (which was the pre-registered fallback): both harnesses stay POLICY COMPARISONS
measured on REALIZED, champ-aligned outcomes (CRN rollouts) with outcome-Φ (AUC 0.696) for power. The
in-season fix is a METRIC SWAP, not a new sim: the harness already rolls out realized rest-of-season;
swap raw POINTS (paradox-prone) for realized rest-of-season WINS / playoff-Δ (champ-aligned, corr 0.30).
This is simpler and more robust than state-Φ: no value-function fitting, no state-distribution-shift, no
paradox-fitting. The structure columns are kept as cheap telemetry / potential control variates.

## Recommendation & migration (staged, each QA-gated) -- REVISED after check #4

Check #4 killed the state-value-function stage; the rest stands, in outcome-surrogate form:
1. ~~Enrich dump + fit a state-Φ value function~~ -- DONE and REJECTED (check #4 above). Structure columns
   kept as telemetry.
2. **Extract `scripts/lib/arbiter.mjs`** from cpcv (CRN OPE + season bootstrap + PBO + ledger + fingerprint
   profiles); refactor cpcv to use it (behaviour-preserving, byte-identical draft output = the gate).
3. **Align the in-season METRIC to the terminal objective:** swap the harness's raw-POINTS scorer for a
   realized rest-of-season WINS / playoff-Δ scorer (champ-aligned, corr ~0.30, not paradox-prone). This is
   a scorer change in `src/inseason/backtest/scorers.ts`, not a new sim.
4. **Add an in-season CRN `--dump-trials`** emitting `(season, seed, <realized champ-aligned metric>)` in
   the common schema; wire a thin in-season wrapper to `lib/arbiter.mjs` with the `weekly` fingerprint
   profile + spec (runner = the in-season harness).
5. **Re-run lineup / waivers / trades** through the shared core → drift-aware ledger rows, graded on the
   realized champ-aligned outcome with the outcome-surrogate for power. `--rerun-stale` then covers both.

## STAGE 3 finding (2026-09-12): in-season CANNOT be champ-aligned in its own harness -- use the full field

The in-season harness scores ONE roster in isolation on POINTS because playoff-Δ/wins need the whole
field's rosters + H2H schedule + projection pool, and those are built only for the LIVE season -- there
is no stored historical board to reconstruct 2018-2025 sim contexts from (`scorers.ts`). So the metric
swap (Stage 3) is INFEASIBLE in that harness. But the constraint points at the right answer: the
FULL-FIELD DRAFT BACKTEST already simulates the whole league + playoffs (so it HAS champ) and already
runs in-season policies inside it -- `--full` is the lineup optimizer, `--waivers` the waiver churn. So
**lineup and waivers are already champ-measurable through the shared cpcv core; they were just never
ledger experiments.** REVISED architecture:
- CHAMP-ALIGNED ARBITER = the full-field backtest + cpcv (shared core), for any in-season policy it can
  simulate (lineup `--full`, waivers `--waivers`; trades not yet -- no trade sim in the field).
- The points-based in-season harness stays a COMPLEMENTARY high-power SCREEN (more decisions, but points
  only), whose point-improvements must be confirmed on champ in the full-field sim -- exactly the
  screen->arbiter relationship the funnel already uses.
So "re-run lineup/waivers off the new engine" is: enroll them as cpcv LEDGER experiments (champ-aligned,
playoffs-primary, PBO, drift-fingerprinted). Trades remain on the points-screen until a field trade sim
exists.

The elegant end state (revised): **one analysis core, one ledger, one drift discipline; draft and
in-season are the same DOUBLY-ROBUST policy-comparison engine measuring the effect on a realized,
champ-aligned outcome -- differing only in what trajectory each producer rolls out.** Not a shared value
function (check #4), but a shared ESTIMATOR and ledger, which is the honest unification.

Sources: Jiang & Li, Doubly Robust OPE (arXiv:1511.03722); MRDR (arXiv:1802.03493); Ng-Harada-Russell,
Policy invariance under reward transformations (ICML 1999); FPL-as-MDP (arXiv:2505.02170); Athey-Chetty-
Imbens surrogate index (NBER w26463).
