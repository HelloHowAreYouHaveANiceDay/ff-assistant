# M2a -- the WEEKLY EXPERT CONSENSUS as a weekly feature (screened 2026-09-16)

**VERDICT: ADMIT on the measurement, BLOCKED at the serve boundary. Nothing shipped.**

`ecr_wk_rank` clears the weekly paired-season floor by the widest margin any weekly feature candidate
has produced in this repo -- **+0.0413 pooled CRPS, 5 of 5 seasons, against a 2.9\*SE floor of 0.0165**
on the seasons the archive covers, with an exact null (+0.00015, 3/5) on the seasons it does not. The
gate clauses all still pass and lineup regret moves the right way. It is not shippable today for the
same reason `feat_injury_horizon` was not (docs/weekly.md section 5, D19): **the archive stops in 2024
and there is no live weekly-consensus column**, so a fitted coefficient would serve NOTHING to a 2026
lineup. Unlike the injury horizon, the live feed for this one already exists in the store and the gap
is a retention bug rather than a dead feed -- see "The serve path" below, which is the decision this
screen actually puts to the owner.

This is a screen, not a ship. `data/weekly-artifact.json`, `weekly-artifact-lineonly.json`,
`streaming-artifact.json` and `dst-stream-artifact.json` are byte-identical before and after
(md5 `a3871f4c...`, `d2982b1c...`, `8514b5d4...`, `adf50690...`). The two columns are
**declared-not-fitted**: the shipped trainer command produces the same 25-feature artifact it did
yesterday, and only an explicit `--features ...,ecr_wk_rank,ecr_wk_sd` reaches them.

---

## 1. The column, and its as-of rule

`ranking_history` with `ecr_type = 'wp'` is FantasyPros' **weekly positional** consensus: for one
scrape date and one position, `ecr` is already the within-position rank and `sd` is the spread of the
expert panel around it. (`wo` is the overall list -- a different quantity on a different scale.)

Two columns were added to `feat_player_week_model`, both `REAL`, both NULL where absent:

| column | rule |
|---|---|
| `ecr_wk_rank` | the player's `wp` consensus rank within his position, from the **latest scrape dated at or before this team's kickoff minus two days**, and no later. NULL if the newest qualifying scrape is more than **8 days** old, and NULL if the player is not on that scrape's list. |
| `ecr_wk_sd` | the panel's dispersion on the same row of the same scrape. |

**Why the anchor is kickoff-minus-two and not the table's league-wide `as_of`.** Everything in the
first block of `feat_player_week_model` is keyed to the day before the week's FIRST kickoff, which is
a Wednesday. This feed is scraped on **Fridays**. The strictly-safest anchor would therefore have
produced an EMPTY column rather than a safer one. So it takes the availability block's anchor instead
-- this team's own kickoff minus two days, the same cutoff the Friday injury report uses, and for the
same stated reason (docs/weekly.md section 1): it is strictly before **this player's own kickoff**,
which is the only thing a lineup decision needs, and a Friday consensus is not derived from any game's
result. The widening is recorded rather than buried. A team playing Thursday gets a Tuesday cutoff and
therefore **the previous week's** list, stale by seven days -- that is what was actually knowable, and
it is left stale rather than quietly advanced.

**Staleness is a refusal.** A bye-week gap or a hole in the archive must not hand the model a
three-week-old opinion wearing this week's name, so past 8 days the value is NULL. **A player absent
from the qualifying scrape is NULL**, not backfilled from an older list: the panel's answer for that
week is the list, and a man who is not on it has no weekly consensus.

**Join.** `(name_key, position)` -- the archive's own key. `docs/data-sources.md` says why position
is in it (A.J. Green is both a WR and a DB; dropping position merged two men). The feed's `PK` is
mapped to our `K`; its IDP lists (DB/DL/LB) are dropped, not stored.

Code: `ecrWeekTable` / `ecrWeekCutoff` in `src/weekly/features.ts`, called from both the historical
builder (`buildInto`) and the forward builder (`buildForwardInto`). Declared in
`WEEKLY_FEATURE_FIELDS` (so `src/weekly/projector.ts` will accept an artifact that fits them),
`src/db/schema.sql`, the `src/db/db.ts` additive migration, and `tools/train_weekly.py`'s `CENTER` /
`SELECT_COLS` / `MASKABLE_GROUPS`.

**The D19 serve contract is honoured.** Explicit `missing` (mean-imputation, i.e. 0 after centring)
for the linear heads; NaN passthrough for the boosted design (`feature_value_nan` /
`weeklyFeatureValueBoosted`, unchanged -- they are generic over the spec list); and **its own mask
group**, `"ecr"` at `MASK_DROP_P = 0.97`, the availability block's rate, because it goes absent for
the same reason and just as completely. Without that a boosted head would never have seen the column
missing and a 2026 lineup would route into an out-of-distribution leaf -- the gate-7 collapse, D19.

---

## 2. Coverage

`wp` scrapes exist for **2020-2024 only**: 20 dates in 2020 (from 2020-08-20), 19 in 2021 (from
09-10), 16 in 2022 (from 09-16), 16 in 2023 (from 09-15), **15 in 2024 (from 09-27 -- so 2024's first
three weeks have none)**. 2019 carries one stray date, 2019-12-27. There is nothing for 2012-2018,
2025 or 2026.

Share of **decision-population** rows (`in_population = 1`) carrying a value:

| season | QB | RB | WR | TE | K | DST | all |
|---|---|---|---|---|---|---|---|
| 2010-2018 | 0% | 0% | 0% | 0% | 0% | 0% | 0.0% |
| 2019 | 3.9% | 5.0% | 4.2% | 3.8% | 4.4% | 0% | 3.9% of 5010 |
| 2020 | 82.6% | 87.9% | 88.9% | 84.6% | 78.7% | 0% | 76.9% of 4974 |
| 2021 | 78.4% | 82.5% | 85.4% | 86.9% | 80.3% | 0% | 74.7% of 5333 |
| 2022 | 77.6% | 81.2% | 84.2% | 89.4% | 81.3% | 0% | 74.4% of 5297 |
| 2023 | 69.0% | 82.2% | 87.9% | 82.9% | 75.8% | 0% | 72.9% of 5258 |
| 2024 | 64.2% | 71.2% | 72.3% | 77.6% | 69.5% | 0% | 63.9% of 5270 |
| 2025, 2026 | 0% | 0% | 0% | 0% | 0% | 0% | 0.0% |

**2012-2019 and 2025-2026 are MISSING BY CONSTRUCTION.** Nothing is imputed for them and nothing
should be read into a model's behaviour there.

**DST is 0% and it is a NAME-KEY gap, not a feed gap.** The archive ranks defences as
`Buffalo Bills` / `buffalobills`; our rows are `BUF DST`. A team-name crosswalk is trivially safe
(unlike a player one) but it is **not built here**, because `train_weekly.py` puts DST in
`POS_INTERCEPT_ONLY` and `WEEKLY_SERVE["DST"]` is the separate matchup model (D20) -- so a DST value
could not have moved a single number in this screen. It is a real follow-up if DST is ever fitted on
this table.

---

## 3. The leakage guard, and its two fault injections

`node --import tsx scripts/ecr-week-leak-guard.mjs --seasons 2020-2024`, read-only, against the table
that actually shipped (not the builder against itself). It recomputes every row from
`ranking_history` and `raw_nfl_game` with an independent implementation, parameterised **by the
offset from kickoff** so the control is the same code with one number changed.

```
ECR WEEKLY-CONSENSUS LEAK GUARD -- seasons 2020, 2021, 2022, 2023, 2024, max scrape age 8 days

  60287 rows over 5 seasons; 36311 carry a weekly consensus
  oldest qualifying scrape used: 8 days before the cutoff (bound 8)
  OK    the column is populated at all (a guard over an empty column measures nothing) -- 36311 values
  OK    A NEGATIVE: every stored value reproduces from the honest cutoff (kickoff - 2) -- 60287 rows agree exactly, both directions
  OK    B FAULT INJECTION: the LEAKED cutoff (kickoff + 1) disagrees, so check A can fail -- 6893 rows differ
  OK    C FAULT INJECTION: the anchor shifted back one day disagrees, so the column is pinned to THIS anchor -- 24133 rows differ
  OK    D ERA BOUND: no value outside the seasons the `wp` archive covers -- outside the screened window: 2019:321

ECR LEAK GUARD HELD: every value is from a scrape at or before this team's Friday cutoff, and the guard can fail.
```

Zero mismatches under the honest bound; **6,893 rows move the moment the cutoff crosses the games**
and 24,133 move when the anchor shifts by one day. The discriminating fact is that the check CAN
fire, twice, in two different directions -- a comparison that reported "clean" against every bound
would be a comparison connected to nothing. What is independent here is the implementation and the
gameday source; what is under test is the BOUND, which is the same honesty the streaming audit states
about its own blend arithmetic.

`test/weekly-ecr-column.test.ts` audits the RULE on a hermetic fixture (the table audit and the
builder audit are different claims): a list published the day after the slate must not be reachable
at the honest cutoff and MUST be reachable at a leaked one; the latest qualifying scrape wins; past
the age bound is a refusal, not a carry-forward; an unranked man is NULL rather than backfilled; `PK`
maps to `K` and IDP rows are dropped; and the `wo` overall list is unreachable. Plus the
cross-language half: both names are in `WEEKLY_FEATURE_FIELDS` **and** in `train_weekly.py`'s own
`SELECT_COLS`, `CENTER` and `MASKABLE_GROUPS` source -- a name declared with a transform but absent
from the SELECT reads as missing on every row and fits an intercept.

---

## 4. Positive control and pre-filter (charter rules 2 and 4)

**Positive control -- top 5 by `ecr_wk_rank`, 2023 week 6.** These are the real stars of that week,
which is what a connected column looks like:

```
QB   Mahomes 1.24 (17.3 pts), Allen 1.37 (13.9), Hurts 2.92 (19.9), Jackson 4.53 (17.1), Fields 5.16 (4.9)
RB   McCaffrey 1.08 (12.7), Pollard 3.06 (14.0), Ekeler 3.78 (8.2), Etienne 5.04 (21.8), Robinson 5.65 (10.5)
WR   Hill 1.10 (25.3), Chase 2.14 (11.0), Diggs 3.00 (15.0), Kupp 4.14 (24.3), Allen 4.94 (18.0)
TE   Kelce 1.00 (16.9), Hockenson 1.91 (8.0), Andrews 2.91 (8.9), Engram 4.36 (7.6), LaPorta 4.94 (5.6)
K    Butker 1.94 (17.0), Bass 2.00 (0.0), Elliott 3.15 (1.0), Aubrey 4.27 (8.0), Tucker 5.33 (19.0)
DST  (none -- the name-key gap above)
```

**Pre-filter -- is it the LEVEL in disguise?** This is the check that killed raw `prior_vol` (0.58
correlated with the level the model already carries). Correlations on the 2020-2024 decision
population, 15,977 rows carrying all of `{pts, ecr_wk_rank, season_line_pg, t4_mean}`. Rank is
inverted (1 is best), so a negative correlation is the predictive direction.

| pos | n | corr(ecr, pts) | corr(ecr, line) | corr(ecr, t4_mean) | **partial corr(ecr, pts \| line, t4_mean)** | partial corr(sd, pts \| line, t4) |
|---|---|---|---|---|---|---|
| ALL | 15977 | -0.377 | -0.459 | -0.582 | **-0.105** | -0.041 |
| QB | 2184 | -0.421 | -0.601 | -0.703 | **-0.219** | -0.083 |
| RB | 4159 | -0.504 | -0.562 | -0.769 | **-0.227** | -0.030 |
| WR | 5119 | -0.419 | -0.603 | -0.737 | **-0.208** | -0.062 |
| TE | 2521 | -0.399 | -0.545 | -0.703 | **-0.176** | -0.077 |
| K | 1994 | -0.103 | -0.241 | -0.365 | **-0.097** | +0.002 |

It **is** substantially a level (0.55-0.60 with the preseason line, 0.70-0.77 with trailing form --
of course it is; a weekly consensus is mostly a restatement of who is good). What separates it from
every previous candidate is what survives: **-0.18 to -0.23 partial correlation with actual points at
all four fitted positions, after both the level AND the form are partialled out.** That is the
orthogonal-and-predictive combination the frontier doc has been looking for and not finding. The
`sd` column is much weaker (-0.03 to -0.08) and is carried along rather than motivated.

**Served-lever control.** A dead lever and a real null draw the same flat line, so the fitted
2023-holdout artifact was driven through the **consumer's** projector on one otherwise-identical
high-line fixture (`season_line_pg` 12, healthy, week 6, snap share 0.85), varying only the two new
columns:

```
QB  missing: 14.61 (pZero .037) | rank 1: 15.15 (.011) | 12: 15.04 (.011) | 24: 14.76 (.021) | 48: 11.57 (.144)
WR  missing: 12.54 (.043)       | rank 1: 12.84 (.020) | 12: 12.79 (.025) | 24: 12.73 (.029) | 48:  8.70 (.032)
RB  missing: 14.54 (.021)       | rank 1: 14.74 (.008) | 12: 14.74 (.008) | 24: 14.69 (.011) | 48: 16.41 (.015)
TE  missing: 13.12 (.055)       | rank 1: 13.55 (.031) | 12: 13.79 (.039) | 24: 13.33 (.041) | 48: 13.09 (.058)
```

The lever moves the SERVED number (QB 15.15 -> 11.57, P(zero) 0.011 -> 0.144 for a man the panel has
dropped to QB48), and the `missing` row degrades to the anchor rather than collapsing, which is the
mask-group augmentation doing its job. The fold artifact carries **27** features, both new names
included, at all four fitted positions.

---

## 5. The screen

`ff evaluate-weekly --seasons 2012-2025 --train-seasons 2012-2025 --rosters 300 --json`, twice, one
arm each, then `scripts/weekly-paired-floor.mjs` (pooled CRPS, season as the unit of analysis,
2.9\*SE floor, common-random-number rosters). Both arms were produced from ONE invocation pair; every
number below -- CRPS, the gate clauses, lineup regret -- comes out of those same two runs.

**Fairness of the comparison (step 5, and it is not incidental).** Both arms fit on **identical rows
and identical seasons**: the trainer's row selection is `in_population = 1 AND season_line_pg IS NOT
NULL`, which does not reference the candidate column, so a NULL `ecr_wk_rank` drops nothing. Both
arms are 14 folds of the same nested-by-season design, the same 2012-2025 window, the same boosted
learner and two-part zero model read off the shipped artifact, the same 72,900 drawn rosters per
scenario, and the same 70,011 scored rows. The candidate is not credited for a smaller or easier
training set; it sees the same data with two more columns, which are NULL on 9 of the 14 seasons.
The baseline is the **25-feature set the shipped artifact actually fits** -- NOT `--features all`,
which would have included `rz_share_td` and `prior_vol_cv`, two previously-REJECTED candidates that
do not ship (CLAUDE.md: re-measure against the baseline you intend to ship).

### 5.1 Pre-registered decision block

Stated before the numbers were read, because a partition chosen after seeing them is not a partition:
**the decision is the paired result on 2020-2024, the seasons the column exists in.** The canonical
2012-2020 / 2021-2025 split is reported too, and is reported first, but its selection block contains
**one** covered season out of nine and is therefore structurally unable to see the feature -- it
measures the archive's coverage, not the candidate.

### 5.2 The canonical partition, all 14 seasons

```
per-season pooled CRPS (base -> cand, improvement = base - cand):
  2012  2.7220 -> 2.7252   -0.0031        2019  2.8362 -> 2.8408   -0.0046
  2013  2.7970 -> 2.7981   -0.0010        2020  2.8624 -> 2.8259   +0.0365
  2014  2.6769 -> 2.6796   -0.0027        2021  2.8149 -> 2.7881   +0.0268  (holdout)
  2015  2.7106 -> 2.7123   -0.0017        2022  2.6871 -> 2.6525   +0.0345  (holdout)
  2016  2.6214 -> 2.6210   +0.0004        2023  2.7261 -> 2.6753   +0.0509  (holdout)
  2017  2.7063 -> 2.7017   +0.0045        2024  2.8382 -> 2.7802   +0.0580  (holdout)
  2018  2.8616 -> 2.8522   +0.0095        2025  2.8229 -> 2.8113   +0.0116  (holdout)
```

| arm | improvement (CRPS) | SE | floor (2.9\*SE) | 95% CI | wins/losses | verdict |
|---|---|---|---|---|---|---|
| ALL SEASONS (14) | +0.01567 | 0.00576 | 0.01670 | [0.00549, 0.02672] | 9/5 | REJECT (just under) |
| SELECTION 2012-2020 (9) | +0.00419 | 0.00430 | 0.01246 | [-0.00180, 0.01278] | 4/5 | REJECT |
| HOLDOUT CONFIRM 2021-2025 (5) | **+0.03635** | 0.00832 | 0.02413 | [0.02226, 0.05043] | **5/0** | **ADMIT** |

Read the row structure rather than the verdicts: **every season with the column is positive and every
season without it is a coin flip.** The canonical split puts four of the five covered seasons in the
holdout, so the "selection rejects, holdout admits" pattern here is the coverage boundary, not the
regime split `prior_vol_cv` showed.

### 5.3 The decision block -- 2020-2024, and its negative control

```
  2020  2.8624 -> 2.8259   +0.0365      2023  2.7261 -> 2.6753   +0.0509
  2021  2.8149 -> 2.7881   +0.0268      2024  2.8382 -> 2.7802   +0.0580
  2022  2.6871 -> 2.6525   +0.0345
```

| block | improvement | floor (2.9\*SE) | 95% CI | wins/losses | verdict |
|---|---|---|---|---|---|
| **2020-2024, the decision** | **+0.04134** | 0.01650 | [0.03184, 0.05083] | **5/0** | **ADMIT** |
| within it, 2020-2022 | +0.03262 | 0.00860 | [0.02681, 0.03654] | 3/0 | ADMIT |
| within it, 2023-2024 | +0.0545 (2 seasons) | -- | -- | 2/0 | too few for a floor |
| **2012-2019 NEGATIVE CONTROL** (column NULL on every row of both arms) | **+0.00015** | 0.00479 | [-0.00257, 0.00360] | 3/5 | REJECT -- a clean null |

**The negative control is the load-bearing line.** If the gain came from the re-fit, the extra design
columns, or the augmentation rather than from the information, it would show up on the eight seasons
where both arms see the identical NULL. It measures +0.00015 -- zero to four decimals, 3/5 seasons.
So the +0.041 is the column.

**One number this screen does NOT explain: 2025 is +0.0116** although the column is NULL there. It is
outside the uncovered-seasons SE (0.0017), so it is probably not pure noise; the plausible mechanism
is that 2025 is the dead-injury-feed era, and a candidate model that learned (via the 0.97 mask rate)
to lean less on the availability block degrades differently there. It is small, it is not part of the
decision block, and nothing here rests on it. Flagged rather than explained away.

### 5.4 By position, and the gate clauses

Pooled over all 14 held-out seasons -- so diluted by the 9 seasons with no column. The direction is
what matters; the magnitudes on covered seasons are roughly three times these.

| pos | base CRPS | cand CRPS | delta |
|---|---|---|---|
| QB | 3.1607 | 3.1101 | +0.0506 |
| RB | 2.7102 | 2.6933 | +0.0169 |
| WR | 2.8558 | 2.8398 | +0.0160 |
| TE | 2.2283 | 2.2212 | +0.0072 |
| K | 2.4747 | 2.4747 | 0.0000 |
| DST | 3.1334 | 3.1334 | 0.0000 |

K and DST are exactly unchanged, which is the expected result and a small control in its own right:
they are `POS_INTERCEPT_ONLY` in this trainer, so a new column cannot reach them, and a non-zero
number there would have meant something else had moved.

**The three gate clauses, for the candidate model** (docs/weekly.md section 3; imported, not retyped):

| clause | baseline (25 features) | candidate (27) |
|---|---|---|
| **(a)** pooled CRPS beats the shipped `week()` baseline | PASS 2.7647 vs 3.4182 | **PASS 2.7483 vs 3.4182** |
| **(b)** coverage given pts > 0 in [0.75, 0.85] pooled, [0.70, 0.90] per position | PASS 0.840, every position inside | **PASS 0.841, every position inside** |
| **(c)** predicted zero-week share within 0.03 of actual, pooled and per position | PASS 0.241 vs 0.246 (off 0.005) | **PASS 0.242 vs 0.246 (off 0.005)** |

Pooled, the candidate is RMSE 6.2170 (base 6.2446), CRPS 2.7483 (base 2.7647), coverage 0.846, bias
+0.127 (base +0.107). **All three clauses pass and none was widened or altered.**

### 5.5 Lineup regret -- the decision metric

Same 72,900 common-random-number rosters per scenario, from the same invocation pair.

| scenario | baseline captured | candidate captured | delta | base winShare | cand winShare | shipped `week()` |
|---|---|---|---|---|---|---|
| standard-15 | 85.54 | **85.73** | +0.19 | 0.717 | 0.724 | 76.98 |
| deep-18 | 90.46 | **90.70** | +0.24 | 0.732 | 0.739 | 80.52 |

Pooled over 14 seasons of which 5 carry the column, so the covered-season figure is roughly 2.5-3x
this. It is the right sign and it is small in absolute terms, which is the honest reading: most
lineup slots are not close calls, and the CRPS gain concentrates in the ones that are.

**Streaming regret was not run.** `ff evaluate-streaming` fits through `train_streaming.py`, a
different feature list and a different artifact; adding the column there is a separate screen.

---

## 6. Step 4 -- the manager backtest: NOT RUNNABLE, and why

`scripts/inseason-backtest-lineup.mjs` **cannot be pointed at a candidate artifact.** Its three arms
are `floor` / `challenger` / `served`, resolved through `MODEL_FILES` in
`src/inseason/backtest/context.ts`, which names `SHIPPED_WEEKLY_ARTIFACT`,
`CHALLENGER_WEEKLY_ARTIFACT` and the `WEEKLY_SERVE` table as fixed constants read from `data/`. There
is no artifact flag, and the only way to run the candidate through it would be to overwrite
`data/weekly-artifact.json` -- which this screen is forbidden from doing and should be forbidden from
doing, since the live copilot reads that file from disk per call. **So the screen stops at step 3, as
the brief provides for, and the -1.4 pts/wk manager gap is not measured here.**

The change that would enable it is small and is a legitimate follow-up: give `MODEL_FILES`/`loadModel`
an override path and add `--artifact <path>` to the script, with the served arm refusing the override
(it is a table, not a file). It is not made here because it touches the in-season backtest harness,
which is outside this screen's allowed surface.

---

## 7. The serve path -- the actual blocker, and it is closer than injury-horizon's

A fold gain that cannot reach a live lineup is worth nothing (D19's injury-horizon finding, stated
verbatim in docs/weekly.md section 8). So, measured rather than assumed:

- **`ranking_history.wp` stops at 2024-12-27.** It is the DynastyProcess archive
  (`src/data/ecrHistory.ts`); nothing refreshes it in-season. 2025 and 2026 have no rows.
- **BUT the live feed already exists in this store.** `weekly_rank` is FantasyPros' current-week
  positional ranking, ingested by `ingestWeekly` in `src/data/advanced.ts`, and it carries **exactly
  the quantities this column needs** -- `pos`, `rank`, `ecr`, `best`, `worst`, `sd`. That is the same
  feed at the same grain, one week at a time.
- **Three things stand between it and a serve, and all three are fixable:**
  1. **It is truncated on every ingest** (`DELETE FROM weekly_rank` before the upsert) and its key is
     `(player_id, pos)` with **no season and no week column**. So no history accrues and a stored row
     cannot be placed in a week -- the point-in-time rule cannot even be stated against it.
  2. **Its `scraped` stamp is the only as-of it has**, and on this store it reads **2026-09-08** --
     eight days stale as of today. A serve needs the ingest to run **before each week's Friday
     cutoff**, or the column serves last week's opinion with no way to tell.
  3. **The forward builder reads `ranking_history`, so it currently writes NULL for 2026**, correctly
     and by construction. Pointing it at `weekly_rank` is a real change with a real point-in-time
     obligation attached, not a wiring tweak.

**The decision this puts to the owner** is therefore not "ship the feature" but "is the weekly-rank
retention worth building" -- add `(season, week)` to `weekly_rank`, stop truncating, schedule the
ingest inside the Friday window, then re-screen with the live path in the loop. On the evidence above
that is the highest-value open item the weekly track has: +0.041 CRPS is larger than anything else
screened on this grain by an order of magnitude, and unlike the injury horizon the feed is not dead.

Until then the honest state is: **ADMITTED on the historical measurement, NOT SHIPPED, dead at serve.**

---

## 8. Yahoo (step 6): not run

The column is format-independent (it is a rank, not a point total), so the same screen against
`data/formats/sc-a845f67652fb/features.db` is a genuine second target. It was not run -- the two
14-fold ESPN arms cost about 90 minutes and the session budget went to the negative control and the
serve-path measurement instead, both of which were load-bearing for the verdict and neither of which
Yahoo would have changed. The per-format `features.db` files predate these columns; `loadWeeklyRows`
and `ensureContextColumns` were both made tolerant of a store that lacks them (selecting only the
columns present, and adding them on the next build), so a Yahoo run needs a rebuild of that format's
weekly table and nothing else.

---

## 9. What was changed, and the gates

Changed: `src/weekly/features.ts` (the column, its as-of rule, both builders, the loader, coverage),
`src/db/schema.sql` + `src/db/db.ts` (additive columns), `tools/train_weekly.py` (declaration, mask
group, SELECT), `scripts/weekly-paired-floor.mjs` (a `--seasons` flag, for a candidate that exists
over part of the range), new `scripts/ecr-week-leak-guard.mjs`, new `test/weekly-ecr-column.test.ts`.
`data/ff.db` was backed up online to `data/ff.db.bak-prem2a-2026-09-16` (integrity_check ok, 187,728
weekly rows) before the two columns were filled; the fill was a targeted UPDATE of those two columns
only, through the same exported functions the builder calls, so no other column of
`feat_player_week_model` moved.

| gate | result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 975 tests, 973 pass, 2 skipped, **0 failures** (the one failure this work caused -- an unmigrated store hitting `m.ecr_wk_rank` in `loadWeeklyRows` -- was fixed by `presentEcrWeekFields`, the `presentContextFields` pattern, plus the schema.sql column) |
| `npx eslint .` | 0 errors, 46 warnings, **none in any file touched here** (verified by running eslint over exactly those files: no output) |
| served weekly artifacts byte-identical | yes -- all four md5s unchanged |
| championship backtest | **39.5% championships / 96% playoffs**, unchanged |

```
npm run ff -- backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150
  consensus-blend [QB=0.5]: re-rank the board toward FFToday (6997 player-seasons)
FORMAT  weeks 1-13, 7-team playoff, seeding division-winners-first, bracket reseeds  (from the espn format block)
BACKTEST age-curve opportunity FULL-SYSTEM(real lineup)+inflation no-lookahead(prev-yr proj)  16-team $200 HALF 7-team-playoff | reserve=4 maxShare=0.25  market 0.3  book vor
  CHAMPIONSHIPS: 39.5%  (random 6.3%)  |  playoffs: 96%
  ROOKIES: added 1451 draft-capital-priced rookies across 25 seasons (~58/yr) to the pool
  per season: 2000:28%  2001:31%  2002:44%  2003:47%  2004:32%  2005:29%  2006:49%  2007:19%  2008:47%  2009:55%  2010:44%  2011:62%  2012:47%  2013:41%  2014:29%  2015:38%  2016:29%  2017:33%  2018:41%  2019:36%  2020:43%  2021:35%  2022:54%  2023:33%  2024:40%
```

---

## 10. Verdict, plainly

The weekly expert consensus is **real, orthogonal to the level and the form, and large** -- the
largest weekly feature effect this repo has measured (+0.0413 CRPS, 5/5 seasons, floor 0.0165, with
an exact null on the seasons it does not cover), it passes all three gate clauses, and it moves
lineup regret in the right direction. **It is not shippable today** because the archive ends in 2024
and the live path (`weekly_rank`) is truncated on every ingest and carries no week stamp, so a fitted
coefficient would serve zero to a 2026 lineup. **Nothing was shipped; no default, trainer default or
served artifact changed.** The owner decision is whether to build the `weekly_rank` retention that
would make this servable, and re-screen with the live path in the loop.

---
---

# M2b -- READY FOR SIGN-OFF (built 2026-09-16, nothing promoted)

**The serve boundary above is gone.** The retention is built, the live column is populated, a
candidate artifact exists at a temp path, and its week-2 predictions are frozen write-once so the
admission accrues out-of-sample evidence whatever the owner decides and whenever he decides it.
**Nothing is served.** `WEEKLY_SERVE`, every default feature list and all four served artifacts are
untouched; the candidate is reachable only by naming its file.

| served artifact | md5 before M2b | md5 after M2b |
|---|---|---|
| `data/weekly-artifact.json` | `a3871f4c489164abbda8e29734b16f53` | **unchanged** |
| `data/weekly-artifact-lineonly.json` | `d2982b1c809838356bd450b8e0e3ae3f` | **unchanged** |
| `data/streaming-artifact.json` | `8514b5d4406193055cebb9f813e8db46` | **unchanged** |
| `data/dst-stream-artifact.json` | `adf5069013d2f65b7328b1ae4dfd4ace` | **unchanged** |

**A CORRECTION TO THE BRIEF, STATED FIRST BECAUSE EVERY NUMBER BELOW DEPENDS ON IT. The live week is
WEEK 2, not week 3.** 2026 week 1 (09-09..09-14) is settled and carries actuals; week 2 runs
2026-09-17..09-21 with a league `as_of` of **2026-09-16, which is today** -- so today is the LAST day
the write-once snapshot for week 2 could legally be taken at all, and week 3's own snapshot is a week
away. Doing this for "week 3" would have meant freezing a prediction for a week whose consensus has
not been published and skipping the one week that was still open. Everything below is week 2.

---

## 11. The retention, and its idempotency proof

`ingestWeekly` (src/data/advanced.ts) now does two writes of deliberately different kinds. `weekly_rank`
is untouched in behaviour -- still `DELETE`d and rewritten, still keyed `(player_id, pos)`, still the
answer to "what is he ranked NOW". The same rows are ALSO appended into `ranking_history` as
`ecr_type = 'wp'`, keyed by the feed's own `scrape_date` on the ARCHIVE'S OWN PRIMARY KEY
(`source, ecr_type, scrape_date, player_id, pos`) via `appendWeeklyRankSnapshot` (src/data/ecrHistory.ts).

**Because the key is the archive's, `ecrWeekTable` needed NO change to serve 2026.** The historical
builder, the forward builder, the leak guard and the trainer all read one table with one rule. That
is the whole design: the retention is not a second path to the same quantity.

Three refusals, each one a property rather than a convention:

- **Append only.** `INSERT OR IGNORE`, never `DELETE`, never `UPDATE`. A re-ingest of a scrape we
  already hold writes nothing; a new scrape date is a new row; and a CHANGED value under an existing
  key does **not** move the row already held (`test/weekly-ecr-retention.test.ts` asserts this
  inverse case explicitly -- an `ON CONFLICT DO UPDATE` would pass every other assertion in the file).
- **The scrape's own date, not the ingest time.** A row whose date is ABSENT falls back to the ingest
  date; a row whose date is UNPARSEABLE is **dropped**, because stamping a scrape of unknown vintage
  with "today" manufactures the one fact the entire point-in-time rule rests on.
- **`season` is the scrape year**, byte-for-byte what `ingestEcrHistory` stamps, so a later reload of
  the DynastyProcess archive cannot disagree with a row we wrote. (Safe here: in six seasons the
  archive holds no January `wp` date -- redraft weekly lists stop in December.)

### 11.1 The control (run against the live store, twice)

```
ranking_history wp rows BEFORE: 67991
weekly_rank scraped BEFORE: 2026-09-08            <- eight days stale, the M2a finding
RUN 1: live=815 archived=815 ignored=0 dates=2026-09-16
ranking_history wp rows AFTER RUN 1: 68806  (+815)
  2026-09-16: DB=101 DL=71 DST=32 K=33 LB=94 QB=72 RB=114 TE=116 WR=182
RUN 2: live=815 archived=0 ignored=815 dates=2026-09-16
ranking_history wp rows AFTER RUN 2: 68806  (+0)

  OK    run 1 appended rows (815)
  OK    every fielded position present (QB,RB,WR,TE,K,DST)
  OK    run 2 is IDEMPOTENT: 0 new rows, 0 reported
  OK    run 2 SAW the rows (815 ignored on conflict) -- the check can fail
```

The last line is the one that makes the third mean anything: `inserted 0, ignored 0` would also
satisfy "wrote nothing" and would mean the append never ran. It reports 815 conflicts, so it ran and
the table refused it.

**BACKFILL IS IMPOSSIBLE, and this is permanent.** `fp_latest_weekly.csv` publishes exactly one
scrape -- the latest -- with no history endpoint, and every scrape before today was overwritten in
place by the old `DELETE`. The archive therefore has a hole from 2025-01-01 to 2026-09-15 that
nothing can fill. The 2026 series starts at 2026-09-16 and grows one scrape a week from here.

**IDP is kept, DST is kept, and `wo` is NOT written.** The feed publishes nine positional pages
(qb / ppr-rb / ppr-wr / ppr-te / k / dst / dl / lb / db) and **no overall page**, so there is no
weekly-overall consensus in this feed to retain; pooling the positional lists into one would be our
number wearing FantasyPros' name. IDP rows are stored because the archive stores them and
`ecrWeekTable` drops them at READ time -- one filter, in the reader, rather than two that can
disagree. DST rows are stored as `Denver Broncos`-style team names and still do not join our
`DEN D/ST` rows: **the M2a name-key gap is unchanged and is still a real follow-up**, costing nothing
today because `train_weekly.py` puts DST in `POS_INTERCEPT_ONLY` and `WEEKLY_SERVE["DST"]` is the
separate matchup model.

### 11.2 The cadence -- built, NOT enabled, and that is the one thing left for the owner

A new routine `rankings` (`ff ingest-source weekly`) is **first in the registry**, and that order is
load-bearing: `rankings` refreshes the feed and appends the scrape, `actuals` rebuilds
`feat_player_week_model` through `buildForwardInto` (which is what READS the archive and fills the
column), and `scorecard` then FREEZES the week write-once. In any other order a prediction is frozen
on a week-old consensus with nothing in the frozen row saying so.

It is in `DEFAULT_ROUTINES`, so any fresh store gets it. **The live store does not**, and this is the
config-precedence trap CLAUDE.md names:

```
settings.scheduler = {"enabled":true,"everyMinutes":15,"routines":["actuals","scorecard","decisions"]}
```

A stored schedule OVERRIDES `DEFAULT_ROUTINES` entirely, so on this machine the routine exists and
never runs. **Writing that settings row is an outward-facing change to a running app's behaviour and
is therefore left for the sign-off** (charter rule 1), not done as a side effect. The one-line fix is
in section 16. Until it is run, the archive only accrues when someone runs `ff ingest` or
`ff ingest-source weekly` by hand -- which is exactly the fragile state this work exists to end.

**IT IS VERIFIED TO RUN, not merely registered.** Two defects were caught between writing it and
this line, both of the shape where a routine sits in the schedule looking enabled and does nothing:

- it first named **`ingest-raw weekly`**, and `cmdIngestRaw` refuses any id outside `RAW_ASSETS`
  with `exit 2` -- `weekly` is an L1 asset. The verb is `ingest-source`.
- `ingest-source` was **not in the tick's `HANDLERS` map**, and the tick SKIPS an unmapped verb
  rather than failing. `test/routines.test.ts` asserts exactly this and is what surfaced it.

The positive control, which is the only thing that separates "registered" from "runs":

```
npm run ff -- inseason-tick --routines rankings
inseason-tick: rankings -- 1 step(s)
  weekly consensus retained: +0 new ranking_history rows (815 already held) at scrape 2026-09-16
materialized weekly: 815 rows + rebuilt board (3011ms)
  ok   ingest-source weekly                 3.0s
1/1 steps ok in 3.0s
```

At 15 minutes the routine lands ~300 times between Thursday and Sunday's first kickoff, which is far
more than the Friday window needs; the repeat cost is one ~300KB CSV and an `INSERT OR IGNORE` that
writes nothing. Over-running is a no-op by construction. A single weekly run would be the fragile
design: one missed Friday and the week has no consensus at all, with no second chance before kickoff.

---

## 12. The live column

Filled by a **targeted UPDATE of the two columns only**, through the same exported helpers the
builder calls (`ecrWeekTable` / `ecrWeekCutoff`), so there is one definition of the rule and no other
column of `feat_player_week_model` moved. (`buildForwardInto` would have produced the identical
values -- it already reads `ranking_history` -- but it DELETEs and rewrites the whole season, moving
thirty columns for a change about two.) `data/ff.db` was backed up online to
`data/ff.db.bak-prem2b-2026-09-16` first (`integrity_check ok`, 187,728 weekly rows, 67,991 `wp` rows).

```
archive scrape dates for 2026: 2026-09-16
9576 rows: 420 carry a consensus, 9156 NULL
per week (decision population):
  week  1:    0 /  295   (played; its anchor precedes our first retained scrape)
  week  2:  236 /  295   (80.0%)   <- THE LIVE WEEK
  week  3:   16 /  295   (5.4%)
  weeks 4-18: 0          (no scrape exists yet that is within 8 days of their anchors)
```

All rows (not only the decision population): week 2 is **395 / 532**. By position, as
`loadWeeklyRows` hands them to the model: **QB 53/60, RB 102/144, WR 141/177, TE 71/84**.

**Every zero and every gap above is the rule working, not a hole.** Three separate refusals produce
them and each is verifiable:

- **Week 1 is 0** because it is already played and its anchors are all before 2026-09-16.
- **The 59 NULL rows inside week 2's decision population** are `BUF=10, DET=9` plus 40 men scattered
  across other teams. The BUF/DET 19 are the **Thursday game (2026-09-17)**: their anchor is
  kickoff-minus-two = **2026-09-15**, one day BEFORE the scrape, so the rule refuses it. That is the
  documented widening working in the honest direction -- a Thursday team gets what was knowable on
  Tuesday, and today's list was not. The other 40 are men absent from the published list, which is
  NULL rather than backfilled from an older one.
- **Week 3 is 16, not 0**, and that is also correct: one team kicks off Thursday 2026-09-24, anchor
  2026-09-22, and the 2026-09-16 scrape is 6 days old at that anchor -- inside the 8-day bound. It is
  a stale-but-knowable value, exactly as section 1 provides for. Weeks 4+ are all past the bound.
- **Our roster, 8 of 12** carry a value: `Bo Nix 18.4, Breece Hall 15.5, Colston Loveland 2.9,
  Isaiah Likely 7.7, Chris Godwin Jr. 29.6, Marvin Harrison Jr. 40.3, Michael Pittman Jr. 36.5,
  Cairo Santos 7.7`. The four misses are `Jared Goff / Amon-Ra St. Brown / Jameson Williams` (all
  **DET**, the Thursday anchor) and `MIN D/ST` (the name-key gap; DST is intercept-only anyway).

### 12.1 The leak guard, on the live rows

`node --import tsx scripts/ecr-week-leak-guard.mjs --seasons 2020-2026`

```
  82175 rows over 7 seasons; 36731 carry a weekly consensus
  oldest qualifying scrape used: 8 days before the cutoff (bound 8)
  OK    the column is populated at all -- 36731 values
  OK    A NEGATIVE: every stored value reproduces from the honest cutoff (kickoff - 2) -- 82175 rows agree exactly, both directions
  OK    B FAULT INJECTION: the LEAKED cutoff (kickoff + 1) disagrees -- 6941 rows differ
  OK    C FAULT INJECTION: the anchor shifted back one day disagrees -- 24502 rows differ
  per season: 2020 7244/11543 (B 1652, C 555); 2021 7789/12816 (B 1454, C 6666);
              2022 7556/12312 (B 1456, C 5974); 2023 7372/11664 (B 1206, C 5948);
              2024 6350/11952 (B 1125, C 4990); 2025 0/12312 (B 0, C 0);
              2026 420/9576 (B 48, C 369)
  OK    D ERA BOUND -- archive covers 2019,2020,2021,2022,2023,2024,2026; outside the screened window: 2019:321

ECR LEAK GUARD HELD
```

The per-season line is new and it is the part that matters here: **both fault injections fire on the
2026 rows specifically** (48 rows move under a leaked cutoff, 369 under a shifted anchor). An
aggregate pass over seven seasons could have been carried entirely by the archive; this shows the
guard is connected to the live season, not merely averaged over it.

**One guard was itself repaired.** Check D's covered-season list was the literal `2019..2024` --
true the day it was written and FALSE the moment the retention appended a 2026 scrape, at which point
a correct column would have failed the era bound. It now DERIVES the covered seasons from
`ranking_history`, so a live season passes because it IS covered and a fabricated one still fails.
That is coverage-by-enumeration, the guard that rots while staying green (CLAUDE.md), caught by this
work rather than by a later green run.

---

## 13. The candidate artifact

```
uv run --with scikit-learn --with numpy tools/train_weekly.py \
  --db data/ff.db --seasons 2010-2025 --holdout-season none \
  --features td_ppg,t4_mean,t4_sd,td_games,spread_line,total_line,implied_team_total,days_rest,\
week_no,season_line_pg,td_fd,td_ts,td_attempts,td_rush_yards,prior_snap_share,prior_route_share,\
depth_rank,teammates_out,home,inj_out,inj_doubtful,inj_questionable,prac_dnp,prac_limited,inj_feed,\
ecr_wk_rank,ecr_wk_sd \
  --zero-model two-part --learner gbm \
  --out data/weekly-artifact.candidate-ecr.json
```

i.e. **the shipped recipe exactly, plus two names**. The feature list is the 25 the served artifact
actually fits -- NOT `--features all`, which would drag in `rz_share_td` and `prior_vol_cv`, two
previously-REJECTED candidates (D-note in docs/decisions.md; CLAUDE.md: re-measure against the
baseline you intend to ship). `populationHash 7ca2e2be49fc5aa7`, `populationRows 84582` -- identical
to the served artifact's, so the two were fitted on the same rows.

### 13.1 The refit control, and it is decisive

Before comparing anything, the same command was run **with the 25 features only** to
`data/weekly-artifact.candidate-base.json`:

> **the 25-feature refit reproduces `data/weekly-artifact.json` BYTE-FOR-BYTE** (identical JSON
> ignoring `fittedAt`; same `populationHash`, same `populationRows`).

So the trainer is deterministic on this store today, the store's fitting rows have not drifted since
the served artifact was cut on 2026-09-15, and **every difference between the served artifact and the
candidate is caused by adding the two columns to the design** -- there is no refit noise to
disentangle. (The control file was deleted after the comparison; re-run the command above without the
last two feature names to reproduce it.)

### 13.2 Serve-check through the consumer's loader

`node --import tsx scripts/weekly-artifact-probe.mjs data/weekly-artifact.candidate-ecr.json` --
this runs the full schema check AND recomputes the golden block to 1e-6, so a producer/consumer
disagreement is an exception rather than a slightly different projection nobody notices.

```
data/weekly-artifact.candidate-ecr.json: schema 2, zeroModel two-part, 27 features, positions DST/K/QB/RB/TE/WR
  second-stage grid: 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9
  GOLDEN ROWS (reproduced by this evaluator to 1e-6, or the load above would have thrown)
   0 RB   line  14.5  inj_out 0  mean 18.665  p10 5.407  p50 17.730  p90 30.946  P(zero) 0.0350
   1 WR   line    11  inj_out 0  mean  7.736  p10 0.000  p50  5.650  p90 18.377  P(zero) 0.2733
   2 QB   line  19.5  inj_out 0  mean 22.629  p10 10.898  p50 21.454  p90 32.613  P(zero) 0.0102
   3 TE   line   7.5  inj_out 0  mean  3.350  p10 0.000  p50  0.763  p90  9.568  P(zero) 0.4809
   4 RB   line     9  inj_out -  mean  9.894  p10 0.000  p50  8.350  p90 21.478  P(zero) 0.1580
   5 WR   line    13  inj_out 1  mean  0.175  p10 0.000  p50  0.000  p90  0.000  P(zero) 0.9880
```

(The served artifact's same six golden rows, for comparison: 18.983 / 9.338 / 23.013 / 4.234 / 9.321
/ 0.200.) The trainer's own `boosted_self_check` reproduced scikit-learn to 1e-9 before writing.

---

## 14. BEFORE / AFTER on the live week (2026 week 2, league 462233, format `sc-f6143a8dfb13`)

**BEFORE** = what the store serves today, each position through `WEEKLY_SERVE`.
**AFTER** = the same with QB/RB/WR/TE swapped to the candidate and **K/DST left alone** -- which is
exactly what promotion would do, since the candidate would replace `CHALLENGER_WEEKLY_ARTIFACT`,
which serves those four and nothing else. Comparing a wholesale artifact swap would have measured a
change nobody is proposing.

### 14.1 Top 12 per position, ordered by the SERVED projection

`ecr` is the retained consensus rank (`-` = the column is NULL for that man this week).

**QB**

| player | tm | ecr | before | after | delta |
|---|---|---|---|---|---|
| Josh Allen | BUF | - | 26.09 | 24.93 | -1.16 |
| Caleb Williams | CHI | 4.3 | 25.33 | 27.22 | +1.89 |
| Bryce Young | CAR | 20.7 | 22.10 | 22.93 | +0.83 |
| Trevor Lawrence | JAC | 10.6 | 20.28 | 19.48 | -0.80 |
| Brock Purdy | SF | 6.5 | 19.83 | 20.20 | +0.37 |
| Jaxson Dart | NYG | 12.5 | 19.44 | 18.72 | -0.73 |
| Matthew Stafford | LAR | 14.5 | 18.75 | 18.17 | -0.58 |
| Patrick Mahomes II | KC | 12.9 | 18.59 | 20.86 | +2.27 |
| Dak Prescott | DAL | 5.5 | 18.14 | 18.53 | +0.39 |
| Lamar Jackson | BAL | 2.1 | 18.08 | 21.06 | **+2.98** |
| Jayden Daniels | WAS | 6.4 | 17.62 | 17.52 | -0.10 |
| Justin Herbert | LAC | 9.7 | 17.60 | 17.25 | -0.35 |

biggest movers: Lamar Jackson +2.98 (ecr 2.1), Kyler Murray -2.38 (ecr 33.6), Mahomes +2.27 (ecr
12.9), Caleb Williams +1.89 (ecr 4.3), Cam Ward +1.17 (ecr 30.1). **The sign tracks the consensus at
QB**, which is what a connected column looks like.

**RB**

| player | tm | ecr | before | after | delta |
|---|---|---|---|---|---|
| Derrick Henry | BAL | 4.8 | 24.08 | 21.47 | -2.61 |
| Jahmyr Gibbs | DET | - | 22.33 | 22.55 | +0.22 |
| Bijan Robinson | ATL | 1.9 | 19.66 | 20.63 | +0.98 |
| D'Andre Swift | CHI | 14.4 | 19.51 | 18.32 | -1.19 |
| Javonte Williams | DAL | 11.6 | 19.24 | 17.85 | -1.40 |
| Ashton Jeanty | LV | 6.0 | 19.06 | 19.71 | +0.65 |
| Jonathan Taylor | IND | 5.9 | 15.91 | 16.72 | +0.81 |
| Kenneth Walker III | KC | 6.2 | 15.79 | 17.21 | +1.43 |
| Breece Hall | NYJ | 15.5 | 14.54 | 14.67 | +0.13 |
| Bucky Irving | TB | 17.4 | 13.88 | 13.52 | -0.36 |
| David Montgomery | HOU | 17.1 | 13.70 | 14.86 | +1.16 |
| Chase Brown | CIN | 11.8 | 13.67 | 15.02 | +1.35 |

biggest movers: Jeremiyah Love +3.37 (ecr 20.3), Christian McCaffrey +2.87 (ecr 3.5), Derrick Henry
-2.61 (ecr 4.8), TreVeyon Henderson +1.88 (ecr 45.2), Kenneth Walker III +1.43 (ecr 6.2).

**WR**

| player | tm | ecr | before | after | delta |
|---|---|---|---|---|---|
| Puka Nacua | LAR | 1.7 | 27.43 | 12.32 | **-15.11** |
| Deebo Samuel Sr. | SF | 40.5 | 18.56 | 12.13 | -6.44 |
| Mike Evans | SF | 17.6 | 18.29 | 9.92 | -8.37 |
| Jaxon Smith-Njigba | SEA | 3.8 | 16.57 | 16.16 | -0.40 |
| Amon-Ra St. Brown | DET | - | 16.56 | 16.14 | -0.42 |
| Zay Flowers | BAL | 22.8 | 16.41 | 16.26 | -0.15 |
| Christian Watson | GB | 14.0 | 16.17 | 16.60 | +0.43 |
| Davante Adams | LAR | 24.9 | 15.84 | 7.40 | **-8.44** |
| Chris Olave | NO | 6.7 | 14.81 | 15.46 | +0.66 |
| Nico Collins | HOU | 7.9 | 13.97 | 14.16 | +0.19 |
| Ja'Marr Chase | CIN | 3.4 | 13.92 | 13.91 | -0.00 |
| CeeDee Lamb | DAL | 6.6 | 13.61 | 13.84 | +0.23 |

**TE**

| player | tm | ecr | before | after | delta |
|---|---|---|---|---|---|
| Trey McBride | ARI | 1.0 | 14.34 | 13.43 | -0.91 |
| Colston Loveland | CHI | 2.9 | 11.14 | 9.84 | -1.30 |
| Dallas Goedert | PHI | 7.5 | 10.40 | 11.21 | +0.81 |
| Isaiah Likely | NYG | 7.7 | 10.18 | 10.94 | +0.76 |
| Dalton Kincaid | BUF | - | 9.43 | 5.56 | -3.86 |
| Tyler Warren | IND | 3.5 | 9.18 | 8.81 | -0.38 |
| Juwan Johnson | NO | 10.2 | 9.03 | 9.04 | +0.00 |
| Harold Fannin Jr. | CLE | 13.2 | 8.88 | 7.60 | -1.28 |
| George Kittle | SF | 11.2 | 8.64 | 7.63 | -1.02 |
| Mike Gesicki | CIN | 24.5 | 8.49 | 9.25 | +0.76 |
| T.J. Hockenson | MIN | 19.5 | 8.20 | 8.12 | -0.08 |
| Pat Freiermuth | PIT | 20.9 | 7.94 | 8.04 | +0.09 |

### 14.2 THE SURPRISE, DIAGNOSED -- and it is the most important line in this section

Puka Nacua is the consensus **WR1.7** and the candidate cuts him by **15 points**. Charter rule 3
says explain a surprising number before acting on it, and charter rule 4 says prove a broader lever
does not already explain a gain. The decisive control is to project the CANDIDATE with the two new
columns forced NULL: whatever survives that is **not** the consensus.

| player | served | candidate | candidate, `ecr_wk_*` forced NULL |
|---|---|---|---|
| Puka Nacua | 27.43 | 12.32 | **12.12** |
| Davante Adams | 15.84 | 7.40 | **7.06** |
| Mike Evans | 18.29 | 9.92 | **9.70** |
| Deebo Samuel Sr. | 18.56 | 12.13 | **11.79** |
| Jaxon Smith-Njigba | 16.57 | 16.16 | 15.90 |
| **Lamar Jackson** | 18.08 | **21.06** | **16.04** |
| Derrick Henry | 24.08 | 21.47 | 21.21 |
| Trey McBride | 14.34 | 13.43 | 12.72 |
| Jared Goff (no ecr) | 17.34 | 17.18 | 17.18 |

Mean absolute move per row, week 2, the 463 QB/RB/WR/TE rows the model projects:

| pos | n | \|cand - served\| | \|cand(ecr NULL) - served\| | **\|cand - cand(ecr NULL)\| = the COLUMN'S VALUE alone** | rows moving >2 pts: total / by the value |
|---|---|---|---|---|---|
| QB | 59 | 0.543 | 0.350 | **0.474** | 3 / 4 |
| RB | 144 | 0.374 | 0.284 | 0.225 | 3 / 1 |
| WR | 176 | 0.770 | 0.690 | **0.198** | 15 / 1 |
| TE | 84 | 0.383 | 0.435 | 0.178 | 2 / 0 |
| **ALL** | **463** | **0.548** | **0.474** | **0.238** | **23 / 6** |

Two findings, and the owner should weigh both:

1. **THE LEVER IS CONNECTED.** Lamar Jackson moves **+5.02** on the column's value alone (16.04 ->
   21.06) and the QB column carries most of its own movement (0.474 of 0.543). That is the positive
   control passing on live 2026 rows, and it matches M2a's per-position result (QB was the largest
   CRPS gain, +0.0506). Jared Goff, whose column is NULL, moves 0.00 between candidate and
   candidate-with-column-blanked -- the negative half of the same control.

2. **BUT MOST OF THE WEEK-2 MOVEMENT IS NOT THE CONSENSUS.** At WR the column's own value accounts
   for 0.198 of a 0.770 mean move; Nacua's -15.11 survives blanking the column almost entirely
   (12.32 vs 12.12). Adding two mostly-NULL columns to a boosted design re-splits every tree and --
   because the new `ecr` mask group at `MASK_DROP_P = 0.97` changes the missingness augmentation --
   changes behaviour most where the vector is most imputed. **2026 rows are exactly that regime**
   (`prior_snap_share`, `prior_route_share` and the usage block are all NULL), which is the D19
   fragility by name. So the live serve moves for a reason the +0.0413 CRPS measurement does not
   cover.

   This is **not** in contradiction with M2a's negative control (+0.00015 CRPS, 3/5, on the eight
   seasons where both arms see the identical NULL). That control says the perturbation is a WASH on
   measured accuracy; it does not say the perturbation is small per player. Both are true: the moves
   are individually large, they cancel on average, and M2a measured the average.

   **Whether the direction is an improvement is a separate question this screen cannot settle, and
   the honest note is that it looks like one.** Nacua's served 27.43 is 2.3x his own season line
   (12.05) on a 9.9-point week 1; Adams' served 15.84 is 2.15x a 7.37 line off a 4.1-point week.
   The candidate pulls all three back to roughly 1.0x. A weekly model projecting a WR at 27 points
   off a 12-point line is the number that needs defending, not the one that replaces it -- but
   "looks more sensible" is not a measurement, and the frozen week-2 record in section 15 is what
   will settle it.

### 14.3 The lineup and the streaming picks

```
LINEUP BEFORE (served)                      LINEUP AFTER (candidate)
  QB    Jared Goff           17.34            QB    Jared Goff           17.18
  RB    Breece Hall          14.54            RB    Breece Hall          14.67
  WR    Amon-Ra St. Brown    16.56            WR    Amon-Ra St. Brown    16.14
  TE    Colston Loveland     11.14            TE    Isaiah Likely        10.94
  FLEX  Isaiah Likely        10.18            FLEX  Colston Loveland      9.84
  FLEX  Jameson Williams     10.10            FLEX  Jameson Williams      9.72
  DST   MIN D/ST              5.07            DST   MIN D/ST              5.07
  K     Cairo Santos          6.82            K     Cairo Santos          6.82
  total                      91.75            total                      90.38
  bench: Bo Nix 15.87, Chris Godwin Jr. 7.33, bench: Bo Nix 16.02, Chris Godwin Jr. 7.59,
         Marvin Harrison Jr. 5.87,                   Marvin Harrison Jr. 6.83,
         Michael Pittman Jr. 3.95                    Michael Pittman Jr. 5.31
```

**THE STARTING ELEVEN IS IDENTICAL.** The only change is that Likely and Loveland swap the TE and
FLEX slots, which is not a decision -- the same eight men start either way. That is the honest
headline for this week: the candidate's projections move materially and its lineup does not.

Streaming picks (the men outside `POOL_DEPTH`), before -> after:

| pos | before | after | |
|---|---|---|---|
| QB | C.J. Stroud 15.81 | C.J. Stroud 16.31 | SAME PICK |
| RB | George Holani 4.70 | George Holani 5.70 | SAME PICK |
| WR | Devaughn Vele 7.37 | Devaughn Vele 7.78 | SAME PICK |
| TE | Noah Fant 6.14 | Noah Fant 6.79 | SAME PICK |

All four picks are unchanged. (K and DST are not compared: they are served by
`weekly-artifact-lineonly.json` and `dst-stream-artifact.json` and the candidate does not touch them.)

### 14.4 The M2a numbers, restated

Unchanged and not re-run -- they are the admission evidence and they are in sections 5.2-5.5 above:

| | |
|---|---|
| decision block, 2020-2024 (the seasons the column exists in) | **+0.04134 pooled CRPS, floor 0.01650, 95% CI [0.03184, 0.05083], 5/0 seasons -- ADMIT** |
| 2012-2019 negative control (column NULL in both arms) | +0.00015, 3/5 -- a clean null |
| gate clause (a) | PASS, 2.7483 vs the shipped `week()` 3.4182 |
| gate clause (b) | PASS, coverage 0.841, every position inside |
| gate clause (c) | PASS, zero share 0.242 vs 0.246 |
| lineup regret, standard-15 | 85.54 -> 85.73 captured (+0.19), winShare 0.717 -> 0.724 |
| lineup regret, deep-18 | 90.46 -> 90.70 captured (+0.24), winShare 0.732 -> 0.739 |
| per position (pooled, diluted by 9 uncovered seasons) | QB +0.0506, RB +0.0169, WR +0.0160, TE +0.0072, K 0.0000, DST 0.0000 |

### 14.5 Yahoo 129048 -- NOT RUN, and what blocks it, measured

The column is format-independent (it is a rank, not a point total) and the builder IS format-aware:
`scripts/build-format-features.mjs --weekly-only` runs the same `buildForwardInto`, and the additive
migration would add the two columns to that store. Three things block it anyway, and the second is a
real gap in the retention rather than a scheduling problem:

1. `data/formats/sc-a845f67652fb/features.db` **has no `ecr_wk_rank`/`ecr_wk_sd` columns** today, so a
   Yahoo comparison needs a `--weekly-only` rebuild of a 970 MB store plus a Yahoo candidate train.
2. **THE FORMAT STORE CARRIES ITS OWN COPY OF `ranking_history`, and the retention does not reach
   it.** That store holds **67,991** `wp` rows -- the pre-M2b archive, frozen at 2024 -- because
   `features.db` is a `copyFileSync` of `data/ff.db` taken on the last FULL build, and `--weekly-only`
   deliberately skips that copy. So a Yahoo rebuild today would write an **all-NULL 2026 column**:
   the same dead-at-serve state M2a diagnosed, one store further out. **The follow-up is to make the
   retention fan out to every format store (or to make `--weekly-only` refresh `ranking_history` from
   the root), and it should land before any Yahoo screen.**
3. That store had an open `-wal`/`-shm` while this ran (the app and a concurrent session), so writing
   it was outside this task's safe surface in any case.

---

## 15. The forward record, frozen

A new write-once scorecard kind, `weekly_ecr_candidate` (model `ecr_candidate`), snapshotted on the
**same players, the same week and the same frozen `as_of`** as the shipped `weekly` and
`weekly_challenger` rows.

**Why freeze a model nobody serves.** The admission evidence is a backtest, which is the arrangement
the scorecard exists to distrust. A prediction can only be written before a kickoff that has not
happened, and **today was the last legal day for week 2**. Waiting for the sign-off would have cost a
week of out-of-sample evidence permanently. If the answer is no, the series records a model that was
rejected, which costs nothing; if it is yes, the promoted model arrives with evidence that predates
its own promotion.

```
  ecr cand:    week 2: 530 rows from weekly-artifact.candidate-ecr.json
               (kind weekly_ecr_candidate, model ecr_candidate) -- NOT SERVED
```

Verified:

| control | result |
|---|---|
| rows exist with the format key | 530 rows, `format_key sc-f6143a8dfb13`, season 2026 week 2, `as_of 2026-09-16` |
| each row carries the artifact stamp | `{"artifact":"weekly-artifact.candidate-ecr.json","path":"data\\weekly-artifact.candidate-ecr.json","fittedAt":"2026-09-16","features":27,"served":false}` |
| **re-freezing refuses** | second run: `ecr cand: week 2: 0 rows` + note *"week 2's ECR-candidate snapshot was already taken -- written once"* |
| the values are the candidate's | Goff 17.18 (p10 6.77, p90 29.31), Lamar Jackson 21.06, Puka Nacua 12.32 -- byte-identical to section 14 |
| `ff scorecard` will score it | the kind is in `SCORECARD_KINDS`, so the scoring loop picks it up the moment week 2 settles; it gets the `weekly` kind's rows as lineup-regret companions, on exactly the terms `weekly_challenger` does |

The artifact is **optional on disk**: absent, the kind is skipped and says so. It must never fall
back to the shipped artifact, which would record the incumbent's numbers under the candidate's name
and make the two look identical forever -- the same refusal the challenger block already makes.

---

## 16. PROMOTE / ROLL BACK -- the exact commands

**PROMOTE** (two commands, in this order). The first is the model; the second is the cadence without
which the column goes stale and the model quietly serves last week's opinion.

```powershell
# 1. the model. `weekly-artifact.json` is CHALLENGER_WEEKLY_ARTIFACT, which serves QB/RB/WR/TE;
#    K and DST are served by other files and are not touched.
Copy-Item data\weekly-artifact.json data\weekly-artifact.pre-d27-2026-09-16.json
Copy-Item data\weekly-artifact.candidate-ecr.json data\weekly-artifact.json -Force
node --import tsx scripts\weekly-artifact-probe.mjs data\weekly-artifact.json   # must print 27 features + 6 golden rows

# 2. the cadence. WITHOUT THIS the retention only runs when someone types a command: the STORED
#    scheduler row overrides DEFAULT_ROUTINES entirely, so the new routine exists and never fires.
npm run ff -- schedule --routines rankings,actuals,scorecard,decisions --every 15 --enable
npm run ff -- schedule          # read it back: `routines:` must list rankings FIRST, and [x] beside it
```

Step 2 is independent of step 1 and **is worth running even if the model is rejected** -- the archive
is the thing that cannot be backfilled, and every week it is not accruing is a week permanently
missing from any future screen.

Nothing else changes: `WEEKLY_SERVE` already names `weekly-artifact.json` at QB/RB/WR/TE, so the
promotion is a file swap and no code edit. `WEEKLY_SERVE_SWITCHED_ON` should be bumped to the
promotion date in the same commit so the scorecard's metadata records the change; the mapping itself
is unchanged.

**Consider also, at promotion time**, that the frozen `weekly_ecr_candidate` series becomes a
duplicate of the served `weekly` series from the next week on. Leave it running: an unbroken series is
what makes the two comparable, exactly as the challenger's whole-field rule states.

**ROLL BACK** (one command):

```powershell
Copy-Item data\weekly-artifact.pre-d27-2026-09-16.json data\weekly-artifact.json -Force
node --import tsx scripts\weekly-artifact-probe.mjs data\weekly-artifact.json   # must print 25 features
```

The md5 of the pre-promotion file is `a3871f4c489164abbda8e29734b16f53`; `md5sum` it after a rollback
and it must match. The retention, the live column, the routine and the frozen scorecard kind are
independent of the model swap and are **not** rolled back by this -- they are strictly additive and
correct whether or not the candidate ships.

**TO UNDO THE STORE WRITES ENTIRELY** (retention rows, the live column, the frozen kind):
`data\ff.db.bak-prem2b-2026-09-16` is an online backup taken before any of them, `integrity_check ok`.

---

## 17. Gates

| gate | result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **1003 tests, 1000 pass, 2 skipped, 1 failure -- and the failure is NOT this work's** (see below) |
| `npx eslint .` | 0 errors, **46 warnings** -- the same 46 as M2a; none in any file touched here (9 warnings appear in `src/data/advanced.ts` and `src/data/ingest.ts`, all at line numbers preceding this work's edits) |
| served weekly artifacts byte-identical | yes -- all four md5s unchanged (table at the top of this section) |
| championship backtest | **39.5% championships / 96% playoffs**, unchanged; the per-season line reproduces `docs/architecture-review-2026-09-16.md:720` byte-for-byte |

```
npm run ff -- backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150
  consensus-blend [QB=0.5]: re-rank the board toward FFToday (6997 player-seasons)
FORMAT  weeks 1-13, 7-team playoff, seeding division-winners-first, bracket reseeds  (from the espn format block)
BACKTEST age-curve opportunity FULL-SYSTEM(real lineup)+inflation no-lookahead(prev-yr proj)  16-team $200 HALF 7-team-playoff | reserve=4 maxShare=0.25  market 0.3  book vor
  CHAMPIONSHIPS: 39.5%  (random 6.3%)  |  playoffs: 96%
  ROOKIES: added 1451 draft-capital-priced rookies across 25 seasons (~58/yr) to the pool
  per season: 2000:28%  2001:31%  2002:44%  2003:47%  2004:32%  2005:29%  2006:49%  2007:19%  2008:47%  2009:55%  2010:44%  2011:62%  2012:47%  2013:41%  2014:29%  2015:38%  2016:29%  2017:33%  2018:41%  2019:36%  2020:43%  2021:35%  2022:54%  2023:33%  2024:40%
```

That it is unchanged is the expected result and is a control in its own right: nothing in this work
touches the draft path, and a moved number would have meant a store write reached somewhere it should
not have.

### 17.1 The one test failure, attributed rather than waved through

```
test/picks.test.ts
  every season's pick count and total spend match docs/league-tendencies.md within 1%
  AssertionError: 2025: 372 picks against the recorded 192
```

**It is the concurrent M2e session's Yahoo draft ingest, not M2b.** The store now holds
`fact_draft_pick` rows for two leagues in 2025 -- `462233` (ESPN) **192** and `129048` (Yahoo)
**180** -- and 192 + 180 = 372 exactly. The assertion aggregates across leagues and does not filter
by `league_id`, so it reads two leagues' drafts as one league's. M2b's store writes are
`ranking_history` (appends), `weekly_rank` (as the ingest already did), two columns of
`feat_player_week_model` for 2026, and the new `scorecard_prediction` kind -- none of them within
reach of a draft-pick table. **The fix belongs to whoever owns that ingest** (add `league_id` to the
test's query, or to the recorded table); it is named here rather than left as an unexplained red.

**Two failures earlier in this session WERE this work's, and both were real defects rather than test
friction** -- they are the reason section 11.2 has a positive control:

- `test/routines.test.ts` -- "every registry routine names verbs that the tick's handler map can
  run": the `rankings` routine named `ingest-raw weekly`, which `cmdIngestRaw` refuses (`weekly` is
  an L1 asset, not a RAW one), and the tick SKIPS an unmapped verb silently. Fixed by naming
  `ingest-source` and registering it in `HANDLERS`.
- `test/wp13-wiring.test.ts` -- "every routine is leagueScoped now": `rankings` is deliberately NOT
  league-scoped (a league-independent feed, one copy per store), so the assertion now carries a
  named `NOT_LEAGUE_SHAPED` carve-out rather than a silently widened rule.

Changed here: `src/data/ecrHistory.ts` (`appendWeeklyRankSnapshot`), `src/data/advanced.ts`
(`ingestWeekly` returns a result object and appends), `src/data/ingest.ts` (two call sites + the
retention line in the log), `src/inseason/routines.ts` (the `rankings` routine, first in the
registry, and `DEFAULT_ROUTINES`), `src/weekly/scorecard.ts` (the `weekly_ecr_candidate` kind),
`scripts/ecr-week-leak-guard.mjs` (the era bound derived rather than enumerated; a per-season line),
new `test/weekly-ecr-retention.test.ts` (5 tests), `src/ff.ts` (`ingest-source` in the tick's
HANDLERS map), `test/routines.test.ts` + `test/wp13-wiring.test.ts` (the two assertions the new
routine legitimately changes), this document, `docs/decisions.md` (D27, PENDING) and one status line
in `docs/architecture-review-2026-09-16.md`.

**Not done, and why:** (1) the stored `settings.scheduler` row is NOT written -- it is an
outward-facing change to a running app and belongs to the sign-off (section 16, step 2); (2) Yahoo
129048 is NOT measured -- the per-format store's own `ranking_history` is stale and `--weekly-only`
does not refresh it (section 14.5); (3) the DST name-key crosswalk is still not built (section 11,
and it could not move a number here); (4) `scripts/inseason-backtest-lineup.mjs` still has no
`--artifact` flag, so the manager-level backtest of the candidate remains unrunnable, exactly as
section 6 recorded for M2a.
