# Feature frontier -- the season projector's candidate features and their screen verdicts (2026-09-14)

The projector (`tools/train_projection.py` + `feat_player_season_ext`) fits a small set of
prior-season workload-share features (`prior_snap_share`, `prior_route_share`,
`prior_carries_per_game`, `prior_carry_share`, `prior_air_yards_share`, `prior_wopr`,
`depth_rank_sep1`, `adp`, `adp_vs_ecr`, `rookie_draft_pick`; indicator `team_changed`). Those cover
the **workload-share** frontier well. Three more signal families in the raw store were wired as
opt-in candidates and screened. This page records them so "have we exhausted the features?" is a
list with verdicts, not a shrug.

## SCREENED 2026-09-14 -- all five candidates REJECT (none clears the 2.9*SE floor)

> **Re-confirmed under the GBM (2026-09-14 fan-out).** These screens run against the SHIPPED boosted
> model, not the old linear one: the trainer's `--learner` default is `gbm` and `evaluate.ts` passes no
> `--learner`, so `admit-feature` fits GBM in both arms (verified by grepping a fresh fold artifact for
> `"learner":"gbm"`). A separate re-screen of all 12 rejected candidates (these five plus the ladder's
> lags/basis/`contract_year`) confirmed every one still REJECTs under the GBM -- nothing null-as-a-linear-
> addition came alive via boosting interactions. `hist_ppg_w` keeps its holdout-only confirm; still a
> candidate, not a default. docs/validation.md, the edge fan-out entry.

All five were wired as DECLARED-not-fitted columns of `feat_player_season_ext` (schema.sql + db.ts
migration + seasonExt.ts extraction + projector.ts `FEATURE_FIELDS`), so screening changed NO shipped
number. Verdicts on the selection folds (position-gated screens use `admit-feature --pos`):

| candidate | pos | window | improvement (pinball) | floor (2.9*SE) | verdict |
|---|---|---|---|---|---|
| `prior_out_games` (durability) | all | 2013-2020 | -0.0024 (holdout -0.0129) | 0.0166 | REJECT |
| `qb_changed` | WR | 2013-2020 | +0.0044 (holdout +0.122, floor 0.354) | 0.0101 | REJECT |
| `prior_yac_oe` (NGS YAC-over-exp) | WR | 2019-2023 | +0.0004 | 0.0011 | REJECT |
| `prior_ryoe` (NGS rush-yds-over-exp) | RB | 2021-2024 | +0.0005 | 0.0015 | REJECT |
| `prior_cpoe` (NGS completion-over-exp) | QB | 2021-2024 | ~0 (too thin) | -- | REJECT/insufficient |

**Reading:** the workload-share features already capture the resolvable signal; none of the advanced
(NGS) or roster-context (QB-change) or durability candidates adds value above the noise floor. NGS is
additionally **data-starved** -- it exists only 2016+ (top ~120 rec / ~48 rush / ~40 pass players a
season), so a walk-forward fold clears the 200-row coverage floor only in the most recent seasons and
the screens are underpowered by construction. The columns are KEPT as opt-in candidates (like the
existing EXT_* set) so re-screening as NGS accrues seasons is one `admit-feature` command.

**A contract bug this surfaced (and the guard caught, loudly):** a new fitted feature must be added to
`projector.ts` `FEATURE_FIELDS` (the consumer's computable-feature allowlist), or the TS loader REFUSES
the trained artifact ("not one this evaluator can compute"). Missing that made every *covered* fold
fail while empty early folds passed -- i.e. it looked like a clean null. The positive control
(does the feature get a non-zero coefficient at full data, per position?) is what distinguished
"connected but null" from "never connected." Always run it before trusting a REJECT.

## SCREENED 2026-09-15 -- PBP situational-opportunity (red-zone / goal-line / end-zone), all REJECT

Built a new raw source, `raw_pbp_player_week` (nflverse play-by-play aggregated to player-week; 140,116
rows, 1999-2026; docs/data-sources.md 1.5a), for the one signal class the box score cannot give:
HIGH-VALUE TOUCHES. Three prior-season shares were wired as declared-not-fitted candidates of
`feat_player_season_ext` (the same path as the 2026-09-14 set) and screened position-gated on 2013-2025.

| candidate | pos | improvement (pinball) | floor (2.9*SE) | holdout confirm | verdict |
|---|---|---|---|---|---|
| `prior_rz_touch_share` (rz carries+targets / team) | RB | +0.0157 +/- 0.0224 (4/8) | 0.0650 | +0.0084, not confirmed | REJECT |
| `prior_gtg_carry_share` (goal-to-go carries / team) | RB | -0.0506 +/- 0.0384 (2/8) | 0.1114 | -0.0407, not confirmed | REJECT (negative) |
| `prior_rz_touch_share` | WR | +0.0383 +/- 0.0336 (4/8) | 0.0975 | +0.0307, not confirmed | REJECT |
| `prior_ez_target_share` (end-zone targets / team) | WR | +0.0283 +/- 0.0414 (4/8) | 0.1201 | -0.2560, not confirmed | REJECT |

**The positive control PASSED** (so these are true nulls, not dead levers): the 2024 leaders in
`prior_rz_touch_share` are exactly the 2023 goal-line bell-cows (Kyren Williams 0.511, McCaffrey 0.492,
Barkley 0.485), and `prior_gtg_carry_share` shows the real goal-line monopolies (Barkley 0.833, Jacobs
0.818, Mixon 0.816). The features are connected and face-valid; they simply add nothing resolvable.

**Reading:** same shape as edge #14 (docs/edges.md) -- prior-season red-zone role is nearly collinear
with prior rank and the volume shares (`carry_share`, `wopr`) already fitted: a bell-cow has high carries
AND high red-zone touches, so once the rank curve and volume shares are in, the high-value slice is
already paid for. The TD-equity hoped for is the least rank-predictable part of scoring, but at the
SEASON grain it does not separate from volume. The raw substrate is KEPT (valuable per se; feeds nothing
yet), and the three columns stay declared-not-fitted candidates -- re-screenable in one `admit-feature`
command. No shipped number changed.

### Follow-ups the same day: a volume-ORTHOGONAL season family, and the WEEKLY grain -- all REJECT

Because the shares nulled on collinearity, two further angles were tried to be thorough. Both REJECT,
which together with the shares makes the pbp opportunity substrate a comprehensive null on every tested
surface -- a real result, not a shrug: high-value-opportunity does not beat the shipped models anywhere.

**Volume-orthogonal season family** (built as residuals so collinearity cannot be the excuse):

| candidate | pos | improvement (pinball) | floor (2.9*SE) | holdout | verdict |
|---|---|---|---|---|---|
| `prior_td_oe` (TDs MINUS expected-from-opportunity, the regression residual) | RB | -0.0458 (2/8) | 0.1942 | -0.0554 | REJECT (neg) |
| `prior_td_oe` | WR | -0.0233 (2/8) | 0.1179 | +0.1072 (4/5) | REJECT |
| `prior_adot` (air_yards / targets) | WR | -0.0493 (2/8) | 0.0911 | +0.0105 | REJECT (neg) |

Positive control passed loudly (`prior_td_oe`'s biggest 2023 over-performer is Raheem Mostert +10.4, the
textbook regression case; biggest under-performer Tony Pollard -9.4). **Why it still nulls:** the season
projector's dominant anchor is the MARKET (ECR/ADP/FFToday), and the market already prices TD regression
-- it ranks Mostert down on its own -- so a mechanical residual is redundant with the anchor. Columns kept
as declared-not-fitted candidates.

**WEEKLY grain** (`rz_share_td` = rolling season-to-date red-zone touch share on `feat_player_week_model`,
D19 serve-contract compliant -- explicit missing, NaN passthrough, `form` mask group; point-in-time
verified: week-1 is null). Screened via `scripts/weekly-paired-floor.mjs` (pooled CRPS, 2.9*SE), baseline =
every weekly feature EXCEPT it vs `--features all`:

| arm | improvement (CRPS) | floor | verdict |
|---|---|---|---|
| selection (2012-2020) | -0.0031 (2/7) | 0.0048 | REJECT (neg) |
| holdout (2021-2025) | -0.0011 (1/4) | 0.0018 | REJECT (neg) |
| all 14 seasons | -0.0024, CI [-0.0046, -0.0002] | 0.0032 | REJECT (mildly harmful) |

Same shape as edges #7/#14: an in-season usage LEVEL that is real and face-valid (2024 wk-10 leaders are
the actual goal-line backs -- Kyren Williams .55, Conner, Jones, Kamara, Barkley) but does not convert --
here it is marginally NEGATIVE, the GBM slightly overfitting a column the anchors (season line + form +
snap/route usage) already cover. `rz_share_td` stays a declared candidate on the weekly view, unfitted;
`ff evaluate-weekly --features all` includes it only in a screen, never in the shipped serve. No shipped
number changed on either grain.

### Round 3 (2026-09-15): team-environment (season) + volatility (weekly), all REJECT -- one with a twist

Screened the two remaining axes in full (not just the pre-filter), for learning. Both reject on the gate.

**Team-environment** (a player's CURRENT team's Y-1 pbp scheme, assigned by team; season projector):

| candidate | pos | improvement (pinball) | floor | verdict |
|---|---|---|---|---|
| `prior_team_pass_rate` | WR | -0.041 | 0.089 | REJECT |
| `prior_team_pass_rate` | RB | +0.009 | 0.212 | REJECT |
| `prior_team_plays_pg` | WR | -0.063 | 0.153 | REJECT |
| `prior_team_rz_pg` | RB | -0.057 | 0.160 | REJECT |

Face-valid (WAS/CIN/MIN top pass-rate, BAL/CHI/SF run-heavy). Nulls because a player's OWN prior usage
already encodes his team's pie x share, and ADP/ECR prices team context.

**Volatility** (`prior_vol_cv` = prior-season weekly CV, always-present, weekly CRPS). Positive control
strong (St. Brown among the steadiest; committee/low-volume types most volatile).

| arm | improvement (CRPS) | floor | verdict |
|---|---|---|---|
| SELECTION (2012-2020, the gate) | -0.0016 (2/7) | 0.0023 | **REJECT** (negative) |
| holdout (2021-2025) | +0.0019 (5/0) | 0.0016 | ADMIT (confirm only) |
| all 14 seasons | -0.0004 (7/7) | 0.0021 | REJECT |

**A REGIME SPLIT, and a pre-filter blind spot worth remembering.** The gate REJECTS (selection seasons
negative), but the feature HELPS consistently in the recent regime (2021-2025, 5/0, clears the floor) --
same category as `hist_ppg_w` (rejected on the gate, holdout-only positive, kept as a candidate). And the
lesson for the screening recipe: the CHEAP pooled pre-filter (Round-2 measured `prior_vol_cv`'s pure
signal at ~0.05 and called it a flat reject) **averaged this regime split away** -- the full
season-partitioned screen is what surfaced the recent-era signal. So the pre-filter is a sound FIRST cut
but does NOT replace the partitioned screen for a feature that may be regime-dependent; a pre-filter null
on a plausibly regime-sensitive feature still earns a full screen. `prior_vol_cv` and `rz_share_td` stay
declared candidates on the weekly view, unfitted; no shipped number changed.

**Tally after 2026-09-15: ~10 pbp/volatility/team candidates screened, all REJECT on the gate.** The
projection model is well-saturated; the pbp substrate has not yielded an orthogonal-and-predictive
feature. The likely remaining edge is in the DECISION/roster-construction layer (where the sim already
shows variance and RB-scarcity move outcomes -- the cja-vs-ARI power-ranking split), not the projection.

## Screening recipe (for the next candidate)

**The screening path is now cheap and correct** (do NOT hand-read a pinball delta):
1. Add the prior-season aggregate as a column of `feat_player_season_ext`, anchored at `<season>-09-01`,
   in `src/features/sources/seasonExt.ts` (the one place the ext table is built; leakage-safe by
   construction because everything there is as-of Sep 1 of season Y and reads only Y-1 and earlier).
2. Declare it in `EXT_CENTER` / `EXT_RATIO` / `EXT_INDICATOR` (+ `EXT_ALLOWED` positions) in
   `tools/train_projection.py`. Declared != fitted: it changes NO shipped number until admitted.
   Also add the name to `src/model/projector.ts` `FEATURE_FIELDS` -- the consumer's computable-feature
   allowlist -- or the TS loader refuses any artifact that fits it (see the contract-bug note above).
3. `ff build-features-ext --seasons 2013-2025`, then screen:
   `node --import tsx scripts/admit-feature.mjs --candidate <col> --seasons 2013-2025`
   (leave-one-out `--remove` for a feature already in the defaults; `--pos QB` to score ONE position,
   the right metric for a position-gated feature whose effect is otherwise diluted ~15x by the pool).
   ~52s for the two nested-CV runs on the parallel fold executor. ADMIT only if it clears the
   `2.9*SE` effect-size floor (WS1). NB the ext table's canonical range is **2013+** (earlier FFC ADP
   archives are late-stamped and break the pre-kickoff invariant); do not build it earlier.
4. If admitted, it is still a **model change** -- re-check on the D13 playoff gate and get owner
   sign-off before it joins the defaults (the D14/D15 no-silent-model-change rule).

## The three families, in detail (why-real / why-null, kept for re-screening)

### P1 -- Advanced efficiency lags (NGS). SCREENED -> REJECT (all three, below floor; data-starved).
- **Source:** `raw_ngs` (26,737 rows, **2016-2026** -- so ~9 training seasons; fewer rows than the
  workload features, which reduces power on the older folds). Per-week, split by `stat_type`
  (passing / receiving / rushing).
- **Candidates (prior-season means, player-keyed):**
  - WR/TE: `avg_separation`, `avg_yac_above_expectation`, `catch_pct`, `avg_cushion`.
  - RB: `ryoe_per_att` (rush yards over expected / att), `rush_pct_over_expected`, `efficiency`.
  - QB: `cpoe` (completion % over expected), `avg_time_to_throw`, `aggressiveness`.
- **Why it might be real:** these are the metrics that separate sustainable production from
  rank-driven luck -- exactly the residual the curve leaves. **Why it might be null:** they are
  noisy year-to-year and partly collinear with the workload shares already fitted; screen each vs
  the SHIPPED baseline (rule 2 of the how-to-know checklist), not against a bare curve.
- **Cost:** position-split aggregation + join on `player_gsis_id` -> `player_sk`. One column per
  metric; screen the 2-3 most promising per position, not all of them (multiplicity, WS4).

### P2 -- QB-change flag. SCREENED -> REJECT (+0.0044 WR, floor 0.0101). Full coverage, leakage-careful.
- **Source:** `raw_nfl_game.away_qb_id/home_qb_id` (starter per game, **1999-2026**) for the Y-1
  primary starter; `raw_depth_chart` (preseason `depth_rank`, as-of Sep 1) for the Y expected QB1.
- **Candidate:** indicator `qb_changed` -- a skill player whose team's expected QB1 entering Y differs
  from its most-frequent starter in Y-1. The receiving analog of the existing `team_changed`.
- **LEAKAGE WARNING:** must use the **preseason expected** QB1 (depth chart as-of Sep 1), NEVER the
  realized Y starter -- using the realized starter leaks Y outcomes. This is the one candidate where a
  naive extraction is a leak; audit it the way `evaluate.ts`'s embargo guard audits the trainer
  (assert the value is computable from <= Y-1 data + the Sep-1 depth chart only).
- **Why it might be real:** a WR's target quality moves with his QB. **Why it might be null:**
  `team_changed` already fires for most QB changes that matter (the player moved), and the pure
  same-team QB swap is rare enough to be underpowered.

### P3 -- Durability / prior-season availability. SCREENED -> REJECT (-0.0024, holdout -0.0129).
- **Source:** `raw_injury` (90,780 rows, **2009-2026**) and/or `raw_snap_count` games played. Note
  `src/features/sources/injuryDuration.ts` already builds `feat_injury_horizon` -- the plumbing for
  injury features partly exists, so this is the lowest-wiring candidate.
- **Candidate:** `prior_games_missed` (count of Y-1 weeks with `report_status = Out`, or games with 0
  offensive snaps) as a center feature, or a `prior_injury_flag` indicator (missed >= 4 games in Y-1).
- **Why it might be real:** injury-prone players carry availability risk the rank does not price.
  **Why it might be null:** survivorship -- the players in the draftable pool are the ones who stayed
  healthy enough to produce, so Y-1 games-missed may not predict Y.

## Already covered / low novelty (do not re-screen without a new angle)
- `raw_participation`, `raw_snap_count` -> `prior_snap_share` / `prior_route_share` already fitted.
- `raw_combine` -> `feat_player_prospect.athletic_score` already feeds the rookie model; static
  (draft-class), not a season lag, so not a projector feature.
- `raw_college_player_season` -> rookie-model territory, not the returning-player projector.
- `contract_year` -> screened by leave-one-out 2026-09-14: **DROPPED** (contribution +0.0039, floor
  0.0100; docs/decisions.md acceptance block). Removed from the default fit list and the shipped artifact
  regenerated; kept as an --add-features candidate + ext column for later re-admission.
- **Multi-year history** (`prior2_pts`, `prior3_pts`, `hist_ppg_w` -- lags of `feat_player_season` by
  `player_sk`, ladder rung 2, 2026-09-14): screened, **all three REJECT** on the 2012-2020 decision block
  (best `prior2_pts` +0.086 vs floor 0.099; the Marcel blend `hist_ppg_w` +0.062 vs floor 0.190 but
  CONFIRMED on the 2021-2025 holdout, +0.190 vs floor 0.103). Consistent direction, sub-floor size.
  Declared as `--add-features` candidates (`LAG_RATIO`), not defaults. docs/validation.md, rung 2.
- **Nonlinear basis** (`age_sq`, `age_hinge30`, `log_rank` -- derived from age and prior rank in
  `basisFeatures`, ladder rung 4, 2026-09-14): screened, **all three REJECT** with the sign slightly
  against (-0.014 / -0.053 / -0.031 on the decision block). The linear age term and the winsorised rank
  already carry it. Declared as candidates (`BASIS_CENTER`), not defaults. docs/validation.md, rung 4.
- **External projection** (`fftoday_proj` -- FFToday's preseason season projection, `raw_fftoday_proj`
  2008-2026, joined on (season, pos, name_key), a ratio to the rank bucket; ladder rung 7, 2026-09-14):
  **ADMIT** (+0.326 vs floor 0.275 on the decision block; holdout +0.502, 5/5, confirmed) and NOT
  explained by the market rank (`adp` gated the same way: REJECT, -0.007, holdout 0/5). **ADMITTED to the
  defaults 2026-09-14 (owner decision D16)** -- now in `RATIO_FEATURES`; the D13 playoff gate was run and
  is NULL/underpowered at a system already 95.5% playoffs. It makes the board depend on the FFToday
  archive: `node scripts/scrape-fftoday.mjs --season <Y>` each preseason. docs/validation.md, rungs 5+7.
- **Trainer-variant rungs** (not columns; gated by `scripts/gate-variant.mjs`): games-weighted
  shrinkage of the usage ratios (`--shrink-k`) and partial pooling across positions
  (`--pool-dev-mult`), ladder rung 3 -- **both REJECT, both negative on the holdout**. The flags stay,
  default off. docs/validation.md, rung 3.

## Discipline reminders (this repo's, applied to the frontier)
- Screen each candidate against the baseline that would SHIP, on the D13 **playoff** gate, with the
  WS1 effect-size floor and WS4 family-wide FDR -- selection on ~a dozen candidates is a winner's
  curse (checklist item 5), so quote the selection-blind holdout number.
- A new feature that admits is a model change: playoff-gate check + owner sign-off before it ships,
  never a silent code edit to the default lists (D14/D15).
