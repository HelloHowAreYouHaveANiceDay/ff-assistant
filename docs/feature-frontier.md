# Feature frontier -- what the season projector has NOT yet screened (2026-09-14)

The projector (`tools/train_projection.py` + `feat_player_season_ext`) fits a small set of
prior-season workload-share features (`prior_snap_share`, `prior_route_share`,
`prior_carries_per_game`, `prior_carry_share`, `prior_air_yards_share`, `prior_wopr`,
`depth_rank_sep1`, `adp`, `adp_vs_ecr`, `rookie_draft_pick`; indicators `team_changed`,
`contract_year`). Those cover the **workload-share** frontier well. Three signal families in the raw
store are NOT yet screened. This page maps them so the answer to "have we exhausted the features?"
is a list, not a shrug.

**The screening path is now cheap and correct** (do NOT hand-read a pinball delta):
1. Add the prior-season aggregate as a column of `feat_player_season_ext`, anchored at `<season>-09-01`,
   in `src/features/sources/seasonExt.ts` (the one place the ext table is built; leakage-safe by
   construction because everything there is as-of Sep 1 of season Y and reads only Y-1 and earlier).
2. Declare it in `EXT_CENTER` / `EXT_RATIO` / `EXT_INDICATOR` (+ `EXT_ALLOWED` positions) in
   `tools/train_projection.py`. Declared != fitted: it changes NO shipped number until admitted.
3. `ff build-features-ext --seasons 2013-2025`, then screen:
   `node --import tsx scripts/admit-feature.mjs --candidate <col> --seasons 2008-2025`
   (leave-one-out `--remove` for a feature already in the defaults). ~52s for the two nested-CV runs
   on the parallel fold executor. ADMIT only if it clears the `2.9*SE` effect-size floor (WS1).
4. If admitted, it is still a **model change** -- re-check on the D13 playoff gate and get owner
   sign-off before it joins the defaults (the D14/D15 no-silent-model-change rule).

## The three unscreened families, ranked

### P1 -- Advanced efficiency lags (NGS). Highest signal, moderate wiring.
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

### P2 -- QB-change flag. Named candidate; full coverage; leakage-careful.
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

### P3 -- Durability / prior-season availability. Good coverage, cheapest (partly built).
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
- `contract_year` -> screened by leave-one-out 2026-09-14: **DROP** (contribution +0.0039, floor
  0.0100; docs/decisions.md acceptance block). A recommendation to remove it is open with the owner.

## Discipline reminders (this repo's, applied to the frontier)
- Screen each candidate against the baseline that would SHIP, on the D13 **playoff** gate, with the
  WS1 effect-size floor and WS4 family-wide FDR -- selection on ~a dozen candidates is a winner's
  curse (checklist item 5), so quote the selection-blind holdout number.
- A new feature that admits is a model change: playoff-gate check + owner sign-off before it ships,
  never a silent code edit to the default lists (D14/D15).
