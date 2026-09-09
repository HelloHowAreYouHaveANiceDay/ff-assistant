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

---

## 2. The model, and the two decisions that shaped it

**Target: `pts / season_line_pg`.** The season line already encodes who the player is; fitting points
directly would spend the model's capacity re-learning talent. Predicting the ratio makes every
coefficient a statement about what the August number gets wrong week to week, which is the only thing
a weekly model can add.

**The zero atom: quantile heads that can reach zero.** Weekly points are zero-inflated twice over -- a
rostered man can fail to play at all, and a receiver who plays can catch nothing. Measured on
2010-2025 rostered non-bye weeks: **29.5%** of the rows the model trains on score at or below one
point, and about **40%** of everything the harness scores does. Two treatments are defensible -- a two-part model (P(zero week) from availability
signals, times the ratio given a real week), or quantile heads free to sit on the atom. This artifact
uses the latter, with the clamp floor at **exactly 0** rather than the season model's 0.01. The reason
is not elegance: the signals that would drive a two-part first stage -- injury designation as of the
Friday report, depth-chart rank, whether the man ahead of him is out -- are the DATA TRACK's columns
and do not exist yet. Fitting P(zero) on to-date scoring alone fits the *consequence* of an injury
rather than the injury. `--zero-model two-part` exits with that sentence rather than fitting a stage
it cannot honestly feed.

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

### Results, 14 held-out seasons, 111,591 player-weeks

Pooled:

| model | RMSE | CRPS | coverage | cov(>0) | bias |
|---|---|---|---|---|---|
| **weekly** | **5.493** | **2.335** | 0.868 | 0.800 | -0.045 |
| season line | 6.019 | 2.718 | 0.884 | 0.828 | -0.304 |
| shipped `week()` | 6.016 | 2.728 | 0.894 | 0.836 | -0.306 |
| trailing-4 | 6.128 | 2.589 | 0.886 | 0.833 | 1.090 |
| zero | 8.543 | 5.033 | 0.403 | 0.000 | -4.990 |

By position, weekly CRPS against the shipped baseline: QB 3.240 vs 4.592, RB 2.357 vs 2.767, WR 2.225
vs 2.510, TE 1.622 vs 1.848, K 2.470 vs 2.490, DST 3.111 vs 3.119. The last two are near-ties: this
table carries no kicking or defensive usage columns, so K and DST are intercept-only and there is
nothing for the model to add.

By preseason-line rank band, weekly RMSE / shipped RMSE: 1-12 **7.430 / 7.986**, 13-24 **6.664 /
7.245**, 25-48 **5.799 / 6.432**, 49+ **4.027 / 4.466**. Banding is by the preseason line, not by the
finish -- stratifying by the outcome would make every band a statement about hindsight.

Lineup regret:

| scenario | model | captured | winShare vs shipped |
|---|---|---|---|
| standard-15 | **weekly** | **65.15** | **0.505** |
| standard-15 | trailing-4 | 64.16 | 0.499 |
| standard-15 | season line | 61.49 | 0.117 |
| standard-15 | shipped `week()` | 61.50 | -- |
| standard-15 | zero | 47.74 | 0.183 |
| deep-18 | **weekly** | **70.63** | **0.575** |
| deep-18 | trailing-4 | 69.25 | 0.548 |
| deep-18 | shipped `week()` | 65.87 | -- |

72,900 rosters drawn per scenario. Note what `winShare` means and does not: 0.505 is the share of
rosters where our lineup strictly beat the baseline's, and the large remainder is rosters where the
two models chose the SAME lineup -- which is most of them, because most roster spots are not close
calls. The gain is concentrated in the ones that are.

### Pre-registered predictions

| | claim | outcome | evidence |
|---|---|---|---|
| **W1** | the trained model beats the shipped `week()` baseline on CRPS in every position | **HELD** | beaten in all 6 |
| **W2** | its lineup-regret gain is under 2 points per week | **FAILED** | 3.64 points per lineup (standard-15) |
| **W3** | the trailing-4-week mean is worse than the season line alone on RMSE | **HELD** | 6.128 vs 6.019 |

W2 is the interesting one and it failed in the direction of the work being *more* valuable than
predicted, which is the direction to be most suspicious of. Two readings, and the honest answer is
that they are not separated by this measurement:

- The reasoning behind W2 was that the measured defence-versus-position edge is small (legacy
  calibration: talent alone 0.717 correlation, +0.013 from DvP) and the large weekly edge is
  availability, which this table cannot see. That reasoning still looks right: `dvp_mult` carries a
  small coefficient everywhere (RB 0.065, WR 0.047, TE 0.057).
- What W2 did not anticipate is that most of the gain comes from **in-season form** -- `t4_mean` and
  `td_ppg` are the two largest coefficients at every position -- and from the **bias correction** the
  `rostered` population supplies. Both are things a season line genuinely does not know, and neither
  is a matchup effect. The prediction was right about matchups and wrong about the size of what else
  was on the table.
- Note also that trailing-4 alone captures 64.16 against our 65.15. Most of the lineup gain is
  available from a folk model, and the trained model's margin over *it* is about one point.

### The gate

Pre-registered: ship the trained artifact only if it beats the shipped baseline on pooled CRPS **and**
coverage is in [0.75, 0.85].

**FAILED, on coverage: 0.868.** CRPS passes comfortably (2.335 vs 2.728). So the **season-line-only
artifact is what ships**, and this section says so rather than quietly re-specifying the band.

Post hoc, and explicitly not part of the gate: over non-zero weeks the same statistic reads **0.800**
-- exactly nominal, and better than the shipped baseline's 0.836. The pooled figure is inflated by the
zero atom sitting on a p10 of exactly 0; those weeks genuinely are inside the interval. Every baseline
over-covers too (0.884, 0.894, 0.886), so the trained model is the best-calibrated thing in the table
on the very statistic that failed it. The gate was written without the atom in mind. It is left as
written, and a future gate specified on `cov(>0)` -- decided **before** the next run, not after this
one -- is the honest way to revisit it.

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

**ESPN's own number is the third baseline** and the only one that measures this work against the room
rather than against itself. Read-only through the app bridge, never a write. Getting it took a probe,
and the probe is kept (`scripts/weekly-espn-probe.mjs`): the week must go in the URL as
`scoringPeriodId`, without which the league endpoint returns only season-long blocks and nothing
weekly; the plausible-looking `filterStatsForTopScoringPeriodIds` header form makes the fetch fail
outright. The join to our board is by name+position, because `raw_espn_projection` carries ESPN's own
id and nothing in the identity registry maps it -- 430 of 523 board players matched, and inventing a
mapping to close that gap would silently attach one man's projection to another.

**The odds kind is EMPTY and says why.** `team_odds` holds a game spread and total, not a playoff or
title probability. A Brier score accrued against a number we manufactured from the spread would
measure our own arithmetic. When a real playoff/title probability exists in the store, the kind
populates and the accrual starts; until then it is zero rows and a sentence.

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

`injury_status_friday`, `depth_chart_rank`, `teammates_out`, `prior_snap_share`, `prior_route_share`,
`vegas_implied_team_total`.

Two things change when `feat_player_week_context` lands:

- **The two-part zero model becomes measurable.** Right now it is refused; with a Friday injury
  designation and a depth-chart rank there is something real to condition P(zero week) on, and the
  comparison against the quantile-head form is a one-flag experiment.
- **W2's reasoning gets its actual test.** The claim was that availability, not matchup, is the large
  weekly edge. This measurement could not test it because it has no availability column. The gain it
  found came from in-season form instead. Adding the injury columns and re-running the same harness is
  the direct test, and it should be run against the baseline that ships **then**, not this one.

---

## Commands

```
ff build-weekly-features --seasons 2010-2025 --current-season 2026
    build feat_player_week_model, print coverage per column per season

uv run --with scikit-learn --with numpy tools/train_weekly.py \
    --db data/ff.db --seasons 2010-2025 --holdout-season none \
    --features all --out data/weekly-artifact.json
    add --season-line-only for the floor artifact; --population {rostered,played}

ff evaluate-weekly --seasons 2012-2025 --train-seasons 2010-2025 --rosters 300
    nested-by-season evaluation, lineup regret, the pre-registered predictions, the gate

ff scorecard --season 2026 --team-odds --espn
    build forward features, snapshot the imminent week, score every settled week
    --snapshot-only / --score-only / --week N / --today YYYY-MM-DD / --json

node --import tsx scripts/weekly-espn-probe.mjs 2026 1
    read-only: what stat blocks ESPN actually returns for a week
```
