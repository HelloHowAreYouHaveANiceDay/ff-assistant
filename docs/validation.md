# Validation harness (how we know a change is better, not a regression)

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
