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

1. **`DEFAULT_LEVERS`.** P31 measured `starterReserve` provably inert at the shipped `aggr` (4 vs 0
   produces byte-identical trials), and `premium` and `maxShare` flat within noise on five seasons.
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

## The one piece of work worth doing next

**Price a quarterback against positional replacement in the analytic marginal, then re-run P28.**

P30 is the most useful failure in the programme because it names a bug rather than a limit. V3's
analytic marginal measures a player against a STREAMING FLOOR, so an elite quarterback is priced by
how far he beats the waiver wire -- which is a long way. VOR prices him against the seventeenth
quarterback, which is what a one-QB league actually pays. The evidence that this is the defect and
not a property of roster-aware valuation is that the SIMULATED roster-aware book gets it right: it
cuts the QB share of our money to 16.2%, toward the room's own 7.8-11.2%, with no positional term
anywhere in the module. The analytic surrogate the bidder can afford to run per bid takes it the
other way, to 31-34%.

So the work is bounded and the test already exists. Change the analytic marginal's baseline at each
position from the waiver floor to the last starter the league rosters at it, confirm on
`scripts/roster-book.mjs` that V3's positional shares move toward the simulated book's, and then re-run
P28 unchanged: `--bot-churn --bot-book price`, 2012-2024, n=150, paired. That arm has a detectable
effect of 8.5pp and V3 currently loses it by 35.5 points in twelve seasons out of twelve, so it is
capable of giving a clear answer either way.

Two things to hold to when doing it. The shading term is ALSO wrong -- our predictive uncertainty is
largely shared with the room, and combining it in quadrature with the market's private spread
double-counts -- but it explains only about 7 of the 35 points, so fixing it first would move the
number without settling anything. And P28's threshold must not be re-specified: a bidder that has to
be re-measured against a softer rule to pass is a bidder that failed.

---

## What the 2026 season settles on its own

Nothing in this programme can validate itself further on history; the useful measurements from 1999
to 2025 have been taken. Three things resolve without anyone doing anything:

- **The 32 frozen preseason odds rows.** Written once, before kickoff, on 2026-09-08, and now
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
- **Whether 14.5% or 38.1% is closer to the truth**, in the only sample that matters -- one season,
  which is worth almost nothing statistically and everything as a sanity check. If the team misses
  the playoffs, the honest arbiter is not thereby vindicated and the flagless one is not thereby
  refuted; a single draw from either distribution is consistent with both. That is worth writing down
  in advance, because it is exactly the moment somebody will want to re-baseline on one data point.
