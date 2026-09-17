# M2h -- the SERVE-TIME MISSINGNESS ablation of the weekly model (2026-09-16)

**STATUS: findings only. Nothing shipped, no default moved, no served artifact touched.**
`data/weekly-artifact.json` md5 `a3871f4c489164abbda8e29734b16f53` and
`data/weekly-artifact-lineonly.json` md5 `d2982b1c809838356bd450b8e0e3ae3f`, before and after.

---

## 1. The question, and why it is not the training ablation

M2f asked what a feature CONTRIBUTES: remove it from training, refit, and see what the model loses.
That measures INFORMATION. It is not the risk the live season runs.

The live risk is that a feed the model was **fitted on** fails on a Sunday. The model is unchanged;
it simply has a hole where a column should be. That has already happened, more than once:

* the FantasyPros weekly consensus is scraped on a **Friday**, so a **Thursday** game's
  kickoff-minus-two anchor precedes the scrape and the column is structurally NULL for those teams
  (M2b measured it live: 19 BUF/DET rows in week 2 of 2026);
* the injury feed stopped publishing report DATES once already, which is the whole reason `inj_feed`
  exists as a column and the reason D19 added missingness augmentation;
* and, measured here for the first time, **seven of the twenty-five served columns are 100% absent
  for the live week-2 2026 serve** (section 3).

So the instrument masks at SERVE only. `EvalOpts.maskServe` (`applyServeMask`, src/weekly/evaluate.ts)
nulls the named fields on the **scored** rows of every fold; the folds' training is untouched. The
projector then turns a null into the artifact's own declared `missing` for the linear heads and into
**NaN** for the boosted design (`weeklyFeatureValueBoosted`) -- byte for byte what the serving path
sees when the feed is dark, and exactly the mask-group absent state the trees were augmented for.
That is fit-with / serve-without: the Sunday.

## 2. What was run, and the one correction it needed

```
node --import tsx scripts/weekly-missingness-ablation.mjs \
  --folds <dir> --out <dir> --tag incumbent          # the served artifact, 25 features
node --import tsx scripts/weekly-missingness-ablation.mjs \
  --artifact data/weekly-artifact.candidate-ecr.json --folds <dir2> --out <dir> --tag ecr \
  --only ecr_wk_rank,ecr_wk_sd,family:ecr,family:avail,season_line_pg
```

Canonical nested evaluation: 14 held-out seasons 2012-2025, train window 2010-2025, 300 rosters,
two-part boosted folds, the decision population. One fold set is trained ONCE and every arm after
that is scoring-only (`reuseArtifacts`), so ~35 arms cost one training run.

**The correction, and it is a finding in its own right.** `ff evaluate-weekly`'s default is
`--features all`, and `all` is a MOVING SET: it is `RATIO_TO_LINE + CENTER + INDICATOR` in
`tools/train_weekly.py`, which today is **29 columns** -- `rz_share_td`, `prior_vol_cv` and M2a's
`ecr_wk_rank`/`ecr_wk_sd` were declared after `data/weekly-artifact.json` was built, and it carries
**25**. A fold fitted on the superset is not the model that serves, and masking a column the served
model never had would report a cost nobody is exposed to. So this driver pins `--features` to the
**artifact's own feature list**, read off the file rather than retyped. The first fold trained under
the flagless default was discarded once it came out with 29 features.

> Carried to the owner separately: the flagless `ff evaluate-weekly` today trains folds on a
> different feature set from the artifact it scores them against. It is not wrong so much as no
> longer the control it reads as -- and docs/weekly-ecr-screen-2026-09-16.md's claim that "the
> shipped trainer command produces the same 25-feature artifact it did yesterday" is no longer true.

Everything derived rather than retyped, per the enumeration-rot rule: the single-feature arms are the
artifact's own `features`; the family arms are parsed out of `MASKABLE_GROUPS` in
`tools/train_weekly.py`; the three sub-families of `avail` (designations / practice / the feed flag)
are this screen's own decomposition and each member is ASSERTED to be in the parsed `avail` group, so
a rename upstream fails loudly instead of masking nothing.

## 3. What the live serve actually looks like today (the empirical half)

Read from `data/ff.db`, decision population (`in_population = 1`, non-bye), NULL share per column.
`scripts/weekly-availability-coverage.mjs` gives the same picture on the whole table.

**The premise this screen was commissioned on is STALE, and that is the first finding.** D19,
`docs/weekly.md` section 8, the README and `weekly-availability-coverage.mjs`'s own "READING THIS"
block all say the injury feed went dark from 2025 and that the availability block reads NULL for
every 2025+ week. It does not. Over the 2025 decision population `inj_feed` **averages 1.000** and
the designations are at their normal rates (Out 0.041, Questionable 0.039, practice-limited 0.045 --
2024 was 0.030 / 0.047 / 0.054), with 87.5% of rows carrying a value. The dark season is **2026**,
and only for weeks the report has not been filed for yet:

| 2026 week | `inj_feed` mean | rows with `inj_out` | reading |
|---|---|---|---|
| 1 | 1.000 | 263/295 | settled |
| 2 | 1.000 | 263/295 | **the live week -- the block is present** |
| 3-18 | 0.000 | 0/295 | future weeks, nothing filed yet (correct, not a failure) |

**What IS dark at the live serve is a different block entirely.** For week 2 of 2026 -- the week a
lineup is being set from -- seven of the twenty-five served columns are **100% NULL**, and they are
not the ones anyone has been worrying about:

| column | 2025 settled NULL | 2026 wk2 NULL | 2023/2024 wk2 NULL (the normal shape) |
|---|---|---|---|
| `prior_snap_share` | 18.7% | **100%** | ~22% |
| `prior_route_share` | 18.8% | **100%** | ~22% |
| `td_fd`, `td_ts`, `td_attempts`, `td_rush_yards` | 7.1% | **100%** | ~13% |
| `t4_sd` | 14.3% | 100% | 100% (structural: needs two games) |
| `depth_rank` | 12.5% | 11.9% | normal |
| injury / practice block | 12.5% | 10.8% | normal |
| `spread_line` / `total_line` / `implied_team_total` | 0% | 0% (wk 1-3; 100% from wk 4) | normal |
| `ecr_wk_rank` (candidate only) | 100% | 20.0% | n/a |

Only `t4_sd` is structural. The snap/route pair and the four to-date production ratios are a **2026
ingest gap**, not a property of week 2: in 2023, 2024 and 2025 those columns were 78-93% populated at
the same week. Nothing warns about it, because a NULL is a legal serve value under D19.

## 4. Single-column masks -- the served artifact

Fourteen held-out seasons, 2012-2025. `dCRPS` is masked minus unmasked, **paired by season**; `+/- SE`
is the season-level standard error over those 14 paired differences (the unit of analysis is the
season, not the row). `dStd15` / `dDeep18` are the lineup-regret decision metric, points of actual
starter production per drawn roster. Reference arm: CRPS **2.7626**, coverage **0.844**,
std15 **85.627**, deep18 **90.606**.

| column | dCRPS | +/- SE | seasons won | zero-seasons | coverage | dStd15 | dDeep18 |
|---|---|---|---|---|---|---|---|
| `depth_rank` | 0.5376 | 0.0300 | 14/14 | 0 | 0.811 | -0.83 | -1.05 |
| `t4_mean` | 0.2503 | 0.0518 | 14/14 | 0 | 0.858 | -0.72 | -0.99 |
| `season_line_pg` | 0.0921 | 0.0041 | 14/14 | 0 | 0.831 | -0.36 | -0.42 |
| `td_ppg` | 0.0892 | 0.0198 | 14/14 | 0 | 0.852 | -0.99 | -0.97 |
| `prior_snap_share` | 0.0373 | 0.0039 | 13/14 | 1 | 0.848 | -0.71 | -0.95 |
| `inj_out` | 0.0312 | 0.0033 | 14/14 | 0 | 0.843 | -0.39 | -0.38 |
| `td_games` | 0.0245 | 0.0021 | 14/14 | 0 | 0.848 | -0.19 | -0.19 |
| `week_no` | 0.0197 | 0.0026 | 14/14 | 0 | 0.846 | -0.16 | -0.22 |
| `implied_team_total` | 0.0148 | 0.0012 | 14/14 | 0 | 0.846 | -0.14 | -0.19 |
| `prac_dnp` | 0.0125 | 0.0013 | 14/14 | 0 | 0.842 | -0.13 | -0.15 |
| `inj_questionable` | 0.0121 | 0.0009 | 14/14 | 0 | 0.846 | -0.17 | -0.21 |
| `teammates_out` | 0.0119 | 0.0011 | 14/14 | 0 | 0.845 | -0.06 | -0.07 |
| `inj_doubtful` | 0.0095 | 0.0013 | 14/14 | 0 | 0.844 | -0.14 | -0.16 |
| `prac_limited` | 0.0074 | 0.0008 | 14/14 | 0 | 0.843 | -0.07 | -0.12 |
| `t4_sd` | 0.0073 | 0.0050 | 11/14 | 0 | 0.844 | 0.00 | -0.02 |
| `days_rest` | 0.0066 | 0.0012 | 13/14 | 0 | 0.840 | -0.12 | -0.13 |
| `spread_line` | 0.0058 | 0.0011 | 12/14 | 0 | 0.845 | 0.02 | 0.04 |
| `td_ts` | 0.0045 | 0.0012 | 13/14 | 0 | 0.848 | -0.05 | -0.06 |
| `prior_route_share` | 0.0028 | 0.0008 | 9/14 | **4** | 0.845 | -0.05 | -0.05 |
| `total_line` | 0.0027 | 0.0007 | 11/14 | 0 | 0.844 | 0.04 | 0.03 |
| `td_rush_yards` | 0.0016 | 0.0006 | 12/14 | 0 | 0.845 | -0.00 | -0.01 |
| `td_fd` | 0.0012 | 0.0008 | 10/14 | 0 | 0.848 | -0.05 | -0.02 |
| `home` | 0.0006 | 0.0002 | 12/14 | 0 | 0.845 | 0.00 | -0.00 |
| `inj_feed` | **0.0000** | 0.0000 | 0/14 | **14** | 0.844 | 0.00 | 0.00 |
| `td_attempts` | -0.0005 | 0.0005 | 5/14 | 0 | 0.844 | 0.01 | 0.00 |

**`depth_rank` is the most expensive column in the model by a factor of two, and it is not one anyone
has screened.** +0.5376 CRPS, every one of 14 seasons, and it is the only single mask that moves
**coverage** materially (0.844 -> 0.811, away from the nominal 0.80 on the wrong side). Its per-season
deltas are flat (0.226 in 2012, then 0.46-0.68 in every season after), so it is not one season
carrying it. A depth-chart rank is the model's cleanest statement of ROLE -- who is the starter --
and the zero stage leans on it accordingly.

## 5. Family masks -- and the finding that reverses the intuition

| arm | members | dCRPS | +/- SE | won | coverage | dStd15 | dDeep18 |
|---|---|---|---|---|---|---|---|
| `family:__all__` (control) | 25 | 0.6137 | 0.0134 | 14/14 | 0.858 | **-8.75** | **-10.12** |
| `family:usage` (snap, route, depth) | 3 | 0.3746 | 0.0176 | 14/14 | 0.844 | -1.74 | -2.20 |
| `family:avail` (D19 availability block) | 7 | 0.1443 | 0.0042 | 14/14 | 0.835 | -1.82 | -2.17 |
| `extra:live2026` (today's dark set) | 7 | 0.0647 | 0.0062 | 14/14 | 0.856 | -0.71 | -0.91 |
| `family:form` | 7 | 0.0539 | 0.0056 | 14/14 | 0.855 | -0.91 | -1.41 |
| `family:injury_designations` | 3 | 0.0456 | 0.0024 | 14/14 | 0.846 | -0.58 | -0.62 |
| `extra:usage_pair` (snap + route) | 2 | 0.0451 | 0.0043 | 13/14 | 0.848 | -0.64 | -0.83 |
| `family:odds` (Vegas) | 3 | 0.0282 | 0.0020 | 14/14 | 0.846 | -0.10 | -0.14 |
| `family:practice_status` | 2 | 0.0188 | 0.0014 | 14/14 | 0.842 | -0.20 | -0.26 |
| `family:teammates_out` | 1 | 0.0119 | 0.0011 | 14/14 | 0.845 | -0.06 | -0.07 |
| `extra:todate4` (the four to-date ratios) | 4 | 0.0083 | 0.0018 | 13/14 | 0.852 | -0.08 | -0.08 |
| `family:injury_feed_flag` | 1 | 0.0000 | 0.0000 | 0/14 | 0.844 | 0.00 | 0.00 |

**A PARTIAL feed failure is more expensive than a TOTAL one, in two of the four mask groups.**

* `usage`: all three columns dark costs **+0.375**. `depth_rank` **alone** dark costs **+0.538** --
  43% more, for strictly less missing data.
* `form`: all seven dark costs **+0.054**. `t4_mean` **alone** dark costs **+0.250** -- nearly five
  times more. `td_ppg` alone is +0.089, also above the whole block.
* `avail` goes the other way and is superadditive: the block is +0.144 against +0.085 for the sum of
  its seven members.

That is exactly what D19's missingness augmentation buys and exactly where it stops. The trees were
trained on rows where a whole `MASKABLE_GROUPS` block is NaN **together** (`MASK_DROP_P` 0.97 / 0.6 /
0.5 / 0.4), so "the usage block is gone" is a regime they know and fall back on the anchor for. "The
depth chart is gone but snap share and route share are both present" is a combination that appears in
training only through natural missingness, and the row routes somewhere the augmentation never
covered. The augmentation is per-GROUP; real feeds fail per-COLUMN.

**`inj_feed` is a measured NULL, not a dead lever.** Masking it is exactly 0.0000 in all 14 seasons.
It carries a non-zero linear zero-stage coefficient at every fitted position (-0.41 QB to -0.77 RB)
and it IS in every boosted position's feature list -- but it is **constant at 1 across every fitted
row** (the feed published in all 14 training seasons), so no tree can have split on it, and the
boosted heads override the linear ones at QB/RB/WR/TE. The column's job is to mark a dark week, and
the model has never seen one. The positive control that this is the feature and not the instrument:
the same mask applied to `family:avail`, which CONTAINS `inj_feed`, moves +0.1443.

## 6. The empirically weighted ranking -- what to harden first

The table above is the cost if a feed fails on every row. What matters is that cost **times the share
of rows that still carry the column**, since a row that is already NULL cannot lose anything. Two
buckets fall out, and they want different actions.

**(a) ALREADY BEING PAID, every week of 2026.** `extra:live2026` masks exactly the seven columns
measured dark at the live week-2 serve: **+0.0647 CRPS +/- 0.0062, 14/14 seasons, -0.71 points per
standard-15 lineup and -0.91 per deep-18 lineup, every week.** That is not a risk, it is a live
regression, and it is the largest actionable number in this screen. The dominant member is the
snap/route pair (`extra:usage_pair` +0.045, -0.64 pts); the four to-date production ratios together
are +0.008 and effectively free.

**(b) AT RISK -- expected cost if the feed failed next Sunday**, i.e. `dCRPS` scaled by the column's
presence at the live week (historical presence is ~88% for the same columns, so the scaling is ~1 for
everything still alive):

| rank | feed | live presence (2026 wk2) | expected dCRPS if it fails | expected dStd15 |
|---|---|---|---|---|
| 1 | **`depth_rank`** (depth chart) | 88.1% | **0.54** | -0.83 |
| 2 | **`t4_mean`** (trailing-4 mean) | 88.5% | **0.25** | -0.72 |
| 3 | `season_line_pg` (the level column) | 100% | 0.09 | -0.36 |
| 4 | `td_ppg` (to-date per game) | 88.5% | 0.09 | -0.99 |
| 5 | injury designations (3 cols) | 89.2% | 0.05 | -0.58 |
| 6 | Vegas lines (3 cols) | 100% wk 1-3, **0% from wk 4** | 0.03 | -0.10 |
| 7 | practice status (2 cols) | 89.2% | 0.02 | -0.20 |
| 8 | `teammates_out` | 89.2% | 0.01 | -0.06 |
| 9 | `inj_feed` | 89.2% | 0.00 | 0.00 |
| -- | snap / route / to-date ratios | **0%** | 0 (already paid -- bucket (a)) | -- |

**The reading, plainly.**

1. **Fix the 2026 snap-count and play-by-play ingest.** It is worth -0.71 points per lineup per week
   right now, it is the only item in the screen costing points today, and it needs no model change --
   the columns exist and were 78-93% populated at the same week of 2023, 2024 and 2025.
2. **Harden `depth_rank` above everything else.** It is the model's role signal, the most expensive
   column by 2x, the only one that visibly damages calibration when it goes, and -- by section 5 --
   losing it ALONE is worse than losing the whole usage block. A depth-chart outage is the single
   worst Sunday this model can have.
3. **`t4_mean`, `td_ppg` and `season_line_pg` are derived, not fetched**, so hardening them means
   guarding the derivation (a broken `raw_nfl_game` join, a name-key miss), not a vendor.
4. **The injury block is worth roughly a seventeenth of `depth_rank`** (+0.046 for all three
   designations, -0.58 pts/lineup). Worth keeping; not where the leverage is. That lines up with the
   prior measurement the brief quoted (practice status 0.021 log-loss vs 0.002 for injury type):
   practice status is cheaper still, +0.019.
5. **Consider per-COLUMN dropout in the training augmentation**, not just per-group. Section 5's
   reversal is a training-regime gap and the only finding here that a model change would fix. It is
   NOT proposed as a ship; it is the next thing worth measuring.
6. **The Vegas lines vanish from week 4 onward** in the forward table (0/295 rows carry a spread).
   Cheap to lose (+0.028), but the ROS and future-week projections run on it.

## 7. The candidate artifact -- what the D27 consensus costs when the Friday scrape is late

`data/weekly-artifact.candidate-ecr.json` (27 features), its own fold set, same 14 seasons.
Reference arm: CRPS **2.7469**, coverage 0.845, std15 **85.757**, deep18 **90.683** -- the candidate
is better than the incumbent's 2.7626 with nothing masked, which is M2a's admission.

| arm | dCRPS (14 seasons) | dCRPS (6 COVERED seasons) | +/- SE | won | dStd15 | dDeep18 |
|---|---|---|---|---|---|---|
| `family:ecr` (both columns) | 0.0155 | **0.0362** | 0.0077 | 6/6 | -0.08 | -0.03 |
| `ecr_wk_rank` | 0.0116 | 0.0270 | 0.0057 | 6/6 | -0.08 | -0.08 |
| `ecr_wk_sd` | 0.0019 | 0.0045 | 0.0014 | 6/6 | -0.00 | 0.04 |
| `season_line_pg` (control) | 0.0944 | -- | 0.0036 | 14/14 | -0.40 | -0.44 |
| `family:avail` (control) | 0.1487 | -- | 0.0046 | 14/14 | -1.83 | -2.16 |

Per season, `family:ecr`: 2019 +0.0035, 2020 +0.0394, 2021 +0.0329, 2022 +0.0337, 2023 +0.0491,
2024 +0.0589 -- and **exactly 0.0000 in the other eight seasons**, which is the archive's own era
bound (2012-2018 and 2025 carry no `wp` scrape at all). That is the cleanest control in the screen:
a column already 100% missing in a season cannot cost anything in that season, and it does not.

**The reading for the owner.** M2a measured the feature's GAIN at +0.0413 CRPS on the covered seasons.
Masking it at serve costs **+0.0362 on the same kind of season** -- so a week with no consensus gives
back essentially the whole gain and **nothing more**: no collapse, no calibration damage (coverage
0.845 -> 0.848), and the lineup moves 0.08 of a point. The D19 mask group (`ecr` at 0.97) is doing its
job. The real-world exposure is smaller again, because only the THURSDAY teams lose the column on a
late scrape -- 19 of 295 decision rows in the live week (6.4%), which prorates to about **+0.002
CRPS**. **Admitting the consensus does not create a serve-time fragility worth blocking on.**

## 8. Controls

Every one was an ARM, not a sentence, because a mask that does nothing reads exactly like a feed that
costs nothing.

| control | expected | measured | verdict |
|---|---|---|---|
| mask EVERYTHING -> the model collapses onto its anchor | devastating | +0.6137 CRPS, **-8.75 / -10.12 points per lineup**, 14/14 | HELD |
| mask `home` -> ~0 | ~0 | +0.0006, dStd15 +0.00 | HELD |
| mask `week_no` -> ~0 | ~0 | +0.0197, 14/14 -- small but SYSTEMATIC | **partially held**, see below |
| a column already 100% missing in a season -> exactly 0 that season | 0.000000 | `prior_route_share` 2012-2015; `prior_snap_share` 2012; `ecr_*` in 8 of 14 seasons | HELD |
| masking the level column moves a lot | large | +0.0921, 14/14, and the worst coverage of any single mask (0.831) | HELD, with the caveat below |
| the instrument is connected at all | non-zero | 35 of 37 arms move; the two that do not are `inj_feed` and the family that contains only it | HELD |
| the default path is off | byte-identical | see below | HELD |

**`week_no` is not zero and is not reported as one.** +0.0197 with an SE of 0.0026 and 14/14 seasons
is small against `depth_rank`'s 0.54 but it is a real, consistent effect -- the model does use where
in the season a week sits. `home` is the arm that is genuinely ~0. The pre-registered expectation was
wrong about `week_no`, and the arm says so.

**The level control needs its caveat stated, because the naive reading of it is wrong.** The weekly
model's ANCHOR is not the `season_line_pg` FEATURE -- it is the multiplicative season line the target
is a ratio to (`projectWeekly` multiplies by `row.season_line_pg`, and a row without one produces no
projection at all). That anchor cannot be masked; a row that loses it is dropped, not degraded. So the
`season_line_pg` arm masks only the level COVARIATE sitting on top of the ratio, and +0.0921 is the
right size for that. The "devastate" control for the anchor proper is `family:__all__`, which leaves
the model with nothing but its intercept times the line: **-8.75 points per lineup**, an order of
magnitude beyond any other arm.

**The default path is unchanged, and the proof is structural rather than statistical.** No new option
was added: `EvalOpts.maskServe` and `ff evaluate-weekly --mask-serve` already existed (D19 built them
for exactly this purpose). The only edit to `src/weekly/evaluate.ts` lifts the three-line inline mask
loop into a named, exported `applyServeMask(rows, fields?)` with identical semantics and calls it at
the same point -- so the flagless path is byte-identical by construction, not by re-measurement.
`ff evaluate-weekly --resolve-only` prints what it printed before. `test/weekly-missingness.test.ts`
pins both halves: an absent or empty mask leaves the rows byte-identical by JSON AND produces
identical projections from the shipped artifact, and the fault injection shows the mask moving the
level a lot, `week_no` little, and everything-masked most.

## 9. Reproducing

```
node --import tsx scripts/weekly-missingness-ablation.mjs --folds <dir> --out <dir> --tag incumbent
node --import tsx scripts/weekly-missingness-ablation.mjs --folds <dir> --out <dir> --tag incumbent --report
node --import tsx scripts/weekly-missingness-ablation.mjs --artifact data/weekly-artifact.candidate-ecr.json \
  --folds <dir2> --out <dir> --tag ecr --only ecr_wk_rank,ecr_wk_sd,family:ecr,family:avail,season_line_pg
```

The fold set is trained once per artifact (14 boosted two-part folds; ~4 hours on a machine shared
with another executor's fan-out); every arm after that is scoring-only at ~30 seconds. Arms append to
`arms-<tag>.jsonl` and a rerun RESUMES rather than repeating. Read-only on `data/ff.db` throughout; no
artifact, default or served path was written.
