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

1. **ONE UNIT OF MEASURE, AND IT CHANGED IN PHASE 3 (2026-09-09).** Every recommendation that can be
   is scored under common random numbers, with the run's own noise floor stated beside the ranking.
   The unit used to be OUR CHAMPIONSHIP PROBABILITY. It is now **the change in P(PLAYOFFS)**, with
   expected optimal-lineup points in weeks 15-17 as the secondary and P(title) reported alongside and
   never used alone. Where no delta is the honest unit -- a weekly lineup, a playoff schedule, a
   handcuff's conditional payoff -- the result still says so in `assumptions.basis` rather than
   dressing a points quantity up as a probability.

   **Why, in one paragraph.** P(title) = P(playoffs) x P(title | playoffs). Scored against 114 real
   team-seasons of this league (docs/validation.md, Phase 2c), this simulator BEATS a uniform
   baseline on the playoff berth -- Brier 0.2370 against 0.2451 -- and LOSES to it on the champion,
   0.0659 against 0.0652. Single elimination among seven makes the second factor nearly a coin flip,
   and eight titles in 114 team-seasons is almost no signal to fit against. Every recommendation this
   module made was ranked on the one quantity the model had been measured not to know. Optimising a
   quantity a model cannot predict optimises its noise.

   **THE STATE-DEPENDENT SWITCH.** Above a **70%** simulated playoff probability the primary becomes
   playoff-week strength. The threshold is derived from the calibration reliability table -- the
   first bin whose realised playoff rate exceeds 85% -- and the derivation says out loud that the bin
   holds ONE team-season and that the band below it is the largest miscalibration on the page (58%
   predicted, 41% realised), which is the argument for putting the switch above that band rather than
   inside it. It is exposed on `seasonOdds().objective` (regime, primary, threshold, and a sentence
   of prose) so a reader can disagree with it explicitly. The reason it earns its place: with the seed
   settled every candidate's playoff delta is 0.00pp, so a tool still ranking on that quantity is
   ordering a list of zeroes.

   Every scored row carries `playoffsPp`, `playoffWeekPts` and `titlePp`, plus `rankValue` -- whichever
   of the first two the active regime ranks on -- and all three come from ONE simulation of each
   state, so two of them can never be correlated across different samples. The noise floor is
   computed for the PRIMARY. The FAAB rule of thumb is now priced per point of PLAYOFF probability
   and its own text says the quantity changed.
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
- **`lineupRecommend` goes through the weekly projector, and the artifact behind it is the floor**
  (integration pass 2, 2026-09-08). It calls `projectWeekly` (`src/weekly/projector.ts`) with the
  SHIPPED season-line-only artifact, which projects the season line exactly -- so no number moved
  when the seam landed, by construction. It still has no matchup, form or weather in it, because the
  trained artifact failed its pre-registered coverage band (`docs/weekly.md`). What changed is that
  the day a trained artifact passes, the lineup improves by swapping one file rather than by a
  rewrite. A roster player the projector has no row for falls back to the season line divided by 17
  and `assumptions.basisNote` NAMES him; `basis` is `weekly-model` only when every player came from
  the projector, so a half-weekly, half-flat lineup cannot report itself as one thing.
- **`lineupRecommend` now takes an OBJECTIVE, and its default did not change** (Track H, 2026-09-09).
  `{ objective: "expected" }` -- the default, and what every existing caller and MCP consumer still
  gets -- maximises the sum of projected points over a legal assignment. `{ objective: "winprob" }`
  maximises the probability of beating THIS week's actual opponent instead, which is a different
  lineup at the margins: a point scored past the opponent's total is worth nothing, so an underdog
  wants variance and a favourite wants the floor. `src/inseason/winprob.ts` samples each player's
  published band (p10/p50/p90 and P(zero week)) as a quantile function, couples NFL teammates through
  a Gaussian copula at a MEASURED 1.15x the fitted pairwise correlation, and hill-climbs from the
  expected-points lineup over every legal single-player substitution under common random numbers. It
  REFUSES a generated schedule rather than inventing an opponent, and returns both lineups with the
  P(win) of each so the trade is visible rather than described.

  **It is not the default because the replay says it should not be.** 1,876 team-weeks, 2018-2025,
  scored against the opponent's real points: -0.59pp of team-weeks won under the challenger artifact
  and -0.05pp under the shipped floor (`docs/validation.md`, Track H; P51 and P57 failed, P58 held).
  The diagnostic is that the search CLAIMED +0.50pp under its own sampler and delivered -0.59pp -- it
  is solving its problem correctly against a distribution that is not the real one, because the only
  artifact with any shape in it is the one that failed its coverage gate. Under the floor artifact
  every player's band is the same multiple of his own season line, so there is no relative shape to
  trade and the objective is inert by construction. Revisit the day an artifact PASSES that gate.

  `ff copilot lineup --objective winprob` does not exist yet -- the dispatcher was outside Track H's
  file fence. `scripts/winprob-lineup.mjs` is the caller, reaching the same function through the same
  loaders with the same action-log write.
- **The store CAN now tell you what week it is** (integration pass 2). The data track's
  `raw_nfl_game` carries a `gameday` per game for every season including the live one, so
  `currentWeek()` derives it: week w is current from the day after week w-1's last kickoff through
  week w's last kickoff, and before week 1's first kickoff the current week is 1. It follows the
  real schedule rather than "season start plus seven days", so a flex or an international kickoff
  does not shift it -- a derivation, not the hardcoded NFL calendar the old note was right to fear.
  The comparison is on the LOCAL date: in UTC every evening after 8pm ET lands on the next calendar
  day, and on a week's last kickoff day that hands back the NEXT week. A store with no schedule rows
  still gets the old `default` answer, said out loud.
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
