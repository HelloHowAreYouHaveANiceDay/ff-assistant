# Power, small samples, and the surrogate index

Why the championship backtest cannot resolve a thin edge, what the prior art says to do, and the
instrument we built. Companion to `experimentation-redesign.md`.

## The problem, measured

The unit of generalisation is the SEASON, and we have ~25 (1999-2024). The championship is a binary,
near-lottery outcome: the season simulator has measured skill on the playoff BERTH and ~none on the
CHAMPION (single-elim among seven is a coin flip; `docs/edges.md` objective note). So a real roster
improvement lands in the title column as noise.

A within/between-season variance decomposition of the shipped consensus edge (from the CRN-paired
trial dumps, no new backtests) shows the wall is the SAMPLE, not compute:

| metric | between-season share | floor @ n=150 | floor @ n=600 | floor @ n=inf |
|---|---|---|---|---|
| playoffs | 66% | ~1.63pp | ~1.41pp | **~1.33pp** |
| championship | 58% | ~3.82pp | ~3.16pp | **~2.91pp** |

More trials/season barely move the floor (the noise is genuine year-to-year variation in the effect,
i.e. real generalisation uncertainty, not reducible Monte-Carlo error). **At 25 seasons the arbiter
cannot reliably resolve a playoff edge below ~1.3pp or a title edge below ~2.9pp, at ANY compute
budget.** Most levers move the seed by far less. This is the Lopez de Prado thesis in concrete form:
the backtest is low-power; spend it only on large, robust, ship-level effects.

## Prior art

- **Surrogate index / proxy metrics (primary).** When the true objective is too noisy/slow, optimise on
  a high-power surrogate VALIDATED to predict it. Athey-Chetty-Imbens (NBER w26463) got a 35% SE
  reduction; the experimentation literature formalises choosing/aligning a proxy that maximises power
  ("Choosing a Proxy Metric", arXiv:2309.07893; "Learning Metrics that Maximise Power", arXiv:2402.03915;
  Netflix's 200-A/B-test evaluation, arXiv:2311.11922).
- **The surrogate paradox** is the central risk: a treatment can move the proxy the WRONG way for the
  true outcome. This repo already documents its instance -- `ff sim` season-points OVER-REWARDS
  top-heavy rosters (they pile up points and lose in single-elim). So a single raw proxy is unsafe; a
  FITTED index that combines proxies is the fix.
- **CUPED / covariate adjustment** (Deng et al. 2013): regress out pre-experiment covariates to cut
  variance. Our CRN pairing already captures part of what it would; a season-level covariate that
  predicts the effect's heterogeneity could add a little more.
- **Empirical-Bayes / James-Stein shrinkage** (Efron, CASI ch.7): estimate the whole lever family
  jointly and shrink toward zero -- the canonical fix for many-small-noisy-effects and the winner's
  curse in a sweep.
- **Deflated Sharpe / minimum backtest length** (Bailey-Lopez de Prado): with few observations, CAP the
  number of strategies tried and deflate for it -- bounds how many lever values a 25-season sweep can
  honestly test. We already track T (`experiments-status`).

## The instrument: `scripts/surrogate-index.mjs`

`E[champ | wins, regPoints, playoffs]`, logistic, fit LEAVE-SEASON-OUT so validation is honest, applied
as a fixed instrument to score any arm's trials. The per-trial score is a title probability; a lever's
effect on its season-paired mean is the high-power read.

Measured on the consensus contrast:
- **Predictive surrogacy:** OOS AUC 0.695 for the title (leave-season-out), log-loss 0.604 vs base-rate
  0.666. It predicts the title out of season.
- **Power:** the consensus effect is t=3.72 on the index (up 17/25 seasons) vs t=1.19 on the playoff
  berth (8/25) and t=2.10 on the title -- it resolves what the binary outcomes cannot, in champ-prob
  units, staying title-aligned (unlike raw regPoints at t=4.27, which carries the top-heavy bias).
- **Top-heavy guard: only PARTIALLY validated.** The index uses regPoints (coef +0.52 > wins +0.29);
  title-predictive on average in the playoff-aware backtest, but paradox-safety for a top-heavy-favouring
  lever needs CROSS-INTERVENTION validation.

## Validation status & plan

1. Predictive surrogacy -- DONE (OOS AUC 0.695).
2. **Cross-intervention surrogacy -- DONE (`scripts/surrogate-validate.mjs`).** Across 4 diverse, large
   interventions (consensus-off, maxShare 0.5, aggr 1.0, benchDiscount 1.0 vs the shipped baseline) the
   index-LIFT tracks the champ-LIFT with **r=0.999**, agrees in sign every time, and carries **~2x the
   power** (|t|) of the binary title on every one (e.g. maxShare champ t=-3.11 -> index t=-5.29). The
   index roughly HALVES the resolution floor (champ ~3.8pp -> index ~1.9pp champ-prob).
   CAVEAT (honest): all 4 interventions moved regPoints and champ the SAME direction (regPoints also
   r=0.995 with champ), so a true PARADOX case (regPoints up, champ down) was NOT exercised -- maxShare
   0.5 lowered BOTH (too thin to score). So in the backtest's LEVER space regPoints and titles are
   tightly aligned and the paradox (a property of optimising season-points across a huge config space,
   per winner's-curse selection) does not strongly bite; the index is safe for lever TUNING. The index's
   discrimination OVER raw regPoints is therefore unproven here, but it is calibrated to champ-prob and
   down-weights points via the fit, so it is the safe choice at no cost. Richer roster-composition
   features (enrich the trial dump) would lower the floor further and harden the guard.
3. Once validated: tune levers on the index (~2x power), layer shrinkage across the family + deflated
   trial-count discipline, and CONFIRM only the gross survivors on the 25-season arbiter. NOTE the index
   still cannot resolve arbitrarily thin (sub-~1pp) edges -- it halves the floor, it does not remove it.

## Lever re-optimisation under the consensus-on baseline (RESULT)

`scripts/lever-sweep.mjs` swept 27 lever contrasts, analysed on the index (`scripts/surrogate-validate.mjs`,
~2x power); each lever's canonical contrast is enrolled as a drift-aware LEDGER experiment on the true
objective (playoffs-primary). **No optimum moved -- the shipped posture holds under the consensus edge:**
- HOLD (alternative REJECTed on the arbiter): aggr, max-share, bench-discount, premium, max-kdst,
  mult-qb, mult-rb. Moving away from the shipped value is measurably worse.
- INERT / below resolution (neither confirmed nor refuted -- they do not move the seed): starter-reserve,
  bench-reserve, mult-wr, mult-te. sleeper-threshold and tier-break read EXACTLY 0.00 (byte-identical) --
  board-display filters the draft backtest cannot see, so they cannot be validated this way at all.
- ONE thin CANDIDATE: bench-discount 0.5 reads index +0.57 (t=2.79) vs shipped 0.25 -- suggestive that
  valuing bench-only players slightly more may help, but it does NOT survive FDR across 27 tests. Logged
  for a finer sweep (0.3-0.4) + arbiter confirmation; not shipped.

So the answer to "have we re-run the levers under the new model?": yes, on the powered instrument, and
the consensus edge did not destabilise any lever. The 13 levers are now drift-aware ledger experiments;
`experiments-status --rerun-stale` (the last engine piece) will re-run them automatically on future drift.

Sources: Athey-Chetty-Imbens NBER w26463; arXiv:2309.07893, 2402.03915, 2311.11922; Deng et al. CUPED
(arXiv:2312.02935 retrospective); Bailey-Lopez de Prado Deflated Sharpe; Efron CASI ch.7.
