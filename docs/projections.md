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

**The curve-only artifact is the shipped default.** The trained one beats it on RMSE and pinball
under nested CV but fails the pre-registered p10/p90 coverage gate, and the gate is all three. See
`docs/validation.md`, Phase 2a.

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
