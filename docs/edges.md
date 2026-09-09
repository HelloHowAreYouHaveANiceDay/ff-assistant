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
