# In-Season Management -- Design (Phase 3)

The backtest proves in-season management is a top edge, and it is the SAME edge as the draft:
sharper projections. So the design centers on ONE **projection layer** feeding both.

---

## AS BUILT: the copilot (2026-09-08)

Most of this document is a plan. This section is what exists, so a reader does not go looking for the
plan and find the code, or the other way round.

**`src/inseason/copilot.ts` -- the nine in-season decisions as pure functions over one `SimContext`.**
Season odds, weekly lineup, waivers, trade check, trade finder, handcuffs, depth risk, power
rankings, playoff SOS. Each takes a context plus plain arguments and returns structured JSON; none of
them opens a file or a database, which is what makes the whole surface testable on a fixture with no
store, no app and no league (`test/copilot.test.ts`, 33 tests).

**Why it exists, and it is not tidiness.** Fifteen scripts under `scripts/` already answered these
questions, and every one was a PROGRAM rather than a function: it opened its own store, printed a
table and exited. Nothing could call them. So the desktop Assistant -- whose entire purpose is agent
control of the team on the user's behalf -- could not reach a single one of those answers, and the
MCP surface it does reach was still entirely a DRAFT surface months after the draft ended. The
scripts also cost real accuracy: six of them hand-built the same sim context, three on the REAL
schedule and three on a GENERATED one, and the same roster returned a base title probability of
4.17%, 4.56% or 5.1% depending on which tool you asked. `loadSimContext` fixed the context; this
fixes the callers.

**Three properties the module is built around:**

1. **ONE UNIT OF MEASURE.** Every recommendation that can be is scored as a change in OUR
   championship probability, under common random numbers, with the run's own noise floor stated
   beside the ranking. Where a title delta is not the honest unit -- a weekly lineup, a playoff
   schedule -- the result says so in `assumptions.basis` rather than dressing a lineup quantity up as
   a probability.
2. **ASSUMPTIONS TRAVEL WITH THE NUMBER.** `{schedule, basis, trials, seeds, artifact, asOf}` is on
   every result. An LLM handed a bare "6.5%" quotes it as a fact; handed it with its caveats attached
   it cannot. The tool descriptions repeat it in prose and the one-line summary ends with the caveat
   sentence, because a field is only a caveat if the reader knows to look.
3. **REFUSALS ARE NAMED.** `seasonOdds` refuses a table that breaks a conservation law.
   `lineupRecommend` refuses a lineup starting a man on a bye or ruled OUT -- checked against the
   SOURCE, which is the only version a disconnected availability pipeline cannot satisfy.
   `waiverTargets` refuses a drop that leaves a mandatory slot unfillable and names it, because
   simulating an empty slot overstates the cost of a move nobody would make that way.

**`src/inseason/copilotStore.ts`** is the read-only loading the pure functions refuse to do for
themselves: the availability map (`player_status` AND high-severity injury news, because they refresh
on different cycles and the stale one is not always the same), the depth chart, consensus values, the
posted lines, the data stamp. Everything opens `{readonly: true}`.

**`src/inseason/copilotActions.ts`** is the single dispatcher `ff copilot <verb>` and the nine MCP
tools both go through, so a number a terminal prints and a number the Assistant quotes are the same
computation. It is also where the D3 write lives.

### The action log covers ADVICE, not just actions (D3)

This phase makes NO ESPN writes -- no lineup submitted, no claim filed, no offer sent. The instinct
is that there is therefore nothing to log. That is exactly backwards: what the Assistant does here is
give advice, and advice a human acts on is still the agent driving the team. So every recommendation
writes an `action_log` row -- verb, arguments, summary -- at status `recommended`, BEFORE the answer
is returned; a call that throws leaves the row at `failed`. When the write tools arrive, an ESPN move
will sit in the same log directly beneath the recommendation that produced it, which is the record
you actually want when something goes wrong.

The write is in the dispatcher rather than in each tool for D7's reason: a caller cannot forget to
log if there is no path to the answer that skips logging. `test/copilot-actions.test.ts` fault-injects
that -- a call that reaches the same work directly must leave the log empty.

### What it is NOT, and what is still missing

- **No ESPN writes, and no stubs for them.** A stub named `set_lineup` on the tool surface would read
  to a model as a capability.
- **`lineupRecommend` divides the season projection by 17.** It ranks a roster correctly; it has no
  matchup, form or weather in it. The weekly projection model is a separate track, and quoting this
  as though it were that model is the mistake the header note exists to prevent.
- **The store cannot tell you what week it is.** There are no kickoff dates in `game` and `matchup` is
  empty until something fetches the live league, so `currentWeek()` returns the week WITH ITS SOURCE
  and says `default` when nobody knew. Guessing from the wall clock would be a hardcoded NFL calendar
  wearing a derivation's clothes -- the same defect as the hardcoded `playoffTeams: 7`.
- **FAAB guidance is a stated rule of thumb**, not a fitted value: there is no historical bid data in
  this repo to fit it on, so the rule travels with the number.
- **Per-owner targeting is still not trustworthy** (CLAUDE.md): manager profiles have no
  out-of-sample signal, so nothing here tries to model what a specific opponent will accept. The
  trade finder gates on consensus VALUE, which is a market fact, not a psychological model.

---

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
- **RSS headlines** (ESPN, Yahoo, CBS, PFT/NBC, RotoWire, Yardbarker) tagged to the players they name
  by whole-name match -> `category=headline`.
- **Sleeper trending** adds/drops (cross-league buzz, via the `load_ff_playerids` sleeper_id
  crosswalk) -> `category=trending`.
Add a source by appending rows; consumers don't change. Dead feeds (NFL.com, Bleacher Report,
FantasyPros) were probed and dropped.

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

Interface (all name-keyed, half-PPR, our league settings):
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
