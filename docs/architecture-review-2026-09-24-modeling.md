# Architecture review -- modeling, simulation, feature engineering (2026-09-24)

Read-only review of `main` @ d25582d. Four parallel reviewers (preseason projection/value, weekly model,
simulation/arbiter, feature engineering); every BLOCKER below was then re-checked by hand against the
code or the live store (`data/ff.db`, read-only). Nothing was edited, trained or backtested. The
2026-09-16 review covered the multi-league storage/platform seams; nothing here repeats it.

Severity: **BLOCKER** = silently wrong numbers today. **SHOULD-FIX** = structural risk / duplication that
will produce wrong numbers later, or a measurement that cannot see what it claims to. **NIT** = hygiene.
"Verified" = re-checked by hand in this session; "unverified" = reviewer inference, magnitude unmeasured.

Charter note: several fixes below MOVE A SHIPPED NUMBER (golden re-pin, served weekly rows, season odds).
Per charter rule 1 each of those is a stop-and-confirm item -- fix to a temp path, gate, present
before/after, then swap. This document is the finding list, not a sign-off.

---

## 0. The five cross-cutting themes

1. **Train/serve skew is the dominant failure class.** The same column name means different things at fit
   time and serve time in at least six places (rank basis, live team, unresolved identity -> 0, injury
   vocabulary, augmentation rates, two `_ext` columns). The golden-row checks cannot catch any of them:
   they prove the *arithmetic* crosses the Python/TS seam, not that the *inputs* are built the same way.
2. **The gates do not measure what ships.** The flagless arbiter projects from prior-year actuals x two
   "retired" all-season multiplier files, not the GBM projector the board serves; its baseline hands us
   a noise-free projection against a noised room (96% playoff, ~4pp headroom, +/-3pp tolerance); the
   live weekly scorecard scores a different metric on a different population than the weekly gate.
3. **League arithmetic is re-implemented per consumer.** Replacement level x5, games-per-season x6+,
   `gauss` x4, playoff bracket x2, `simulateSeasons` option bundles x4, weekly eval harness x2, name-key
   joins in 5+ places -- with measurably different definitions.
4. **Uncertainty is modeled four separate times and none of them is the model's.** Preseason quantile heads
   are fitted and then ignored (board band = `spread.ts` bootstrap; sim = hardcoded `OUR_SD_BAND`); the
   season sim uses its own bootstrap/parametric draws; winprob rebuilds each weekly distribution from
   three quantiles and moves the mean by -19%..+7%.
5. **Contracts are retyped by hand, and the registries are descriptive, not executable.** Feature lists
   exist separately in TS and in three Python trainers; `src/lineage/registry.ts` has drifted and nothing
   reads it; the model registry contradicts `WEEKLY_SERVE`; `schema: 2` has absorbed four meaning changes;
   the weekly trainer's DEFAULT flags overwrite the served artifact with a different model.

What is sound and should be preserved: `loadArtifact`'s refusal-by-default validation + golden rows;
walk-forward, curve-in-fold training; the `--artifact-dir` holdout guard; `rng.ts` identity-keyed draws
in the season sim; write-once scorecard semantics; the decision log discipline.

---

## 1. BLOCKERS (silently wrong today)

### Live serve (in-season, affects this week's advice)

- **B1. Live weekly rows carry the Sept-1 team all season.** `buildForwardInto` takes `p.team` from
  `feat_player_season` (`src/weekly/features.ts:1302`, used every week at `:1395`), which is pinned to
  Sept-1 since the 09-23 fix (`src/features/build.ts:411-417`); the historical builder uses a running
  team (`build.ts:668-676`). **Verified:** `player.nfl_team` = NYJ for Blake Grupe, CLE for Jaleel
  McLaughlin; every 2026 row in `feat_player_week_model` says IND / DEN. Opponent, spread/total, rest
  days, the `opp_*` block and `teammates_out` all inherit it (13 players measured by the reviewer).
- **B2. Unresolved identity is written as "healthy", not "missing".** `buildLiveWeekContextInto` joins
  `player_status`/news by `name_key` and drops names flagged ambiguous (`weekContext.ts:535-541`); the
  week is still treated as reported (`weekly/features.ts:232-240`), so `inj_questionable` becomes 0.
  **Verified:** Justin Jefferson, Lamar Jackson, Michael Pittman Jr. -- 2026 wk2-3 rows have
  `depth_rank=NULL, inj_questionable=0, in_population=1`; Pittman is `Questionable (Foot)` in
  `player_status` right now. Historical rows for the same men resolve by gsis id (`depth_rank=1`).
  `player_status` has no ESPN/gsis id column and holds a single current snapshot (no history).
- **B3. Season-sim playoff bracket advances the week per MATCHUP, not per round.** `season.ts:1067-1069`:
  `poRound++` inside `beat()`, `gameWeek = opts.weeks + poRound`, and `playoffWeek.clear()` on every call
  (so the "same score per round" cache is dead). In a 6-7 team bracket games land on weeks +1..+6;
  `missedWeeks` only covers `weeks + playoffWeekCount` (`knownInjury.ts:113`), so a season-ending
  injured player is healthy again from bracket game 4. **Verified** (code). `backtest.ts:60-73` already
  does this right (`wk++` per round) -- reuse it.
- **B4. Winprob's sampler mean is not the model's mean.** `quantileFn` (`winprob.ts:117-131`) rebuilds
  each distribution from p10/p50/p90 + pZero plus a synthetic upper step, discarding the 7-level mixture.
  Reviewer integration over the artifact's golden rows: RB 17.63 -> 18.59 (+5%), TE 4.34 -> 3.50 (-19%),
  RB 10.23 -> 10.92 (+7%). Separately, 12/2,285 2026 skill rows have mean > p90 (independent heads).
  The EP lineup ranks on the mean while `epWinPct` samples the band, so the two objectives disagree most
  exactly on those players. Code verified; magnitudes from the reviewer's probe.
- **B5 (probable). Live context columns come from different sources than training.** Train: nflverse
  dated Friday reports + nflverse depth; serve: ESPN `injury_status` via `espnStatusToReport`, escalated
  by headlines, ESPN `depth_order`, snapshot at build time not kickoff-2d (`weekContext.ts:155-196` vs
  `:543-566`). No agreement measurement exists. Magnitude unverified -- measure on a settled week.

### Measurement (the arbiter and the audits)

- **B6. The golden arbiter does not run the shipped projector, and it reads two all-season fits.**
  `data/golden.json` `baseFlags` has no `--projection`, so `projMode="actuals"` (`ff.ts:2589`); the age
  and opportunity multipliers load by default whenever their files exist (`ff.ts:2545-2558`) and are
  applied at `:2925-2939`. **Verified:** `age-curve.json.fittedFrom = "data/history-points.csv"` (all
  seasons), `opportunity-model.json.season = 2025` -- one fit applied to 1999-2024, i.e. look-ahead.
  `models.ts:442,461` says both are "RETIRED ... nothing reads this file"; `ff.ts:2918` says "Off by
  default"; `ff.ts:2545` says "ON BY DEFAULT". Consequence: the D13 golden (96.0 / 38.5) gates a
  projection the board never serves, with a small in-sample tailwind. Magnitude unverified (the
  multipliers are clamped 0.7-1.35 with ~0.01 R^2 lift, so likely small -- but the arbiter cannot
  currently gate a projector change at all).
- **B7. Train/serve rank-basis skew in the preseason projector.** The trainer keys the curve and every
  ratio-feature bucket on `prior_pos_rank` (`train_projection.py:683` `_rank = prior_pos_rank`; `:564`,
  `:717`); the board serves `rankBasis: "ecr-else-prior"` (`src/model/features.ts:306`, consumed at
  `projector.ts:218`). Reviewer: 293/425 2026 players differ by >= one bucket width; 98/523 have no prior
  rank (never in training, imputed). Golden rows always set rank == prior rank so cannot see it. The
  weekly season-line anchor inherits the skew (`weekly/features.ts:323-325`: trained on backtest-path
  lines, served on board-path lines). Code verified; out-of-sample cost unmeasured (possible partial
  explanation of D21's "anti-predictive at QB" -- unverified).
- **B8. The live weekly scorecard's CRPS uses the mean as the median.** `scorecard.ts:1015`
  `p50: f.value` -- `scorecard_prediction` stores no p50/pZero. For a two-part row mean and median
  differ grossly (TE golden: mean 4.34, p50 0). **Verified.** It also snapshots every row with a season
  line (~510/wk) instead of `in_population` (~300), against a third definition of the floor
  (`scorecard.ts:368,441` vs `evaluate.ts:831`). D11/D17/D27 cite this scorecard as the continuous audit;
  it is measuring something else.
- **B9. `--max-kdst` reprices the whole room.** The `vor` bot book is `computeValues(..., cfg.maxKDst)`
  with OUR cfg (`sim.ts:394`). **Verified.** Any measured effect of that lever is "every bot changed";
  `lever-connected.mjs` would call it connected for the wrong reason.

---

## 2. SHOULD-FIX, by slice

### Arbiter / gate power
- **G1. The baseline is structurally saturated.** Under `--no-lookahead`, `ourSd = 0` (`ff.ts:2967`) while
  the room sees the same numbers x one shared N(0, 0.30) draw (`backtest.ts:203`), and our weekly
  lineup uses the same clean estimate (`backtest.ts:248`). We are a noise-free observer of the room's
  own information -> 96% playoffs in a 7-of-16 field. The gate can mostly only fail a lever. Give us an
  error of the room's scale, partly correlated with it. (**Verified** code.)
- **G2. Tolerance >> noise.** The flagless run is deterministic (CRN), Monte-Carlo SE ~0.3pp, yet
  `consistencyOK` (`cpcv.mjs:243`) allows +/-3pp; the treatment verdict does not set the exit code. Pin
  the per-season line exactly (it reproduces byte-for-byte) and make the treatment verdict fail.
- **G3. CRN holds only partly in the auction.** Bot bid noise is one sequential stream, drawn only for
  eligible/affordable bots (`sim.ts:363, 489-491, 540-554`, `managers.ts:79,107`), so once our bids
  change a winner every later draw shifts. Paired tests stay valid but lose power; headers overclaim.
  Key bot noise through `rng.ts draw(seed, trial, player, seat, purpose)`.
- **G4. Run-changing env vars are not in the ledger hash.** `FF_STRATEGY`, `FF_RANK_DECAY`, `FF_V3_*`,
  `FF_SIM_*` change results; neither `config_hash` (`cpcv.mjs:298`) nor `fingerprintDraftArbiter` reads
  `process.env`.
- **G5. "Survive both books" is convention.** The gate runs `vor` only (`ff.ts:2515`); add a `rank` arm.
- **G6. Rookie survivorship in the backtest.** Only rookies who appear in season Y's actuals enter the
  pool (`ff.ts:2946-2956`); `fitRookieCurve` is E[pts | played] (`rookieModel.ts:24`); the board prices
  rookies through the GBM on imputed features instead -- two rookie models. Measured neutral overall,
  which bounds but does not remove it.

### Simulation core
- **S1. Four `simulateSeasons` option builders** (`simContext.ts:530`, `simWorker.ts run()`,
  `season-calibration.mjs:635/792/870`); `simWorker` drops the D18 seed, `priorWeeks`, seeding,
  divisions, reseed, `playoffWeekCount`, knownInjury -- and `scripts/waiver-sweep.mjs:119` uses it (so
  CLAUDE.md's "simPool is used by nothing" is stale). `season-calibration.mjs:438-450` holds a declared
  "SECOND COPY of the blend rule" that has already once turned a 1.9pp effect into a null.
- **S2. Two in-season uncertainty models.** Season sim: bootstrap around the ROS level, playoff weeks
  always parametric (`season.ts:926`), no level draw carried into the playoffs in bootstrap mode
  (`:739`). Winprob/lineup: the calibrated D32 weekly bands. Title odds come from a different generative
  model than the regular season -- a candidate contributor to P16 (unverified).
- **S3. Duplicated primitives:** `gauss` x4 (`sim.ts:35`, `backtest.ts:34`, `draftModel.ts:268`,
  `season.ts:330`); brackets x2; three RNG schemes (sequential mulberry32, `rng.ts`, winprob `hash3`);
  bots score via `weekScore`, we via `optimalLineup` inside the same arbiter (equal for ESPN only);
  FLEX/BE literals in `sim.ts:593, 423-428, 299`, `backtest.ts:123` (no `flexOk`), in-season backtests
  `lineup.ts:108`, `winprobLineup.ts:272`.

### Preseason projection / value
- **P1. Replacement level x5 with different definitions:** `values.ts:258` (laminar, superflex-aware,
  shipped); `rank.ts:21` (hardcoded RB/WR/TE); `sim.ts:282` (even /3 flex split -- the rule `values.ts`
  measured as wrong -- literal "FLEX", +1 spare, /17); `simContext.ts:489-506` (2nd-best FA /17);
  `lineupMarginal.ts:149-230` (re-implements `baselines()`).
- **P2. Games per season.** `rookieModel.ts:52` and `weekly/features.ts:329` use 16/17 by era;
  `backtest.ts:122,248,282,309` and `sim.ts:281` always /17 on 1999-2020 16-game totals; `NFL_WEEKS=17`
  redeclared in `copilot.ts:78`, `league/index.ts:20`, `league/espn.ts:34`, `simContext.ts:493`.
- **P3. Fitted preseason quantile heads feed nothing.** `assemble.ts:243` reads name/pos/points only;
  p10/p90 overwritten by `spread.ts` (`assemble.ts:400-414`); sim uses `OUR_SD_BAND` (`sim.ts:189`).
  No crossing guard (1/523 rows p10 > p50 in `points.csv`).
- **P4. The embargo guard is swallowed.** `evaluate.ts:258` loads the artifact, the embargo throw at
  `:271` is caught at `:276` into a note, and `:279` scores the leaked artifact; `trainerOk` stays true
  for `admit-feature.mjs:93` / `gate-variant.mjs:50`.
- **P5. Feature set decided by coverage, not declared.** `build_specs` silently drops any default with
  < 200 non-null rows (`train_projection.py:596`); fold artifacts 2012/2013 lack `depth_rank_sep1` while
  the shipped one has it. A thin format store would ship a different model with no error.
- **P6 (latent). `prior_air_yards_share` / `prior_wopr`** come from `_ext` in Python
  (`train_projection.py:417-423`) and from the base table in TS (`model/features.ts:96-102,360-361`).
  Not in the shipped artifact today; would skew on admission.

### Weekly model
- **W1. Load failures are swallowed and mislabelled.** `tryLoad` (`streamingServe.ts:266`) catches a
  golden-check refusal -> null; QB-TE silently fall to the ROS blend while `weeklyServeAssumption()`
  still names `weekly-artifact.json`. The population-hash guard (`models.ts:58`) runs only in
  `ff models`.
- **W2. Trainer defaults overwrite the served artifact with a different model.** `train_weekly.py`
  defaults: `--features all`, `--zero-model quantile`, `--learner linear`,
  `--out data/weekly-artifact.json` (**verified**). The loader accepts it; `fittedFrom` records no flags.
  The D23 `rz_share_td` trap is still armed.
- **W3. Registry contradicts the serve table.** `models.ts:210-300` calls the K-only floor "THE SHIPPED
  weekly model", the served challenger "not served", streaming "ships at ALL SIX" (ships nowhere);
  `dst-stream-artifact.json` has no entry and no `populationHash`; `agent.ts:707` tells the agent the
  same stale story. Constant names are inverted (`SHIPPED_WEEKLY_ARTIFACT` = K floor).
- **W4. Two eval harnesses, neither evaluates what is served.** `evaluate.ts` / `streamingEvaluate.ts`
  duplicate `loadSeason`, `quantile`, `measureSpread`, baselines; K/DST are gated on challenger heads but
  served from the floor / the Python-only-gated DST model. Nothing scores `WEEKLY_SERVE` as a whole.
- **W5. Missingness-augmentation rates are stale.** `MASK_DROP_P` masks availability at 0.97
  ("gone from 2025") -- D22 restored it to 1.00 coverage; ECR masked at 0.97 while live coverage is
  0.84-0.90 (`train_weekly.py:275`). Derive from `liveWeekCoverage` at fit time; record on the artifact.
- **W6. Name-key vs id joins for the same projections.** Live lineup joins on `lineupNameKey` and keeps
  the higher mean on collision (`copilotStore.ts:415-420`); backtest joins on `player_sk`
  (`backtest/context.ts:142`). Already failed once (4 DSTs, `copilot.ts:641-657`).
- **W7. `schema: 2` does not version meaning.** `boosted`, `rowFilter`, `bandCalibration`,
  `populationHash` all added under it; loader ignores unknown fields. The stale packaged
  `app/engine/ff.cjs` (09-16) would serve uncalibrated bands. Add a `requires: [...]` capability list.

### Feature engineering
- **F1. Layering is partly bypassed.** `build.ts` fetches nflverse player-week / draft / schedules over
  HTTP and reads `history-*.csv` directly (`build.ts:142,295,598,648`); schedules come from both the
  nflverse CSV and `raw_nfl_game`. A failed fetch returns an empty map -> NULL `prior_fd`/`prior_ts`/
  `draft_round` for a whole season, visible only in a count.
- **F2. Two identity resolvers + name joins.** `skResolve.ts` and `features/sources/resolve.ts`; FFToday
  (a served feature) keys `(season, name_key, pos)` and joins on name (`model/features.ts:230-240`,
  `train_projection.py:363`; backtest joins on PRIOR position `:405`), 7-10%/season unmatched -> silent
  imputed value; weekly ECR and DFS salary also join by name (`weekly/features.ts:736, 986`).
- **F3. Per-format stores carry stale half-PPR opponent features.** `build-format-features.mjs` never
  rebuilds `feat_player_week_stream`; the Yahoo store's `opp_pa_pos` is byte-identical to the half-PPR
  store while its points are 35% higher. Unused by current format artifacts; wrong units for any
  stream/DST model trained there.
- **F4. Lineage registry is display-only and has drifted** (`src/lineage/registry.ts` omits
  `raw_depth_chart`, `raw_pbp_player_week`, `raw_dfs_salary`, `ranking_history`,
  `feat_player_week_stream`, the HTTP reads); no trainer/server reads it.
- **F5. Feature lists retyped by hand** in TS (`WEEKLY_FEATURE_FIELDS`, `CONTEXT_FIELDS`,
  `STREAM_FIELDS`, `weekModelInsertSql`, `ExtSeasonRow`/`EMPTY_EXT`) and Python (`SELECT_COLS`, `CENTER`,
  `INDICATOR`, `STREAM_COLS`, `STREAM_CENTER`, `FEATS`, `CENTER_FEATURES`, `EXT_CENTER`, `EXT_RATIO`,
  `LAG_RATIO`, `BASIS_CENTER`), plus constants copied across the seam (`LAG_WEIGHTS`, `AGE_PIVOT`,
  `POPULATION_DEPTH`).
- **F6. `depth_rank_sep1` (shipped feature) is built two ways:** training seasons from the nflverse
  weekly week-1 chart (post-Sept-1, min rank); 2025+ from the daily chart as of Sept 1, last value wins
  (`seasonExt.ts:263-282`).
- **F7. Admission tooling:** `admit-feature.mjs` baseline cache keyed only on db path/seasons/position
  (stale across a rebuild or trainer change); the charter's pre-filter (rule 2) is not enforced --
  `prefilter-feature.mjs` + ~6 bespoke `*-prefilter.mjs`, never checked by `admit-feature`/`gate-variant`;
  the weekly track has no standard admission script.

### NITs (abbreviated)
Vestigial `useAge`/`useOpp`/`_curveKind` in `projections.ts:365`; stale "two shipped multipliers"
comments; golden blocks optional (`a.golden?.length`) and thin (5-6 hand rows; weekly fixtures never
carry a non-null `ecr_wk_rank`; the floor's golden rows omit K, its only served position);
`weekly_challenger` scorecard series is byte-identical to `weekly`; `ecrForSeason` reads the wall
clock (`build.ts:222-225`); future live weeks inherit last week's ECR via the 8-day window;
`seed = s+1+yr*1000` collides if `--n >= 1000`; `spread_line` is probably the closing line (unverified).

---

## 3. Target architecture (what fixes the themes, not the instances)

```
LeagueMath (one module, src/draft/leagueMath.ts)
  gamesInSeason(season) | replacementLevel(pool, slots, frame) | flexFill (laminar, slotEligibility)
  isBenchSlot | one playoff bracket (per-ROUND week) | one scoreWeek(optimalLineup) for every team
  -> values, sim, simContext, lineupMarginal, backtest, season, winprob all import; rank.ts deleted.

SimCore
  rng.ts keyed draws everywhere (incl. auction bot noise) | one gauss | buildSimOpts(ctx) used by
  simContext, simWorker, season-calibration.

One uncertainty contract
  Weekly: projection rows carry the FULL quantile grid + pZero; winprob samples the true mixture;
  season sim draws the current/playoff weeks from the same bands, extended by the drawn level.
  Preseason: decide ONE owner of season uncertainty (artifact heads vs spread.ts) and thread it to
  strategyV3/sim, or label the heads eval-only.

Executable feature registry (data/feature-registry.json)
  per column: source tables, as-of rule, id-join key, transform, missing value, scoring-derived?
  TS builders + all Python trainers load column lists from it; lineage graph derived from it;
  build-format-features rebuilds every scoring-derived table; admit-feature refuses a column
  with no pre-filter record.

One weekly row builder
  buildInto + buildForwardInto merged, parameterised by (population, per-week team source, as-of);
  identity only through the staging resolver (ESPN id stored on player_status at ingest);
  unresolved => NULL, asserted in contextFor. Positive control: rebuild a settled 2025 week via the
  forward path and diff against the historical row.

Recipe-on-artifact
  artifact records full trainer flags, feature list, augmentation rates, rank basis, and a
  `requires:[capabilities]` list the loader enforces; trainer refuses to write a served path
  except by reproducing its recipe; registry "served" status derived from WEEKLY_SERVE.

Gates that can fail and measure what ships
  Arbiter base = --projection artifact --artifact-dir <blind folds>; age/opportunity path deleted;
  our projection error at the room's scale; exact per-season pin; two-sided treatment verdict with
  exit code; rank-book arm; FF_* env in the hash. Scorecard stores p50/pZero, filters in_population,
  baselines on the pinned floor; one weekly scoring core that takes a router and scores WEEKLY_SERVE.
```

---

## 4. Suggested order (each numbered item is its own stop-and-confirm where it moves a number)

**P0 -- live serve, before next week's lineup lock**
1. B1 per-week team in the forward builder (positive control: Grupe/McLaughlin rows change; settled-week
   diff vs historical builder).
2. B2 unresolved => NULL (not 0) now; ESPN id on `player_status` next (positive control: Jefferson /
   Pittman wk2-3 rows go NULL/resolved; fault-inject an ambiguous name).
3. B3 per-round bracket week (fault injection: a season-ending player must stay out of every bracket
   game; season odds move -> re-pin with sign-off).
4. B4 carry the grid on the row and sample the mixture; clamp/flag mean>p90.

**P1 -- make the measurements honest (golden re-pins need owner sign-off)**
5. B8 + W4 scorecard metric/population/floor; one scoring core.
6. B6 arbiter on the shipped projector with blind folds; delete the multiplier path; measure the
   before/after delta so the size of the look-ahead is a number, not a guess.
7. B7 measure the board-path out of sample (2020-2025, ECR exists) vs prior-rank path; then pick one
   basis and put it on the artifact.
8. G1/G2/G4/G5/B9 gate power package.
9. B5 live-vs-archive injury/depth agreement on a settled week.

**P2 -- structural (removes the classes)**
10. LeagueMath + SimCore. 11. Executable feature registry + one weekly row builder.
12. Recipe-on-artifact + capability list + registry derived from `WEEKLY_SERVE` (W1-W3, W7, P5).
13. One uncertainty contract (S2, P3).

## 5. Docs to correct once fixes land
`models.ts:442,461` ("nothing reads this file"); `ff.ts:2918` vs `:2545` comments; CLAUDE.md "simPool
is used by nothing" (waiver-sweep uses it); D20 text (season sim DST via `loadWeeklyProjection` -- no
`src/` caller); `agent.ts:707` streaming-serves-six; `copilotStore.ts:392-395`; `projector.ts` header.

---

## 6. Hotfix pass (2026-09-24, same day, owner: "hotfix all the issues now")

Working tree, uncommitted. Every fix below has a test that FAILS when the fix is reverted (fault-injected
by hand) unless marked otherwise. Suite: 1401 tests, 1393 pass, 6 fail -- the SAME 6 store-state failures
the pre-change baseline had (population hashes of the K-floor and streaming artifacts, `raw_dfs_salary`
with no lineage producer, a format store missing `prior_air_yards_share`, `carsonwentz` off the board).

| # | Fix | Where | Verified by |
|---|---|---|---|
| B1 | live weekly rows use a PER-WEEK team: observed team for settled weeks, the CURRENT roster team (resolved via real ids) for weeks not yet played | `forwardTeamAt`, `buildForwardInto` | test/forward-team.test.ts; store diff: 13 movers, 208 rows (Grupe NYJ, McLaughlin CLE) |
| B2 | live status/depth resolved through the `player` row's gsis/espn ids, then (name,pos,team); a man the feed does not cover is written `live-unresolved` and served MISSING, never healthy | `resolvePlayerTable`, `buildLiveWeekContextInto`, `contextFor` | 2 new tests in test/live-week-context.test.ts; Pittman/DJ Moore now Q=1, Jefferson/Jackson/Harrison resolved; 7 uncovered (Travis Hunter among them) |
| B3 | season-sim bracket keyed by ROUND | `season.ts playoffWinner` | test/bracket.test.ts; live title odds move <= 0.6pp, playoff odds identical. NOTE: `knownInjury` has NO production caller (injury-horizon HELD), so the "heals mid-bracket" effect was latent; the live effect was wrong-week byes/draws |
| B4 | winprob samples the projector's FULL mixture grid (served p10/p50/p90 are knots); a caveat names players whose mean head and band disagree by > 25% | `mixtureKnots`, `quantileFn`, `winProbLineup` | 2 tests in test/winprob.test.ts. Median |sampler/served - 1| 13.4% -> 9.3% on 2026 wk4. RESIDUAL (not hotfixable): the MEAN head and QUANTILE heads disagree (Nacua EP 7.9 vs band 13.9; Flowers 21.3 vs 10.9) -- which head to trust needs a held-out measurement |
| B6 | arbiter's age/opportunity multipliers OFF by default (opt-in `--age-curve`/`--opportunity`); banner no longer claims them in artifact mode | `cmdBacktest` | flagless 39.3/96 -> 38.0/96 (below). GATED playoff axis unchanged |
| B7 | MEASURED, no change: board (ECR) basis vs training (prior) basis, blind folds 2020-2025 | scratchpad rank-basis.mts | board basis is BETTER: QB MAE 49.6 vs 52.7 (4/6 seasons), RB 39.8 vs 40.8 (4/6), others tied. Serve path left as is |
| B8 | scorecard freezes p50 + p_zero; scores on the FROZEN median (legacy rows: CRPS withheld, not faked) and only `in_population` rows | `scorecard.ts`, schema.sql | new test in test/weekly-scorecard.test.ts (median, population, legacy). NOT done: the season_line floor is still `lineOnlyArtifactFor`, not the pinned floor |
| B9 | room K/DST cap fixed at `ROOM_MAX_KDST = 2`, independent of our lever | `sim.ts` | test/draft-composition.test.ts (bots-only room identical at maxKDst 2 vs 9) |
| P4 | embargo check outside the try, fatal | `src/model/evaluate.ts` | code reading only (the fold loop shells out to the trainer) |
| P5 | projection trainer names dropped features (stderr, even --quiet) and records `droppedFeatures` + `trainerArgv` | `train_projection.py` | probe: 2008-2011 fit warns `depth_rank_sep1`; 2005-2016 artifact carries the fields and loads in TS |
| W1 | artifact load failures carry a reason (not built vs REFUSED) into `missingWhy` and the lineup `basisNote` | `tryLoadWeeklyArtifact`, `copilotActions` | test/weekly-artifact-load-reason.test.ts (positive control + corrupted golden) |
| W2 | `train_weekly.py` refuses to write a SERVED filename without `--allow-served-overwrite`; records `trainerArgv` | `train_weekly.py` | bare run exits 1; `data/weekly-artifact.json` md5 unchanged |
| W3 | registry `what` text + MCP `lineup_recommend` description match `WEEKLY_SERVE` | `models.ts`, `agent.ts` | text |
| G4 | set `FF_*` env vars enter the arbiter fingerprint (clean env: hash unchanged) | `scripts/lib/deps.mjs` | hash a35a97fa clean / 83d30eba with FF_STRATEGY=v3 / a35a97fa again |
| F7 | admit-feature baseline cache keyed on trainer source + feature-table version | `scripts/admit-feature.mjs` | syntax only (a real run is hours) |
| S1 | waiver-sweep workers run the caller's own `ctx.opts()` | `simWorker.ts`, `waiver-sweep.mjs` | probe: worker reconstruction == `ctx.run` bit-for-bit; old option set differs |

**Live store.** The forward board was rebuilt on `data/ff.db` with the fixed code (backup of the prior
store: session scratchpad `ff-pre-hotfix.db`). **The week-4 scorecard snapshot was frozen at 04:10 UTC,
BEFORE these fixes, and is write-once -- its rows carry the stale team/availability inputs.**

**B6 measurements (flagless = `--full --no-lookahead --inflation --seasons 1999-2024 --n 150`):**
- before: 39.3% titles / 96% playoffs (with the all-season multiplier files).
- after: 38.0% / 96%, per season `2000:33 2001:25 2002:39 2003:55 2004:33 2005:31 2006:49 2007:25
  2008:42 2009:59 2010:41 2011:65 2012:41 2013:45 2014:30 2015:31 2016:25 2017:41 2018:35 2019:37
  2020:37 2021:34 2022:43 2023:27 2024:29`.
- shipped GBM projector (blind d16 folds) vs last-year actuals, 2013-2024 paired: playoffs -0.44pp
  [-2.83, +1.50], titles +2.39pp [-4.22, +8.11] -- indistinguishable. Blind folds exist only for
  2012-2025, so the projector arm cannot yet cover the golden span; building pre-2012 folds is the
  prerequisite for making `--projection artifact` the arbiter's base.

**Awaiting owner sign-off (charter rule 1), NOT applied:**
1. Re-pin `data/golden.json` `titlePct` 38.5 -> 38.0 (context axis only; `playoffPct` 96.0 still holds).
2. G1 gate saturation (our projection error at the room's scale), G2 exact per-season pin + failing
   treatment verdict, G3 keyed auction bot noise, G5 rank-book arm, G6 rookie pool from the draft
   class, P2 games-per-season -- each moves the golden and is a policy change to the arbiter.
3. B4 residual: which weekly head (mean vs quantile grid) to trust -- a held-out measurement first.
4. Structural (section 3): LeagueMath/SimCore, executable feature registry, one weekly row builder,
   recipe-on-artifact + capability list, one uncertainty contract; W5 augmentation rates need a refit.
5. B5 (live vs archive injury vocabulary) cannot be measured until a settled 2026 week has both.
