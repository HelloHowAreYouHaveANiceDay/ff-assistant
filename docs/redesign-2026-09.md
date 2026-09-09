# The 2026-09 redesign, end to end

*Written 2026-09-09, at the end of Phase 3. This is the record for the owner: what was done, what it
cost, what it bought, what is still open, and what the 2026 season will settle without anyone's help.
Every number here is quoted from `docs/validation.md`, where the run that produced it is recorded.*

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
| **3** | `redesign/phase-3-decision-layer` | 5 (`b126af4`..HEAD) | roster-aware value; the derived bidder V3; the in-season objective re-based on P(playoffs); the odds accrual scorer | **P28 FAILED** -- V3 loses by 35 points of playoff rate in 12 of 12 seasons. V2 stays. The objective changed anyway |

**The chain to merge**, in order:

```
main
  <- redesign/phase-1-conditional-curve-trajectories
  <- redesign/phase-2a-feature-table-projector
  <- redesign/phase-2b-price-model-ecr-arbiter          (+ redesign/data-track-sources)
  <- redesign/integration                               (data track merged here)
  <- redesign/integration-2                             (weekly + copilot tracks merged here)
  <- redesign/phase-2c-real-outcomes
  <- redesign/phase-2d-weekly-features   AND   redesign/phase-3-decision-layer
```

The last two are SIBLINGS, both cut from `825e915`. They were built in parallel behind a file fence:
2d owns `src/weekly/**` (except `scorecard.ts`'s odds branch), `src/model/**`, `src/features/**`,
`tools/train_*.py` and `app/**`; Phase 3 owns `src/draft/**`, `src/inseason/**`, `src/agent/**`.
They both prepend a section to `docs/validation.md` and both append to `README.md`, so those two
files are the only expected conflicts and both resolve by keeping both sections.

---

## Every recorded prediction, with its outcome

P1-P20, P25-P31 and W1-W6 -- 33 in all; P21-P24 were never issued. **Eighteen held and fifteen
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
4. **The merge to main.** Nine branches, chaining as above, with two siblings at the head. Nothing in
   Phase 3 conflicts with Phase 2d outside `docs/validation.md` and `README.md`. **Recommendation:
   merge the chain in order, resolve those two files by keeping both sections, and re-run the flagless
   arbiter on the merge result -- it must still read 38.1% / 96% with that per-season line.**
5. **The DAG renderer change** (Phase 2d, `c4a9ccf`: the node list is derived rather than enumerated).
   It is an app-side change on the sibling branch and Phase 3 has not seen it run. **Recommendation:
   verify it in the app after the merge, since it is the one change here that only a running UI can
   check.**
6. **The price-model default.** The shipped artifact is fitted on 2020-2025 and beats `rank` on the
   2026 holdout by $0.89 of MAE, not the $2 that was predicted -- and `rank` is BETTER at the top of
   the market. The price book is the default opponent for the honest arbiter. **Recommendation: keep
   it, and treat any elite-tier conclusion that rests on it as the least trustworthy kind.**

---

## What the 2026 season settles on its own

Nothing in this programme can validate itself further on history; the useful measurements from 1999
to 2025 have been taken. Three things resolve without anyone doing anything:

- **The 32 frozen preseason odds rows.** Written once, before kickoff, on 2026-09-08, and now
  scoreable: when the season settles, `ff scorecard --season 2026` produces a Brier and a log loss
  for the playoff berth and the title separately, each against its own uniform floor, with a
  reliability table. It is the first forecast this repo has made that it could not have tuned.
- **The weekly scorecard**, accruing every week: our model against the season line, the shipped week
  path, trailing-4 and ESPN's own number, on predictions frozen before kickoff.
- **Whether 14.5% or 38.1% is closer to the truth**, in the only sample that matters -- one season,
  which is worth almost nothing statistically and everything as a sanity check. If the team misses
  the playoffs, the honest arbiter is not thereby vindicated and the flagless one is not thereby
  refuted; a single draw from either distribution is consistent with both. That is worth writing down
  in advance, because it is exactly the moment somebody will want to re-baseline on one data point.
