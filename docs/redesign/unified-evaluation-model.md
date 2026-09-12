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

## Recommendation & migration (staged, each QA-gated)

1. **Enrich the trial dump** with roster-state features (prerequisite for a weekly-capable `Φ`).
2. **Extract `scripts/lib/arbiter.mjs`** from cpcv (CRN OPE + bootstrap + PBO + ledger + fingerprint
   profiles); refactor cpcv to use it (behaviour-preserving, byte-identical draft output = the gate).
3. **Fit + validate one `Φ`** over roster-state; re-validate surrogacy on in-season states.
4. **Add in-season `--dump-trials`** emitting `(season, seed, ΔΦ, champ)`; wire a thin in-season arbiter
   wrapper to the shared core with the `weekly` fingerprint profile.
5. **Re-run lineup / waivers / trades** through the unified engine → drift-aware ledger rows, graded on
   `ΔΦ` (power) + terminal champ (truth). `--rerun-stale` then covers both.

The elegant end state: **one potential function `Φ`, one ledger, one drift discipline; draft and
in-season are the same engine measuring the same thing (championship win-probability) at different
points in one season-long MDP.**

Sources: Jiang & Li, Doubly Robust OPE (arXiv:1511.03722); MRDR (arXiv:1802.03493); Ng-Harada-Russell,
Policy invariance under reward transformations (ICML 1999); FPL-as-MDP (arXiv:2505.02170); Athey-Chetty-
Imbens surrogate index (NBER w26463).
