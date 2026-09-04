# What edges are actually possible (and which we've measured)

All championship numbers are from the multi-season backtest (`ff backtest --seasons 2014-2024`,
docs/validation.md); random baseline = 6.3% (1 of 16). Directions are robust; absolute magnitudes
depend on the bot model, so weigh them as "big / medium / none", not to the decimal.

> **Curve note (2026-09-03):** the percentages on this page were measured under the OLD even-split
> FLEX baseline. The value curve has since changed (points-weighted FLEX allocation), which moved
> the full-system no-lookahead headline from 13.6% to **24.4%** championships -- see "Weighted FLEX
> baselines" in docs/validation.md. The RANKING of the edges below is unaffected (the fix is itself
> an instance of edge #2: a better independent value table); the absolute numbers are stale.

### 0. Get the value curve itself right -- BIG, proven [13.6% -> 24.4%]
Before any strategy dial: the bid table must price positions the way the format actually consumes
them. Splitting FLEX slots evenly across RB/WR/TE instead of allocating them by projected points
gave TE 11 phantom starting slots and cost ~11 championship points. This dwarfed every config
lever we had tuned, and no test caught it because the sim's bot book shared the same function.
Lesson: an artifact BOTH sides of a comparison are computed from cannot be validated by that
comparison.

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

### 5. Roster construction / aggression dial -- BALANCED WINS (corrected Step 5, 2026-09-02)
The earlier "NONE across seasons (~27-28%)" was the OLD uniform bot on the wrong 16-slot roster and
did not hold. On the realistic per-manager field + the real 12-slot roster + the multi-season value
curve, championship rises with the per-starter reserve to a plateau at reserve 15-20 (~24%) and
collapses at 25 (over-reserved). New default: **reserve 15 / max-share 0.35** (~24%, the 12-20 plateau; 15 over 20 for live robustness) vs the old
aggressive-lean 5/0.6 (15.7%) -- a ~8.5-pt swing, measured against the realistic field on the
12-slot roster; the earlier neutrality was the uniform bot. Full table: docs/validation.md.

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
  to drain them (`src/draft/nomination.ts`, cheat sheet in docs/league-managers.md). **Built AND
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
