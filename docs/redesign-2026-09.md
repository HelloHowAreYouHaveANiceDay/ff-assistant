# The 2026-09 redesign, end to end

*Written 2026-09-09, at the end of Phase 3; completed the same day by the final integration pass,
which merged Phase 2d and Phase 3 onto `redesign/final`, closed the leftovers each phase had left in
the other's file fence, and arbitrated the new board. This is the record for the owner: what was
done, what it cost, what it bought, what is still open, and what the 2026 season will settle without
anyone's help. Every number here is quoted from `docs/validation.md`, where the run that produced it
is recorded.*

---

## The honest headline

> **Our championship rate is 38.1% against a field that drafts on our own projection plus one shared
> error of an asserted sd 0.30 and never touches its roster, over 25 seasons. It is 14.5% against a
> field that drafts the real published FantasyPros consensus with an independent per-bot view, prices
> with a book fitted on this room's own 1,102 picks, and works the waiver wire at this room's observed
> rate, over the five seasons that consensus exists for. Nothing about our strategy differs between
> those numbers.**
>
> **And the championship half of that number is not something the model can see.** Scored against 114
> real team-seasons of this league, the season simulator beats a uniform baseline on the PLAYOFF berth
> (Brier 0.2370 against 0.2451) and loses to it on the CHAMPION (0.0659 against 0.0652). A draft
> strategy can put you in the bracket. What happens in the bracket is not an edge anybody here has
> found.

*Updated by integration pass 3 (2026-09-09).* Under the league's **actual** 13-week calendar the
first figure is **39.7%**, not separable from 38.1% (paired -1.60pp, CI [-4.59, +1.20]); the second
re-measured at **11.2% over four seasons**, which is within the ~4-point level drift Track A recorded
on that arm after the board was rebuilt. The calibration figures re-run per season are 0.2369 against
0.2451 on the berth and 0.0658 against 0.0652 on the champion -- i.e. **the finding is unchanged**,
which is the useful thing about having re-measured it. See PROGRAMME 2 below.

What that means in practice, in three sentences. The strategy is good and the size of "good" was
overstated by an opponent model nobody had checked. The right thing to optimise is the seed, not the
trophy, and every in-season tool now does. The right thing to distrust is any single percentage,
including the ones on this page.

**The two numbers, named in full, because neither means anything without its arm.** They are not two
estimates of one quantity; they are answers to two different questions.

| | the flagless TRIPWIRE | the HONEST arbiter |
|---|---|---|
| what it is for | detecting that an input drifted | budgeting what a plan should expect |
| command | `backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150` | `backtest --market ecr --market-noise 0 --bot-noise 0.20 --bot-churn --bot-book price --full --no-lookahead --inflation --seasons 2020-2024 --n 300` |
| market model | our own projection plus one shared error of an asserted sd 0.30 | the real published FantasyPros consensus, shared error 0, per-bot view log-sd 0.20 |
| churn | none -- the field never touches its roster | `--bot-churn`, at this room's observed waiver rate |
| opponent book | `vor` -- our own valuation function | `price` -- fitted on this room's own 1,102 real picks |
| seasons | 25 (2000-2024) | at most 2020-2024; the ECR archive begins in 2020, so this arm can never reach earlier, and `--no-lookahead` drops the first season of whatever window is loaded (no prior year inside it). P32/P33 therefore ran on **four** seasons, 2021-2024 |
| projection | **actuals** -- it never opens the artifact | **actuals** by default; P32/P33 add `--projection artifact` to put a BOARD under test |
| result | **38.1% championships / 96% playoffs** | **14.5% / 49.0%** (V2, price book) |

The tripwire reproducing to the season is the ONLY thing it is for. It says nothing about the board,
because it does not read the board -- which is why P32 and P33 had to be run separately.

---

## The phases

Each row is a branch. They chain: every branch is cut from the one above it, so the merge order is
the table order.

| phase | branch | commits | what it changed | headline |
|---|---|---|---|---|
| 1 | `redesign/phase-1-conditional-curve-trajectories` | 4 (`30cbe70`..`ace1aad`) | the projection conditions on PRESEASON rank, not finish rank; the season sim resamples player-SEASON trajectories instead of iid weeks; the board's age comes from the identity registry | flagless arbiter **38.2%**, and the recorded 34.9% was found to be a stale record rather than a drift |
| 2a | `redesign/phase-2a-feature-table-projector` | 5 (`511b3a5`..`a62d7d6`) | one point-in-time feature table, one projector the board AND the backtest call, a train-in-Python/serve-a-validated-artifact contract, `fact_draft_pick` | nothing moves on purpose: **38.2%**, per-season identical, 523 board values reproduce exactly |
| 2b | `redesign/phase-2b-price-model-ecr-arbiter` | 7 (`0141daa`..`764ac43`) | curve hyperparameters selected inside the fold; two-level copula; the price model fitted on the room's real picks; `--market ecr`; bot churn | the arbiter had been scoring us against an opponent weaker than the real one, by **26 points** |
| data | `redesign/data-track-sources` | 9 (`d1c239a`..`079d891`) | raw assets: league history, NFL schedules with the Vegas line, injuries, depth charts, snaps, participation, ADP archive, contracts | the raw layer is re-fetchable; nothing is hand-scraped |
| weekly | `redesign/weekly-track` | 7 (`606a91f`..`a9021bf`) | point-in-time weekly features with a leakage guard that fires, a trained weekly artifact, nested-by-season evaluation with lineup regret, the write-once scorecard | W1 HELD, W2 FAILED (3.39 points of lineup regret against a 2-point threshold), W3 HELD |
| copilot | `redesign/copilot-track` | 4 (`30fe9e1`..`74578f7`) | the nine in-season decisions as pure functions over one sim context; `ff copilot` and the MCP tools over the same functions | the Assistant could reach none of these answers before; 34 tools now |
| int | `redesign/integration` / `redesign/integration-2` | 2 + 21 (incl. the two track merges) | the three tracks merged; three claims that stopped being true when they met | one number moved, and it is named |
| 2c | `redesign/phase-2c-real-outcomes` | 9 (`8c2b5a1`..`825e915`) | ONE key space (staging reads the registry); the league's own history as facts; the price model refitted; the season simulator scored against eight seasons of real outcomes; the honest arbiter | **P16 FAILED** -- the title Brier is worse than uniform. The flagless arbiter becomes **38.1%** because the bot field was rebuilt from nine real drafts |
| 2d | `redesign/phase-2d-weekly-features` | 5 (`6fc36d5`..`50dba8d`) | a two-part weekly model (will he play, then how much); per-position usage features admitted by the gate; the DAG node list derived | the gate refused a model that beats every baseline on accuracy, on a calibration clause it missed by five thousandths |
| **3** | `redesign/phase-3-decision-layer` | 5 (`b126af4`..`668681f`) | roster-aware value; the derived bidder V3; the in-season objective re-based on P(playoffs); the odds accrual scorer | **P28 FAILED** -- V3 loses by 35 points of playoff rate in 12 of 12 seasons. V2 stays. The objective changed anyway |
| **fin** | `redesign/final` | 8 (`89b798f`..HEAD) | the 2d/3 merge; the four fenced leftovers closed; the new board arbitrated | **P32 and P33 both HELD** -- and the arm cannot detect anything under ~10pp, so "held" here mostly means "not adjudicated" |

**The chain, in order. It is now merged as far as `redesign/final`:**

```
main
  <- redesign/phase-1-conditional-curve-trajectories     4 (30cbe70..ace1aad)
  <- redesign/phase-2a-feature-table-projector           5 (511b3a5..a62d7d6)
  <- redesign/phase-2b-price-model-ecr-arbiter           7 (0141daa..764ac43)
       + redesign/data-track-sources                     9 (d1c239a..079d891)
  <- redesign/integration                                (data track merged here)
  <- redesign/integration-2                              (weekly + copilot tracks merged here)
       + redesign/weekly-track                           7 (606a91f..a9021bf)
       + redesign/copilot-track                          4 (30fe9e1..74578f7)
  <- redesign/phase-2c-real-outcomes                     9 (8c2b5a1..825e915)
  <- redesign/phase-2d-weekly-features                   5 (6fc36d5..50dba8d)   siblings, both
     redesign/phase-3-decision-layer                     5 (b126af4..668681f)   cut from 825e915
  <- redesign/final                                      8 (89b798f..HEAD)
```

`main..redesign/final` carries the whole programme -- 78 commits as this was written; run
`git rev-list --count main..redesign/final` for the current figure. What remains for the owner is one
merge of that branch,
not nine.

The two siblings were built in parallel behind a file fence: 2d owned `src/weekly/**` (except
`scorecard.ts`'s odds branch), `src/model/**`, `src/features/**`, `tools/train_*.py` and
`app/renderer/app.js`; Phase 3 owned `src/draft/**`, `src/inseason/**`, `src/agent/**` and the docs.
The fence held: **`docs/validation.md` was the only conflict**, because both prepended a section, and
it resolved by keeping both -- Phase 3 above Phase 2d, both above Phase 2c. `README.md` auto-merged.

The merge commits carry one thing the phases did not: `scripts/merge-sanity.mjs`. Two append-only
branches off one base can merge without a conflict and still be silently broken -- a duplicate MCP
tool name, a second `CREATE TABLE` for one table, a shadowed CLI case, two renderer list entries
sharing an id. In each the later one wins and the earlier is unreachable, and no typecheck and no
test notices. It checks WITHIN a scope, never across a file (`ff.ts` has two switches and `app.js`
three id lists, and four label pairs legitimately repeat across them at the merge base), and
`--self-test` injects one duplicate of each of the four kinds and asserts all four fire. On the
merge: 34 MCP tools, 63 schema tables, no duplicate in any scope.

---

## Every recorded prediction, with its outcome

P1-P20, P25-P33 and W1-W6 -- 35 in all; P21-P24 were never issued. **Twenty held and fifteen
failed.** That ratio is the point of registering them: a programme where the predictions all hold is
a programme whose predictions were written after the measurement.

| | prediction | outcome |
|---|---|---|
| P1 | championships rise under both opponent books with the conditional curve | HELD in direction, not significance (+1.00pp) |
| P2 | the `aggr` optimum moves to >= 0.8 under the conditional curve | **FAILED** |
| P3 | the `multQB 0.7` edge shrinks toward zero | HELD, and it reversed sign |
| P4 | the projector arm is within noise of Phase 1's conditional arm | HELD |
| P5 | the trained artifact beats curve-only on the nested evaluation | HELD -- it ships |
| P6 | the `aggr` optimum is in [0.6, 0.8] under the ECR market | HELD -- 0.7 |
| P7 | `maxShare` is a plateau, not a peak | HELD |
| P8 | `multQB` 0.7 does not beat 1.0 | HELD |
| P9 | our rate falls by 0.5 to 4 points when the field works the wire | **FAILED, by a factor of three** |
| P10 | draft-pick and participation resolution each rise 15+ points after the re-key | **FAILED** -- a coverage ceiling, not a keying one |
| P11 | price LOSO MAE on 2018-2025 at or below $4.32 | **FAILED** -- $6.38 |
| P12 | 2026 holdout MAE <= $5.00, top-12 bias within +/-$3 | **FAILED** -- $7.07, +$4.3 |
| P13 | price beats rank on 2026 by >= $2 of MAE | **FAILED** -- it loses by $1.48 |
| P14 | per-owner profiles still carry no out-of-sample signal | HELD |
| P15 | the simulator's playoff Brier beats uniform | HELD |
| P16 | its title Brier beats uniform | **FAILED** -- 1.0% worse than uniform |
| P17 | the simulator is over-confident at the top | HELD |
| P18 | honest-arbiter title rate in [12%, 26%] | HELD -- 14.5% |
| P19 | `aggr` 0.7 beats 1.0 there by >= 4 points | **FAILED** -- +1.0pp, CI [-3.7, +5.9] |
| P20 | book ordering by our title rate is vor > rank > price | **FAILED** -- it is rank > price > vor |
| P25 | at least one screen survivor improves pooled CRPS with coverage in band | HELD -- two do |
| P26 | for QB, carries per game beats rushing yards per game | **FAILED** |
| P27 | ADP relative to ECR does NOT survive -- the same consensus twice | HELD |
| P28 | V3's playoff rate is at least V2's minus 2 points under BOTH arms | **FAILED** -- +1.3pp on one arm, **-35.5pp** on the other |
| P29 | V3's title rate is within noise of V2's | HELD on the honest arbiter, not on the long arm |
| P30 | V3's QB share of spend is at least 3 points LOWER than V2's | **FAILED** -- it is 3 to 14 points HIGHER |
| P31 | at least three V2 levers are flat within noise under the honest arbiter | HELD -- `starterReserve`, `premium`, `maxShare` |
| W1 | the weekly model beats the season line in every position | HELD |
| W2 | its lineup regret is under 2 points | **FAILED** -- 3.39 |
| W3 | trailing-4 is worse than the season line | HELD |
| W4 | the two-part model's lineup gain is at least 5 points per lineup | HELD -- 6.08 |
| W5 | its predicted zero-week share matches actual within 3 points | **FAILED** -- 0.035 pooled |
| W6 | `implied_team_total` outweighs `dvp_mult` at every position | **FAILED** -- the reverse |
| P32 | the 2d board's playoff rate is within noise of, or better than, the 2c board's under BOTH books | HELD -- price -2.50pp CI [-9.33, +2.17]; rank +1.67pp CI [-4.08, +8.08] |
| P33 | its title rate is within noise | HELD -- price -2.75pp CI [-5.25, +0.17]; rank -0.00pp CI [-1.75, +2.08] |

The five most consequential failures, and what each one actually says:

- **P16** -- the championship is not predictable from a post-draft roster. This is the finding the
  whole of Phase 3 is built on.
- **P9 / P20** -- our measured edge was mostly a statement about the opponent we chose. A mirror is
  not automatically the easy opponent; against the field that prices exactly as we do, we do worst.
- **P19** -- `aggr 0.7`, recorded as the single biggest lever at ~+10pp on 25 seasons, measures
  +/-1pp on five. The difference is the season window, not the arbiter, and the honest arbiter can
  never have more seasons: the FantasyPros archive begins in 2020.
- **P28** -- a bidder derived from first principles, with every hand-tuned lever removed, loses to
  the hand-tuned one in twelve seasons out of twelve.
- **P30** -- and it loses for a specific, findable reason: the analytic marginal it can afford to run
  per bid prices a quarterback against the waiver wire, where VOR prices him against the seventeenth
  quarterback, which is what a one-QB league pays for.

---

## What Phase 2d changed

**A gate refused a model that is better on every accuracy metric, and the model did not ship.** The
two-part weekly model (will he play, then how much) beats the shipped path on RMSE 5.268 to 5.927, on
CRPS 2.150 to 2.664, and on the deep-18 lineup by 6.08 points a week. It failed clause (c) of the
pre-registered gate -- predicted zero-week share 0.384 against an actual 0.419, off by 0.035 against
a tolerance of 0.030, and outside per position at RB, WR and TE. The tolerance was not widened to
0.04, because a tolerance chosen after seeing 0.035 is not a tolerance. **The season-line-only floor
still ships**, and the miss is a bounded next job: the first stage is a plain logistic and its
intercept is the only thing between 0.384 and 0.419.

The clause was worth writing because the two candidates failed it for opposite reasons. The
quantile-head model missed by 0.287 because it *cannot say the number*: its p10 sits on the zero atom
and a model whose lowest published level is 0.10 claims P(zero) = 0.10 and no more.

**Availability is worth about 1.5 points per lineup per week**, the largest single effect the weekly
track has measured. Adding the availability columns alone, on the same folds against the same
baseline, moves the deep-18 lineup from +4.55 to +6.08 over the shipped path -- which settles what
W2 left open in Phase 2c, when the table had no availability column to test the availability claim
with.

**Two features were admitted to the season model and the board moved.** `depth_rank_sep1` (rho
-0.186, the strongest candidate the screen has ever produced) and `contract_year` took the projection
from RMSE 54.17 to 52.79 and pinball 12.31 to 12.02. Almost all of it is at quarterback -- R-squared
0.600 against curve-only's 0.479 -- which is where a September depth chart says the most: a starter
is a starter, a backup scores nothing, and a curve indexed on last year's finish cannot see a job
change. The value book's dollar share moved WR 37.9% -> 41.0% and RB 32.5% -> 29.3%. **That
reallocation is what the final pass arbitrates**, below.

**Two defects in the screen, the same shape both times:** a candidate that never reached a test,
reported identically to one that was tested and measured nothing. A distinct-value floor of 8
excluded every binary candidate the sweep has ever derived; a TEXT-versus-INTEGER `player_sk`
mismatch made the ADP-versus-ECR derivation match zero rows. The sweep now prints a NOT SCREENED
block naming every candidate that reached no test and why -- and three still do, including the
owner's rookie-draft-capital question, which has 0 rows by construction because a rookie has no
prior-season finish rank. That is the answer, not a null.

---

## What the final integration pass changed

Four things, each a leftover one phase could see and the other owned.

**One shipped weekly artifact.** `lineupRecommend` loaded the floor and `ff scorecard`'s `weekly`
kind loaded the two-part challenger, each filename typed inline in its own file. Both load through
the same loader, both validate, both produce plausible numbers -- so the season's forward record was
accruing for a model nobody was ever served from, which is the one failure a scorecard cannot
survive. The `weekly` kind now serves the shipped artifact by the same constant the lineup reads. The
challenger is not discarded: it gets its own kind, `weekly_challenger`, on the same players, the same
week and the same frozen as-of, so the live season accrues out-of-sample evidence for it -- the only
evidence left, the historical folds having all been used. **The dual series starts at week 2**: week
1 was snapshotted on 2026-09-08 under the old arrangement and predictions are written once, so
back-filling it now would be exactly the after-the-fact prediction the file exists to refuse. A guard
requires the two kinds to DISAGREE, because asserting each equals its own artifact would also pass an
implementation that read one file for both; it found a third inline filename in
`src/weekly/evaluate.ts`.

**The live season is no longer blind.** `feat_player_week_context` held zero rows for 2026 -- the
historical builder reads `raw_injury`, which stopped publishing report dates in 2025 and holds
nothing for an unarchived season -- so the two-part model's first stage, whose largest coefficients
are `inj_out` (+3.4 to +5.2 in logit) and `inj_doubtful`, would have served September on its declared
defaults, which say everyone is healthy. `ff build-live-context` fills them from the two feeds the
copilot's OUT refusal already reads, so a man the lineup refuses to start and a man the model prices
as unlikely to play cannot be different men. It obeys a different rule from the historical builder
and is therefore a different verb: a live feed publishes one current state and one timestamp, so the
whole snapshot is placed by the point-in-time rule -- **after a week's first kickoff, the snapshot
belongs to the NEXT week** -- and only that week is written. On the live store: 462 rows for week 2,
19 Out, 56 Questionable, 66 players with a positional team-mate out, `inj_feed` = 1 everywhere so the
model knows the feed spoke. Week 3 is correctly still blind.

The effect is visible in the first dual snapshot: the three largest shipped-versus-challenger
divergences in 2026 week 2 are men the challenger prices near zero (9.18 vs 0.61, 8.12 vs 0.26, 7.84
vs 0.03) because it can see they are out, where the floor prices them at their season line.

Adding those rows made a PASSING leakage guard fail, and the guard was right: it asserts that every
Friday injury status is backed by a dated filing, and a status feed files nothing. The fix was not to
weaken it -- a threshold would also absorb a real leak -- but to make the row say which builder wrote
it (`source` is 'archive' or 'live') and check each guarantee against its own rows. The live rows are
not exempted; they are held to the point-in-time rule instead, and both guards were fault-injected
against the real store to prove each can still produce its failing value.

**The registry knows about the weekly pair, and about the current board.** `src/draft/models.ts`
described the projection artifact by its pre-2d numbers and knew nothing of the weekly track. Both
weekly artifacts are now registered with their measured numbers and the clause each failed or passed,
the shipped one required and the challenger not -- and the checks are keyed on the thing rather than
the name, so the required slot refuses a two-part artifact and the challenger slot refuses a quantile
one. `validateModels()` now refuses a weekly artifact of the old schema, which would otherwise score
every unknown head as zero and produce a slightly different projection with no error anywhere.

**The Data page shows the data.** Seven tables were being served by no key at all -- the table the
weekly model is fitted on, the two the board is fitted on, and the entire forward record. Registering
them was the whole of the fix, because Phase 2d had already made the renderer's node list derived
rather than enumerated.

---

## Was the new board any better? P32 and P33

The flagless arbiter projects from actuals and never opens `data/projection-artifact.json`, so a
3-point dollar-share reallocation from RB to WR had reached the shipping default without any arbiter
having an opinion about it. That is exactly the kind of change this repo's one rule exists to
adjudicate, so it was adjudicated.

Both boards run through the honest arbiter with the MARKET UNCHANGED and only OUR book swapped:
`--projection artifact --artifact <board> --market ecr --market-noise 0 --bot-noise 0.20 --bot-churn
--full --no-lookahead --inflation --seasons 2020-2024 --n 300`, paired on common random numbers,
under both opponent books. The connectedness control is in the run's own banner: the 2c arm prints
`9 fitted features` and the 2d arm `11`.

| book | board | playoffs | title | paired playoff difference (2d - 2c) | paired title difference |
|---|---|---|---|---|---|
| `price` | 2c | **79.8%** | **21.1%** | -2.50pp, CI [-9.33, +2.17], 2/4 seasons | -2.75pp, CI [-5.25, +0.17], 1/4 |
| `price` | 2d | 77.3% | 18.3% | | |
| `rank` | 2c | 70.5% | 13.0% | +1.67pp, CI [-4.08, +8.08], 2/4 seasons | -0.00pp, CI [-1.75, +2.08], 1/4 |
| `rank` | 2d | **72.2%** | 13.0% | | |

**P32 HELD and P33 HELD**, and the honest reading is that this arm could not have failed them for
anything short of a large effect: with four usable seasons the detectable difference at 80% power is
**10.2 points of playoff rate** and 4.4 of title rate. Both intervals contain zero on both books, and
the two books disagree about the sign on playoffs.

Three things have to be said with that, because "held" is doing very little work here:

- **The point estimate goes the wrong way on the price book** -- 2d is 2.5 points of playoff rate and
  2.8 of title rate behind 2c, worst in 2024 (-13pp of playoffs). The trial-level McNemar on playoffs
  is nominally significant there (p = 0.032), but the unit of generalisation in this repo is the
  SEASON, not the trial, and the season-level interval contains zero comfortably. Reading the trial
  test as the answer is the specific mistake `scripts/paired-analysis.mjs` exists to prevent.
- **The window is four seasons.** `--no-lookahead` drops the first season of the loaded window,
  because there is no prior year inside it, so `--seasons 2020-2024` scores 2021-2024. The
  FantasyPros archive begins in 2020 and cannot reach earlier, so this arm can never have more.
- **Both arms carry the same lookahead.** Each board is a single full-data artifact fitted on
  1999-2025, so both have seen the seasons being replayed. That makes the LEVELS optimistic in both
  arms and the COMPARISON fair, since the contamination is identical; it is not an unbiased estimate
  of either board's real rate. The unbiased version needs per-fold artifacts for both boards
  (`ff evaluate-projection --keep-artifacts <dir>` twice, then `backtest --artifact-dir`), which is a
  measurement nobody has run.

**So the reallocation is not vindicated and it is not condemned.** The features were admitted on a
projection-accuracy gate they passed cleanly -- RMSE 54.17 to 52.79, almost all of it at quarterback
-- and the championship arbiter, on the only opponent model honest enough to use and the only seasons
it can reach, cannot tell the two boards apart. Nothing was reverted, because that is an owner
decision and reverting on an underpowered null would be the same error as shipping on one.

---

## What Phase 3 changed, and what it deliberately did not

**Changed.** The in-season decision surface ranks on P(playoffs), reports playoff-week strength as the
secondary and the title alongside; the noise floor is computed for the primary; a state-dependent
switch moves the primary to playoff-week strength above a 70% playoff probability; every result
carries an `objective` block and every summary's caveat names the quantity; the frozen preseason odds
can now be scored when a season resolves.

**Not changed, on purpose.** `DEFAULT_LEVERS` is byte-identical. The default bidder is still V2. The
default arbiter is still the flagless one, and it still returns 38.1% / 96% with the same per-season
line. `docs/decisions.md` is untouched. No ESPN write path was added.

---

## Open decisions, for the owner

1. **`DEFAULT_LEVERS`.** P31 measured `starterReserve` inert at the shipped `aggr` and recorded it as
   producing byte-identical trials. **Corrected by Track A (P35):** on the long arm 16 of 1,800
   trials differ, so it is FLAT WITHIN NOISE, not byte-identical -- -0.17pp, CI [-0.44, 0.00].
   `premium` and `maxShare` flat within noise on five seasons.
   Retiring the first as a tunable lever costs nothing and removes a knob that reads as live. The
   other two were measured on 25 seasons where they did move; five seasons is not enough to overturn
   that. **Recommendation: retire `starterReserve` as a UI/CLI dial, keep the rest.**
2. **The default arbiter.** The flagless run is the regression tripwire and reproduces to the season,
   which is its job. The honest arbiter is the rate a plan should budget against. Changing the
   default would silently re-baseline every number already recorded AND drop the season window from
   25 to 5, which P19 shows is not enough to measure a lever with. **Recommendation: keep the
   default, quote the honest arbiter in plans.**
3. **V2 vs V3 as the live bidder.** The arbiter answered this one: V2. The open question is whether
   anybody picks V3 up again, and if so the place to start is named -- the gap between the simulated
   roster-aware book (which behaves as the theory predicts) and the analytic surrogate the bidder can
   afford (which does not). **Recommendation: leave V3 selectable and unshipped.**
4. **The merge to main.** The chain is already merged as far as `redesign/final`, which is one branch
   of 74 commits off `main` with the flagless tripwire reproducing to the season, 456 tests green and
   a clean typecheck. **Recommendation: merge `redesign/final` into `main` as a single `--no-ff`
   merge, then re-run the flagless arbiter on `main` -- it must still read 38.1% / 96% with the
   per-season line in this document.** Nothing here pushes or merges to `main`; that is the owner's
   commit to make.
5. **Ship the two-part weekly challenger, or keep the floor.** It is better on RMSE (5.268 vs 5.928),
   on CRPS (2.150 vs 2.671) and on the lineup by 6.08 points a week, and it failed one calibration
   clause by 0.005. Shipping it means overruling a gate that ran exactly as written, which is how
   gates stop meaning anything. **Recommendation: keep the floor and let the season decide.** From
   week 2 the scorecard freezes both models' predictions on the same players every week, so by
   December there is out-of-sample evidence nobody could have tuned -- and the cheaper move is
   available meanwhile: recalibrate the first stage's intercept and re-run the gate, which is the one
   thing between 0.384 and 0.419.
6. **The DAG renderer change** (Phase 2d, `c4a9ccf`: the node list is derived rather than enumerated,
   plus the seven tables the final pass registered). `test/dag-derivation.test.ts` runs the real bytes
   of `app/renderer/app.js` and asserts nothing the engine serves goes unplaced, and `ff serve`
   returns all seven new keys with live row counts -- but no session here has run the Electron app.
   **Recommendation: open the Data page once after the merge; it is the one change that only a
   running UI can confirm.**
7. **The price-model default.** The shipped artifact is fitted on 2020-2025 and beats `rank` on the
   2026 holdout by $0.89 of MAE, not the $2 that was predicted -- and `rank` is BETTER at the top of
   the market. The price book is the default opponent for the honest arbiter, and P32 is a live
   demonstration of why that matters: the two books disagree about the SIGN of the 2d board's effect
   on playoff rate. **Recommendation: keep it as the honest arbiter's default, quote both books for
   any board or value conclusion, and treat any elite-tier conclusion that rests on it as the least
   trustworthy kind.**
8. **The 2d board (`depth_rank_sep1` + `contract_year`), and the RB-to-WR reallocation it caused.**
   Admitted on a projection-accuracy gate they passed cleanly; the championship arbiter cannot tell
   the two boards apart on four seasons (P32/P33 above), and its point estimate is mildly negative
   under one book and mildly positive under the other. **Recommendation: keep them -- they were
   admitted on the measurement they were screened for, and reverting on an underpowered null is the
   same error as shipping on one -- and run the unbiased version before leaning on the board for a
   value decision: per-fold artifacts for both boards, then `backtest --artifact-dir`.**

---

## PROGRAMME 2: five parallel tracks, and the league changing its calendar underneath them

*Added 2026-09-09 by integration pass 3. Programme 1 ended with `redesign/final` at `75da5b0`. Five
tracks then ran in parallel off it and were stacked onto `redesign/final-2`.*

### The five tracks

| track | branch | commit | what it is | verdict |
|---|---|---|---|---|
| A | `redesign/v3-qb-replacement` | `b36c690` | V3's analytic marginal against POSITIONAL baselines (the "one piece of work worth doing next", below), plus private-component shading | The named defect is fixed and **was not the reason**: V3 still loses the long arm by 29pp. It stays selectable, not default. |
| B | `redesign/inseason-backtest` | `08443a5` | This league's own week-by-week rosters and transaction log, and the lineup / waiver / handcuff decisions scored against them | Our lineup rule scores **LESS** than the room (-1.39 pts/wk under the challenger, -4.45 under the floor). Our waiver ranking beats it (22.4 vs 18.7 pts per FAAB dollar). |
| C | `redesign/streaming-all-positions` | `9a90640` | A streaming model per position, and a decision metric in the units of the decision | Ships at **QB, K, DST**. The opponent block measures ~0 at RB/WR/TE. |
| D | `redesign/dual-eligibility` | `235980d` | Position as a SET, from ESPN's `eligibleSlots` through valuation, lineup and roster legality | Provably a no-op today -- zero 2026 players are dual-eligible at QB/RB/WR/TE -- and correct for the next Taysom Hill. |
| E | `redesign/league-format` | `74d72b1` | The calendar as a fact with a source | Correct, and **immediately superseded by the league itself**. See below. |

### The format finding, which is the story of this pass

Track E read ESPN on the morning of 2026-09-09 and recorded **14 regular weeks, playoffs 15/16/17,
`playoffReseed` false**, and concluded that the owner's "13 weeks" recollection described the
2018-2020 league. That was a correct reading. Hours later, a live re-read returned **13 weeks,
playoffs 14/15/16, `playoffReseed` TRUE** -- the commissioner had shortened the season on 2026-09-08,
after week 1 had been played and after the preseason odds had been frozen. Track E's cached
`settings-2026.json` is stale, and so is anything derived from it.

The league's own format history, now read per season from ESPN and stored on `raw_league_season`:

| era | teams | reg weeks | playoffs | field | reseed | divisions |
|---|---|---|---|---|---|---|
| 2018-2020 | 14 | 13 | 14/15/16 | 6 | no | 1 |
| 2021-2024 | 14 | 14 | 15/16/17 | 6 | no | 1 |
| 2025 | 16 | 14 | 15/16/17 | 7 | no | 4 |
| 2026 | 16 | 13 | 14/15/16 | 7 | **yes** | 4 |

Two consequences nobody planned for. Re-ingesting the 2026 schedule **accumulated** rather than
replaced it -- 104 games read back as 166, a team playing twice in week 1, no error anywhere -- and
the preseason odds now describe a bracket the league will not play. The first is fixed; the second is
answered with a second VINTAGE of the snapshot rather than a rewrite, because a write-once record
that can be corrected is not one.

And **`playoffReseed` had never been read at all**. Both simulators reseeded unconditionally for the
life of the repo: right for 2026, wrong for all eight prior seasons.

### The schedule the orchestrator checked

Re-verified here from the re-ingested schedule (`scripts/schedule-balance.mjs`), because a claim about
a schedule is exactly the kind that outlives the schedule -- and this one changed twice in a day.

The 2026 schedule is **structurally balanced**: 104 games over 13 weeks of 8, every team playing
exactly 13, and **no opponent met more than twice**. The division games are the two blocks at the
ends: **weeks 1-3 and weeks 11-13 are 8-of-8 in-division**, weeks 4-10 are 8-of-8 cross-division.
So the run-in is entirely against the three teams we have already played once, and a division rival's
late-season form matters more than raw SOS suggests.

Our division (`Class of 2012`) is the **weakest of the four by projection**: mean rostered projected
points 1568.1, against 1601.2 / 1755.5 / 1772.9. Under division-winners-first that is worth
something real, and it is the one place the seeding assumption above actually bites.

### Every prediction in programme 2

| id | claim | outcome |
|---|---|---|
| P34 | V3's QB share falls toward the room's once the baseline is positional | **HELD** |
| P35 | the redundant-lever finding holds for V2: `starterReserve` inert | **FAILED in its strong form** -- 4 vs 0 is NOT byte-identical on the long arm (16 of 1,800 trials differ). Weak form holds: -0.17pp, CI [-0.44, 0.00] |
| P36 | managers leave >= 8 pts/wk on the bench vs hindsight | **HELD** -- 12.48 |
| P37 | our lineup beats the median manager's realised lineup in >= 60% of team-weeks | **FAILED** -- 46.8% (challenger), 42.1% (floor) |
| P38-P39 | waiver and promotion claims (Track B) | recorded in `docs/in-season-backtest.md` |
| P40 | QB/K/DST streaming picks beat the board's by >= 1.0 pt/wk | **HELD** on both pools -- +8.29 / +1.37 / +1.32 on the REAL pool |
| P41 | the opponent block adds < 0.5 pt/wk at RB/WR/TE | **HELD**, and negative: -0.15 / -0.46 / -0.17 |
| P42 | DST CRPS improves >= 5% with the opponent block | **FAILED** -- 0.1% |
| P43-P44 | dual eligibility is a no-op for a single-eligible player (Track D) | **HELD**, with positive controls |
| P45 | division-winners-first does not worsen the 2025 playoff Brier by > 0.005 | **HELD** -- it improved it by 0.000612 |
| P46 | 13 weeks changes the tripwire by < 2 points | **HELD** -- +1.5pp, CI contains zero |
| P47 | division seeding changes it by < 1 point | **HELD** -- +0.7pp |
| **P48** | recalibrating stage one's intercept brings the zero share within 0.030 | **FAILED** -- the numbers did not move at all (RB 0.031, WR 0.039, TE 0.074), and could not have; see below |
| **P49** | the per-season format improves the playoff Brier over the constant-7 run | **HELD** -- 0.2408 -> 0.2369, better in 8 seasons of 8 |
| W1-W6 | the weekly gate's own series | W1, W3, W4 held; W2, W5, W6 failed (unchanged by P48) |

**P48 is the one worth reading.** The correction was pre-registered as a level fix, and the level was
never wrong: an MLE logistic with an intercept is already mean-calibrated on its own training set
(its score equation IS `sum(p) = sum(y)`), so the shifts came out at 0.0005. The real gap is that the
trainer fits on `season_line_pg >= 3` while the harness scores every non-bye row, and those two
populations differ in zero rate by **0.106 to 0.207** at QB/RB/WR/TE -- three to seven times the
tolerance. The residual is therefore how far the FEATURES extrapolate across a population shift, not
a level: they extrapolate well at QB (0.112 gap collapses to a 0.009 residual and clause (c) passes)
and badly at TE (0.207 -> 0.074). The fix that WOULD close the clause is choosing the shift on the
scored rows, which fits the gate and measures nothing.

**P49 is worth reading for the opposite reason.** It held on the Brier and means less than it looks:
the uniform floor moves with the field too, so the skill score goes 3.5% -> 3.3%. The honest reading
is that the Phase 2c calibration finding **survives** the correction rather than depending on it.

### The tripwire, before and after

| | calendar | seeding | bracket | championships | playoffs |
|---|---|---|---|---|---|
| LEGACY (`--reg-weeks 14 --seeding record`) | 14 wk, 15/16/17 | record | reseeds | **38.1%** | 96% |
| **EFFECTIVE (the flagless run)** | 13 wk, 14/15/16 | division-first | reseeds | **39.7%** | 96% |

Paired: -1.60pp, bootstrap 95% CI [-4.59, +1.20]pp, McNemar p 0.091, legacy better in 11 of 25
seasons. Detectable effect at 80% power: 4.63pp. **They are not separable.** The legacy run reproduces
its recorded per-season line byte for byte, which is how we know five merges and a format rewrite
changed nothing they were not meant to. **39.7% is the regression line going forward.**

### Owner decisions added by this pass

6. **The seeding rule is an ASSUMPTION, not a reading.** ESPN publishes no flag for it; it is inferred
   from the league having divisions, and this league's own seeds cannot distinguish the two rules in
   any season. Worth +0.7pp, inside noise.
7. **The two-part weekly model does not ship** (P48 failed). RB/WR/TE keep the season-line floor;
   QB/K/DST keep the streaming models. It goes on accruing out-of-sample evidence as
   `weekly_challenger` from week 2, which is the only thing that will settle it.
8. **The odds have been re-snapshotted as vintage 1**, as of 2026-09-09, under the 13-week format.
   The 2026-09-08 preseason rows are untouched and both series will be scored. Our own number barely
   moved (54.33% -> 54.00% playoff, 9.17% -> 9.47% title); the FIELD compressed.

### Recommended next work

1. **The analytic-vs-simulated marginal harness for V3** -- the section immediately below, still the
   most useful open item, and now better posed: Track A fixed the named defect and V3 still lost by
   29pp, so the next question is which of the two books is wrong and where they diverge, measured
   directly rather than inferred from a championship rate.
2. **Win-probability lineups.** Track B's finding is that our lineup rule scores LESS than the room
   because it starts a player who scores zero 4-6% of the time against their 3.5% -- an information
   gap. Maximising expected points is also the wrong objective in a head-to-head week: against a
   strong opponent you want variance and against a weak one you want floor. Both point the same way.
3. **An injury-duration model.** The weekly model knows a designation and not a horizon, and the
   population gap that sank P48 is largely the deep bench, where "will he play at all" is the whole
   question.
4. **A FAAB bid model on the transaction log now in the store.** 7,480 transactions with their bids
   are in `raw_league_transaction`; the FAAB guidance the copilot gives today is a STATED RULE OF
   THUMB priced per point of playoff probability, and it says so. It could be fitted.

---

---

## PROGRAMME 3: five more parallel tracks, and a simulator bug one of them found in another

*Added 2026-09-09 by integration pass 4. Programme 2 ended with `redesign/final-2` at `1b271a6`.
Five tracks ran in parallel off it and were stacked onto `redesign/final-3`.*

### The five tracks

| track | branch | commit | what it is | verdict |
|---|---|---|---|---|
| F | `redesign/weekly-population` | `e264c13` | ONE population, defined by the DECISION, materialised as `feat_player_week_model.in_population` and read by both the trainer and the harness | The cause of pass 3's clause-(c) failure was **the trainer and the harness scoring different players**, not the model. Clause (c) now passes everywhere. **Nothing new ships**: clause (b) fails POOLED by 0.002. |
| I | `redesign/injury-duration` | `87b1049` | `fact_injury_episode`, `feat_injury_horizon`, and P(he misses the next k games) from a Friday report | **Ships** into `depthRisk` and `handcuffs`. P52 held; **P59 and P60 both failed**, and P60's stated mechanism was refuted: the injury TYPE is worth 0.001-0.002 out of sample, the PRACTICE STATUS 0.021. |
| J | `redesign/faab-model` | `7559843` | `fact_waiver_claim` -- every processed claim WITH ITS BID, winners and losers -- and a fitted clearing price plus P(win \| bid) | **Ships** into `waiverTargets`. P54 failed (26.4% better than the rule of thumb, not the 30% predicted) and the honest smaller margin is what is recorded. |
| H | `redesign/winprob-lineups` | `47f8476` | the lineup that maximises P(beating THIS week's actual opponent), and a replay of it against 1,876 real team-weeks | **Does not become the default**: a measured **-0.59pp** of team-weeks won. P51 and P57 failed, P58 held. Selectable, and it found the simulator bug below. |
| G | `redesign/v3-marginal-harness` | `563f7b1` | where V3's analytic surrogate and the simulated marginal disagree, and a fitted correction | **The level was not the reason either.** The calibration is connected (627 of 1,800 trials change) and worth **+0.28pp**, CI [-3.28, +3.56]. A clean null. V3 stays unshipped. |

The merge order was F, I, J, H, G. Every `docs/validation.md` conflict was a prepend and kept both
sides; `src/db/schema.sql` and `src/ff.ts` conflicted where two tracks appended at the same tail and
kept both; `src/inseason/copilot.ts` conflicted on one import line that two tracks had each widened,
and kept both widenings. Tests went 554 -> 566 -> 588 -> 609 -> 638 -> 645 across the five merges,
0 failures throughout, and 660 after the leftovers.

### Every prediction of this programme, with its outcome

**P50-P63 are the five tracks' own; P64-P69 are the integration pass's.** Sixteen recorded,
**nine held and seven failed** -- and as in Programme 2, the failures are where the information is.

| | prediction | outcome |
|---|---|---|
| P50 (W5) | on one population the two-part model's predicted zero share matches actual within 0.03 | **HELD** -- pooled 0.267 vs 0.267, off by 0.000 where it was off by 0.035 |
| P51 | the winprob lineup wins at least 1.5pp more team-weeks than the EP lineup | **FAILED**, on sign as well as size -- **-0.59pp** |
| P52 | the duration model beats designation-only on log loss at every horizon k=1..4 | **HELD** -- it ships on this |
| P54 | the FAAB model's LOSO MAE beats the rule of thumb by at least 30% | **FAILED** -- 26.4% |
| P56 (a) | the analytic surrogate's rank correlation with the simulated marginal is below 0.8 in at least one roster-state phase | **HELD**, and harder than predicted -- NEGATIVE in two of five phases |
| P56 (b) | the level ratio analytic/simulated is below 0.85 at EVERY position | **FAILED** -- QB 0.48 but WR 1.20 and TE 1.26; it over-prices as well as under-prices |
| P57 | the winprob gain is concentrated where the projected margin exceeds 15 points | **FAILED** |
| P58 | in the under-5-point bucket the two lineups differ in under 20% of team-weeks | **HELD** |
| P59 | at k=1 the gain over designation-only is under 0.02 | **FAILED** -- 0.047 |
| P60 | the gain GROWS with k and exceeds 0.05 at k=4, because injury type carries the horizon | **FAILED**, and the mechanism refuted -- it SHRINKS to 0.024, and the type is worth ~0.0015 |
| P61 | the claiming team's remaining-FAAB share is a significant positive feature | **SPLIT** |
| P62 | the week-of-season effect on the clearing price is negative | **FAILED**, sign reversed |
| P63 | at a 0.7 win target the realised win rate is within 10 points of 70% | **FAILED** -- 94.4%, and the prediction was mis-specified (the recommended bid is the SMALLEST bid that REACHES the target) |
| P28 (re-run under G's calibration) | V3's playoff rate is at least V2's minus 2 points on BOTH arms | **FAILED** -- long arm -26.44pp |
| **P64** | **same-team WR1-WR2 correlation lies in [-0.10, +0.05]** | **HELD** -- **+0.0130** (SE 0.0085, n 13,806) |
| **P65** | **same-team RB1-RB2 lies in [-0.20, 0.00]** | **HELD** -- **-0.0129** (SE 0.0090, n 12,340) |
| **P66** | **same-team TE1-TE2 is within 2 SE of zero** | **HELD** -- **-0.0201** against 2 SE = 0.0216 (n 8,626) |
| **P67** | **the correlation fix moves the playoff Brier by less than 0.002** | **HELD** -- 0.2369 -> 0.2368 |
| **P68** | **it moves OUR playoff and title odds by less than 1 point** | **HELD** -- title 9.61 -> 9.48, playoff 52.8 -> 53.0, both inside the seed-only noise floor |
| **P69** | **it moves the effective tripwire within noise (CI contains zero)** | **HELD**, and for a reason worth more than the prediction -- see below |

The **W-series** was not extended by this programme; W1-W6 stand as recorded in Programme 1, and
Track F's clause-(c) result is registered above as **P50 (W5)** because it is the same claim
re-measured on the corrected population.

### The same-position correlation, and the simulator fix

Track H, building the win-probability lineup, needed the correlation between two receivers on one NFL
team and found that `pairCorr` returns **1** whenever the two POSITION STRINGS match. It worked
around that locally. The season simulator did not: `prepare()` in `src/draft/bootstrap.ts` built every
NFL team's correlation matrix with `pairCorr(corr, a.pos, b.pos)`, so **two different men at the same
position on the same team entered the copula as one man**. The matrix is singular, the Cholesky
shrinkage repair fired, and that team's REAL couplings were damped on the way to something
decomposable -- silently, because the repair is designed to degrade quietly.

It was never a modelling choice. `scripts/fit-correlation.mjs` kept only the TOP scorer per position
per team-week, so a same-position pair was never measured and the model had no key for `pairCorr` to
find. The owner asked whether same-position teammates correlate positively or negatively; the answer
is that **both mechanisms are real and they very nearly cancel** -- shared game script couples two
receivers positively, competition for one ball couples them negatively -- and on 13,806 WR pairs,
12,340 RB pairs and 8,626 TE pairs the residual is inside 2 SE of zero in every case (P64-P66). Each
is written as 0 under the shrink rule, with the raw r kept beside it so shrinking to zero cannot be
misread as measuring zero. QB1-QB2 measures -0.19 and is deliberately NOT written: two quarterbacks
who both clear the six-game filter is a team that changed quarterbacks, which is the filter and not
football.

`teammateCorr` is now the two-different-men question and never returns 1; `prepare()` builds its
diagonal from IDENTITY rather than position equality; `winprob.ts` calls the shared function so the
two cannot drift. Two same-team receivers, week-1 correlation over 20,000 drawn seasons: **0.8932
before, 0.0077 after.**

**P69 held because the draft tripwire cannot see this change at all.** The paired analysis found ZERO
discordant trials in 3,750 -- bit-identical -- and `src/draft/backtest.ts` does not import the copula:
its consumers are `season.ts`, `spread.ts` and `winprob.ts`. That is recorded as a connectivity fact,
not as a null. Where the lever does live it is proven connected, by a unit fault injection and by the
odds table moving. But the odds table's moves are **not separable from noise**: the largest title
delta was 0.41 points at a roster that holds a same-position pair, and re-running with two other seed
triples and no code change at all swings title by up to 0.72 and playoff by up to 1.15.

### What ships, per position, after this programme

| | draft board | season odds / trades / waivers | weekly lineup | streaming | injury horizon | FAAB |
|---|---|---|---|---|---|---|
| QB | V2 bidder, 2d board | simulator, real schedule | **streaming artifact** | ships | ships | ships |
| RB | " | " | floor (season line / game) | not served | ships | ships |
| WR | " | " | floor | not served | ships | ships |
| TE | " | " | floor | not served | ships | ships |
| K | " | " | **streaming artifact** | ships | ships (no episodes) | ships |
| DST | " | " | **streaming artifact** | ships | n/a -- a defence carries no injury report | ships |

The lineup row is what integration pass 4 changed: `copilotStore.loadWeeklyProjection` served the
floor at all six positions until this pass routed it through `WEEKLY_SERVE`.

### The two open gate questions

**1. Does the POOLED coverage band supersede the PER-POSITION bands, or the other way round?** This is
the whole of the disagreement between the weekly gate and the streaming gate, and it decides whether
RB, WR and TE keep being served the floor. Track F's two-part model passes clause (c) everywhere and
every per-position coverage band and fails the POOLED band by **0.002** (0.852 against a ceiling of
0.85). The streaming gate has no pooled coverage condition -- deliberately, because it is applied one
position at a time and a position IS its own population -- and on the decision population it now
passes at all six. `scripts/streaming-gate-question.mjs` prints both models under the SAME corrected
clauses so the decision has both sets of numbers. **Nothing was decided and nothing was widened.**
Whichever reading is adopted must be adopted as the rule for the NEXT candidate too; choosing the
reading that lets a model through, after seeing which reading that is, is the failure both gates
exist to prevent.

**2. Should the streaming model be served at all six positions? -- AND THE MEASUREMENT REFRAMED THIS
ONE.** The question was posed on the assumption that the pooled band is what stands between the
streaming model and the three positions it does not serve. **It is not.** Run through the FULL weekly
gate, pooled condition included, on the decision population, the streaming artifact **passes every
clause at all six positions**: pooled coverage 0.847 inside [0.75, 0.85], pooled CRPS 2.7347 against
the two-part model's 2.7804, and clause (a) passing at K and DST where the two-part model outright
fails it. So the two questions separate, and only the first is about a band. What holds
`SHIPPED_STREAMING_POSITIONS` at QB/K/DST is that it was set from a streaming-gate run made BEFORE
the decision population existed, and neither Track F nor this pass widened it -- both for the same
reason: widening a shipped list on the strength of a model that has only just started passing is
tuning, and the band it passes was itself registered against the old population's numbers.
**Recommendation: re-register the coverage band as its own pre-registered job against the baseline
that ships then, and decide both questions off that -- not off this table.** And read the size of
what is on offer: Track C's control (the same trainer with the twelve opponent columns REMOVED) is
within 0.004 CRPS at every position and P42 failed saying so, so what the streaming model would win
at RB/WR/TE is the two-part structure -- which is the same thing the two-part model wins, and the
model the pooled band is refusing.

### The leftovers this pass closed

- **The lineup seam now serves what the table says.** `loadWeeklyProjection` routes through
  `WEEKLY_SERVE`, so the scorecard and the lineup can no longer disagree about a quarterback's
  projection. Track B's replay gained a third arm for it: over 1,896 real team-weeks the SERVED
  mapping scores 85.71 against the floor's 85.19 and the challenger's 88.10.
- **`--objective expected|winprob`** reaches `ff copilot lineup`, the dispatcher and the
  `lineup_recommend` MCP tool. Default `expected`, because the alternative is a measured -0.59pp.
- **The registry refuses a stale weekly artifact.** `rowFilter` must be `in_population`, and where an
  artifact carries a `populationHash` it must equal the store's; both trainers now emit one.
- **The streaming artifact is in the registry at all**, which it was not -- the model serving three
  positions had none of the registry's checks.
- **`.gitignore`** for the four generated files three tracks left untracked.

### The owner decision list, updated

Read against **"Open decisions, for the owner"** above; only the entries this programme moved are
repeated here, and none of the earlier text was edited.

- **Decision 5 (ship the two-part weekly challenger, or keep the floor) has CHANGED SHAPE and is not
  yet answerable.** It was "it failed one calibration clause by 0.005". Track F showed that 0.005 was
  the trainer and the harness scoring different players; on one population the clause passes
  everywhere. What now blocks it is a DIFFERENT clause -- the pooled coverage band, by 0.002 -- and
  that is not a model question but the gate question above. **Recommendation: answer the pooled-band
  question first, as its own pre-registered decision, and let the live scorecard keep accruing
  meanwhile.** The 2026 forward record is unaffected and is still the cleanest evidence available.
- **NEW: the pooled band versus the per-position bands** (gate question 1 above). It decides both
  decision 5 and whether streaming widens past QB/K/DST. **Recommendation: decide it on the RULE,
  before looking again at which model each reading admits.**
- **NEW: streaming at all six positions** (gate question 2). It passes not only the streaming gate
  but the FULL weekly gate -- pooled coverage clause included, 0.847 in band -- at all six positions
  on the decision population, and beats the two-part model on pooled CRPS. **Recommendation (at the
  time this was written): hold anyway, and re-register the coverage band first.** Widening a shipped
  list the week a model starts passing is the definition of tuning, the band it passes was chosen on
  a different population, and Track C already measured the opponent block's own contribution at ~0
  (P42 failed) -- so the gain on offer at RB/WR/TE is the two-part structure, not the matchup
  columns.

  **DECIDED, 2026-09-09, by the owner: ship it.** `WEEKLY_SERVE` now maps all six positions to
  `streaming-artifact.json` (`src/weekly/streamingServe.ts`, `WEEKLY_SERVE_SWITCHED_ON =
  "2026-09-09"`). This is a constant change, not a widening of any gate, check or clause -- the
  measurement above is exactly what was recorded here and nothing in it was re-run or loosened to
  reach the decision. The recommendation to hold pending re-registering the coverage band was heard
  and overridden, not silently bypassed: the owner judged the reported measurement sufficient. The
  lineup replay's `served` arm moved from 85.71 to 88.22 points/team-week (floor 85.19, challenger
  88.10) -- see `docs/weekly.md`'s 2026-09-09 addendum and `docs/validation.md` for the full record.
  Decision 5 (the two-part model, and the pooled-band question itself) is UNCHANGED by this -- the
  two-part model still ships nowhere, and the pooled band is still unregistered against the current
  population.
- **Decision 3 (V2 vs V3) is unchanged and is now better evidenced.** Track G calibrated the
  surrogate to the simulated marginal and P28 failed again. **Recommendation: as before -- V3 stays
  selectable and unshipped -- and see next-work item 3: the next attempt should be structural or
  none.**
- **NEW: the lineup objective.** `--objective winprob` is now reachable from the CLI and the MCP tool
  and is NOT the default, on a measured -0.59pp. **Recommendation: leave the default alone until a
  weekly artifact ships with a band that passed a coverage clause; the replay is a measurement of the
  bands, not of the objective.**
- **Decision 4 (the merge to `main`) stands and now names a different branch.** `redesign/final-3` is
  the chain; the flagless tripwire on it reads **39.7% / 96%** with the per-season line in
  `docs/validation.md`, the legacy cell reads 38.1% / 96% byte-identical to its record, and 660 tests
  pass. **Nothing here pushes or merges to `main`; that is still the owner's commit to make.**

### Recommended next work

1. **`feat_injury_horizon` into the weekly first stage.** Specified, not done -- the join, the
   coverage and the three traps are written out in `docs/weekly.md` section 5. It moves the stage
   clause (c) grades, so it needs its own pre-registered gate, and the prediction must be registered
   against the two-part model WITH the practice columns it already has.
2. **M2, the greedy double-count in `lineupMarginal.ts`** -- measured by Track G at up to 10% too high
   at flex-eligible positions, pinned and NOT fixed. It is a V3 input, so fixing it belongs under its
   own gate with P28 re-run unchanged, exactly as Track A's and Track G's fixes were.
3. **A STRUCTURAL V3 attempt, not another input pass.** Two passes have now fixed a named defect in
   V3's marginal (Track A: positional replacement; Track G: the level calibration) and both left the
   29pp gap. The surrogate's disagreement with the simulated marginal is not a level error -- P56(b)
   showed it under-prices quarterbacks by half while over-pricing receivers and tight ends -- so the
   next attempt should change the surrogate's FORM, or stop.
4. **Re-run the winprob replay when a weekly artifact ships with a calibrated band.** Track H's own
   diagnosis is that the search solves its problem correctly against a distribution that is not the
   real one: the only artifact with relative shape in it is the one that failed its coverage gate.
   The -0.59pp is a measurement of the bands, not of the objective.
5. **The FAAB responding-field question.** P61 split and the `log_bid` coefficient's interval crosses
   zero because four claims in five in this room are uncontested -- so a big bid is itself a signal
   that a player was contested, which biases the measured effect downward. Whether the bid AMOUNT
   moves P(win) is not answerable from 794 claims of which 630 have an outcome; it needs either more
   seasons or a design that conditions on contest.

## The one piece of work worth doing next -- DONE, and it was not enough (Track A)

*This section originally recommended pricing a quarterback against positional replacement in V3's
analytic marginal and re-running P28. Track A did exactly that (`redesign/v3-qb-replacement`,
`b36c690`), and the outcome is kept here so the recommendation is not repeated.*

The named defect was real and is fixed: V3's QB share fell from 34.3% to 21.4% (simulated book 15.2%,
VOR 20.1%), and the shading double-count turned out to be exact -- the "private" part of our
uncertainty is zero at every rank, because the spread table the bidder used IS the consensus
dispersion the market is handed. Both fixes together recovered about 6 of the 35 lost points. V3
still loses the long churn arm by **29pp, worse in 12 of 12 seasons**, and P28 was not re-specified.

The mechanism is now visible and is not an input: correcting the baseline shrinks every marginal, so
V3 bids $25-40 less and buys a weaker starting lineup. Right about relative value, wrong about level.
The residual sits between the cheap analytic surrogate the bidder runs per bid (`lineupMarginal.ts`)
and the simulated marginal it approximates (`rosterMarginal.ts`, 426 ms per candidate, unaffordable
live). **V2 stays the live bidder; V3 stays selectable.** The next tool is the analytic-versus-
simulated rank-correlation harness listed first under "Recommended next work" above, not another
pass on inputs.

One correction this produced elsewhere: `starterReserve` 4 vs 0 is flat within noise, not
byte-identical, on the long arm (16 of 1,800 trials differ, -0.17pp, CI [-0.44, 0.00]).

---

## What the 2026 season settles on its own

Nothing in this programme can validate itself further on history; the useful measurements from 1999
to 2025 have been taken. Three things resolve without anyone doing anything:

- **The 64 frozen odds rows, in TWO vintages.** 32 preseason (2026-09-08, 14-week calendar) and 32
  post-week-1 (2026-09-09, 13-week calendar) -- the second added because the league changed its own
  format, not because the first was wrong to write. They are scored as separate series against the
  same outcome, which is the only comparison that can say whether re-forecasting helped. Written once
  each, before the weeks they speak to, and now
  scoreable: when the season settles, `ff scorecard --season 2026` produces a Brier and a log loss
  for the playoff berth and the title separately, each against its own uniform floor, with a
  reliability table. It is the first forecast this repo has made that it could not have tuned.
- **The weekly scorecard**, accruing every week: the shipped model against the season line, the
  shipped `week()` path, trailing-4 and ESPN's own number, on predictions frozen before kickoff.
- **The two-part challenger, graded in public.** From week 2 the scorecard freezes the challenger's
  prediction for the same players in the same moment, under its own kind. Nobody can tune it -- the
  rows are write-once and its artifact is fixed -- so by December there is a season of out-of-sample
  evidence on the exact question the gate could not settle: whether a model that is better at
  everything except the zero-week share is better to be served from. It is the cleanest experiment in
  the repo, and it costs nothing but running the command each week. **One caveat that belongs in
  writing now**: 2026 week 1's `weekly` row was frozen under the old arrangement, from the two-part
  artifact, so the shipped series is comparable from week 2 onward and week 1 is not part of it.
- **Whether the honest arbiter (11-15% depending on window and format) or the tripwire (38-40%) is
  closer to the truth**, in the only sample that matters -- one season,
  which is worth almost nothing statistically and everything as a sanity check. If the team misses
  the playoffs, the honest arbiter is not thereby vindicated and the flagless one is not thereby
  refuted; a single draw from either distribution is consistent with both. That is worth writing down
  in advance, because it is exactly the moment somebody will want to re-baseline on one data point.
