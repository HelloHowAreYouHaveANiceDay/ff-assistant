# In-Season Management -- Design (Phase 3)

The backtest proves in-season management is a top edge, and it is the SAME edge as the draft:
sharper projections. So the design centers on ONE **projection layer** feeding both.

## The shared projection layer (the spine)

One module produces OUR projections at three horizons, independent of ESPN/consensus (the edge is
NOT sharing the room's numbers -- docs/edges.md):

| Horizon | Used by | Source path |
|---|---|---|
| **Season** (preseason) | draft values (`ff values`) | FantasyPros redraft ranks -> points curve (have it); upgrade: ffanalytics multi-source |
| **Weekly** | in-season lineups | per-week projections, refreshed each week (matchups, injuries, role) |
| **Rest-of-season (ROS)** | waivers, trades, keep/cut | rolling projection of remaining weeks |

Interface (all name-keyed, No-PPR, our league settings):
`projSeason(): Map<name, pts>` | `projWeek(week): Map<name, pts>` | `projROS(fromWeek): Map<name, pts>`.
Same normalization/name-matching as the draft (ESPN names; dynastyprocess crosswalk if needed).

**Source options** (pick by effort/quality): (a) ESPN's own weekly projections read COPRESENT from
the live app -- zero new deps but it's the consensus (no edge); (b) FantasyPros weekly/ROS
(key/scrape); (c) ffanalytics multi-source consensus (an independent edge). Prefer (b)/(c) for the
edge; (a) as a fallback. The layer hides the source behind the interface.

## In-season consumers (all copresent, all backtestable)

### 1. Weekly lineup optimizer (build first -- biggest, simplest)
Each game week: read the live roster (copresent, like the draft), get `projWeek(week)`, set the best
legal lineup (bench players on bye/OUT, start the weekly-best), and submit via the ESPN UI. Run on a
schedule before each week's lock; notify what changed and why (the action-log pattern, D3).
Validated already by `ff backtest --our-weekly-noise` (~+5-7 marginal championship pts).

### 2. Waiver / FAAB (next)
Weekly: from `projROS`, rank available free agents by ROS value over our droppable bench; size a FAAB
bid; submit the claim (copresent). The `ff waiver`/spec scaffolding exists.

### 3. Trade evaluation (later)
Value both sides by `projROS` (+ roster-need weighting); flag +EV offers. Copilot-first (propose,
human confirms) before any auto-send.

## Reuse of what we built
- **Copresent browser + bro session + robust port** -> read roster / set lineup / submit claims.
- **Engine/Strategy seam + action-log + budget governor + notify** -> same operating model, weekly.
- **Backtest harness** -> already simulates weekly lineups; extend to waiver churn to validate #2.

## What can be built/verified NOW vs after kickoff
- NOW (offline): the projection layer's weekly/ROS builders + backtest of lineup & waiver value.
- AFTER the season starts (live): reading the live weekly roster, setting/submitting lineups, waivers
  -- these need real in-season games and can only be smoke-tested then (like the real draft room, G1).

## Operating model (unchanged from draft)
Configure-then-run per week, full-auto with copresent override + an action log; a token-budget
governor; desktop notifications of every lineup/waiver move and why.

## Priority
1. Shared projection layer (weekly + ROS), independent source. 2. Weekly lineup optimizer + backtest
of waiver value. 3. Waiver/FAAB automation. 4. Trade copilot. Draft-bidder inflation/nomination
(docs/edges 3) can proceed in parallel since it reuses the same projection layer.
