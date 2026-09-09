# The in-season backtest: our decisions against what this room actually did

Everything in this repo up to now was validated against the DRAFT -- one auction, replayed
thousands of times. The in-season surface (lineups, waivers, handcuffs) had never been scored
against anything, because the store did not contain the facts it would have to be scored against:
who was on which roster in which week, who was started, who was added, when, or for how much.

This track fetched those facts and used them. Four steps, three backtests, four pre-registered
predictions, two of which failed.

## What is now in the store

| table | rows | what |
|---|---|---|
| `raw_league_roster_week` | 27,055 | every team's roster AND lineup slot for 147 of 159 scoring periods, 2018-2026 |
| `raw_league_transaction` | 11,169 items / 4,569 transactions | every add, drop, waiver claim and trade, with FAAB bids |
| `fact_roster_week` | 24,367 | the same rosters, resolved to `player_sk` |
| `fact_fa_pool_week` | 64,865 | who was on nobody's roster, week by week (about 480 players a week) |
| `fact_lineup_week` | 1,896 | started points, hindsight-optimal points, and the gap, per team-week |

Rebuild: `ff ingest-raw league-rosters`, `ff ingest-raw league-transactions`, then
`buildRosterStateInto` (`src/features/sources/rosterState.ts`).

### The ESPN endpoint that lies, and the query parameter that decides everything

Four shapes were probed read-only through the app bridge before anything was built
(`scripts/inseason-probe*.mjs`; every payload cached under `data/cache/espn/`).

| request | result |
|---|---|
| `leagueHistory/{id}?seasonId=Y&view=mRoster&scoringPeriodId=w` | **IGNORES the week.** Weeks 1, 3, 8 and 14 of 2020 return identical rosters *and identical starters*. It is the FINAL roster wearing a week number. |
| `leagueHistory/{id}?...&view=mBoxscore` | `rosterForCurrentScoringPeriod` comes back empty. |
| `seasons/Y/segments/0/leagues/{id}?scoringPeriodId=w&view=mBoxscore` | **Works**, for past seasons as well as the current one: real lineup slots and the week's applied points. |
| `...view=mTransactions2` | Empty array on every path -- **unless the request carries `scoringPeriodId`**. With it, 2024 week 5 returns 21 transactions. |

Both failures are the same shape: a request that returns a well-formed object which does not answer
the question asked. "ESPN has purged the old transaction log" was, for three probes, a statement
about a missing query parameter. The parser test asserts that week 3's and week 8's starters
*differ*, which is the assertion that would have caught the first one.

### Identity resolves 100%, in three stages, and the split is reported

21,789 rows by ESPN id through `player_xref`; 2,453 team defences by arithmetic on ESPN's own
encoding (`-16000` minus the proTeamId, so `-16011` is proTeamId 11 is IND is `DST:IND`); 125 by
`nameKey` **plus position** against an unambiguous `stg_player` row. The third stage exists because
Tom Brady and Drew Brees carry no `espn_id` in the cross-source id file at all. Never a bare name.

### Point-in-time, stated precisely

The naive version of the invariant is wrong. Week *w*'s roster MEMBERSHIP and slot assignment ARE
knowable before week *w*'s first kickoff -- that is exactly when a manager sets them, and a backtest
that refused to look at them could not evaluate a lineup decision at all. Week *w*'s applied POINTS
are not. So the guard is: **perturb week *w*'s points and every row of every later week, and nothing
`asOfRosterState` returns for week *w* may move.** Fault-injected three ways in
`test/inseason-backtest-state.test.ts` -- the hindsight optimum must MOVE under the same
perturbation, the signature must distinguish two genuinely different weeks, and the state must
return a non-empty roster, or every "nothing moved" is trivially true of nothing.

`fact_lineup_week.optimal_pts` is explicitly hindsight and is built by a different function. That is
why it can be a ceiling without being a leak.

---

## Backtest 1 -- lineup regret. P36 held; P37 failed badly.

1,896 team-weeks, 2018-2025. Same roster, three numbers: what the manager started, the best legal
lineup from that roster with hindsight, and what OUR rule would have started (`optimalLineup` over
the weekly projector's means as of that week) scored on the real results.

| | floor | challenger |
|---|---|---|
| managers started | 89.64 | 89.64 |
| hindsight optimum | 102.12 | 102.12 |
| **our lineup, scored** | **85.19** | **88.25** |
| gain over the manager | -4.45 | -1.39 |
| season bootstrap of that gain | [-5.40, -3.78] | [-2.29, -0.57] |
| beats the league's median realised lineup | 42.1% | 46.8% |
| beats its OWN team's manager | 36.5% | 43.5% |

- **P36** -- managers leave at least 8 points a week on the bench against hindsight:
  **HELD**, 12.48.
- **P37** -- our lineup beats the median manager's realised lineup in at least 60% of team-weeks
  under the challenger: **FAILED**, 46.8% (floor 42.1%).

### It is not a measurement defect, and that was checked before it was written down

"The tool is worse than the room" is exactly the shape of claim that usually is one, so
`scripts/inseason-lineup-diagnose.mjs`:

- **Positive control on the optimiser.** Our lineup carries the higher PROJECTED total in 88.9% of
  team-weeks with a further 8.3% exact ties (challenger 80.2% + 17.7%). It is the argmax of that
  quantity, so ~100% is the only acceptable answer; the residual is almost entirely the 119 starts
  where a manager started a man our point-in-time block calls unavailable -- he is in the manager's
  total and not in our candidate set. The rule is connected and doing its job.
- **The mechanism.** Our lineups start a player who scores EXACTLY ZERO 6.4% of the time (challenger
  4.4%) against the managers' 3.5%. Real managers avoid non-playing players better than a Wednesday
  injury block does. That is an information gap, not an optimisation gap.
- **Robustness.** The loss survives dropping every team-week where the projector had no row for
  someone (722 remain: -3.65 / -0.67) and dropping 2025, whose injury block is empty so availability
  is bye-only (-4.65 / -1.61).

**What to do about it** is a question for the owner, and the honest options are not "fit harder":
get late-week inactives into the availability block, or treat the lineup surface as an assistant
that flags a benched player who out-projects a starter rather than as an autopilot.

## Backtest 2 -- waiver ranking. P38 held for the challenger only.

133 weeks. The room made K adds; our tool ranks the same choice set and takes ITS top K; both are
scored on realised rest-of-season points per game from the add week forward.

| | floor | challenger | the room |
|---|---|---|---|
| realised ROS points per game | 5.65 | **7.17** | 6.83 |
| weeks our K beat theirs | 26.3% | 60.9% | -- |
| per FAAB dollar | 18.71 | **22.43** | 20.61 |
| seasons ahead of the room | 1 of 8 | 7 of 8 | -- |

- **P38** -- our recommended adds outscore the room's per FAAB dollar over 2018-2025:
  **FAILED under the floor, HELD under the challenger** (+8.8%).

### The join defect a reported rate caught

The first run scored the room's adds against week *w*'s own free-agent pool and matched **3.9%** of
them. That is not "the room adds obscure players" -- an add executed inside scoring period *w* is
already on week *w*'s roster snapshot, so the claimed man is by construction absent from the pool
computed for that week. The choice set is week *w-1*'s pool, where the match rate is **87.3%**. Had
that rate not been printed, a wrong number would have been recorded as a finding.

### What is NOT being backtested, said once and plainly

`waiverTargets` ranks by the change in playoff probability from a paired simulation over a
`SimContext`, and a `SimContext` is built entirely from the current season's board, ownership and
schedule. Constructing one for 2019 would mean inventing a 2019 board, which would make the
comparison a measurement of a fabrication. So the objective is replaced by expected points from the
added player, and **the FAAB rule is not exercised at all**: the per-dollar comparison puts the
room's own dollars on both sides, which makes it the same test as the per-add comparison. Printing
it twice as though it were two pieces of evidence would have been the dishonest option.

### What the room itself shows, needing no model of ours

Bidding more did not get more, on 1,878 claims:

| bid | n | mean bid | realised ROS points per game |
|---|---|---|---|
| $0 (free agent) | 1,235 | 0 | 6.86 |
| $1-4 | 318 | 1.82 | 6.58 |
| $5-14 | 187 | 8.35 | 7.03 |
| $15-39 | 110 | 22.55 | 6.74 |
| $40+ | 28 | 65 | 7.22 |

Half a point of spread across a 65x range in price.

## Backtest 3 -- backup becomes starter. P39 held; the handcuff prior does not move.

67 events, 2018-2024: the published depth chart moving a man from rank 2 to rank 1, with a displaced
week *w-1* starter carrying an OUT designation that week. A strictly pre-kickoff signal, where
`handcuff.ts`'s own fit infers "the lead is out" from the lead's missing week.

| pos | n | starter t4 | backup pts, that week | next-4 mean | snap% before -> that week | share of starter |
|---|---|---|---|---|---|---|
| RB | 9 | 8.67 | 13.76 | 9.72 | 0.45 -> 0.61 | **1.586** |
| QB | 14 | 10.17 | 8.34 | 5.08 | 0.70 -> 0.90 | 0.820 |
| WR | 30 | 7.75 | 3.14 | 2.84 | 0.49 -> 0.61 | 0.405 |
| TE | 14 | 6.34 | 1.69 | 3.02 | 0.49 -> 0.60 | 0.266 |

- **P39** -- a promoted RB backup posts at least 60% of the departed starter's trailing-4 that week:
  **HELD**, 159% -- he outscores the man he replaced. Registered direction for WR and TE (lower)
  **HELD**, and by a distance.

**The prior is NOT replaced.** The specified model (the backup's week-*w* points on the starter's
trailing-4, the backup's prior snap share and the team's implied total), cross-validated nested by
season, is worse out of sample than `0.922*backup + 0.402*lead`: RMSE 7.30 vs 6.78 pooled, 3.27 vs
1.50 on the nine RB events. Adding the backup's own trailing-4 gets it to 6.59 vs 6.78 -- a 2.7%
gain on 66 events over seven folds, inside the selection noise this repo has been burned by, and a
loss on the one position the board exists for. `handcuff.ts` records the check and keeps its
coefficients.

**The event definition was wrong first, and a zero caught it.** Requiring exactly one rank-1 player
returned ZERO wide receivers across seven seasons. That is a property of the filter, not of
receivers: a team fields two or three, so the chart carries about 2.5 rank-1 receivers per team and
the rule deleted the entire position. 34 events became 67 once it was fixed. A second scale error
died the same way -- `offense_pct` is already a fraction, and dividing it by 100 again produced a
fitted coefficient of 1,152.

---

## The through-line

The trained weekly challenger beats the shipped season-line floor on **both** decisions -- it
halves the lineup deficit (-1.39 vs -4.45) and it is the only one of the two that beats the room on
waivers (7.17 vs 5.65 points per game, 7 seasons of 8 vs 1 of 8). That is the first evidence in this
repo of the challenger doing useful work, and it is **not** evidence for shipping it: the gate it
failed (`docs/weekly.md`) was about calibration, and these are point estimates on decisions, not
coverage. It is an argument for re-running that gate, not for skipping it.

## Reproduce

```
ff ingest-raw league-rosters       --seasons 2018-2026
ff ingest-raw league-transactions  --seasons 2018-2026
node --import tsx scripts/inseason-backtest-lineup.mjs
node --import tsx scripts/inseason-lineup-diagnose.mjs
node --import tsx scripts/inseason-backtest-waiver.mjs
node --import tsx scripts/inseason-backtest-promotion.mjs
```

The fetch is read-only, one request at a time, and every payload is cached, so a re-run costs
nothing and needs no ESPN session.

## Limits, named

- **2025 has no injury block** in `feat_player_week_model`, so availability there is bye-only. Its
  numbers are in line with the other seasons but the reason to trust them is weaker.
- **2026 rows exist for weeks that have not been played.** ESPN serves today's roster under a future
  week number with zero points; `buildRosterState` refuses any week whose first kickoff has not
  happened. Nothing in the tables above is from an unplayed week.
- **The playoff-odds objective and the FAAB rule are untested.** See backtest 2.
- **Per-manager conclusions are still not trustworthy** (`CLAUDE.md`): these are league aggregates,
  and nothing here changes the finding that per-owner profiles have no out-of-sample signal.
