# MVP: Draft-Day Auction Agent

> **STATUS: MVP ACHIEVED (2026-09-01).** The agent drafts a complete, legal, in-budget roster
> fully autonomously. Done-bar met: **3 consecutive practice auctions completed 12/12** legal
> rosters, 0 unfilled slots, verified from the roster panel -- $168, $200 (fresh, pick-1-to-done),
> $200 (fresh). Legality guard proven by fault injection + strategy seam proven (`npm test`, 9/9).
> `ff launch-practice` (agent self-launches) + `ff auto-draft` (full-auto Engine) + `strategy.ts`
> (pluggable Strategy) + `espnAuction.ts` (verified reader/actor).
>
> **What the MVP is NOT (the next investment): roster QUALITY.** The v1 fill strategy (bid
> value+premium, paced per-slot, ESPN-reserve backstop) reliably COMPLETES a legal roster but
> spends unevenly (variance in which studs it wins) -- balanced valuation/targeting/nomination is
> the Strategy layer to build next, behind the same Engine seam. `nominate()` also still TODO
> (bots + ESPN auto-nominate suffice to fill today).


Scope: a copresent agent that drafts a **complete, legal, in-budget roster** in the user's
16-team $200 salary-cap ESPN auction, fully autonomously, per a strategy set with the user
beforehand. Weekly lineup/waivers/copilot are out of scope for this MVP.

## Operating model (decided 2026-08-31)

- **Configure-then-run.** Before draft day, the user + agent set the STRATEGY (values, budget
  plan, targets/avoids). On draft day the agent runs **full-auto** against that strategy.
- **Copresent override (D0).** The user can watch and take the wheel at any moment; the agent
  yields when the human acts and resumes after.
- **Done bar:** in a practice auction, the agent finishes with a **complete, position-legal
  16-man roster, never overspending, no unfilled slots**, verified from the real roster panel.

## The load-bearing seam: Engine vs Strategy

```
              +------------------ Draft Engine (strategy-agnostic) ------------------+
  ESPN room   |  read: block, offer, clock, my budget, my roster, board, budgets     |
   (DOM,  <-->|  time: clock-aware bid placement (final-second)                       |
  copresent)  |  act:  quickBid / jumpBid / nominate / pass                           |
              |  ENFORCE hard legality (budget reserve, roster slots) -- always       |
              +---------------------------------+-----------------------------------+
                                                | DraftState  ->  Decision
                                                v
              +------------------ Strategy (pluggable; heavy future invest) ---------+
              |  value(player, state) -> $      whatWeThinkHeIsWorth                  |
              |  maxBid(player, state) -> $     ceiling for THIS player now (0=skip)  |
              |  nominate(state) -> player      whom to put up on our turn           |
              +---------------------------------------------------------------------+
```

The **Engine owns auction mechanics + safety**; the **Strategy owns judgment**. The Engine never
lets a Strategy violate legality: `effectiveMax = min(strategy.maxBid, affordableMax, domMax)`.

### DraftState (Engine -> Strategy, each decision)
- `myBudget`, `mySlots` (remaining by position: QB/RB/WR/TE/FLEX/K/DST/BENCH), `myRoster[]`
- `onBlock`: `{ name, pos, team, espnPreDraftVal }`
- `currentOffer`, `secondsLeft`, `iAmHighBidder`
- `board[]`: available players `{ name, pos, team, espnPreDraftVal }` (for nomination)
- `teams[]`: `{ name, budgetLeft }` (opponent budgets; optional for v1)

### Decision (Strategy -> Engine)
- For bidding: `maxBid` (dollars) for the on-block player. Engine bids up to
  `min(maxBid, affordableMax, domMax)`, placed clock-aware.
- For nomination: a `player` from the board (+ optional opening price).

### Hard legality (Engine, non-negotiable -- this is what guarantees the done-bar)
- `affordableMax = myBudget - (unfilledSlotsRemaining_afterThisPlayer * $1)` -- always reserve
  $1 per still-empty slot so a legal roster is always completable.
- Never bid on a player whose position has no open slot (incl. FLEX/BENCH eligibility).
- Never exceed `domMax` (ESPN's "Manual offer (max $X)").
- Stop bidding the moment any of the above binds, regardless of Strategy.

## v1 Strategy (simple but robust; the first plug)

- **Values = our own** (not ESPN's), computed pre-draft: projections -> VOR -> dollar values
  normalized so total value across draftable players ~= total league budget (16 x $200). Seed
  projections from the easiest source (CSV now; live later). Store as `value[player]`.
- **maxBid(player) = value[player]** (never overpay our own value), then Engine clamps to
  affordable/legal.
- **nominate():** v1 = nominate the highest-value player we do NOT want (drain opponents), or if
  none, a $1-2 roster-filler we need. (Robust hook for smarter nomination later.)
- **Config surface** (set with user pre-draft, so full-auto is safe): the value table, a
  targets list (optional max premiums), an avoids list, and roster/reserve rules. Everything the
  Strategy needs is data -> swapping strategies = swapping this config + the value/maxBid/nominate
  functions, nothing in the Engine changes.

## What's proven vs to-build

Proven live (this session): copresent attach via bro; agent self-launches the practice draft
(window.open capture); `readBlock()` (player/offer/myMax/espnPreDraftVal); `quickBid()` as an
action.

To build for the MVP:
1. **Engine reads** still missing: `secondsLeft` (the per-player clock), `myBudget`, `mySlots`,
   real `myRoster` (FIX: `table.Table` is the QUEUE, not the roster -- find the roster panel),
   `board[]`, opponent `budgets`.
2. **Clock-aware bidding** -- place the last legal bid in the final second (the reason v0 won
   nothing: a 2s poll gets sniped at expiry).
3. **nominate()** action -- pick from board + confirm on our nomination turn.
4. **Strategy module** -- the interface above + the v1 plug + a pre-draft config file.
5. **Legality guard** -- the reserve/slot math, with fault-injection tests (set budget low ->
   proves it refuses to overspend; fill a position -> proves it won't bid there).

## Acceptance criteria (MVP done)

- In >=3 consecutive practice auctions, the agent ends with a **full 16-man legal roster**,
  `spent <= $200`, **0 unfilled slots**, verified by reading the roster panel (not the queue).
- The legality guard provably fires: injected low budget -> never strands a slot; filled
  position -> no bid on it. (Fault injection, per the repo's testing floor.)
- Swapping the value table changes bids with **no Engine change** (proves the seam).
- Full-auto run needs no human input after strategy is set; a human bid mid-draft is respected
  (agent yields + resumes).

## Related

`docs/espn-draft-flow.md` (verified selectors + launch), `docs/decisions.md` (D0 copresent, D8
draft-first), `src/draft/espnAuction.ts` (reader/actor), roadmap Phase 2.
