# What edges are actually possible (and which we've measured)

All championship numbers are from the multi-season backtest (`ff backtest --seasons 2014-2024`,
docs/validation.md); random baseline = 6.3% (1 of 16). Directions are robust; absolute magnitudes
depend on the bot model, so weigh them as "big / medium / none", not to the decimal.

## Edges the harness QUANTIFIES (draft edges)

### 1. Discipline vs an overpaying room -- BIG, proven [~27%, 4.4x random]
Your league overpays for studs (recap data: studs $80-106, 61% of picks $1-5). Bidding rational
values and NOT chasing bidding wars wins ~27% of titles even when we share the room's projection.
This is the floor edge and it is large.

### 2. Your OWN projection (independent of the consensus) -- BIG [~27% -> ~39%]
The single most striking result: using a projection INDEPENDENT of the source everyone else uses is
worth ~12 championship points -- even at the SAME accuracy -- because you no longer share the room's
blind spots (you win the players the consensus misprices instead of mispricing them the same way).
Practical meaning: do NOT bid ESPN's / the consensus's values (that's what the room uses); use our
own nflverse-derived values. We already do.

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

### 5. Roster construction / aggression dial -- NONE across seasons
Stars-and-scrubs vs balanced vs moderate all land ~27-28% over 11 seasons (the single-season gaps
wash out). Real within one season, neutral in expectation. **Do not spend effort tuning this** --
keep a sane moderate default and move on.

## Edges that are REAL but the bot-sim can't see (agent vs HUMANS)

The backtest is agent-vs-bots, so these don't show up -- but they are exactly where an always-on
software agent beats distracted humans:

- **Never miss a bid / perfect clock management** -- acts on every nomination, in the final second,
  never gets sniped for lack of attention. (Our jump-bidding does this.)
- **Perfect budget + roster-slot tracking** -- always knows the exact legal max bid and the reserve
  to still fill a legal roster; humans miscount and either strand money or can't fill a slot.
- **No tilt / no reaching** -- doesn't panic-buy in a position run or chase a player above value
  after losing one. Sticks to the plan.
- **Nomination gamesmanship** -- nominate players you don't want (esp. K/DST the room overpays) to
  drain opponents; nominate targets when the room is cash-poor. (Built; a medium edge, not yet
  quantified.)
- **Live inflation tracking** -- recompute values as money/talent leave the board (docs/value-methods
  section 3). Medium; not yet wired into the live bidder.

### 6. Waiver churn (automated) -- NEGATIVE in a deep league [backtested]
Surprising, and the backtest earned its keep: automating waiver pickups by recent production LOSES
titles here (full-system 36% -> ~24-27%). In a 16-team league the free-agent pool is mostly
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
