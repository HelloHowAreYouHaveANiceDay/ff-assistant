# What edges are actually possible (and which we've measured)

All championship numbers are from the multi-season backtest (`ff backtest --seasons 2014-2024`,
docs/validation.md); random baseline = 6.3% (1 of 16). Directions are robust; absolute magnitudes
depend on the bot model, so weigh them as "big / medium / none", not to the decimal.

> **Curve note (2026-09-03):** the percentages on this page were measured under the OLD even-split
> FLEX baseline. The value curve has since changed (points-weighted FLEX allocation), which moved
> the full-system no-lookahead headline from 13.6% to 24.4% championships -- and later work (bid
> shading, benchDiscount, reserve/share) took it to **~33% on 25 seasons**. Numbers on this page are
> pre-shading and stale in MAGNITUDE; the RANKING of edges still holds. See "Weighted FLEX
> baselines" in docs/validation.md. The RANKING of the edges below is unaffected (the fix is itself
> an instance of edge #2: a better independent value table); the absolute numbers are stale.

> **THE OBJECTIVE NOTE (2026-09-09, Phase 3), and it changes how every percentage on this page should
> be read.** P(title) = P(playoffs) x P(title | playoffs). Scored against 114 real team-seasons of this
> league, the season simulator BEATS a uniform baseline on the playoff berth (Brier 0.2370 vs 0.2451)
> and LOSES to it on the champion (0.0659 vs 0.0652). Single elimination among seven makes the second
> factor nearly a coin flip. **So a "championship edge" on this page is a playoff-seeding edge plus a
> lottery ticket, and the lottery half is not something any model here can move.** Where a lever's
> value is quoted in championship points, read it as evidence about the seed. Where two options differ
> by a couple of championship points and nothing else, the honest answer is that they do not differ.
> The in-season tools were re-based on P(playoffs) for exactly this reason (docs/in-season-design.md).
>
> **THE CHAMPIONSHIP IS NOT PREDICTABLE FROM THE DRAFT, and that is measured rather than argued.**
> Over eight settled seasons the simulator's spread of title probabilities runs 3% to 20% and buys
> nothing against a flat 1/n; P(title | seed) is flat where it should not be (the 2 seed and the 4
> seed each won 25% against a predicted 11.6% and 5.8%, while the 6 and 8 seeds never won); and the
> 2025 champion was the **7 seed at 9-5**. A draft strategy can put you in the bracket. What happens
> in the bracket is not an edge anybody in this repo has been able to find.

### 0. Get the value curve itself right -- BIG, proven [13.6% -> 24.4%, pre-shading]
Before any strategy dial: the bid table must price positions the way the format actually consumes
them. Splitting FLEX slots evenly across RB/WR/TE instead of allocating them by projected points
gave TE 11 phantom starting slots and cost ~11 championship points. This dwarfed every config
lever we had tuned, and no test caught it because the sim's bot book shared the same function.
Lesson: an artifact BOTH sides of a comparison are computed from cannot be validated by that
comparison.

## Edges the harness QUANTIFIES (draft edges)

### 1. Discipline vs an overpaying room -- REAL, and about half the size we thought (rewritten 2026-09-09, Phase 2c)

**The old text said ~27%, 4.4x random. Under an arbiter that gives the field both of the things this
one was missing -- the real published consensus and the waiver wire -- it is 12-21%, or 1.9x to 3.4x
random.** Same room, same levers, same discipline; a different opponent.

The room really does overpay for studs (nine real drafts: top price $88-121 in a $3,200 room, 54-61%
of picks at $1-5) and bidding rational values really does beat it. What changed is that the old
number was measured against a field drafting on OUR OWN projection plus one shared error we chose,
and never touching its roster after August. Neither is true of anybody's league. The grid is in
docs/validation.md; the short version is that the edge survives every cell and shrinks by half.

**What to do with it is unchanged, and that is the point.** Bid your own values, do not chase, keep
the reserve. The thing to stop doing is quoting a championship percentage as though the arbiter were
a fact about the world.

### 2. Your OWN projection (independent of the consensus) -- REAL, BUT MOSTLY A STATEMENT ABOUT HOW MUCH NOISE WE GIVE THE MARKET (rewritten 2026-09-08, Phase 2b)

**The old text said this was worth ~12 championship points "even at the SAME accuracy". That claim
could not survive an arbiter that models the market properly, and it did not.**

The measurement it came from had the room draft on OUR OWN projection times one shared lognormal
error of sd 0.30 -- a number that was asserted and never measured. So "an independent projection"
was really "a projection with less noise than the number we chose to give the opposition", and the
size of the edge was a re-statement of that choice. Phase 2b built the honest arbiter (`--market
ecr`: the room drafts on the REAL preseason consensus, rookies included, with each bot holding an
independent view) and swept the one parameter the old claim rested on:

| what the market drafts on | rank book | price book |
|---|---|---|
| our projection + shared sd 0.30 (the old arbiter) | 36.1% | 34.6% |
| real consensus + its MEASURED error by rank band | 47.9% | 45.9% |
| real consensus, published, no extra noise at all | **21.6%** | **14.6%** |

Twenty-six points between the top and bottom rows, from one modelling choice about the opposition.
The middle row is what the instruction asked for and it double-counts (the consensus projection
already contains its own error -- it is a projection, not the truth -- so multiplying it by a fresh
draw of the same size gives the market twice the variance it has, while our book carries none). The
bottom row is the other honest reading. **The truth is between them and nobody knows where.**

**PHASE 2C completed the arbiter (2026-09-09).** Phase 2b's bottom row gave the room a single shared
view and left it standing pat all season. Both are now fixed: each bot holds an INDEPENDENT view of
log-sd 0.20 on top of the published consensus (bounded by the price model's own residual dispersion,
0.35-0.90 by tier), and `--bot-churn` gives the field the waiver wire at this room's observed rate.
2020-2024, n=300, against the rebuilt 16-owner field:

| what the field drafts on, and whether it works the wire | vor book | rank book | price book |
|---|---|---|---|
| our projection + shared sd 0.30, standing pat *(the legacy arbiter)* | 41.5% | 36.2% | 33.9% |
| our projection + shared sd 0.30, working the wire | 28.3% | 29.4% | 29.3% |
| the consensus AS PUBLISHED + per-bot 0.20, standing pat | 23.1% | 23.8% | 16.7% |
| the consensus AS PUBLISHED + per-bot 0.20, working the wire *(**the honest arbiter**)* | **11.9%** | **21.0%** | **14.5%** |

**Thirty points from top-left to bottom-left, none of it a change to our strategy.** And the
pre-registered guess about which opponent book flatters us most (P20: vor > rank > price, on the
grounds that `vor` is our own function wearing a costume) was WRONG in the most useful direction: on
the bottom row `vor` is the HARSHEST book, not the kindest. A field that prices players exactly as we
do makes the same mistakes we do, so it neither overpays the studs we are avoiding nor leaves the
mid-round value we are collecting. **The mirror is not automatically the easy opponent.**

What survives is unchanged in kind and smaller in size: do not bid the consensus's own numbers, chase
measured projection accuracy rather than measured edge, and treat any specific championship
percentage as a statement about the arbiter as much as about us.

What survives, and it is not nothing:

- **Do not bid the consensus's own numbers.** That much is structural rather than parametric: if your
  book is the room's book you can only win by outbidding, which is the opposite of the discipline
  edge. Use our own nflverse-derived values. We already do.
- **The size of the edge is unknown and smaller than 12 points.** Any plan that budgets a specific
  number of championship points for "we have our own projection" is budgeting against the old
  arbiter's assumption, not against the room.
- **Measured projection accuracy is a better thing to chase than measured edge.** The nested CV
  (`ff evaluate-projection`) scores the projection against outcomes and cannot be gamed by a choice
  about the opposition. The trained artifact beats curve-only there -- RMSE 54.32 vs 55.55, pinball
  12.39 vs 13.17, coverage 0.764 -- and is STILL not a measurable backtest improvement (-1.33pp over
  13 seasons, CI [-5.85, +3.38]). Those two facts sitting side by side is the honest state of play.

### 3. A MORE ACCURATE projection -- MEDIUM, and it compounds [~39% -> ~46%]
Tightening our projection error (sim sigma 0.30 -> 0.05) lifts titles ~39% -> ~46%. Diminishing but
real. This is why investing in a better projection source (multi-source consensus via ffanalytics,
a real model, injury/role updates to draft day) pays -- it is the top TUNABLE lever.

### 4. IN-SEASON lineup management -- BIG absolute, MEDIUM marginal, driven by WEEKLY projections
Setting your weekly lineup by that week's info (matchup/health) instead of a season average is the
single biggest ABSOLUTE lever: naive season-lineups -> 41% titles, weekly-informed -> ~69%. BUT most
managers already set weekly lineups, so the realistic MARGINAL edge is being BETTER than the room:
- everyone naive: 41%  |  everyone equally weekly-skilled: ~45%
- us better than the room (weekly proj sd 0.25 vs their 0.4): ~49.5%
- us much better (sd 0.15): ~51%
So ~+5-7 championship points for superior WEEKLY projections -- comparable to the draft value edge,
and the SAME lever (sharper projections) applied weekly. This is why in-season and projection
sharpening are one build: one projection layer -> season values (draft) AND weekly forecasts (lineup).
The agent also never forgets to set a lineup or misses a bye -- a real edge over humans who do.

### 5. Roster construction / aggression dial -- BALANCED WINS (corrected Step 5, 2026-09-02)
The earlier "NONE across seasons (~27-28%)" was the OLD uniform bot on the wrong 16-slot roster and
did not hold. On the realistic per-manager field + the real 12-slot roster + the multi-season value
curve AND at aggr 1.0, championship rose with the per-starter reserve to a plateau at 15-20 (~24%)
and
collapses at 25 (over-reserved). Default at the time: **reserve 15 / max-share 0.35** (~24%, the 12-20 plateau; 15 over 20 for live robustness) vs the old
aggressive-lean 5/0.6 (15.7%) -- a ~8.5-pt swing, measured against the realistic field on the
12-slot roster; the earlier neutrality was the uniform bot. Full table: docs/validation.md.
**SUPERSEDED 2026-09-05:** the whole sweep above was run at `aggr 1.0`. With shading shipped
(`aggr 0.7`) the reserve is nearly INERT and `maxShare` is what binds; the shipped posture is
**reserve 4 / max-share 0.25**, ~33%. Read the numbers above as history, not as a default.

**MEASURED AGAIN UNDER THE HONEST ARBITER (2026-09-09, Phase 3), and "nearly inert" was generous.**
Swept against the shipped arm on the same seeds, 2020-2024, n=300, paired:

| lever | setting | playoff rate | paired difference | verdict |
|---|---|---|---|---|
| `starterReserve` | 4 -> 0 | 49.0% | **0.00pp** on this arm | flat. Recorded as yte-identical and that is TOO STRONG: on Track A's long arm 16 of 1,800 trials differ (-0.17pp, CI [-0.44, 0.00]). The soft reserve almost never binds at `aggr 0.7` |
| `premium` | 2 -> 0 | 49.1% | +0.07pp, CI [-4.5, +6.0] | flat |
| `maxShare` | 0.25 -> 0.50 | 47.9% | -1.07pp, CI [-3.6, +0.7] | flat |
| `benchDiscount` | 0.25 -> 1 | 43.4% | -5.60pp, CI [-16.7, +3.5] | the only one still doing work |

Three of the four are indistinguishable from doing nothing on this arm, and `starterReserve` is
provably inert rather than merely small. Nothing was changed on the strength of it -- five seasons
cannot adjudicate a lever measured on 25 -- but a plan that treats the reserve as a live dial is
planning around a knob that is not connected at the shipped aggressiveness.

### 6. A DERIVED bidder instead of tuned levers -- TRIED AND REJECTED (2026-09-09, Phase 3)

The obvious next move after "the levers are corrections for a missing quantity" is to measure the
quantity: what a player adds to THIS roster, priced by inverting the budget curve, with a
winner's-curse shading derived from dispersion and the number of live bidders. Built as V3
(`FF_STRATEGY=v3`), fully connected, every term fault-injected. **It loses to V2 by 35 points of
playoff rate over thirteen seasons, in twelve seasons out of twelve.**

The reason is worth keeping, because it is not "the idea is wrong". The SIMULATED roster-aware book
behaves exactly as the theory predicts -- it cuts the QB share of our money from 20.1% to 16.2%,
toward the room's own 7.8-11.2%, with no positional term anywhere in it. But a simulated marginal per
bid is ten million season simulations and cannot be backtested, so the bidder uses an ANALYTIC
surrogate, and the surrogate prices an elite quarterback against a streaming floor rather than
against the seventeenth quarterback -- so it goes the other way, spending 31-34% of the budget at QB
where V2 spends 20-31%. **The gap between the book that can be simulated and the book that can be
bid is where the loss lives.** Anyone picking this up should start there and not with the shading.

## Edges that are REAL but the bot-sim can't see (agent vs HUMANS)

The backtest is agent-vs-bots, so these don't show up -- but they are exactly where an always-on
software agent beats distracted humans:

- **Never miss a bid / perfect clock management** -- acts on every nomination, in the final second,
  never gets sniped for lack of attention. (Our jump-bidding does this.)
- **Perfect budget + roster-slot tracking** -- always knows the exact legal max bid and the reserve
  to still fill a legal roster; humans miscount and either strand money or can't fill a slot.
- **No tilt / no reaching** -- doesn't panic-buy in a position run or chase a player above value
  after losing one. Sticks to the plan.
- **Live scarcity / VONA premium** -- pay up as a position runs dry. BUILT but BACKTESTED NEGATIVE
  (-4.5 pts, 18->13%) and OFF by default. In a deep 16-team league the "next available" at any
  position is close, so the premium mostly makes us overpay; the value table already prices scarcity
  statically. (`--scarcity` to experiment.)

- **Nomination gamesmanship** -- nominate players you don't want at a known payer's craved position
  to drain them (`src/draft/nomination.ts`, scouting report in the per-install, gitignored
  `data/league-managers.md`). **Built AND
  measured: in the backtest it is NEUTRAL-to-NEGATIVE** (drain-nom 18%->12%; greedy-non-target 15.5%;
  value-greedy default wins). Rational bots don't tilt, so the sim can't reward it -- exactly why this
  belongs in "can't see it" (below). It's a real edge only vs distracted HUMANS; kept as a documented
  live option, never defaulted. The disciplined lesson, twin to auto-waivers: don't ship a
  sim-negative feature as if validated.
- **Live inflation tracking** -- recompute values as money/talent leave the board. BUILT + BACKTESTED
  + WIRED LIVE (src/draft/inflation.ts): reprice by remaining$ / remaining book value. Backtest:
  **+~2 championship pts / +3 playoff pts** (17->19% draft-only, 12->14% full no-lookahead) -- a
  mechanical market correction the rational bots DON'T neutralize, unlike gamesmanship. ON by default
  in the live bidder (`--no-inflation` to disable). Live now computes it EXACTLY from the scraped
  drafted set (`espnAuction.readDraft` -> the pick-history feed) instead of the old virtualized-board
  proxy: remaining$ (from every team's `.cash`) / value of the top undrafted players in our table.
  Verified live: reads ~1.03 at the open, drifts to ~0.95 as the room spends down.

- **PER-POSITION inflation -- captured + BACKTESTED, REJECTED as a bidding input.** The draft log
  records empirical inflation per position (actual $ / our book), and it DIVERGES hard live (one mock:
  WR 2.03x book while RB went 1.05x). Fading the overpaid position seemed promising -- but backtested
  it adds ~nothing over global inflation and slightly HURTS combined: draft-only 19.1% (global) ->
  18.8% (global+pos); full-system no-lookahead 13.9% -> 13.4%; alone it's ~neutral (16.8->17.0). Why:
  disciplined value-bidding + global inflation ALREADY fades overpaid positions automatically (we bid
  our value, get outbid on the hot position, redirect to value) -- explicit fading double-counts. So
  `--pos-inflation` stays OFF by default; the per-position capture is kept only as a HUMAN signal in
  the draft log (shows where the room is overpaying), not an automated lever. Same discipline as
  scarcity/waivers/nomination: measured, didn't help, not shipped.

### 5b. THE FIELD ALSO WORKS THE WIRE, and about a third of our headline was it not doing so (2026-09-08)
Every championship number on this page and in docs/validation.md was measured against a field that
stood pat from September to January. This room does not: about fifteen adds per team per season,
roughly one a week. `--bot-churn` gives every bot the same conservative rule our team runs, and the
paired result is **-12.83pp** (38.2% -> 25.4%, CI [10.27, 15.12], worse in 24 of 25 seasons). It is
not an asymmetry from giving the field a tool we lack -- with `--waivers` on both sides it is
-12.96pp. The pre-registered prediction was a fall of 0.5-4 points; it failed by a factor of three.
Kept behind a flag until the owner decides which arm is the arbiter, but read every absolute number
on this page in its light.

### 6. Waiver churn (automated) -- NEGATIVE in a deep league [backtested]
Surprising, and the backtest earned its keep: automating waiver pickups by recent production LOSES
titles here (a material drop off the same-config baseline; the old "36% -> 24-27%" absolutes were
against the retracted uniform bot -- trust the direction). In a 16-team league the free-agent pool is mostly
replacement-level, so churn drops real drafted talent for hot-hand noise that regresses; more
churn = worse. Real waiver value is injury-replacement + genuine breakouts (rare, hard to ID early),
so waivers are a CONSERVATIVE human-gated COPILOT (`src/inseason/waivers.ts` -- surface only clear
rest-of-season upgrades, don't auto-drop), NOT an auto-edge. Shallower leagues (8-10 team) would
differ -- more talent on the wire.

### 7. Progressive in-season re-projection (role-trend) -- accuracy signal REAL but tiny; decision NULL/NEGATIVE [backtested]
Tested the strong hypothesis that in-season role (snap/route share) trend should sharpen the frozen
preseason line -- the shipped projection is static (frozen at Y-09-01; only availability updates), so
a role-change like a backfield takeover is structurally invisible to it. Built a full decision-backtest
layer for it (`src/inseason/backtest/{projectors,opportunity,progressive}.ts`, Phases 0-4, all with
hermetic tests):
- **The instrument works** (Phase 0 guillotine): an oracle projection beats the frozen line by +38.5
  pts/decision on the waiver probe (CI clear), while noise (-29.7) and shuffle (-21.7) do NOT -- so the
  harness can see projection quality and reject fakes.
- **The signal is REAL but small** (accuracy diagnostic): role-trend re-projection is more accurate than
  the frozen line on the ~4,900 role-change players, MAE 4.223 -> 4.131 (~2%), largest exactly where
  role moved -- the conviction is correct in principle. Overall MAE 4.282 -> 4.255.
- **It does NOT clear the decision bar** (holdout, both scorers): re-scaling the frozen line by role
  trend did not improve the waiver ADD decision on either holdout split under both realized and sim
  scorers -- tiny, sign-unstable across scorers. The sharper CHANGE-POINT variant (regime detector) was
  actively NEGATIVE (-0.5 to -1.1). A ~2% accuracy gain on a 4.2-pt-MAE base (weekly points are mostly
  irreducible noise) is too small to flip which FA is the best add, and speculative hot-role adds
  mean-revert while the frozen-forward scorer holds them all season.
- **The ~2% ceiling is robust to the CHANGE ENCODING** (`scripts/inseason-change-metrics.mjs`): swept a
  family -- SMA(2..5), EWMA(hl 1..3), MA crossover, OLS slope -- on the accuracy diagnostic with holdout
  selection. Shorter/more-responsive wins marginally (SMA(2) best, held-out ~2.7%), EWMA(1) close; slope
  and crossover worse. But every encoding lands at ~2-3%, and SMA(2) -- the winner -- was itself
  decision-REFUTED on holdout (realized/sim sign-flip). It is not the encoding; the role signal is just
  small.
- **The features AGGREGATE to a bigger accuracy lift -- but STILL fail the decision**
  (`scripts/inseason-aggregate-model.mjs`): a per-fold ridge over the full in-season set (frozen line +
  form + role level + role trend + usage + dvp matchup + Vegas implied total) is held-out ~5-6% more
  accurate on role-change players (3.94->3.74, 4.35->4.10) -- 2-3x the role-alone lift, because the
  orthogonal features (matchup, Vegas) add real signal the correlated ones (role/form/usage) don't. Yet
  its waiver decision is realized +0.3/+0.5 (CI includes 0) and sim -0.35/-0.56 (CI EXCLUDES 0,
  negative). A genuinely more accurate projection makes a WORSE distributional decision: MAE rewards
  average calibration, but the waiver decision is top-of-pool RANKING + tails, and a model more
  confident about volatile players makes riskier adds that the injury/variance-aware scorer punishes.
Lesson (same shape as #6 and the CLAUDE.md accuracy-vs-decision rule): a targeted -- OR aggregate --
accuracy win does not imply a decision win; accuracy and decision value are different objectives. Role
trend is worth surfacing as a COPILOT signal ("this player's role is rising") but neither it nor the
full aggregate model is an automatable projection edge. Reproduce: `scripts/inseason-backtest-progressive.mjs`,
`scripts/inseason-progressive-accuracy.mjs`, `scripts/inseason-change-metrics.mjs`,
`scripts/inseason-backtest-projection.mjs`.

### 8. Strength of schedule -- a LAYER-2 (playoff) signal, not a Layer-1 (accuracy) one [backtested]
Tested SOS (point-in-time opponent defense-vs-position ease, rated only through the decision week) in
both layers (`scripts/inseason-backtest-sos.mjs`, `src/inseason/backtest/sos.ts`):
- **Layer 1 accuracy: NO.** A naive season-to-date SOS adjustment makes next-week prediction slightly
  WORSE (frozen MAE 4.55 -> 4.56/4.62), because raw points-allowed is noisy and multiplicative ease^beta
  over-adjusts. (A properly SHRUNK matchup coefficient -- dvp inside the ridge aggregate model, #7 --
  gave only a tiny help.) Matchup is real signal but must be regularised, not applied raw.
- **Layer 1 rest-of-season -> waiver decision: REFUTED/negative**, sign-unstable like every other
  in-season projection tweak.
- **Layer 2 playoff schedule -> playoff-week value: looked positive, REFUTED on firm-up.** Under the
  REALIZED playoff scorer, favouring soft weeks-15-17 matchups looked like the one positive lead
  (+0.94/+1.45 across holdout splits; +1.18 CI[0.36,2.07] P99% at fixed beta over all 7 seasons). But the
  firm-up (`scripts/inseason-sos-playoff-firmup.mjs`) ran the SIM-DISTRIBUTIONAL playoff scorer and it
  FLIPPED SIGN: -1.27 CI[-2.09,-0.48] P0%. Per-season the realized positive is driven by 3 of 7 seasons
  (2018/19/24 each +7 to +9; 2022/23 negative) -- high variance, not robust. Same failure as role trend:
  the realized scorer rewards risky soft-matchup adds that happened to hit; the variance/injury-aware
  scorer, which prices their downside, refutes them.
Lesson: the layer framing is load-bearing (SOS is a playoff concept, not a season-accuracy one), but even
in its right layer playoff-SOS is not an automatable edge -- a conclusion must survive BOTH scorers, and
the realized-only positive is the recurring seduction of a variance-blind metric. Keep playoff SOS a
human-gated read (`playoff_sos`); do NOT fold it into the projection or an automated waiver.

### 9. College production + athleticism as rookie-projection features -- REAL but redundant with draft capital [backtested]
Gathered the missing rookie pillars (combine/RAS, NGS, college Dominator/Breakout -- commits e5e0fc3,
2879a42, d897861) and validated them on a rookie-holdout (`scripts/rookie-holdout.mjs`): predict
rookie-season PPG for drafted RB/WR/TE 2016-2024 (n=406), held out by draft class. Rookies never appear
in the projection's training set or the historical backtest (both need a prior-season finish), so this
purpose-built holdout is the only way to check them.
- The features are CONNECTED and real: prospect-only (athletic_score + dominator + breakout_age, no draft
  capital) predicts rookie PPG at r 0.23-0.26 on holdout.
- But they are fully SUBSUMED by draft capital: draft capital alone is r 0.50-0.54; adding the prospect
  features moves it ~0.00 (0.497->0.494, 0.541->0.541), MAE unchanged. Even on late picks (overall >=100,
  where draft capital is coarse) +prospect does not help (r 0.234 vs 0.242, 0.233 vs 0.228).
Matches the prior art exactly ("athleticism gets the smallest weight because NFL teams account for it
with draft capital"). The data foundation is real and reusable (combine/NGS/college now ingested +
crosswalked, docs/data-sources.md), and `feat_player_prospect` is a validated per-player asset -- but the
projection should NOT fold these in as rookie features; draft capital (already a projection feature)
carries the signal.

**The deeper structural finding (the real gap): rookies are unpriced in the backtest, so the ARBITER
cannot see them.** `season_line_pg` is NULL for 0/406 historical rookies in their rookie season, because
`backtestFeatureRows` (src/model/features.ts:234) builds its pool from `feat_player_season` season Y-1
finishers and a rookie has no Y-1 NFL row. So the championship backtest never drafts a rookie and cannot
evaluate rookie draft value, and rookie projection quality is not gradeable there. The live board path
DOES price rookies (ECR consensus rank, which encodes draft capital), and the achievable rookie-year
ceiling is r~0.52 (draft capital) -- but none of that is historically validatable. The one project that
would matter is a rookie POOL in the backtest priced by a draft-capital->finish model, so rookies enter
the arbiter.

**BUILT (flag-gated): `ff backtest --rookies`.** `src/draft/rookieModel.ts` fits expected rookie season
points as a log-linear function of overall draft pick per position (E[pts]=a+b*ln(overall)); leave-one-
season-out r=0.663, MAE 37.5 (matches the draft-capital ceiling). `--rookies` adds each drafted skill
rookie who appears in that season's actuals, priced by his draft pick, to the pool -- 1,451 across 25
seasons (~58/yr). Paired (CRN) effect on the shipped headline: NEUTRAL/within noise (n=150: --no-rookies 38.7% ->
rookies-on 38.5%, -0.2pp). Healthy: rookies priced by draft capital ~ how the market prices them, so no
systematic edge, but the arbiter now REPRESENTS rookies instead of being blind to them.

**NOW DEFAULT ON** (`--no-rookies` drops them for the old behavior). CLAUDE.md's stale "~33%" was
corrected to ~39% (the effective tripwire is 39.7%; rookies barely move it). The next full validation
pass should record the rookies-on tripwire.

**The parallel WEEKLY gap, and the rookie role-trend re-test.** Rookies are also unpriced in the WEEKLY
backtest path -- `season_line_pg` is NULL for 0/59 historical rookies (2023) -- so the weekly scorecard,
the in-season decision harness, AND the #7 progressive-projection experiment all silently EXCLUDED
rookies (they filtered on non-null `season_line_pg`). The live board path does price them (ECR rank:
54/54 2026 rookies). Built a weekly rookie fallback (`rookieWeeklyLines`, draft-capital season points /
scheduled games) -- MAE 4.30 vs actual, a legitimate line where there was none. Re-tested role-trend on
rookies with it (`scripts/rookie-weekly-roletrend.mjs`): on the role-change subset (31% of rookie-weeks,
far more than veterans) role-trend cuts MAE 4.1% at a=1.0 -- ~2x the veterans' ~2% (#7), the
highest-leverage case as predicted. Still ACCURACY only. WIRED the fallback into the projection (preseasonLinePerGame,
backtest branch; the live board path keeps ECR) and rebuilt 2018-2024: rookies now have a
season_line_pg (59/59 for 2023, was 0), so the weekly model, scorecard, and decision harness
finally SEE them -- veterans unchanged (additive). With rookies now in the harness, the
role-trend DECISION test is STILL refuted (accuracy 2x on rookies does not convert to a waiver
edge, same as #7). So: the coverage gap is fixed (a real win -- the model represents rookies
weekly), but week-over-week role re-projection remains accuracy-only, not an automatable edge.

### 10. Trades -- a REAL validated edge, and the biggest coverage gap now closed [backtested]
The QA audit flagged trades as the biggest hole: `trade_check`/`trade_finder` ran a full paired sim and
shipped live, but NOTHING backtested them (the single-roster harness can't A/B a two-sided deal). Built
`src/inseason/backtest/trades.ts` (`ff inseason-backtest trade`): replay every point-in-time state,
propose the best roughly-fair (|proj gap|<=3) one-for-one that improves OUR projected optimal lineup and
does not hurt the counterparty (mutual), apply it to BOTH rosters, score realized rest-of-season (a trade
is permanent -> frozen-forward is right).
- REALIZED: +5.06 pts/decision (CI [1.54, 9.89], P 100%), traded 1220/1232 -- the first strongly-positive,
  well-controlled in-season decision edge in the repo. Positional arbitrage: trade surplus for need at
  fair value.
- CONTROLS: a RANDOM fair trade is -2.05 (a random swap slightly hurts), so the +5 is genuine SELECTION
  skill, not a frozen-forward/hindsight artifact; give-best-for-worst is -38.2 (scorer detects direction).
- CAVEATS: the SIM scorer reads +18.9 but is CIRCULAR (we select and score on the same projection) -- trust
  the realized +5. The counterparty loses realized -3.9, so "mutual" (projected non-negative) deals still
  extract value in hindsight -- real, but not truly win-win. Season-variable (2018 +20, 2019/2022 ~0).
So trade recommendations have teeth, and the capability is now VALIDATED, not just shipped. (A two-sided
RosterPolicy is still absent from the generic harness; this is a dedicated two-roster backtest.)

**PACKAGE trades (2-for-1 / 1-for-2 / 2-for-2) -- a prior-art borrow that pays [backtested].** Extended
the search to multi-player packages (arXiv 2111.02859, 2511.17535: trades as a knapsack over packages;
the net-receiver auto-drops its lowest-proj scrub back to its original roster size, so a full roster does
not block a 2-for-1). `ff inseason-backtest trade-package`, `src/inseason/backtest/trades.ts`
(maxGive/maxGet), 2018-2024 realized: 1-for-1 +5.06 -> **1-for-2 +7.62 (CI [3.73, 12.29], P 100%)** ->
2-for-2 +7.26. The clean win is **1-for-2 (acquire depth)**: trading a surplus stud for two contributors
adds ~+2.6 over the one-for-one -- flexibility and injury resilience pay in a deep league. 2-for-1
(consolidate into a stud) reads -1.385, but that is CONFOUNDED: a 2-for-1 shrinks our roster and the
backtest does not model filling the freed slot with a free agent, so consolidation is understated, not
shown bad. Random control stable -2.05 throughout. (Implementation note: an early version trimmed rosters
to the TEMPLATE slot count, which silently shrank legitimately-large rosters and collapsed the one-for-one
baseline to +0.24 -- caught because the MDP probe showed +5.06 on the same data, so it had to be code, not
data; the fix trims only a net-receiver, back to its own original size.)

### 11. Lineup information gap -- game-day availability is worth ~1.8 pts/week [backtested]
The QA audit's one decision we LOSE to humans (lineup, -1.4 to -4.5 pts/wk). Root cause is mechanical:
the live copilot benches OUT/DOUBTFUL but STARTS questionable players (copilot.ts:341), and there is NO
game-day inactive feed anywhere in the repo (Sleeper `player_status` is a designation snapshot, not the
~90-min OUT list). So a questionable-then-inactive player is started and scores 0.
`scripts/inseason-backtest-lineup-info.mjs` sizes it: set each historical lineup by projection with NAIVE
availability (bench OUT/DOUBTFUL, start Q -- our live rule) vs FRESH (bench every actual scratch), diff
realized. **Gap = 1.79 pts/team-week (2018-2024, 1330 team-weeks; 1.24-2.88 by season)** -- of 884
questionables we'd start, 232 (26%) sat for 0. This is the ceiling of what game-day availability info is
worth, and it explains most of the human gap. CLOSING it needs (a) a game-day inactive feed (ESPN
app-bridge/Sleeper gameday, none wired), and/or (b) a play-probability model for questionables (the
prior-art approach: P(active | report+practice status), data exists in feat_player_week_context). News
blurbs (ESPN/RotoWire RSS) are ingested but read-only -- no NLP-to-status path (in-season-design.md:174).

**B1 (play-probability model) built and REFUTED as the fix.** `src/inseason/backtest/playProb.ts` fits
P(active | Friday report + practice), leave-one-season-out -- beautifully calibrated (Q+Full 70%,
Q+Limited 61%, Q+DNP 38%, Out/Doubtful ~0%). But down-weighting the lineup by proj x P(active)
(`scripts/inseason-backtest-playprob.mjs`) recovers only 0.09 of the 1.79 pts/wk gap (5%, sign-unstable).
Same lesson as #7: a PROBABILITY cannot pinpoint WHICH questionable sits -- a 61%-to-play star is still
EV-optimal to start, and you eat the zero on the unlucky 39%; only the game-day RESOLUTION helps. So the
gap is a resolved-fact problem, and the fix is **B2, a game-day inactive feed** (ingest the ~90-min OUT
list into player_status before lock -- ESPN app-bridge/Sleeper gameday; Part A shows perfect availability
recovers the full 1.79). B1 stays a valid reusable "play-risk" flag, just not the lineup fix.

**B2 (game-day inactive feed) BUILT.** `src/data/gamedayStatus.ts` (`ff refresh-gameday-status`) pulls
ESPN's public per-game `injuries` block (Out/Doubtful/Questionable, updated near kickoff), crosswalks
`athlete.id` -> player_sk via player_xref('espn') (~100% of fantasy-relevant players; the ~19% misses are
linemen), into `raw_gameday_status`. `loadAvailability` (copilotStore.ts) now escalates a game-day OUT to
a bench, keyed by nameKey -- 19 late-scratch players benched for the current week in a live run. This is
the operational closer for #11: run it near lineup lock to catch the ~90-min OUT list the Friday/Sleeper
snapshot misses. Its value is Part A's 1.79-pt ceiling (proven); it needs no separate backtest, just the
pre-lock refresh.

### 12. The MDP / sequential frontier -- myopic is near-optimal for THIS league [explored]
Prior art (recon) treats season-long fantasy as a Markov decision process (FPL solved as a belief-state
MDP + Bayesian Q-learning), planning a SEQUENCE of moves. Our system is myopic -- every verb scores one
move vs the current roster. Explored whether the sequential view adds value here; it does not, because
every sequential effect is measured-low:
- FAAB budget pacing: bid effect not separable from zero (uncontested deep-league waivers, #6/faab).
- Playoff timing/stashing: playoff-SOS refuted under the sim scorer (#8).
- Bench/roster sequencing: low-leverage (#7, insurance/handcuff/bench nulls).
- The one real edge, TRADES (#10, +5 pts full-RoS), is a REGULAR-SEASON accumulation, not a playoff
  edge: `scripts/mdp-trade-playoff-probe.mjs` scores the same trades on weeks 15-17 only -> -0.06
  (CI [-1.33, 1.20], P 49%). It evaporates in the games that decide the title, so temporal (playoff)
  weighting of trades -- the recon's GA-playoff-biasing lever -- adds nothing.
WHY myopic ~ optimal here but the MDP view pays for FPL: FPL has a hard per-week transfer budget/penalty
(genuine sequential resource management) and is a single global top-percentile contest; our redraft has
no per-week transfer cost, uncontested waivers, and a 16-team H2H sim with NO measured title skill -- the
Markov structure that binds in FPL does not bind here. Conclusion: invest in myopic decisions done well
(trades validated, lineup availability fixed, rookies represented), not in sequential planning.

## Edges that DON'T exist / aren't worth chasing

- A "perfect" aggression setting -- there isn't one (see #5).
- Beating the market with the SAME projection everyone uses -- collapses to just the discipline edge.
- **Automated waiver churn in a deep league** -- negative-EV (see #6); keep it a recommendation copilot.
- Out of scope for a draft agent: **trades**, a future copilot surface.

## Where to invest (in priority order)
1. **Build ONE sharp, independent projection layer** -- it powers BOTH the draft (season -> values,
   ~+12-19 pts) AND in-season lineups (weekly, ~+5-7 marginal pts). Highest leverage, serves everything.
2. **In-season lineup automation** on top of it -- never miss a lineup/bye, start the weekly-best.
   (Absolute value is huge; marginal value scales with how much sharper our weekly projection is.)
3. **Wire live inflation + smarter nomination** into the draft bidder -- medium edges we've scaffolded.
4. **Do NOT keep tuning the aggression dial** -- proven neutral.
5. Waiver/trade automation (also fed by the same ROS projection) -- the next in-season surface.
