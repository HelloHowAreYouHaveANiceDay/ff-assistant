# M2d -- WHERE THE SEASON SIMULATOR'S DISPERSION IS WRONG, and in which direction (2026-09-16)

> **STATUS UPDATE (2026-09-16, WP16a): the ONE FINDING of section 6 -- `K_u = 1`, the level's own
> prior weight -- was SIGNED OFF AND APPLIED as D28.** The constant is `LEVEL_PRIOR_WEEKS` in
> `src/draft/season.ts`; the before/after gate, the live-surface deltas and the
> `FF_SIM_LEVEL_PRIOR_WEEKS=6` rollback are in `docs/decisions.md` D28. Everything BELOW this line
> is the measurement exactly as it was written, including the sentences that say nothing is applied
> -- they describe the state at the time of the sweep and are left unedited on purpose. The four
> NULLs and the rejected roster-level factor are unchanged and still ship at their swept defaults.

A MEASUREMENT, not a change. Nothing here is applied: every value is passed explicitly through an
env-gated knob that is a no-op at its default, the flagless arbiter reproduces the D25 record
exactly, and the two live surfaces (`copilot-crosscheck --schedule real`, `ff copilot season-odds
--league 462233`) are byte-identical to their recorded post-D25 numbers.

Arbiter: `scripts/season-calibration.mjs`, on a `VACUUM INTO` snapshot of `data/ff.db`
(`--db <snapshot>`; 925 MB, taken 2026-09-16 while other executors were writing the live store),
`--artifact-dir data/fold-artifacts-d16`, `--replacement-frame nfl`, 3000 trials, seed 7,
2018-2025, 114 real team-seasons.

---

## 0. THE PREMISE IS STALE -- and that is the first finding

The task, README ("Known model limits") and `docs/decisions.md` all describe the season simulator as
**over-confident**: playoff Brier 0.2370 against a uniform 0.2451, and a **50-70% predicted band that
realises 46%**. That figure predates BOTH D16 (the boosted projector + FFToday, hence the blind
`data/fold-artifacts-d16` folds) AND D25.1 (the `/17` replacement frame). Re-measured on the current
stack, the preseason arm's reliability table has the opposite sign in the band the claim names:

```
  RELIABILITY, PLAYOFFS -- preseason, current stack (the positive control below)
    bin        n   predicted   observed     gap
    5-15%      2       12.7%       0.0%   -12.7
    15-30%    10       25.1%      20.0%    -5.1
    30-50%    70       40.6%      40.0%    -0.6
    50-70%    32       55.8%      59.4%    +3.6      <- the band the README says realises 46%
```

102 of 114 team-seasons sit in 30-70%, every bin is inside counting noise of its label, and **there
is no bin above 70% at all**. The preseason simulator is not over-confident; it is
**under-RESOLVED** -- its probabilities are squeezed into a narrow interval around the 43.8% base
rate, and within that interval they are honest. The same shape holds in-season, more sharply: at
weeks 4 and 8 the top bin is under-confident by ~10 points (predicted 78.1% -> observed 90.9% at
week 4; predicted 80.3% -> observed 90.6% at week 8).

That reverses the sign of the question. Adding dispersion to a simulator whose predictions are
already too timid moves every probability further toward the base rate -- which is precisely the
uniform shrink the README records as rejected leave-one-season-out, arriving with a mechanism's
credentials. The candidate worth testing is the opposite one.

## 1. PRE-REGISTRATION (written and committed to this file before any sweep was run)

**Hypotheses, in the order I expect them to matter.**

- **(a) Per-player season-LEVEL uncertainty -- the primary candidate, and I expect the improving
  direction to be a DECREASE, not an increase.** In bootstrap mode `projSd` is inert (`season.ts`
  sets `err = 1` whenever `boot`), so the entire preseason level dispersion is the rank-outcome
  pool's own season-total spread, rescaled to our projected mean (`calibration: "scale"` preserves
  the pool's CV). D18 already shrinks this in-season by `sqrt(K/(K+k))`. There was no knob for it at
  PRESEASON, so one is exposed: `FF_SIM_LEVEL_SCALE` (default 1, multiplies the drawn season level's
  deviation from its target). Prediction: `> 1` is a Brier LOSS at every horizon; `< 1` sharpens the
  predicted distribution and improves Brier **only if the simulator's ordering of teams carries real
  skill**. The points-for ceiling (0.1378) says much of the berth is decidable from realised scoring;
  whether a preseason board can find it is exactly what the sweep measures.
- **(b) Week-to-week persistence -- I expect a NULL, because it is not missing.** The premise that
  the sim "draws each week independently" is false since schema 2: `bootstrap.ts` draws a whole
  player-SEASON per trial (the schema-1 iid-week sampler understated season-total spread by 1.6-2.8x
  and was replaced for that reason), and `coupleWithinWeek` then permutes weeks within the drawn
  season. So there is no AR(1) to add; a player's good and bad stretches are whatever the real
  player-season he drew actually did. What CAN be swept is the within-season weekly spread
  (`FF_SIM_WEEKLY_VAR`, already present), and I predict it barely moves the berth, because a berth is
  decided by the season level and the weekly deviations sum out over 13-14 weeks.
- **(c) Copula strength -- I expect a small effect.** The teammate copula couples only NFL teammates,
  of which a 13-16 man fantasy roster holds few pairs, and the measured correlations are 0.08-0.35.
  Both stages are swept: `FF_WEEKLY_COUPLING` (within-week, shipped 1.8) and a new
  `FF_SIM_CORR_SCALE` (season-level, shipped 1). Opponent dependence is NOT swept, and the reason is
  stated rather than skipped: two fantasy rosters in a matchup share no players, and the only
  cross-roster coupling that exists (two managers holding two ends of one NFL stack) is deliberately
  out of the grouping.
- **(d) The pools' tail.** `calibration: "scale"` multiplies every week of every trajectory by one
  ratio, so the pool's SHAPE (the atom at zero, the skew) is already preserved and only the level is
  restored. The shape-preserving inflation the task asks about is therefore exactly (a) for the
  level and `FF_SIM_WEEKLY_VAR` for the week; there is no separate tail knob to invent.
- **(new) The missing dependence I think is real: a ROSTER-LEVEL common factor.** Nothing couples the
  16 men of one fantasy roster beyond NFL-teammate pairs, so a team's season total is nearly a sum of
  independent draws and the spread of TEAM strength is correspondingly narrow. `FF_SIM_TEAM_SD`
  (default 0) adds a per-roster, per-trial lognormal season multiplier -- manager lineup-setting
  skill, waiver activity, a season's injury luck landing on one roster. **Prediction: it will behave
  as a shrink** (it widens team totals, compressing every probability toward 43.8%), and I will say
  so if that is what the reliability table shows.

**The decision rule, fixed in advance.** A knob value is a FINDING only if (i) its HELD-OUT playoff
Brier, with the value chosen leave-one-season-out over the swept grid, beats the control, (ii) the
paired-by-season delta against the control has a 95% season-bootstrap CI excluding zero, and (iii)
the reliability table moves toward its labels rather than merely flattening. A value that improves
Brier by pushing every prediction toward the base rate is the rejected shrink and will be reported as
such. In-season, the D18 ordering (seeded arms dominating unseeded) must still hold at every value.

---

## 2. THE POSITIVE CONTROL, before any sweep

The flagless arbiter on the snapshot reproduces the D25 record exactly, to four decimals, at all
three horizons -- so the snapshot, the artifact directory, the frame flag and the trial count are the
ones those numbers were made with:

| run | recorded (D25.1) | measured here |
|---|---|---|
| week 8, arm D (pooled playoff Brier) | 0.1336 | **0.1336** |
| week 4, arm D | 0.2004 | **0.2004** |
| preseason, playoff | 0.2297 | **0.2297** |
| preseason, title | 0.0636 | **0.0636** |

Per-season too (preseason 2018 0.242359, 2019 0.203273, 2020 0.209735 ...), and each sweep's CONTROL
arm reproduces those same per-season figures -- which is the check that the `--sweep` axis added to
the script is a pass-through at the default value and not a second code path.

**The code change is a no-op on the default path, proved three ways.** (1) The arbiter above ran
AFTER the edits. (2) `node --import tsx scripts/copilot-crosscheck.mjs --schedule real`: ALL CHECKS
PASSED, including both fault injections; playoff shares 7.0000, title 1.0000. (3) `npm run ff --
copilot season-odds --league 462233`: us (8==3) **66.45 / 13.50**, largest playoff mover MILE
**54.05**, top mean points **1028.45** -- byte-identical to the post-D25 numbers recorded in
`docs/decisions.md`. (4) `test/sim-dispersion-knobs.test.ts` asserts `deepEqual` between the unset
simulator and the simulator with every knob set to its documented default, on BOTH sampling paths,
and that an unparseable or negative value falls back rather than to nonsense.

## 3. WHAT WAS EXPOSED (and nothing else)

Every knob defaults to the shipped behaviour and is read at CALL time, so a sweep can set several
values inside one process.

| knob | file | default | what it multiplies |
|---|---|---|---|
| `FF_SIM_LEVEL_SCALE` | `src/draft/season.ts` | 1 | the drawn season LEVEL's deviation from the player's target (and `projSd` on the parametric path) |
| `FF_SIM_TEAM_SD` | `src/draft/season.ts` | 0 | sd of a per-fantasy-roster, per-trial lognormal season factor (new dependence) |
| `FF_SIM_CORR_SCALE` | `src/draft/bootstrap.ts` | 1 | the SEASON-stage teammate copula's off-diagonals |
| `FF_SIM_WEEKLY_VAR` | `src/draft/season.ts` | 1 | (pre-existing) within-season week-to-week spread, level preserved |
| `FF_WEEKLY_COUPLING` | `src/draft/bootstrap.ts` | 1.8 | (pre-existing) the within-week copula multiple |
| `FF_SIM_LEVEL_SHRINK` | `src/draft/season.ts` | the D18 `sqrt(K/(K+k))` | (pre-existing) the in-season level-uncertainty factor |

`scripts/season-calibration.mjs` gained `--sweep KNOB=v1,v2,...` and `--sweep-out <path>`: one build
of each season, one simulation per value, paired by season, with the LOSO choice, the season
bootstrap CI, the shuffled-outcome control at every value, the seeded-vs-unseeded (D18) check at
every value, and a reliability table per value. No flag, no change.

## 4. CONNECTEDNESS -- every knob reaches the outcome before any null is believed

`sd(p)` is the spread of the 114 predicted playoff probabilities (the RESOLUTION of the forecast);
`mean|dp|` is the mean absolute change in a team-season's probability against the control.

| preseason sweep | value | Brier | sd(p) | mean&#124;dp&#124; | max&#124;dp&#124; | min p | max p |
|---|---|---|---|---|---|---|---|
| `FF_SIM_LEVEL_SCALE` | 1 (control) | 0.2297 | 0.1093 | -- | -- | 0.115 | 0.682 |
| | 0 (extreme: level pinned) | 0.2363 | 0.1774 | 0.0605 | 0.1953 | 0.024 | 0.809 |
| | 1.5 | 0.2314 | 0.0801 | 0.0255 | 0.0723 | 0.188 | 0.623 |
| `FF_SIM_TEAM_SD` | 0 (control) | 0.2297 | 0.1093 | -- | -- | 0.115 | 0.682 |
| | 0.25 (extreme) | 0.2333 | 0.0672 | 0.0368 | 0.1050 | 0.220 | 0.579 |
| `FF_SIM_WEEKLY_VAR` | 1 (control) | 0.2297 | 0.1093 | -- | -- | 0.115 | 0.682 |
| | 0 (extreme: weeks flat) | 0.2310 | 0.1170 | 0.0118 | 0.0450 | 0.089 | 0.710 |
| `FF_SIM_CORR_SCALE` | 1 (control) | 0.2297 | 0.1093 | -- | -- | 0.115 | 0.682 |
| | 4 (extreme) | 0.2304 | 0.1079 | 0.0044 | 0.0207 | 0.117 | 0.681 |
| `FF_WEEKLY_COUPLING` | 1.8 (control) | 0.2297 | 0.1093 | -- | -- | 0.115 | 0.682 |
| | 0 / 5 (extremes) | 0.2296 / 0.2299 | 0.1098 / 0.1094 | 0.0029 / 0.0028 | 0.0113 / 0.0093 | 0.116 | 0.685 |

Every lever moves the reliability table, so every null below is a null about the MODEL and not about
a disconnected knob. The two copula levers are connected but weak on real rosters (3 pp of
probability at the extremes), which is what a 13-16 man roster holding few NFL-teammate pairs should
do -- `test/sim-dispersion-knobs.test.ts` shows the same lever moving the odds hard on a fully
stacked roster, so "weak" here is a property of the rosters, not of the wiring.

## 5. THE SWEEPS

### 5a. Preseason (`--at-week` absent; the only arm that also scores the title)

Paired by season against the control, 8 seasons, 114 team-seasons. Positive delta = worse.

| knob | value | playoff Brier | title Brier | paired d | SE | t | 95% CI (season bootstrap) | better in |
|---|---|---|---|---|---|---|---|---|
| `FF_SIM_LEVEL_SCALE` | **1** | **0.2297** | **0.0636** | -- | -- | -- | -- | -- |
| | 0.75 | 0.2314 | 0.0640 | +0.0017 | 0.0016 | 1.07 | [-0.0012, +0.0046] | 3/8 |
| | 0.5 | 0.2332 | 0.0641 | +0.0036 | 0.0034 | 1.06 | [-0.0024, +0.0099] | 3/8 |
| | 0 | 0.2363 | 0.0640 | +0.0069 | 0.0068 | 1.01 | [-0.0052, +0.0191] | 3/8 |
| | 1.5 | 0.2314 | 0.0635 | +0.0017 | 0.0026 | 0.64 | [-0.0030, +0.0066] | 4/8 |
| `FF_SIM_TEAM_SD` | **0** | **0.2297** | **0.0636** | -- | -- | -- | -- | -- |
| | 0.10 | 0.2315 | 0.0642 | +0.0018 | 0.0013 | 1.39 | [-0.0004, +0.0043] | 4/8 |
| | 0.25 | 0.2333 | 0.0643 | +0.0037 | 0.0032 | 1.15 | [-0.0018, +0.0098] | 5/8 |
| `FF_SIM_WEEKLY_VAR` | **1** | **0.2297** | **0.0636** | -- | -- | -- | -- | -- |
| | 0 | 0.2310 | 0.0693 | +0.0013 | 0.0010 | 1.24 | [-0.0006, +0.0032] | 3/8 |
| | 1.5 | 0.2313 | 0.0643 | +0.0016 | 0.0011 | 1.54 | [-0.0002, +0.0036] | 3/8 |
| `FF_SIM_CORR_SCALE` | **1** | **0.2297** | **0.0636** | -- | -- | -- | -- | -- |
| | 0 | 0.2303 | 0.0636 | +0.0006 | 0.0004 | 1.50 | [-0.0001, +0.0014] | 2/8 |
| | 4 | 0.2304 | 0.0641 | +0.0007 | 0.0006 | 1.17 | [-0.0003, +0.0020] | 3/8 |
| `FF_WEEKLY_COUPLING` | **1.8** | **0.2297** | **0.0636** | -- | -- | -- | -- | -- |
| | 0 | 0.2296 | 0.0636 | -0.0001 | 0.0004 | -0.27 | [-0.0007, +0.0006] | 4/8 |
| | 5 | 0.2299 | 0.0641 | +0.0002 | 0.0004 | 0.62 | [-0.0004, +0.0009] | 3/8 |

**Leave-one-season-out chose the SHIPPED value in 8 of 8 folds for every one of the five knobs**, and
the held-out Brier equals the control's 0.2297 in every case. The shuffled-outcome control loses to
the honest arm at every value of every knob (e.g. 0.2537 vs 0.2297 at the control).

**The roster-level common factor behaves exactly as pre-registered -- it is the rejected shrink.**
At `FF_SIM_TEAM_SD` 0.25, 96 of 114 team-seasons collapse into the single 30-50% bin, `sd(p)` falls
0.109 -> 0.067, and the 50-70% band's gap goes from +3.6 to +18.3. It flattens; it does not inform.
Reported as such, per the pre-registered rule.

**And sharpening does not work either.** `FF_SIM_LEVEL_SCALE` 0 (every drawn season pinned to its
projection) widens the forecast to 0.024-0.809 -- and the 50-70% band then realises **46.2%**, which
is the README's famous number appearing as a symptom of an OVER-sharpened simulator. The shipped
level spread is at the optimum from both sides.

### 5b. In-season: the level-uncertainty prior is the one term that is wrong

D18 scales the level's posterior spread by `sqrt(K/(K+k))` and takes **K = 6, the constant the
rest-of-season MEAN blend was fitted to** -- an untested transfer, which D18's own text states
plainly ("the SAME K = 6 the lines were blended with"). K for a posterior MEAN and K for a posterior
SPREAD are different quantities. Sweeping the factor directly (`FF_SIM_LEVEL_SHRINK`) and reading it
back as an implied prior weight `K_u`:

| week (k played) | K_u = 6 (shipped) | K_u = 1 | K_u = 0.5 | K_u = 0 |
|---|---|---|---|---|
| 4 (k=3) -- factor | 0.8165 | 0.5 | 0.378 | 0 |
| 4 -- pooled playoff Brier | 0.2004 | 0.2002 | 0.2002 | 0.2006 |
| 8 (k=7) -- factor | 0.6794 | 0.354 | 0.259 | 0 |
| 8 -- pooled playoff Brier | **0.1336** | **0.1297** | 0.1293 | 0.1279 |
| 11 (k=10) -- factor | 0.6124 | 0.302 | 0.213 (K_u 0.475, the grid point actually run) | 0 |
| 11 -- pooled playoff Brier | **0.0867** | **0.0851** | 0.0848 | 0.0846 |

Paired by season, **K_u = 1 against the shipped K_u = 6**:

| horizon | paired d | SE | t | 95% CI (season bootstrap) | better in |
|---|---|---|---|---|---|
| preseason (k=0) | 0 exactly (the factor is 1 either way) | -- | -- | -- | -- |
| week 4 | -0.0001 | 0.0020 | -0.07 | [-0.0038, +0.0033] | 4/8 |
| **week 8** | **-0.0039** | 0.0016 | -2.44 | **[-0.0067, -0.0007]** | **7/8** |
| **week 11** | **-0.0017** | 0.0007 | -2.25 | **[-0.0030, -0.0002]** | **6/8** |

**It is a sharpening, not a flattening.** At week 8 `sd(p)` rises 0.2994 -> 0.3120 and the forecast
reaches further (max p 0.989 -> 0.995), while the reliability table moves TOWARD its labels in the
bin that was worst:

| week-8 bin | n | shipped K_u = 6: predicted -> observed (gap) | K_u = 1: predicted -> observed (gap) |
|---|---|---|---|
| 0-5% | 18 | 1.8% -> 0.0% (-1.8) | 1.3% -> 0.0% (-1.3) |
| 5-15% | 12 / 13 | 10.7% -> 16.7% (+5.9) | 9.4% -> 15.4% (+6.0) |
| 15-30% | 13 | 21.3% -> 7.7% (-13.6) | 20.6% -> 7.7% (-13.0) |
| 30-50% | 20 / 19 | 39.0% -> 35.0% (-4.0) | 38.0% -> 36.8% (**-1.2**) |
| 50-70% | 19 / 17 | 58.6% -> 52.6% (-5.9) | 58.3% -> 52.9% (-5.4) |
| **70-100%** | 32 / 34 | 80.3% -> 90.6% (**+10.4**) | 81.5% -> 88.2% (**+6.7**) |

The +10.4 top-bin gap is the exact defect D18 recorded as its own next candidate ("the top bin is
still under-confident... the remaining spread that is too wide late in the season is not the level").
It IS the level -- D18 just shrank it by a third when it needed shrinking by two thirds.

**Leave-one-season-out, and the boundary problem, stated rather than hidden.** Over the week-8 grid
alone, LOSO picks the grid's EDGE (`K_u = 0`, no level uncertainty at all) in 8 of 8 folds, held-out
0.1279. Jointly over weeks 4 and 8 it picks `K_u = 0` in 8 of 8 as well (held-out: week 8 0.1279,
week 4 0.2006 against a control 0.2004). I am **not** proposing the boundary: `K_u = 0` says a
player's level after three games is known exactly, it is the WORST value of the grid at week 4, and a
constant that is chosen at an edge is a constant the data has not bounded. `K_u = 1` is the interior
value that is a real gain at weeks 8 and 11, free at week 4 and identically zero at preseason.

The week-4-only LOSO is the winner's-curse guard firing, and it is reported rather than dropped: over
that week's own grid it picks a different value in 3 of 8 folds and its held-out Brier is **0.2021
against the control's 0.2004** -- i.e. at week 4 there is nothing to choose and choosing anyway
costs. That is the same statistic that makes the week-8 result credible (there, every fold picks the
same direction and the held-out number improves), so the two are read with one rule.

**The D18 ordering survives at every value** (the assertion the brief requires): seeded beats
unseeded 8/8 at weeks 8 and 11 and 7/8 at week 4, at every swept factor, and the margin GROWS with
the stronger shrink (week 8: -0.1004 shipped -> -0.1043 at `K_u = 1`; week 11: -0.1455 -> -0.1472).
Shuffled-outcome controls lose everywhere (week 8: 0.3007 shuffled vs 0.1297 honest).

## 6. VERDICT

**NULL on four of the five candidates, and on the premise.**

- **(a) preseason level uncertainty: NULL.** The shipped spread is the optimum from both sides; LOSO
  picks it 8/8. Widening it is the rejected uniform shrink; narrowing it produces exactly the 46%
  band the README complains of.
- **(b) week-to-week persistence: NULL, and the premise is wrong.** The simulator has NOT drawn weeks
  independently since schema 2 -- it resamples whole player-seasons and then permutes weeks within
  them. There is no AR(1) term missing. The knob that does exist for within-season weekly spread
  (`FF_SIM_WEEKLY_VAR`) is a null in both directions (+0.0013 / +0.0016).
- **(c) copula strength: NULL at both stages.** Season-stage 0 or 4x: +0.0006 / +0.0007. Within-week
  0 or 5x: -0.0001 / +0.0002. Connected, and too few teammate pairs per roster to matter.
- **(d) pool tail: NULL, and there is no separate knob to invent** -- `calibration: "scale"` already
  preserves the pool's shape and only restores its level, so the "shape-preserving inflation" the
  question asks for IS (a), measured above.
- **(new) the roster-level common factor: a SHRINK, reported as one.** It improves nothing and
  flattens everything (`sd(p)` 0.109 -> 0.067 at 0.25).

**One FINDING, in-season only, and it is a sharpening rather than a shrink.**

> The level-uncertainty prior weight is **K_u = 1 week, not the rest-of-season blend's K = 6**.
> Held-out (season-paired) playoff Brier: week 8 **0.1336 -> 0.1297** (-0.0039, CI [-0.0067,
> -0.0007], 7/8), week 11 **0.0867 -> 0.0851** (-0.0017, CI [-0.0030, -0.0002], 6/8), week 4 a dead
> null (-0.0001), preseason unchanged by construction. The top reliability bin's gap falls from
> +10.4 to +6.7 and the D18 seeded/unseeded ordering strengthens.

**The exact override, PENDING OWNER SIGN-OFF -- nothing is applied.** The quantity lives in one
place: `src/draft/simContext.ts` passes `priorWeeks: rosBlend.K` into `played`, and
`scripts/season-calibration.mjs`'s arm D does the same with `s.rosK`. Shipping means giving the
LEVEL its own constant instead of borrowing the MEAN's:

```
src/draft/simContext.ts   played: { ..., priorWeeks: LEVEL_PRIOR_WEEKS }   // a new constant = 1,
                                                                          // NOT rosBlend.K (= 6)
scripts/season-calibration.mjs  arm D: priorWeeks: LEVEL_PRIOR_WEEKS
```

Reproduce either arm from one script version, with no code change at all:

```
node --import tsx scripts/season-calibration.mjs --db <snapshot> --at-week 8 \
  --artifact-dir data/fold-artifacts-d16 --replacement-frame nfl \
  --sweep FF_SIM_LEVEL_SHRINK=unset,0.354,0.259,0      # 0.354 = sqrt(1/(1+7)) = K_u 1 at week 8
```

**What sign-off would also need to decide, because a measurement cannot:** `K_u` is a single number
standing in for a per-player, per-position quantity (a rookie's level is far less certain after seven
games than a ninth-year tight end's), and this experiment can only say that one number should be near
1 rather than 6. And it moves live in-season odds -- `season-odds`, `waivers`, `depth-risk` and every
copilot caveat -- so it is a D-level decision, applied the charter way (temp path, gate, before/after,
then swap), not a side effect.

**Left unmeasured, deliberately:** weeks 2-3 and 12+ (the horizons this experiment did not sample);
whether `K_u` should differ by position or by how many weeks a man actually played; the title Brier
in-season (the at-week arms score the berth only, per D13); and the Yahoo format, whose own K is 5
and whose golden does not exist yet (D24).

## 7. GATES

- `npm run typecheck` -- clean.
- `npm test` -- **1003 tests, 1000 pass, 2 skipped, 1 fail**, and the one failure is not this work's
  and is not reproducible: `test/picks.test.ts` read "2025: 372 picks against the recorded 192" for
  league 462233 midway through an 11-minute suite while a CONCURRENT executor was ingesting the Yahoo
  league's draft into the shared `data/ff.db`. Re-run alone it is 9/9 green, and the store now holds
  the Yahoo rows correctly stamped (`129048` 180 rows for 2025; `462233` still 192). The same
  transient hit `test/wp13-wiring.test.ts` in an earlier full run and is likewise 6/6 green alone.
  **No measurement in this report is affected**: the arbiter read a `VACUUM INTO` snapshot taken
  before any of that, and its own output line for 2025 says `roster match 186/192`.
- `test/sim-dispersion-knobs.test.ts` (new) -- 5/5, including the default-equality and connectedness
  pairs.
- `npx eslint` on every changed file -- no warnings.
- The draft championship backtest, run ONCE, unaffected by any of this (nothing in the draft path
  reads these knobs):

```
npm run ff -- backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150
  CHAMPIONSHIPS: 39.5%  (random 6.3%)  |  playoffs: 96%
  per season: 2000:28%  2001:31%  2002:44%  2003:47%  2004:32%  2005:29%  2006:49%  2007:19%  2008:47%  2009:55%  2010:44%  2011:62%  2012:47%  2013:41%  2014:29%  2015:38%  2016:29%  2017:33%  2018:41%  2019:36%  2020:43%  2021:35%  2022:54%  2023:33%  2024:40%
```

**Also worth correcting when someone signs this off:** README's "Known model limits" paragraph and
the D13 header's playoff Brier both quote the pre-D16/pre-D25 figures (0.2370 against 0.2451, the
50-70% band realising 46%). The current stack's preseason numbers are 0.2297 against 0.2451 (skill
6.3%) with that band realising 59.4%. The claim that the simulator is over-confident is no longer
true of the shipped simulator; it is under-resolved instead, which is a different problem with a
different fix (better preseason team-strength signal, not more dispersion).

