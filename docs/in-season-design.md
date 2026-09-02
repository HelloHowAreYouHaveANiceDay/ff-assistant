# In-Season Management -- Design (Phase 3)

The backtest proves in-season management is a top edge, and it is the SAME edge as the draft:
sharper projections. So the design centers on ONE **projection layer** feeding both.

## News / data-refresh layer (Phase 3A -- STARTED 2026-09-02)

The "keep the data FRESH" half of Phase 3, built as **two decoupled layers** so the aggregator is
league-setting-NEUTRAL and the league lens sits on top:

**Layer 1 -- general player-news aggregator (`tools/build_player_news.py` -> `data/player-news.csv`).**
A source-agnostic per-player feed (`player,pos,team,category,severity,detail,source,asof`) with NO
league/scoring/roster assumptions. Sources, pluggable:
- nflverse **injuries** (`load_injuries`, week-1 REG = draft-time proxy) -> `category=injury`.
- nflverse **depth charts** (`load_depth_charts`, `pos_rank`) -> `category=role`; `severity` is a
  general fantasy-relevance hint (QB/TE/K backup at depth 2 = medium; RB/WR only concerning at 3+,
  since an RB2/WR2 still starts).
- **RSS headlines** (ESPN, Yahoo) tagged to the players they name -> `category=headline`.
Add a source by appending rows; consumers don't change.

**Layer 2 -- league tailoring (`ff news`).** Joins the feed to OUR `data/values.csv` by `nameKey`
and renders the DRAFTABLE players whose news the rank may not price: AVOID (injury high) / WATCH
(injury medium) / BURIED (concerning role) flags plus their live headlines, strongest first. The
classifier is pure + tested (`src/news.ts`, `classifyNews(category, severity)`) -- it tailors on the
league-neutral signal, so Layer 1 can add sources without touching it. `--no-headlines` for flags only.

- **Read-only today** -- it does NOT change values. Next: (a) fold an availability discount into
  `values` behind a flag (zero an OUT-for-season player, discount Questionable); (b) extend Layer 1
  to the WEEKLY horizon (each week's report + matchup) so the in-season lineup optimizer benches
  OUT/bye players from live news, not a season average; (c) sharpen headline->player tagging + drop
  non-fantasy noise.

The rest of this doc is the broader in-season plan the news layer feeds.

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
