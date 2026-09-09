# The Projection Layer (shared spine)

One module (`src/projections.ts`) produces OUR projections at three horizons -- the spine that
feeds BOTH the draft and in-season. Independent of ESPN/consensus, which is the measured edge
(docs/edges.md: your own projection is worth ~+12 championship pts even at equal accuracy).

## Interface
```
season(name)              -> full-season pts     (draft values: ff values)
week(name, pos, opp?)     -> one week's pts      (lineups: per-game x defense-vs-position)
ros(name, gamesRemaining) -> rest-of-season pts  (waivers / trades / keep-cut)
all()                     -> the player table
```
`makeProjections({ seasonPoints, defRatings, gamesPerSeason })` is pure/testable;
`loadProjections(pointsCsv, defCsv)` loads from the CSVs the tools build. Demo: `ff project
"Bijan Robinson" --vs KC`.

## The season curve is a CONDITIONAL EXPECTATION, not an order statistic (2026-09-08)

`ff projections` builds `data/points.csv` by looking each player's ECR rank up in a curve. Which
curve is the load-bearing choice, and it was wrong until 2026-09-08.

- **order statistic** (what shipped before, still reachable via `--curve orderstat`): the mean season
  of the k-th best FINISHER. That is by construction the best of everyone who could have finished
  there, so it carries the winner's luck of whoever won the slot.
- **conditional** (the default): `E[points | this player enters ranked k]` -- the average over
  everyone who entered at that rank, busts included.

They differ by 20-35% at the top, and the error concentrates where a dollar is most expensive. VOR of
the #1 player, which is the number the whole auction book is scaled from: QB 169 -> 90, RB 203 -> 135,
WR 182 -> 101, TE 134 -> 89. See `docs/validation.md` and `scripts/curve-report.mjs`.

The curve took its **shape** from the prior-year-finish conditional (25 season pairs, n 50-130 per
rank -- stable, but conditioned on the wrong variable) and its **level** from the preseason-ECR
conditional (the variable the board is actually indexed by, but only six seasons and too thin to take
a shape from), then made monotone non-increasing.

Known bias, stated rather than buried: the ECR half can only score players who actually posted a
season, so a ranked player who never played is a hidden zero that gets dropped. That biases the level
UP, making the correction conservative.

## THOSE CHOICES ARE NOW SELECTED BY THE EVALUATION, NOT SET HERE (Phase 2b, 2026-09-08)

Everything in the paragraph above -- the window width, the monotone repair, the ECR level rescale,
and whether the linear stage multiplies the curve or adds to it -- was four hand-made constants
compiled into the feature builder, where no evaluation could reach them. They are now
HYPERPARAMETERS of `tools/train_projection.py`, selected PER POSITION by forward-chaining inner
cross-validation on pinball loss (4 windows x monotone on/off x 3 level weights x ratio/offset).

Forward chaining, not a shuffled k-fold, and it is not fastidiousness: a curve is fitted on season
pairs, so a random split lets a fold's curve be built from seasons AFTER the one it is scoring --
lookahead moved one level up, into the model, where no data-level check can see it. For the same
reason `--holdout-season Y` trains on seasons strictly BEFORE Y rather than "every season except Y".

The selected curve travels ON the artifact (`base: "artifact_curve"`), because a curve chosen inside
the fold and then not shipped would mean the board reads whatever recipe the feature builder happens
to hold and the selection changed nothing. `loadArtifact` refuses an artifact that declares one
without the other.

**THE ECR LEVEL CORRECTION IS NEVER SELECTED** -- not once, at any position, in any of the fourteen
outer folds. It shipped for six months as half of the conditional curve and, given the choice, the
evaluation declines it every time. The shipped 2026 artifact is `offset` form with windows QB 2 /
RB 1 / WR 2 / TE 1 / K 3 / DST 1 and level weight 0 throughout. The windows are NOT stable across
folds and should not be read as facts about positions; see docs/validation.md.

**The multiplicative stage is retired.** `age-curve.json` and `opportunity-model.json` were fitted
outside every fold, by their own scripts, against their own curves -- and the opportunity amplitudes
against a curve that had seen the future (defect D1). A model that reaches for a fitted file on disk
cannot be cross-validated, because it is the same file in every fold. Age is now a coefficient of the
trainer and usage is a ratio to its rank bucket's mean over training seasons only; the two files stay
on disk for the record and NOTHING reads them.

**Quantiles are fitted where they are scored.** Phase 2a fitted p10/p50/p90 on ranks 1-36 and scored
them on everything, and reported the resulting 0.614 coverage as a property of the model; it was a
property of the experiment. They are now fitted over ranks 1-60 with rank in the design, and the rank
feature is winsorised at 60 -- past which 42% of the store's scored rows live, and where an
unwinsorised coefficient was being extrapolated ten standard deviations beyond anything it saw.

## The projection is produced by an ARTIFACT, and one projector serves both callers (2026-09-08)

`project()` no longer looks the curve up and multiplies factors in. It loads
`data/projection-artifact.json`, calls `src/model/projector.ts:projectSeason`, and writes
`data/points.csv`. The backtest calls the SAME function with a different rank basis. Before this,
the board and the backtest each applied the age and opportunity multipliers themselves, a thousand
lines apart and with slightly different arguments -- two implementations of "the projection", one of
which was the thing being validated and the other the thing being shipped.

- **The projector is PURE.** No file reads, no network, no clock. That is what makes the two callers
  testable against each other: a test of "identical inputs" is a fiction if either side can reach
  for a file.
- **The multipliers live in the artifact's `multiplicative` stage**, so there is exactly one place
  they are applied. A trained artifact that regresses on age declares an EMPTY stage, because
  declaring the age multiplier as well would apply age twice -- and 0.9 squared is 0.81, which is a
  perfectly plausible projection with no symptom.
- **`project()` FAILS LOUDLY without an artifact** rather than falling back to a bare curve. A silent
  fallback is indistinguishable from a working model at every place anyone looks.
- **The rank basis is named, not implicit.** The board indexes at preseason consensus rank (the
  variable the auction is priced against); the backtest indexes at prior-year finish rank, because
  the FantasyPros archive only begins in 2020.

`points.csv` gains `p10,p50,p90`, appended AFTER `player_sk` -- roughly fifty readers destructure the
leading columns positionally, so a new column at the end is invisible and one in the middle would
shift every value they read.

### Which artifact ships, and why

Two are producible:

- **curve-only** (`ff build-artifact --curve-only`) -- every non-intercept coefficient zero, the two
  shipped multipliers in the multiplicative stage, quantile heads from the empirical quantiles of
  `actual / curve` on ranks 1-36. It reproduces the pre-2026-09-08 board exactly.
- **trained** (`uv run --with scikit-learn --with numpy tools/train_projection.py`) -- ridge on the
  RATIO of actual to curve, with age, usage relative to the rank bucket, team change, prior games and
  draft capital, plus pinball-loss quantile heads.

**The TRAINED artifact ships** (Phase 2b, confirmed after the Phase 2c rekey). It passed the
pre-registered P5 gate -- nested-CV RMSE 54.17 against curve-only's 55.54, pinball 12.31 against
13.16, and coverage 0.759 inside [0.75, 0.85] with every rank band inside [0.70, 0.90]. The
curve-only artifact remains producible and reproduces the pre-2026-09-08 board exactly; it is the
floor that would ship if a future trained artifact failed the gate. (This paragraph said the opposite
until Phase 2d: it was written when the trained artifact failed on coverage in Phase 2a and was never
updated when Phase 2b's re-fit passed. A stale claim in a doc is a claim like any other.) See
`docs/validation.md`, Phases 2a-2c.

### The train/serve contract

The artifact carries a **golden block**: five fixture feature rows together with the TRAINER'S OWN
predictions for them. The TypeScript loader recomputes them and REFUSES the artifact if the two
disagree by more than 1e-6. `featureValue()` exists in both Python and TypeScript deliberately --
that is not duplication to refactor away, it is what makes the comparison mean anything. A producer
that ships its own validator grades its own homework and passes forever while every consumer rejects
its output; this repo has that scar already.

The loader also refuses an artifact naming a feature it cannot compute, missing a quantile head, or
carrying a coefficient for an undeclared feature. Each of those degrades, without the guard, to "that
coefficient contributes zero" -- a slightly different projection and no error at all.

## The feature screen, and what it had never been able to see (Phase 2d, 2026-09-09)

`scripts/feature-sweep.mjs` screens every derivable candidate against the SHIPPED projector's
per-fold residuals, with BH-FDR control over the whole family and two controls -- a seeded random
column that must NOT survive and `age`, already shipped, that must be detected against the bare
curve. Both behaved.

Phase 2d added the `feat_player_season_ext` columns to it and found **two defects in the screen
itself**, both of the same shape: a candidate that never reached a test, reported identically to a
candidate that was tested and measured nothing.

1. **The distinct-value floor was 8**, which silently excluded every BINARY candidate the sweep has
   ever derived. Spearman is well defined with ties and the Fisher-z approximation is ample at
   n > 150; a two-valued column is a legitimate candidate, not a degenerate one. Lowering the floor to
   2 (only a genuinely constant column has nothing to correlate) surfaced **the two strongest
   candidates in the entire sweep** -- `contract_year` at rho -0.124 and `depth_rank_sep1` at
   -0.186, against the previous best of +0.105 -- plus `changedTeam` and `divShare`.
2. **`player_sk` is TEXT in `feat_player_season` and INTEGER in `feat_player_season_ext`**, so a
   strict-equality lookup returned nothing for every player. The other extension columns joined fine
   because a template-literal key coerces both sides; only the ADP-versus-ECR derivation used `===`,
   and it produced 0 rows while looking exactly like a feature that measured nothing.

The sweep now prints a **NOT SCREENED** block naming every candidate that never reached a test and
why. That block is the deliverable, not a diagnostic: "it did not survive" is a statement about a
test that ran, and settling a pre-registered prediction with a measurement that never happened is
precisely the failure this repo keeps finding in other people's work and its own.

Three candidates still reach no test, and two of them are structural rather than fixable:

- `injury_status_sep1` is **100% NULL** in the extension table -- 0 of 8,021 rows.
- `rookieDraftPick` / `rookieDraftRound` have **0 rows by construction**: the residual universe is
  players with a prior-season finish rank, and a rookie has none. The owner's question about rookie
  draft capital cannot be answered by this screen at all, and the honest answer is that, not a null.

### Survivors, and the admission trace (Phase 2d)

Screened against 5,305 out-of-sample errors over 16 seasons, 101 candidates, BH-FDR at 0.10.
Sixteen survived; clustered by mutual correlation they are **11 independent candidates**:

| # | cluster | scope | rho vs shipped | admissible today? |
|---|---|---|---|---|
| 1 | `depth_rank_sep1` | all | **-0.186** | yes -- extension table |
| 2 | `contract_year` | all | **-0.124** | yes -- extension table |
| 3 | `passAirYards` | QB | +0.105 | no -- not in `feat_player_season` |
| 4 | `epaPass`, `teamPassEpa`, `teamYards` | QB / all | +0.100 | no |
| 5 | `primetimeShare`, `offSundayShare` | all | +0.061 | no |
| 6 | `adot` | WR/TE | +0.058 | no |
| 7 | `divShare`, `rookieSeason`, `birthYear` | all | +0.049 | no |
| 8 | `tdPerYard` | all | -0.047 | no |
| 9 | `changedTeam` | all | -0.040 | already fitted as `team_changed` |
| 10 | `avgTemp` | all | -0.036 | no |
| 11 | `twoPt` | all | -0.035 | no |

Clusters 3-8 and 10-11 are the twelve Phase-2a survivors, and they remain unfitted for a mechanical
reason rather than a judgement: the sweep derives them from the nflverse feeds in its own process,
and none of them is a column of `feat_player_season`. Admitting one means adding it to
`src/features/build.ts`, rebuilding the feature table, and then running the admission below. That is
the next bounded job and it is **not done here**.

Clusters 1 and 2 are extension-table columns and were admitted **one at a time, in survivor order**,
each re-measured under the full nested evaluation (`ff evaluate-projection --seasons 2008-2025`,
`FF_ADD_FEATURES=` to select) rather than on the residuals it was screened against. Keep-rule,
pre-registered: pooled CRPS improves AND coverage stays inside the band.

| step | features | RMSE | pinball | coverage | per band | verdict |
|---|---|---|---|---|---|---|
| baseline | Phase 2c's nine | 54.17 | 12.31 | 0.759 | all in | -- |
| +1 | `depth_rank_sep1` | **52.79** | **12.03** | 0.761 | all in | **ADMIT** |
| +2 | `+ contract_year` | 52.79 | **12.02** | 0.760 | all in | **ADMIT** |

Per position, the pooled out-of-sample RMSE with both admitted against the baseline: **QB 76.8 vs
82.4**, RB 61.9 vs 62.4, WR 49.7 vs 49.6, TE 36.5 vs 36.9. Almost all of the gain is at quarterback,
which is where a September depth chart says the most -- it is the position where a starter is a
starter and a backup scores nothing, and the curve indexed on last year's finish cannot see a job
change.

**A caveat that belongs beside the second row rather than in a footnote.** `contract_year` clears the
rule by 0.01 of pinball with RMSE unchanged and coverage a thousandth worse. It is admitted by the
letter of a rule that has no effect-size floor, and it is recorded that way rather than presented as
a win. A keep/drop rule with no minimum effect will eventually admit noise; this is the first
candidate to sit close enough to say so out loud.

**What it did to the board** (2026, 523 players, same store, artifact rebuilt with both):

| | before | after |
|---|---|---|
| top-12 composition | 12 QB | 11 QB + Bijan Robinson (RB) |
| startable-tier points share, QB | 18.4% | 17.8% |
| startable-tier points share, WR | 31.8% | 32.5% |
| value-book dollar share, QB | 16.4% | **16.7%** |
| value-book dollar share, WR | 37.9% | **41.0%** |
| value-book dollar share, RB | 32.5% | **29.3%** |

The Phase 2c value finding was that the book allocates ~17% of the room to quarterback against a room
maximum of 11.2%. **The admitted features do not close that gap** -- the QB dollar share moves the
wrong way, 16.4% to 16.7%. As instructed, no positional multiplier is added: the finding is reported
and the mismatch stands.

The larger move is a **3-point reallocation from RB to WR**, which is not something either admitted
feature was screened for and is not validated by anything in this section. The championship backtest
is the arbiter of a value change, and the flagless arbiter does not read this artifact (it projects
from actuals), so nothing here has been through it. Anyone acting on the new board should run
`backtest --projection artifact --artifact-dir <per-fold artifacts>` first.

## Data (all nflverse, independent of ESPN)
- **season** -- `data/points.csv` from `ff projections` (current FantasyPros redraft ranks -> the
  CONDITIONAL points-by-rank curve above; forward-looking, our own).
- **defense-vs-position** -- `data/def-ratings.csv` from `tools/build_def_ratings.py` (each team's
  pts allowed to each position vs league avg, latest season, as priors).
- upgrade path: multi-source consensus (ffanalytics) for `season`; live-updating weekly/ROS once
  the season starts.

## Calibration -- what actually moves weekly accuracy (validate_matchup.py, 57k player-weeks 2014-24)
- Player TALENT (season per-game) alone: corr 0.717 with actual weekly.
- + defense-vs-position matchup: corr 0.730 (**only +0.013**), residual sd 4.93 -> 4.83.

So the matchup model is a small real edge; **the big weekly edge is EXECUTION, not projection
finesse** -- start your startable studs, bench anyone on a bye or ruled OUT. The lineup optimizer
gets most of its value from AVAILABILITY (which it enforces at lineup time), a little from the
matchup mult here. Don't over-invest in a fancy weekly model; do make sure the agent never sets a
bad lineup and works the waiver wire.

## Consumers
- **Draft:** `ff values` turns `season()` into auction $ (VOR->$). (Biggest proven edge.)
- **In-season lineup optimizer:** `week(name, pos, opp)` ranks each roster slot; start the best
  AVAILABLE (bye/OUT filtered). Backtest-validated (`ff backtest --our-weekly-noise`).
- **Waivers/trades:** `ros()` values free agents / both sides of a trade. (Next.)

Same independent projection, every horizon -- sharpen it once, and the draft AND the season both win.
