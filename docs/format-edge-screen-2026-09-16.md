# Per-format feature screen -- the candidate library under the YAHOO target (2026-09-16)

**Nothing here is shipped. No default feature list, trainer default, lever or artifact was changed.**
This is a measurement of the design doc's central edge claim, run with this repo's discipline, and the
answer is mostly "no". Read the verdict section before the tables.

## The question

`docs/multi-format-design.md` ("Per-format feature engineering", "Why this is a real edge, not
ceremony") argues that the ~12 declared-not-fitted candidates that all REJECT under ESPN half-PPR
were *rejected under half-PPR scoring*, and that some of them have a MECHANICAL reason to pay under
the Yahoo ruleset: aDOT / air-yards / end-zone targets under **first-down + 40+ big-play + full-PPR +
TE-premium** scoring, and QB rushing volume under **superflex + 6-pt pass TDs**. Nobody had measured
it. This screen measures it.

- Yahoo format: `data/formats/sc-a845f67652fb/` (scoringKey `sc-a845f67652fb`, league 129048),
  full PPR with TE 1.5, 6-pt pass TD, -2 INT, +2/+3 yardage milestones (pass 300/400, rush+rec
  100/200), first downs pass 0.2 / rush 0.5 / rec 0.5, +2 per 40+ yard completion/run/reception.
- ESPN incumbent: `data/ff.db` (half-PPR), read-only, screened in the SAME session with the SAME
  script and window so the contrast is one invocation pair, not a comparison against older recorded
  numbers (checklist item: never correlate two facts sampled from two separate runs).
- Window `2013-2025` throughout; canonical selection-blind split (decision 2013-2020, 8 seasons;
  confirm 2021-2025, quoted once). Gate: WS1 paired-season `2.9*SE` floor. Family-wide BH FDR (WS4)
  applied across the 18 Yahoo screens.

## STEP 1 -- the lever is connected (charter rule 4 / checklist item 3)

Four independent checks, all run against the format DB before any verdict was read.

**(a) The ext table carries the whole candidate library, and it is format-INDEPENDENT.**
`feat_player_season_ext` in the Yahoo `features.db` has the identical 39 columns and identical
per-season row counts as the ESPN store's (2013:566 ... 2025:652). Set difference "present in ESPN,
missing in Yahoo" = **empty**. That is what it should be: the candidates are component stats
(air yards, red-zone touches, NGS), which do not depend on a ruleset.

**(b) `feat_player_season.pts` in the format DB really is the Yahoo target, not a half-PPR copy.**
2024 top rows, Yahoo vs ESPN, same store layout:

| player | Yahoo `pts` | ESPN `pts` |
|---|---|---|
| Lamar Jackson | 611.5 | 430.4 |
| Joe Burrow | 563.5 | 372.9 |
| Josh Allen | 521.2 | 379.1 |
| Ja'Marr Chase | 470.5 | 339.5 |

`prior_pts[2024] == pts[2023]` holds **503/503** (point-in-time invariant), and the feat rows agree
with the 8/8-ground-truthed `history-points.csv` on **299/300** sampled 2024 rows. (The one
disagreement is a duplicate `name` in the CSV resolving to a different `player_sk`; it is a join
artifact of my spot-check, not a target defect -- the sampler keys on `name` alone.)

**(c) A Yahoo FOLD artifact serves Yahoo-scale projections, and is blind to its own season.**
`artifact-2024.json` from the fold set: `holdoutSeason=2024`, `learner=gbm`, 11 fitted features,
`seasons` does NOT include 2024. Projections for 2024, Yahoo fold vs ESPN fold:

| player | Yahoo fold proj | ESPN fold proj |
|---|---|---|
| Jalen Hurts | 446.1 | 294.7 |
| Josh Allen | 449.9 | 305.9 |
| Lamar Jackson | 440.3 | 300.7 |
| Ja'Marr Chase | 293.8 | 170.6 |

**(d) The SCREEN ITSELF can return a positive.** This is the control that matters most, because a
page of REJECTs is exactly what a disconnected harness produces. The leave-one-out of `fftoday_proj`
under the Yahoo target returns **KEEP, +0.5698 +/- 0.0941 pinball, 8/8 seasons, floor 0.2729** --
an unambiguous, large, correctly-signed effect from the same script, the same window, the same DB.
So every REJECT below is a measurement, not silence.

## STEP 1b -- the Yahoo BASELINE, the first honest accuracy figure for this format

`ff evaluate-projection --db data/formats/sc-a845f67652fb/features.db --seasons 2013-2025`
(13 outer folds, trainer re-run blind per fold; fold artifacts written to a scratch dir, nothing
under `data/` touched):

```
OUT-OF-SAMPLE, pooled over 13 held-out seasons   (YAHOO target -- points are ~1.4x the ESPN scale)
             CARRY-FORWARD          CURVE-ONLY             TRAINED
             rmse      r2   crps   rmse      r2   crps   rmse      r2   crps
  ALL          81.9   0.448   18.8    77.3   0.509   18.2    71.3   0.582   15.7
  QB          130.4   0.462   32.1   127.4   0.487   32.2   107.4   0.635   24.6
  RB           90.0   0.269   20.6    82.8   0.382   20.0    78.4   0.446   17.4
  WR           75.3   0.447   18.0    70.3   0.518   17.9    67.9   0.550   15.8
  TE           61.4   0.446   14.4    59.0   0.489   13.9    56.0   0.538   12.3
  returning    81.0   0.452   18.3    75.2   0.528   17.8    69.9   0.592   15.3   (n=5632)
  new          88.6   0.415   22.8    91.8   0.373   21.8    81.2   0.509   18.6   (n= 723)
  coverage p10/p90 inside band: carry 0.614  curve 0.587  trained 0.747
```

The trained model beats the free curve at every position and in every rank band -- **RMSE -7.8%,
pinball -13.7% vs curve pooled** -- so the format-native projector is doing real work, not
reproducing the curve at a new scale.

**One number needed explaining before it was written down (charter rule 3).** The verb's own P5 ship
gate prints `P5 FAILED`. Reading it: RMSE PASS (70.54 vs curve 76.92), pinball PASS (15.53 vs 18.06),
pooled coverage PASS (0.752, in [0.75, 0.85]); the single failing sub-check is **per-band** coverage,
where the `60+` band is **0.692 against a 0.70 floor** -- a 0.008 miss in the deepest, thinnest band.
This is not a format defect and not new: the ESPN incumbent shows the same deep-band under-coverage
shape (the quantile heads are fitted over ranks 1-60 and the rank is clipped there, so beyond rank 60
the band is extrapolated). It is a calibration note for a future Yahoo weekly/variance fit, not a
reason to distrust the screen -- every screen below compares two arms that share that property.

## STEP 2 -- the cheap pre-filter (charter rule 2)

`scripts/prefilter-feature.mjs` (new, this session). For each candidate x position it measures, under
whatever target the `--db` carries:

- `rho_y` -- correlation with the actual season points (raw predictiveness);
- `rho_res` -- correlation with the **out-of-sample residual of the shipped baseline**, computed from
  the per-season blind fold artifacts (the script ASSERTS `holdoutSeason === Y` and refuses a
  single all-history artifact, because that residual would be in-sample);
- `rho_res|C` -- the same, PARTIALLED on the level and the incumbent usage shares
  (`prior_pts`, `prior_pos_rank`, `prior_games`, `age`, `prior_snap_share`, `prior_route_share`,
  `prior_carries_per_game`, `prior_carry_share`, `prior_air_yards_share`, `prior_wopr`, `adp`,
  `fftoday_proj`). This is the level-in-disguise detector.

6,355 scored rows over 13 blind seasons on each side. **The headline is that the two formats'
residual structures are nearly identical.** Ordered by |`rho_res|C`| under Yahoo (abridged; full
tables in the screen outputs):

| candidate | pos | n | YAHOO rho_y | rho_res | rho_res\|C | ESPN rho_y | rho_res | rho_res\|C |
|---|---|---|---|---|---|---|---|---|
| `fftoday_proj` | WR | 1443 | +0.713 | -0.009 | **+0.192** | +0.706 | -0.019 | +0.186 |
| `fftoday_proj` | QB | 645 | +0.812 | +0.017 | **+0.163** | +0.813 | +0.038 | +0.170 |
| `prior_yac_oe` | TE | 263 | +0.236 | +0.120 | +0.151 | +0.242 | +0.130 | +0.167 |
| `prior2_pts` | WR | 1575 | +0.633 | +0.073 | +0.133 | +0.630 | +0.070 | +0.146 |
| `hist_ppg_w` | WR | 2122 | +0.712 | -0.000 | +0.119 | +0.706 | -0.009 | +0.136 |
| `prior_out_games` | QB | 142 | +0.133 | +0.138 | +0.106 | +0.132 | +0.124 | +0.088 |
| `prior_adot` | QB | 107 | +0.134 | +0.134 | +0.064 | +0.133 | +0.055 | -0.006 |
| `adp` | TE | 246 | -0.408 | +0.125 | +0.063 | -0.408 | +0.064 | -0.007 |
| `prior_ryoe` | RB | 334 | +0.253 | +0.031 | +0.055 | +0.254 | +0.016 | +0.024 |
| `prior_ez_target_share` | QB | 716 | +0.015 | +0.040 | +0.054 | +0.019 | +0.036 | +0.057 |
| `prior_rz_touch_share` | WR | 2042 | +0.512 | -0.059 | -0.037 | +0.510 | -0.064 | -0.028 |
| `prior_ez_target_share` | WR | 2032 | +0.490 | -0.028 | +0.000 | +0.491 | -0.036 | +0.008 |
| `prior_adot` | WR | 2042 | +0.026 | +0.015 | +0.018 | +0.030 | +0.004 | +0.011 |
| `prior_rz_touch_share` | RB | 1390 | +0.570 | -0.024 | +0.022 | +0.573 | -0.017 | +0.018 |
| `qb_changed` | WR | 2096 | -0.046 | +0.021 | +0.008 | -0.046 | +0.013 | -0.003 |

Two readings, both load-bearing:

1. **The classic level-in-disguise pattern is present and the partial correlation catches it.**
   `prior_rz_touch_share` (WR) has `rho_y = +0.51` and `rho_res|C = -0.04`; `prior_ez_target_share`
   (WR) `+0.49 -> +0.000`. These columns predict the target well and predict what the model got wrong
   not at all -- they are the level the projector already carries. This is exactly the shape
   `docs/edges.md` #14 and the 2026-09-15 pbp round recorded, and it reproduces under the Yahoo
   target rather than being a half-PPR artifact.
2. **The thesis-critical candidates do not light up under Yahoo.** `prior_adot` WR moves +0.011 ->
   +0.018; `prior_ez_target_share` WR +0.008 -> +0.000. The differences are inside the noise of a
   correlation on ~2,000 rows. The largest Yahoo-favoring gaps (`prior_adot` QB +0.059, `adp` TE
   +0.056) sit on n=107 and n=246 and are not the mechanism the design doc argues for.

Per the frontier doc's own recorded lesson (`prior_vol_cv`: a pooled pre-filter averaged a real
regime split away), a pre-filter null on a plausibly regime-sensitive candidate **still earns the
full screen**. Every mechanical candidate below was screened regardless of what it scored here.

## STEP 3+4 -- the full paired-floor screen, Yahoo, with the ESPN contrast from the same session

18 screens per format, ~1 minute each. `--pos` used for every position-gated candidate. Improvement
is the candidate's own contribution in pinball (higher is better); the verdict is the WS1 `2.9*SE`
decision on 2013-2020; the holdout is quoted once and never gates. `q(BH)` is the family-wide FDR
across the 17 non-degenerate Yahoo screens.

| candidate | pos | YAHOO base pinball | YAHOO improvement +/- SE (wins) | floor | verdict | YAHOO holdout | q(BH) | ESPN improvement +/- SE (wins) | ESPN floor | ESPN verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| `fftoday_proj` | REMOVE | 16.905 | +0.5698 +/- 0.0941 (8/8) | 0.2729 | **KEEP** | +0.1884 / floor 0.4390 / NOT confirmed | 0.000 | +0.4491 +/- 0.0570 (8/8) | 0.1653 | **KEEP** |
| `prior_adot` | TE | 13.314 | +0.0582 +/- 0.0218 (5/8) | 0.0633 | REJECT | -0.2708 / floor 0.3436 / NOT confirmed | 0.030 | -0.0387 +/- 0.0257 (2/8) | 0.0746 | REJECT |
| `prior_ez_target_share` | TE | 13.314 | +0.0708 +/- 0.0521 (4/8) | 0.1511 | REJECT | -0.0873 / floor 0.1342 / NOT confirmed | 0.464 | +0.0504 +/- 0.0387 (5/8) | 0.1121 | REJECT |
| `prior_yac_oe` | TE | 13.314 | +0.0454 +/- 0.0454 (1/8) | 0.1315 | REJECT | -0.1308 / floor 0.2794 / NOT confirmed | 0.626 | +0.0134 +/- 0.0134 (1/8) | 0.0388 | REJECT |
| `hist_ppg_w` | WR | 16.642 | +0.1122 +/- 0.1526 (5/8) | 0.4424 | REJECT | +0.0558 / floor 0.6908 / NOT confirmed | 0.626 | +0.0102 +/- 0.0565 (3/8) | 0.1638 | REJECT |
| `adp` | ALL | 16.335 | +0.0216 +/- 0.0359 (3/8) | 0.1042 | REJECT | +0.0225 / floor 0.1433 / NOT confirmed | 0.626 | +0.0187 +/- 0.0199 (4/8) | 0.0578 | REJECT |
| `prior_ez_target_share` | WR | 16.642 | +0.0152 +/- 0.0249 (4/8) | 0.0721 | REJECT | +0.1794 / floor 0.3854 / NOT confirmed | 0.626 | +0.0283 +/- 0.0414 (4/8) | 0.1201 | REJECT |
| `hist_ppg_w` | QB | 25.013 | -0.0200 +/- 0.0867 (3/8) | 0.2514 | REJECT | +0.6030 / floor 0.7119 / NOT confirmed | 0.999 | -0.2667 +/- 0.0811 (0/8) | 0.2351 | REJECT |
| `qb_changed` | WR | 16.642 | -0.0116 +/- 0.0275 (2/8) | 0.0798 | REJECT | +0.2411 / floor 0.4427 / NOT confirmed | 0.999 | -0.0186 +/- 0.0242 (2/8) | 0.0703 | REJECT |
| `prior_rz_touch_share` | RB | 17.967 | -0.0431 +/- 0.0483 (3/8) | 0.1402 | REJECT | +0.0191 / floor 0.1456 / NOT confirmed | 0.999 | +0.0157 +/- 0.0224 (4/8) | 0.0650 | REJECT |
| `prior_carries_per_game` | QB | 25.013 | -0.0676 +/- 0.0654 (1/8) | 0.1896 | REJECT | +0.3717 / floor 0.7831 / NOT confirmed | 0.999 | -0.0064 +/- 0.0843 (2/8) | 0.2445 | REJECT |
| `prior_td_oe` | WR | 16.642 | -0.0953 +/- 0.0480 (2/8) | 0.1392 | REJECT | +0.2011 / floor 0.3446 / NOT confirmed | 0.999 | -0.0233 +/- 0.0407 (2/8) | 0.1179 | REJECT |
| `prior_adot` | WR | 16.642 | -0.0985 +/- 0.0497 (2/8) | 0.1442 | REJECT | +0.0043 / floor 0.5664 / NOT confirmed | 0.999 | -0.0493 +/- 0.0314 (2/8) | 0.0911 | REJECT |
| `prior_td_oe` | RB | 17.967 | -0.2190 +/- 0.0666 (1/8) | 0.1932 | REJECT | -0.0361 / floor 0.1832 / NOT confirmed | 0.999 | -0.0458 +/- 0.0670 (2/8) | 0.1942 | REJECT |
| `prior2_pts` | WR | 16.642 | -0.2506 +/- 0.1048 (1/8) | 0.3038 | REJECT | +0.0430 / floor 0.1688 / NOT confirmed | 0.999 | -0.1072 +/- 0.1434 (4/8) | 0.4159 | REJECT |
| `prior_yac_oe` | WR | 16.642 | -0.0093 +/- 0.0093 (0/8) | 0.0270 | REJECT (near-degenerate) | +0.2279 / floor 0.3935 / NOT confirmed | 0.999 | +0.0131 +/- 0.0131 (1/8) | 0.0380 | REJECT (near-degenerate) |
| `prior_cpoe` | QB | 25.013 | +0.0000 +/- 0.0000 (0/8) | 0.0000 | **DEGENERATE -- not a null** | +0.3032 / floor 0.6319 / n.c. | n/a | +0.0000 +/- 0.0000 (0/8) | 0.0000 | **DEGENERATE** |
| `prior_ryoe` | RB | 17.967 | +0.0000 +/- 0.0000 (0/8) | 0.0000 | **DEGENERATE -- not a null** | -0.0678 / floor 0.1267 / n.c. | n/a | +0.0000 +/- 0.0000 (0/8) | 0.0000 | **DEGENERATE** |

**Family-wide FDR (WS4):** across the 17 non-degenerate Yahoo screens, the only BH survivors at
alpha=0.10 are `fftoday_proj` (leave-one-out, q<0.001) and `prior_adot` TE (q=0.030). Note the FDR is
LOOSER than the WS1 floor here -- 2.9 sigma corresponds to p ~ 0.002 -- so `prior_adot` TE passing BH
while failing the floor is the two criteria doing exactly what they are designed to do, not a
contradiction. The floor is the gate.

### Two arms were DEGENERATE, and that is a finding about the harness, not about football

`prior_cpoe` (QB) and `prior_ryoe` (RB) returned improvement **exactly 0.0000 with SE exactly 0 and
0/8 wins** under BOTH targets. That is the signature of two IDENTICAL models, i.e. the candidate
never entered the fit -- which reads exactly like a clean null and is not one. Diagnosed to the input
rather than reported on face:

```
non-null rows in feat_player_season_ext, by season (Yahoo format DB; ESPN identical)
season  prior_cpoe  prior_ryoe  prior_yac_oe
2013-16          0           0             0
2017            34           0           117
2019            34          47           113
2024            41          48           109
```

`tools/train_projection.py build_specs` drops any feature with `< 200` covered rows. NGS starts 2016
and covers only the top ~40 QBs / ~48 RBs / ~120 receivers a season, so these columns are **below the
coverage floor in every fold** and the two arms are byte-identical models.

**Positive control, to prove the lever is CONNECTED and not merely absent** (the frontier doc's own
rule): trained a FULL-DATA Yahoo artifact with each candidate added and read the coefficients.

| candidate | in the fitted spec list | mean-head coefficients |
|---|---|---|
| `prior_cpoe` | yes | QB -0.0445, every other position exactly 0 |
| `prior_ryoe` | yes | RB +0.0137, every other position exactly 0 |
| `prior_yac_oe` | yes | WR +1.4066, TE +11.6939, others 0 |
| `prior_adot` | yes | WR +0.0101, TE -0.0349, others 0 |

So the wiring works end to end (and `EXT_ALLOWED` is enforced -- zero at every disallowed position).
The walk-forward screens for the NGS family are **underpowered by construction, not null**.

**Exploratory re-screen on an NGS-covered window** (non-canonical split, reported OUTSIDE the FDR
family and NOT a decision: `--seasons 2018-2025 --holdout-seasons 2024-2025`, decision 2018-2023, 6
seasons, confirm impossible with 2 held-out seasons):

| candidate | pos | improvement +/- SE (wins) | floor | verdict |
|---|---|---|---|---|
| `prior_yac_oe` | TE | +0.0369 +/- 0.0737 (2/6) | 0.2137 | REJECT |
| `prior_cpoe` | QB | -0.0249 +/- 0.0249 (0/6) | 0.0722 | REJECT |
| `prior_ryoe` | RB | +0.0000 +/- 0.0000 (0/6) | 0.0000 | STILL DEGENERATE |

`prior_ryoe` is **unscreenable at any window** at the season grain: ~48 covered RB rows a season can
never reach a 200-row floor.

## The reading

**The format-edge thesis, as stated for the PROJECTION layer, is NOT supported.** Nothing admits
under the Yahoo target. The candidate library behaves the same way under full-PPR + first-downs +
big-play bonuses + TE premium as it does under half-PPR, at the season grain, and the ESPN contrast
run in the same session confirms this is a genuine similarity rather than two differently-measured
numbers.

The single interesting signal is `prior_adot` at **TE**:

- Yahoo **+0.0582 +/- 0.0218, 5/8 seasons, floor 0.0633** -- a near-miss (92% of the floor), BH
  q=0.030;
- ESPN **-0.0387 +/- 0.0257, 2/8** -- wrong sign;
- so this IS a sign flip in the direction the mechanism predicts (TE premium 1.5 + 0.5/reception
  first down + 40+ bonus makes target DEPTH worth more at TE than it is in half-PPR);
- but the holdout is **-0.2708** -- it reverses hard on 2021-2025, the opposite of the
  `hist_ppg_w`-style "rejected on the gate, confirmed on the holdout" pattern that would make it a
  live candidate. It fails the gate AND fails the confirm.

The honest summary of that one row: **suggestive, sub-floor, holdout-contradicted; keep it as a
declared candidate and re-screen when the Yahoo window widens; do not take it to sign-off.**

**The QB-side superflex thesis is contradicted, not merely unsupported.** `prior_carries_per_game`
is `EXT_ALLOWED` for QB already and was screened directly: Yahoo **-0.0676 (1/8)**, i.e. slightly
worse than the ESPN arm's -0.0064. `hist_ppg_w` at QB is Yahoo -0.0200 vs ESPN -0.2667 -- less
harmful under Yahoo, consistent with the QB target being larger and better-conditioned, but still a
reject. Superflex changes the VALUE of a QB point, not the PREDICTABILITY of QB points, and the
projector is a points model. This is the same conclusion `docs/multi-format-design.md` already
reached from the other direction ("the superflex edge is a VALUE-layer (Layer 2) effect"); the
feature screen now independently confirms it from the projection side.

**The known half-PPR-scaled anchors still carry their weight under Yahoo.** `fftoday_proj` --
FFToday's own-scoring preseason projection, used as a ratio to the rank bucket -- is worth
**+0.5698 pinball (8/8 seasons)** under the Yahoo target, MORE in absolute terms than under ESPN
(+0.4491) and comparable relative to the larger Yahoo pinball scale (3.4% vs 3.8%). The ratio-to-
bucket-mean form divides the scoring scale out, which is exactly why the approximation survives the
retarget. `adp`, gated the same way, is a null under both (+0.0216 Yahoo / +0.0187 ESPN), reproducing
the D16 finding that the external *judgement* carries and the market *rank* does not. **So the
"known feature approximations carried" flag in the design doc is real but not urgent for accuracy**;
a Yahoo-native consensus would be cleaner, but the half-PPR-scaled anchor is not leaking value.

**A methodological confirmation worth recording.** The ESPN arm reproduces the recorded frontier
numbers closely on an independently-constructed run: `prior_rz_touch_share` RB +0.0157 / floor 0.0650
(frontier: +0.0157 / 0.0650), `prior_td_oe` RB -0.0458 / 0.1942 (frontier: -0.0458 / 0.1942),
`prior_ez_target_share` WR +0.0283 / 0.1201 (frontier: +0.0283 / 0.1201), `prior_adot` WR -0.0493 /
0.0911 (frontier: -0.0493 / 0.0911). Identical to four decimals, which is the expected result for a
deterministic walk-forward fit and a strong check that this session's harness measures the same thing
the recorded screens did.

## Status of anything that might look like a result

- **Nothing is shipped.** No default list, trainer default, lever, artifact, or golden changed.
  `scripts/prefilter-feature.mjs` is new and reads only; `scripts/admit-feature.mjs` was NOT modified
  (its existing `--db` flag reaches the trainer, the curve-only rung and the feature loader, which is
  all this needed). Screen outputs live in the session scratchpad.
- **Any ADMIT would still need owner sign-off (D14/D15) -- and there is no ADMIT.** Had one cleared,
  it would have been **pinball-floor-only**: the Yahoo format has **no championship gate**. `cpcv.mjs`
  has no `--league`/`--format` axis and `data/formats/sc-a845f67652fb/golden.json` does not exist
  (finding F-9; WP7 owns it). The one rule (D13) applies per format, and that format's arbiter is not
  built, so a projector feature admitted here would be admitted on accuracy alone.
- **Power note.** `--seasons 2013-2025` scores 8 decision seasons (the ext table's canonical range
  starts 2013), against the ESPN ladder's 9. The `2.9*SE` floor on 8 seasons is a high bar: the floors
  in the table run 0.03-0.44 pinball on a 13-25 pinball baseline. A sub-floor positive is therefore
  "not resolvable here", not "proven zero" -- which is what WS1 is for.

## What could not be run, and why

| not run | reason |
|---|---|
| `--remove adp` (leave-one-out) | `adp` is NOT a default feature (`CENTER_FEATURES`/`RATIO_FEATURES` hold 11 columns; `adp` is an `EXT_CENTER` candidate), so `--remove-features adp` exits by design. Screened with `--add` instead -- the same test the ESPN ladder ran. |
| `prior_carry_share` at QB | `EXT_ALLOWED["prior_carry_share"] = {"RB"}`. Allowing QB is a `tools/` edit, out of scope here. Not worth making (see below) -- the QB-rushing mechanism is already testable via `prior_carries_per_game`, which is QB-allowed and rejected. |
| `prior_ryoe` at any window | ~48 covered RB rows/season vs the trainer's 200-row `build_specs` floor. Structurally unscreenable at the season grain. |
| the D13 championship gate on any candidate | no Yahoo `golden.json` and no `cpcv --league`; and no candidate cleared the accuracy floor, so the gate was never reached. |
| weekly-grain screens under the Yahoo target | Not run in this pass. NOTE (orchestrator correction, same day): the format DB's `feat_player_week_model` is NOT a half-PPR copy any more -- WP3 rebuilt it under the Yahoo target (measured: 1,102 of 2,736 shared 2025 wk1-4 rows differ in `pts`, 2,352 in `season_line_pg`). What still blocks an honest weekly screen is `manifest.weekly.seasonLineBlind: false`: every historical season line was projected from an artifact that saw that season, so a weekly screen there would be lookahead until a per-season blind fold set exists for this format. |

**The one trainer change worth making (and it is small): none for the edge thesis; one for honesty.**
The QB-rushing angle needed no trainer change and rejected. What the session did surface is that
`build_specs`' 200-row coverage floor SILENTLY produces an arm identical to baseline, and
`admit-feature` then reports that as `REJECT -- improvement is within the floor` with SE 0.0000.
A REJECT and a never-connected feature print the same verdict. If anything is changed later, it
should be a one-line guard in `scripts/admit-feature.mjs` that refuses to issue a verdict when
`se == 0 && wins == 0` and says "the two arms are identical -- the candidate never entered the fit,
check coverage" instead. That is a reporting fix, not a model change, and it is exactly the
"silence read as agreement" class CLAUDE.md warns about.

## Reproduce

```
# baseline + blind fold artifacts (write them OUTSIDE data/)
npm run ff -- evaluate-projection --db data/formats/sc-a845f67652fb/features.db \
  --seasons 2013-2025 --keep-artifacts <scratch>/folds-yahoo

# pre-filter (both formats)
node --import tsx scripts/prefilter-feature.mjs --db data/formats/sc-a845f67652fb/features.db \
  --artifact-dir <scratch>/folds-yahoo --seasons 2013-2025 --out <scratch>/prefilter-yahoo.tsv
node --import tsx scripts/prefilter-feature.mjs --db data/ff.db \
  --artifact-dir data/fold-artifacts-d16 --seasons 2013-2025 --out <scratch>/prefilter-espn.tsv

# one screen (repeat per candidate/pos; swap --db for the ESPN contrast)
node --import tsx scripts/admit-feature.mjs --candidate prior_adot --pos TE --seasons 2013-2025 \
  --db data/formats/sc-a845f67652fb/features.db
```
