# The lineup model under stress (M3, 2026-09-17)

A stress test of the weekly lineup surface: `src/inseason/lineup.ts` (the optimizer),
`src/inseason/copilot.ts` (`lineupRecommend`, `assertStartersAvailable`), `src/inseason/copilotStore.ts`
(the loaders) and `src/inseason/winprob.ts` (the alternative objective). Six axes: optimizer
correctness, input robustness at serve, stability, value against baselines, calibration under
stress, determinism and latency.

**Nothing about the model or any lever was changed.** Three defects were fixed, each an outright
bug in reporting or in a guard, each with a fault-injected test. Served artifacts are byte-identical
(`data/weekly-artifact.json` md5 `5aa938ecd0dc73ab68fe9a0137de3cfd`), `npm run typecheck` is clean,
the suite is green, and the draft backtest prints its pinned line.

New: `scripts/lineup-stress.mjs` (the fuzz + perturbation + baseline + calibration driver, one
command each), `test/lineup-stress-fuzz.test.ts` (10 tests), `test/lineup-stress-robustness.test.ts`
(17 tests).

```
node --import tsx scripts/lineup-stress.mjs report        # axes 1 and 3 (synthetic), ~10s
node --import tsx scripts/lineup-stress.mjs baselines     # axes 4 and 5, 1,896 team-weeks, ~30s
```

---

## 0. Verdict per axis

| axis | verdict |
|---|---|
| 1. optimizer correctness | **PASS.** 18,000 fuzz cases over nine templates against an exact independent reference: 0 failures. The control (the pre-matroid slot-order greedy) fails 209 of 2,700, so the fuzz is connected. |
| 2. input robustness at serve | **3 DEFECTS, all fixed** (D1/D2/D3 below), 11 cases PASS, 7 FINDINGS. |
| 3. stability | **PASS with a finding.** Nothing flips at a 1% perturbation of the live roster; 0.3% of the starting SET flips at 5%. But a draw inside the model's own p10/p90 flips the set 95% of the time -- the ORDERING is confident, the OUTCOME is not, and the served caveat says neither. |
| 4. value vs baselines | **PASS.** Served beats both cheap baselines by ~3.6 pts/team-week, 8/8 seasons, and is level with the room's managers (-0.09 [-1.26, 0.75]). It sits 12.6 below hindsight, concentrated at WR and RB. |
| 5. calibration under stress | **PASS overall (0.814 vs a nominal 0.80), two real defects of the band**: it is short on the UPSIDE everywhere (11.8% above p90 vs 6.8% below p10), and the "injury-designated" cell is DEGENERATE, not calibrated. |
| 6. determinism + latency | **PASS.** Byte-identical apart from `assumptions.asOf`. `lineupRecommend` is 1ms cold / 0.1ms warm; the whole verb 155-172ms; 404ms with the app unreachable, no hang. |

---

## 1. Optimizer correctness

### What was done

`scripts/lineup-stress.mjs` fuzzes `optimalLineup` against an **exact dynamic program** over
(slot index, used-player bitmask), whose eligibility table is **hand-written in the script and does
not import `src/draft/slots.ts`**. That independence is the point: a producer that ships its own
validator grades its own homework and passes forever. The existing `test/lineup-eligibility.test.ts`
compares the optimizer with the algorithm it *replaced*, which proves the two agree, not that either
is right.

The objective the reference maximises is **(slots filled, total points), lexicographically** -- not
points alone. `optimalLineup` seats every available man it legally can (Kuhn's algorithm yields a
maximum matching whatever the weights), and that is the right rule for a real lineup: an empty slot
also scores zero and the platform will not accept one. The script counts the cases where the two
objectives disagree rather than hiding the choice.

Nine templates: ESPN's, Yahoo's superflex (`W/R/T`, `Q/W/R/T`, `DEF`, `BN`, two `IR`), single-flex,
two-flex, no-K/DST, flex-heavy, generic slash forms, an edited `flex_ok` that includes QB, and a
"starved" template with more starters than the roster can fill. Rosters are generated to HIT the
hard cases: projections quantised so exact ties are common, 10% zeros, 6% negatives, 25% dual
eligibility, 25% unavailable.

### Results

| case | expected | observed | verdict |
|---|---|---|---|
| 18,000 random rosters x 9 templates, seed 1 | exact optimum + legal every time | **0 failures**, 2.1s | PASS |
| 9,000 cases at the test's fixed seed 20260917 | same | **0 failures** | PASS |
| CONTROL: the same fuzz on the slot-order greedy | must FAIL | **209 failures / 2,700**, e.g. "filled 6 slots, the exact reference fills 7" | PASS (the fuzz is connected) |
| slot vocabulary, every token in the nine templates | `slotAdmits` == the independent table | **no disagreement** | PASS |
| more starters than eligible players | the slot stays EMPTY, never filled illegally | 5 of 8 slots empty, each named in `flags`, RB still filled at RB rather than consumed by FLEX | PASS |
| all-tied projections | full legal lineup, total == optimum | 9 of 9 filled, 81.0 | PASS |
| zero and negative projections | slot filled (an empty slot scores zero too) | a -3 DST is started; total 15 | PASS (documented choice, now pinned by a test) |
| IR / BE / BENCH / BN / ER tokens | never a starting slot | 1 starting slot from a 7-token template, no flags | PASS |
| SUPERFLEX with a spare QB | the QB fills SUPERFLEX; plain FLEX must NOT take him | correct both ways; FLEX goes empty rather than absorbing the QB | PASS |
| dual eligibility (RB/WR swing man) | 42.0 (the optimum), greedy loses | correct | PASS |
| the generator itself | must produce ties/zeros/negatives/duals | asserted, with thresholds | PASS |

**FINDING 1-a (not a defect).** With negative projections, max-points and max-cardinality disagree
in about 17% of the fuzz's cases (worst case in the fuzz: +15.5 points by benching negative men).
This is a property of the generator, which makes negatives far commoner than reality -- in the real
league only a DST goes negative, and only rarely. The choice to fill the slot is correct and is now
asserted by a test rather than implied by a comment.

---

## 2. Input robustness at serve

Every case below was first driven against a **temp copy of the live store** (an online `db.backup()`
of `data/ff.db` into the scratch dir; the live store was opened read-only throughout), at
season 2026 week 2 on the real 12-man roster, and is reproduced on the shared fixture as a unit test.

### The three defects, and they are one defect wearing three hats: A PLAYER RESOLVED BY NAME

| id | case | expected | observed (before) | verdict |
|---|---|---|---|---|
| **D1** | two men of one name, the UNAVAILABLE copy first in roster order | the lineup returns, the available man starts | **THROWS** -- `lineup starts 1 player(s) who cannot play in week 2: <name> -- bye week 2`. `ff copilot lineup` and the MCP tool both fail outright on a perfectly legal lineup | **DEFECT, fixed** |
| **D1'** | the same, the AVAILABLE copy first | a genuinely-benched bye man must be caught | **passes unseen** -- the guard inspects the first copy, finds him fine, and the one failure it exists to catch goes unreported | **DEFECT, fixed** |
| **D2** | `optimalLineup`'s own "started but not available" flag, same roster | silent (the available twin was seated) | fires falsely: `"<name> started but not available"` | **DEFECT, fixed** |
| **D3** | a rostered man with NO board row AND no weekly row | a named zero, or a refusal | **`totalProj` is `NaN`** -- the headline number of the verb, serialising to JSON `null`; his slot prints `NaN`; and `basisNote` says he "fell back to the season projection divided by 17", which is exactly what did not happen | **DEFECT, fixed** |

**The fixes.**

* `assertStartersAvailable` (`src/inseason/copilot.ts`) now collects **every** roster man of that
  name and complains only when they are **all** unavailable. Starting "that name" is a plumbing
  failure only in that case. On a roster with unique names `cands` has one element and the behaviour
  is byte-identical to the old `find`.
* `optimalLineup` (`src/inseason/lineup.ts`) reads the **seated object** (`occupant[i]`) instead of
  looking the starter up by name. The flag is unreachable from outside the function by construction
  (the assignment only ever draws from the available players) -- which is precisely why it must be
  right: a tripwire that can fire falsely is worse than none.
* The season-line fallback in `lineupRecommend` is guarded with `Number.isFinite` -- the same test
  that was already applied to the weekly value one line above and simply was not applied to the
  fallback -- and men with **neither** a weekly row nor a usable season line are **named** in
  `basisNote` as carried at zero, with "that is a board/roster join gap, not a projection". The
  identical guard was applied to the **second** caller, `toWp` on the winprob path, in the same
  change: fixing one of two callers of a rule is worse than fixing neither, because it looks done.
* Two residues of the same name-keying were fixed alongside: the bench `reason` map (keyed on name
  alone, so both bench rows of a duplicated name got the last one's reason) and the winprob bench
  filter (a name-set, so with two men of one name and only one starting, **both** were dropped from
  the result and a rostered man vanished).
* A started name that fills more than one slot is now **flagged** rather than silently printed
  twice. The assignment is not touched -- it is legal and correct -- but a lineup that prints the
  same man in two slots is indistinguishable from a bug, and the reader cannot resolve it.

**D3's reachability, stated honestly.** Today's only production loader, `loadSimContext`, writes
`Number(j.ProjPts) || 0` and *drops* a rostered man with no board row (with a `console.warn`), so
the NaN is latent there rather than live. `lineupRecommend` is also reached from hand-built contexts
(the backtest harness, the scripts), where it is not.

### The cases that PASSED

| case | expected | observed | verdict |
|---|---|---|---|
| a rostered man with no weekly row | falls back to the season line / 17 **and says so** | `basis` degrades `weekly-model` -> `projection`; `basisNote`: "1 fell back to the season projection divided by 17 ... : Amon-Ra St. Brown"; total 91.4 -> 84.8 | PASS |
| no weekly projector at all | the old path, named | "no weekly projector was supplied: every point total is the season projection divided by 17, which has no matchup, no recent form and no weather in it"; total 75.5 | PASS |
| a NaN weekly projection | treated as ABSENT, not as a number | falls back and is named | PASS |
| every starter OUT | every slot empty with a named reason, no crash | 8 empty slots, 8 `no available player to fill <slot>` flags, 12 `unavailable` rows each with its source, total 0 | PASS |
| every man at one position on bye | that slot goes empty with a NAMED reason, never a bye starter | WR and one FLEX empty, five `bye week 2` rows, total 64.4 | PASS |
| an IR **designation** on the best man | he is benched, the next man starts | Goff (16.83) out, Nix (15.36) in, `OUT (IR) -- fault-injection` named; same for PUP/NFI/Suspension/DNR/Doubtful/Out | PASS |
| QUESTIONABLE | still starts (measured: benching every Q costs more) | starts, not listed unavailable | PASS |
| a roster shorter than the template | fills what it can, names every slot it cannot | 3 filled, 5 named | PASS |
| the app unreachable (`FF_LIVE_READ_TIMEOUT_MS=1`) | the fallback fires with its message, no hang | 404ms total; `schedule: REAL, from the store's synced matchups (104 games, synced 2026-09-10T15:37:52.313Z) -- the live read failed: live league read exceeded 1ms (FF_LIVE_READ_TIMEOUT_MS)` | PASS |
| consensus MISSING (`ecr_wk_rank`/`ecr_wk_sd` nulled on 532 rows of a scratch copy) | the caveat NAMES it | `DEGRADED -- 3 model feature(s) are 100% ABSENT at this week ...: ecr_wk_rank, ecr_wk_sd, prior_route_share`, and the lineup moves 91.4 -> 90.0 | PASS (a connected, fault-injected positive control) |
| the live week's own dark feeds | named without being asked | `prior_route_share` is reported dark at the real serve, matching WP17's open item | PASS |

### FINDINGS (no fix; each is outside this pass's ownership or is a model change)

**FINDING 2-a -- "1 starters unmatched, scored 0: De'Zhaun Stribling (WR)" is NOT a name-key gap,
and the message that exists to disambiguate cannot.** Diagnosed on the live store:

* `raw_league_roster_week` (league 462233, 2026, week 1) carries him as a started WR, slot 23 (FLEX),
  `applied_points = 0`, on team 15.
* `feat_player_week` carries a row for week 1 2026 spelled **identically** -- `De'Zhaun Stribling` --
  with `pts = NULL`.
* The seeding join in `src/draft/simContext.ts` reads
  `SELECT ... FROM feat_player_week WHERE season=? AND week<=? AND pts IS NOT NULL`, so a row whose
  `pts` is NULL is absent from `actualByName` and the man is scored 0 and reported "unmatched".
* Reproduced exactly: applying the same join *with* the DST nickname alias leaves precisely **one**
  residue over the 128 week-1 starters, and it is him. Without the alias it is 17 (16 defenses plus
  him), which is why the alias is load-bearing and why the count alone tells you nothing.

The scoring is right (he did not play, and 0 is his week). **The caveat is wrong about why**, and its
own comment claims otherwise -- "two very different things land here: a man whose game is not synced
yet (a data gap) and a name the two tables spell differently (a join gap) ... a count cannot tell
them apart; a list can." A list cannot either: both produce the identical sentence. The two cases are
distinguishable in one query -- *does a feature row for that (name, week) exist at all?* -- and the
DSTs above are the "no row" case while Stribling is the "row with NULL pts" case. No fix here:
`src/draft/simContext.ts` is outside this pass's file ownership, and it is a one-line message change
with an obvious shape (`unmatched` vs `unscored`).

**FINDING 2-b -- there is NO lineup-lock concept anywhere in the lineup path.** `grep -i lock`
returns nothing in `lineup.ts`, `copilot.ts` or `copilotStore.ts`. A Thursday player whose game has
already kicked off is still a candidate to be started or benched, and the serve says nothing about
it. Today is a Wednesday and the point is moot; on a Monday with fourteen games settled, the verb
will happily recommend moving a man whose week is over. `weekSource` names the week boundary ("week
2 runs through its last kickoff on ...") but nothing is per-player. This is a real gap in the
decision surface, not a bug in the code that is there.

**FINDING 2-c -- `ownership.slot = 'IR'` is never read, so an IR-slotted man is offered as a
starter.** `loadSimContext` selects `player_id, team_id, team_abbrev, owner` from `ownership` and
ignores the `slot` column that table carries. Yahoo league 129048 has **four** men in an IR slot
(A.J. Brown, Isiah Pacheco, Jordyn Tyson, Tank Dell); ESPN 462233 currently has none. All four are
caught today by the *injury* path (`player_status.injury_status` -> OUT), which is defence in depth
that happens to hold. The day a returning player's designation clears while he is still parked in
the IR slot -- which is the normal sequence, since the manager must activate him by hand -- the
lineup would recommend starting a man the platform will refuse. Outside this pass's ownership
(`src/draft/simContext.ts`).

**FINDING 2-d -- the lineup's fallback is the PRESEASON line / 17, not the D18 rest-of-season
blend.** `src/draft/season.ts:503` prices every rostered man at `rosPerGame ?? proj / 17`;
`lineupRecommend` and `toWp` use `p.proj / perWeek` and never read `rosPerGame`, which
`loadSimContext` computes and attaches (K = 6, 192 men on the live roster set). So in week 10 the
season simulator and the lineup verb hold two different per-week strengths for the same man, on the
same context. The exposure is bounded -- the fallback covers 2.9% of rostered men in the 2018-2025
replay, and 1 of 12 on the live roster -- but this is exactly the drift `WEEKLY_SERVE` was built to
make impossible, one seam short. **Not fixed: aligning them would move the lineup, i.e. it is a
model change, which this pass is forbidden.** It is a candidate for an owner-gated change.

**FINDING 2-e -- a STALE feed is invisible; only an ABSENT one is reported.** `liveWeekCoverage`
measures the NULL share of each served column against the same week in the prior three seasons, so
it catches *dark*. It does not read any `as_of`/`scraped` stamp. `weekly_rank.scraped` on the live
store is `2026-09-17` (fresh), and the season `ranking` row for `fantasypros_ecr` is
`2026-09-08` -- nine days old -- and nothing in the lineup caveat mentions either. The brief's
expected behaviour ("rankings 8 days old -> consensus MISSING with the caveat naming it") does not
happen: a stale consensus produces a POPULATED column and a confident-looking lineup. The
*absent*-consensus case does produce the caveat, correctly, and is now a positive control above.

**FINDING 2-f -- the DST alias is applied by `nameKey` but not by `lineupNameKey`.** Renaming the
rostered defense from `MIN D/ST` to `Vikings D/ST` on the scratch roster made the weekly projection
miss: he dropped to the season line (5.07 -> 6.47) and `basis` degraded to `projection`. It is
reported honestly -- he is named in `basisNote` -- so this is a fragility, not a silent failure, and
the two key spellings are a documented owner decision (`copilot.ts` lines 488-501). It is worth
knowing that the live roster happens to carry the spelling that joins.

**FINDING 2-g -- the "REAL schedule" caveat cannot distinguish a live read from the stored
fallback.** With the app unreachable, `assumptions` says `REAL schedule` and the distinction ("from
the store's synced matchups ... the live read failed") is printed to **stderr** only. The code
comment says "Which source served is printed"; it is, to a console, not into the machine-readable
block a consumer quotes.

---

## 3. Stability

### Synthetic (2,000 random ESPN-template rosters, seed 7)

| perturbation | slot-label flip | starting-SET flip | proj pts lost per flip | per week |
|---|---|---|---|---|
| +/- 1% | 5.2% | 3.3% | 0.01 | 0.000 |
| +/- 5% | 10.3% | 5.7% | 0.31 | 0.018 |
| +/- 10% | 15.8% | 9.1% | 0.67 | 0.061 |
| +/- 20% | 28.1% | 15.5% | 1.65 | 0.256 |

### On the LIVE roster (2026 week 2, 2,000 draws each, served bands)

| perturbation | slot-label flip | starting-SET flip | proj pts lost per flip | per week |
|---|---|---|---|---|
| +/- 1% | **0.0%** | **0.0%** | -- | 0.000 |
| +/- 5% | 13.8% | 0.3% | 1.47 | 0.004 |
| +/- 10% | 45.7% | 14.1% | 1.47 | 0.207 |
| +/- 20% | 73.3% | 38.1% | 1.81 | 0.691 |
| **one draw inside each man's own p10-p90** | **99.5%** | **95.0%** | **6.47** | **6.143** |

**Verdict: PASS, with a finding.** Nothing at all flips on the live roster at 1%, and only 0.3% of
the starting SET flips at 5% -- the synthetic fuzz's 3.3% at 1% is an artifact of a generator built
to produce ties, which the real roster does not have. A lineup that flipped on a 1% perturbation
while the caveat read confident would have been a defect; it does not.

**FINDING 3-a.** Drawing each man once from the model's own p10-p90 flips the starting set 95% of
the time, at a mean cost of 6.5 projected points. That is not a defect and it must not be read as
one: **the band is the OUTCOME distribution, not the uncertainty of the mean.** The served bands on
this roster are enormous relative to the gaps between candidates -- Amon-Ra St. Brown is
`mean 16.79, p10 5.20, p90 30.28`, and the FLEX candidates are separated by 0.7 to 2.2 points. The
honest statement is that the expected-points *ordering* is stable to any plausible error in the
projection, while the realised ordering is close to a coin toss -- and the serve's summary
("Week 2: 91.4 projected pts. QB Jared Goff, RB Breece Hall, ...") carries neither the band nor the
margin. A reader who is told 91.4 and a list of names has no way to see that the two FLEX slots were
decided by 0.70 points (Jameson Williams 10.24 over Colston Loveland 9.54) between two men whose own
p10-p90 spans are 22.0 and 22.9 points wide.

### Win probability vs expected points, on the live context

Driven for all 13 regular-season weeks against the real opponent (schedule from the store's synced
matchups), 8,000 sims at seed 7:

| week | same lineup | P(win) winprob | P(win) EP lineup | bought for |
|---|---|---|---|---|
| 1-5, 7-9, 11-12 | yes | 63.49 / 61.28 / 56.71 / 62.39 / 51.50 / 58.25 / 57.94 / 70.31 / 73.46 / 56.51 % | identical | 0 pts |
| **6, 10, 13** | **no** | 31.46 / 48.63 / 53.89 % | **identical** | **0 pts** |

**The objective is CONNECTED but is a NULL on this roster.** In the three weeks the searched lineup
differs it differs only in slot LABELLING -- `epCostPts` is 0 and `winPct == epWinPct` to the
percentage point in every one of the thirteen, which means the two lineups are the same set of men.
(All three are weeks with a bye-driven empty slot.) `test/winprob-copilot.test.ts` already proves the
search CAN produce a different underdog lineup on a constructed fixture, so this is a measurement of
this roster, not a dead lever -- and it agrees with the recorded replay, which found the objective
worth **-0.59pp** of team-weeks won over 1,876 real ones. Nothing here argues for changing D-whichever
default; it is evidence that the flag costs nothing to leave where it is.

---

## 4. Value against baselines

1,896 team-weeks, league 462233, 2018-2025, via `scripts/lineup-stress.mjs baselines`. Every arm
shares the same point-in-time context (`loadWeekContext`): identical roster membership, identical
availability, identical template, identical IR exclusion, identical actuals. Only the projection the
arm ranks by varies.

**The driver was cross-checked against the repo's own harness**, which is the only reason its numbers
can be quoted. `scripts/inseason-backtest-lineup.mjs --league 462233 --seasons 2018-2025` and this
independent implementation agree to the printed digit on the shared arms: floor **85.83** / gain
**-3.81**, served **89.55** / gain **-0.09**, and the bootstrap intervals overlap to within
resampling noise. A second control: the hindsight lineup recomputed here reproduces the store's own
`fact_lineup_week.optimal_pts` to a mean of **-0.011** points (max |diff| 3.50 on a single
team-week).

| arm | mean pts | vs managers | season bootstrap CI | seasons won | beats own manager |
|---|---|---|---|---|---|
| managers (what the room started) | 89.64 | -- | -- | -- | -- |
| hindsight (the ceiling) | 102.11 | +12.47 | -- | -- | -- |
| **floor** -- season line / 17 | 85.83 | **-3.81** | [-4.92, -2.72] | 0/8 | 0.380 |
| **trailing-4 form** (`t4_mean`) | 86.01 | **-3.63** | [-4.58, -2.47] | 0/8 | 0.396 |
| **served** (`WEEKLY_SERVE`) | **89.55** | **-0.09** | **[-1.26, 0.75]** | **5/8** | 0.489 |

| paired, arm vs arm | mean | season CI | seasons |
|---|---|---|---|
| served - floor | **+3.72** | [3.17, 4.36] | **8/8** |
| served - trailing4 | **+3.54** | [2.59, 4.36] | **8/8** |
| trailing4 - floor | +0.18 | [-0.68, 1.03] | 4/8 |

**Answering the question directly: yes, the model's lineup beats both cheap baselines, decisively
and in every season.** It is level with the room's real managers, and it is 12.6 points below
hindsight. And **the trailing-4 form baseline is not better than the season line** -- +0.18 with a
CI straddling zero and 4 of 8 seasons -- which is worth recording, because "just use his last four
games" is the rule a human reaches for first.

### Per season (mean points)

| season | n | managers | hindsight | floor | trailing4 | served |
|---|---|---|---|---|---|---|
| 2018 | 224 | 95.04 | 106.18 | 88.04 | 90.35 | 91.41 |
| 2019 | 224 | 90.37 | 104.58 | 87.95 | 86.09 | 90.81 |
| 2020 | 224 | 92.17 | 103.88 | 88.25 | 86.93 | 91.07 |
| 2021 | 238 | 88.59 | 101.68 | 83.79 | 83.71 | 88.51 |
| 2022 | 238 | 86.86 | 99.36 | 83.83 | 83.41 | 87.12 |
| 2023 | 238 | 88.26 | 101.51 | 84.23 | 84.69 | 89.12 |
| 2024 | 238 | 90.56 | 103.19 | 86.04 | 87.33 | 90.90 |
| 2025 | 272 | 86.28 | 97.63 | 85.03 | 85.89 | 87.97 |

### Per position: where the 12.6 points to hindsight actually are

Mean realised points of the man each arm started in that slot.

| slot | n | floor | trailing4 | served | hindsight | served's gap to hindsight |
|---|---|---|---|---|---|---|
| QB | 1,896 | 17.64 | 17.60 | **18.26** | 19.56 | -1.30 |
| RB | 1,896 | 12.90 | 13.16 | **14.04** | 17.82 | **-3.78** |
| WR | 1,896 | 11.97 | 11.54 | **12.59** | 17.58 | **-4.99** |
| TE | 1,896 | 8.03 | 8.15 | **8.29** | 9.28 | -0.99 |
| DST | 1,896 | 6.66 | 6.63 | **6.89** | 7.48 | -0.58 |
| K | 1,896 | 7.90 | 7.92 | 7.90 | 8.00 | -0.10 |
| FLEX | 3,792 | 10.37 | 10.50 | **10.79** | 11.20 | -0.41 |

Served is the best of the three arms at every slot except K, where all three tie and the ceiling is
0.10 away -- the kicker slot is, measurably, not a decision. **Two thirds of the total regret sits at
RB and WR** (-3.78 and -4.99 against -0.10 to -1.30 everywhere else), which is where the candidate
pools are deep and the week-to-week variance is largest.

### ESPN's own weekly projection: NOT TESTED historically, and why

`raw_espn_projection` holds **585 rows, all of them season 2026 week 2**. ESPN publishes a
`statSourceId=1, statSplitTypeId=1` block only for the current/upcoming scoring period;
`src/weekly/espnProjections.ts` refuses to infer one from a season total ("that would be our
arithmetic wearing ESPN's name"); and the reader requires an authenticated app bridge. So the store
accumulates only weeks somebody snapshotted before kickoff, there is no way to backfill 2018-2025,
and the arm cannot exist. This is a measurement of the table, not an assumption.

---

## 5. Calibration under stress

The served p10/p90 against the realised week, on **23,657 rostered player-weeks** (2018-2025, league
462233, every man on every roster whom the served router projected). Nominal coverage 0.80. `bias` is
mean(actual - projected), so a negative bias means the model is too high.

| cell | n | coverage | < p10 | > p90 | bias |
|---|---|---|---|---|---|
| **ALL** | 23,657 | **0.814** | 0.068 | **0.118** | -0.10 |
| QB | 2,959 | 0.817 | 0.086 | 0.098 | -0.38 |
| RB | 6,229 | **0.795** | 0.063 | **0.142** | +0.03 |
| WR | 7,307 | 0.814 | 0.069 | 0.117 | -0.24 |
| TE | 2,900 | 0.828 | 0.054 | 0.118 | -0.01 |
| K | 1,809 | **0.865** | **0.013** | 0.122 | **+0.89** |
| DST | 2,453 | 0.799 | **0.115** | 0.086 | **-0.50** |
| STARTERS (our served lineup) | 14,669 | 0.827 | 0.067 | 0.106 | +0.20 |
| BENCH | 8,988 | **0.791** | 0.070 | **0.139** | **-0.59** |
| injury-DESIGNATED (OUT/DOUBTFUL) | 771 | **1.000** | 0.000 | 0.000 | -0.28 |
| clean (no designation, no bye) | 21,627 | 0.809 | 0.062 | 0.129 | +0.45 |
| weeks 1-4 | 5,722 | 0.832 | 0.056 | 0.112 | +0.31 |
| weeks 5-17 | 17,935 | 0.808 | 0.072 | 0.120 | -0.23 |
| season 2018 | 2,812 | 0.809 | 0.064 | 0.126 | +0.03 |
| season 2019 | 2,781 | 0.808 | 0.068 | 0.124 | -0.16 |
| season 2020 | 2,783 | 0.816 | 0.075 | 0.109 | -0.37 |
| season 2021 | 3,037 | 0.798 | 0.077 | 0.125 | -0.24 |
| season 2022 | 3,006 | 0.818 | 0.078 | 0.104 | -0.41 |
| season 2023 | 2,983 | 0.826 | 0.067 | 0.107 | 0.00 |
| season 2024 | 3,078 | 0.814 | 0.067 | 0.119 | +0.02 |
| season 2025 | 3,177 | 0.818 | 0.051 | 0.131 | +0.32 |

**Overall: PASS.** 0.814 against a nominal 0.80 is slightly conservative and well inside the band the
weekly gate already enforces (0.75-0.85, `docs/weekly.md` section 7). The season axis is flat --
0.798 to 0.826 across eight seasons, with no sign of the 2018-2019 participation-feed gap moving it --
so a dark feed degrades the MEAN (measured elsewhere at -0.71 pts/lineup) without breaking the band.

**FINDING 5-a -- the band is systematically SHORT ON THE UPSIDE, everywhere.** 11.8% of weeks land
above p90 against 6.8% below p10, for a nominal 10% each side. The asymmetry is present at every
position except DST, and is worst at RB (14.2% above p90) and on the bench (13.9%). The tail this
matters for is the one that decides a start/sit: a bench player's real ceiling is further away than
the model says, which understates the case for the boom candidate over the safe one. This is the
band, not the mean -- the mean bias is -0.10 overall.

**FINDING 5-b -- the injury-DESIGNATED cell is DEGENERATE, not calibrated, and reading 1.000 as a
triumph would be the exact "silence read as agreement" failure this repo keeps hitting.** Probed
directly over 2022-2025: of **420** designated player-weeks, the realised points are **0 in 420 of
420** (range [0, 0]) and the band's **p10 is 0.000 in 420 of 420**. So `p10 <= 0 <= p90` holds
trivially and the cell measures only that the interval contains zero. It says nothing about whether
the band is right for an injured man, because there is no dispersion on either side to be right
about. The honest reading: **the availability path is doing the work here, not the band.**

**FINDING 5-c -- K is over-covered and biased high (+0.89), DST under-covered at the floor (11.5%
below p10) and biased low (-0.50).** Both positions are served the FLOOR artifact for the mean at K
and the DST matchup model at DST (`WEEKLY_SERVE`), and both fail the weekly gate's clause (a) by a
hair (2.4747 vs 2.4725 at K; 3.1334 vs 3.1328 at DST). The kicker's band is too wide and its centre
too low; the defense's band is too narrow at the bottom and its centre too high. Neither is a lineup
defect -- the per-slot table in axis 4 shows K is not a decision at all (0.10 from the ceiling) and
DST is worth 0.58 -- but a copilot that quotes a kicker's p10/p90 is quoting a band that is wrong in
a known direction.

**Where the band is wrong, the lineup's confidence is wrong.** Combining 5-a with finding 3-a: the
served bands are already wide enough that almost any starting set is inside them, and they are still
*too narrow on the upside*. The recommendation's confidence, as the summary currently presents it,
is not supported by the band it was computed from -- and the summary does not print the band.

---

## 6. Determinism and latency

| case | expected | observed | verdict |
|---|---|---|---|
| the same verb twice, same store, same week | byte-identical result and summary | identical except `assumptions.asOf` (`...T14:44:33.331Z` vs `...486Z`), which is the snapshot instant and is meant to move; the summary string is identical | PASS |
| the same verb twice, `objective: "winprob"`, seed 7 | identical | identical starters | PASS |
| `winprob` at seed 7 vs seed 8 | may differ | identical starters on this roster | PASS (and see finding 3-a) |
| `lineupRecommend` cold (first call in the process) | -- | **1 ms** | PASS |
| `lineupRecommend` warm (mean of 20) | -- | **0.1 ms** | PASS |
| `loadSimContext` (the real cost) | -- | **272 ms** | -- |
| the whole `lineup_recommend` verb, app reachable not required (`schedule: generated`) | -- | **172 ms cold, 155 ms warm** | PASS |
| the whole verb with the app UNREACHABLE (`FF_LIVE_READ_TIMEOUT_MS=1`, `schedule: auto`) | fallback fires, no hang | **404 ms**, stored-matchup fallback, message names the timeout | PASS |
| `objective: "winprob"`, 8,000 sims | -- | **18 ms** | PASS |

**NOT TESTED: the app-UP live schedule read.** The brief forbids launching, killing or driving the
running app, and `loadSimContext`'s live arm opens the league over the app's CDP port. The path that
matters for a live serve is the one that was measured: the stored-matchup fallback, which produces
the same `REAL` schedule (104 games) in 404 ms and is what the verb uses whenever the CDP port is
not answering.

---

## 7. What was changed

| file | change | test |
|---|---|---|
| `src/inseason/copilot.ts` | `assertStartersAvailable` checks every roster man of a started name and complains only when all are unavailable (D1) | `test/lineup-stress-robustness.test.ts`, four tests: both fault injections (bye and OUT still refuse), the false-positive case, and the all-out case that proves the guard was narrowed rather than disabled |
| `src/inseason/copilot.ts` | the season-line fallback is `Number.isFinite`-guarded, on **both** callers, and men with no basis at all are named in `basisNote` (D3) | two tests: the NaN case, and a control that a finite projection is untouched |
| `src/inseason/copilot.ts` | bench `reason` keyed on name+pos; the winprob bench filter consumes one seat per name rather than filtering the name out | one test: with two men of one name and one starting, both still appear |
| `src/inseason/copilot.ts` | a name filling more than one slot is flagged | one test, plus a control that the flag never appears with unique names |
| `src/inseason/lineup.ts` | the "started but not available" flag reads the seated object, not a lookup by name (D2) | one test |

Nothing else in `src/` was touched. `src/weekly/espnProjections.ts` was read only.

### Gates

* `npm run typecheck` -- clean.
* `npm test` -- 1,086 tests, 0 failing (2 skipped); 1,059 before, +27 from the two new files.
* `npm run lint` -- 46 warnings, **zero new**.
* `data/weekly-artifact.json` md5 `5aa938ecd0dc73ab68fe9a0137de3cfd`,
  `data/weekly-artifact-lineonly.json` `d2982b1c809838356bd450b8e0e3ae3f`,
  `data/dst-stream-artifact.json` `adf5069013d2f65b7328b1ae4dfd4ace` -- all unchanged.
* `npm run ff -- backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150` -- **39.5% / 96%**, per-season line byte-for-byte.
* The live store was opened READ-ONLY. Every robustness case ran on an online `db.backup()` copy in
  the scratch dir; the `ecr`-missing case ran on a second copy of that copy. The running app was
  neither launched, killed nor driven; the "app down" case used `FF_LIVE_READ_TIMEOUT_MS=1`.

---

## 8. What is left, and what could not be tested

| item | why |
|---|---|
| ESPN's own weekly projection as a historical baseline arm | impossible: the store holds 585 rows, all 2026 week 2, and ESPN publishes the projection block only for the current scoring period (section 4) |
| the app-UP live schedule read latency | the brief forbids driving the running app; the fallback path, which is what a live serve uses when CDP is unavailable, was measured instead |
| a real duplicate-name roster | none exists in either league today; the defects were found and are regression-tested on synthetic twins built from the live roster's own men |
| aligning the lineup fallback with the D18 `rosPerGame` blend (finding 2-d) | it would move the lineup -- a model change, forbidden in this pass, and it needs the D13 gate and owner sign-off |
| a lineup LOCK concept (finding 2-b) | a new capability, not a defect fix |
| reading `ownership.slot = 'IR'` (finding 2-c) | `src/draft/simContext.ts` is outside this pass's file ownership |
| naming the stale-vs-absent feed distinction in the caveat (finding 2-e) | needs an `as_of` read the coverage function does not do; a design decision, not a bug fix |
| distinguishing "unmatched" from "unscored" in the seeding caveat (finding 2-a) | `src/draft/simContext.ts`, outside ownership; one-line message change |
