# Validation harness (how we know a change is better, not a regression)

> ## TRACK A: V3 against positional replacement -- the named defect, fixed, and it was not the reason (2026-09-09)
>
> Branch `redesign/v3-qb-replacement` off `redesign/final` (`75da5b0`). Phase 3 closed with one
> bounded piece of work named: V3's analytic marginal measures a player against the STREAMING FLOOR,
> so an elite quarterback is priced by how far he beats the waiver wire, and V3 spent 31-34% of its
> budget at quarterback against a room that spends 7.8-11.2% and a SIMULATED roster-aware book that
> says 16.2%. That defect is now fixed. **It was not why V3 loses.**
>
> | | prediction | outcome |
> |---|---|---|
> | P34 | V3's QB share of an empty-roster book lands within 5 points of the simulated book's 16.2% | **FAILED, narrowly** -- 21.4%, a gap of 5.2 points (6.2 against the simulated book re-measured in the same run at 15.2%). It was 34.3% before, so the gap closed from 18.1 to 5.2 and stopped one fifth of a point short |
> | P28 (re-run unchanged) | V3's playoff rate is at least V2's minus 2 points on BOTH arms | **FAILED on both** -- long churn arm -34.78pp, honest arm -11.08pp |
> | P35 | the redundant-lever finding still holds for V2: `starterReserve` inert | **FAILED in its strong form** -- 4 vs 0 is NOT byte-identical on the long arm (16 of 1800 trials differ). The weak form holds: -0.17pp, CI [-0.44, 0.00] |
>
> ### What changed
>
> **The value term.** A dedicated STARTING slot is now measured against the last starter the league
> rosters at that position -- `starterBaselines` in `src/draft/lineupMarginal.ts`, which reproduces
> `values.ts baselines()` index for index (points-weighted FLEX allocation included; an even three-way
> split is the bug that cost 8.6pp of championships when it was fixed in `values.ts`, and reproducing
> it inside V3 would have hidden it where no existing test looks). It is recomputed from the REMAINING
> board and the room's REMAINING open slots, so it tightens as the pool empties. K, DST and every
> bench slot keep the streaming floor, because there the waiver wire really is the alternative.
>
> **The shading term.** `ourSdPrivateFor` replaces our full predictive spread with the PRIVATE part --
> our spread minus the market's shared realised error at the same rank band, floored at zero. In this
> harness that is **exactly zero at every rank**, and that is the finding rather than a bug: the
> backtest threads no per-player p10/p90 through the historical points table, so `OUR_SD_BAND` has
> always been the measured CONSENSUS dispersion, which IS the market's shared error (the same table
> `--market ecr` hands the room). Combining the two in quadrature counted one quantity twice.
>
> ### The book, on the same state, pool and price function (`scripts/roster-book.mjs`)
>
> Empty roster, twelve slots open, $200, the fifteen real opponents, the whole board as the pool,
> generated schedule, 200 trials, seed 7, 40 candidates. The script now prints V3's analytic book
> beside the simulated one it is trying to approximate -- the only way to say which of the two moved.
>
> | pos | simulated roster-aware | V3 analytic BEFORE | V3 analytic AFTER | VOR |
> |---|---|---|---|---|
> | QB | 15.2% | 34.3% | **21.4%** | 20.1% |
> | RB | 39.6% | 30.5% | 34.1% | 35.8% |
> | WR | 38.3% | 27.8% | 37.3% | 36.8% |
> | TE | 6.9% | 7.3% | 7.2% | 7.3% |
>
> Before the fix the top NINE names in V3's book were quarterbacks. After it, three of the top eight.
> Top 24 by V3 dollars, against the simulated book and VOR:
>
> ```
>   # SIMULATED (pp / $)                    V3 ANALYTIC ($)          VOR ($)
>   1 Jahmyr Gibbs        RB  31.50  200    Josh Allen (QB)     101  Bijan Robinson (RB)  91
>   2 Bijan Robinson      RB  29.00  200    Drake Maye (QB)     100  Jahmyr Gibbs (RB)    86
>   3 Puka Nacua          WR  27.00  196    Bijan Robinson (RB)  96  Ja'Marr Chase (WR)   80
>   4 Ja'Marr Chase       WR  25.00  188    Lamar Jackson (QB)   92  Jaxon Smith-Njigba   78
>   5 Jaxon Smith-Njigba  WR  25.00  188    Jahmyr Gibbs (RB)    91  Christian McCaffrey  77
>   6 Amon-Ra St. Brown   WR  25.00  188    Ja'Marr Chase (WR)   91  Puka Nacua (WR)      76
>   7 Christian McCaffrey RB  24.00  184    Jaxon Smith-Njigba   90  Amon-Ra St. Brown    66
>   8 Jonathan Taylor     RB  24.00  184    Puka Nacua (WR)      88  Jonathan Taylor (RB) 65
>   9 Drake London        WR  23.00  180    Caleb Williams (QB)  86  Drake London (WR)    64
>  10 Ashton Jeanty       RB  23.00  180    Joe Burrow (QB)      85  Trey McBride (TE)    64
>  11 Breece Hall         RB  22.50  178    Jayden Daniels (QB)  83  Josh Allen (QB)      63
>  12 Omarion Hampton     RB  21.00  172    Christian McCaffrey  83  Omarion Hampton (RB) 63
>  13 De'Von Achane       RB  20.50  170    Jalen Hurts (QB)     81  Drake Maye (QB)      62
>  14 CeeDee Lamb         WR  20.50  170    Justin Herbert (QB)  81  De'Von Achane (RB)   60
>  15 Jeremiyah Love      RB  20.00  168    Trevor Lawrence (QB) 81  Jeremiyah Love (RB)  58
>  16 George Pickens      WR  20.00  168    Amon-Ra St. Brown    78  CeeDee Lamb (WR)     57
>  17 Saquon Barkley      RB  20.00  168    Drake London (WR)    77  Brock Bowers (TE)    55
>  18 Brock Bowers        TE  19.50  150    Jonathan Taylor (RB) 73  Lamar Jackson (QB)   54
>  19 James Cook III      RB  19.50  150    Omarion Hampton (RB) 72  James Cook III (RB)  52
>  20 Trey McBride        TE  18.50  128    CeeDee Lamb (WR)     71  Ashton Jeanty (RB)   52
>  21 Chase Brown         RB  18.50  128    De'Von Achane (RB)   69  Breece Hall (RB)     51
>  22 Josh Allen          QB  17.00  117    Jeremiyah Love (RB)  68  Justin Jefferson     48
>  23 Justin Jefferson    WR  17.00  117    Justin Jefferson     64  Caleb Williams (QB)  47
>  24 Kenneth Walker III  RB  17.00  117    Trey McBride (TE)    64  A.J. Brown (WR)      47
> ```
>
> **A harness bug worth recording, because it manufactured a result.** The first cut of the V3 column
> barred the forty candidates from V3's board, copying `MarginalBook.fillExclude`. The two modules bar
> different things: V3 reads the board for its positional baseline as well as for its budget path, so
> removing the top forty players took the quarterback baseline eleven ranks too deep and re-created the
> very inflation being measured -- 27.3% QB share instead of 21.4%. The board is the whole pool, which
> is what `sim.ts` hands V3 in a real auction.
>
> ### P28, re-run unchanged
>
> Both arms exactly as registered, paired on common random numbers through
> `scripts/paired-analysis.mjs`. PLAYOFFS is the primary; the title is reported alongside.
>
> | arm | V2 playoffs | V3 playoffs | paired difference (playoffs) | V2 title | V3 title | paired difference (title) |
> |---|---|---|---|---|---|---|
> | long churn, 2012-2024, n=150, 12 seasons | 88.9% | **54.1%** | **-34.78pp**, SD 11.76, SE 3.39, t -10.25, CI [-41.33, -28.61], **0/12 seasons** | 25.5% | 8.1% | -17.44pp, SE 1.96, CI [-21.17, -13.89], 0/12 |
> | honest, 2020-2024, n=300, 4 seasons | 45.2% | **34.1%** | -11.08pp, SD 34.10, SE 17.05, t -0.65, CI [-41.75, +19.33], 1/4 seasons | 13.5% | 3.8% | -9.75pp, SE 5.57, CI [-20.67, -3.33], 0/4 |
>
> Long arm = `--bot-churn --bot-book price --full --no-lookahead --inflation --seasons 2012-2024
> --n 150`; honest arm = the same plus `--market ecr --market-noise 0 --bot-noise 0.20`, 2020-2024,
> n=300. McNemar on trial-level pairs: long arm chi2(1) 475.21, p < 1e-6 (98 V3-only against 724
> V2-only of 822 discordant); honest arm chi2(1) 36.84, p < 1e-6.
>
> **P28 FAILED on both arms and V3 still does not ship.** The rule was fixed before the run and is not
> re-specified here: a playoff rate more than two points below V2 disqualifies it. The honest arm's
> detectable effect at 80% power is 49pp on four seasons, so its interval settles nothing either way;
> the long arm's is 9.8pp on twelve, and V3 loses it by 35.
>
> **Two levels drifted from the Phase 3 record and one did not.** The long arm reproduces V2 exactly
> (88.9% / 25.5%) and reproduces the PRE-FIX V3 exactly (`FF_V3_BASELINE=off`: 53.5% / 7.3% against
> the recorded 53.4% / 7.3%, and 60.6% / 8.7% with shading off against the recorded 61% / 8.7%). The
> honest arm reads V2 at 45.2% / 13.5% against the recorded 49.0% / 14.5%, and its pre-fix V3 at 48.6%
> / 11.5% against 50.3% / 11.8% -- the paired difference reproduces in sign and rough size (+3.42pp
> here on 3/4 seasons, +1.27pp recorded) while the levels sit ~4 points low. That arm covers four
> seasons, not the five the Phase 3 table says. Every number in this section is measured on this
> branch's data and none is quoted from the record.
>
> ### Where the remaining gap sits -- the 2x2, all four cells on the same seeds
>
> Long churn arm, 2012-2024, n=150. V2 is 88.9% / 25.5%.
>
> | value term | shading | V3 playoffs | V3 title |
> |---|---|---|---|
> | waiver floor (pre-fix) | full spread (pre-fix) | 53.5% | 7.3% |
> | waiver floor | none (`FF_V3_SHADE=off`) | 60.6% | 8.7% |
> | positional replacement | full spread | 54.1% | 8.1% |
> | positional replacement | private only (SHIPPED on this branch) | **59.7%** | 10.2% |
> | positional replacement | none | 65.5% | 10.4% |
>
> **The two terms interact, which no single arm shows.** The baseline fix is worth **+0.61pp**, CI
> [-2.78, +3.89], 6/12 seasons -- a clean null -- while the old shading is on, and **+4.94pp**, CI
> [+1.72, +8.67], 8/12 seasons, t 2.69, once it is off. The old shading was over-aggressive enough to
> swamp its own value term. Shading costs 7.1pp of playoff rate against the waiver floor and 11.4pp
> against the positional baseline.
>
> **The shading fix, paired against the Step 2 V3 on the same seeds:** +5.61pp of playoffs, SD 7.31,
> SE 2.11, t 2.66, CI [+1.56, +9.50], better in 8 of 12 seasons; +2.17pp of title, CI [+0.50, +3.89],
> 9/12 seasons. Against V2 it is
> still -29.17pp, CI [-33.72, -25.33], 0/12. P28's threshold is not re-run against this number; it is
> reported as what it is.
>
> **The residual is the surrogate, and that is now the only candidate left.** Both inputs the Phase 3
> writeup named as wrong have been corrected and V3 gained 6.2 points of a 35-point deficit. What
> remains is the analytic expected-lineup-points calculation itself, against the SIMULATED marginal
> that behaves correctly. Substituting the simulated marginal for the top 40 candidates was
> considered and is **not affordable**: `scripts/roster-book.mjs` measures it at **426 ms per
> candidate** after a 4.2s budget curve, so one decision point is ~21s, one draft is ~200 of them, and
> the long arm is 1,800 drafts -- roughly 250 days of compute for one arm.
>
> ### What the bidder actually buys (`scripts/v3-roster.mjs --seeds 8 --book price --season Y`)
>
> The drafts the arbiter really scores, so these are shares of the same auctions, not of a 2026 board.
>
> | season | V2 spend / QB share | V3 spend / QB share, waiver floor | V3 spend / QB share, positional baseline | V3 starting-lineup proj, floor -> baseline |
> |---|---|---|---|---|
> | 2019 | $45 / 31% | $147 / 34% | $110 / **18%** | 1511 -> 1456 |
> | 2021 | $82 / 20% | $126 / 34% | $102 / **29%** | 1524 -> 1487 |
> | 2023 | $110 / 21% | $149 / 31% | $135 / **23%** | 1569 -> 1542 |
>
> This is the mechanism of the loss on the honest arm, and it is worth stating plainly: correcting the
> baseline shrinks every marginal, so V3 bids less, spends $25-40 less of its $200, and buys a
> measurably weaker starting lineup. The quarterback share moves the way P30 asked for and the roster
> gets worse. A bidder can be right about relative value and wrong about level.
>
> ### P35 -- `starterReserve` on the long arm
>
> `--starter-reserve 0` against the shipped 4, V2, long churn arm, 2012-2024, n=150, paired.
> **NOT byte-identical**: 16 of 1800 trial rows differ, 3 discordant on playoffs, 88.7% against 88.9%,
> mean -0.17pp, SD 0.41, SE 0.12, CI [-0.44, 0.00], and 25.6% against 25.5% on the title. The flag is
> connected (the header prints `reserve=0` and the trials move), so this is a real if tiny effect.
>
> P31's "provably inert -- byte-identical trials" was measured on the five-season honest arm and does
> not generalise to thirteen seasons of the legacy market: the soft reserve binds in about 0.9% of
> trials there. The weaker claim P31 also made -- flat within noise -- holds comfortably. **The
> recommendation to retire `starterReserve` as a dial is unaffected** (an effect of 0.17pp with an
> interval touching zero is not a knob worth exposing), but the justification must be "flat", not
> "provably dead".
>
> ### The recommendation
>
> **Keep V2 as the bidder. Keep V3 selectable, unshipped, and now with both of its named input defects
> fixed.** The arbiter has answered the same question twice with the same answer, and the second time
> it answered a strictly better version of V3. What changed is the diagnosis: it is no longer "the
> marginal prices quarterbacks wrongly" or "the shading double-counts", because both are fixed and the
> bidder still loses 29 points of playoff rate in twelve seasons out of twelve. Anyone picking this up
> should go straight at the analytic surrogate -- the gap between `lineupMarginal` and
> `rosterMarginal`, visible as the 21.4%-against-15.2% residual in the book above and now printable
> player by player from `scripts/roster-book.mjs` -- and should not spend another pass on the inputs.
> (`lineupMarginal.ts`'s header cites a `scripts/marginal-agreement.mjs` that does not exist in this
> tree; a rank-correlation harness between the two books would be the right first tool and has to be
> written.)
>
> ### Tripwire and gates
>
> ```
> npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
>   CHAMPIONSHIPS: 38.1%  (random 6.3%)  |  playoffs: 96%
>   per season: 2000:31% 2001:32% 2002:29% 2003:47% 2004:41% 2005:18% 2006:51% 2007:21% 2008:36%
>               2009:35% 2010:35% 2011:62% 2012:49% 2013:41% 2014:32% 2015:26% 2016:41% 2017:33%
>               2018:45% 2019:38% 2020:37% 2021:36% 2022:61% 2023:33% 2024:43%
> ```
>
> Identical to the final-integration line in every season, which is what "V2 is untouched" has to mean
> -- `values.ts` and `strategy.ts` are not in this branch's diff at all. `npm test` 467 tests, 465
> pass, 0 fail, 2 skipped; `npm run typecheck` clean; `scripts/v3-connected.mjs` all connected.
>
> **Every new guard was fault-injected once.** Disabling the baseline branch in `expectedWeekPoints`
> fails exactly the two assertions that target it (the QB-against-QB17 gap and the strategy-level
> "the baseline reaches the bidder") and none of the other seventeen. Dropping the subtracted term
> from `ourSdPrivateFor` fails exactly the private-component guard. The private-component guard is
> written as a subtraction rather than a zero and its own fault injection drives it to a POSITIVE
> value, because a zero that cannot become non-zero is a dead lever wearing a measured null's clothes.

> ## FINAL INTEGRATION: the two siblings merged, the leftovers closed, the new board arbitrated (2026-09-09)
>
> `redesign/final` = `redesign/phase-3-decision-layer` + `redesign/phase-2d-weekly-features`, 74
> commits off `main`. Two pre-registered predictions, P32 and P33. **Both held, and the honest
> reading is that the arm could not have failed them for anything under ten points.**
>
> | | prediction | outcome |
> |---|---|---|
> | P32 | the 2d board's playoff rate is within noise of, or better than, the 2c board's under BOTH opponent books | **HELD** -- `price` -2.50pp CI [-9.33, +2.17], 2/4 seasons; `rank` +1.67pp CI [-4.08, +8.08], 2/4 |
> | P33 | its title rate is within noise | **HELD** -- `price` -2.75pp CI [-5.25, +0.17]; `rank` -0.00pp CI [-1.75, +2.08] |
>
> ### The tripwire, and everything it reproduced
>
> ```
> npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
>   CHAMPIONSHIPS: 38.1%  (random 6.3%)  |  playoffs: 96%
>   per season: 2000:31% 2001:32% 2002:29% 2003:47% 2004:41% 2005:18% 2006:51% 2007:21% 2008:36%
>               2009:35% 2010:35% 2011:62% 2012:49% 2013:41% 2014:32% 2015:26% 2016:41% 2017:33%
>               2018:45% 2019:38% 2020:37% 2021:36% 2022:61% 2023:33% 2024:43%
> ```
>
> Identical to Phase 2c to the point in every season. Everything else on the merge, each re-run here
> rather than quoted from the branch it was measured on:
>
> | check | reproduced |
> |---|---|
> | `ff evaluate-projection --seasons 2008-2025` | RMSE **52.79** / pinball **12.02** / coverage **0.760**, P5 PASS; R-squared 0.542 vs carry-forward 0.432 |
> | `ff evaluate-weekly`, two-part | RMSE **5.268** / CRPS **2.150**, gate (a) PASS 2.1500 vs 2.6642, (b) PASS 0.798, (c) **FAIL** 0.384 vs 0.419 |
> | `ff evaluate-weekly`, the floor / baseline | season_line **5.928** / 2.671; shipped `week()` **5.927** / **2.664** |
> | odds accrual vs the calibration harness, 2025 | playoffs **0.209587**, title **0.052147**, both MATCH to six decimals |
> | `npm test` | 461 tests, 459 pass, 0 fail, 2 skipped (both conditional on a curve-only artifact; the shipped one is trained) |
> | `npm run typecheck` | clean |
> | `scripts/merge-sanity.mjs` | 34 MCP tools, 63 schema tables, no duplicate in any scope; `--self-test` fires all four checks |
> | `copilot-mcp-smoke`, `copilot-crosscheck`, `weekly-leak-audit`, `v3-connected`, `value-gates` | all pass |
>
> ### P32/P33 -- arbitrating a board the arbiter had never seen
>
> The flagless tripwire projects from ACTUALS (`projMode = "actuals"`) and never opens
> `data/projection-artifact.json`. So Phase 2d's feature admission, and the WR 37.9% -> 41.0% / RB
> 32.5% -> 29.3% dollar reallocation it caused, had reached the shipping default with no arbiter
> having an opinion about it -- which is exactly the kind of change this repo's one rule exists to
> adjudicate.
>
> Both boards, market unchanged, only OUR book swapped:
>
> ```
> backtest --projection artifact --artifact <board> --market ecr --market-noise 0 --bot-noise 0.20
>          --bot-churn --bot-book {price|rank} --full --no-lookahead --inflation
>          --seasons 2020-2024 --n 300 --dump-trials <path>
> ```
>
> **The lever is connected and the run says so in its own banner**: the 2c arm prints `9 fitted
> features` and the 2d arm `11`. That check is not decoration -- a `--artifact` flag silently ignored
> under `--market ecr` (which builds OUR book from `--artifact-dir` per-season files) would have
> produced two identical arms and a clean, meaningless null.
>
> | book | board | playoffs | title | paired (2d - 2c), playoffs | paired, title |
> |---|---|---|---|---|---|
> | `price` | 2c | **79.8%** | **21.1%** | -2.50pp, CI [-9.33, +2.17], t -0.71, 2/4 | -2.75pp, CI [-5.25, +0.17], t -1.81, 1/4 |
> | `price` | 2d | 77.3% | 18.3% | | |
> | `rank` | 2c | 70.5% | 13.0% | +1.67pp, CI [-4.08, +8.08], t +0.46, 2/4 | -0.00pp, CI [-1.75, +2.08], 1/4 |
> | `rank` | 2d | **72.2%** | 13.0% | | |
>
> Detectable effect at 80% power with four seasons: **10.2pp** of playoff rate, 4.4pp of title rate.
> Both intervals contain zero under both books and the two books disagree about the sign on playoffs,
> so P32 and P33 held in the only sense this arm can deliver: **not adjudicated.**
>
> Three caveats, all of which make the numbers weaker than they look:
>
> 1. **The point estimate goes the WRONG WAY on the price book** -- 2d trails by 2.5pp of playoffs and
>    2.8pp of title, worst in 2024 (-13pp). The trial-level McNemar on playoffs is nominally
>    significant there (chi2 4.62, p = 0.032), and reading that as the answer is precisely the mistake
>    `scripts/paired-analysis.mjs` exists to prevent: n = 300 x 4 seasons is 300 noise re-draws over
>    four seasons, and the unit of generalisation is the SEASON. The season-level interval contains
>    zero comfortably.
> 2. **Four seasons is all this arm can ever have.** `--seasons 2020-2024` under `--no-lookahead`
>    drops 2020 (no prior year inside the window), and the FantasyPros archive begins in 2020.
> 3. **Both arms carry the SAME lookahead.** Each board is one full-data artifact fitted on 1999-2025,
>    so both have seen the seasons being replayed. The contamination is identical, which makes the
>    COMPARISON fair and the LEVELS optimistic in both arms -- 79.8% playoffs here against V2's 49.0%
>    on the same arm with `--projection actuals` is that gap, not a finding. The unbiased version
>    needs per-fold artifacts for BOTH boards (`ff evaluate-projection --keep-artifacts <dir>` twice,
>    then `backtest --artifact-dir`) and has not been run.
>
> **Nothing was reverted.** The features were admitted on a projection-accuracy gate they passed
> cleanly and the championship arbiter cannot separate the boards; reverting on an underpowered null
> is the same error as shipping on one. It is recorded as an owner decision, not taken here.
>
> ### The four fenced leftovers, closed
>
> - **The lineup and the scorecard were serving DIFFERENT weekly models.** `lineupRecommend` loaded
>   `weekly-artifact-lineonly.json` and `ff scorecard` loaded `weekly-artifact.json`, each filename
>   typed inline. Both load through the same loader, both validate, both produce plausible numbers --
>   so the season's forward record was accruing for a model nobody was served from, which is the one
>   failure a scorecard cannot survive. One constant now; the challenger gets its own
>   `weekly_challenger` kind from week 2 (week 1 is frozen under the old arrangement and predictions
>   are written once). The guard requires the two kinds to DISAGREE -- asserting each equals its own
>   artifact would also pass an implementation that read one file for both -- and a "no filename
>   outside projector.ts" scan, fault-injected, found a THIRD inline reference in
>   `src/weekly/evaluate.ts`.
> - **The live season was blind.** `feat_player_week_context` held 0 rows for 2026, so the two-part
>   model's first stage would have served September on defaults meaning "everybody is healthy".
>   `ff build-live-context` writes 462 rows for week 2 from `player_status` and high-severity injury
>   `news` -- the same two feeds the copilot's OUT refusal reads -- 19 Out, 56 Questionable, 66 with a
>   positional team-mate out, `inj_feed` 1 on every row. The point-in-time rule is fault-injected in
>   both directions: a snapshot at or after a week's first kickoff belongs to the NEXT week, and week
>   1 must be empty in the TABLE, not merely in a returned count. Week 3 is correctly still blind.
>   The payoff is visible in the first dual snapshot: the three largest shipped-vs-challenger
>   divergences are men the challenger prices near zero (9.18 vs 0.61, 8.12 vs 0.26, 7.84 vs 0.03).
> - **`src/draft/models.ts`** re-quotes the season artifact (52.79 / 12.02 / 0.760, nestedLift 0.0880
>   -> 0.1100, both admitted features named with what each bought) and gains BOTH weekly artifacts
>   with their gate verdicts. Checks keyed on the thing, not the name: the required slot refuses a
>   two-part artifact, the challenger slot refuses a quantile one, and `validateModels` refuses a
>   weekly artifact of the old schema. Tested with a positive control first, then two injections.
> - **Seven tables were served by no `data-sources` key** -- `feat_player_week_model`,
>   `feat_player_season`, `feat_curve`, `feat_player_week`, `raw_espn_projection` and both scorecard
>   tables. Registering them is the whole fix, because Phase 2d had already made the renderer's node
>   list derived; verified through `ff serve` with live row counts.
>
> ### A passing guard failed, and it was right to
>
> The live builder made `test/featuresExt.test.ts`'s leakage guard fail on its first full run. That
> guard asserts every Friday injury status in `feat_player_week_context` is backed by a `raw_injury`
> filing dated at or before that Friday -- and the live rows have no filing behind them by
> construction, because a status FEED publishes a current state and one timestamp and files nothing.
>
> The two easy ways to quiet it are both worse than the fix. A threshold would also absorb a real
> leak, which is the thing the guard exists to catch. Inferring provenance from the SHAPE of `as_of`
> -- the archive writes a date, the live builder a timestamp -- makes a load-bearing distinction into
> an implicit convention held between two files.
>
> So `feat_player_week_context` gained a **`source`** column ('archive' | 'live'), and each guarantee
> is asserted against the rows that actually carry it. The archive guard keeps its back-join, scoped
> by `source`, with its NON-VACUITY count asserted inside the scope -- a scope that quietly matches
> nothing is exactly the failure a green check hides. A second test asserts the live rows' own rule:
> the snapshot must precede the week's first kickoff, and no live row may exist for a season whose
> archive carries dated filings (two builders writing one week would leave which guarantee survives
> up to run order).
>
> **Both fault-injected against the real store**, inside a rolled-back transaction: relabelling one
> live row 'archive' takes the archive guard 0 -> 1; moving one live snapshot past its kickoff takes
> the live guard 0 -> 1; both return to 0 on rollback.
>
> ### One stale claim corrected
>
> `scripts/season-calibration.mjs` was still printing "scorecard.ts writes this kind but does NOT
> score it -- the accrual is a Phase 3 gap". Phase 3 closed that gap in the same session the line was
> written. A script that keeps printing a resolved gap is how a stale claim outlives the thing it
> described.
>
> ---

> ## PHASE 3: the decision layer under an objective the model can actually see (2026-09-09)
>
> Four pre-registered predictions, P28 to P31. **Two held, one held on one arm and failed
> catastrophically on the other, and one failed outright.** Nothing was re-specified after the fact
> and nothing was tuned to make one hold. The failure is the finding: a bidder derived from first
> principles, with every hand-tuned lever removed, loses to the hand-tuned one by 35 points of playoff
> rate on thirteen seasons.
>
> | | prediction | outcome |
> |---|---|---|
> | P28 | V3's playoff rate is at least V2's minus 2 points under BOTH arms | **FAILED** -- held on the honest arbiter (+1.3pp), lost by **35.5pp** on the long churn arm |
> | P29 | V3's title rate is within noise of V2's | HELD at the season level (-2.7pp, CI [-14.7, +7.1], t = -0.43) on the honest arbiter; not on the long arm |
> | P30 | V3's QB share of spend is at least 3 points LOWER than V2's | **FAILED** -- it is 3 to 14 points HIGHER |
> | P31 | at least three V2 levers are flat within noise under the honest arbiter | HELD -- `starterReserve`, `premium`, `maxShare` |
>
> **THE HEADLINE THIS IS MEASURED AGAINST IS UNCHANGED.** `--full --no-lookahead --inflation
> --seasons 1999-2024 --n 150` still returns **38.1% / 96%** with the Phase 2c per-season line
> reproduced to the point. V2 remains the default bidder, `DEFAULT_LEVERS` is untouched, and no
> recorded decision is reversed.
>
> ### The objective, and why it changed
>
> P(title) = P(playoffs) x P(title | playoffs). Phase 2c scored this simulator against 114 real
> team-seasons and found measurable skill on the FIRST factor (Brier 0.2370 against a uniform 0.2451)
> and none on the second (0.0659 against 0.0652 -- worse than knowing nothing). Single elimination
> among seven makes the second factor nearly uniform, and eight titles in 114 team-seasons is almost
> no signal to fit against. **Every in-season recommendation in this repo was ranked on the factor the
> model cannot predict.** Optimising a quantity a model cannot predict optimises its noise.
>
> So the objective is now: **PRIMARY** the change in P(playoffs); **SECONDARY** expected optimal-lineup
> points in the three fantasy playoff weeks; **ALONGSIDE** the change in P(title), computed and printed
> on every row and never used alone. Every result carries an `objective` block naming which, and the
> caveat sentence each summary ends with names it too.
>
> ### Step 1 -- roster-aware value
>
> `src/draft/rosterMarginal.ts` measures what a player adds to a REAL roster state by simulating with
> and without him under common random numbers, and converts the marginal to dollars by inverting a
> measured BUDGET CURVE -- the P(playoffs) the remaining money buys when it fills the remaining slots
> from the remaining pool. That inversion is the shadow price; live inflation, budget pressure, the
> starter reserve and the concentration cap are all consequences of it rather than four separate
> levers.
>
> The decision state for the table below: our roster EMPTY with all twelve slots open and $200, the
> other fifteen teams the league's real 2026 rosters, the pool the whole board, the generated
> schedule, 40 candidates, 300 trials, seed 7.
>
> | # | roster-aware | pos | pp of P(playoffs) | $ | titlePp | wk15-17 pts | VOR book | $ |
> |---|---|---|---|---|---|---|---|---|
> | 1 | Jahmyr Gibbs | RB | 27.00 | 194 | 6.00 | 25.8 | Bijan Robinson | 91 |
> | 2 | Bijan Robinson | RB | 24.67 | 182 | 5.33 | 26.4 | Jahmyr Gibbs | 86 |
> | 3 | Ja'Marr Chase | WR | 24.00 | 179 | 6.67 | 21.5 | Ja'Marr Chase | 80 |
> | 4 | Puka Nacua | WR | 22.67 | 172 | 5.33 | 20.7 | Jaxon Smith-Njigba | 78 |
> | 5 | Amon-Ra St. Brown | WR | 22.33 | 170 | 4.33 | 17.7 | Christian McCaffrey | 77 |
> | 6 | Jaxon Smith-Njigba | WR | 22.00 | 169 | 4.33 | 21.2 | Puka Nacua | 76 |
> | 7 | Jonathan Taylor | RB | 21.67 | 167 | 4.00 | 20.8 | Amon-Ra St. Brown | 66 |
> | 8 | Ashton Jeanty | RB | 19.67 | 136 | 2.00 | 16.6 | Jonathan Taylor | 65 |
> | 9 | Christian McCaffrey | RB | 19.33 | 131 | 2.00 | 22.2 | Drake London | 64 |
> | 10 | Drake London | WR | 19.33 | 131 | 5.67 | 18.6 | Trey McBride | 64 |
> | 11 | Omarion Hampton | RB | 19.00 | 128 | 2.67 | 20.0 | Josh Allen | 63 |
> | 12 | Brock Bowers | TE | 18.67 | 125 | 5.67 | 16.2 | Omarion Hampton | 63 |
> | 18 | Lamar Jackson | QB | 16.33 | 102 | 3.67 | 12.1 | Lamar Jackson | 54 |
> | 21 | Josh Allen | QB | 15.00 | 93 | 3.67 | 15.1 | Breece Hall | 51 |
>
> **Positional share of the book, over the same 40 candidates:**
>
> | | QB | RB | WR | TE | K | DST |
> |---|---|---|---|---|---|---|
> | roster-aware | **16.2%** | 38.4% | 37.8% | 7.6% | 0.0% | 0.0% |
> | VOR | 20.1% | 35.8% | 36.8% | 7.3% | 0.0% | 0.0% |
> | the room, historically | 7.8-11.2% | 38.1%+ | -- | -- | -- | -- |
>
> The QB share falls by 3.9 points toward the room's and RB rises toward the room's floor. It was not
> forced -- there is no positional term anywhere in the module.
>
> **Cost.** 40 candidates at 200 trials: a one-off budget curve of 4.1s per decision state, then
> **425 ms per candidate**; at 300 trials, 6.0s and 555 ms. The target was under 400 ms and 200 trials
> misses it by 25 ms on this machine; 150 trials would meet it at the cost of resolution. Both numbers
> are the measured wall time of `scripts/roster-book.mjs`, which times the fixed and per-candidate
> costs separately because they are paid at different moments.
>
> **Three defects the tests found, each of which produced a plausible number:**
>
> - the baseline fill reached for the CANDIDATE itself (the fill is greedy over the same pool), so
>   every marginal was zero by construction -- the best QB in the pool priced at 0.00pp filling an
>   EMPTY quarterback slot while pricing at +7.33pp as a backup;
> - the dollar conversion linearised a violently convex curve and priced Ja'Marr Chase at **$406 in a
>   $200 auction**;
> - the fill rule sorted on raw season points and bought FOUR bench quarterbacks, because no receiver
>   out-scores a quarterback on the raw curve.
>
> ### Step 2 -- the derived bidder
>
> V3 (`src/draft/strategyV3.ts`, `FF_STRATEGY=v3`) is three terms and no tuned constants: the
> roster-aware marginal in expected starting-lineup points (analytic, because a simulated marginal per
> bid is ten million season simulations and cannot be backtested); a price from inverting the analytic
> budget path; and a winner's-curse shading derived from dispersion and the number of live bidders.
> `benchDiscount`, `posMult`, `maxShare`, `starterReserve` and `premium` are NOT applied.
>
> | arm | V2 playoffs | V3 playoffs | paired difference | V2 title | V3 title | paired difference |
> |---|---|---|---|---|---|---|
> | honest arbiter, 2020-2024, n=300 | 49.0% | **50.3%** | +1.27pp, CI [-24.1, +22.0], 3/5 seasons | 14.5% | 11.8% | -2.67pp, CI [-14.7, +7.1], 2/5 |
> | long churn arm, 2012-2024, n=150 | 88.9% | **53.4%** | **-35.50pp**, CI [-41.6, -30.8], **0/12 seasons** | 25.5% | 7.3% | -18.22pp, CI [-21.4, -14.8], 0/12 |
>
> Honest arbiter = `--market ecr --market-noise 0 --bot-noise 0.20 --bot-churn --bot-book price`; long
> arm = `--bot-churn --bot-book price`, legacy market. Both with `--full --no-lookahead --inflation`,
> both paired on common random numbers through `scripts/paired-analysis.mjs`, which now reports
> PLAYOFFS as well as the title.
>
> **P28 FAILED and V3 does not ship.** The rule was decided before the run: a playoff rate more than 2
> points below V2 disqualifies it. On the five-season honest arbiter V3 is fractionally ahead, and
> that arm's detectable effect at 80% power is 39pp -- it cannot adjudicate anything of this size. On
> thirteen seasons, where the detectable effect is 8.5pp, V3 loses in every single season.
>
> **Where the loss comes from, measured rather than guessed.** Two sensitivity arms on the long arm:
>
> | V3 variant | playoffs | title |
> |---|---|---|
> | full shading (uncertainty + market spread) | 53.4% | 7.3% |
> | market spread only (`FF_V3_OURSD=0`) | 60% | 9.4% |
> | no shading at all (`FF_V3_SHADE=off`) | 61% | 8.7% |
> | V2 | 88.9% | 25.5% |
>
> Shading explains about 7 of the 35 points; **the value term explains the rest**. The winner's-curse
> correction is over-aggressive because our predictive uncertainty is largely SHARED with the room --
> a shared error moves every bid together and the winner is not selected on it -- so combining it in
> quadrature with the market's private spread double-counts. But fixing that does not rescue V3. An
> analytic expected-lineup-points marginal, priced against a budget path, simply picks a worse
> championship roster than a VOR book with a FLEX-weighted baseline, and it does so consistently.
>
> **P30 FAILED, in the opposite direction to the prediction.** Our positional spend over the drafts
> the arbiter actually scores (`scripts/v3-roster.mjs --season Y`, 8 seeds, price book):
>
> | season | V2 spend | V2 QB share | V3 spend | V3 QB share |
> |---|---|---|---|---|
> | 2019 | $45 | 31% | $147 | 34% |
> | 2021 | $82 | 20% | $126 | 34% |
> | 2023 | $110 | 21% | $149 | 31% |
>
> The reason is the same one VOR was invented for: an expected-points marginal measured against a
> STREAMING FLOOR prices an elite quarterback by how many points he beats the waiver wire by, which is
> large; VOR prices him by how much he beats the seventeenth quarterback, which is what a one-QB
> league actually pays for. The roster-aware book gets this right when it is computed by SIMULATION
> (16.2% QB share, Step 1) and wrong when computed by the analytic surrogate the bidder can afford.
> **That gap between the two, not the arbiter, is the honest reason V3 loses.**
>
> **Connectedness, both directions** (`scripts/v3-connected.mjs`): zero uncertainty returns EXACTLY 1
> shading; 16 bidders shade to 0.292 where 2 bidders shade to 1.000; one bidder carries no curse; the
> bid moves with the budget ($200 -> $24, $100 -> $25) and never exceeds it; a thin pool bids $58 for
> the same man a rich pool bids $24 for; the same quarterback is bid $24 into an open slot and $0 as a
> backup.
>
> ### P31 -- which V2 levers are redundant under the honest arbiter
>
> Each swept against the shipped V2 arm on the same seeds, 2020-2024, n=300, paired:
>
> | lever | setting | playoffs | paired difference | title | verdict |
> |---|---|---|---|---|---|
> | `starterReserve` | 4 -> 0 | 49.0% | **0.00pp**, CI [0.00, 0.00] | 14.5% -> 14.5% | **DEAD in this arm** -- byte-identical trials |
> | `premium` | 2 -> 0 | 49.1% | +0.07pp, CI [-4.5, +6.0] | 14.5% -> 15.0% | flat |
> | `maxShare` | 0.25 -> 0.50 | 47.9% | -1.07pp, CI [-3.6, +0.7] | 14.5% -> 14.0% | flat |
> | `benchDiscount` | 0.25 -> 1 (off) | 43.4% | -5.60pp, CI [-16.7, +3.5], 1/5 seasons | 14.5% -> 11.0% | the one that is doing work |
>
> **P31 HELD**, and `starterReserve` is the strongest form of it: at `aggr 0.7` the soft reserve never
> binds in this arm, so the two configurations produce IDENTICAL trials. Three of the five levers V3
> was built to make unnecessary were already unnecessary. `benchDiscount` is the exception and its
> interval still contains zero on five seasons -- it was measured on 25.
>
> ### Step 3 -- the in-season policy
>
> `waiverTargets`, `tradeCheck`, `tradeFinder`, `depthRisk` and `handcuffs` now report all three
> numbers, rank on the primary, and compute the noise floor for the primary. All three deltas come
> from ONE simulation of each state, so a playoff delta and a playoff-week delta can never be two
> samples correlated after the fact -- the trap this repo has already paid for once.
>
> **THE REGIME THRESHOLD, derived from the calibration rather than chosen.** The reliability table over
> 114 team-seasons:
>
> | predicted playoff band | n | mean predicted | realised |
> |---|---|---|---|
> | 5-15% | 2 | 8.3% | 0.0% |
> | 15-30% | 13 | 24.1% | 23.1% |
> | 30-50% | 71 | 41.3% | 47.9% |
> | 50-70% | 27 | 58.0% | 40.7% |
> | 70-100% | 1 | 74.4% | 100.0% |
>
> The first bin whose realised playoff rate exceeds 85% is 70-100%, so the threshold is **70%**. Two
> things have to be said with it: **that bin contains one team-season**, and the band below it is the
> largest miscalibration on the page (58% predicted, 41% realised), which argues for putting the switch
> above the miscalibrated band rather than inside it. It is exposed on `seasonOdds().objective` so a
> reader can disagree with it explicitly instead of by accident.
>
> Above it the primary becomes playoff-week strength. The fixture test shows why: with the seed
> settled, every candidate's playoff delta is **0.00pp** -- a tool still ranking on that quantity is
> ordering a list of zeroes -- while playoff-week points separate the same four candidates by 33.
>
> ### Step 4 -- the odds accrual
>
> `scorecard.ts` had a snapshot path for the `odds` kind and no scoring path. It has one now, and it
> is checked against the calibration harness rather than against a reimplementation of itself: handed
> the exact probabilities `scripts/season-calibration.mjs` produced for 2025, it reproduces that
> harness's per-season figures to six decimals.
>
> | 2025, 16 teams, 7 berths | accrual scorer | calibration harness | uniform floor | skill |
> |---|---|---|---|---|
> | playoffs | 0.209587 | 0.209587 | 0.246094 | +14.8% |
> | title | 0.052147 | 0.052147 | 0.058594 | +11.0% |
>
> Control: rotating which team got which outcome scores 0.257045 against the honest 0.209587, so the
> join is real. **Nothing writes 2025 odds into `scorecard_prediction`** -- those probabilities are
> computed now, after the season, and recording them would be exactly the thing the write-once rule
> exists to prevent. The 32 frozen 2026 rows stay unscored and `ff scorecard` says why: *"2026 has not
> resolved: 0/16 teams settled ... an in-progress season's placeholder rank looks exactly like a
> result."*
>
> ### The recommendation, for the owner to take or leave
>
> **Keep V2 as the live bidder.** The derived bidder is a better description of the problem and a
> worse answer to it, and the arbiter said so in twelve seasons out of twelve.
>
> **Change the in-season unit of measure, which this phase already does.** That one is not a close
> call: the tools were ranking on a quantity measured to be worse than a coin flip.
>
> **Consider retiring `starterReserve` and `premium`** as separately tunable levers -- not because V3
> replaced them, but because P31 measured them flat and `starterReserve` provably inert at the shipped
> `aggr`. That is a decision for the owner and `DEFAULT_LEVERS` is untouched here.
>
> ---

> ## PHASE 2D: availability in the weekly model, features admitted by the gate (2026-09-09)
>
> Six pre-registered predictions, W4-W6 and P25-P27. **Three held and three failed.** The two gates
> ran as written and one of them refused a model that beats every baseline on every accuracy metric
> by a wide margin, on a calibration clause it missed by five thousandths. Nothing was re-specified
> and nothing was tuned to make it pass.
>
> | | prediction | outcome |
> |---|---|---|
> | W4 | the two-part model's lineup gain is at least 5 points per lineup on deep-18 | **HELD** -- 6.08 (72.31 vs 66.22) |
> | W5 | its predicted zero-week share matches actual within 3 points, pooled and per position | **FAILED** -- 0.035 pooled; RB 0.031, WR 0.039, TE 0.074 |
> | W6 | `implied_team_total` carries a larger coefficient than `dvp_mult` at every position | **FAILED** -- `dvp_mult` is larger at all four fitted positions |
> | P25 | at least one screen survivor improves pooled CRPS with coverage in band | **HELD** -- two do |
> | P26 | for QB, carries per game beats rushing yards per game | **FAILED** -- rushing yards is the stronger; neither survives |
> | P27 | ADP relative to ECR does NOT survive -- the same consensus twice | **HELD** -- rho +0.004, p 0.90, n 810 |
>
> ### The weekly gate, applied as pre-registered, on two models
>
> The Phase 2c gate failed on POOLED coverage at 0.876 for a reason that was not about calibration:
> the clamp floor is exactly 0, p10 sits on the zero atom, an actual of 0 is therefore always inside
> [0, p90], and 41.9% of the scored rows are zeros. No improvement in a model can bring that inside
> [0.75, 0.85] -- only making it worse about zeros can. The band was corrected **before this run and
> against the previous run's numbers**, and the atom was moved out of the coverage figure and graded
> directly:
>
> > **(a)** pooled CRPS beats the shipped baseline; **(b)** coverage CONDITIONAL ON pts > 0 in
> > [0.75, 0.85] pooled and [0.70, 0.90] per position; **(c)** the predicted share of zero weeks is
> > within 3 points of actual, pooled and per position.
>
> Clause (c) needed a number no model here published. `predZeroProb` reads it off the ladder each
> model *does* publish, inverting the quantile function at 0 with the artifact's own clamp floor as
> the q=0 anchor -- and the consequence is the point: **a quantile-head model whose p10 sits on the
> atom claims P(zero) = 0.10 and cannot claim more**, because 0.10 is the smallest level it
> publishes.
>
> 14 held-out seasons, 112,782 player-weeks, same folds and baselines for both models:
>
> | clause | quantile heads (2c's features) | two-part (with availability) |
> |---|---|---|
> | (a) pooled CRPS vs shipped `week()` 2.664 | **PASS** 2.314 | **PASS** 2.150 |
> | (b) cov(>0), pooled / per position | **PASS** 0.813 / all in band | **PASS** 0.798 / all in band |
> | (c) zero-share within 0.03 | **FAIL** off by 0.287; outside at all 6 | **FAIL** off by 0.035; RB 0.031, WR 0.039, TE 0.074 |
> | | RMSE 5.474, deep-18 70.77 | RMSE 5.268, deep-18 72.31 |
>
> **Both failed. The season-line-only artifact keeps shipping**, exactly as before Phase 2d, and
> `lineupRecommend` is unchanged.
>
> The two failures say opposite things and that is why the clause was worth writing. The quantile
> model misses by 0.287 because it *cannot say the number*. The two-part model misses pooled by
> **0.035 against a tolerance of 0.030** -- it can express the atom and is not yet calibrated on it,
> which is a bounded next job (the first stage is a plain logistic and its intercept is the only
> thing between 0.384 and 0.419). The tolerance is not widened to 0.04. A tolerance chosen after
> seeing 0.035 is not a tolerance.
>
> ### W4 settles the question W2 left open
>
> Phase 2c's W2 failed and the recorded reading was that the gain came from in-season form rather
> than from anything the prediction was about -- because the table had no availability column to test
> the availability claim with. It has one now, and adding those columns **alone**, on the same folds
> against the same baseline, moves the deep-18 lineup from +4.55 to **+6.08** points over the shipped
> path. Availability is worth about **1.5 points per lineup per week** on top of form and matchup. It
> is the largest single effect this track has measured.
>
> What the first stage learned, logit coefficients on standardised columns:
>
> | position | `inj_out` | `inj_doubtful` | `prac_dnp` | next largest |
> |---|---|---|---|---|
> | QB | +3.38 | +2.67 | +2.38 | `prac_limited` +1.36 |
> | RB | +4.91 | +3.96 | +1.75 | `td_games` -1.76 |
> | WR | +5.18 | +3.17 | +1.62 | `td_games` -1.42 |
> | TE | +3.95 | +2.85 | +1.88 | `td_games` -1.34 |
>
> ### W6 failed against the RECORD, not against a guess
>
> The recorded belief is that defence-versus-position is small (legacy calibration: talent alone
> 0.717 correlation, +0.013 from DvP) and that the market's implied team total should dominate it. On
> the fitted mean head -- both features centred and scaled by their own training standard deviation,
> so the coefficients are comparable in units of a one-sigma move -- `dvp_mult` is the **larger** of
> the two at all four fitted positions: QB 0.061 vs 0.036, RB 0.081 vs 0.033, WR 0.049 vs 0.032, TE
> 0.049 vs 0.041. Two honest readings and this measurement does not separate them: the DvP built here
> is a shrunk, prior-blended, point-in-time multiplier rather than the raw season table the legacy
> calibration used, so it may simply be the better-constructed feature; or `implied_team_total` is
> largely redundant with `spread_line` and `total_line`, which sit in the same fit, and the three are
> splitting one effect. Either way, the record's claim as stated is not what the model does.
>
> ### The screen was measuring less than it looked like it was measuring
>
> Two defects, the same shape -- **a candidate that never reached a test, reported identically to one
> that was tested and measured nothing**:
>
> 1. The distinct-value floor was **8**, which silently excluded every BINARY candidate the sweep has
>    ever derived (`changedTeam`, `divShare`, `contract_year`) and any coarse ordinal. Spearman is
>    well defined with ties and Fisher-z is ample at n > 150; only a constant column has nothing to
>    correlate. Lowered to 2, it surfaced **the two strongest candidates in the whole sweep** --
>    `depth_rank_sep1` at rho -0.186 and `contract_year` at -0.124, against a previous best of +0.105.
> 2. `player_sk` is **TEXT** in `feat_player_season` and **INTEGER** in `feat_player_season_ext`, so
>    the ADP-versus-ECR derivation's `===` matched nothing and produced **0 rows** -- a candidate with
>    no test, indistinguishable from a null. The other extension columns joined fine because a
>    template-literal key coerces both sides.
>
> The sweep now prints a **NOT SCREENED** block naming every candidate that reached no test and why.
> Three still do: `injury_status_sep1` is 100% NULL (0 of 8,021 rows), and `rookieDraftPick` /
> `rookieDraftRound` have **0 rows by construction** -- the residual universe is players with a
> prior-season finish rank and a rookie has none. The owner's question about rookie draft capital
> cannot be answered by this screen at all, and that is the answer, not a null.
>
> ### The admission trace
>
> Each candidate re-measured under the full nested evaluation, one at a time, in survivor order --
> never on the residuals it was screened against. Keep-rule pre-registered: pooled CRPS improves AND
> coverage stays in band.
>
> | step | RMSE | pinball | coverage | verdict |
> |---|---|---|---|---|
> | baseline (2c's nine features) | 54.17 | 12.31 | 0.759 | -- |
> | `+ depth_rank_sep1` | **52.79** | **12.03** | 0.761 | **ADMIT** |
> | `+ contract_year` | 52.79 | **12.02** | 0.760 | **ADMIT** |
>
> Per position with both admitted, against baseline: **QB 76.8 vs 82.4**, RB 61.9 vs 62.4, WR 49.7 vs
> 49.6, TE 36.5 vs 36.9. Almost all of it is at quarterback, which is where a September depth chart
> says the most: a starter is a starter and a backup scores nothing, and a curve indexed on last
> year's finish cannot see a job change.
>
> `contract_year` clears the rule by **0.01 of pinball** with RMSE unchanged and coverage a thousandth
> worse. It is admitted by the letter of a rule that has no effect-size floor, and it is recorded that
> way rather than dressed up. A keep/drop rule with no minimum effect will eventually admit noise.
>
> **The board moved and the arbiter has not seen it.** Top-12 goes from twelve quarterbacks to eleven
> plus Bijan Robinson; the value book's dollar share shifts WR 37.9% -> 41.0% and RB 32.5% -> 29.3%.
> The QB share does **not** close the Phase 2c gap -- 16.4% -> 16.7% against a room maximum of 11.2%
> -- and no positional multiplier was added. The flagless championship backtest projects from actuals
> and does not read this artifact, so it is unchanged and has told us nothing about this board; a
> value decision on it needs `backtest --projection artifact --artifact-dir <per-fold>` first.
>
> ### Coverage, and three things the feeds cannot do
>
> - **`report_status_wed` / `practice_status_wed` are empty** -- 11 and 389 values across 133,892
>   player-weeks, because the feed's dated filings land at kickoff minus two or later. Phase 2d set
>   out to declare them and reports their emptiness instead. A model fitting an intercept on 0.008% of
>   its rows would have produced "Wednesday practice status did not help", a fact about the feed
>   dressed as a fact about football.
> - **From 2025 the injury feed publishes no report DATE.** An undated filing cannot be placed on
>   either side of a cutoff, so all 6,068 of 2025's are dropped and every injury column reads NULL.
>   `inj_feed` is 0 for exactly those league-weeks, so the model knows it is blind rather than
>   concluding the league was healthy.
> - **The live season has no availability at all**: `feat_player_week_context` holds no 2026 rows, so
>   the two-part first stage would serve 2026 on its declared defaults. Running `ff build-features-ext`
>   for 2026 is a data-track job and is not done here.
>
> ### Guards added, each fault-injected once
>
> - `weeklyGate` -- every clause exercised twice, once with an input that must fail it and once with
>   an input that must pass, plus a whole-gate positive control. A gate nothing can ever pass would
>   have kept the floor shipping forever while looking rigorous.
> - The leakage guard gained its missing half: ten columns NULL everywhere would satisfy "nothing
>   moved" without being wired to anything, so the fixture now seeds `feat_player_week_context` and
>   asserts the **complement** -- week *w*'s injury report must move week *w*'s availability columns
>   and must not touch *w+1*, while week *w*'s RESULTS still must not move any of them. It found a
>   real bug on its first run: the fixture's synthetic `player_sk` was the string `P0`, the block
>   joins on the numeric surrogate key, and all ten columns were silently NULL.
> - `scripts/weekly-leak-audit.mjs` audits `inj_out` and `teammates_out` against an independent
>   recomputation from `raw_injury`, parameterised by the cutoff: **5** mismatches at the Friday bound
>   against **30** with the bound moved to kickoff, and **0** against the context table it is built
>   from. The bound on the first is 0.5% and not zero because this recomputation resolves through the
>   gsis crosswalk alone while the builder also falls back on name+position+team -- an independent
>   implementation that agreed to the last row would be the same implementation. The discriminating
>   assertion is the ratio, not the count.
> - `test/dag-derivation.test.ts` -- remove two nodes and the unplaced-asset guard must name both,
>   then return empty again with them restored.
>
> ### The arbiter, unchanged
>
> ```
> npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
>   CHAMPIONSHIPS: 38.1%  (random 6.3%)  |  playoffs: 96%
> ```
>
> Identical to Phase 2c, and it should be: the flagless arbiter projects from **actuals**
> (`projMode = "actuals"`), so it never reads `data/projection-artifact.json` and nothing in this
> phase touched `src/draft/`. That is worth stating rather than assuming, because it is also the
> reason the arbiter has said nothing at all about the new board -- a 3-point dollar-share
> reallocation from RB to WR is exactly the kind of change this repo's one rule exists to arbitrate,
> and it has not been arbitrated. `--projection artifact --artifact-dir <per-fold artifacts>` is the
> run that would.
>
> ### Left undone, deliberately
>
> - **`src/draft/models.ts` is not updated.** The registry entry for the projection artifact still
>   quotes the Phase 2c numbers (54.32 / 12.39 / 0.764 and the pre-rekey figures) and carries no
>   weekly entry. `src/draft/**` is outside this phase's file fence. What it needs: `nestedLift` and
>   the P5 line re-quoted to **RMSE 52.79 / pinball 12.02 / coverage 0.760** with `depth_rank_sep1`
>   and `contract_year` named, and a `weekly` entry recording that the two-part artifact failed clause
>   (c) and the floor ships.
> - **`feat_player_week_model` is not in the engine's `data-sources` registry**, so it is still
>   invisible on the Data page. The derivation places it the moment it is registered (asserted by
>   test), and registering it is one line inside `cmdServe` -- also outside the fence.
> - **The two-part artifact is not promoted to `lineupRecommend`**, correctly, because it failed its
>   gate. Note that `ff scorecard` reads `data/weekly-artifact.json` and therefore WILL freeze 2026
>   predictions with the two-part model while the lineup serves the floor. That split predates Phase
>   2d and is defensible for a measurement surface, but it should be decided on purpose.
>
> ---

> ## PHASE 2C: one key space, real outcomes, and the honest arbiter (2026-09-09)
>
> Eleven pre-registered predictions, P10 to P20. **Seven failed and four held.** The failures carry
> the content: each one says, in a different place, that a number is only as good as the join, the
> season range or the opponent behind it. None was re-specified after the fact, and nothing was tuned
> to make one hold.
>
> | | prediction | outcome |
> |---|---|---|
> | P10 | draft-pick and participation resolution each rise 15+ points | **FAILED** -- 49.1% -> 48.7% and 75.4% -> 75.4% |
> | P11 | price LOSO MAE on 2018-2025 at or below $4.32 | **FAILED** -- $6.38 |
> | P12 | 2026 holdout MAE <= $5.00, top-12 bias within +/-$3 | **FAILED** -- $7.07, +$4.3 |
> | P13 | price beats rank on 2026 by >= $2 of MAE | **FAILED** -- it LOSES by $1.48 |
> | P14 | per-owner profiles still carry no out-of-sample signal | HELD |
> | P15 | the simulator's playoff Brier beats uniform | HELD |
> | P16 | its title Brier beats uniform | **FAILED** -- 1.0% worse than uniform |
> | P17 | the simulator is over-confident at the top | HELD |
> | P18 | honest-arbiter title rate in [12%, 26%] | HELD -- 14.5% |
> | P19 | aggr 0.7 beats 1.0 there by >= 4 points | **FAILED** -- +1.0pp, CI [-3.7, +5.9] |
> | P20 | book ordering by our title rate is vor > rank > price | **FAILED** -- it is rank > price > vor |
>
> ### Step 0 -- identity reconciliation: the store held two key spaces
>
> `stg_player` called `resolveOrMint` with an EMPTY id bag and no birthdate, so every match attempt
> fell through to the "name + position among rows that also have no birthdate" branch -- which misses
> every registry row, because registry rows all carry a birthdate. Staging therefore MINTED a key for
> almost everybody, and anything resolving through `player_xref` joined nothing, silently, while
> reporting a healthy resolution rate. **A rate measures whether a key was found, never whether it
> means anything to the table it will be used against.**
>
> | | before | after |
> |---|---|---|
> | shared gsis ids agreeing on `player_sk` | 59 / 7,961 | **7,939 / 7,939** |
> | `player_identity` rows | 22,814 | 12,122 |
> | `stg_player` rows | 11,966 | 12,122 |
> | keys staging minted for itself | 10,897 | **39** (the board-only players) |
> | how staging decided identity | `minted` 10,897, `name+pos` 1,232 | gsis 7,940, pfr 1,559, name+birthdate 1,446, name+pos 818, espn 231, sleeper 85, fantasypros 11, minted 39 |
>
> Four things had to move together, and three of them are defects in their own right:
>
> 1. **The id bag and the birthdate are passed.** The registry decides; it wins every tie-break, per
>    `docs/data-layers.md`, and the previous staging key is never consulted.
> 2. **An ambiguous raw key is EXPANDED, not read collapsed.** `player_ids` resolves a
>    (name_key, position) two men share by NULLing every field they disagree about and keeping both
>    sides in `player_ids_variant`. Read alone it can produce at most ONE key for the pair -- the merge
>    the layer exists to prevent, arrived at from the raw side. Marvin Harrison Jr.'s gsis was sitting
>    on a row carrying his father's 1973 birthdate. `crosswalkPeople()` expands them and is shared by
>    the registry and staging, because two readers that disagree about how many people a key is are
>    how the spaces diverged in the first place.
> 3. **The TEAM vocabulary was never conformed.** The crosswalk writes SFO/NEP/GNB and everything else
>    writes SF/NE/GB, so every consumer using team as a discriminator silently lost it: `pickStaged`
>    had no usable staged row for Christian McCaffrey and his age fell back to the name-keyed bio
>    table -- the exact join this layer removes, defeated by a spelling. `normTeam` now sits beside
>    `normPos`.
> 4. **`pfr` joined the crosswalk** and `stg_player.pfr_id` with it, retiring the parallel route that
>    mapped a per-person id through (name_key, position) and had to refuse for anyone sharing a name.
>
> The board's `player_sk` and its AGE now come from the SAME `pickStaged` decision; the name-only
> fallback is gone and unresolved is a counted, named state (516/523, the seven listed by name).
>
> **`identity_rekey`.** 11,966 old keys -> 3 unchanged, 11,946 moved, 14 merged, 3 split, 0 dropped,
> with the reason DERIVED from the shape of the mapping rather than asserted. Marvin Harrison is three
> staged rows (the son at 2002 with the son's gsis, the Hall of Famer at 1972-08-25 out of Syracuse,
> and a third man the crosswalk lists at 315lb out of TCU); both Justin Jeffersons and both Lamar
> Jacksons are two.
>
> **The frozen table was migrated, never regenerated.** `scorecard_prediction` is write-once and its
> `subject` IS a `player_sk` for the player kinds. Season subjects joining staging went **63/490 ->
> 490/490** and weekly **308/2,389 -> 2,389/2,389**, with the row count unchanged at 3,077 and
> `raw_espn_projection` untouched at 577 (it is keyed by ESPN id). Two defects surfaced doing it:
> migrating the `odds` kind through a player map rewrote TEAM ids and was caught only by a UNIQUE
> constraint (**a numeric column is not a key space**); and because the old and new spaces OVERLAP,
> the first cut was order-dependent (five real moves reported as collisions) and not idempotent (a
> second run walked every row one more step, onto a different man). Both are fault-injected.
>
> **And a defect in every feature builder, which the rekey exposed.** They all upsert on a key that
> CONTAINS the surrogate key, so a rebuild after the keys moved could not reach the old rows and added
> the new ones beside them: `feat_player_season` 17,189 -> **33,086** and `feat_player_week` 287,632 ->
> **553,900**, with every per-season count still looking right. Each builder now replaces the season
> it rebuilds.
>
> #### Row counts through the rebuild
>
> | table | before | after |
> |---|---|---|
> | `stg_player` / `player_identity` | 11,966 / 22,814 | 12,122 / 12,122 |
> | `player_xref` | 27,301 | 36,618 |
> | `history-points.csv` (sk resolved) | 41,245 (91.5%) | 41,245 (**91.1%**) |
> | `history-weekly.csv` (sk resolved) | 422,499 (92.4%) | 422,499 (**92.1%**) |
> | `feat_player_season` | 17,189 (99.0%) | 17,189 (98.2%) |
> | `feat_player_week` | 287,632 (98.9%) | 287,887 (98.2%) |
> | `feat_player_season_ext` / `feat_player_week_context` | 8,021 / 131,892 | 8,021 / 131,892 |
> | `feat_player_week_model` | 187,447 | 187,566 |
> | `fact_draft_pick` | 738 | 1,658 (Step 1) |
> | `board` / `player_value` (sk resolved) | 523 (100%) | 523 (**98.7%**) |
> | `scorecard_prediction` / `raw_espn_projection` | 3,077 / 577 | 3,077 / 577 |
>
> The resolution rates that FELL did so because the layer stopped guessing: a (name_key, position)
> pair two staged players now share resolves to nobody, which is the correct answer and was previously
> a coin flip.
>
> **P10 FAILED, and the reason is a coverage ceiling rather than a keying one.** Per-source resolution,
> before -> after: draft picks 49.1 -> 48.7, contracts 49.0 -> 48.6, participation 75.4 -> 75.4,
> injuries 82.4 -> 82.4, snaps 82.4 -> **82.5**, depth charts 79.2 -> **79.4**, player-week 94.4 ->
> 94.4, FFC ADP 92.0 -> 90.8. Measured directly against the 12,927 NFL draft picks: **5,828 carry a
> name the crosswalk has never heard of** (4,663 of them drafted before 2000) and a further **756 have
> a known name at a position the crosswalk spells differently** -- the draft feed says `DB` and `T`,
> the crosswalk says `CB`/`S` and `OT`. So that 49% is ~45 points of coverage and ~6 of vocabulary,
> and re-keying cannot move either. The prediction was about the wrong quantity.
>
> **Regression.** The flagless arbiter reproduced **38.2% / 96% and the per-season line exactly**.
> `ff evaluate-projection --seasons 2008-2025` moved and in the right direction: RMSE 54.32 -> **54.17**,
> pinball 12.39 -> **12.31**, coverage 0.764 -> **0.759**, curve baseline 55.55 -> 55.54, all gates
> still PASS. Resolving identity correctly changes which history rows carry an age and which prior
> season a row joins to; that is the whole delta.
>
> **FAULT INJECTION.** Reverting to the empty id bag puts staging back to 11,966 rows and 10,897
> minted keys and fails the shared-gsis agreement test. Dropping the variant expansion loses 321
> people and fails both staging-completeness tests.
>
> ### Step 1 -- the league's own history as facts
>
> `fact_draft_pick` was built from `data/recaps.json`, a hand-scraped gitignored file covering four
> seasons and 738 picks that could not be rebuilt by re-fetching -- the one property the raw layer
> guarantees. It now reads `raw_league_pick`: **1,658 picks over 2018-2026**, with totals asserted
> against that table **to the dollar** in all nine seasons.
>
> | season | teams | picks | total | consensus rows | consensus as-of |
> |---|---|---|---|---|---|
> | 2018 | 14 | 182 | $2,757 | 0 | none -- the ECR archive does not reach it |
> | 2019 | 14 | 182 | $2,789 | 0 | none |
> | 2020 | 14 | 182 | $2,769 | 164 | 2020-09-03 |
> | 2021 | 14 | 182 | $2,772 | 165 | 2021-09-03 |
> | 2022 | 14 | 182 | $2,796 | 164 | 2022-09-02 |
> | 2023 | 14 | 182 | $2,783 | 165 | 2023-09-01 |
> | 2024 | 14 | 182 | $2,767 | 165 | 2024-09-06 |
> | 2025 | 16 | 192 | $3,157 | 173 | 2025-08-08 |
> | 2026 | 16 | 192 | $3,148 | 176 | 2026-09-09 (from `ranking`, the live board's own source) |
>
> New columns: `money_remaining`, `slots_remaining` and `season_total_money` replay the auction pick by
> pick, and `price_share` normalises the 14-team ($2,800) and 16-team ($3,200) eras, which are
> different currencies rather than different amounts.
>
> `fact_team_season` (130 rows) and `fact_matchup` (1,050 games) are new. `champion`, `made_playoffs`
> and `settled` are derived once, here; `settled` comes from the data -- every team has a final rank
> and one of them is 1 -- rather than from the calendar, because an in-progress season's placeholder
> rank looks exactly like a result.
>
> **A derivation that does not work, recorded so nobody rebuilds it.** The playoff field looked
> readable off the finishes ("the teams finishing 1..k are exactly seeds 1..k, for the largest such
> k") and is not: `k = teams` satisfies it trivially, so the first cut always returned its own
> fallback -- correct for every real season and structurally unable to return anything else, found
> only by fault injection. Bounded to a plausible bracket it is still not identifiable: across the six
> settled 14-team seasons it reads 6, 8, 6, 4, 6, 8, because ESPN's `final_rank` is a
> consolation-inclusive ordering (in 2021 the 8 seed finished FIFTH and the 6 seed seventh). So the
> field is a stated constant, 6 below 16 teams and 7 at or above -- what
> `settings.config.playoffTeams` records -- and `seedsAgreeAtField` reports the check beside it. Seven
> of the eight settled seasons agree.
>
> ### Step 2 -- the price model: more seasons only help if they carry the feature
>
> All three predictions failed, for one reason. The ECR archive starts in 2020, so every pick in 2018
> and 2019 is unranked, and `no_consensus` then has to carry both "we do not know this player" and
> "this is the 2018 RB1".
>
> | leave-one-season-out window | price | rank | vor |
> |---|---|---|---|
> | 2022-2025 (the recorded four seasons, rebuilt on the new keys) | **$4.24** | $7.40 | $7.70 |
> | 2020-2025 (every season with a consensus) | **$3.72** | $7.42 | $7.61 |
> | 2018-2025 (P11's window) | **$6.38** | $8.29 | $8.53 |
>
> So the artifact ships fitted on **2020-2025**, chosen on that rotation and confirmed -- not chosen --
> on the holdout. Scored on the held-out **2026** draft, every book normalised to the season's own
> total spend:
>
> | book | MAE | within $3 | top-12 | 13-36 | 37-96 | tail |
> |---|---|---|---|---|---|---|
> | price (fitted 2020-2025) | **$4.70** | 65.1% | 9.0 / +4.1 | 8.0 / -5.0 | 8.5 / +0.9 | 1.7 / +0.2 |
> | price (fitted 2018-2025, the pre-registered arm) | $7.07 | 63.0% | 10.6 / +4.3 | 14.1 / -9.7 | 10.4 / -1.0 | 3.6 / +2.1 |
> | rank | $5.59 | 53.6% | 6.7 / +1.8 | 9.2 / +4.3 | 10.5 / -3.8 | 2.3 / +0.7 |
> | vor | $7.23 | 56.8% | 23.0 / +23.0 | 13.7 / -11.0 | 12.2 / +1.1 | 1.7 / -0.8 |
>
> P12 fails on the top-12 bias either way (+$4.1 on the shipped arm against a predicted +/-$3), and
> P13 fails outright: the price book beats `rank` by $0.89, not the predicted $2, and the
> pre-registered arm LOSES to it by $1.48. **The `rank` book is better at the top of the market than
> the fitted one is**, which is worth remembering the next time an elite-tier conclusion rests on the
> price book. `vor` -- our own valuation function, the default opponent -- overpays the top twelve by
> $23 a man.
>
> One caveat on the 2026 column: that season's consensus is read from `ranking`, whose scrape is dated
> 2026-09-08, after the August draft. It is preseason-final rather than pre-draft, and the holdout is
> mildly flattered by it.
>
> **The bot field was rebuilt too.** `ff build-managers` derives `data/managers.json` from
> `fact_draft_pick` + `fact_team_season` -- 16 real owners, 130 team-seasons, every one of 1,658 picks
> attributed -- replacing a browser scrape that needed the desktop app open, reached four seasons, and
> carried two placeholder `member <guid>` profiles standing in for real people. `leagueShare` barely
> moves (QB .0778 -> .0775, RB .4270 -> .4275), but the seats do, so **the flagless arbiter goes 38.2%
> -> 38.1% and its per-season line changes**. That is an input change, declared here rather than
> discovered later.
>
> **P14 HELD.** On 112 team-seasons (up from 98), leave-one-season-out, the personalised profiles
> still do not beat "everyone drafts league-average": **11.51pp against 11.43pp**, winning 56/112.
> The heterogeneous field remains decoration and per-owner targeting advice remains untrustworthy.
>
> **Face validity, re-derived.** `scripts/face-validity.mjs` now takes its target ranges from
> `fact_draft_pick` 2018-2026 as shares of the room's money, instead of three drafts retyped out of a
> doc. Nine seasons estimate the range far better than three, so the old "25% of the range OR 25% of
> the quantity" tolerance became indefensible and is now 10% of the observed range:
>
> | book | metrics inside | what is off |
> |---|---|---|
> | vor | 6/10 | total spend, top price, RB total, QB total |
> | rank | 7/10 | total spend, top price, players >$30 |
> | price | **8/10** | top price ($97 against a real $101-121), TE spend ($308 against $206-283) |
>
> ### Step 3 -- the season simulator, scored against eight seasons of real outcomes
>
> `seasonOdds` drives trade advice, waiver advice and the frozen preseason scorecard, and had never
> been scored against anything. Every check on it was INTERNAL -- conservation laws, marginals, the
> copula's correlations -- and an internal check is structurally incapable of noticing over-confidence,
> because it compares the system against itself.
>
> 114 team-seasons, 2018-2025: post-draft rosters from `fact_draft_pick`, each season projected by ITS
> OWN per-fold artifact at as-of Sep 1, the league's real schedule from `fact_matchup`, 3,000 trials,
> seed 7, scored against `fact_team_season`.
>
> | | Brier | log loss |
> |---|---|---|
> | PLAYOFFS -- simulator | **0.2370** | 0.6624 |
> | PLAYOFFS -- uniform | 0.2451 | 0.6832 |
> | PLAYOFFS -- points-for (has SEEN the season) | 0.1378 | 0.4614 |
> | TITLE -- simulator | **0.0659** | 0.2598 |
> | TITLE -- uniform | 0.0652 | 0.2540 |
> | TITLE -- points-for (has SEEN the season) | 0.0636 | 0.2442 |
>
> **P15 HELD** (playoff skill +3.3% over uniform). **P16 FAILED**: the title Brier is 1.0% WORSE than
> a flat 1/n. Eight titles in 114 team-seasons is almost no signal, and the simulator's spread of
> title probabilities (3% to 20%) buys nothing against it. **P17 HELD**, and it is the largest
> miscalibration on the page:
>
> | predicted playoff band | n | mean predicted | realised | gap |
> |---|---|---|---|---|
> | 5-15% | 2 | 8.3% | 0.0% | -8.3 |
> | 15-30% | 13 | 24.1% | 23.1% | -1.0 |
> | 30-50% | 71 | 41.3% | 47.9% | **+6.6** |
> | 50-70% | 26 | 58.0% | 46.2% | **-11.1** |
> | 70-100% | 1 | 74.4% | 100.0% | +25.6 |
>
> The simulator separates the league more than the league separates itself -- which is what you would
> expect from a model that gives every other team a static roster for fourteen weeks.
>
> **Shrinkage does NOT fix it, and that is the reportable result.** Chosen leave-one-season-out, the
> held-out Brier gets WORSE: 0.2370 -> 0.2385 for playoffs and 0.0659 -> 0.0661 for the title, with the
> per-fold factor swinging 0.10-0.40 and 0.20-0.70. Eight seasons cannot estimate it. Nothing applies
> a correction; it is a finding for Phase 3.
>
> **P(title | seed)** is flat where it should not be: the 2 seed and the 4 seed each won 25% of the
> time against a predicted 11.6% and 5.8%, while the 6 and 8 seeds never won. The 2025 champion was
> the **7 seed at 9-5**, and 2025 is the one season in eight where the simulator's most likely champion
> WAS the champion.
>
> **The control.** Outcomes shuffled within each season -- preserving how many berths and titles there
> were, destroying only which team got them -- score 0.2587 and 0.0671 against the honest 0.2370 and
> 0.0659. The join is real; the title arm has a little signal and simply loses to uniform anyway.
>
> **The 2026 odds accrual.** The 32 frozen rows read back cleanly: 16 teams with both probabilities,
> summing to 700% playoff and 100% title, the conservation the simulator imposes. But `scorecard.ts`
> has no `odds` branch in its SCORING phase, only `weekly` and `season` -- the snapshot path exists and
> the accrual path does not. Recorded, not fixed.
>
> ### Step 4 -- the honest arbiter
>
> Phase 2b's harshest arm gave the room the real published consensus but a SINGLE shared view, and
> left it standing pat all season. Both are now fixed: `--market ecr --market-noise 0` drafts the
> consensus as published, `--bot-noise 0.20` gives each bot an independent view on top of it (bounded
> by the price model's own leave-one-season-out residual dispersion, 0.35-0.90 by tier), and
> `--bot-churn` gives the field the waiver wire at this room's observed rate. Rookies are in the pool
> at their ECR rank. 2020-2024 -- every season the FantasyPros archive reaches -- n=300, against the
> rebuilt 16-owner field.
>
> | market model | churn | vor book | rank book | price book |
> |---|---|---|---|---|
> | our projection x one shared sd 0.30 *(legacy)* | off | 41.5% | 36.2% | 33.9% |
> | our projection x one shared sd 0.30 *(legacy)* | **on** | 28.3% | 29.4% | 29.3% |
> | consensus AS PUBLISHED + per-bot 0.20 | off | 23.1% | 23.8% | 16.7% |
> | consensus AS PUBLISHED + per-bot 0.20 | **on** | **11.9%** | **21.0%** | **14.5%** |
>
> Every cell is paired on common random numbers; the season-level bootstrap CIs are over five seasons,
> and the detectable effect at 80% power with five seasons runs 2-28pp depending on the cell, which is
> itself worth reading before believing any small difference here.
>
> **What CHURN costs, paired:**
>
> | market | book | cost | 95% CI over seasons | seasons better |
> |---|---|---|---|---|
> | legacy | vor | 13.1pp | [11.5, 15.2] | 5/5 |
> | legacy | rank | 6.8pp | [3.9, 9.2] | 5/5 |
> | legacy | price | 4.7pp | [3.5, 5.9] | 5/5 |
> | ECR | vor | 11.3pp | [6.6, 15.4] | 5/5 |
> | ECR | rank | 2.8pp | [1.2, 4.4] | 4/5 |
> | ECR | price | **2.2pp** | **[-0.5, 4.9]** | 4/5 |
>
> **The churn penalty is mostly an artefact of the mirror.** Against a field that prices players
> exactly as we do, giving it the waiver wire costs us 11-13 points; against a field pricing on the
> published consensus with its own fitted book, it costs 2.2 and the interval contains zero. The 12.8
> points recorded in Phase 2b was measured in the top-left cell.
>
> **What the MARKET MODEL costs, paired:** vor 18.3pp [9.8, 29.5] standing pat and 16.5pp [10.3, 23.6]
> with churn; price 17.3pp [9.5, 24.0] and 14.8pp [5.2, 23.5]; rank 12.4pp [-6.7, 26.9] and 8.4pp
> [-8.3, 20.5], both intervals containing zero -- the rank book is by far the least sensitive to which
> market it faces, which is what you would expect of the one book that was never built from either
> side's projection.
>
> **The long arm, 2012-2024 (13 seasons, legacy market, vor book), n=300:** 38.8% standing pat against
> **26.2%** with churn -- 12.7pp, CI [11.1, 14.4], worse in 13 of 13 seasons. That is the cleanest
> churn measurement in the record and it agrees with the 2b figure; it is also the cell whose market
> model the five-season grid above says is the flattering one.
>
> #### P18, P19, P20
>
> **P18 HELD.** Under the honest arbiter with the price book -- the cell the prediction named -- our
> title rate is **14.5%**, inside the pre-registered [12%, 26%].
>
> **P19 FAILED, and it is the most consequential number in this phase.** Shading at `aggr 0.7` against
> `aggr 1.0`, same cell, paired: **14.5% against 13.5%, a difference of +1.0pp, CI [-3.7, +5.9]**,
> better in 3 of 5 seasons, McNemar p = 0.44. The prediction asked for at least 4 points.
>
> **But the control says the arbiter is NOT why**, and running it is the only reason this is a finding
> rather than a fabrication. `aggr 0.7` is recorded as the biggest single lever, ~+10pp, measured over
> 25 seasons under the LEGACY arbiter; comparing that to a five-season honest-arbiter number and
> calling the gap an arbiter effect would be correlating two facts from two different samples. So the
> same two arms were run on the SAME five seasons and the SAME book, changing only the market and the
> churn:
>
> | arbiter, 2020-2024, price book, n=300 | aggr 0.7 | aggr 1.0 | paired difference |
> |---|---|---|---|
> | legacy market, standing pat | 33.9% | 35.5% | **-1.6pp**, CI [-3.5, +0.1], better in 1/5 |
> | ECR as published + per-bot 0.20 + churn | 14.5% | 13.5% | **+1.0pp**, CI [-3.7, +5.9], better in 3/5 |
>
> **Shading does not reproduce as a large lever on these five seasons under EITHER arbiter.** The
> difference between +10pp and +/-1pp is the SEASON WINDOW, not the opponent. And the honest arbiter
> can never have more seasons: the FantasyPros archive begins in 2020, so this arm is structurally
> capped at five or six, and its detectable effect at 80% power is 3-8pp. **A lever worth 10 points on
> 25 seasons is simply not measurable on five**, and neither of these two rows is evidence against it.
> Nothing is changed: `aggr` stays at 0.7, and the honest reading is that the honest arbiter cannot
> currently adjudicate a lever of this size.
>
> (The `aggr 0.7` arm reproduced the grid's `ecr-price-churnon` cell to the decimal, 14.5%, which is
> the positive control that `--aggr` is connected and that 0.7 is what the stored default holds.)
>
> **P20 FAILED, and the direction is the finding.** The predicted ordering was vor > rank > price, on
> the reasoning that `vor` is our own valuation function and a mirror flatters most. Measured, under
> the honest arbiter with churn: **rank 21.0% > price 14.5% > vor 11.9%** -- very nearly the reverse.
> Standing pat it is rank 23.8% > vor 23.1% > price 16.7%. A field that prices players exactly as we
> do makes the same mistakes we do: it does not overpay the studs we are avoiding, and it does not
> leave the mid-round value we are collecting. **A mirror is not automatically the easy opponent**,
> and the intuition that it must be is the same self-reference the FLEX bug hid behind.
>
> #### The headline paragraph
>
> **Our championship rate is 38.1% against a field that drafts on our own projection plus one shared
> error of an asserted sd 0.30 and never touches its roster, over 25 seasons (1999-2024, n=150, the
> flagless arbiter). It is 14.5% against a field that drafts the real published FantasyPros consensus
> with an independent per-bot view of log-sd 0.20, prices with a book fitted on this room's own 1,102
> picks, and works the waiver wire at this room's observed rate, over the five seasons that consensus
> exists for (2020-2024, n=300). The same cell reads 21.0% with the rank book and 11.9% with the vor
> book. Nothing about our strategy differs between those numbers.**
>
> **The recommendation, for the owner to take or leave.** Keep the flagless run as the regression
> tripwire -- it reproduces to the season and that is its job -- and quote
> `--market ecr --market-noise 0 --bot-noise 0.20 --bot-churn --bot-book price` over 2020-2024 as the
> rate a plan budgets against, because `price` is the only opponent book fitted on this room and the
> best-calibrated of the three against nine real drafts (8/10 metrics, against 7 and 6). Then check
> that the conclusion survives the other two books, per this repo's standing rule. **The default is
> NOT changed here**: doing so would silently re-baseline every number already recorded, and the
> season window would drop from 25 to 5 -- which the P19 result shows is not enough seasons to
> measure a lever with.
>
> ### Step 5 -- positional gates, derived instead of typed
>
> `scripts/value-gates.mjs` carried `TE book in $380-470` and `WR book >= $1,050`, constants typed in
> on the day one build produced them; the TE bound had been FAILING against a book at $373 that nothing
> else said was wrong. **The comparison was also wrong**, and that is most of it: the book prices 523
> players and the room buys 192, so the full positional total was being compared to the room's spend
> with a scale error baked in. Against the top-192 slice the book totals $3,190 to the room's $3,200.
>
> | pos | book (top-192) | room 2018-2026 | price model | union +/-50% | |
> |---|---|---|---|---|---|
> | QB | $556 | $158-359 | $323 | $79-538 | **OUT** |
> | RB | $1,041 | $1,220-1,497 | $1,126 | $563-2,246 | in |
> | WR | $1,211 | $1,136-1,488 | $1,286 | $568-2,233 | in |
> | TE | $308 | $209-285 | $348 | $104-522 | in |
> | K | $41 | $18-48 | $15 | $8-72 | in |
> | DST | $33 | $19-53 | $101 | $9-151 | in |
>
> The positional bands are REPORTED, not enforced, and that is the point rather than a softening: our
> book is supposed to disagree with the room, so a bound derived from the room's taste cannot be a
> build gate without gating against the strategy. What is fatal is structural and cannot be tripped by
> a real edge -- every position present in the top-192 book, that slice within 10% of the room's money,
> no position above 60% of it. FAULT INJECTION: dropping every TE makes the first one fire.
>
> **The value finding for the owner.** Our book puts **17.4% of the room into QB**; this room has never
> spent more than 11.2% and the price model says 10.1%. RB is the mirror: 32.6% against a room that has
> never spent less than 38.1%. TE is mildly above (9.7% against 6.5-8.9%); WR, K and DST are inside.
> Whether the QB overweight is the edge or a defect is not something a gate can decide, so it is
> printed where somebody will read it.
>
> ### The state at the end of the phase
>
> | check | value |
> |---|---|
> | `npm run typecheck` | clean |
> | `npm test` | 395 tests, 393 pass, 2 skip, 0 fail |
> | `node --import tsx scripts/value-gates.mjs` | ALL GATES PASS (the inherited TE failure is gone) |
> | flagless arbiter, `--full --no-lookahead --inflation --seasons 1999-2024 --n 150` | **38.1% / 96%** |
>
> Per season: `2000:31 2001:32 2002:29 2003:47 2004:41 2005:18 2006:51 2007:21 2008:36 2009:35
> 2010:35 2011:62 2012:49 2013:41 2014:32 2015:26 2016:41 2017:33 2018:45 2019:38 2020:37 2021:36
> 2022:61 2023:33 2024:43`.
>
> **That line is NOT the Phase 2b line, and the reason is recorded rather than discovered later.** The
> identity rekey reproduced the old line character-for-character; what moved it was `ff build-managers`
> rebuilding the bot field from nine seasons of `fact_draft_pick` -- 16 real owners over 130
> team-seasons, replacing four seasons and two placeholder `member <guid>` profiles. The headline moved
> 38.2% -> 38.1%; the seats, and therefore every per-season figure, moved more. This is the Phase 2c
> reference line.

> ## INTEGRATION PASS 2: + the weekly track and the copilot track (2026-09-08/09)
>
> `redesign/integration-2` = `redesign/integration` + `--no-ff` merges of `redesign/weekly-track`
> and `redesign/copilot-track`, then the four merge notes those tracks left, each with a
> fault-injected test.
>
> **Conflicts, and how they were resolved.** Four, all of them two tracks appending to the same tail:
> `README.md` and `src/db/schema.sql` on the weekly merge, `README.md` and `src/ff.ts` on the
> copilot merge. Both sides were kept everywhere. The one judgement call was `README.md` on the
> second merge: the copilot track edited three spots IN PLACE (the Status bullet, the tool count,
> the layout line) and those are corrections, so its versions won and the superseded `16-tool` and
> old `In-season:` lines were dropped. `src/ff.ts` needed a brace: both sides ended mid-function and
> shared one closing `}`.
>
> **The checks an auto-merge hides, all run:** no duplicate `CREATE TABLE` or `CREATE INDEX` in
> `schema.sql`; no new duplicate `case` label in the `ff.ts` dispatch (`app-data` and
> `my-roster-set` appear once per switch in two different switches and pre-date this work); no
> duplicate name in `buildTools()` -- `TOOL_NAMES.length` is **34**; no duplicate raw asset id.
>
> ### The verification table
>
> | check | before (`redesign/integration`) | after |
> |---|---|---|
> | `npm run typecheck` | clean | clean |
> | `npm test` | 304 tests, 302 pass, 2 skip | 372 tests, 370 pass, 2 skip, 0 fail |
> | arbiter, flagless `--full --no-lookahead --inflation --seasons 1999-2024 --n 150` | 38.2% / 96% | **38.2% / 96%, per-season line character-identical** |
> | `evaluate-projection --seasons 2008-2025` | RMSE 54.32, pinball 12.39, coverage 0.764 | identical, P5 HELD |
> | `scripts/copilot-mcp-smoke.mjs` | n/a | PASSED, 34 tools, all 9 copilot tools present |
> | `scripts/copilot-crosscheck.mjs` | n/a | ALL CHECKS PASSED (real schedule, both fault injections fire) |
> | `scripts/weekly-leak-audit.mjs` | n/a | 0 mismatches; the leaked-bound control fired on every column |
> | `scripts/value-gates.mjs` | 1 fail (TE book $373 in $380-470) | the same 1 fail, nothing else. Not adjusted. |
>
> ### The one number that MOVED, and why it is not a regression
>
> `ff evaluate-weekly --seasons 2012-2025 --train-seasons 2010-2025 --rosters 300`, pooled:
>
> | model | weekly track | integration pass 2 |
> |---|---|---|
> | trained `weekly` | RMSE 5.493 / CRPS 2.335 | **5.478 / 2.317** |
> | `season_line` | 6.019 / 2.718 | **5.939 / 2.674** |
> | gate coverage | 0.868 | **0.876** |
>
> **The cause is measured, not guessed: the SEASON LINE changed under the weekly model.** The weekly
> track branched from `a62d7d6`, before Phase 2b shipped the trained season artifact, so its
> `data/projection-artifact.json` was `curveOnlyArtifact` -- the floor, no fitted coefficients.
> Integration ships the TRAINED one. `season_line_pg` is built from that artifact and is the
> denominator every weekly ratio is fitted against, so the whole target moved. Diffed column by
> column on 2023: **`season_line_pg` differs on 9,072 of 11,664 rows and `t4_mean`, `dvp_mult` and
> `pts` differ on zero.** That is the entire delta, and it is the expected direction -- a better
> season line makes both the baseline and the model better.
>
> **Every conclusion survives:** W1 HELD (beaten in all 6 positions), W2 FAILED (3.39 points of
> lineup regret against a 2-point threshold), W3 HELD (trailing4 6.134 worse than season_line
> 5.939), and the pre-registered gate **still FAILS on coverage**, so the **season-line-only
> artifact still ships**. No gate was re-run to change a decision and no band was re-specified.
>
> ### The write-once snapshots, carried not regenerated
>
> Copied from the weekly track's store with a script that inserts on the same primary keys and
> refuses to overwrite: `scorecard_prediction` **3,045 rows** (week-1 `weekly` kind at 523 each for
> `weekly`, `season_line`, `shipped_week`, `trailing4` plus `espn` at 430; `season` kind 523, as-of
> 2026-09-01) and `raw_espn_projection` **577 rows** -- 0 refused, because the destination was
> empty. `ff scorecard --season 2026` then reported **0 new rows** and no scored weeks: write-once
> holds against a re-run. Forward features rebuilt on the merged store: 178,033 rows for 2010-2025
> and 9,414 for 2026 (523 players x 18 weeks), both exact.
>
> **A caveat that belongs on the record.** Those frozen week-1 predictions were produced against the
> CURVE-ONLY season line, per the section above. They are the weekly track's model as it stood on
> 2026-09-08, not the integrated one, and week 1 kicked off on 2026-09-09 so they can never be
> re-taken. That is the correct outcome -- a snapshot re-taken after kickoff would be worthless --
> but the Brier and RMSE accrual scores the model that was frozen, and this is what it was.
>
> ### The four merge notes, each with its fault injection
>
> 1. **`CLAUDE.md` said 16 tools.** Now 34, pointing at `TOOL_NAMES.length` as the source rather
>    than a number to retype, and naming `ff copilot`.
> 2. **`currentWeek()` returned a default on every call.** It now derives the week from
>    `raw_nfl_game` kickoff dates -- week w runs from the day after week w-1's last kickoff through
>    week w's last kickoff -- on the **LOCAL** date. FAULT: at 9pm on 2026-09-14 the UTC date is
>    already the 15th and the UTC path returns week **2**; the local path returns week **1**. The
>    old `default` survives verbatim for a store with no schedule rows. Live: week 1 today, week 11
>    on 2026-11-20.
> 3. **`lineupRecommend` divided by 17.** It now calls `projectWeekly` with the shipped
>    season-line-only artifact. Both directions asserted, because the shipped artifact is the
>    identity and a DEAD seam looks exactly like a working one: deep-equal starters and bench under
>    the shipped artifact, and a fixture artifact with one non-zero coefficient CHANGES the lineup.
>    On the real 2026 roster the two paths also agree exactly (76.4 points, no per-starter
>    difference). A player the projector has no row for falls back and `assumptions.basisNote` names
>    him.
> 4. **The scorecard's `odds` kind was permanently empty.** `runScorecard` now takes an
>    `oddsProvider`; `ff scorecard --odds` runs `seasonOdds` on the league's REAL schedule at 3000
>    trials, seed 7, and a generated schedule is refused. **16 teams, 32 rows** (playoff and title
>    stored as separate models -- a Brier score over a mixture of the two has no interpretation),
>    as-of 2026-09-08, playoff probabilities summing to 700% for 7 berths and title to exactly 100%.
>    FAULT: no provider writes nothing and says why; a second run handed DIFFERENT probabilities
>    changes no stored value.
>
> ### What Phase 2c inherits
>
> - **The identity key-space reconciliation, first.** Untouched here by instruction, and it blocks
>   the rest.
> - **The TE-floor gate.** $373 against a $380-470 band, inherited and deliberately not adjusted.
> - **The DAG node list under `app/`** -- the new tables are not on it. `app/` was out of scope.
> - **The weekly gate, re-run under a band pre-registered on `cov(>0)`.** Decided BEFORE the run,
>   not after this one. The trained artifact now reads 0.814 on that statistic against the shipped
>   baseline's 0.804, and its pooled 0.876 failure is the zero atom sitting on a p10 of exactly 0.

> ## INTEGRATION: Phase 2b + the data track, on one branch (2026-09-08)
>
> `redesign/integration` = `redesign/phase-2b-price-model-ecr-arbiter` + a `--no-ff` merge of
> `redesign/data-track-sources`. **The merge was textually clean** -- git resolved every appended
> region (the `src/ff.ts` dispatcher, `src/db/schema.sql`, `src/data/ingest.ts`, `README.md`,
> `docs/data-layers.md`) without a conflict, and the checks below say nothing was lost either way:
> no duplicate `case` label in the dispatcher and no duplicate `CREATE TABLE` in the schema.
>
> **The arbiter is byte-identical across the merge.** `--full --no-lookahead --inflation --seasons
> 1999-2024 --n 150` reads **38.2% / 96%** before AND after, with the same per-season line
> (2000:32% 2001:37% 2002:25% 2003:52% 2004:43% 2005:15% 2006:55% 2007:20% 2008:33% 2009:41%
> 2010:39% 2011:57% 2012:52% 2013:37% 2014:35% 2015:29% 2016:30% 2017:29% 2018:41% 2019:35%
> 2020:35% 2021:45% 2022:53% 2023:31% 2024:54%), and again after the two fixes below.
> `ff evaluate-projection --seasons 2008-2025` also reproduces exactly: RMSE **54.32** vs curve
> 55.55, pinball **12.39** vs 13.17, coverage **0.764**, every band inside [0.70, 0.90] -- so the
> trained artifact and the projector both survived the merge intact.
>
> **Tests: 304 total, 302 pass, 0 fail, 2 skipped** (the two curve-only projection tests that skip
> because the shipped artifact is trained -- the same two that skip on 2b alone). Before the raw
> tables were rebuilt, 22 skipped: the data track's 20 table tests correctly refuse to grade an
> unbuilt table, which is the right shape for that guard. `typecheck` clean throughout.
> `scripts/lever-connected.mjs maxShare 0.25 0.45` reports CONNECTED after the `ff.ts` merge.
>
> **The data track's tables rebuild on the merged store to its exact counts** -- `raw_nfl_game`
> 7,548; `raw_injury` 90,762; `raw_depth_chart` 1,907,518; `raw_snap_count` 324,611;
> `raw_nfl_draft_pick` 12,927; `raw_participation` 182,303; `raw_adp_history` 8,750; `raw_contract`
> 31,893; `raw_league_pick` 1,658; `feat_player_week_context` 131,892; `feat_player_season_ext`
> 8,021. One number needs reading carefully: `ingest-raw depth-charts` PRINTS 1,921,758 while the
> table holds 1,907,518. The printed figure counts rows PROCESSED, and the 2025/2026 dated-snapshot
> schema re-states rows that upsert onto the same key. The table itself matches season by season,
> all 26 of them, against the data track's own store.
>
> **2b's one open item is closed.** `ff assemble` was run (the network-touching step 2b was not
> permitted), and `values.csv top-12 == player_value top-12` now PASSES. That surfaced the next
> thing: `value-gates.mjs` now fails **`TE book = $373 (in $380-470)`**. It is INHERITED, not
> caused by the merge -- `data/values.csv` is byte-identical between 2b and the merge (`git diff`
> empty), and its TE column sums to $373 on both. The gate's $380 floor was calibrated on an older
> build; the shipped book is $7 under it. Deciding whether to move the book or the floor is a VALUE
> change and therefore the arbiter's business, not integration's. Reported, not suppressed.
> `scripts/sim-vs-mock.mjs` now computes real ESPN-mock rows (9 complete drafts of 23 logs; no NaN):
> positional-$ distance from the real 2025 room -- price book 224, rank 292, ESPN mock rooms 341,
> vor 474.
>
> **Two data-track notes applied here** (both in files the data track was fenced from):
> `ff ingest-source <id> --seasons A-B` now FORWARDS the range to `ingestOne` -- proved by fault
> injection, since dropping the forwarding makes `ingest-source league-history --seasons 2024-2024`
> return 1,658 rows (the default 2018-2026 range) where the fix returns 182 (2024 alone) -- and the
> `data-sources` freshness list gained the 13 `raw_*` and 3 `feat_*` nodes, verified over the real
> `ff serve` RPC, all 16 reporting rows and a fetch time.
>
> **Open for the next pass:** `app/renderer/app.js`'s DAG node list still does not draw the new
> tables (owner-visible, deliberately untouched here); the weekly and copilot branches are not
> merged; and Phase 2c's identity key-space reconciliation (staging vs registry) is untouched and
> remains its blocking first step.

> ## PHASE 2b: the curve is chosen by the evaluation, and the arbiter has been scoring us
> ## against an opponent weaker than the real one (2026-09-08)
>
> Phase 2a built a modelling side that could absorb a feature. Phase 2b uses it, and then turns the
> same scepticism on the ARBITER -- with two results that matter more than anything the model does.
>
> **THE HEADLINE NUMBERS EVERY DELTA BELOW IS MEASURED AGAINST.** The flagless arbiter is unchanged
> at **38.2% / 96%** (`--full --no-lookahead --inflation --seasons 1999-2024 --n 150`), per-season
> identical to Phases 1 and 2a. What moved is the BOARD -- the shipped projection is now a trained
> artifact -- and what moved most is our confidence in what 38.2% means.
>
> Every number on this page was measured with:
>
> - **the curve**: per position, window / monotone / ECR-level-weight / base-form selected inside the
>   fold by forward-chaining CV. The shipped artifact is `offset` form, ECR level weight **0 at every
>   position**, windows QB 2 / RB 1 / WR 2 / TE 1 / K 3 / DST 1.
> - **the market model**: the default arbiter still has the room draft on our own projection times one
>   shared error of sd 0.30. `--market ecr` is the honest alternative and it is reported separately,
>   because it does not agree.
>
> ### 1. The curve's construction is now a hyperparameter, selected per position inside the fold
>
> It used to be four hand-made choices compiled into the feature builder, where no evaluation could
> reach them: a +/-1 window at ranks 1-3 and +/-2 below, always monotone-repaired, always rescaled to
> the preseason-ECR level, and always multiplied (never added) into the linear stage. Now: 4 windows x
> monotone on/off x 3 ECR level weights x ratio/offset, selected by pinball loss on FORWARD-CHAINING
> inner folds -- not a shuffled k-fold, because a curve is fitted on season pairs and a random split
> lets a fold's curve be built from seasons after the one it scores.
>
> `--holdout-season Y` now trains on seasons STRICTLY BEFORE Y rather than "every season except Y",
> for the same reason: a training row from a season after Y carries a base built from a window that
> contains Y. That costs real data at the early folds and it is the only version of the number that
> means what it says.
>
> **Selection per outer fold, and how stable it was.** `w` = window, `m` = monotone repaired,
> `L0` = no ECR level correction, `/r` `/o` = ratio or offset form.
>
> | position | window, by fold 2012-2025 | most common | level weight | monotone |
> |---|---|---|---|---|
> | QB | 3 3 3 3 2 2 2 2 2 2 2 2 2 2 | **2** (10/14) | 0 in 14/14 | mixed (8/14) |
> | RB | 3 3 3 3 2 2 2 2 3 3 3 3 1 3 | **3** (9/14) | 0 in 14/14 | mixed (6/14) |
> | WR | 2 2 2 2 2 1 1 1 1 1 1 1 1 1 | **1** (9/14) | 0 in 14/14 | mixed (7/14) |
> | TE | 3 3 3 3 3 3 3 3 3 1 1 1 1 1 | **3** (9/14) | 0 in 14/14 | mostly yes (10/14) |
> | form | ratio for 2012-2015, **offset** for 2016-2025 | offset (10/14) | | |
>
> Two things are worth taking from that table and one is worth NOT taking.
>
> - **The ECR level correction is never selected. Not once, at any position, in any fold.** It was
>   shipped for six months as half of the conditional curve -- "shape from the long prior-rank series,
>   level from the preseason-ECR conditional" -- and given the choice, the evaluation declines it every
>   time. That is a real finding about a shipped component, and it is the sort a hand-set constant can
>   never produce.
> - **The form flips once, in 2016, and never flips back.** Fourteen folds is not enough to call that
>   a regime change rather than a coincidence of which seasons are in the training window.
> - **The windows are NOT stable enough to read as facts about positions.** WR moves 2 -> 1, TE moves
>   3 -> 1, RB wanders. Unstable per-fold selection is exactly what the K/DST screen looked like from
>   the inside before it was rejected; the difference here is that the selection is INSIDE the fold, so
>   the instability costs honesty rather than hiding it.
>
> ### 2. Nested CV, and PRE-REGISTERED P5
>
> `ff evaluate-projection --seasons 2008-2025`. 14 usable held-out seasons, 6,805 player-seasons; the
> trainer re-invoked per fold, blind to and BEFORE its own season; every rung scored by one function.
> The `bare` rung is gone: the multiplicative stage is retired, so the curve rung IS bare.
>
> | slice | carry rmse / r2 / crps | CURVE-ONLY | TRAINED |
> |---|---|---|---|
> | ALL | 59.3 / 0.432 / 13.9 | 55.6 / 0.497 / 13.3 | **54.5 / 0.520 / 12.5** |
> | QB | 88.1 / 0.473 / 21.8 | 87.9 / 0.479 / 22.0 | **81.9 / 0.545 / 19.4** |
> | RB | 68.6 / 0.269 / 15.9 | 63.0 / 0.385 / 15.2 | 62.7 / 0.391 / 14.4 |
> | WR | 54.2 / 0.431 / 13.1 | 50.5 / 0.506 / 13.0 | 50.0 / 0.514 / 12.3 |
> | TE | 38.9 / 0.418 / 9.1 | 36.8 / 0.476 / 8.7 | 36.8 / 0.480 / 8.4 |
> | rank 1-6 | 90.5 / -0.087 / 18.8 | 70.7 / 0.329 / 17.6 | 68.7 / 0.375 / 16.3 |
> | rank 7-12 | 66.9 / 0.310 / 15.6 | 63.8 / 0.369 / 15.3 | 61.3 / 0.419 / 14.7 |
> | rank 13-24 | 65.1 / 0.173 / 15.0 | 62.7 / 0.226 / 14.7 | 60.0 / 0.297 / 14.4 |
> | rank 25-40 | 67.6 / 0.075 / 17.3 | 65.7 / 0.128 / 15.9 | 63.1 / 0.195 / 15.1 |
> | rank 41-60 | 58.3 / 0.100 / 14.1 | 57.7 / 0.124 / 14.5 | 56.5 / 0.153 / 12.9 |
> | **rank 60+** | 44.1 / 0.073 / 11.0 | **42.5 / 0.144 / 10.4** | 43.3 / 0.108 / 9.8 |
>
> **The 60+ band is new and it should have existed from the start.** It holds 42% of the scored rows
> in this store -- prior-year WRs run to rank 225 -- and it was reported nowhere. A band nobody prints
> is a band nobody checks, and that is exactly how the two defects in the next paragraph survived.
>
> **PRE-REGISTERED P5**: the trained artifact beats curve-only on pooled CRPS and RMSE, AND pooled
> p10/p90 coverage lands in [0.75, 0.85] with every rank band in [0.70, 0.90]. Pooled 2015-2025:
>
> | | trained | curve-only | verdict |
> |---|---|---|---|
> | RMSE | 54.32 | 55.55 | PASS |
> | pinball | 12.39 | 13.17 | PASS |
> | coverage | 0.764 | -- | PASS ([0.75, 0.85]) |
> | per band | 1-6 0.773, 7-12 0.800, 13-24 0.791, 25-40 0.735, 41-60 0.751, 60+ 0.761 | -- | PASS |
>
> **P5 HELD, so the TRAINED artifact ships.** Phase 2a's coverage was 0.614 because its quantile heads
> were fitted on ranks 1-36 and scored on everything; they are now fitted over 1-60 with rank in the
> design, and the rank feature is winsorised at 60.
>
> **THE GATE FAILED TWICE BEFORE IT PASSED, AND THE SEQUENCE IS PART OF THE RECORD.** Both failures
> were defects of mine, both are the same "fit on one sample, score on another" error this phase exists
> to remove, and both are visible as defects without reference to the gate -- but the gate is what
> found them, and I did change the model after watching it fail:
>
> | run | RMSE | pinball | coverage | what was wrong |
> |---|---|---|---|---|
> | 1 | 65.5 | 16.0 | 0.643 | the rank feature was extrapolated arbitrarily far past the rank 60 it was fitted at; every band 1-60 improved while ALL got 10 points worse |
> | 2 | 62.1 | 14.8 | 0.682 | the artifact's curve stopped at rank 60 while the column it replaced ran to WR 204, so every deeper player was priced as a WR60 |
> | 3 | 54.3 | 12.4 | 0.764 | -- |
>
> Read run 1 carefully, because it is the most instructive number here: **every rank band from 1 to 60
> improved while the pooled figure got much worse.** That is only possible if the damage is outside the
> bands being printed, and it was.
>
> ### 3. Two defects closed, and one closed BY CONSTRUCTION
>
> - **D1 (opportunity fitted against a curve that had seen the future) is resolved by construction, not
>   by refitting.** `age-curve.json` and `opportunity-model.json` are RETIRED from the projector path.
>   Both were fitted outside every fold, by their own scripts, against their own curves; a model that
>   reaches for a fitted file on disk cannot be cross-validated, because it is the same file in every
>   fold. Age is now a coefficient; usage is a ratio to its rank bucket's mean over training seasons
>   only. The point-in-time per-position usage lift, measured inside the fold by season-grouped CV and
>   recorded on the artifact as `usageLiftRmse` (RMSE points): **QB +0.06, RB +0.19, WR +0.33, TE
>   +0.46.** The files stay on disk so their recorded numbers remain checkable; `loadArtifact` REFUSES
>   an artifact that still declares a multiplicative stage, so a half-migration fails loudly instead of
>   silently dropping a factor it says it has.
> - **D2 (Marvin Harrison Sr. and Jr. merged into one row).** Two crosswalk rows differing in birthdate
>   are two people. The upsert used to produce a row carrying the father's name, team and 1973 birth
>   date with the son's gsis and espn ids -- a row that is neither man, and as well-formed as a real
>   one. Collisions are resolved before the insert: fields the two sides disagree about are NULLed, the
>   key is flagged `ambiguous`, and both sides are kept in full in `player_ids_variant`. Fault-injected.
> - **D3 (null features for a pool player with no row in the drafted season).** The backtest's pool is
>   the PRIOR season's players -- deliberately, since in the simulated August of Y the only people who
>   exist are the ones who played in Y-1. **144 of the 2024 pool had every usage feature NULL**, so the
>   trained arm projected them from its intercept while the curve arm projected them from their rank:
>   not a paired comparison, and it hit exactly the men whose fate the projection most needs to price.
>   New `own_*` columns on `feat_player_season` carry each season's own usage forward. Fault-injected
>   (0/120 absent skill players carried usage before, all of them after).
>
> ### 4. The board moved, and the shape of the move is the one the residuals asked for
>
> | | QB | RB | WR | TE | K | DST | top price |
> |---|---|---|---|---|---|---|---|
> | before (curve x age x opportunity) | $548 | $1,296 | $1,204 | $383 | $44 | $45 | $105 |
> | after (trained artifact) | $579 | $1,149 | $1,331 | $373 | $44 | $45 | **$91** |
>
> Top 12 by value, before -> after: Bijan Robinson $105 -> $91, Jahmyr Gibbs $94 -> $86, Ja'Marr Chase
> $70 -> $80, Jaxon Smith-Njigba $67 -> $78, Christian McCaffrey $76 -> $77, Puka Nacua $78 -> $76.
> The elite RB tier comes down about 18% and the WR book rises to match -- which is precisely what
> Phase 2a's residual slices asked for (an RB entering top-6 finished **35 points under** his
> projection) and what the top price says too: $91 against a room whose real top is $88-106, from $105.
>
> **A KNOWN CONSEQUENCE, reported rather than suppressed.** Under the new board our strategy rosters
> ~2.9 tight ends per draft against ~2.0 before (even-split control: 3.5 before, 3.5 after). TE is
> relatively dearer once the elite RBs come down. `test/draft-composition.test.ts` was keyed on an
> absolute threshold of 2.5, calibrated against one build's output; it is now keyed on the RELATIVE
> claim it was always really making -- the weighted curve rosters fewer TEs than the even split -- with
> a loose absolute ceiling. That is a re-keying, not a widening, and the shift itself is a finding.
>
> **`scripts/value-gates.mjs` reports one FAILURE on this branch and it is not a build problem:**
> `values.csv top-12 == player_value top-12`. `player_value` is written by `ff assemble`, which fetches
> ESPN's public draft-rank endpoint, and this phase was not permitted to touch ESPN. `points.csv` and
> `values.csv` are consistent with each other and with the shipped artifact; the store's `player_value`
> table is Phase 2a's. One `ff assemble` on a machine with network access clears it.
>
> ### 5. The teammate correlation was restored to the WEEK (defect D4)
>
> `fit-correlation.mjs` measured QB-WR +0.348 on SAME-WEEK residuals over 14,021 team-weeks. Phase 1
> moved the bootstrap draw from the week to the season -- correctly, because independent weekly draws
> understate season-total spread by a factor of two -- and the copula went with it, so the sampler
> ended up coupling season QUALITY. Season totals landed on target while the same-week figure fell to
> +0.107. A fantasy week is decided on the Sunday.
>
> Stage two is a PERMUTATION, not a resample: each coupled player's DRAWN season is rearranged, his own
> weekly scores dealt to weeks in the order of a second correlated normal keyed by (trial, week,
> player). His weekly multiset, his season total and his season-total distribution are bit-for-bit
> unchanged. Zero weeks do not move -- their positions are the injury, and a torn ACL is a run of zeros
> at the end of a season, not zeros scattered through it.
>
> | multiple | QB-WR same-week | QB-TE | K-DST | | season totals (QB-WR / QB-TE / K-DST) |
> |---|---|---|---|---|---|
> | off (Phase 1) | 0.111 | 0.068 | 0.028 | | 0.338 / 0.219 / 0.213 |
> | 0.5 | 0.171 | 0.104 | 0.083 | | |
> | 1.0 | 0.238 | 0.144 | 0.131 | | |
> | **1.8 (shipped)** | **0.347** | **0.210** | **0.209** | | 0.350 / 0.216 / 0.220 |
> | 3.0 | 0.435 | 0.259 | 0.330 | | |
> | targets | 0.35 | 0.22 | 0.22 | | fitted 0.347 / 0.225 / 0.224 |
>
> Marginals: worst quantile error 0.60% of a player's own p10-p90 span (target under 2%); season-total
> sd within 1% of each pool (target 15%); cross-team control 0.013. All from ONE invocation of the
> sampler, never two.
>
> **The multiple is 1.8, not 1.0, and that is not an overshoot.** The copula's parameter is a
> correlation between NORMALS imposed on RANKS; the target is a PEARSON correlation between weekly
> scores whose marginal is heavily skewed with an atom at exactly zero. Rank dependence attenuates
> badly across marginals of that shape. One scalar lands all three pairs inside tolerance, which is
> itself evidence the attenuation is a property of the mapping rather than of any one pair.
>
> Season odds, generated schedule, 4,000 x 3 seeds: favourite 15.82% -> 15.76%, spread sd 3.17pp ->
> 3.15pp, our team 7.59% -> 6.66%. Small, and that is the EXPECTED size -- within-week correlation
> moves head-to-head weekly variance, not season-total dispersion, which is what the spread measures.
>
> ### 6. A price model of this room, fitted on 738 real picks
>
> A hurdle model -- logistic P(price > $1), then a log-linear model of the share of the room's money
> given he clears $1 -- because the modal price is exactly $1 and 61% of picks go for $1-5. Price is a
> SHARE of the room's money throughout, so a fit spanning three 14-team seasons and one 16-team season
> means one thing.
>
> **Leave-one-season-out, every book normalised to the same season total** (`scripts/price-loso.mjs`):
>
> | book | n | MAE | bias | within $3 |
> |---|---|---|---|---|
> | price:none | 738 | 7.51 | +0.00 | ~55% |
> | price:inflation | 738 | 7.51 | +0.00 | ~57% |
> | **price:quad (SHIPPED)** | 738 | **4.32** | +0.00 | **65.0%** |
> | price:full (confounded) | 738 | 2.82 | +0.00 | 73.8% |
> | rank | 738 | 7.12 | +0.00 | 53.3% |
> | vor | 738 | 7.11 | -0.00 | 56.5% |
>
> | MAE / bias by tier | top 12 | 13-36 | 37-96 | tail |
> |---|---|---|---|---|
> | price:quad | 8.4 / +4.0 | 8.3 / +0.5 | 6.8 / -2.2 | 1.7 / +0.5 |
> | rank | 9.1 / -0.6 | 15.5 / +11.1 | 11.6 / -3.5 | 2.9 / -0.6 |
> | vor | 21.1 / **+21.0** | 9.8 / -3.0 | 11.5 / -1.1 | 2.7 / -1.3 |
>
> Tier is the player's OVERALL rank on that season's point-in-time board -- known before the draft, so
> it does not condition on what happened. The `vor` row is the most useful thing in the table: our own
> valuation function, used as the default opponent book for the life of this project, **overpays the
> top twelve by $21 a man**.
>
> **Two modelling findings, both measured rather than argued.**
>
> - **The market-state features are confounded with the player.** Expensive players are nominated
>   early, so `pick_share` / `money_left` / `slots_left` carry "how good is he" on top of "where are
>   we". With all three the model prices the consensus RB1 at **$101 nominated first and $2.70
>   nominated last** -- a description of this room's nomination habits in the costume of a price model,
>   and useless as an opponent, because a simulator nominates in its own order. It is the best
>   PREDICTOR by a wide margin and it is not what ships.
> - **The rank effect had to become a monotone TABLE.** A per-position parabola in log rank fitted on
>   58-253 picks came back with the RB3 above the RB1 and the K60 above the K1. MAE was the best of any
>   variant while the curve was upside down: **no residual statistic can see an inverted ordering.**
>   The fitted rank terms are now evaluated onto a table over ranks 1..80 and repaired with a
>   cumulative min -- the same device `projections.ts` uses -- and `loadPriceModel` refuses a table
>   that climbs.
>
> **`--bot-book price` gates, both passed.** Face validity 9/10 against the real 2023-2025 drafts,
> equalling the rank book -- and matching on median price ($1.0 against a real $2, where rank gives
> $4.0); its one miss is TE total $293 against $199-215. Sim-vs-mock positional distance from the real
> 2025 draft: **price 224, rank 292, vor 474**. It is SELECTABLE, not the default.
> (The ESPN mock-room rows in that script are NaN here: `data/draft-log-*.json` is gitignored and
> absent from this worktree. The three SIM rows do not depend on it.)
>
> ### 7. THE ARBITER HAS BEEN SCORING US AGAINST AN OPPONENT WEAKER THAN THE REAL ONE
>
> This is the most important section on the page and it is the least comfortable.
>
> **The market's realised error, measured** (`scripts/market-noise.mjs`, 2,851 scored player-seasons
> 2020-2025, log(actual / consensus-implied projection) by ECR rank band):
>
> | band | 1-6 | 7-12 | 13-24 | 25-40 | 41-60 | 60+ | ALL |
> |---|---|---|---|---|---|---|---|
> | log sd | 0.459 | 0.448 | 0.616 | 0.814 | 1.045 | 1.214 | 0.978 |
> | mean | +0.009 | +0.021 | -0.022 | -0.015 | -0.249 | -0.321 | -0.166 |
>
> These are FLOORS: a ranked player who never posted a season is dropped rather than scored as zero.
>
> **`--market ecr`**: the room drafts on the REAL preseason consensus (the point-in-time curve at each
> player's actual FantasyPros positional rank, so ROOKIES are in the pool), with the measured band sd
> as the shared error and an independent per-bot view of log-sd 0.20 on top. Our book is the projector
> as-of preseason with a per-season artifact blind to that season. 2020-2024, n=300, paired against the
> flagless baseline on the same five seasons -- **and five scored seasons is a short window**:
>
> | book | baseline | ECR (measured sd) | delta | ECR (`--market-noise 0`) |
> |---|---|---|---|---|
> | rank | 36.1% | **47.9%** | +11.87pp, SE 6.45, CI [+1.27, +22.60], 5/5 seasons | **21.6%** |
> | price | 34.6% | **45.9%** | +11.33pp, SE 3.01, CI [+5.87, +16.33], 5/5 seasons | **14.6%** |
>
> **The two ECR columns are 26 points apart and both are defensible.** The measured-sd column does what
> was asked and it DOUBLE-COUNTS: the consensus projection already contains its own error -- it is a
> projection, not the truth -- so multiplying it by a fresh draw of the same size gives the market
> about twice the variance it really has, while our own book carries no added noise at all. The
> `--market-noise 0` column is the other reading: the room drafts on the consensus as published, and
> all the disagreement lives in the per-bot term. **Essentially all of the measured "value edge" is a
> statement about how much noise the market is given.**
>
> **And the field has never worked the waiver wire.** `--bot-churn` gives every bot the same
> conservative rule our team runs, at this room's observed rate of about one add per team per week.
> PRE-REGISTERED **P9: our rate falls by between 0.5 and 4 points. FAILED, by a factor of three**, and
> it fails identically in the symmetric arm, so it is not the asymmetry of giving the field a tool we
> lack:
>
> | arm | churn off | churn on | paired |
> |---|---|---|---|
> | shipped config | 38.2% | **25.4%** | -12.83pp, SE 1.24, t 10.33, CI [10.27, 15.12], worse in 24/25 |
> | `--waivers` both sides | 38.6% | **25.7%** | -12.96pp, SE 2.97, t 4.37, CI [7.36, 18.83], worse in 19/25 |
>
> Nothing crashed and no roster became illegal (a legality guard derived from the league's own starting
> slots stops a bot dropping its only quarterback). It stays behind a flag per its own gate -- the
> effect is far outside P9's range -- but the finding stands: **about a third of our measured
> championship rate was the field never touching its roster after August.**
>
> Both results point the same way, in a direction nobody had measured.
>
> ### 8. The sweeps, under the ECR market
>
> 2020-2024, n=300, `--bot-book rank`, all paired against aggr 0.7 / maxShare 0.25 / multQB 1.0:
>
> | lever | values | outcome |
> |---|---|---|
> | aggr | 0.6 47.0 / **0.7 47.9** / 0.8 44.1 / 0.9 41.2 / 1.0 42.2 | **P6 HELD** -- optimum 0.7, in [0.6, 0.8]. 0.8 is -3.87pp CI [-6.33, -1.13]; 0.6 is -0.93pp, CI crosses zero |
> | maxShare | **0.20 48.9** / 0.25 47.9 / 0.35 43.8 | **P7 HELD** -- a plateau, not a peak. 0.20 vs 0.25 is +1.00pp CI [-0.40, +2.53]; 0.35 is -4.13pp CI [-5.60, -2.67] |
> | multQB | 0.7 46.3 / **1.0 47.9** | **P8 HELD** -- -1.60pp, CI [-4.67, +1.53] |
>
> **A DEAD LEVER WAS CAUGHT MID-SWEEP.** The first maxShare pass used `--maxShare`, which the argv
> walker does not recognise (the flag is `--max-share`). All three cells returned 47.9% to the tenth --
> identical, which is not something three different configurations do. The tell was the sameness, not
> a failure; the run was green.
>
> **`DEFAULT_LEVERS` IS UNCHANGED.** The recommendation, for the owner to take or leave: `aggr` stays
> at 0.7 (its optimum under the new arbiter as well as the old); `maxShare` 0.20 and 0.25 are
> indistinguishable, so keep 0.25 rather than move a default on a null; `multQB` stays at 1.0.
>
> ### 9. Continuity: the trained artifact in the backtest
>
> 2012-2024, n=150, rank book, paired: baseline 35.0%, projector-artifact 33.6%, **-1.33pp** (SE 2.45,
> CI [-5.85, +3.38], better in 5/13 seasons). The trained artifact wins the projection gate and is
> still not a measurable backtest improvement -- exactly as in Phase 2a, and the detectable effect at
> 80% power with 13 seasons is ~7.1pp, so this test could not have resolved an effect of this size
> either way.
>
> ### 10. The season simulator has never been scored against an outcome, and now it can be
>
> `matchup` holds 0 rows, `ownership` holds rosters and not standings, `data/owners.json` carries names
> with no results. The finalRank figures in `docs/league-tendencies.md` came from a live league call
> and were never written down in machine-readable form. So `scripts/sim-calibration.mjs` is built
> end-to-end and PROVEN CONNECTED on a fixture: rosters rebuilt from the 738 real picks, every player
> projected with the artifact blind to the season, the season simulated on a generated schedule,
> scored by Brier plus a reliability table against a uniform baseline -- and against an ADVERSARIAL
> arm, the same outcomes assigned to the wrong teams.
>
> | arm | playoff Brier | champion Brier | playoff skill |
> |---|---|---|---|
> | honest (drawn from the model) | 0.2302 | 0.0596 | +8.6% |
> | shuffled (adversarial) | 0.2540 | 0.0655 | -0.9% |
> | uniform baseline | 0.2518 | 0.0643 | -- |
>
> The scorer distinguishes right answers from wrong ones, and the adversarial arm correctly scores
> WORSE than knowing nothing. **THE REAL RUN NEEDS ONE HUMAN FETCH, with the app open, once:**
>
> ```
> node --import tsx scripts/fetch-league-outcomes.mjs 2022 2025
> ```
>
> after which nothing in the calibration touches the network. Two limits recorded now rather than
> discovered later: `fact_draft_pick` carries no NFL team, so the drafted rosters simulate with
> teammates UNCORRELATED (slightly over-confident); and 21-29 picks a season have no projection at all
> (players the consensus never ranked), who enter at zero.
>
> ---

> ## PHASE 2a: the measurement loop was right and the MODELLING side could not absorb a feature
> ## (2026-09-08)
>
> Phase 1 found that the projection answered the wrong question. Phase 2a is about why that took so
> long to find and why nothing could be done about it quickly: the projection was a curve times two
> hand-built multipliers, each with its own fit script, its own artifact, its own clamp and its own
> amplitude, each applied by the CONSUMER. Adding a third feature meant a third fit script, a third
> artifact and a third pair of call sites. Meanwhile every fit script re-derived prior-year rank and
> prior-season usage for itself, joined by NAME, and at least three separate copies of the curve
> builder lived in `scripts/`. `nested-cv.mjs` -- the thing that decided what was true -- did not run
> the shipped model at all; it reimplemented it.
>
> **Nothing in this phase moves a shipped number on purpose.** The flagless arbiter is unchanged at
> **38.2% / 96%**, per-season identical to Phase 1, and the shipped board's 523 point values reproduce
> exactly. What changed is that there is now one feature table, one projector, one train/serve
> contract and one evaluation that runs the shipped code.
>
> ### The pipeline
>
> | | what it is | built by |
> |---|---|---|
> | `feat_player_season` | 17,189 rows, 1999-2026, `as_of <season>-09-01` | `ff build-features` |
> | `feat_player_week` | 287,632 rows including byes, `as_of` = day before kickoff | same |
> | `feat_curve` | 66,645 rows: the point-in-time curve per (season, kind, pos, rank) | same |
> | `fact_draft_pick` | 738 real picks, 2022-2025, with the consensus as it stood | `ff build-picks` |
>
> **Point-in-time is the rule the layer exists for.** The curve columns are refitted PER SEASON on an
> expanding window rather than fitted once on everything. A curve fitted on 27 seasons and then used
> as a feature for 2010 is lookahead moved one level UP, out of the data and into the model, where no
> data-level check can see it.
>
> **Identity resolution.** `history-points.csv` and `history-weekly.csv` now carry `player_sk` as an
> appended last column, resolved gsis-first, then `(name_key, position, team)`. Team is load-bearing:
> `nameKey` strips generational suffixes on purpose, so a name+position lookup hands Marvin Harrison
> Jr. his father's row.
>
> | slice | resolved |
> |---|---|
> | history-points, skill positions 2010-2025 | **99.88%** (9,071 / 9,082) |
> | history-points, every row 1999-2025 | 91.49% (37,736 / 41,245) -- the shortfall is IDP, which the crosswalk covers thinly |
> | `feat_player_season`, all rows | **99.0%** |
> | `feat_player_week`, all rows | 98.9% |
> | `fact_draft_pick` | 99-100% per season |
>
> The rebuild was verified against the previous files rather than assumed: **41,245 shared
> (season, name, pos) rows compared, 0 differ by more than 0.05**; 422,187 weekly rows, 0 differ
> (`scripts/history-rebuild-check.mjs`).
>
> **`fact_draft_pick` totals match `docs/league-tendencies.md` to the dollar** -- 2796 / 2783 / 2767 /
> 3157 for 2022-2025. **2026 is recorded as ABSENT** from the store copy rather than quietly missing
> from a table of counts.
>
> ### Nested CV that runs the SHIPPED code
>
> `ff evaluate-projection --seasons 2008-2025`. For each held-out season the TRAINER is re-invoked as
> a subprocess with `--holdout-season Y`, so the coefficients, the transform centres, the bucket means
> and the alpha search are all re-derived blind to Y; the artifact is loaded through the shipped
> loader; the projection comes from `projectSeason`, the same function the board calls. All three
> rungs are scored by one function, because a comparison between two things measured by two pieces of
> code is not a comparison.
>
> Pooled over 16 held-out seasons, 7,569 player-seasons. `crps` is the mean pinball loss over the
> three quantiles -- a proper scoring rule, and deliberately not the continuous ranked probability
> score, which we do not have the distribution for.
>
> | slice | carry rmse / r2 / crps | CURVE-ONLY | TRAINED |
> |---|---|---|---|
> | ALL | 59.2 / 0.428 / 13.8 | 55.0 / 0.504 / 13.1 | **54.4 / 0.516 / 12.8** |
> | QB | 86.6 / 0.480 / 21.4 | 86.6 / 0.487 / 21.6 | 84.7 / 0.511 / 19.7 |
> | RB | 69.0 / 0.267 / 16.0 | 62.2 / 0.403 / 14.9 | 61.7 / 0.414 / 14.7 |
> | WR | 54.4 / 0.423 / 13.1 | 49.8 / 0.518 / 12.8 | 49.3 / 0.528 / 12.7 |
> | TE | 39.3 / 0.421 / 9.2 | **37.1 / 0.484 / 8.7** | 37.3 / 0.479 / 8.5 |
> | rank 1-6 | 89.5 / -0.066 / 18.6 | **70.2 / 0.347 / 17.2** | 73.2 / 0.290 / 16.5 |
> | rank 7-12 | 66.8 / 0.294 / 15.5 | **63.1 / 0.369 / 15.2** | 63.9 / 0.355 / 14.6 |
> | rank 13-24 | 64.2 / 0.169 / 14.8 | 61.1 / 0.250 / 14.4 | 59.3 / 0.291 / 14.2 |
> | rank 25-40 | 67.7 / 0.057 / 17.4 | 64.8 / 0.139 / 15.5 | 63.0 / 0.186 / 15.2 |
> | rank 41-60 | 58.0 / 0.114 / 14.1 | 56.2 / 0.161 / 14.0 | 55.4 / 0.184 / 13.7 |
>
> Carry-forward is the free baseline; **the curve is the bar that matters**, because the curve is
> free too. The trained model beats it overall and loses to it at TE and at the top two rank bands --
> exactly the region a dollar is most expensive.
>
> ### THE GATE FAILED, AND THE CURVE-ONLY ARTIFACT SHIPS
>
> Pre-registered: the trained artifact must beat curve-only in BOTH pinball and RMSE on the pooled
> 2015-2025 holdouts, AND p10/p90 coverage must land in [0.75, 0.85].
>
> | | trained | curve-only | verdict |
> |---|---|---|---|
> | RMSE | 54.31 | 54.66 | PASS |
> | pinball | 12.62 | 12.91 | PASS |
> | coverage | 0.614 | 0.586 | **FAIL** ([0.75, 0.85]) |
>
> **The gate is all three, so the curve-only artifact is the shipped default.** No tuning was done
> afterwards: tuning against a gate you have already watched fail is how a gate stops being a
> measurement.
>
> Coverage per rank band tells you exactly where the bands are wrong, and it is worth reading before
> anyone "fixes" the pooled number:
>
> | band | curve-only inside | trained inside |
> |---|---|---|
> | 1-6 | 0.918 | 0.887 |
> | 7-12 | 0.887 | 0.858 |
> | 13-24 | 0.828 | 0.809 |
> | 25-40 | 0.651 | 0.680 |
> | 41-60 | 0.557 | 0.620 |
>
> Both artifacts fit their quantile heads on **ranks 1-36 only** -- past that the curve has flattened
> onto its last fitted value and `actual / curve` stops measuring dispersion. So the pooled 0.614 is
> a fit on one sample scored on another, and the honest reading is that the bands are slightly too
> WIDE at the top and much too narrow past rank 24. Widening the fitted range is the obvious next
> move and it belongs to Phase 2b with its own pre-registration.
>
> ### Residual slices, from those same per-fold residuals
>
> `ff residuals --seasons 2011-2025`, 7,263 rows. A large consistent bias says something real is
> missing; large-but-zero-mean is the ceiling.
>
> | slice | n | bias | sd | t |
> |---|---|---|---|---|
> | ALL | 7,263 | -0.0 | 54.4 | -0.03 |
> | **rank 1-6** | 527 | **-14.1** | 73.1 | **-4.42** |
> | **TE** | 1,369 | **-2.9** | 37.2 | **-2.90** |
> | **RB rank 1-6** | 89 | **-35.3** | 93.6 | **-3.56** |
> | **TE rank 1-6** | 88 | **-20.6** | 56.4 | **-3.42** |
> | **TE rank 7-12** | 86 | **-16.3** | 51.4 | **-2.94** |
> | WR | 2,435 | +2.0 | 49.3 | +2.01 |
> | rank 25-40 | 1,132 | +3.3 | 63.3 | +1.73 |
>
> **The model over-projects the elite tier and it is not close.** An RB entering top-6 comes in 35
> points under his projection on average; the same is true of top-12 tight ends. Phase 1 halved the
> top of the curve and this says it is still too high there.
>
> ### Feature screen (run once, nothing fitted)
>
> `scripts/feature-sweep.mjs` now reads candidates from `feat_player_season` and the residuals from
> `ff evaluate-projection --dump-residuals`. It no longer rebuilds its own model. 85 candidates,
> Benjamini-Hochberg FDR at 0.1. Survivors, `rho(bare curve)` / `rho(shipped)`:
>
> | feature | scope | n | rho(bare) | rho(shipped) | p |
> |---|---|---|---|---|---|
> | passAirYards | QB | 669 | +0.252 | +0.105 | 0.0063 |
> | epaPass | QB | 669 | +0.218 | +0.100 | 0.0094 |
> | teamPassEpa | all | 5,305 | +0.065 | +0.061 | 9.4e-6 |
> | primetimeShare | all | 5,305 | +0.061 | +0.061 | 7.4e-6 |
> | adot | WR/TE | 2,943 | -0.002 | +0.058 | 0.0018 |
> | tdPerYard | all | 4,974 | -0.020 | -0.047 | 0.0010 |
> | offSundayShare | all | 5,305 | +0.045 | +0.043 | 0.0017 |
> | rookieSeason | all | 5,305 | +0.022 | -0.041 | 0.0028 |
> | avgTemp | all | 5,305 | -0.035 | -0.036 | 0.0087 |
> | teamYards | all | 5,305 | +0.042 | +0.035 | 0.0106 |
> | twoPt | all | 5,024 | +0.017 | -0.035 | 0.0123 |
> | birthYear | all | 5,305 | +0.034 | -0.035 | 0.0118 |
>
> **NOTHING WAS FITTED FROM THIS.** Surviving is a licence to run a proper nested-CV evaluation and
> nothing more.
>
> **A control had to be repaired to stay a control.** The positive control is "age must correlate with
> the residual, because we know age is real". Once age became a fitted feature of the trained
> artifact, that control could no longer fire -- and a control that cannot fire looks exactly like one
> that is passing. It reported `NOT DETECTED ... the screen is mis-wired`, which was a false alarm
> about a real problem. The fix is a fourth rung, `bare`: the curve with an EMPTY multiplicative
> stage. Against it, age reads **rho -0.118, detected**, and against the shipped model **+0.004** --
> the model absorbing its own signal, which is the pattern that should be there. The negative control
> (a seeded random column) reads rho -0.013, p 0.356, and does not survive.
>
> ### The championship backtest, paired
>
> `--full --no-lookahead --inflation --seasons 2010-2024 --n 150`, i.e. the 14 seasons 2011-2024,
> which is exactly the range Phase 1's arm could run. Trials dumped, `scripts/paired-analysis.mjs`.
>
> | book | baseline | projector (curve-only) | mean | SE | t | 95% CI | seasons better |
> |---|---|---|---|---|---|---|---|
> | vor (mirror) | 40.2% | 41.7% | **+1.48pp** | 1.64 | 0.90 | [-1.48, +4.62] | 7/14 |
> | rank (independent) | 35.3% | 36.2% | **+0.90pp** | 1.76 | 0.51 | [-2.24, +4.33] | 7/14 |
>
> **P4 -- the projector arm is within noise of Phase 1's conditional arm. HELD.** Phase 1 measured
> +1.00pp (vor) and +2.33pp (rank); Phase 2a measures +1.48pp and +0.90pp through completely
> different code. Both are positive under both books and significant under neither -- the detectable
> effect at 80% power with 14 seasons is ~4.8pp, so this test could not have resolved an effect of
> this size either time. The baseline arm reproduced Phase 1's 40.2% / 35.3% to the tenth, which is
> what makes the two phases comparable at all.
>
> **P4's second clause -- "does not regress with the trained one" -- is NOT cleanly confirmed.** The
> trained arm was run properly, with `--artifact-dir` pointing at 15 per-season artifacts each blind
> to its own season (a single artifact fitted on 1999-2025 would have seen every season being
> replayed). It comes in at **39.0%**, i.e. **-1.29pp** against the baseline (SE 2.38, CI [-5.71,
> +3.19]) and **-2.76pp** against the curve-only arm (SE 2.33, CI [-7.05, +1.81]). Within noise both
> times, and directionally negative both times. Together with the failed coverage gate and the
> residual slices showing it over-projects the elite tier harder than the curve does, the picture is
> consistent: **the trained artifact is not ready and the curve-only one ships.**
>
> ### What was deprecated rather than migrated
>
> - **`scripts/nested-cv.mjs` and `scripts/residual-analysis.mjs` are DELETED**, replaced by
>   `ff evaluate-projection` and `ff residuals`. They reimplemented the curve and both multipliers
>   internally, so they measured a model we do not ship -- and that is not hypothetical: the harness
>   had been fitting `E[y | rank]` for years while the board applied an order statistic, which is
>   Phase 1's Finding A seen from the other end.
> - **`scripts/feature-value.mjs` is marked DEPRECATED at its head and left in place.**
>   `docs/validation.md` and `src/draft/age.ts` both cite its numbers, and deleting the source of a
>   recorded figure makes the record unverifiable. It should not be re-run to decide anything: it
>   derives prior rank and usage for itself by name, holds one season out and reports that as
>   out-of-sample, and scores against the order-statistic curve.
>
> ### Two defects found in passing, recorded rather than fixed here
>
> - **`fit-opportunity.mjs` never wrote the `bySk` map that `models.ts` REQUIRES.** The shipped
>   artifact carries 8,991 entries that came from somewhere else, so re-running the script as it
>   stood would have produced an artifact the registry rejects with "bySk map missing or tiny". The
>   migration onto `feat_player_season` fixes it, because the table carries `player_sk` on every row.
> - **The shipped opportunity amplitudes were fitted against a curve that had seen the future.** The
>   old script fitted one curve over the whole history and applied it to every year. Re-run against
>   the point-in-time column, RB's measured signal collapses from +0.0186 to **+0.0005** (amplitude
>   85% -> 3%) while WR rises to +0.0156 and TE holds at +0.0203. `data/opportunity-model.json` is
>   deliberately NOT refitted in this phase -- Phase 2a builds the pipeline, it does not move a
>   shipped number -- but this is a real finding and it should be the first thing Phase 2b re-measures.
> - **`player_ids` merges Marvin Harrison Sr. and Jr. into one raw row**: the father's name, team and
>   1973 birth date carrying the SON's gsis id. That is a RAW-layer defect upstream of everything
>   built here. The feature table reports his age as NULL rather than 52 only because of an
>   implausible-age clamp, which is a guard doing the right thing for a reason that would not
>   generalise to a father twenty years younger.
>
> ---

> ## PHASE 1 REDESIGN: the projection curve was the wrong quantity, and the season sim was half as
> ## uncertain as the world (2026-09-08)
>
> Three defects, found by asking what quantity each number actually IS rather than whether it looked
> reasonable. All three had been visible for the life of the project and none had ever failed.
>
> **THE HEADLINE THIS WAS MEASURED AGAINST IS 38.2%, NOT THE 34.9% THIS FILE RECORDED BELOW.** Read
> that first, because everything after it is a paired delta against 38.2%. On the shipped config
> (`playoffTeams: 7`, the synced league value) at HEAD `468ced6`, the flagless arbiter run returns:
>
> ```
> npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
>   CHAMPIONSHIPS: 38.2%  (random 6.3%)  |  playoffs: 96%
>   2000:32% 2001:37% 2002:25% 2003:52% 2004:43% 2005:15% 2006:55% 2007:20% 2008:33% 2009:41%
>   2010:39% 2011:57% 2012:52% 2013:37% 2014:35% 2015:29% 2016:30% 2017:29% 2018:41% 2019:35%
>   2020:35% 2021:45% 2022:53% 2023:31% 2024:54%
> ```
>
> **That is a stale record, not a drifted input, and it was checked rather than assumed.** The
> arbiter's own rule says a materially different number means an input moved, so: `npm test` 199/199,
> `typecheck` clean, `value-gates` ALL PASS, history covering 1999-2025, and the positional book
> totals identical to the dollar (QB $689, RB $1,213, WR $1,126, TE $403, K $45, DST $44). The inputs
> are the ones the 34.9% was measured on. What moved is CODE: 34.9% was written at commit `51ea5c8`
> and roughly twenty commits have landed since, several of which change what the simulator scores
> (`677b765` "every roster in the league was missing its defense", `fc869a6` "an unfillable slot
> scores replacement level, not zero", `0361075` K/DST added to the history pool). Two variants were
> run to rule out the obvious suspects: the pre-`93de4df` opportunity model gives **39.5%** (so the QB
> opportunity refit COSTS ~1.3pp and is not the inflater), and `playoffTeams: 6` gives **39.1% / 94%**
> (so the 96% vs 94% playoff line is entirely the 7-team playoff, and championships are unaffected).
>
> ---
>
> ### FINDING A -- the curve answered a different question from the one the board asks
>
> `buildCurveFromHistory` averaged the k-th best FINISHER's season and applied it to the player
> ranked k in preseason ECR. The k-th best finisher is an ORDER STATISTIC: by construction the best of
> everyone who could have finished there, carrying the winner's luck of whoever won the slot. The
> board needs a CONDITIONAL EXPECTATION -- E[points | this player enters ranked k] -- the average over
> everyone who entered there, busts included. Measured on `history-points.csv` (1999-2025):
>
> | pos k | order-stat | E[pts \| prior-year finish k] | E[pts \| preseason ECR k] (2020-25) | SHIPPED conditional |
> |---|---|---|---|---|
> | QB 1 | 400 | 264 (n 51) | 341 (n 12) | 322 |
> | QB 12 | 273 | 202 (n 127) | 242 (n 30) | 246 |
> | RB 1 | 345 | 225 (n 51) | 189 | 251 |
> | RB 12 | 208 | 170 (n 128) | 212 | 190 |
> | WR 1 | 326 | 212 (n 52) | 213 | 223 |
> | WR 12 | 201 | 164 (n 128) | 165 | 175 |
> | TE 1 | 238 | 160 (n 51) | 173 | 180 |
> | TE 12 | 120 | 90 (n 124) | 113 | 101 |
>
> **The error lands exactly where a dollar is most expensive.** VOR of the #1 player -- the number the
> entire auction book is scaled from -- goes QB **169 -> 90**, RB **203 -> 135**, WR **182 -> 101**,
> TE **134 -> 89**. Reproduce with `node --import tsx scripts/curve-report.mjs`.
>
> **This is regression to the mean, and it had been found three times already** -- in the age fit, the
> opportunity fit, and the bootstrap calibration -- and normalised away as a nuisance level shift each
> time. It was never a nuisance; it was this curve seen from three directions. `scripts/nested-cv.mjs`
> had been fitting `E[y | rank]` internally the whole time, so the validation harness and the shipped
> projection disagreed about what a projection even is. (Its numbers are therefore UNCHANGED by this
> work: age +0.0069, opportunity +0.0095, both +0.0157 over the market bar.)
>
> **How the two conditionals combine.** SHAPE from the prior-year-finish conditional (25 season pairs,
> n 50-130 per rank, stable, but conditioned on the wrong variable); LEVEL from the preseason-ECR
> conditional (the variable the board is actually indexed by, but only six seasons, n 12-30, and its
> RB curve is not even monotone -- RB1 189 < RB5 242 on n=12). Per-position ECR level factors: **QB
> 1.218, RB 1.116, TE 1.127, WR 1.074**. Isotonic non-increasing repair is applied because
> `baselines()` reads a replacement level off this curve, so a rise would hand a worse player a higher
> VOR. **Stated bias:** 635 of 3,329 preseason-ranked player-seasons never appear in the scored
> history -- a ranked player who never played is a hidden zero that is dropped, which biases the ECR
> level UP. The level correction is therefore conservative; the true conditional is lower still.
>
> **Book by position, before -> after.** All value gates PASS UNCHANGED -- no gate was touched.
>
> | | QB | RB | WR | TE | K | DST | top price | top QB |
> |---|---|---|---|---|---|---|---|---|
> | order-stat | $689 | $1,213 | $1,126 | $403 | $45 | $44 | $116 | $84 |
> | conditional | **$548** | $1,296 | $1,204 | $383 | $44 | $45 | $105 | **$60** |
>
> QB loses $141 of book against a room that really spends $240-330 there, and the money moves into RB
> and WR depth.
>
> **Independent corroboration from a completely different measurement.** `bootstrap-calibration.mjs`
> compares our projections against the historical pools, and every ratio moves toward 1.0: mean
> **0.81 -> 0.92**, with QB1 0.68 -> 0.86, RB1 0.63 -> 0.82, WR1 0.64 -> 0.88, TE1 0.59 -> 0.79.
> Spread preservation improves at every position (WR 0.37 -> 0.68, RB 0.52 -> 0.70, QB 0.58 -> 0.88).
> Players the [0.5, 2.0] guard refused to calibrate fall **113 -> 46**. Nothing in that script knows
> about the curve change; it simply stops disagreeing with the board.
>
> #### The championship number, paired -- and what it can and cannot support
>
> `--projection conditional` gives the backtest an EXPANDING WINDOW: the curve for season Y is fitted
> on season pairs strictly before Y. The market and bots are unchanged (prior-year actuals plus
> noise), so this isolates OUR book being a conditional expectation while the room's is still an order
> statistic -- the live situation.
>
> **Two limits bound how far this measurement reaches, and both are the honest kind.** (1) The
> FantasyPros archive begins in 2020 and rank 1 needs about five seasons of it, so NO backtested
> season through 2024 can receive the ECR level correction: this arm measures the SHAPE half only,
> while the shipped board gets both. (2) The window needs ~10 prior pairs before rank 1 has a sample,
> so the usable range is **2011-2024, 14 seasons**, and the baseline was re-run over exactly that
> range so the seeds pair.
>
> | book | baseline | conditional | mean | SE | t | 95% CI | seasons better |
> |---|---|---|---|---|---|---|---|
> | vor (mirror) | 40.2% | 41.2% | **+1.00pp** | 1.43 | 0.70 | [-1.90, +3.57] | 10/14 |
> | rank (independent) | 35.3% | 37.6% | **+2.33pp** | 1.32 | 1.76 | [-0.14, +4.86] | 9/14 |
>
> **Positive under both books, significant under neither** (detectable effect at 80% power with 14
> seasons is ~3.9pp, so this test could not have resolved an effect this size). The curve does not
> ship on this number. It ships on being the right quantity, on the book totals matching how the room
> actually spends, and on the calibration agreement above -- and the championship figure is recorded
> as directional, exactly as the age curve was.
>
> #### Pre-registered predictions, recorded whether or not they held
>
> - **P1 -- championships rise under both books. HELD in direction, not in significance.** +1.00pp
>   (vor) and +2.33pp (rank); neither CI excludes zero.
> - **P2 -- the `aggr` optimum moves to >= 0.8 under the conditional curve. FAILED.** Swept on the
>   same 14 seasons: **0.7 -> 41.2%**, 0.8 -> 39.5%, 0.9 -> 36.4%, 1.0 -> 31.2%. The optimum does not
>   move; it stays at 0.7 and the gradient away from it is steeper than before. `DEFAULT_LEVERS` is
>   deliberately UNCHANGED in this phase.
> - **P3 -- the `multQB 0.7` edge shrinks toward zero. HELD, and it reversed sign.** Against +1.97pp
>   measured on 2026-09-06 under the order-stat curve, the paired delta under the conditional curve
>   and the rank book is **-0.95pp** (SE 0.86, t -1.11, CI [-2.57, +0.71], better in 5/14 seasons).
>   That is the mechanistically satisfying result: `multQB 0.7` was a hand-tuned patch for exactly the
>   QB over-pricing this curve removes at source, and once the source is fixed the patch is dead
>   weight. It was already deliberately not shipped; this is the reason it never should be.
>
> ---
>
> ### FINDING B -- the season simulator was half as uncertain as the world
>
> The bootstrap pools were a flat bag of weekly scores per rank and the simulator drew each week
> independently. A player-season is not sixteen independent weeks: it carries persistent state -- a
> torn ACL, a bust, a breakout -- and independent draws average exactly that away. Measured on
> `history-weekly.csv` (16 played weeks per player-season):
>
> | pos rank | n | empirical season sd | iid-week sd | ratio | empirical p10/p90 | iid p10/p90 |
> |---|---|---|---|---|---|---|
> | QB 1 | 51 | 92.4 | 42.6 | 2.17 | 131 / 370 | 205 / 315 |
> | QB 5 | 126 | 86.4 | 35.4 | 2.44 | 108 / 340 | 193 / 283 |
> | RB 1 | 51 | 107.6 | 46.5 | 2.32 | 82 / 369 | 168 / 287 |
> | RB 10 | 129 | 86.2 | 36.0 | 2.40 | 62 / 284 | 123 / 215 |
> | WR 5 | 129 | 65.4 | 33.2 | 1.97 | 99 / 263 | 145 / 231 |
> | TE 3 | 76 | 52.7 | 27.3 | 1.93 | 66 / 203 | 100 / 170 |
>
> Every position and rank lands between 1.6x and 2.8x. Every consequence pointed the same way, toward
> FALSE CONFIDENCE: `spread.ts` p10/p90 bands about half their true width, over-confident title and
> playoff probabilities, and depth under-priced. `season.ts` drops `projSd` in bootstrap mode on the
> grounds that the pool already carries projection error -- it carries it PER WEEK, which is a
> different claim, and the two compounded.
>
> **`rank-outcomes.json` is now schema 2**: one array per player-season, in week order. The draw moved
> up a level -- from "which week does he post" to "which season does he have" -- with the same
> Cholesky groups, the same identity-keyed RNG (week 0 plus a new `PURPOSE.season`, so paired runs
> stay paired), and the same empirical quantile. Pools are sorted by SEASON TOTAL so the copula's
> uniform is a season quantile. A schema-1 file is REFUSED with an actionable message: read leniently,
> each of its weeks becomes a one-week season, which is this exact bug reintroduced by the data with
> nothing failing. The registry check is keyed on the SHAPE as well as the version number.
>
> **Measured after the change** (`scripts/verify-marginal.mjs`):
>
> | | pool sd | drawn sd |
> |---|---|---|
> | QB rank 3 | 89.2 | 88.4 |
> | WR rank 5 | 65.4 | 65.2 |
> | TE rank 4 | 52.6 | 53.0 |
> | RB rank 8 (uncoupled control) | 84.9 | 84.5 |
>
> - the WEEKLY marginal is untouched: worst quantile error **1.13%** of the p10-p90 span
> - `bootstrap-calibration` is UNMOVED at 0.92, which is the right negative control: preserving the
>   weekly marginal must not move a weekly statistic
>
> **Season odds, generated schedule, before -> after** (`scripts/season-odds-spread.mjs`):
>
> | | before (iid weeks) | after (trajectories) |
> |---|---|---|
> | favourite | 16.93% | **15.17%** |
> | median team | 4.81% | 4.87% |
> | worst team | 1.03% | **1.70%** |
> | favourite / worst | 16.5x | **8.9x** |
> | sd across teams | 3.66pp | 3.12pp |
>
> The favourite falls and the pack compresses -- what a correctly-wide season model does. The old one
> had effectively decided the draft settled the year.
>
> **KNOWN LIMIT, recorded now rather than discovered later.** The +0.348 QB-WR correlation was
> measured on SAME-WEEK residuals and is now applied to the season quantile. Season totals hit the
> target (**+0.329**); the same-week figure falls to **+0.107**, cross-team stays at +0.013. Teammates
> now share season quality, not the particular week they boomed. That is the right trade -- season
> dispersion was wrong by a factor of two, which dominates a weekly correlation that only moves
> head-to-head weekly variance -- but it is a real gap. Restoring the within-week component without
> disturbing the marginal is Phase 2, and it must not be done by scaling noise onto the scores.
>
> **A test was DELETED, and that is worth flagging.** `test/spread.test.ts` asserted "the band narrows
> RELATIVE to the total as weeks accumulate (it is a sum, not a scaling)". That was a correct test of
> a wrong model, and it would have blocked this fix. It is replaced by the invariance that actually
> holds, so a convolution cannot be quietly reintroduced.
>
> ---
>
> ### FINDING C -- the board showed the wrong man's age
>
> `player_bio` is keyed by name_key alone, so two real people sharing a name share a row. The board
> was the last consumer still joining on that name:
>
> | | before | after | whose birth date it was |
> |---|---|---|---|
> | Justin Jefferson (WR, ECR 9) | 23.5, rookie badge | **27.2** | a Browns LINEBACKER, born 2003 |
> | DeVonta Smith (WR) | 23.7, rookie badge | **27.8** | a different DeVonta Smith, born 2002 |
> | Lamar Jackson (QB) | 28.4 | **29.6** | the Panthers CORNERBACK, born 1998 |
>
> `stg_player` had all three right the whole time. Resolution now uses the rule this function already
> applies to `player_sk` -- position first, then a name belonging to exactly one player -- plus TEAM,
> which the first version of this fix omitted and which turned out to be load-bearing: `nameKey`
> strips generational suffixes on purpose, so **Marvin Harrison Jr. collapses onto his father**, and
> staging holds only the FATHER (WR, IND, born 1973). Position matches, so a name+position lookup
> returns a Hall of Famer who retired in 2008 and prints **53** on a 24-year-old. Requiring the staged
> row not to contradict the board's team rejects him and falls back to the bio row, which is his son's
> (24.1). That regression was introduced by this work and caught by diffing the top 100 rows, not by a
> test -- so it has one now.
>
> EXPERIENCE has no staged equivalent, so the bio `exp` is kept only where its birth date agrees with
> staging's; otherwise the row is somebody else's and so is his experience. Blank experience rises
> 40 -> 65 of 523 and blank age 40 -> 42. Those are cells where the honest answer is "we do not know
> which of two men this is". **Top-100 board rows changed: 3 ages, 4 experience values.**
>
> The age CURVE is unaffected -- it reads `bySk` and always did. This was a presentation defect, which
> is why it survived: every model was right and the thing people look at was wrong.
>
> ---
>
> ### What this phase did NOT do
>
> - **`DEFAULT_LEVERS` is untouched**, including `aggr`, despite the sweep above. Moving a shipped
>   lever is the owner's decision and belongs to its own measurement.
> - The conditional curve is measured in the backtest WITHOUT its ECR level half (see the two limits
>   above), so the backtested arm is strictly weaker than the shipped board.
> - Same-week teammate correlation is a recorded regression (+0.348 -> +0.107), deferred to Phase 2.

> ## The AGE CURVE ships, on R-squared evidence, with the championship number recorded as directional (2026-09-07)
>
> The rank curve knows nothing about WHO holds a rank -- a 33-year-old back and a 25-year-old back
> entering ranked RB8 got identical projections. `data/age-curve.json` is a fitted multiplier on it,
> applied by `projections.ts` and ON BY DEFAULT in the backtest (`--no-age-curve` to disable).
>
> **It earned inclusion before it was built.** `scripts/feature-value.mjs` measured it out-of-sample
> over 2,276 player-seasons, holding out one season at a time AND controlling for position:
> **+0.0154 R-squared** over a rank+position baseline. The position control was essential -- without
> it a sibling feature (opportunity) looks 3x more valuable than it is, because carries-vs-targets
> silently identifies position.
>
> **PER-POSITION amplitude, because the pooled test cannot say FOR WHOM.** Fitting and scoring age
> within each position separately: **RB +0.0369, WR +0.0204, QB +0.0072, TE -0.0019.** The first
> shipped curve had these backwards -- it gave QB the WIDEST swing (1.25 -> 0.83) on the smallest
> signal and gave TE a full curve on none at all, reshaping the top of the board hard (Drake Maye
> $73 -> $95, Josh Allen $91 -> $70) on evidence that did not support it. Each position's amplitude
> is now scaled to its own measured lift: RB 100%, WR 55%, QB 20%, **TE flat at 1.0**.
>
> **The championship translation is +0.6pp, t = 0.40 -- not established.** And the correction MADE
> THAT NUMBER WORSE: the over-amplified curve scored +2.0pp. That is the point rather than an
> embarrassment. A noise-fit can score well on any single measurement, and a backtest used as the
> only arbiter will happily reward one. The per-position R-squared test is the stronger evidence and
> it says the shipped amplitudes are right. `scripts/age-curve-effect.mjs` holds both arms frozen.
>
> **Shipped on the projection evidence, not the championship number**, because the board also feeds
> trades, waivers and season odds -- the projection improvement is real for all of them. Anyone
> quoting this as a championship gain is quoting a t of 0.40.
>
> **Two things were nearly shipped wrong and are worth remembering.** The first fit used raw per-age
> cell means, which (a) fitted noise -- QB came out 23 -> 1.44, 25 -> 0.98, 28 -> 1.10, with no
> monotone shape -- and (b) carried a level shift: the ratio averages ~0.87 because a player who
> finished RB8 got partly lucky and regresses, at EVERY age. That is regression to the mean, not
> aging, and applying it would have deflated every projection ~13%. Harmless for VOR (a uniform scale
> cancels in the dollar split) but not for the season simulator, whose bootstrap pools are calibrated
> against real point levels. The fix is a quadratic fit per position, normalised to a weighted mean of
> 1.0, so the curve carries the age SHAPE and nothing else.
>
> Known blemish: the TE curve turns back UP past age 34, which is quadratic extrapolation into cells
> holding 1-7 observations. The +/-25% clamp bounds it and no rostered TE is that old, but it is an
> artifact rather than a finding.


> ## K and DST existed on the live board but NOT in the backtest pool (fixed 2026-09-07)
>
> `src/data/history.ts` filtered history to QB/RB/WR/TE behind the comment *"K/DST aren't in this
> feed"*. **That comment was wrong.** Kickers are in `stats_player_week` (569 rows in 2024) with full
> distance-tiered columns, and team defenses are derivable from `stats_team_week` plus points-allowed
> from the schedule. Two consequences, both invisible because nothing ever failed:
>
> 1. **Every backtested season ran with two starting slots EMPTY for all 16 teams**, while the live
>    board (`points.csv`) carried 34 K and 32 DST. We validated on a pool we do not draft from.
> 2. **`maxKDst` was inert.** `--max-kdst 2` and `--max-kdst 60` returned an identical 36.5% -- a cap
>    on K/DST spending cannot bind when there is nothing to buy. A prior fix had added the missing
>    `--max-kdst` flag and closed the gap; the flag worked, the lever stayed dead, because the missing
>    piece was the DATA. Fixing the proximate cause is not fixing the cause.
>
> **The headline moves, and it is significant.** Paired by season, identical seeds, headline mode
> (`--full --no-lookahead`, n=150): **28.1% -> 35.6% championships, +7.5pp, t = 3.52, 95% CI +2.7 to
> +12.3** over 10 seasons. Playoffs 91% -> 94%.
>
> **The CURRENT headline is 34.9%, not 35.6%** -- that paired test was run before the DST scoring was
> ground-truthed against ESPN later the same day, which moved it 35.6 -> 34.9 (well inside the CI, so
> the +7.5pp conclusion stands). Both numbers are kept rather than one overwritten, because the delta
> and the level were measured at different points and quoting the newer level beside the older delta
> would imply a comparison that was never run.
>
> This is **not** the strategy improving. The backtest was *understating* it: fewer scoring starters
> means higher relative weekly variance, and variance dilutes skill, so a real edge converted to
> titles less often than it should have. Every championship figure below this line that predates
> 2026-09-07 was measured on the K/DST-less pool and reads LOW by roughly this margin.
>
> **`maxKDst` measured for the first time: not significant.** Uncapped vs the shipped $2 cap is
> **-1.4pp, t = -0.68, CI -6.1 to +3.3**. The cap is directionally right and costs nothing, so it
> stays -- but it is a reasonable prior, not a validated win, and should be described that way.
>
> **Face validity was checked before any of this was believed.** 2024 kickers come out Boswell 189,
> Aubrey 187, Dicker 173; 2024 defenses DEN 142, MIN 124, with CAR last at 11 -- the correct
> *ordering* against reality, not merely plausible magnitudes. And the simulated field spends **1.8%**
> of the room on K+DST against the real league's 1.3% historical / 3.2% in 2026, so the gain is not
> an artifact of bots overpaying for newly-available players.
>
> One mapping is INFERRED and flagged in `scoring.ts`: ESPN publishes DST points-allowed across stat
> ids whose tier boundaries are absent from the settings payload. The event values (sack 1, INT 2,
> fumble recovery 1, safety 3, TD 8) are read directly; the PA ladder uses the standard boundaries
> those values fit. Check it first if a DST total ever looks wrong.

> ## The backtest now plays a REAL SCHEDULE (2026-09-07)
>
> Until now `backtest.ts` had **no schedule at all**: it re-shuffled the whole field every week, so
> each opponent was an independent uniform draw. That is *unbiased* -- every team's average opponent
> is the league mean -- but it got two things structurally wrong: **no repeat cap** (you could draw
> the best roster four times and the worst never, where a real schedule caps any opponent at two),
> and **no correlated schedule risk** (in a real league you play three division rivals twice each, so
> a strong division is a season-long tax; independent weekly draws average that away entirely).
>
> Replaced by `src/draft/schedule.ts`: **standard divisional play** -- 6 in-division (double
> round-robin) + 8 cross-division (two other divisions once each; the third goes unplayed, which is
> forced by 14 weeks against 15 possible opponents). Non-16/4 leagues fall back to a plain
> round-robin, still better than random pairing. `--random-schedule` restores the old behaviour.
>
> **It does not move the headline number, and that was the expected result.** Measured as a matched
> pair on identical seeds (so the drafts are byte-identical and the schedule is the only variable),
> over 11 seasons at n=150: **+1.00pp, sd 4.34, t = 0.76, 95% CI -1.9 to +3.9pp.** Replacing an
> unbiased sampler with a real schedule buys realism, not a different answer -- and it confirms the
> historical championship figures in this file were *not* distorted by the missing schedule.
>
> `test/schedule.test.ts` asserts the invariants that separate a real schedule from a
> plausible-looking one (perfect matching each week, 6 in-division, every rival exactly twice, the
> 2-game repeat cap) **plus a positive control** that reproduces the old random pairing and asserts
> it FAILS those same invariants -- because a schedule test that passes on both is worthless.

> **Every championship number in this file is only meaningful together with the VALUE CURVE it was
> measured under.** On 2026-09-03 the FLEX-baseline allocation changed (even 3-way split ->
> points-weighted), which moved the whole bid table; see "Weighted FLEX baselines" below. Numbers
> measured before that date are EVEN-SPLIT-curve numbers and are retired as current guidance, the
> same way the old uniform-bot 36% figures were. **Current headline (weighted curve, full-system
> no-lookahead + inflation, realistic field, **1999-2024 (25 scored seasons)**, n=150): **34.9%
> championships, 94% playoffs**, and 34.1% on the 1999-2013 holdout that no tuning ever saw.
> When you record a new number here, name its curve.

Two tools, both offline/fast/deterministic per seed:
- **`ff backtest`** (the trustworthy one for CHAMPIONSHIPS): drafts on a past season's projections,
  then plays a real head-to-head season + playoffs on that season's ACTUAL weekly results ->
  reports our **championship rate**. Weekly variance, byes, and single-elim playoffs are real, so it
  rewards the RIGHT thing.
- **`ff sim`** (fast season-points proxy): one draft, score by starting-lineup season points. Handy
  for quick iteration, but it over-rewards top-heavy rosters (no playoffs) -- prefer backtest for
  strategy calls.

## Live mock drafts (2026-09-04): 10 complete ESPN practice auctions

Run end-to-end through the desktop app's embedded webview (`scripts/mock-suite.mjs 10`, records in
`data/mock-runs.jsonl`, analysis `scripts/analyze-mocks.mjs`). Expectations were written down BEFORE
the runs (`scripts/expectations.mjs`) and split into two classes, because only one transfers to a
practice room full of ESPN AUTO teams.

**Mechanics invariants -- all held, 10/10 drafts:** roster completes 12/12; exactly 2 K/DST every
draft, never benched; no K/DST above $2; TE count 1-3 (expected 1-4); every bid resolved from our
table (`src=ours` 442/442 on the current build); zero stalls or disconnects. Mean 41 min per draft.

**Spend was NOT what I predicted, and the prediction was the pessimistic one.** Expecting the bots
to overpay, I predicted live spend well BELOW the offline band; live median came in at **$171**
against an offline median of **$170** (range $167-175 on the fixed build; the lone $140 was draft 1
on the pre-benchDiscount build). Treat "auto-bots overpay, so we will spend less" as unsupported at
this roster size -- the room does spend its whole budget, and we get our share of what is left.

**Still do not tune strategy on mock outcomes.** The opponent model is wrong (generic AUTO teams,
not this league's 16 managers), so the backtest remains the arbiter for anything about VALUE. The
mocks are the arbiter for MECHANICS, which is what they caught:

- three concurrent `auto-draft` processes sharing one seat (killing a launching shell does not kill
  the node tree on Windows) -> single-instance PID lock;
- `Steelers D/ST` arriving with `pos=K`, so a position-gated DST alias missed it -> alias now keys
  off the NAME;
- every nomination firing twice. **Investigated and NOT a defect:** the repeat targets the same
  player and exactly one nomination results (mock 3: A.J. Brown r283/r291 -> bid r304). A cooldown
  reduces the redundant clicks; do not "fix" it further without evidence a duplicate ever nominates
  a DIFFERENT player.

**Three of the bugs were in the MEASUREMENT, not the engine** -- each made results look fine:
`(rec.dupeNominations||[]).length` reporting 0 for a field the suite never wrote; `"H. Fannin Jr."`
taking "Jr." as the surname so suffixed players fell out of the TE count (mean 2.10 -> 2.50 once
fixed); and logs paired to records POSITIONALLY while two suites both wrote `mock-01.log`. Check the
instrument before believing the reading.

## The opponent model's per-manager profiles carry NO out-of-sample signal (2026-09-05)

`ff calibrate` compares each simulated owner's positional spend to that owner's historical average
and reports small errors -- but **the profile is built from exactly the seasons it is scored on**.
That is fitting and grading on the same data; a profile can look perfect there and predict nothing.
`scripts/manager-stability.mjs` asks the out-of-sample question instead, leave-one-season-out:
does an owner's own history predict their HELD-OUT season better than assuming they draft
league-average?

League history pulled back to 2012 (the scraper defaulted to `--years 4`, which is why the first
pass had only 50 cases; the league has run since 2012 -> **98 team-seasons, 18 owners**):

| predictor | mean abs error on the held-out season |
|---|---|
| the owner's own past seasons | **7.99 pp** |
| "everyone drafts league-average" | **7.67 pp** |

**The personalised profile is WORSE, and wins in 44/92 cases (48%) -- a coin flip.** Manager
positional tendencies vary more year-to-year than they do between managers. So the heterogeneous
field is not the edge the docs implied, and `calibrate`'s numbers are an in-sample fit statistic,
not a validation.

### Does that break the strategy conclusions? No -- tested, not assumed

`--homogeneous` replaces every bot with one league-average manager: the honest null field. Shading
survives and gets STRONGER:

| field | aggr 0.7 | aggr 1.0 | delta |
|---|---|---|---|
| heterogeneous, vor book | 34.6% | 24.4% | +10.2 |
| heterogeneous, rank book | 36.7% | 26.6% | +10.1 |
| **homogeneous (null field)** | **29.8%** | **16.7%** | **+13.1** |

Shading does not depend on modelling opponent identities we cannot actually predict. Combined with
the 1999-2013 season holdout (+8.6pp) and the marketSd sweep, it is robust on every axis tested.

### What this DOES invalidate

Per-owner targeting advice. `ff cheatsheet` prints lines like "nominate a top QB early to drain
<owner>, <owner>, ..." -- that is precisely the per-owner prediction this test shows we
cannot make. Treat the drain plan as entertainment, not strategy. (The `--drain-nom` lever was
already backtest-rejected, so nothing in the shipped bidding path depends on it.)

### What the deeper history DID improve

The extra seasons feed two things that are NOT per-owner predictions and so are unaffected by the
null above: `maxBuy` (the budget-anxiety cap -- 98 team-seasons instead of 54) and `leagueShare`
(the rank book's level anchor; QB share settles at 7.8% over 14 years vs 9.4% over 4). Face validity
holds at **9/10** and the shipped default is verified on the fuller data: **32.9% (vor book) /
34.2% (rank book)**, 94-95% playoffs.

## Bot budget anxiety: fixing the top of the market (2026-09-05)

`scripts/sim-vs-mock.mjs` compares the SIM against the 10 live ESPN mock drafts we ran
(`data/draft-log-*.json`, every pick + price) and against this league's real drafts, truncating all
markets to the same 90-pick prefix (auto-draft exits when OUR roster fills, so the mock logs cover
only the early/mid draft -- comparing 90 picks against 192 would be meaningless).

It found one defect confirmed by TWO independent references at once: the ESPN mocks top out at
**$105** and this league's real drafts at **$103**, while the sim was pricing its top player at
**$132 (vor) / $147 (rank)**. No manager in this league has ever paid that: historical `maxBuy` runs
$47-89, mean $72.

**Cause:** `makeBotBidder` ignored `profile.maxBuy` entirely -- the bots had no budget anxiety, so
nothing stopped two of them escalating a stud past any price a human would pay. **Fix:** a SOFT cap
at `maxBuy x U(0.95, 1.30)`, soft because `maxBuy` is an average of yearly maxima and a manager can
exceed it in a given year; a hard ceiling would clip the top of the distribution flat.

| top price | before | after | reference |
|---|---|---|---|
| sim, vor book | $132 | **$99.5** | ESPN mocks $105, real league $103 |
| sim, rank book | $147 | **$101.4** | |

The calibrated rank book now scores **9/10** face-validity metrics (only median $3.5 vs $2 remains),
with QB $297 and TE $237 both in range.

### The correction removed the model disagreement

Every lever had been tuned against the old, too-hot field, so the shipped config was re-verified.
The two opponent models now AGREE:

| aggr | corrected vor | corrected rank |
|---|---|---|
| 0.6 | 32.7 | 34.6 |
| **0.7** | **34.6** | **36.7** |
| 0.85 | 30.5 | 30.7 |
| 1.0 | 24.4 | 26.6 |

0.7 is the peak under BOTH books -- the minimax tension that briefly argued for 0.6 was an artifact
of an unrealistic field, not a real uncertainty. Shading remains the largest lever (+10.2pp vor,
+10.1pp rank). Shipped default verified flagless: **34.6% championships, 94% playoffs**.

### What the sim/mock comparison also settled

**The sim models this room better than the ESPN mock rooms do.** Positional-$ distance from your
2025 draft: **sim rank book 123, ESPN mocks 341, sim vor book 728**. The mock rooms punt QB far
harder than your league ($144 vs $328 over the same prefix), which is why mock outcomes were never
used to tune strategy -- that refusal now has a number behind it. Money FLOW matches everywhere
(~$3,000 in the first 90 picks across all three markets).

Remaining gap: the sim has 8-12% of early picks at $1-5 against the mocks' 28%, so our bots bid up
the early-mid tier more uniformly than real auto-teams do.

## Breaking the self-reference + calibrating the opponent model (2026-09-04/05)

The sim's bots priced players with `computeValues` -- OUR OWN valuation function -- so the field was
a noisy mirror of us. That is the self-reference that hid the FLEX-baseline bug for months, and an
edge measured against it might be an edge against ourselves. `--bot-book rank` gives the bots a
structurally independent book: shape from a rank-decay curve, level anchored to this league's real
positional spend. `scripts/book-compare.mjs` gates it -- same dollar scale (else a cheaper book alone
looks like an edge) but genuinely different pricing (rho 0.87, 195/516 identical).

**Face validity: does either book reproduce how this room ACTUALLY prices?**
`scripts/face-validity.mjs` scores 40 all-bot drafts against the three real drafts in
league-tendencies.md. The two books failed in OPPOSITE ways:

| metric | vor book | rank book (decay 2.2) | real |
|---|---|---|---|
| median price | 1.4 ok | **8.0 OFF** | $2 |
| % picks $1-5 | 57 ok | **39 OFF** | 61% |
| QB total | **550 OFF** | 289 ok | 192-328 |
| TE total | **336 OFF** | 153 ok | 199-215 |

The VOR book gets the price SHAPE right and the POSITIONAL SPLIT wrong -- **the bots inherit our own
QB/TE overvaluation**, which is the self-reference made visible and measurable. The rank book did the
reverse. Calibrating the decay against the real distribution (`RANK_DECAY` 5) fixes the shape while
keeping the split: total **$3,157** (2025 exactly), median $2.9 vs $2, 60.1% vs 61% cheap picks,
QB $296, TE $233 -- **9 of 10 metrics** within tolerance.

**Known residual:** top price $148 vs a real $88-106. Our bots are not budget-anxious at the very
top, so the stud market is modelled hotter than reality. Conclusions about the most expensive handful
of players -- `maxShare` above all -- are the least trustworthy part of the model.

### The headline survives; the tuning briefly did not

Shading is worth **+9.2pp against the independent book** (27.1% vs 17.9% at decay 2.2) and remains
the largest lever under every framing tested. But the OPTIMUM moved, and the story is worth keeping:

| aggr | 0.6 | 0.65 | **0.7** | 1.0 |
|---|---|---|---|---|
| vor book (mirror) | 32.9 | 33.3 | **34.9** | 25.3 |
| rank book (calibrated) | **34.7** | 34.2 | 34.3 | 25.8 |
| worst case | 32.9 | 33.3 | **34.3** | 25.3 |

**Shipped 0.7 on minimax.** An earlier UNCALIBRATED rank book put the optimum at 0.5 and made 0.7
look like a collapse to 27.1%, on which 0.6 was briefly shipped -- then face validity showed that
book had a median price of $8 and 39% cheap picks, i.e. it modelled a room that does not exist.
Calibration moved the optimum to a 0.6-0.7 plateau and restored 0.7.

**The lesson: a robustness check is only as good as the realism of the challenger it tests against.**
An unvalidated alternative model overruled a correct result for about an hour. Validate the
challenger before letting it change a decision.

Verified flagless: **34.9% (vor book) / 34.3% (calibrated rank book)**.

## Properly-powered paired statistics on 25 seasons (2026-09-04, supersedes the 9-season figures)

Run with `--dump-trials` (per-(season, seed) outcomes) + `scripts/paired-analysis.mjs`. Seeds are
COMMON RANDOM NUMBERS, so each trial is a matched pair; the unit of GENERALISATION is the season, so
the CI is bootstrapped over seasons, not trials.

**Shading vs no shading** (shipped vs aggr 1.0), 25 seasons, 5,000 paired trials each:

| test | result |
|---|---|
| McNemar (trial pairs) | 1,239 vs 746 discordant, chi2(1) = **121.95**, p < 1e-6 |
| season-level paired mean | **+9.86pp** (SD 7.55, SE 1.51, t = 6.53 on 24 df) |
| bootstrap 95% CI over seasons | **[6.92, 12.90]pp** |
| seasons better | **24 of 25** |

**Reserve/share change** (shipped r4/s0.25 vs old r15/s0.35):

| test | result |
|---|---|
| McNemar | 530 vs 437, chi2(1) = 8.75, p = 3.1e-3 |
| season-level paired mean | **+1.86pp** (SE 0.55, t = 3.37) |
| bootstrap 95% CI | **[0.74, 2.92]pp** |
| seasons better | 19 of 25 (worse in 5) |

> **CORRECTION.** This file previously reported the reserve/share change as **+3.44pp, better in 9 of
> 9 seasons, t = 6.85**. That was measured on the 9-season window the config was SELECTED on. On 25
> seasons the same comparison is **+1.86pp and it loses in 5 of them**. The "9 of 9" was a
> small-sample artifact of the tuning window, not a property of the change. The effect is real
> (CI excludes zero) but roughly HALF the advertised size. Detectable effect at 80% power with 25
> seasons is ~1.6pp, so this sits barely above the floor -- treat it as a modest, real improvement,
> and do not quote the old figure.

**Component levers re-verified on all 25 seasons** (baseline = shipped, 34.9%), because the 91-cell
campaign ran on 9 seasons only:

| lever | off / alternative | shipped | delta |
|---|---|---|---|
| benchDiscount | 1.0 -> 30.5% | 0.25 -> **34.9%** | +4.4pp |
| live inflation | off -> 30.7% | on -> **34.9%** | +4.2pp |
| premium | 0 -> 32.5%, 4 -> 33.6% | 2 -> **34.9%** | +2.4pp vs 0 |

`premium` is worth noting: on 9 seasons it read as flat noise across 0/1/2 and I nearly called it
irrelevant. On 25 seasons premium 2 clearly beats premium 0 by +2.4pp. **More seasons changed a
"no effect" into a real one** -- the same power problem that made three positional multipliers look
like gains, running in the other direction.

## The lever campaign + a proper holdout (2026-09-04)

91 pinned backtest configurations (`scripts/full-sweep.sh` -> `data/full-sweep.tsv`), then a
confirmation pass, then -- the part that changed the conclusions -- history extended from 9 scored
seasons to 25 (`ff build-history --seasons 1999-2024`, 26 seasons / 137,643 player-weeks). **Seasons
1999-2013 were never used in any tuning, so they are a genuine holdout.**

| config | tuning 2015-24 | HOLDOUT 1999-2013 |
|---|---|---|
| no shading (aggr 1.0) | 28.0% | 24.5% |
| old default r15/s0.35 | 33.7% | 33.1% |
| **shipped r4/s0.25** | 37.0% | **34.1%** |

**Shading replicates and grows on unseen data** (+8.6pp holdout vs +6.6pp tuning) -- a real effect.
**The reserve/share gain SHRANK from +3.4pp to +1.0pp** -- same sign, one third the size. That is
selection bias: the cell was chosen as the best of 91, so part of its margin was the winner's curse
operating on our own search. It still ships (positive out of sample), but **the honest effect size
is +1.0pp, and without the holdout the docs would have claimed +2.8**.

### What the campaign actually established

- **`aggr` 0.7 -- the winner's-curse correction, and the biggest single lever.** Drafting is a
  common-value auction on noisy estimates, so the winner is disproportionately whoever OVERestimated;
  shading ~30% offsets it. Interior optimum (0.4 -> 23.4%, 1.15 -> 25.4%). **Robust to the one
  assumption it depends on**: swept against `marketSd` 0.20/0.30/0.45, the optimum stays at 0.6-0.7
  in all three and aggr 1.0 is the worst cell in all three. That matters because `marketSd = 0.30` is
  a pure assumption -- `ff calibrate` validates the bots' positional SPEND, never their projection
  noise.
- **`maxShare` binds; `starterReserve` is nearly inert.** At fixed share, reserve 0..8 differ by
  <1pp; share moves championships ~6pp. The earlier "reserve 15 is optimal" was share moving
  underneath an irrelevant dial. Share peaks at 0.25, bracketed both sides.
- **No aggr x reserve ridge.** aggr 0.7 wins at every reserve; lower reserve wins at every aggr.
- **Inflation ON is worth +4.8pp** at aggr 0.7 (the +2pt claim was measured at aggr 1.0).
- **`premium` 2 is already near-optimal** (0 -> 34.1, 1 -> 35.1, 2 -> 34.6, 4 -> 31.6, 6 -> 28.2).
  A predicted failure that did not happen -- recorded because the prediction was wrong.

### Every positional multiplier is 1.0, and that is a finding

`multQB/RB/WR/TE` exist (unit-tested, persisted, sweepable) but all ship at 1.0. Three separate
positional "gains" evaporated when re-measured against a corrected baseline:

| candidate | at the baseline it was found on | re-measured |
|---|---|---|
| multQB 0.7 | +1.3pp (aggr 1.0) | **0.0pp** at n=800 under aggr 0.7 |
| multRB 0.8 | +1.0pp (aggr 1.0) | **-1.9pp** -- sign reversed |
| multWR 0.85 | +1.2pp (r15/s0.35) | **-0.5pp** at r4/s0.25 |

All three were the GLOBAL shading effect wearing a positional costume. **The rule this earns: before
shipping a narrow lever, check whether a broad one already explains it** -- and always re-measure a
candidate against the baseline you actually intend to ship, not the one it was discovered on.

### Statistics: the unit of analysis is the SEASON

n=800 x 9 seasons is not 7,200 independent draws; it is 800 noise re-draws over the same 9 seasons.
For "will this help in a season we have never seen", the effective n is the season count. Seeds are
COMMON RANDOM NUMBERS (`seed = s + 1 + yr*1000`), so configs meet identical market noise and bot
seats -- every trial is a matched pair, and `--dump-trials <path>` now emits per-(season, seed)
outcomes so paired tests can be run properly instead of comparing two aggregate percentages.

Paired per-season result on the 9-season tuning window was +3.44pp, better in 9 of 9. **On 25
seasons it is +1.86pp, better in 19 of 25** -- see the correction above; quote the 25-season figure.
The detection floor at 80% power is ~1.6pp, which is why the +1.2pp WR candidate could never have
been trusted from a single sweep.

### Known structural weakness (not yet fixed)

The sim's bots bid `trueVal` from `computeValues` -- OUR OWN valuation function -- plus noise. This
is the same self-reference that hid the FLEX-baseline bug for months, and it means some of the
shading gain is a correction for bidding against a noisy copy of ourselves. Giving the bots an
INDEPENDENT value model (ADP, or ESPN's published values) is the highest-value remaining change.
`calibrate` should also be extended to reproduce the league's real price DISTRIBUTION (median $2,
61% of picks $1-5, top $80-106 from league-tendencies.md), not just positional spend shares.

## benchDiscount (2026-09-04): a bench-only player is not worth his standalone value

Found by reading actual sim rosters rather than aggregates: with a filled QB slot the agent would
still pay real money for a second QB (one seed: Burrow $56 AND Herbert $36 -- $92 of a $200 budget
on a position that starts one player, next to a single RB). Our value table prices every player as
if he starts; a player who can only fill a BENCH slot never enters the lineup, so that price
overstates what he is worth to THIS roster.

`benchDiscount` multiplies our value when the on-block player fits ONLY a bench slot (starter and
FLEX slots are untouched -- unit-bound). Swept on the championship backtest, full-system
no-lookahead + inflation, 2015-2024:

| benchDiscount | 1.0 (was) | 0.7 | 0.5 | 0.3 | 0.25 | 0.2 | 0.1 | 0.0 |
|---|---|---|---|---|---|---|---|---|
| n=150 | 25.7% | 25.9% | 26.2% | 27.3% | -- | 27.5% | 25.9% | 19.6% |
| n=400 | **24.4%** | -- | -- | 26.9% | **28.0%** | 27.1% | -- | -- |

**Shipped default 0.25: 24.4% -> 28.0% championships at n=400 (SE ~0.6, so ~6 SE), better or equal
in all 9 seasons.** The curve has a real shape rather than a monotone slope -- it peaks at 0.2-0.3
and COLLAPSES to 19.6% at 0.0, because a roster that never buys bench depth loses to byes and
injuries. That collapse is the evidence the lever is doing what it claims: if the gain were noise
or a degenerate "spend less" effect, 0.0 would be best.

The default is carried in `DEFAULT_LEVERS` **and** written to the persisted config (`settings.config`),
which is what the live agent actually reads -- `scripts/set-lever.mjs` patches it and reads it back.
Verified end-to-end by running the backtest with NO flag and getting 28.0%, so the shipped default
is genuinely on (defining a lever and never wiring it reads identically to a lever that does nothing).

**Reserve/max-share re-verified under the new discount** (3x3, n=150): the shipped 15/0.35 is now
the outright best cell at 28.9% (next: 0.45 at 27.9%, reserve 20/0.35 at 27.5%); reserve 10 is worse
at every share. Defaults unchanged.

### Rejected: an extra discount for bench players who cannot fill FLEX (2026-09-04)

Live mock 2 finished with FOUR QBs (Allen $58 + Burrow $12 + Hurts $6 + Herbert $5) in a league that
starts one, and the sim agrees: QB count stays median 3 / max 5 even WITH benchDiscount. Hypothesis:
a bench RB/WR/TE can be started in a FLEX slot on a bye or injury week, but a backup QB starts only
if our starter is out, so he should be discounted further.

Swept `benchNonFlex` (an extra multiplier on bench-only QB/K/DST), n=150: **28.9% / 28.4% / 28.8% /
28.4%** at 1 / 0.6 / 0.4 / 0.2 -- flat inside noise. **Rejected; the lever was removed.**

The null is trustworthy because the lever was proven CONNECTED first
(`scripts/lever-connected.mjs benchNonFlex 1 0.2`): it does change the drafted roster, QB 3.30 ->
3.17 per draft. A dead lever produces exactly the same flat line, so a sweep alone cannot tell the
two apart -- always check the lever moves the roster before believing its null.

**Why it cannot help, structurally:** the QBs in question cost $1-5. The fill-floor guarantees $1 for
any slot we still need, so no discount short of refusing the position outright changes whether a $1
bench QB is taken -- it only changes what we would have paid, and we were already paying the floor.
Cheap bench QBs are not what costs championships.

**Refusing the position outright (2026-09-05): also rejected, and mildly NEGATIVE.** The sweep above
could not reach the one case its own conclusion names, so it was tested directly: a hard guard that
returns `maxBid: 0` for a QB who can only fill a bench slot (the same rule already applied to bench
K/DST). Full-system no-lookahead, 25 seasons, n=150: **31.3% championships / 92% playoffs vs the
shipped 32.9% / 94%.**

Season-level, which is the unit that generalises: **7 seasons better, 4 tied, 14 worse.** McNemar on
the 21 discordant seasons gives p ~= 0.19 -- not a significant regression, but no evidence of a gain
and a 2:1 lean against. Rejected; the lever was removed.

The mechanism is worth keeping, because the intuition is wrong in an instructive way. A bench K/DST
is genuinely dead roster -- it is streamed weekly and can never enter our lineup. A backup QB is not
the same object: in a 1-QB league he is real bye-week and injury insurance, and losing the starter
with no backup is catastrophic. Forcing the guard also spends those $1 slots on a *fifth WR* --
depth behind depth. `scripts/sample-rosters.mjs` shows the swap cleanly at equal cost (seed 1:
QB 5 -> 1, RB 1 -> 2, WR 2 -> 5, both at $117). The sim prices that trade correctly and it is a
small loss, not a win.

## Weighted FLEX baselines (2026-09-03) -- the largest single value fix to date

`baselines()` in `src/draft/values.ts` split the league's 32 FLEX slots evenly across RB/WR/TE
(`round(flexTotal / 3)` = 11 each). Filling those slots with the best leftover players by projected
points instead gives **RB 13 / WR 19 / TE 0** -- TE wins none. The even split therefore took TE's
replacement baseline 11 ranks too deep (TE28 @ 71.0 pts instead of TE17 @ 103.1), inflating every
TE's VOR, and symmetrically starved WR (baseline WR28 @ 159.8 instead of WR36 @ 143.5).

Effect on the shipped bid table (`player_value`), before -> after, vs what the room actually spent
in 2025: TE book **$803 -> $421** (room ~$206); WR **$843 -> $1,127** (room ~$1,291); RB
**$1,087 -> $1,187** (room ~$1,292); QB $704 -> $707 (room ~$328 -- our deliberate contrarian
stance, deliberately kept). Per player: Bowers $90 -> $72, McBride $66 -> $49, Kelce $35 -> $17;
Chase $90 -> $99, Nacua $72 -> $81, Jefferson $41 -> $50, Gibbs $107 -> $111.

Measured on `ff backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 400`
(n = 400 x 9 scored seasons = 3,600 trials/arm; SE ~0.6 pts; random baseline 6.3%; deterministic
per seed, so these are exact and reproducible, not estimates):

| arm | our book | market book | championships | playoffs | per season 2016..2024 |
|---|---|---|---|---|---|
| M1 (pre-fix) | even | even | 13.6% | 70% | 13 11 11 14 13 14 18 17 12 |
| M2 (our values only) | weighted | even | 22.2% | 83% | 13 19 19 25 22 30 29 27 18 |
| **M3 (SHIPPED)** | weighted | weighted | **24.4%** | **87%** | 20 22 21 30 29 23 31 27 17 |

M3 is the conservative frame -- the sim's bot book is computed by the same `baselines()`, so
landing the fix makes the modelled market rational too -- and it still beats M2, because a rational
market prices TEs sanely and our other edges (the real lineup optimizer, budget discipline) do the
rest. Weighted-everywhere therefore ships as ONE behavior; no two-track split was needed.

**Bot calibration improved as predicted** (`ff calibrate --n 300`, mean abs error sim vs real
2023-25 spend): WR **18% -> 7%**, RB 8% -> 6%, top-3 concentration 8% -> 7%, TE 2% (unchanged),
QB 7% -> 8%. A lower-TE book makes the modelled bots spend near the room's real ~7% TE share.

**Why nothing caught this earlier:** the sim's bot book (`trueVal` in `sim.ts`) is computed by the
SAME `baselines()`, so the entire backtest ecosystem shared the artifact and graded its own
homework; the unit tests use fixture tables. The bug could only bite in a REAL room, where TEs are
priced at market -- the agent would have "won" mid-TEs at a discount against its own wrong book,
stuffed both FLEX slots with them, and underbid WRs, in a half-PPR league. `test/values.test.ts`
now locks the weighted fill, keeps the even split reachable for regression, and carries a fault
injection that fails if the default flips back.

**Levers re-verified under the new curve** (3x3, n=150, SE ~1.0 pt). The defaults were tuned on the
old curve and still hold:

| reserve \\ maxShare | 0.25 | 0.35 | 0.45 |
|---|---|---|---|
| 10 | 22.1% | 24.6% | 23.2% |
| **15** | 24.6% | **25.7% (default)** | 25.9% |
| 20 | 24.4% | 24.1% | 24.1% |

Best cell (15/0.45, 25.9%) is 0.2 pts from the shipped 15/0.35 -- far inside 2 SE, so the defaults
are unchanged. The plateau is broad; reserve 10 and 20 are both worse than 15 at every share.

## `ff backtest` -- optimize championship wins (2024)

`npm run ff -- backtest --n 800 [--starter-reserve N --max-share F --premium N]`
Draft with 2024 values (data/values-2024.csv, from data/points-2024.csv), simulate the 2024 season
(weeks 1-14) + playoffs (top `playoffTeams` from the synced config -- currently 7, not the 6 this
line used to claim; weeks 15-17) on real weekly points (data/weekly.csv). Lineups are set
each week by projection, scored by ACTUAL, and a bye/injured starter can't play -> DEPTH matters.

**Projection UNCERTAINTY (the key knob, default sd 0.30):** everyone drafts on a NOISY projection of
the season (a stud can be mis-projected), scored by the real weekly truth. Without it the draft has
perfect foresight and trivially rewards concentration; with it, buying "studs" carries real bust risk.

### Run it across MANY seasons (essential -- single seasons overfit)

`ff backtest --seasons 2014-2024 --n 150` loops every season in `data/history-{points,weekly}.csv`
(built by `tools/build_history.py`) and aggregates. **Always use the multi-season number** -- a
single season's championship estimate swings 25%<->50% for the SAME config just on seed/sample
noise, so single-season "findings" are overfit (I made that mistake: a 2024-only run showed
"reserve 5 = 50.6%, optimal", which did NOT replicate -- 2024 at high N is ~25%).

### Injury-proneness is NOT an effective draft lever (2026-09-03)

Tested a proposed lever that discounts OUR values by prior-season availability (`avail = games /
the busiest player's games`), modelling "pay less for injury-prone players". Wired as
`backtest --injury-lever F` (F=0 is the baseline; only our team applies it, the field still bids on
market). Full-system no-lookahead, n=250/season, 2015-2024:

| injury-lever | 0 | 0.3 | 0.5 | 0.8 |
|---|---|---|---|---|
| championships | 11.3% | 11.2% | 11.0% | 11.3% |

Flat (<=0.3pp = noise). The lever IS connected -- per-season rates move between settings (2018:
8/9/8/10; 2023: 12/14/13/14), proving the discount changes picks -- so this is a real null, not a
dead no-op. **Why it doesn't help:** (1) prior-season POINTS already embed games missed (fewer games
-> fewer points -> lower value), so an extra availability discount double-counts without new signal;
(2) prior-year availability is a weak predictor of next-year availability (injuries don't persist);
(3) the full-system backtest already prices in-season availability (a missed week scores 0 through
the real lineup optimizer). The flag is kept (defaults off) for re-testing if a stronger
injury-history signal is added. **Caveat -- what this does NOT test:** a FRESH injury (ruled out this
week, not yet in ECR). The backtest's projection IS prior-year actuals, so it has no
"news-ahead-of-the-ranking" case -- which is exactly the real-world value of the board's live injury
flags + Hide-OUT filter, a human/agent overlay, not a value term.

### Rookies are NOT cleanly testable as a lever (structural, 2026-09-03)

A rookie bonus/penalty can't be A/B'd in the trustworthy no-lookahead backtest: it drafts on the
PRIOR season's actuals (`projYr = yr-1`), and a rookie has no prior season, so rookies are absent
from the draft pool entirely -- there is nothing for a rookie lever to act on. Testing one would need
a rookie projection source in the historical data (draft-capital / prospect model), which we don't
have. In production, rookies are valued purely by their ECR rank (consensus already prices upside)
and shown with an "R" exp badge for the human/agent to judge -- not weighted by the engine.

### Aggression is NOT neutral -- balanced wins (Step 5 sweep, 2026-09-02)

The earlier "aggression is roughly neutral (~27%, all within noise)" claim was measured against the
OLD uniform "everyone overpays for studs" bot on the wrong (16-slot) roster, and it does NOT hold.
Re-measured against the REALISTIC per-manager field on the real **12-slot roster**, with the
multi-season regular-season value curve and inflation ON, aggression matters a lot. Full-system
no-lookahead championship rate, `backtest --full --no-lookahead --inflation --seasons 2015-2024`
(n=150/cell; random = 6.3%):

| reserve \ max-share | 0.25 | 0.35 | 0.45 | 0.60 |
|---|---|---|---|---|
| **5** (old default) | 20.1 | 17.6 | 16.6 | **15.7** |
| **10** | 22.2 | 22.6 | 20.7 | 19.2 |
| **15** (new default) | 23.3 | **24.5** | 23.9 | 23.9 |
| **20** | 24.1 | 24.1 | 24.1 | 24.1 |
| **25** | 2.8 | 2.8 | 2.8 | 2.8 |

Championship rises with the per-starter RESERVE up to a plateau at reserve 12-20 (~24%), then
COLLAPSES at 25 (8 other starters x $25 = the whole $200 budget -> we bid $1 on everyone). **Default
= reserve 15 / max-share 0.35 / premium 2** (~24% at n=400) -- **SUPERSEDED 2026-09-05: shipped is
reserve 4 / max-share 0.25 under aggr 0.7; reserve proved nearly INERT once bids are shaded.** The
whole plateau 12-20 is statistically
tied (SE ~0.6 pts), and it beats the old aggressive-lean 5/0.6 (15.7%) by ~8.5 pts, far more than 2
SE. Cross-checks agree: without inflation the top cells drop to 20.3% (inflation stays ON, +~4 pts);
draft-only lookahead has 15/0.35 at ~25% vs 5/0.6 at 19.7%.

> **Reserve 15, not 20 -- a LIVE robustness call (Tier 2, 2026-09-02).** In the sim 20 edges 15 by a
> statistical tie, but a live ESPN mock showed reserve 20 STRANDS budget: at 20 the reserve binds
> (8 x $20 = $160 reserved), so after ONE buy the soft cap collapses to ~$20 and we get outbid on
> every remaining starter, ending with 1 player + $1 scraps. At 15 the max-share cap governs instead
> ($70), the soft cap stays healthy (~$58 after a buy), and we keep competing. Reserve 15 sits at the
> low end of the sim plateau AND survives a room that pays > $20/starter -- the robust choice.
The edge is still discipline + independent values vs an overpaying room -- but the room overpays for
STUDS that bust weekly, so a DEEP balanced roster, not a stars-and-scrubs one, banks it.

### VALUE edge, quantified (`--our-noise` vs `--market-noise`)

`ff backtest --our-noise F --market-noise 0.30` gives the market (bots) a projection with error sd
`market-noise` and US a projection with error sd `our-noise`. If ours is tighter (or just
INDEPENDENT), we spot mis-priced players and win value; everyone still scores by the real weekly
truth. Sweep (11 seasons, config fixed):
- our projection = the shared consensus everyone uses -> ~27% (no value edge, discipline only).
- our OWN projection, SAME accuracy (independent errors) -> ~39%. **+12 pts just for not sharing the
  room's blind spots.**
- tighter accuracy: 0.25 -> 41%, 0.20 -> 43%, 0.12 -> 44%, 0.05 -> 46%.
So VALUES are the top tunable lever. Full breakdown: docs/edges.md. Config is NOT neutral though
(see the Step 5 table above; **the specific values are SUPERSEDED -- see the 2026-09-05 sections at
the top of this file**): keep a BALANCED default (then reserve 15 / max-share 0.35) -- the deep
roster banks the room's stud-overpay -- and invest most in better VALUES + discipline vs the room.

## FULL-SYSTEM backtest (`--full --no-lookahead`) -- the whole pipeline end-to-end

`ff backtest --full --no-lookahead` runs the ACTUAL production modules together on real historical
seasons: values.ts (VOR->$) -> strategy.ts (draftField) -> projections.ts -> inseason/lineup.ts
(the real optimizer, availability-aware), scored by real weekly results + playoffs.
- `--full` = our team sets each week's lineup with the REAL `optimalLineup`, not a synthetic noise.
- `--no-lookahead` = our projection for season Y is season Y-1's actuals (a real, crude forecast
  with ZERO future knowledge); scored by Y's weekly truth.

Result (2015-2024) against the REALISTIC per-manager field (see below): **24.4% championships,
~3.9x random, 87% playoffs** on the WEIGHTED curve (n=400). The ~13% / 66% figures this line used
to quote were measured on the EVEN-SPLIT curve and are retired -- see the weighted-FLEX section at
the top. Draft-only was ~18% (2.9x) on the old curve; not yet re-measured under the new one. These REPLACED the
earlier ~36%/~27% numbers, which were measured against a uniform "everyone overpays for studs" bot;
that bot left random value everywhere and flattered us. The realistic heterogeneous field
(QB-payers, RB-first, QB/TE-punters, calibrated to real spending) is a genuinely harder, more honest
opponent -- trust these lower numbers, not the old ones.

## REALISTIC opponent field (src/draft/managers.ts) -- the bot model

The 15 bot seats are each a REAL manager from this league, modelled on 4 years of auction history
(`data/league-managers.md` + `data/managers.json`, both per-install and gitignored -- they name real
league members). Each bot reproduces its owner's positional appetite
(a QB-payer chases QB; a punter won't), a per-position spend budget (share x $200 -> stops chasing a
position once its allocation is spent), and a concentration-scaled stars-and-scrubs curve.

**Calibrate it: `ff calibrate --n 300`** runs an all-bot field and prints simulated vs real positional
share + concentration + biggest-buy per owner. Current fit: mean-abs-error QB 7% / RB 8% / TE 2% /
concentration 8% (WR ~18%, the soft spot). This is the fault-injection guard -- the RB-heavy manager
must come out RB-heavy, or the model is disconnected from the data.

**Nomination (`--drain-nom`, `--greedy-nom`) -- backtested, NOT a win.** Drain-nominating the known
position-payers LOWERS championships (18% -> 12%); greedy "nominate the best non-target" also trails
(15.5%) the value-greedy default. Rational bots don't tilt, so the sim can't reward nomination
gamesmanship (docs/edges.md) -- it's a human-only edge, kept as a documented live option, not defaulted.

**Live repricing (`--inflation`, `--scarcity`) -- inflation WINS, scarcity loses.** Repricing our
values by remaining$/remaining-book-value (`src/draft/inflation.ts`) adds **+~2 championship pts /
+3 playoff pts** (draft-only 17->19%, full no-lookahead 12->14%; stable at n=300). Unlike nomination,
this is a mechanical market correction the rational bots don't neutralize -> it's real. **ON by
default in the live bidder** (`--no-inflation` to disable). Live uses a start-normalized, bounded
[0.8,1.4] estimate (the draft board is virtualized, so exact remaining book value isn't cheaply
readable). SCARCITY/VONA premium tested NEGATIVE (-4.5 pts) -> OFF by default: the deep 16-team pool
keeps the next-available player close, so a live premium mostly overpays.

Confirmed in a live ESPN mock: inflation reads ~1.0 early and drifts down as the room spends down
(money leaves faster than talent here), so the agent gets more patient and snipes value late -- the
validated mechanism, live. (Live inflation is now computed EXACTLY from the scraped drafted set via
`espnAuction.readDraft`, not the old virtualized-board proxy.)

**Per-position inflation (`--pos-inflation`) -- backtested, REJECTED.** Fading the position the room is
overpaying adds ~nothing over global inflation and slightly hurts combined (draft-only 19.1->18.8%,
full-system no-lookahead 13.9->13.4%; ~neutral alone). Disciplined value-bidding + global inflation
already fades overpaid positions, so explicit fading double-counts. OFF by default; the per-position
empirical inflation is kept in the draft log as a human signal only (docs/edges.md).

**Waivers (`--waivers`) -- backtested and REJECTED as an auto-feature.** Adding automated waiver
churn (swap our weakest for the best-producing free agent, trailing-avg or ROS-blend, no lookahead)
DROPPED championships materially (measured ~-9 to -12 pts off the same-config baseline), and more
churn made it worse. In a deep 16-team league the free-agent pool is replacement-level, so churn
trades real drafted talent for hot-hand noise. -> the waiver feature is a conservative HUMAN-GATED
copilot (`src/inseason/waivers.ts`), not auto-execution. The backtest prevented shipping a
title-losing feature. (The DIRECTION -- churn hurts -- is what's trustworthy; the old absolute
"36% -> 24-27%" figures were against the retracted uniform bot and are not used.)

**Read it honestly:** these absolute %s were measured against a BOT MODEL, so trust the DIRECTION
and the multiple-of-random, not the decimal. Our own values are last-year actuals here -- they miss
rookies and undervalue players hurt last year -- so a real preseason projection
(ffanalytics/FantasyPros) would do better, and waivers/trades would ADD edge on top. (Any "36%"
elsewhere in older text was the pre-managers.ts uniform-bot number and has been retracted -- the
realistic-field figures were ~13% full-system no-lookahead / ~24% for the balanced draft config
on the EVEN-SPLIT value curve; on the weighted curve that ships today it is 24.4% full-system.)

## `ff sim` (season-points proxy)

## What it does

1. Loads a **projection** table (`data/points.csv`) and OUR **values** (`data/values.csv`).
2. Drafts 16 teams: **our team uses the REAL `makeV2Strategy`** (so the sim validates production
   code, not a copy); the 15 bots bid a market model anchored to true value but **overpaying for
   studs** (calibrated to seacaptaindate.com's tendencies -- docs/league-tendencies.md).
3. **Projection RISK:** each player's REALIZED points = projection x (1 + noise, sd 35%). A stud
   can bust. This is what makes concentration risky and balance valuable -- without it the sim has
   perfect foresight and trivially favors buying the priciest studs.
4. Scores every team by its best legal STARTING-lineup realized points, and reports our roster's
   points, average finish (of 16), and 1st / top-3 rate, averaged over N seeds.

Run: `npm run ff -- sim --n 300 [--values FILE] [--starter-reserve N --max-share F --premium N]`

## The regression-guard workflow

Change one thing (a value table, a strategy param), run `ff sim --n 300` before and after:
- **our starting pts up + avg finish down (toward 1) = better.**
- pts down / finish up = **regression** -- revert.
Use N>=300 so seed noise averages out; compare the same N.

## What it found (and how the guidance evolved)

The harness repeatedly corrected intuition -- which is the point:
- **From tendencies alone I guessed "go fully balanced." Wrong.** Over-balance (reserve 20,
  max-share 0.25) finishes WORST in every run.
- On the **2024-actuals** proxy, MODERATE won (reserve ~8, ~$95 on top 3).
- On the **forward-looking 2025 projections** (steep top, deep 16-team; measured under the OLD
  No-PPR assumption), **CONCENTRATION wins** -- more aggression -> better finish
  (reserve 2 / max-share 0.8 / $181-on-3 finished ~2.6
  vs ~3.5 for moderate). This MATCHES the league's real behavior (61% of picks are $1-5).
- **`ff sim` prefers concentration, but that is the season-points proxy over-rewarding top-heavy
  rosters (it has no playoffs) -- do NOT pick the config from it.** The real default is BALANCED
  (reserve 15 / max-share 0.35, premium 2 -- **SUPERSEDED, now 4 / 0.25 / 2**), chosen from the
  championship backtest (Step 5 table
  above), which the sim's own "Known limitation" section below predicts.

## Known limitation to weigh (why we don't just go max-aggression)

Scoring = sum of the starting lineup's realized points. This likely **over-rewards top-heavy
rosters**: it counts a $1 replacement WR2 as "some points" without fully penalizing that a lineup
of 3 studs + 6 waiver-level starters has a low weekly floor and loses head-to-head matchups the
season-sum metric can't see. So treat "max stars-and-scrubs wins" as an upper bound; the default
keeps real depth. A future harness upgrade: simulate weekly head-to-head wins, not season points.

## Honest limits (so we don't over-trust it)

- The **bot model and the 35% projection noise are assumptions**; the ABSOLUTE numbers (e.g. "50%
  firsts") are inflated because the bots are simple. Trust the RELATIVE comparison between configs,
  not the absolute win rate.
- Scoring truth = `data/points.csv`, now **2025 forward-looking projections** (FantasyPros redraft
  consensus ranks mapped onto a 2024 No-PPR points-by-rank curve -- `tools/build_projections.py`;
  that legacy Python path and its No-PPR curve are superseded by `ff refresh`, which scores under
  the synced half-PPR rules).
  Independent of ESPN. A true multi-source projection (ffanalytics / a projections API) would sharpen
  it further; the harness workflow is unchanged.
- The sim does not model nomination gamesmanship, keepers, or in-season waivers.

## Files
`src/draft/values.ts` (VOR->$), `src/draft/sim.ts` (simulator), `tools/build_projections.py`
(2025 FantasyPros ranks -> points), `tools/build_points.py` (2024 actuals variant), `data/points.csv`,
`data/values.csv`. Rebuild before the draft:
`uv run --with nflreadpy --with polars tools/build_projections.py` then `npm run ff -- values`,
then re-run `npm run ff -- sim --n 400 ...` to pick the config.

## The arbiter was pricing for the WRONG LEAGUE (2026-09-05) -- fixed

`backtest.ts` and `sim.ts` built OUR value book with the hardcoded `DEFAULT_VALUE_LEAGUE` literal,
while the live board (`ff.ts:767`) and the app payload (`assemble.ts:74`) built it with
`resolveValueLeague(config)`. The backtest also passed no `maxKDst`, so the value table's K/DST clamp
came from the literal `2` rather than from the lever.

For THIS league the two are identical -- 16 teams, $200, 12 slots -- which is exactly why it survived:
every backtest anyone had ever run produced the right answer by coincidence. For any other league the
arbiter would have been valuing players for a format nobody was playing, silently.

Both now pass the league already in scope (`lg`, which `ff.ts` builds from the SYNCED config) plus
`cfg.maxKDst`. Verified behaviour-preserving here: **32.9% / 94% with all 25 per-season numbers
bit-identical**, which is the required result given the two leagues coincide.

**That regression cannot prove the fix, only that nothing broke** -- under the old code the number
would be identical too. The assertions that actually lock it are in `test/values.test.ts`: they use a
deliberately different format (10-12 teams, $300, 14 slots) and assert the value book DIVERGES, that
`resolveValueLeague` consumes a `SimLeague` shape as-is, and that `computeValues` honours the
`maxKDst` it is handed. A "the backtest still prints 32.9%" check is structurally blind to this class
of bug; only a differing-league assertion sees it.

## Lever registry (2026-09-05) -- one entry per lever, everything else derived

`src/draft/levers.ts` now holds `LEVER_SPECS` as the single source of truth. `DEFAULT_LEVERS`,
`LEVER_META`, the backtest CLI flags (`leverOverridesFromArgv`), the strategy mapping
(`leversToV2Config`) and the app's Settings rows are all DERIVED from it, and a compile-time
`Record<keyof Levers, LeverSpec>` check fails the build if a lever is added without a spec.

This closes three drift bugs that were live at the time:
- `tierBreak` and `sleeperThreshold` had **no CLI flag at all**, so the arbiter could not measure them.
- the backtest's `maxKDst` flag reached the strategy but not the value table (above).
- the renderer's `LEVERS_UI` table listed **8 of 13** levers -- `benchDiscount` (the largest measured
  win, 24.4% -> 28.0%) and all four positional multipliers were invisible and uneditable in the app.

Also new: `--lever-off <key>` sets a lever to its declared no-op value, and an out-of-range CLI value
is clamped **loudly** rather than silently reporting a number for a config nobody ran. Note that not
every lever has a no-op setting -- `tierBreak`, `maxKDst`, `maxShare` and `sleeperThreshold` declare
none, because any "off" for them would fall outside their own legal range. `test/levers.test.ts`
locks all of it, including a regression lock on the shipped defaults.

## Shipped levers re-verified under the INDEPENDENT opponent book (2026-09-06, pre-draft)

Every shipped value had been tuned mostly against `--bot-book vor`, where the bots price with OUR OWN
`computeValues`. `scripts/sim-vs-mock.mjs` measures that market as the one FURTHEST from this
league's real positional spend -- distance **877**, vs **523** for the rank book and **376** for the
ESPN mock rooms (the sim over-spends QB ~$470 vs the room's real ~$328, and under-spends RB/WR by
$300-400). A value that only wins under `vor` is fitted to our own bias, not to the room.

Re-swept at `--bot-book rank`, full-system no-lookahead + inflation, 1999-2024, n=150:

| lever | cells (championship %) | verdict |
|---|---|---|
| `aggr` | 0.60 **34.6** / 0.65 34.2 / **0.70 34.2** / 0.80 32.3 | plateau 0.6-0.7; shipped 0.70 stands (it is also the minimax choice across books) |
| `maxShare` | 0.15 32.8 / 0.20 **34.7** / **0.25 34.2** / 0.35 32.6 / 0.45 31.7 | **bracketed BOTH sides for the first time**; 0.20-0.25 is a plateau |
| `benchDiscount` | 0.15 32.1 / **0.25 34.2** / 0.40 32.2 | bracketed both sides; 0.25 confirmed |
| `premium` | **1 -> 35.4** / **2 -> 34.2** | apparent +1.2pp -- REJECTED, see below |

Note the `maxShare` shape: under `rank` it is a PLATEAU at <=0.25, not a peak AT 0.25 as the earlier
`vor` sweep reported. 0.20 measures 0.5pp higher, inside noise. Nothing to change, but do not quote
"peaks at 0.25" as if the curve were single-peaked under every book.

### `premium 1` looked like a +1.2pp win and is an overfit -- rejected

It was the only candidate the sweep produced, and it beat `premium 2` under BOTH books (vor 35.1 vs
34.6; rank 35.4 vs 34.2), which is normally a good sign. The paired test says otherwise:

    McNemar chi2 2.95, p ~ 0.086      (not significant)
    season-level mean +1.28pp, SE 0.73, t 1.75 / 24 df
    bootstrap 95% CI [-0.13, +2.67]pp -- CROSSES ZERO
    detectable effect at 80% power with 25 seasons: ~2.12pp -- larger than the effect itself

And the per-season deltas split cleanly across the tuning/holdout boundary:

| era | seasons | mean delta (premium 1 - premium 2) |
|---|---|---|
| holdout 2000-2013 | 14 | **+0.36pp** |
| tuning era 2014-2024 | 11 | **+2.36pp** |

**The whole gain lives in the seasons `premium` was tuned on and vanishes on the holdout.** That is
the overfitting signature this file already has scar tissue for (a cell that measured +3.4pp became
+1.0pp held out). It was also the best of 8 cells, and selection alone inflates the winner. Not
shipped. If it is ever revisited, the test is a PRE-REGISTERED holdout run, not another sweep.

## `multQB` 0.7: found by watching LIVE drafts, confirmed in the sim, still a judgment call (2026-09-06)

The strongest candidate this harness has produced in a while, and the first one found by watching the
agent draft rather than by sweeping. Four COMPLETE ESPN practice auctions the night before the real
draft (the first complete ones ever recorded here -- earlier attempts all died early) showed the same
thing twice at the shipped config:

| mock | filled | clicks | QBs rostered | dead bench-QB $ | spent |
|---|---|---|---|---|---|
| 1 (shipped) | 12/12 | 148/148 | 3 | $13 | $117 |
| 2 (shipped) | 12/12 | 143/143 | **4** | $16 | $111 |
| 3 (`--pos-mult QB:0.70`) | 12/12 | 146/146 | 3 | **$4** | $83 |

Three and then FOUR quarterbacks on a ONE-QB roster, while the starting WR cost $5-12 and $83-89 sat
unspent. `benchDiscount 0.25` shrinks those bids but does not stop them: Maye at $12 is exactly
`74 x 0.7 x 0.8 x 0.25 + 2`.

**Cause: our value book overprices QB.** It prices QB ~$707 league-wide against this room's real
~$328. Whenever the room does not want a backup QB, our book says he is a bargain and we take him.

**Why no sweep ever caught it.** `multQB 0.7` measured EXACTLY 0.0 under `--bot-book vor` -- because
those bots price with OUR OWN `computeValues` and inherit the same QB bias, so QBs are expensive in
that sim and we never hoover them. `rank` prices QB independently (sim-vs-mock: QB $206 vs vor's
$470 vs this league's real $328) and is the only shipped opponent model that can see this at all.
A lever can be genuinely wrong and measure zero in a self-referential market.

Re-measured, 1999-2024, n=150:

| | multQB 1.0 (shipped) | multQB 0.7 |
|---|---|---|
| rank book | 34.2% | **36.1%** (0.60 -> 35.4, 0.85 -> 35.2: interior optimum) |
| vor book | 32.9% | **33.8%** |

Paired vs the shipped arm on identical seeds (rank): McNemar chi2 6.60, **p = 0.010**; season-level
mean **+1.97pp**, SE 0.74, t 2.67/24df; bootstrap 95% CI **[+0.56, +3.47]pp** (excludes zero); better
in **19/25 seasons**. And the holdout split runs the RIGHT way, unlike `premium 1`:

| era | seasons | mean delta |
|---|---|---|
| holdout 2000-2013 | 14 | **+2.36pp** |
| tuning era 2014-2024 | 11 | +1.27pp |

Minimax across both books favours 0.7 (worst case 33.8 vs the shipped 32.9), which is the same
criterion that chose `aggr` 0.7.

**NOT SHIPPED, deliberately.** It cleared every statistical bar, but the live mock only half-confirms
it: the QB leak closed ($16 -> $4) while total spend FELL to $83, so the money was not redirected
into better starters -- it just was not spent. n=1 per arm in a room whose price curve is not this
league's. Changing a validated lever hours before a real draft, on a benefit the live evidence does
not yet show, is exactly the impatience this file exists to prevent. Ship it after the season, with a
pre-registered holdout, or run it live as `--pos-mult QB:0.70` with eyes open.

### Robustness, same four mocks

**580 bid clicks, 0 failures.** The earlier "~14% of clicks fail" estimate does NOT reproduce: it was
an artifact of manual `ff bid` calls, each paying a fresh CDP attach (15-30s, racy). The persistent
auto-draft loop is 100% reliable. Click health is now counted and surfaced live (log + cockpit), so
this is measurable during the real draft rather than inferred afterwards.

## THE REAL DRAFT (2026-09-06) -- what a live auction taught that no mock did

Final: **12/12, $199 of $200, 53/53 clicks landed, 0 failures.** Roster came in at **1.01x book**
(spent $198 / book $196), so the bidding maths was sound end-to-end. Everything below is what the
live room exposed that four complete mocks the night before did not.

### The one expensive failure: eviction -> ESPN auto-bids on your behalf

Twice mid-draft ESPN raised a Disney-ID re-auth and the webview lost its page context. The recovery
built the night before caught both, named the cause, and walked back in unaided -- it works.

But the FIRST eviction hit at pick 1 while our own nomination (Amon-Ra St. Brown) was on the block,
and with us disconnected **ESPN auto-bid to $88 on a player our book valued at $59 and our cap
limited to $43**. Our bidder never made that bid and could not have. That single 40-second window:

  - cost ~$29 of surplus directly, and
  - committed 44% of budget to one player, which set us at $10/slot while the eventual best-value
    team (0.66x book) sat at $15/slot with the pick of the endgame.

Strip that pick and the roster is ~0.86x book. **The entire performance gap traces to one
disconnection, not to the strategy.** Ideas: pre-emptively re-auth before the room opens; detect the
auth iframe BEFORE it tears the context down; never nominate while a re-auth is pending.

### Bugs that only a real draft could surface

- **`enter-draft --app` is broken.** It calls `page.getByRole`, which the webview shim does not
  implement, so it throws before reaching its own direct-URL fallback. Every mock used
  `launch-practice`, so this path had never run. Worked around by navigating the webview directly --
  and note the draft URL needs the **`memberId`** query param or ESPN bounces you to the homepage.
- **`--rounds` defaults to 1600** (~37 min at a 1.4s tick). A real draft is longer: the bidder exited
  cleanly at 3/12 with `final:` and had to be restarted with `--rounds 20000`. Every mock finished
  inside 1600 so it never showed. Should be time-based, or default far higher.
- **The QB tail is unrankable.** Our VOR floor collapses ~10 startable QBs (Love, Mayfield, Darnold,
  Stroud, Young, Ward, Jones...) to book $1, so at a $1 cap the bidder cannot prefer one over
  another -- it takes whoever is nominated. We landed Goff (book $8) for $1, which was luck.
- **Duplicate player entries.** "Patrick Mahomes" (drafted $4) and "Patrick Mahomes II" (book $12)
  both exist, so the book can chase a player who is already gone.
- **D/ST/K have no real projection** -- `20 - rank*0.1` is a synthetic ordering, not an opinion.
  Fine given maxKDst $2, but do not read "#6 defense" as analysis.

### Levers at a $1 cap are INERT -- and that produced a wrong call

Late in the draft, with `soft-1`, the fill-floor pins EVERY cap to $1 regardless of position. A
`multRB 1.5` set to bias the last bench slot toward a running back therefore did nothing, and the
slot went to a $1 WR. The reasoning error was assuming the bidder CHOOSES between candidates: it
does not -- it evaluates one nominated player at a time, so a positional multiplier can only change
what we would PAY, never what we prefer. At a floored cap it changes nothing at all.

**If roster SHAPE matters at the end, it needs a shape rule (`maxAtPos`-style), not a price lever.**

### Mid-draft lever changes work, and they mattered

`aggr 0.7 -> 1.0` and `multRB 1.0 -> 1.5` were applied live and took effect on the next bid
(confirmed by the `LEVERS CHANGED mid-draft` log line). They bought Breece Hall at $41 -- at the
shipped settings our cap was $22 and he would have gone elsewhere, exactly as Jeremiyah Love did at
$44 twenty picks earlier. Same for `multTE 1.3` -> Loveland at $25. The live-lever work shipped the
night before is what made the recovery possible.

Caveat for the record: those values are IN-DRAFT JUDGEMENT CALLS, not backtested settings, and the
stored config has been reset to the validated posture. `aggr 1.0` in particular is the worst cell in
every sweep we have run.
