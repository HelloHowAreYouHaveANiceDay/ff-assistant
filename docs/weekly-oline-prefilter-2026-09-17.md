# Offensive-line injury as a WEEKLY feature -- cheap pre-filter (2026-09-17)

**VERDICT: DEAD AT THE PRE-FILTER, and dead for the boring reason -- there is no signal to begin
with, not "the consensus already prices it."** Against the out-of-fold residual of the served
26-feature two-part GBM (`data/weekly-artifact.json`), "offensive linemen Out/Doubtful this week"
carries a season-level mean partial correlation of **+0.0066 +/- 0.0105 pooled** (floor 2.9*SE =
0.0305) and **+0.0063 +/- 0.0142 in the RB slice** (floor 0.0413). Neither clears. The decisive
detail is that the **RAW** correlation with the residual -- before anything at all is partialled
out -- is already **+0.0071 pooled and +0.0009 for RB**: partialling on the level/anchor block and
on the weekly consensus pair moves it essentially not at all. So this is not a redundancy finding
about `ecr_wk_rank`; the column simply does not correlate with what the weekly model gets wrong.
In points, a skill player on a team with **two or more** linemen out beats a player on a fully
healthy line by **+0.12 +/- 0.15 points** pooled and **-0.11 +/- 0.15** for RBs -- i.e. zero, with
the RB sign pointing the wrong way for the published prior. Two starter-restricted and
questionable-status variants are equally null. **Both controls passed**: an injected synthetic
feature with a true correlation of 0.05 was detected at +0.055 +/- 0.007 (CLEARS, every slice), and
a shuffled `ol_out` read +0.005 +/- 0.004 (null). The feature is also demonstrably *connected*, not
dead: `ol_out` has a within-team lag-1 autocorrelation of +0.41 against +0.01 for the shuffled twin,
and its worst weeks are nameable (2023 NYG wk5-6, 2017 WAS wk9, 2025 MIN wk5). **A full paired-floor
screen is not worth running on this candidate as specified.** The one caveat that could change that
is stated at the end.

Reproduce in ~3 minutes:

```
node --import tsx scripts/weekly-oline-prefilter.mjs \
  --artifact-dir data/fold-artifacts-oline --seasons 2012-2025 --out data/residuals-oline.tsv
```

`data/fold-artifacts-oline/` is a directory of the 14 per-season weekly fold artifacts, each blind to
the season it scores, i.e. exactly what `npm run ff -- evaluate-weekly --keep-artifacts <dir>`
writes. The copy used here is the `full` arm of the WP18/m2g2 weekly contribution ledger, verified
by the script itself to fit the served 26-feature list byte-for-byte and to declare
`holdoutSeason === Y` for every Y. The DB is opened READONLY; nothing in this study writes to
`data/ff.db`, to `data/weekly-artifact.json`, or to any served artifact.

## Method

**The residual.** Per season Y in 2012-2025: load the decision population's QB/RB/WR/TE rows
(`feat_player_week_model` where `in_population = 1`, byes dropped, a rostered week not played scored
as a real zero), project them with the fold artifact that was trained WITHOUT Y, and take
`residual = actual - p50`. The script asserts blindness twice (`holdoutSeason === Y`, and Y absent
from `artifact.seasons`) and asserts the fold's feature list equals `data/weekly-artifact.json`'s --
a fold fitting a different design answers a different question.

**The unit of analysis is the SEASON.** Every statistic is computed per season and then reported as
a mean +/- SE across the 14 seasons, with the repo's 2.9*SE effect-size floor. A pooled row-level
correlation over ~55,000 player-weeks would have a standard error near 0.004 and would call this
result significant; it is not, and the season is the honest n.

**The candidates**, per (season, week, nfl_team), joined onto every skill-player row by that row's
team:

| candidate | definition |
|---|---|
| `ol_out` | linemen with `report_status` in {Out, Doubtful} |
| `ol_questionable` | linemen with `report_status` in {Questionable, Probable} |
| `ol_starters_out` | `ol_out` restricted to men who are `depth_rank = 1` on `raw_depth_chart` for that team-week |

**The statistics**, per season, per slice (pooled, QB, RB, WR, TE, and a PASS = QB/WR/TE slice, so
the rushing-vs-passing prior is testable):

- `rho_y` -- corr(candidate, actual points);
- `rho_resid` -- corr(candidate, the out-of-fold residual). Raw, nothing removed;
- `rho|L` -- the same, both sides residualised on the LEVEL/anchor block
  (`season_line_pg`, `td_ppg`, `t4_mean`, `td_games`, `week_no`);
- `rho|L+ECR` -- the same, on the level block PLUS `ecr_wk_rank`, `ecr_wk_sd`;
- `gap` -- mean residual for `ol_out >= 1` and `>= 2` minus mean residual for `ol_out == 0`, in
  fantasy points.

`rho|L` is reported twice: once on the whole season and once restricted to the consensus-covered
rows, so the ECR before/after is a comparison of two numbers on the SAME row set rather than an
artefact of the subsetting.

## Leak guard

Every report row feeding a (season, week, team) count must be dated **strictly before that team's own
kickoff**. The cutoff used is **(this team's `raw_nfl_game.gameday` - 2 days)**, which is
character-for-character the point-in-time rule `src/features/sources/weekContext.ts` already applies
to the SHIPPED `inj_out` / `inj_questionable` / `prac_*` columns -- so the candidate is built on the
same contract as the incumbent availability block, not a looser one. Rows dated after the cutoff are
DROPPED (52-92 OL rows per season, 6-9% of them); the latest surviving filing per
(week, team, player) wins.

**A per-team cutoff is required, and a league-wide one would have produced a false alarm.** The
feed's final filings are dated Friday or Saturday, which is after the Thursday-night game but before
the Sunday slate: a naive "max(report_date) < the week's first gameday" test fails for **212 of 243
league-weeks** in 2012-2024 and reads as a leak when it is not one. The per-team test is the one that
answers the question, and after it no surviving row postdates its own team's kickoff minus two days.

**2025 is DATELESS and is flagged as such.** nflverse stopped publishing `date_modified`, so all
6,068 of the season's rows have `report_date = ''` and `as_of = NULL`. This study takes the position
`weekContext.ts` already documents: in that mode the file holds one row per player-week, the FINAL
pre-game report, which is knowable before kickoff. The coverage table marks 2025 `DATELESS`, and the
verdict does not depend on it -- measured, by rerunning with `--seasons 2012-2024`: pooled `rho|L`
+0.0064 +/- 0.0055 against a floor of 0.0159, raw `rho_resid` +0.0068 +/- 0.0053, still null.

## Data problems found (all reported, none worked around)

1. **The OL position vocabulary is exactly `{T, G, C}`** in `raw_injury` for 2012-2025 -- enumerated,
   not assumed. No `OT`/`OG`/`OL`/`LT`/`RG` variants exist in this feed (the full list is
   CB, DE, DT, FB, K, LB, LS, P, QB, RB, S, T, TE, WR, G, C). The script's pattern accepts the
   variants anyway so a future feed change shows up as an addition rather than a silent drop, and it
   PRINTS both the matched and the unmatched vocabulary on every run.
2. **`report_status` vocabulary**: `Questionable` (19,606), `Out` (13,769), `Probable` (11,044,
   retired by the NFL after 2015), `Doubtful` (2,592), `Note` (6), and NULL for 29,451 rows -- a
   practice-report-only filing with no game-status designation. `Probable` is folded into
   Questionable exactly as the shipped `inj_questionable` does, so one number means one thing across
   the span.
3. **`ol_starters_out` is unavailable for 2025**: the 2025+ `raw_depth_chart` is a different schema
   (one `week = 1` row set keyed by 221 snapshot `as_of_key`s, no week-level chart), so a team-WEEK
   starter join does not exist there. That candidate is scored on 13 seasons, not 14, and the
   coverage table's `starters` column says `NO` for 2025 rather than filling it from the wrong week.
4. **The starter join is name/gsis-based and matches 61.6%** of Out/Doubtful OL rows (1,494 of 2,426,
   2012-2024). The remaining 38% are backups and rotational linemen, which is the expected shape, but
   the join is not perfect and `ol_starters_out` should be read as "starters out, at ~62% recall".
5. **`ecr_wk_rank` exists only from 2019** and covers ~65% of rows in the seasons it covers (0 rows
   2012-2018, 171 in 2019, ~3,000-3,500/season 2020-2024, 0 in 2025 -- the 2025 weekly consensus is
   not in this store). So the `rho|L+ECR` column rests on **five seasons**, not fourteen, and its SE
   is correspondingly wide. This is the one place the study is genuinely underpowered -- and it does
   not matter here, because the RAW correlation is already null.
6. **`ol_out >= 2` is rare**: 2.5-5.9% of team-weeks, 97-262 skill-player rows per season. The
   `>= 2` gap column is therefore noisy by construction and is reported with its n.

## Coverage

100% of scored rows carry a feature value: every team-week that played a game in a league-week where
the feed spoke gets an explicit 0 where no lineman was listed (a silent absence there is a zero, not
a missing value; a league-week where the feed said nothing at all would show as a coverage hole and
none occurred).

| season | rows | cov% | team-wks | ol_out>0 | ol_out>=2 | mean ol_out | starters | dated | OL rows | dropped-late |
|---|---|---|---|---|---|---|---|---|---|---|
| 2012 | 3728 | 100.0 | 512 | 22.7% | 2.7% | 0.26 | yes | dated | 783 | 52 |
| 2013 | 3729 | 100.0 | 512 | 24.4% | 3.3% | 0.28 | yes | dated | 769 | 54 |
| 2014 | 3730 | 100.0 | 512 | 26.8% | 4.7% | 0.32 | yes | dated | 765 | 63 |
| 2015 | 3730 | 100.0 | 512 | 24.2% | 3.9% | 0.29 | yes | dated | 778 | 60 |
| 2016 | 3729 | 100.0 | 512 | 30.5% | 5.9% | 0.37 | yes | dated | 858 | 87 |
| 2017 | 3730 | 100.0 | 512 | 31.6% | 5.9% | 0.38 | yes | dated | 945 | 63 |
| 2018 | 3983 | 100.0 | 512 | 28.3% | 2.5% | 0.31 | yes | dated | 954 | 68 |
| 2019 | 3970 | 100.0 | 512 | 33.4% | 5.5% | 0.40 | yes | dated | 933 | 64 |
| 2020 | 3917 | 100.0 | 512 | 28.5% | 3.9% | 0.33 | yes | dated | 992 | 52 |
| 2021 | 4211 | 100.0 | 544 | 26.5% | 4.0% | 0.31 | yes | dated | 895 | 53 |
| 2022 | 4179 | 100.0 | 542 | 28.6% | 4.6% | 0.33 | yes | dated | 1036 | 76 |
| 2023 | 4152 | 100.0 | 544 | 28.3% | 4.0% | 0.33 | yes | dated | 1039 | 73 |
| 2024 | 4165 | 100.0 | 544 | 29.6% | 4.4% | 0.35 | yes | dated | 1072 | 92 |
| 2025 | 4249 | 100.0 | 544 | 37.9% | 5.9% | 0.45 | **NO** | **DATELESS** | 1034 | 0 |

`mean ol_out` of 0.26-0.45 is the study's real constraint: the injury report names an offensive
lineman Out or Doubtful about a third of a lineman per team-week. The feature has a small dynamic
range no matter how good the underlying football story is.

## Feature face validity -- the column is CONNECTED, not dead

Charter rule 4: a dead column and a real null print the same flat numbers, so the column must be
shown capable of saying something before its silence is believed.

| check | `ol_out` | shuffled control |
|---|---|---|
| within-team lag-1 autocorrelation (mean +/- SE over 14 seasons) | **+0.408 +/- 0.025** | +0.012 +/- 0.011 |

Injuries persist week to week and the column knows it; the permuted twin does not. The extreme
team-weeks are also nameable rather than random: 2023 NYG wk5 and wk6 (the Giants' line collapse),
2017 WAS wk9 (4 linemen), 2025 MIN wk5 (4), 2016 PIT wk5, 2015 LAC wk4/wk9, 2019 SEA wk6.

## Results

### `ol_out` -- season-level mean +/- SE over 14 seasons (floor = 2.9*SE)

| slice | rho_resid (raw) | rho\|L | rho\|L, ECR rows | rho\|L+ECR | floor (L+ECR) | verdict |
|---|---|---|---|---|---|---|
| pooled | +0.0071 +/- 0.0049 | +0.0069 +/- 0.0051 | +0.0054 +/- 0.0110 | **+0.0066 +/- 0.0105** | 0.0305 | below |
| RB | +0.0009 +/- 0.0070 | +0.0033 +/- 0.0070 | +0.0080 +/- 0.0157 | **+0.0063 +/- 0.0142** | 0.0413 | below |
| WR | +0.0048 +/- 0.0070 | +0.0040 +/- 0.0071 | -0.0167 +/- 0.0110 | -0.0143 +/- 0.0097 | 0.0282 | below |
| TE | +0.0242 +/- 0.0152 | +0.0216 +/- 0.0152 | +0.0429 +/- 0.0425 | +0.0448 +/- 0.0430 | 0.1247 | below |
| QB | +0.0087 +/- 0.0086 | +0.0061 +/- 0.0088 | +0.0094 +/- 0.0190 | +0.0148 +/- 0.0181 | 0.0525 | below |
| PASS (QB/WR/TE) | +0.0098 +/- 0.0054 | +0.0085 +/- 0.0055 | +0.0040 +/- 0.0123 | +0.0055 +/- 0.0119 | 0.0346 | below |

The residual GAP in fantasy points:

| slice | ol_out >= 1 vs 0 | ol_out >= 2 vs 0 |
|---|---|---|
| pooled | +0.120 +/- 0.069 (floor 0.200) | +0.120 +/- 0.155 (floor 0.448) |
| RB | +0.063 +/- 0.120 (floor 0.348) | **-0.110 +/- 0.154** (floor 0.447) |
| WR | +0.097 +/- 0.097 | +0.000 +/- 0.211 |
| TE | +0.257 +/- 0.171 | +0.571 +/- 0.545 |
| QB | +0.152 +/- 0.134 | +0.338 +/- 0.378 |
| PASS | +0.148 +/- 0.077 | +0.228 +/- 0.195 |

**The rushing-vs-passing prior does not survive.** The published intuition is that line loss hits
rushing hardest. In this store it is the RB slice that is flattest of all -- raw `rho_resid` of
+0.0009, and a `>= 2` gap that is NEGATIVE (a player whose line is missing two men scores 0.11 points
*more* than the residual of a healthy-line player, well inside noise). The mildly positive pooled
gap is carried by TE and QB, both far inside their floors and neither with a mechanism this study
tested.

Per-season the sign is unstable, which is what a null looks like: 2021 is the most positive year
(pooled `rho|L` +0.042, RB +0.048) and 2024 the most negative (pooled -0.013, RB -0.043). Nothing
resembles the regime split that made `prior_vol_cv` worth a full screen -- the recent five seasons
are +0.008, +0.042, -0.017, +0.000, -0.013.

### `ol_questionable` -- 14 seasons

| slice | rho_resid (raw) | rho\|L+ECR | floor | verdict |
|---|---|---|---|---|
| pooled | +0.0007 +/- 0.0049 | +0.0007 +/- 0.0044 | 0.0129 | below |
| RB | +0.0050 +/- 0.0079 | +0.0047 +/- 0.0088 | 0.0256 | below |
| PASS | -0.0008 +/- 0.0060 | -0.0019 +/- 0.0087 | 0.0252 | below |

Gap pooled: +0.074 +/- 0.089 points for `>= 2`. This is the flattest of the three -- unsurprising,
since Questionable is mostly noise about who will actually miss a snap.

### `ol_starters_out` -- 13 seasons (no 2025 depth chart)

| slice | rho_resid (raw) | rho\|L+ECR | floor | verdict |
|---|---|---|---|---|
| pooled | +0.0083 +/- 0.0058 | +0.0039 +/- 0.0086 | 0.0249 | below |
| RB | +0.0016 +/- 0.0063 | +0.0025 +/- 0.0114 | 0.0329 | below |
| WR | +0.0071 +/- 0.0075 | -0.0150 +/- 0.0068 | 0.0198 | below |
| TE | +0.0264 +/- 0.0163 | +0.0390 +/- 0.0424 | 0.1230 | below |

Gap pooled `>= 1`: +0.199 +/- 0.095 points (floor 0.275) -- the largest single number in the study,
still below its floor, and its `>= 2` companion is -0.171 +/- 0.277, i.e. the wrong sign. Restricting
to starters concentrates the football story and does not move the measurement.

## Controls (both mandatory; both passed)

**POSITIVE.** A synthetic feature `synth = residual + N(0, sigma)` with sigma chosen so
corr(synth, residual) = 0.05 exactly (`sigma = sd(e) * sqrt(1/0.05^2 - 1)`), pushed through the
identical pipeline with no other change:

| slice | rho_resid (raw) | rho\|L | rho\|L+ECR | floor | verdict |
|---|---|---|---|---|---|
| pooled | +0.0596 +/- 0.0043 | +0.0590 +/- 0.0043 | +0.0549 +/- 0.0069 | 0.0199 | **CLEARS** |
| RB | +0.0581 +/- 0.0072 | +0.0582 +/- 0.0071 | +0.0492 +/- 0.0080 | 0.0233 | **CLEARS** |
| WR | +0.0638 +/- 0.0078 | +0.0631 +/- 0.0078 | +0.0438 +/- 0.0084 | 0.0243 | **CLEARS** |
| TE | +0.0548 +/- 0.0111 | +0.0536 +/- 0.0109 | +0.0721 +/- 0.0131 | 0.0379 | **CLEARS** |
| QB | +0.0587 +/- 0.0099 | +0.0582 +/- 0.0097 | +0.0648 +/- 0.0220 | 0.0637 | **CLEARS** |

The pipeline detects a true 0.05 in every slice including the thinnest, and the recovered value
(+0.055 to +0.060 rather than exactly +0.050) is the expected small upward bias of a per-season
estimate whose sigma was set from the pooled-season residual sd. The measured `ol_out` effect is
**an order of magnitude below** what the instrument demonstrably sees. The `gap` columns are `n/a`
for this control by construction -- a continuous synthetic never takes the value 0, so there is no
`ol_out == 0` baseline group to subtract; the gap statistic's own control is the negative one below.

**NEGATIVE.** `ol_out` permuted across the team-weeks WITHIN each season (marginal distribution and
per-season coverage preserved exactly; only the team-week alignment destroyed), seed 20260917:

| slice | rho_resid (raw) | rho\|L+ECR | floor | gap >= 2 | verdict |
|---|---|---|---|---|---|
| pooled | +0.0001 +/- 0.0040 | +0.0054 +/- 0.0040 | 0.0117 | -0.006 +/- 0.100 | null |
| RB | -0.0048 +/- 0.0055 | +0.0101 +/- 0.0142 | 0.0413 | -0.180 +/- 0.195 | null |
| PASS | +0.0021 +/- 0.0049 | +0.0030 +/- 0.0108 | 0.0312 | +0.089 +/- 0.128 | null |

Reads null everywhere, as required. Note that the shuffled control's numbers are **the same size as
the real feature's** -- which is the cleanest possible statement of the verdict.

## What this does and does not rule out

It rules out, at the pre-filter's resolution, **a team-week COUNT of linemen on the injury report**
adding anything to the served weekly design. The measurement is trustworthy (positive control sees
0.05, negative control sees nothing, the feature itself is connected with a 0.41 autocorrelation).

It does **not** rule out an offensive-line signal built differently, and one specific caveat should
be recorded before this is called closed:

- **The counting feature has almost no dynamic range.** 0.26-0.45 linemen out per team-week, with
  `>= 2` at 2.5-5.9% of team-weeks. A continuous line-quality measure -- cumulative starter
  continuity, PFF-style pass-block grade, or snap-weighted replacement-level -- is a different
  candidate with a different variance, and this study says nothing about it. Such a feature is not
  in the store today.
- **`docs/feature-frontier.md` records that a pooled pre-filter can average a regime split away**
  (`prior_vol_cv`). The per-season table was inspected for exactly that here and shows no regime:
  the last five seasons are +0.008, +0.042, -0.017, +0.000, -0.013, which is noise about zero, not a
  trend. So the usual "a plausibly regime-dependent candidate still earns a screen" escape clause
  does not apply.
- **The ECR partial rests on five seasons.** If the question were ever "is this redundant with the
  consensus?", it would be underpowered. It is not the question, because the raw correlation is
  already null.

## Artifacts

- `scripts/weekly-oline-prefilter.mjs` -- the study, one command, readonly.
- `data/residuals-oline.tsv` -- machine-readable coverage + every statistic (gitignored).
- `data/fold-artifacts-oline/` -- the 14 blind weekly fold artifacts used (gitignored, 116 MB).
