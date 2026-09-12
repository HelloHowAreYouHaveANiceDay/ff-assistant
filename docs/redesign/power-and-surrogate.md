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
2. **Cross-intervention surrogacy -- REQUIRED before trusting the index for optimisation.** Run a few
   DIVERSE levers (incl. a known top-heavy-favouring one, e.g. high maxShare) and confirm the index-LIFT
   tracks the champ-LIFT across them (Prentice). If a lever shows index-up-but-champ-down, that is a
   paradox flag and the index needs richer roster-composition features (enrich the trial dump: weekly
   point variance/consistency, bench share, positional concentration).
3. Once validated: tune levers on the index (t~4 power), layer shrinkage across the family + deflated
   trial-count discipline, and CONFIRM only the gross survivors on the 25-season arbiter.

Sources: Athey-Chetty-Imbens NBER w26463; arXiv:2309.07893, 2402.03915, 2311.11922; Deng et al. CUPED
(arXiv:2312.02935 retrospective); Bailey-Lopez de Prado Deflated Sharpe; Efron CASI ch.7.
