# The Weekly Track

The season model answers "who should I buy in August". This layer answers "who should I start on
Sunday", which is a different question with a different failure mode. It is also the layer that
matters right now: the 2026 season opens on 2026-09-09.

Four things live here, in dependency order: a point-in-time feature view, a trainer and a
schema-validated serving artifact, an evaluation harness whose decision metric is a lineup rather
than an RMSE, and a forward scorecard that freezes predictions before kickoff so that next January
there is a record nobody can edit.

---

## 1. Point-in-time is the whole discipline

A weekly projection for week *w* of season *Y* may use only information dated before that week's
first kickoff. Break that and the model looks superb and is worth nothing, and the break is **silent**
-- there is no error, no NaN, no coverage hole, just a very good RMSE. Season-level lookahead is loud
(a season projection that knows the season is obviously wrong); weekly lookahead is a `<=` where a
`<` belongs, in a `GROUP BY` nobody reads twice.

So: **`as_of` is the day before the week's FIRST kickoff anywhere in the league.** Not the day before
this team's game -- that is `feat_player_week`'s anchor, correct for its purpose, but it would let a
Monday-night player's row carry Sunday's results. The league-wide anchor is strictly earlier and is
the same date for every row in a week, which is what makes "no week-*w* feature moved" a checkable
statement rather than a hope.

### `feat_player_week_model` -- the columns and their as-of rules

| column | as-of rule |
|---|---|
| `season_line_pg` | the preseason season projection / scheduled games, as of `Y-09-01`. Frozen before week 1, identical in every week of the season -- deliberately, because it is the "what we thought in August" anchor the ratio is measured against. |
| `td_games`, `td_ppg` | games played and points per game through week *w-1*. From `feat_player_week`, which accumulates AFTER writing each row. |
| `t4_mean`, `t4_sd` | the last <=4 games **played** strictly before *w*. Games played, not weeks -- a bye or an inactive week is not a zero, and counting it as one would drag every returning player's trailing mean down by a quarter. `t4_sd` is NULL below two games. |
| `td_fd`, `td_ts`, `td_attempts`, `td_rush_yards` | usage per game through *w-1*, same source and same bound. |
| `dvp_mult`, `dvp_n` | opponent defence-versus-position, as a multiplier. A weighted mean of what the defence has allowed in weeks 1..*w-1* of *Y* (weight = its games so far), what it allowed over all of *Y-1* (weight 6), and 1.0 (weight 4). Each term is a ratio to the league over the same window, so the scoring era divides out. |
| `home`, `spread_line`, `total_line`, `implied_team_total` | as published pre-kickoff. A week with no line carries NULL, never a mean. |
| `days_rest` | days since this team's previous scheduled game. Schedule-derived, so known in August; NULL in a team's first game rather than a made-up 7. |
| `pts` | **the target.** `loadWeeklyRows` never selects it into a feature row. |

#### The availability block (Phase 2d) -- a DIFFERENT anchor, said out loud

Ten more columns arrived from the data track's `feat_player_week_context`. They are not on the anchor
above and pretending otherwise would be the quietest possible lie:

| column | as-of rule |
|---|---|
| `prior_snap_share` | `offense_pct` in the last week he **played** before *w*, carried forward. |
| `prior_route_share` | charted pass plays / team pass plays, same rule. The participation feed starts in 2016. |
| `depth_rank` | the depth chart at **this team's kickoff minus one day**. |
| `teammates_out` | same team, same position, listed Out at **this team's kickoff minus two days**, excluding himself. |
| `inj_out`, `inj_doubtful`, `inj_questionable` | the Friday report status at that same cutoff. Probable was retired after 2015 and folded into Questionable, so one coefficient means the same thing across the span. |
| `prac_dnp`, `prac_limited` | the Friday practice status at that same cutoff. |
| `inj_feed` | 1 where the injury feed published **any** dated report for this league-week. See below. |

Everything in the first table is keyed to the day before the week's **first** kickoff, league-wide --
the strictly-safest anchor and the same date for every row in a week. These are keyed **per team**,
which for a team playing Sunday is up to four days later. That is a real widening, accepted
deliberately for a reason that is checkable rather than a matter of taste: the later anchor is still
strictly before *this player's own kickoff*, which is the only thing a lineup decision needs, and a
Friday injury designation is not derived from any game's result. What it must not admit is week *w*'s
scoring, and that is what the guard below now asserts against the raw injury rows themselves.

**`inj_feed` exists because the alternative is a fabricated fact.** From 2025 the nflverse injury
feed stopped publishing a report **date**. An undated filing cannot be placed on either side of a
cutoff, so `feat_player_week_context` drops all 6,068 of 2025's, and every injury column reads NULL.
Without a feed indicator a model reads that as *nobody in the league was hurt in 2025*, which is
worse than missing data because it is confidently wrong. `inj_feed` is 0 for exactly those
league-weeks, and the five injury indicators are NULL there rather than 0.

**The Wednesday pair is empty, and that is a finding, not an omission.** Phase 2d set out to declare
`report_status_wed` and `practice_status_wed`. They exist, `buildWeekContext` fills them with a
cutoff of kickoff minus four days, and they hold **11** and **389** values across 133,892
player-weeks -- because the feed's dated filings land at kickoff minus two or later. A model
declaring them would fit an intercept on 0.008% of its rows and the report would say "Wednesday
practice status did not help", which is a fact about the feed dressed as a fact about football. They
stay in `PENDING_DATA_TRACK_FIELDS`.

The one thing making DvP a point-in-time quantity is the `week < w` bound, and it is worth saying
that it does all the work: the same statistic over the whole season -- which is what
`data/def-ratings.csv` is, and what almost every published DvP table is -- puts week *w*'s own scoring
inside week *w*'s feature.

**Inherited limit, stated rather than buried.** The season line comes from the shipped projection
artifact, whose `age_factor` and `opp_factor` are fitted once over all seasons. So it carries the
same mild cross-season lookahead the shipped board carries. It is not introduced here and it is
identical across every model and baseline compared below, so it cannot manufacture a difference
between them -- but it is not zero.

### The guard, and its three positive controls

`test/weekly-leakage.test.ts` does not read the table above and believe it. It perturbs week *w*'s
own results, rebuilds, and asserts nothing in week *w* moved. A guard that can only ever say "clean"
is dead code that reads exactly like a passing one, so:

1. **The perturbation must reach something.** Week *w+1* must move. If it does not, "week *w* did not
   move" is measuring nothing.
2. **The target must move.** `pts` is not a feature and must change, or the fixture is not wired to
   the rows being perturbed.
3. **The detector must be able to fire.** With `leakDvpThroughWeek` the DvP window includes week *w*
   -- the real leak in its natural habitat -- and `dvp_mult` must then move both under the switch and
   under the perturbation. It does.

Phase 2d added a fourth, and it is the one the availability block needed. Ten columns that are NULL
everywhere would satisfy "nothing moved" without being wired to anything at all, so the fixture now
seeds `feat_player_week_context`, asserts the columns are non-constant, and then asserts the
complement: **a change to week *w*'s own injury report MUST move week *w*'s availability columns**,
and must not touch week *w+1*. A change to week *w*'s RESULTS still must not move any of them.

That control found a real bug on its first run, in the fixture rather than the builder: the synthetic
`player_sk` was the string `P0`, the availability block joins on the numeric surrogate key, and every
one of the ten columns was silently NULL. A join that cannot parse a surrogate key had been passing
as a join that works.

### The audit on the table that actually shipped

The guard above proves the BUILDER cannot leak, on a fixture it controls completely. That is a
different question from whether the table on disk leaks -- a builder can be correct and the table
still be stale, half-built, or written by an older version of the code. So
`scripts/weekly-leak-audit.mjs` recomputes `td_games`, `td_ppg` and `t4_mean` from the raw weekly
facts with an **independent implementation** and an explicit `week < w` bound, and compares. Not by
re-running the builder and diffing, which would compare the code against itself.

```
node --import tsx scripts/weekly-leak-audit.mjs 2023
            mismatches vs `week < w`   vs `week <= w` (the leak)
  games               0                   6888
  ppg                 0                   6696
  t4                  0                   6504
AUDIT PASSED -- and the leaked-bound control fired on every column.
```

Zero mismatches under the honest bound; thousands the moment the bound moves by one week. Same result
on 2015 and 2025. It also asserts `dvp_n <= week - 1` on every row, which is the defence-side version
of the same claim. The control matters as much as the pass: a comparison that reports "clean" against
both bounds is a comparison that is not connected to anything.

**Phase 2d extended it to the availability block**, which is the part most easily leaked: the injury
feed keeps filing all week, and a Saturday downgrade to Out is a near-perfect predictor of a zero
week that is not knowable at the Friday cutoff the builder claims. Same method -- an independent
recomputation straight from `raw_injury` and `raw_nfl_game`, parameterised by the cutoff so the
control is the same code with one number changed:

```
availability -- 10457 rows recomputed from raw_injury independently          (season 2023)
  inj_out  mismatches vs the Friday cutoff: 5   vs a cutoff moved to kickoff (the leak): 30
  inj_out vs feat_player_week_context (staleness, must be exact): 0 of 10457
  teammates_out mismatches vs the same recomputation: 82 of 10457 (worst off by 1)
```

The bound on `inj_out` is 0.5%, not zero, and saying why matters more than the number: this
recomputation resolves a filing to a player through the gsis crosswalk **alone**, while the builder
also falls back on name+position+team. That is the point -- an independent implementation that agreed
to the last row would be the same implementation -- so a handful of rows differ for reasons about
identity rather than about time. A leak does not look like a handful, which is why the discriminating
assertion is the **ratio** (5 -> 30) and not the count. The staleness check against the context table
has no such slack and must be exact; it is 0.

On 2025 the audit says so rather than passing: `inj_feed` is 1 nowhere, so the availability block is
**not audited**, and the report says that is a coverage fact and not a clean bill.

### Coverage, per column per season (2010-2025, 178,033 rows)

`ff build-weekly-features --seasons 2010-2025` prints it. Steady across the range:

| | `season_line_pg` | `td_ppg` / `t4_mean` | `dvp_mult` / `spread_line` | `days_rest` | `pts` |
|---|---|---|---|---|---|
| 2010 | 51.0% | 80.9% | 94.2% | 88.3% | 61.1% |
| 2015 | 75.6% | 80.9% | 94.2% | 88.3% | 60.5% |
| 2020 | 73.8% | 79.9% | 94.2% | 88.3% | 56.9% |
| 2025 | 75.7% | 81.1% | 94.5% | 89.0% | 57.9% |

2010's season line is thin because 2009 is the first season with a prior-pair curve. `pts` at ~58% is
not a hole: it is the share of rostered player-weeks in which the man actually played, and the other
42% are byes and did-not-plays, which the next section is about.

**The availability block's coverage is not steady, and three feeds explain it.**
`node --import tsx scripts/weekly-availability-coverage.mjs` prints the full table:

| season | `prior_snap_share` | `prior_route_share` | `depth_rank` | injury block | `inj_feed` |
|---|---|---|---|---|---|
| 2010-2012 | 0% | 0% | 0% | 0% | 0% |
| 2013-2015 | 73-75% | **0%** | 73-75% | 89% | 89% |
| 2016-2024 | 72-75% | 71-75% | 64-75% | 89-90% | 89-90% |
| 2025 | 74% | 74% | 89% | **0%** | 90% |
| 2026 (forward) | 0% | 0% | 0% | 0% | 0% |

- **2010-2012**: `feat_player_week_context` does not cover them at all; it starts in 2013.
- **2013-2015**: no participation feed, so route share is absent by construction.
- **2025**: the injury feed publishes no report date, so every filing is undated -- see `inj_feed`
  above. Depth and snaps survive because those feeds still carry dates.
- **2026, the LIVE season**: the forward builder writes rows from the schedule and the board. The
  context table held no 2026 rows at all -- the historical builder reads `raw_injury`, which has none
  for an unarchived season -- so the two-part first stage would have served the live season on its
  declared missing-value defaults, which say everybody is healthy. **`ff build-live-context` fixes
  it** (see section 5), from the live status feeds rather than the archive, one unplayed week at a
  time. The row is filled for the next unplayed week only; every week after it is still blind, and
  correctly reports itself so through `inj_feed`.

---

## 2. The model, and the two decisions that shaped it

**Target: `pts / season_line_pg`.** The season line already encodes who the player is; fitting points
directly would spend the model's capacity re-learning talent. Predicting the ratio makes every
coefficient a statement about what the August number gets wrong week to week, which is the only thing
a weekly model can add.

**The zero atom, and the model it eventually forced.** Weekly points are zero-inflated twice over -- a
rostered man can fail to play at all, and a receiver who plays can catch nothing. Measured on
2010-2025 rostered non-bye weeks: **29.5%** of the rows the model trains on score at or below one
point, and **41.9%** of everything the harness scores is a zero week (`pts <= 0`).

Two treatments were always defensible, and the choice between them was made by the data available:

- **`--zero-model quantile`** (Phase 2c, still the default). One set of heads fitted on the pooled
  target, zeros included, with the clamp floor at **exactly 0** rather than the season model's 0.01,
  so p10 is free to sit on the atom and does. Its limitation is structural rather than a calibration
  failure: **0.10 is the smallest quantile level it publishes, so the largest zero probability it can
  express is 0.10**, however certain the zero is. Against an actual share of 0.419 that is not a model
  that is slightly wrong; it is a model that cannot say the thing.
- **`--zero-model two-part`** (Phase 2d). Stage one is P(zero week), a per-position regularised
  logistic led by the injury designation, the practice report, depth-chart rank and how many
  team-mates at his position are Out; its C is chosen by season-grouped CV on log loss. Stage two is
  the ratio **given he played**, fitted on played weeks only, at a seven-level quantile grid. The
  published p10/p50/p90 are the **mixture's**: q is shifted to `(q - pZero) / (1 - pZero)` and read off
  the grid, so p10 is exactly 0 whenever the zero probability exceeds 0.10, and
  `E[points] = P(he plays) * E[ratio | he plays] * line`.

Until Phase 2d the second one **refused to run**, and the refusal is now conditional rather than
unconditional: it fires when the availability columns are absent from the fitted feature set, with
the same sentence as before. Fitting P(zero) on to-date scoring alone fits the *consequence* of an
injury rather than the injury, and a two-part model without those columns is the same worthless thing
it always was.

What the first stage learned, on the full-data fit, is the cleanest evidence that it is reading the
injury and not its shadow -- these are logit coefficients on standardised columns:

| position | `inj_out` | `inj_doubtful` | `prac_dnp` | next largest |
|---|---|---|---|---|
| QB | +3.38 | +2.67 | +2.38 | `prac_limited` +1.36 |
| RB | +4.91 | +3.96 | +1.75 | `td_games` -1.76 |
| WR | +5.18 | +3.17 | +1.62 | `td_games` -1.42 |
| TE | +3.95 | +2.85 | +1.88 | `td_games` -1.34 |

The golden block carries `pZero` as well as the four published heads, because the mixture is the one
part of the arithmetic with a branch in it, and one fixture is a receiver with an OUT designation --
the row where the branch is actually taken. He projects **P(zero) = 0.967, p10 = p50 = p90 = 0, mean
0.40**, against **6.21** for the otherwise-identical healthy fixture.

**Population: `rostered`, and it is a contract, not a filter.** This cost a full evaluation pass to
find. The trainer originally fitted on appearances while the harness scores every non-bye week -- a
did-not-play week being a real zero for the manager who started him. The model was therefore an
estimator of `E[points | he plays]`, systematically too high for exactly the players a lineup should
be benching: **+0.8 to +1.7 bias against every baseline's -0.4, and coverage 0.57 against a nominal
0.80**, with nothing wrong on either side. They were answering different questions and both were
internally consistent, which is why no test could see it. The population is now recorded on the
artifact, and the harness REFUSES an artifact fitted on a different one.

Form: ridge for the mean with alpha by season-grouped CV; pinball p10/p50/p90 across the **full** rank
range (unlike the season model, which caps at rank 36 because its curve flattens -- there is no such
flattening here, the denominator is a per-player line). Per position, with the usage columns gated by
position exactly as the season model gates them. The holdout is removed before **anything** is
measured, including the transform centres.

### The train-serve seam

`tools/train_weekly.py` fits; `src/weekly/projector.ts` serves. Two implementations of one arithmetic
in two languages is the exact shape that stays green on both sides while disagreeing. The artifact
carries five golden fixture rows with the trainer's own predictions and the loader refuses it if it
cannot reproduce them to 1e-6.

**It caught a real disagreement on its first run.** The trainer stripped `season_line_pg` out of the
fixture feature dict while still reading it itself -- it is both the ratio's denominator AND a declared
regression feature. The two sides differed by 4.05 points on fixture 0, and both were otherwise green.
That is what the golden block is for, and it paid for itself immediately.

Fault injections, all passing: rename a feature, corrupt a golden row, drop a quantile head, drop one
coefficient, a negative clamp floor. The `--season-line-only` artifact is producible and projects the
season line exactly, so nothing silently degrades.

---

## 3. Evaluation: RMSE is not the decision

`ff evaluate-weekly --seasons 2012-2025` holds out one season at a time, retrains on the rest, and
projects the held-out season through the TypeScript evaluator.

Baselines, all through the same code path: **(a)** the season line alone; **(b)** the SHIPPED
`week()` function from `src/projections.ts`, fed a point-in-time defence table instead of the
whole-season `def-ratings.csv` -- the arithmetic is the shipped arithmetic, and scoring it with a
season-long DvP would be beating a baseline that cheats; **(c)** the trailing-4-week mean; **(d)** a
zero-for-everyone model that exists only as a positive control.

Point-forecast baselines get a distribution the same way: their point prediction times the empirical
quantiles of actual/prediction for that position, measured on the **training seasons only**.

**Why the decision metric is a lineup.** Nobody sets a lineup by minimising squared error. A manager
picks two of five receivers and the only thing that matters is whether his two outscore the other
model's two. So: draw many random legal rosters from the week's pool, set each one by each model's
projection, and score the ACTUAL points of the starters chosen. Rosters are common random numbers --
every model sees the same draw -- so `winShare` is a paired statistic, the same discipline CLAUDE.md
records for the championship backtest.

### Results, 14 held-out seasons, 112,782 player-weeks

Two models are reported, on the SAME folds, the same rows and the same baselines. Phase 2c's
quantile-head model is the "no availability columns" row; Phase 2d's two-part model is the one with
them.

Pooled:

| model | RMSE | CRPS | coverage | cov(>0) | bias | P(zero) predicted | actual |
|---|---|---|---|---|---|---|---|
| **weekly, two-part** | **5.268** | **2.150** | 0.853 | 0.798 | -0.085 | 0.384 | 0.419 |
| weekly, quantile heads | 5.474 | 2.314 | 0.876 | 0.813 | -0.027 | 0.132 | 0.419 |
| season line | 5.928 | 2.671 | 0.882 | 0.825 | 0.089 | 0.100 | 0.419 |
| shipped `week()` | 5.927 | 2.664 | 0.875 | 0.804 | 0.087 | 0.161 | 0.419 |
| trailing-4 | 6.129 | 2.619 | 0.885 | 0.831 | 1.134 | 0.161 | 0.419 |
| zero | 8.530 | 5.023 | 0.403 | 0.000 | -4.980 | 0.900 | 0.419 |

The last two columns are the ones Phase 2d exists for. The quantile-head model claims a 13.2% chance
of a zero week against an actual 41.9% -- and it is not badly calibrated so much as *structurally
mute*: 0.10 is the smallest quantile level it publishes. The two-part model says 38.4%. That is the
whole difference between a model that can express the atom and one that cannot.

By position, two-part CRPS against the shipped baseline: QB **2.766 vs 4.448**, RB **2.137 vs 2.683**,
WR **2.055 vs 2.477**, TE **1.510 vs 1.772**, K 2.457 vs 2.468, DST 3.105 vs 3.115. The last two are
near-ties: this table carries no kicking or defensive usage columns, so K and DST are two intercepts
and there is nothing for the model to add.

By preseason-line rank band, two-part RMSE / shipped RMSE: 1-12 **7.223 / 7.933**, 13-24 **6.388 /
7.148**, 25-48 **5.562 / 6.394**, 49+ **3.842 / 4.358**. Banding is by the preseason line, not by the
finish -- stratifying by the outcome would make every band a statement about hindsight. The zero-share
column is worth reading down the bands too: at 49+ the actual share is 0.588 and the two-part model
says 0.516, where the quantile model said 0.154.

Lineup regret, 72,900 rosters drawn per scenario:

| scenario | model | captured | winShare vs shipped |
|---|---|---|---|
| standard-15 | **two-part** | **66.15** | **0.572** |
| standard-15 | quantile heads | 65.14 | 0.501 |
| standard-15 | trailing-4 | 63.97 | 0.486 |
| standard-15 | season line | 61.72 | 0.130 |
| standard-15 | shipped `week()` | 61.74 | -- |
| standard-15 | zero | 47.69 | 0.176 |
| deep-18 | **two-part** | **72.31** | **0.647** |
| deep-18 | quantile heads | 70.77 | 0.569 |
| deep-18 | trailing-4 | 69.08 | 0.533 |
| deep-18 | shipped `week()` | 66.22 | -- |

Note what `winShare` means and does not: 0.572 is the share of rosters where our lineup *strictly*
beat the baseline's, and the large remainder is rosters where the two chose the SAME lineup -- most
of them, because most roster spots are not close calls. The gain is concentrated in the ones that are.

### Pre-registered predictions

| | claim | outcome | evidence |
|---|---|---|---|
| **W1** | the trained model beats the shipped `week()` baseline on CRPS in every position | **HELD** | beaten in all 6 |
| **W2** | its lineup-regret gain is under 2 points per week | **FAILED** | 3.40 (quantile), 4.42 (two-part) per lineup on standard-15 |
| **W3** | the trailing-4-week mean is worse than the season line alone on RMSE | **HELD** | 6.129 vs 5.928 |
| **W4** | the two-part model's lineup gain is at least 5 points per lineup on deep-18 | **HELD** | 6.08 (72.31 vs 66.22) |
| **W5** | its predicted zero-week share matches actual within 3 points, pooled and per position | **FAILED** | pooled off by 0.035; RB 0.031, WR 0.039, TE 0.074 |
| **W6** | `implied_team_total` carries a larger mean-head coefficient than `dvp_mult` at every position | **FAILED** | QB 0.036 vs 0.061, RB 0.033 vs 0.081, WR 0.032 vs 0.049, TE 0.041 vs 0.049 |

**W4 held, and it is the one that settles W2's open question.** The Phase 2c reading of W2 was that
the gain came from in-season form rather than from anything the prediction was about, because the
table had no availability column to test the availability claim. It does now, and adding those columns
alone -- same folds, same baseline -- moves the deep-18 lineup from +4.55 to +6.08 over the shipped
path. Availability is worth roughly **1.5 points per lineup per week** on top of form and matchup.
That is the largest single effect this track has measured.

**W6 failed at every position, and it failed against the record rather than against a guess.** The
recorded belief was that defence-versus-position is small (legacy calibration: talent alone 0.717
correlation, +0.013 from DvP) and that the market's implied team total should dominate it. On the
fitted mean head, with both features centred and scaled by their own training standard deviation so
the coefficients are comparable, `dvp_mult` is the LARGER of the two at all four fitted positions --
by 1.7x at QB and 2.5x at RB. Two honest readings, and this measurement does not separate them: DvP as
built here is a shrunk, prior-blended, point-in-time multiplier rather than the raw season table the
legacy calibration used, so it may simply be a better-constructed feature than the one that measured
+0.013; or the implied total is largely redundant with `spread_line` and `total_line`, which are in
the same fit, and the three are splitting one effect. Either way the record's claim, as stated, is not
what the model does.

**W5 failed, narrowly, and it is the same clause as the gate.** See below.

### The gate

Pre-registered for Phase 2d, **before** this run, against Phase 2c's numbers:

> **(a)** pooled CRPS beats the shipped baseline; **(b)** coverage CONDITIONAL ON pts > 0 in
> [0.75, 0.85] pooled and [0.70, 0.90] per position; **(c)** the predicted share of zero weeks is
> within 3 points of the actual share, pooled and per position.

| clause | quantile heads | two-part |
|---|---|---|
| (a) CRPS vs shipped | **PASS** 2.314 vs 2.664 | **PASS** 2.150 vs 2.664 |
| (b) cov(>0) | **PASS** 0.813 pooled, all positions in band | **PASS** 0.798 pooled, all positions in band |
| (c) zero-share within 0.03 | **FAIL** off by 0.287 pooled; outside at all 6 positions | **FAIL** off by 0.035 pooled; RB 0.031, WR 0.039, TE 0.074 |

**Both FAILED, on (c). The season-line-only artifact keeps shipping.**

The two results say very different things and the difference is the point of having written the
clause. The quantile model misses by 0.287 because it *cannot* say the number. The two-part model
misses pooled by **0.035 against a tolerance of 0.030** -- five thousandths -- and misses at three
positions, worst at TE by 0.074. It is a model that can express the atom and is not yet calibrated on
it.

The temptation here is obvious and is refused: the gate is not widened to 0.04, and nothing is tuned
until (c) passes. A tolerance chosen after seeing 0.035 is not a tolerance. What ships is the floor,
the same as before Phase 2d, and the two-part artifact sits in `data/weekly-artifact.json` as the
measured candidate.

**That inconsistency is now decided, and the decision went the other way from the arrangement.**
Phase 2d recorded it as a caveat: `ff scorecard` read `data/weekly-artifact.json` and would have
frozen 2026's predictions with the two-part model while `lineupRecommend` read the floor, so the
season's forward record would have accrued for a model nobody was served from -- the one failure a
scorecard cannot survive, since its entire claim is that it measures the thing a decision was made
on. The final integration pass gave both surfaces ONE constant,
`SHIPPED_WEEKLY_ARTIFACT` in `src/weekly/projector.ts`, pointing at the floor.

The challenger is not thrown away, because doing so would waste the only evidence left: the
historical folds have all been used. `ff scorecard` snapshots it under its own kind --
`weekly_challenger`, model `two_part` -- on the same players, in the same week, with the same frozen
`as_of`. So the live season grades both models side by side on predictions nobody can tune, which is
exactly the experiment the gate could not settle. Two kinds rather than a sixth model in `weekly`,
because lineup regret inside a kind only means something when every model in it was one somebody
could have chosen.

**The series starts at week 2.** 2026 week 1 was snapshotted on 2026-09-08 under the old
arrangement, so its `weekly` row carries the two-part number; predictions are written once, and
back-filling a challenger row after Thursday's kickoff would be precisely the after-the-fact
prediction this whole surface exists to refuse. `CHALLENGER_FIRST_WEEK` states it and the command
prints it every run, so the gap is a stated fact rather than something a reader has to infer.

Calibrating (c) is a bounded, well-posed next job: the first stage is a plain logistic and its
intercept is the only thing standing between 0.384 and 0.419. It must be pre-registered and re-run
against the baseline that ships **then**, not this one.

---

## 4. The 2026 forward scorecard

Everything above is a backtest: a claim about a model, measured by the person who built it, on data
that already existed. The scorecard is the one measurement that cannot be gamed after the fact, and it
gets that from one property:

> **A prediction is written once, before kickoff, and never updated.**

`scorecard_prediction` is `INSERT OR IGNORE`, so re-running is a no-op and a model improved mid-season
cannot retroactively improve its record -- it can only start a new one. `scorecard_result` is the
opposite, freely rebuildable, because scoring is a pure function of a frozen prediction and a settled
actual. **The snapshot refuses to run late**: a prediction written after the games looks identical to
an honest one in the table, so it is refused rather than flagged.

The live season has no played weeks, so `buildForwardWeeks` assembles the same point-in-time rows from
what exists in September: the published schedule, the board's preseason line, and the prior season's
defence. Nothing new is invented; a week with no line published carries NULL.

### The record so far

`ff scorecard --season 2026 --team-odds --espn`, run 2026-09-08:

```
SCORECARD 2026 -- as of 2026-09-08; imminent week 1
  forward features: 9414 rows, 523 players x 18 weeks;
                    9414 with a season line, 3750 with a published spread
  week 1 snapshot:  weekly 523, season_line 523, shipped_week 523, trailing4 523, espn 430
  season kind:      523 rows (preseason season projection, as of 2026-09-01)
  odds kind:        0 rows  -- see below
  espn:             577 of 800 players carried a week-1 projection; 430 joined our board
  SCORED WEEKS:     (nothing settled yet -- week 1 kicks off 2026-09-09)
```

**There is nothing to score, and that is the correct state.** The 2026 season has not started. What
this run bought is the thing that cannot be bought later: 2,092 week-1 predictions and 523 season
projections, frozen the day before the opener, with an `as_of` that is a fact rather than a claim.

**Week 2, run 2026-09-09 after the final integration**, is the first under the shipped/challenger
split and the first with the live availability columns behind it:

```
SCORECARD 2026 -- as of 2026-09-09; imminent week 2
  week 2 snapshot:  weekly 523, season_line 523, shipped_week 523, trailing4 523
  weekly kind serves weekly-artifact-lineonly.json -- the SAME artifact lineupRecommend serves from
  challenger:       week 2: 523 rows from weekly-artifact.json (kind weekly_challenger,
                    model two_part), series starts week 2
```

All 523 paired rows differ between the two kinds, which is the property the guard requires: if they
agreed, one artifact would be being read for both. The three largest divergences are men the
challenger prices near zero because it can see they are Out -- 9.18 against 0.61, 8.12 against 0.26,
7.84 against 0.03 -- where the floor prices them at their season line. That is the two-part model's
first stage doing the only thing it was built to do, on live data, with the outcome not yet known.
`espn` is absent from this run because it was taken without `--espn` (the bridge read is a separate,
authenticated call).

**ESPN's own number is the third baseline** and the only one that measures this work against the room
rather than against itself. Read-only through the app bridge, never a write. Getting it took a probe,
and the probe is kept (`scripts/weekly-espn-probe.mjs`): the week must go in the URL as
`scoringPeriodId`, without which the league endpoint returns only season-long blocks and nothing
weekly; the plausible-looking `filterStatsForTopScoringPeriodIds` header form makes the fetch fail
outright. The join to our board is by name+position, because `raw_espn_projection` carries ESPN's own
id and nothing in the identity registry maps it -- 430 of 523 board players matched, and inventing a
mapping to close that gap would silently attach one man's projection to another.

**Read the ESPN comparison with the population in mind.** On the 430 players where both have a
week-1 number, our mean is **5.22** and ESPN's is **5.95** -- ours systematically ~12% lower. That is
almost certainly not an accuracy difference: our model is fitted on the `rostered` population, so it
prices in the chance the man does not play, while ESPN's published number reads like a projection
conditioned on playing. It is the same mismatch that cost this track an evaluation pass on its own
model (section 2), now sitting on the other side of the comparison. When week 1 is scored, ESPN will
look biased high against rostered actuals, and that will be a difference in the question being
answered, not a defect. The right reading is the ordering-sensitive one -- CRPS, and lineup regret --
not the bias column.

Face validity of the frozen board, for the record: QB Burrow 16.8 / Herbert 16.7 / Jackson 15.6;
RB Gibbs 13.6 / Hampton 12.9 / Taylor 11.8; WR Chase 10.1 / Nacua 9.9 / St. Brown 9.7;
TE LaPorta 6.9 / Loveland 6.7 / Goedert 6.4.

**The odds kind was EMPTY, and is now filled from the season simulation** (integration pass 2,
2026-09-08). `team_odds` holds a game spread and total, not a playoff or title probability, and a
Brier score accrued against a number manufactured from the spread would measure our own arithmetic
-- so that refusal stands. What changed is that the copilot track supplies the missing number:
`runScorecard` takes an `oddsProvider`, and `ff scorecard --odds` supplies one that loads the sim
context on the league's REAL schedule and runs `seasonOdds` at 3000 trials, seed 7. A GENERATED
schedule is refused outright, because a playoff probability from a stand-in schedule is not this
league's and freezing it write-once would put an uninterpretable number into a record nobody can
rewrite.

Playoff and title are stored as SEPARATE models, two rows per team, because they settle on different
facts and a Brier score over a mixture of the two has no interpretation.

```
odds kind:  32 rows -- 16 teams x {playoff, title}, as_of 2026-09-08, 3000 trials, seed 7
            playoff probabilities sum to 700% (7 berths), title to exactly 100%
            range: playoff 25.5% (HMLS) to 60.0% (TOTR); title 2.2% to 13.7%
```

That is the pre-season prediction the Brier accrual scores at season end.

### Two silent bugs the first live run found

1. **`today` was UTC.** At 22:50 local on 2026-09-08 the UTC date is already 2026-09-09, so the
   harness read week 1 -- whose as-of is 2026-09-08, the day before its Thursday kickoff -- as already
   played, refused to snapshot it, and snapshotted **week 2** instead. Nothing errored. The season
   would have opened with a frozen week-2 prediction made before week 1 and no week-1 record at all.
   A football gameday is a local-calendar date. Those premature rows were deleted before any 2026 game
   was played, so no outcome existed to fit them to.
2. **The ESPN weekly field was absent from the payload**, and the reader said so and stored nothing
   rather than falling back to a season total divided by games -- which would have been our arithmetic
   wearing ESPN's name and would have made the third baseline a fourth copy of the first.

---

## 5. What is waiting on the data track

The trainer and the evaluator take a declared feature-column list, so these plug in without touching
the model code. `PENDING_DATA_TRACK_FIELDS` in `src/weekly/features.ts` is the list, and every report
prints it beside the columns it actually measured with:

**Phase 2d cleared most of this list.** Ten of those columns landed and are declared features;
`PENDING_DATA_TRACK_FIELDS` is now three items, and each is a different kind of gap:

- **`report_status_wed`, `practice_status_wed`** -- built, and empty. The feed's dated filings land at
  kickoff minus two or later, so a Wednesday cutoff catches 11 and 389 rows respectively out of
  133,892. This is not something the model track can fix; it needs a feed that files earlier.
- **A live in-week odds feed** (`vegas_implied_team_total_live`). `team_odds` carries one week --
  whichever was last synced -- and no week number, so the forward builder applies it only to the
  earliest unpriced week. Everything else comes from the schedules feed's closing lines.

**Three open items Phase 2d created rather than closed. Two were closed by the final integration
pass; the middle one is a property of the feed and stands.**

1. **CLOSED. The live season had no availability at all.** `feat_player_week_context` held no 2026
   rows, so the two-part first stage served 2026 on its declared missing-value defaults -- `inj_feed`
   correctly 0, so the model at least knew it was blind rather than believing the league healthy.
   `ff build-features-ext` was NOT the fix: it reads `raw_injury`, which holds nothing for a season
   nobody has archived, so re-running it for 2026 would have produced the same nothing more slowly.
   **`ff build-live-context`** is, and it is a separate verb because it obeys a different rule. The
   historical builder places each filing by its own date; a live feed publishes one current state and
   one timestamp, so the whole snapshot is placed by the point-in-time rule -- **after a week's first
   kickoff, the snapshot belongs to the NEXT week** -- and only that week is written, never
   backfilled. Its sources are ESPN's structured `player_status` and high-severity injury `news`, the
   same two the copilot's OUT refusal reads, deliberately: a man the lineup refuses to start and a
   man the model prices as unlikely to play must not be different men. It carries no practice report
   (`prac_dnp` / `prac_limited` read 0 rather than a guess) and IR / PUP / NFI / suspension all map to
   "Out", which is a judgement recorded as one; Doubtful stays its own indicator because the model has
   a separate coefficient for it. First run on the live store: 462 rows for 2026 week 2, 19 Out, 56
   Questionable, 66 with a positional team-mate out.
2. **STANDS. From 2025 the injury feed publishes no report date at all.** Nothing above changes this:
   the live builder sidesteps it by using a different source, not by learning to place an undated
   filing, which cannot be done safely. Every archived 2025 injury column is still NULL and
   `inj_feed` still says so.
3. **CLOSED. `feat_player_week_model` is now in the engine's `data-sources` registry**, along with
   six other tables that were being served by no key at all -- `feat_player_season`, `feat_curve`,
   `feat_player_week`, `raw_espn_projection`, `scorecard_prediction` and `scorecard_result`. As
   predicted, registering them was the whole of it: the derivation in section 4 of
   `app/renderer/app.js` placed every one without an edit to the node list.

W2's reasoning finally got its actual test. The claim was that availability, not matchup, is the
large weekly edge; the Phase 2c measurement could not test it because it had no availability column,
and the gain it found came from in-season form instead. Section 3's W4 is the direct test.

---

## Commands

```
ff build-weekly-features --seasons 2010-2025 --current-season 2026
    build feat_player_week_model, print coverage per column per season

ff build-live-context [--season 2026] [--now YYYY-MM-DD] [--dry-run] [--json]
    the LIVE season's availability, for the next week that has not kicked off, from
    player_status + high-severity injury news. --now drives the point-in-time rule
    without waiting for Sunday; --dry-run reports what WOULD be written. Run it
    BEFORE the weekly feature build (or before `ff scorecard`, which rebuilds the
    forward weeks itself) so the columns reach feat_player_week_model.

uv run --with scikit-learn --with numpy tools/train_weekly.py \
    --db data/ff.db --seasons 2010-2025 --holdout-season none \
    --features all --zero-model two-part --out data/weekly-artifact.json
    add --season-line-only for the floor artifact; --population {rostered,played};
    --zero-model {quantile,two-part} -- two-part REFUSES unless the availability
    columns are in the fitted feature set

node --import tsx scripts/weekly-artifact-probe.mjs data/weekly-artifact.json
    load an artifact through the CONSUMER's loader (full schema check + golden block)
    and print its golden rows. "the trainer wrote a file" and "the engine can serve
    that file" are two different facts

node --import tsx scripts/weekly-availability-coverage.mjs
    per-column coverage of the availability block by season, with each column's as-of
    rule beside it

ff evaluate-weekly --seasons 2012-2025 --train-seasons 2010-2025 --rosters 300
    nested-by-season evaluation, lineup regret, the pre-registered predictions, the gate

ff scorecard --season 2026 --team-odds --espn
    build forward features, snapshot the imminent week, score every settled week
    --snapshot-only / --score-only / --week N / --today YYYY-MM-DD / --json

node --import tsx scripts/weekly-leak-audit.mjs <season>
    recompute the to-date columns independently and check the `week < w` bound on the
    table as it stands; exits non-zero if it mismatches OR if the leaked-bound control
    fails to fire

node --import tsx scripts/weekly-espn-probe.mjs 2026 1
    read-only: what stat blocks ESPN actually returns for a week

ff build-streaming-features [--seasons 2010-2026]
    build feat_player_week_stream, print the team-week feed rows read per season
    and per-column coverage. The two numbers are printed together on purpose: a
    season the feed does not cover leaves twelve columns NULL at once, and in the
    coverage table alone that is indistinguishable from a season with no data.

uv run --with scikit-learn --with numpy tools/train_streaming.py \
    --db data/ff.db --seasons 2010-2025 --holdout-season none \
    --out data/streaming-artifact.json
    --features weekly-only fits the SAME positions with the twelve streaming
    columns REMOVED: the control the opponent block is measured against, and the
    only baseline P41 can honestly be read against. The trainer REFUSES to emit a
    "streaming" artifact whose streaming columns failed their coverage floor.

ff evaluate-streaming --seasons 2012-2025 --train-seasons 2010-2025
    nested-by-season, TWO artifacts per fold (the model and its control), the
    streaming-regret table, P40-P42 and the per-position gate. --pool-scale N
    scales the free-agent pool boundary so its sensitivity can be checked rather
    than assumed. About 45 minutes: 28 trainer invocations.
```

---

## 6. STREAMING: what the opponent allows, and a decision instead of a projection (Track C, 2026-09-09)

Sections 1-5 answer "how many points will this man score". A streaming decision is a different
question with a different pool: *my defence is on bye and there are nine defences free -- which one*.
The men it is about are, by definition, on nobody's roster. Three things follow, and each is a
separate piece of work below: the features have to be about the OPPONENT rather than about the
player, K and DST have to stop being intercepts, and the metric has to be a PICK rather than an RMSE.

### 6.1 `feat_player_week_stream` -- twelve columns, one anchor, two refusals

Same as-of rule as `feat_player_week_model`: the day before the week's FIRST kickoff, league-wide.
Every accumulated column is bounded by `week < w` of season Y, blended with all of Y-1 and shrunk
toward the LEAGUE MEAN over the same window, weights 4 and 6 -- the same shape `dvpTable` uses, and
the shrink target is a league mean rather than 1.0 because these are absolute units (points, sacks,
yards) and not ratios.

| column | what it is |
|---|---|
| `opp_pa_pos`, `opp_pa_pos_n` | fantasy points the opponent allowed per game **to this player's position**, in POINTS, and the team-games of season-Y evidence behind it |
| `opp_def_sacks_pg`, `opp_def_takeaways_pg` | the opponent DEFENCE's sacks and takeaways per game |
| `opp_pass_yds_allowed_pg`, `opp_rush_yds_allowed_pg` | what that defence allows through the air and on the ground |
| `opp_off_sacks_allowed_pg`, `opp_off_giveaways_pg` | the opponent OFFENCE's sacks suffered and giveaways per game -- **what a DST feeds on** |
| `opp_implied_total` | `total_line - implied_team_total`, i.e. the market's expected points for the other side, exactly as published |
| `roof_dome` | 1 where the roof is dome/closed/indoors |
| `team_fga_pg`, `team_pat_pg` | this player's OWN team's field-goal and extra-point attempts per game |

`opp_pa_pos` is the POINTS version of `dvp_mult`, and the difference is not cosmetic: a multiplier of
1.15 has to be multiplied back onto a per-player line, and K and DST have no meaningful one -- which
is exactly why section 3 reports them as two near-ties.

**Temperature and wind are NOT built, and the refusal is asserted rather than explained.**
`raw_nfl_game` carries `temp` and `wind` and schema.sql says out loud what they are: OBSERVED, "not
knowable before kickoff at all". This store has no forecast feed, and a forecast is a different
quantity from an observation. It is the most attractive leak available on this table -- wind is a
real and large effect on a kicker, the model would find it, and every backtest number would improve
for a reason that cannot exist on a Saturday. `test/streaming-features.test.ts` asserts the columns'
absence, and the audit asserts it against the table on disk. `roof` IS built: a stadium's roof is
knowable when the fixture list is published.

**Red-zone drive rate is not built either, and the substitution is stated.** There is no drive-level
feed here. A "red-zone rate" assembled from box-score totals would be an invented quantity wearing
the name of a measured one, so what the kicker's opportunity actually is -- his own team's FG and PAT
attempts per game -- is built instead.

Coverage, `ff build-streaming-features --seasons 2010-2026`, 187,566 rows:

| | opponent columns | `roof_dome` | `team_fga_pg` / `team_pat_pg` | `opp_implied_total` |
|---|---|---|---|---|
| 2010-2020 | 94.1-94.2% | 94.2% | 100% | 94.2% |
| 2021-2025 | 94.2-94.5% | 94.5% | 100% | 94.5% |
| 2026 (forward) | 89.4% | 75.3% | 100% | **36.9%** |

The ~94% is the share of player-weeks with an opponent at all -- the other 6% are byes, which carry
NULL rather than a fabricated matchup. 2026's `opp_implied_total` is thin because most of the season
has no line published yet, which is a fact about September and is reported rather than filled in.

### 6.2 The guards, and what made them fire

`test/streaming-leakage.test.ts` perturbs week *w*'s own results AND week *w*'s box scores, rebuilds,
and asserts nothing in week *w* moved. Four controls, because a guard that can only ever say "clean"
is dead code:

1. **Every column is non-constant** across the snapshot week before anything else is asserted. This
   fired twice on its first run -- against a fixture whose team stats collided across teams, and
   against `roof_dome`, which the round-robin made constant in exactly the week the guard snapshots.
   Both would have made "it did not move" a statement about nothing.
2. **Week *w*+1 must move.** A perturbation that reaches nothing passes forever.
3. **`leakOpponentThroughWeek` must fire**, on all ten accumulated columns rather than one.
4. **The complement**: a change to the PUBLISHED total line MUST move `opp_implied_total` in week
   *w*, because that is knowable on the Saturday and is the reason the column exists.

`scripts/weekly-leak-audit.mjs` was extended to the table that actually shipped -- an independent
recomputation straight from `feat_player_week` and the cached nflverse team-week CSV, parameterised
by the bound so the control is the same code with one number changed:

```
node --import tsx scripts/weekly-leak-audit.mjs 2023
streaming -- 3689 rows recomputed independently (every third week of 2023)
            mismatches vs `week < w`   vs `week <= w` (the leak)
  opp_pa_pos                    0                   3689
  opp_def_sacks_pg              0                   3689
  opp_pass_yds_allowed_pg       0                   3689
  team_fga_pg                   0                   3689
  opp_implied_total vs total_line - implied_team_total (must be exact): 0 of 11018
```

Zero under the honest bound and **every sampled row** under the leaked one, on 2012, 2015, 2023 and
2025 alike. The audit is honest about how independent it is: the blend arithmetic is shared (a
differently-written weighted mean would test arithmetic, not time), what is independent is the SOURCE
and what is under test is the BOUND -- so the discriminating assertion is the ratio, not the count.

### 6.3 The models, and why K and DST stopped being intercepts

`tools/train_streaming.py` is a WRAPPER around `train_weekly.py`, not a copy: everything that decides
a number is already there and mirrored by `src/weekly/projector.ts`, and a second copy would be a
third implementation of one contract. It overrides four things -- the source (a LEFT JOIN to the
streaming table), the feature lists, the position gating, and `POS_FITTED = all six positions`.

That last one is the point of the track. `train_weekly.py` puts K and DST in `POS_INTERCEPT_ONLY`
with a comment saying why: *this table carries no kicking or defensive usage columns*. Section 3
records the consequence -- K 2.457 vs 2.468 and DST 3.105 vs 3.115 CRPS against the shipped baseline,
two near-ties, because two intercepts have nothing to add. The columns now exist.

**Availability is gated OFF for DST**, and it is a finding rather than a gap:
`feat_player_week_context` holds **0** defensive rows across 2012-2025, so every availability column
is NULL for a defence and fitting them would fit a constant -- an intercept wearing a feature's name.
A team defence does not miss a week; its zero weeks are bad games, which is exactly what the opponent
block is about.

**The golden block had to be overridden too.** The weekly artifact's six fixtures carry no streaming
column, so every streaming coefficient would have been multiplied by its missing-value default in
every golden row -- a contract test structurally incapable of catching the disagreement it exists
for. The eight fixtures here carry real values for all twelve and add a KICKER and a DEFENCE, whose
heads did not exist before. All eight reproduce through the TypeScript loader to 1e-6.

### 6.4 Results, 14 held-out seasons, 112,782 player-weeks

`ff evaluate-streaming --seasons 2012-2025 --train-seasons 2010-2025`, run 2026-09-09. **`two_part`
here is the CONTROL** -- the same trainer with `--features weekly-only`, i.e. the same positions, the
same folds and the twelve opponent columns REMOVED. It is not `weekly-artifact.json`, the weekly
track's challenger; it exists so the opponent block's own contribution can be isolated from "K and
DST stopped being intercepts", which is a different change.

| pos | model | RMSE | CRPS | cov(>0) | zeroP | zeroA |
|---|---|---|---|---|---|---|
| QB | **streaming** | **6.651** | **2.766** | 0.740 | 0.478 | 0.486 |
| QB | two_part (control) | 6.658 | 2.767 | 0.739 | 0.477 | 0.486 |
| QB | shipped `week()` | 8.095 | 4.448 | 0.764 | 0.501 | 0.486 |
| RB | **streaming** | **5.360** | **2.137** | 0.799 | 0.399 | 0.431 |
| RB | two_part (control) | 5.360 | 2.137 | 0.799 | 0.399 | 0.431 |
| RB | shipped `week()` | 6.243 | 2.683 | 0.821 | 0.104 | 0.431 |
| WR | **streaming** | **5.123** | **2.055** | 0.786 | 0.402 | 0.441 |
| WR | two_part (control) | 5.125 | 2.055 | 0.787 | 0.402 | 0.441 |
| WR | shipped `week()` | 5.683 | 2.477 | 0.789 | 0.106 | 0.441 |
| TE | **streaming** | **3.920** | **1.509** | 0.759 | 0.418 | 0.492 |
| TE | two_part (control) | 3.920 | 1.510 | 0.759 | 0.418 | 0.492 |
| TE | shipped `week()` | 4.309 | 1.772 | 0.763 | 0.117 | 0.492 |
| K | **streaming** | **4.449** | **2.112** | 0.844 | 0.204 | 0.209 |
| K | two_part (control) | 4.455 | 2.116 | 0.845 | 0.204 | 0.209 |
| K | shipped `week()` | 5.028 | 2.468 | 0.857 | 0.100 | 0.209 |
| DST | **streaming** | **6.166** | **3.020** | 0.879 | 0.153 | 0.147 |
| DST | two_part (control) | 6.179 | 3.023 | 0.882 | 0.156 | 0.147 |
| DST | shipped `week()` | 6.279 | 3.115 | 0.876 | 0.219 | 0.147 |

**Read the control column first, because it is the finding.** The streaming model beats the shipped
path everywhere and by a lot -- K CRPS 2.112 against 2.468, DST 3.020 against 3.115, both of which
were near-ties before this track. But the CONTROL is within **0.004 CRPS** of the streaming model at
every one of the six positions. What bought the gain at K and DST is that they are FITTED AT ALL --
two intercepts against a real head -- and not the twelve opponent columns. The opponent block's own
contribution is approximately zero, and P42 below fails saying so.

### 6.5 Streaming regret -- the decision, in the units of the decision

RMSE is not the decision and neither is a lineup: the men a streaming decision is about are on
nobody's roster, so they are barely in a drawn roster at all. So for each (season, week, position)
the harness takes the free-agent POOL, asks each model for its ONE best pick, and scores what that
man actually did. 243 scored weeks per position.

The pool is approximated as everyone outside the top N at the position by PRESEASON season line
(N = 24/80/80/32/16/16 for QB/RB/WR/TE/K/DST -- sixteen teams times starters plus typical bench
depth). It is point-in-time and identical for every model, so it sets how HARD the problem is, not
who wins it; a real pool is churnier, which understates every model equally. Track B's
`fact_fa_pool_week` is preferred where it exists and the report names which was used.

| pos | streaming | control | board's pick | trailing-4 | streaming vs board | win share vs board |
|---|---|---|---|---|---|---|
| QB | **16.16** | 16.08 | 8.11 | 14.82 | **+8.05** | 0.638 |
| RB | 8.06 | 8.06 | 2.70 | 7.64 | +5.36 | 0.712 |
| WR | 8.27 | **8.42** | 5.37 | 8.07 | +2.90 | 0.547 |
| TE | **6.83** | 6.80 | 2.88 | 5.43 | +3.96 | 0.704 |
| K | **8.79** | 8.57 | 6.75 | 7.34 | **+2.04** | 0.564 |
| DST | 8.43 | **8.52** | 6.14 | 6.32 | **+2.28** | 0.551 |

The gap against the board's pick is large at every position and is mostly a statement about the
board rather than about the model: a preseason line ranks the pool by who was expected to be good in
August, and by October the useful signal is who is playing. The gap against the CONTROL is +0.08 at
QB, +0.22 at K, **-0.09 at DST** and -0.15 at WR -- i.e. it changes sign, which over 243 weeks is
what a null looks like.

### 6.6 The pre-registered predictions

| | claim | outcome | evidence |
|---|---|---|---|
| **P40** | for QB, K and DST the streaming pick beats the best-by-season-line pick by at least 1.0 point per week | **HELD** | QB +8.05, K +2.04, DST +2.28 |
| **P41** | for RB, WR and TE the opponent features add LESS than 0.5 point per week over the same model without them | **HELD** | RB +0.00, WR -0.15, TE +0.03 |
| **P42** | DST CRPS improves by at least 5% with the opponent's implied total and turnover rates | **FAILED** | 0.1% (3.0195 vs 3.0230) |

**P41 held and P42 failed, and they are the same finding read at two positions.** The record's
expectation going in was that matchup is small for the skill positions and decisive for a defence.
The first half is confirmed to three decimal places. The second half is not: the opponent's implied
total and its giveaway rate move DST CRPS by one tenth of one percent. The DST mean head does load
on the matchup -- `opp_pa_pos` is its largest non-line term at 0.305, and the model separates week-2
defences from 3.66 to 8.85 where the floor gives 5.86 to all of them -- so it is not that the model
ignores the opponent. It is that a defence's week is dominated by variance the opponent's season
averages do not predict: one returned interception is eight points.

**P40 held by a wide margin and is the weakest of the three.** Beating the preseason board's pick by
eight points a week at quarterback sounds like a large result and is mostly a statement about how bad
that baseline is in October. The comparison that matters is the control column, and there it is +0.08.

### 6.7 The gate, per position

The pre-registered weekly gate -- clause (a) CRPS beats the shipped baseline, (b) coverage
conditional on pts > 0 in [0.70, 0.90], (c) predicted zero-week share within 0.03 of actual --
applied one position at a time, with its bands and tolerance IMPORTED from `evaluate.ts` rather than
retyped, so a clause cannot be loosened here while the weekly track's stays put.

| pos | (a) CRPS | (b) cov(>0) | (c) zero share | verdict |
|---|---|---|---|---|
| QB | PASS 2.766 vs 4.448 | PASS 0.740 | PASS off by 0.008 | **SHIPS** |
| RB | PASS 2.137 vs 2.683 | PASS 0.799 | **FAIL off by 0.031** | keeps the floor |
| WR | PASS 2.055 vs 2.477 | PASS 0.786 | **FAIL off by 0.039** | keeps the floor |
| TE | PASS 1.509 vs 1.772 | PASS 0.759 | **FAIL off by 0.074** | keeps the floor |
| K | PASS 2.112 vs 2.468 | PASS 0.844 | PASS off by 0.005 | **SHIPS** |
| DST | PASS 3.020 vs 3.115 | PASS 0.879 | PASS off by 0.006 | **SHIPS** |

**RB, WR and TE fail on exactly the clause and very nearly the numbers the weekly two-part model
failed on** (section 3: pooled 0.035, RB 0.031, WR 0.039, TE 0.074). That is the expected result
rather than a coincidence: clause (c) is about AVAILABILITY -- who does not play -- and these twelve
columns are about the matchup. Nothing here was ever going to fix it, and the temptation to widen the
tolerance to 0.04 is refused for the same reason it was refused in Phase 2d: a tolerance chosen after
seeing the number is not a tolerance.

**So the shipped surface is now MIXED, and that is the thing to be careful about.**
`SHIPPED_STREAMING_POSITIONS = ["QB", "K", "DST"]` in `src/weekly/streamingServe.ts` is the one
place it is decided; RB, WR and TE serve `weekly-artifact-lineonly.json`, the same floor
`lineupRecommend` and `ff scorecard`'s `weekly` kind serve. Every result of `stream_recommend`
carries `artifactByPos`, and `ff scorecard` prints it every run, because "which model said this" is
the one thing a per-position decision makes impossible to infer from the number.

### 6.8 The decision surface, and the forward record

`ff copilot stream --pos DST --week 2` / MCP tool `stream_recommend` -- see `docs/mcp.md`. Live and
read-only through the app bridge, 2026 week 2:

```
DST  START MIN D/ST (4.82 pts, p10 0, p90 13.7, P(zero) 0.21)
     ADD SF D/ST / DROP Isaiah Likely: +2.8 pts this week
     Best free: SF D/ST 7.63, CHI D/ST 6.78, ATL D/ST 5.96
QB   START Jared Goff (15.55 pts, P(zero) 0.14) -- no free quarterback beats him
     Best free: Tua Tagovailoa 15.2, Sam Darnold 13.78, Bryce Young 11.45
K    START Cairo Santos (7.24 pts); ADD Tyler Bass / DROP Isaiah Likely: +0.1 pts
```

The kicker row is the honest one to read: +0.1 points is not a reason to make a claim, and the tool
reports it rather than rounding it into a recommendation.

The scorecard's new `stream` kind freezes ONE pick per position per week, plus the pick a manager
makes by reading the board, side by side -- because freezing only ours would leave a number with no
referent, and adding the comparison in January would be adding it after the games. Week 2, frozen
2026-09-09 with `as_of` 2026-09-16:

```
QB   Tua Tagovailoa 15.20   vs the board's Sam Darnold 13.78
DST  SF D/ST         7.63   vs the board's DAL D/ST      5.95
K    Harrison Mevis  8.19   vs the board's Harrison Mevis 8.19  (the same man)
RB / WR / TE                 the same man in both rows, necessarily
```

RB, WR and TE name the same man in both rows because the floor's projection IS the season line, so
its ranking of the pool IS the board's. That is not a bug in the record; it is the visible
consequence of those three positions not shipping, and it means their `stream` series will accrue
zero regret until they do.

## Determinism

The full 14-fold evaluation was run twice, end to end, including re-invoking the Python trainer for
every fold. Every number in section 3 is byte-identical across the two runs -- alpha search, quantile
subsample (seeded `default_rng(7)`), roster draws and all. A harness whose numbers move between runs
cannot tell a real gain from a re-draw, so this is checked rather than assumed.
