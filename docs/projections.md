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

## Data (all nflverse, independent of ESPN)
- **season** -- `data/points.csv` from `tools/build_projections.py` (current FantasyPros redraft
  ranks -> historical points-by-rank curve; forward-looking, our own).
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
