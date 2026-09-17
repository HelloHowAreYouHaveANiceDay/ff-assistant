# M2i -- a LEARNED surrogate for the simulated roster marginal (2026-09-16)

EXECUTOR REPORT. **Nothing here ships.** `DEFAULT_LEVERS`, `values.ts`, `strategy.ts`, V2 and the
default bidder are untouched; every artifact below is a `.candidate.json` and every code path is
behind a flag that is off unless typed.

---

## 1. PRE-REGISTRATION

*Written into this file before any measurement was run. Recorded as registered; not re-specified
after the numbers, and not tuned to.*

### The claim under test

Track G (`docs/validation.md`, TRACK G) closed V3's third rejection by naming the residual: the
analytic surrogate `src/draft/lineupMarginal.ts` gets the **ORDER** wrong exactly where a draft is
decided. Rank correlation with the simulated marginal is **0.68 on an empty roster, -0.29 after six
buys, -0.51 after nine, and -0.10 across the 37-60 VOR rank band**. A monotone calibration cannot fix
an ordering, which is why Track G's fitted level correction was worth +0.28pp (a clean null).

M2i asks whether a **LEARNED** surrogate -- a small fixed-weight MLP trained on simulated marginals,
deterministic at serve, no LLM (D10 satisfied) -- can reproduce the ordering the analytic surrogate
gets wrong, at a cost the bid loop can pay.

### H1 (the gate)

> An MLP trained on simulated marginals reaches **Spearman rank correlation >= 0.60** with the
> simulated marginal on **held-out-by-season** roster states, in each of the surrogate's three
> failing regimes: **after six buys**, **after nine buys**, and **the 37-60 rank band**
> (against -0.29 / -0.51 / -0.10 for the analytic surrogate today).

**STOP RULE.** If H1 fails, it is recorded as the **fourth V3 null** and **the backtest is not run.**
No arm of P28 is executed, no flag is wired into a default, and the track ends at the measurement.

### H2 (only if H1 holds)

> V3 with the learned marginal (`FF_V3_MARGINAL=learned`) beats V2 on **P28's long churn arm** on the
> **PLAYOFF gate** (V2 88.9%; the gate metric is playoff rate per D13, title reported as context).

H2's own stop rule IS that arm: the long churn arm
(`--bot-churn --bot-book price --full --no-lookahead --inflation --seasons 2012-2024 --n 150`),
paired through `scripts/paired-analysis.mjs` on common random numbers, playoff column primary.

### Registered controls (all three run, all three reported whatever they say)

1. **CEILING (positive control).** The simulated marginal against **itself**, re-simulated at a
   different book seed on the same states. This is the most any surrogate could score. A learned
   surrogate cannot be asked to beat the label's own reproducibility, and if the ceiling is below
   0.60 in a regime then H1 is **unreachable by any model** in that regime -- which is a finding
   about the label, not about the learner, and is reported as such.
2. **FAULT INJECTION.** A model trained on **shuffled labels** must score ~0. A pipeline that scores
   well on shuffled labels is measuring its own feature-to-feature structure, not the marginal.
3. **LEVER-CONNECTED.** `FF_STRATEGY=v3` flagless must reproduce Track G's number on its arm before
   the learned marginal is enabled, and the flagless golden must be byte-identical (V2 does not touch
   any of this).

### Registered in advance: what would make this measurement meaningless

- A held-out rho computed against a **degenerate** label (a state whose simulated book is flat at $0
  across the whole candidate set) measures the trial count, not the surrogate. Track G found **14 of
  40** states degenerate at 300 trials. Degenerate states are **excluded and counted**, never
  averaged in as agreement -- the same rule `scripts/marginal-agreement.mjs` already applies.
- The **empty** state is byte-identical across seeds within a season. It is deduplicated.
- The analytic column must come from **V3 itself** (`V3Config.onDetail`), never from a
  reimplementation in the harness, and must be re-measured **in the same invocation, on the same
  states** as the learned column. Two numbers from two runs of a stochastic simulator are not
  comparable (repo CLAUDE.md, "never correlate two facts sampled from two SEPARATE runs").

---

## 2. STATUS

*(sections below are filled as the work runs; this file was created at pre-registration time and the
section above has not been edited since.)*

- [x] 2. Data
- [x] 3. Model + walker golden check
- [x] 4. H1
- [x] 5. H2 or the stop-rule record -- **the STOP RULE fired; H2 was not run**
- [x] 6. Controls
- [x] 7. Verdict

---

## 3. DATA -- what was labelled, at what cost, and how the budget was met

**THE COST OF ONE LABEL, MEASURED RATHER THAN ASSUMED.** From a shard's own meta (`--trials 300
--cands 60`): 11 states, 1,311 `MarginalBook` season-simulation calls, 27.4 minutes -- i.e. **1.25 s
per simulated book call and ~2.5 minutes per labelled state, single core.** A serial run of the label
set this measurement needs is a multi-day job, which is what stalled the first attempt.

**HOW THE BUDGET WAS MET: the fan-out, not a smaller question.** `scripts/marginal-surrogate-data.mjs`
already carries a coordinator that shards the (season, seed, bidder) units over child processes
through the repo's own `pMap` + `withCpuSlot` primitive (`src/util/pool.ts`), bounded by the global
CPU budget (31 here). Every pass below ran at 20-29 workers, which turns 2.5 min/state into 5-8 s of
wall clock per state. Nothing about the QUESTION was cut to fit: the states are the same real,
replayed-draft states, at the same 300 trials and 60 candidates Track G used. What WAS cut is the
number of drafts sampled -- one seed per training season rather than twenty -- and that is stated
here as the power limit it is.

| pass | grid | states | rows | degenerate | usable | trials | book seed |
|---|---|---|---|---|---|---|---|
| TEST (scored) | 2023-2024 x seeds 1-6 x {v2,v3}, buys 0-11 | 266 | 15,960 | 153 | 113 | 300 | 7 |
| CEILING | the SAME 266 states, re-simulated | 266 | 15,960 | -- | -- | 300 | 11 |
| TRAIN | 2013-2022 x seed 1 x {v2,v3}, buys 0-11 | 230 | 13,800 | 158 | 72 | 300 | 7 |
| NOISE probe | 2023 x seed 1 x v2 | 12 + 12 | -- | -- | 6 | 100 | 7 and 11 |
| NOISE probe | 2023 x seed 1 x v2, buys 3/6/9 only | 3 + 3 | -- | -- | see 4 | 900 | 7 and 11 |

**2025 was never read.** The script refuses it by argument (`REFUSED: 2025 is held out entirely`), so
no later invocation can reach it. The scoring seasons (2023-2024) appear in no training file.

**n PER REGIME, because a mean over five states is not a measurement of the same weight as a mean over
a hundred.** Usable (non-degenerate) states scored, and the number of those for which the ceiling's
partner state was ALSO usable:

| regime | scored states | ceiling pairs |
|---|---|---|
| empty | 1 | 1 |
| after 3 buys | 17 | 11 |
| **after 6 buys** | **5** | **1** |
| **after 9 buys** | **9** | **5** |
| all states | 113 | 71 |
| band 1-12 / 13-36 / **37-60** | 113 each | 71 each |

**THE DEGENERACY IS THE STORY OF THIS DATA SET AND IT IS NOT A BUG.** 153 of 266 test states have a
simulated book flat at $0 across all sixty candidates, and the rate rises exactly with the buy count
H1 gates on -- usable states by buys: `1:23/24 2:21/24 3:17/24 4:16/24 5:8/24 6:5/24 7:6/24 8:5/24
9:9/24 10:2/24 11:0/24`. Late in a draft our seat has little money and few open slots, so the true
marginal of most of the remaining board really is worth under a dollar; at 300 trials the simulator
cannot separate those men from each other. That is a fact about the LABEL, and section 4 measures it
directly rather than inferring it.

---

## 4. LABEL NOISE -- what a trial count buys, measured on the same states

The label is a Monte Carlo estimate, so the first question is not "can a model learn it" but "does it
reproduce ITSELF". `scripts/marginal-surrogate-noise.mjs` (new) re-labels the same states under a
second book seed and reports the mean per-state rank correlation between the two.

On the SAME twelve states (season 2023, seed 1, bidder v2), so the trial count is the only thing that
changes between the rows:

| trials | states | usable | rho (label vs itself) |
|---|---|---|---|
| 100 | 12 | 6 | **0.323** |
| 300 | 12 | 5 | **0.345** |

And over the whole 266-state test grid at 300 trials: **rho 0.336 over 71 usable pairs**, per buy
count `1:0.44(23) 2:0.29(20) 3:0.22(11) 4:0.45(5) 5:0.34(4) 6:0.45(1) 7:0.38(1) 9:0.24(5)`.

**THE 900-TRIAL ARM IS NOT AN ESTIMATE AND IS NOT REPORTED AS ONE.** Three states (buys 3, 6, 9 of
the same draft) at 900 trials under two book seeds cost 10.4 minutes each and yielded **one usable
pair** (rho -0.162, n=1 -- a number with no standard error, quoted only so it is not hidden). What
those three states DO show is worth more than the rho: the count of live rows for the SAME state is
**not monotone in the trial count** --

```
  state            100 trials   300 trials   900 trials     (live rows of 60, seed 7 / seed 11)
  buys 3              5 /  7       2 / 10      19 /  8
  buys 6              3 /  5       3 /  6       3 /  5
  buys 9             44 / 43       5 /  6       3 /  4
```

-- so what separates a resolved state from a flat one here is not how many trials were spent but
which draft the state came from and where the book's own baseline landed. Tripling and then tripling
again does not converge the thing H1 needs.

**THE TRIAL COUNT CHOSEN, AND WHY.** 300 -- the count Track G's own agreement numbers were measured
at, and the count the existing test labels carry. The probe says plainly that 100 would have been
defensible too (0.323 vs 0.345 for a third of the cost) and that the extra trials are NOT where the
irreproducibility lives: **tripling the trials bought about 0.02 of rho.** Label noise at 300 trials is
therefore not the dominant term, and cutting to 100 would not have been the cheap win it looked like
before it was measured -- which is the whole reason it was measured before the fit rather than
asserted after it.

---

## 5. THE MODEL, AND THE WALKER AGAINST ITS OWN PRODUCER

`tools/train_marginal_surrogate.py` on the 230-state training file: 158 states dropped as degenerate
(the default; `--keep-degenerate` puts them back), **4,320 rows over ten seasons, 52 features**, inner
validation on the last two TRAINING seasons (2021-2022), never on 2023-2024.

```
  hidden=(64, 32)         alpha=0.001    inner-val mean state rho 0.2967 (19 states)  MAE 1.9482
  hidden=(64, 32)         alpha=0.01     inner-val mean state rho 0.2832 (19 states)  MAE 1.7628
  hidden=(128, 64)        alpha=0.001    inner-val mean state rho 0.3639 (19 states)  MAE 1.7876
  hidden=(128, 64)        alpha=0.01     inner-val mean state rho 0.3605 (19 states)  MAE 1.7286
  hidden=(32,)            alpha=0.001    inner-val mean state rho 0.4112 (19 states)  MAE 2.4139
  hidden=(256, 128, 64)   alpha=0.01     inner-val mean state rho 0.4154 (19 states)  MAE 1.2174
selected: hidden=(256, 128, 64) alpha=0.01 (inner-val rho 0.4154)
in-sample mean state rho 0.7320 (72 states) -- reported as a FIT statistic, not validation
```

Note the shape of that table before reading anything into the H1 result: **the best inner-validation
ordering any of six architectures reached is 0.42, on 19 states.** The gap between 0.73 in sample and
0.42 on held-out seasons is the usual one; the gap between 0.42 and the 0.60 H1 asks for was already
visible here, before the scoring pass, and section 4 says why.

**THE WALKER REPRODUCES SCIKIT-LEARN TO 1e-6, AND THE CHECK HAS BEEN SEEN TO FAIL.**
`data/marginal-surrogate.candidate.json` carries five golden rows spread across the design matrix,
each holding scikit-learn's OWN `predict()` output. `test/marginal-surrogate.test.ts` -- 8/8:

```
+ the walker reproduces a hand-computed MLP, relu included
+ the standardiser and the target scale are BOTH applied
+ FAULT: a perturbed weight makes the golden check FAIL
+ FAULT: a PERMUTED feature list is refused
+ FAULT: a truncated list, a missing golden block, a multi-unit output, a wrong target: all refused
+ the feature builder emits exactly the published list, in order, all finite
+ FAULT: a non-finite feature is refused rather than silently becoming a NaN bid
+ the M2i candidate artifact loads and its golden block agrees with this walker to 1e-6
```

The last one is on the REAL artifact, not a fixture, and it also perturbs that artifact's own
standardiser by 1% and asserts the golden check throws -- a golden check nobody has watched fail on
the shape it protects is a golden check nobody has.

---

## 6. H1 -- THE RESULT

One invocation, one read of one label file, four columns on the same states
(`scripts/marginal-surrogate-h1.mjs`). 266 states, 15,960 rows, 153 degenerate excluded and counted.
rho is the MEAN of PER-STATE rank correlations against the SIMULATED dollars.

| regime | states | LEARNED | analytic | CEILING | shuffled |
|---|---|---|---|---|---|
| empty | 1 | -0.173 | 0.155 | -0.185 (1) | 0.019 |
| after 3 | 17 | 0.147 | 0.202 | 0.223 (11) | -0.043 |
| **after 6** | **5** | **0.078** | 0.445 | **0.452 (1)** | -0.200 |
| **after 9** | **9** | **-0.148** | -0.173 | **0.238 (5)** | 0.041 |
| all states | 113 | 0.221 | 0.205 | 0.336 (71) | 0.002 |
| band 1-12 | 113 | 0.312 | 0.396 | 0.404 (59) | 0.091 |
| band 13-36 | 113 | 0.198 | 0.329 | 0.260 (71) | -0.027 |
| **band 37-60** | **113** | **0.151** | 0.168 | **0.251 (71)** | 0.016 |

Per-state SD is 0.31-0.50 in every regime, so none of these means is a point estimate; with 5 states
at `after 6` the interval is wide enough to contain most of the table.

```
  H1 -- registered before any of this was run. Threshold 0.60.
    after6       learned   0.078  (analytic   0.445, ceiling   0.452)  -> FAILED   [CEILING IS BELOW THE THRESHOLD]
    after9       learned  -0.148  (analytic  -0.173, ceiling   0.238)  -> FAILED   [CEILING IS BELOW THE THRESHOLD]
    band 37-60   learned   0.151  (analytic   0.168, ceiling   0.251)  -> FAILED   [CEILING IS BELOW THE THRESHOLD]

  H1 overall: FAILED
```

**THE CEILING IS BELOW THE THRESHOLD IN ALL THREE GATED REGIMES, WHICH THE PRE-REGISTRATION ANTICIPATED
AND SAID TO REPORT AS A FINDING ABOUT THE LABEL.** The simulated marginal, re-simulated on the same
state at a different book seed, agrees with itself at rho 0.45 / 0.24 / 0.25 in the three regimes.
**No model of any kind can score 0.60 against a quantity that scores 0.24-0.45 against itself.** So H1
is not merely unmet by this MLP, it is unanswerable as written at this trial count, and section 4
shows that three times the trials buys ~0.02 of that.

A second reading, worth recording because it is the one Track G's residual was about: the **learned
column does not beat the analytic one anywhere it matters**. It is ahead over all states (0.221 vs
0.205) and at `after 9` (-0.148 vs -0.173, both negative and both inside the noise), and clearly
BEHIND in the top band (0.312 vs 0.396) and at `after 6` (0.078 vs 0.445). The analytic surrogate also
reads far better here than Track G's headline (-0.29 after six buys, -0.51 after nine): those numbers
came from a different state sample and a different run of a stochastic simulator, which is exactly why
the pre-registration required the analytic column to be re-measured in the SAME invocation. **The
comparison inside this table is the valid one; the cross-run one is not**, and the discrepancy is
reported rather than explained away.

---

## 7. H2 -- NOT RUN. THE STOP RULE FIRED.

> **STOP RULE.** If H1 fails, it is recorded as the fourth V3 null and the backtest is not run. No arm
> of P28 is executed, no flag is wired into a default, and the track ends at the measurement.

H1 failed. **No backtest arm was run, `FF_V3_MARGINAL` was never wired into `strategyV3.ts` at all**
(the serve path for the learned marginal does not exist in this tree -- it was to be written only if
H1 held), no default moved, and V2 is untouched. This is **the fourth V3 null**, and the first one
whose cause is the LABEL rather than the bidder.

---

## 8. CONTROLS

1. **CEILING (positive control) -- RUN, and it decided the result.** 266 states re-simulated at book
   seed 11; rho 0.336 over 71 usable pairs, below the H1 threshold in every gated regime. Reported as
   a fact about the label's Monte Carlo floor, as registered.
2. **FAULT INJECTION -- RUN, and it scores ~0.** A model trained on labels permuted WITHIN each state
   scores **0.002** over all states (and -0.200 to 0.091 per regime, straddling zero). The pipeline is
   not measuring its own feature-to-feature structure.
3. **LEVER-CONNECTED -- partially moot, and said so.** The registered form ("flagless `FF_STRATEGY=v3`
   reproduces Track G's number before the learned marginal is enabled") belongs to H2, which was not
   run. What WAS verified is the half that constrains this session's tree: the flagless golden
   backtest is unchanged --
   `CHAMPIONSHIPS: 39.5% (random 6.3%) | playoffs: 96%`, per-season line byte-for-byte
   `2000:28 2001:31 2002:44 2003:47 2004:32 2005:29 2006:49 2007:19 2008:47 2009:55 2010:44 2011:62
   2012:47 2013:41 2014:29 2015:38 2016:29 2017:33 2018:41 2019:36 2020:43 2021:35 2022:54 2023:33
   2024:40`.
4. **THE EMPTY-STATE DEDUPLICATION held**: one empty state per season (2 in the test file), so no
   byte-identical row sits on both sides of any split.
5. **THE ANALYTIC COLUMN CAME OUT OF V3 ITSELF** via `V3Config.onDetail`, in the same invocation as
   the learned column, on the same states -- never a reimplementation and never a number quoted from
   another run.

---

## 9. VERDICT

**M2i is the FOURTH V3 NULL, and it closes a different door than the first three.**

The learned surrogate does not reproduce the simulated marginal's ordering on held-out seasons
(0.078 / -0.148 / 0.151 against a registered 0.60), and it does not beat the analytic surrogate it was
meant to replace. But the reason is upstream of the learner: **at 300 trials the simulated marginal
does not reproduce its OWN ordering** (0.45 / 0.24 / 0.25 in the same three regimes), and tripling the
trial count moves that by ~0.02. Most late-draft states are degenerate -- 153 of 266, rising to 19 of
24 by the ninth buy -- because with little budget and few open slots the true marginal of most of the
board genuinely is under a dollar.

So the honest statement is not "an MLP cannot learn the marginal". It is:

> **The SIMULATED ROSTER MARGINAL, as this repo computes it, does not carry a reproducible ORDERING in
> the late-draft states where a draft is decided. Track G's residual cannot be closed by fitting a
> better approximation of that quantity, because the quantity itself is not resolved there at any
> trial count this loop could pay for.**

What that rules out, and what it does not:

- **RULED OUT (at this cost):** any supervised surrogate -- MLP, GBM, or a better analytic form --
  trained on `MarginalBook` labels at 300-900 trials to fix V3's ordering after six-plus buys. The
  supervision is not there to be fitted.
- **NOT RULED OUT:** that the ordering exists and needs a different LABEL -- e.g. many more trials
  with a variance-reduced estimator (common random numbers across candidates within a state already
  help; an antithetic or control-variate scheme is the untried lever), or a coarser target (a
  positional/tier ordering rather than a per-man dollar ordering), or a label defined on the DRAFT
  outcome rather than on a one-man marginal. Each is a bigger piece of work than M2i and none is
  proposed here.
- **UNCHANGED:** V2, every default, every shipped artifact. `data/marginal-surrogate.candidate.json`
  is a candidate with no reader in `src/` -- no code path loads it outside the test and the H1 script.

**Cost, for whoever sizes the next one:** the whole measurement is ~1,700 core-minutes of labelling
(496 labelled states at 300 trials x 60 candidates), which is ~75 minutes of wall clock at 20-29
workers. A version powerful enough to answer H1 in the `after 6` regime with more than five states
would need roughly an order of magnitude more, and -- per section 4 -- would still be scoring against
a label whose own ceiling is 0.45 there.
