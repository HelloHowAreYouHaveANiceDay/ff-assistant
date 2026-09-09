# BYO agent: driving ff-assistant from Claude Code (stdio MCP)

The desktop app has a built-in copilot (Claude Agent SDK, `ff agent-ask`). `ff mcp` exposes **the
same control surface** over stdio MCP so you can drive the draft from Claude Code -- or any other
MCP client -- instead of the in-app chat.

## Why this is the same surface, not a copy of it

`boardServer()` in `src/agent/agent.ts` builds a real `McpServer` (from
`@modelcontextprotocol/sdk`) out of `buildTools()`. The in-app copilot hands **that instance** to
the Agent SDK in-process; `src/agent/mcp-stdio.ts` connects **that same instance** to a stdio
transport. There is no second tool list, so the two surfaces cannot drift apart: add a tool to
`buildTools()` and both get it.

Two guards keep it that way (`test/mcp-surface.test.ts`):
- the server's actual registry must equal `TOOL_NAMES` (catches a duplicate name silently
  overwriting a registration -- verified by fault injection: 15 advertised, 14 registered);
- the copilot's `allowedTools` is *derived* from `TOOL_NAMES`, never retyped, so a tool added later
  cannot be silently un-offered.

## Setup

The app must be **running** for the browser/league tools (`navigate`, `read_page`,
`discover_leagues`, `league_sync`, `read_league`) -- they drive the app's own logged-in ESPN
webview over CDP (`FF_CDP_PORT`, default 9223). The board/roster/lever tools read SQLite directly
and work with the app closed.

Register the server with Claude Code, from anywhere:

```
claude mcp add ff-draft -- npx tsx H:/working/ff-assistant/src/ff.ts mcp
```

Or commit it per-project in `.mcp.json` (an example lives at `.mcp.json.example`):

```json
{
  "mcpServers": {
    "ff-draft": {
      "command": "npx",
      "args": ["tsx", "src/ff.ts", "mcp"],
      "cwd": "H:/working/ff-assistant"
    }
  }
}
```

Options: `--db <path>` (defaults to `data/ff.db`), `--season <year>` (defaults to the current year).

Verify without a client -- this spawns the server, speaks JSON-RPC, lists the tools, and actually
CALLS one (listing proves registration, not execution):

```
node scripts/mcp-smoke.mjs              # -> MCP STDIO SMOKE PASSED       (draft surface)
node --import tsx scripts/copilot-mcp-smoke.mjs   # -> COPILOT MCP SMOKE PASSED  (in-season surface)
```

The second one exists because the copilot tools are a different animal from `read_board`: each
builds a full sim context and runs a Monte Carlo, so "the server lists ten new tools" says nothing
about whether any of them can execute. Its verb list is now IMPORTED from the dispatcher rather than
retyped: it was a hand-written list of nine, and a hand-written list stops covering the surface the
moment a tenth verb lands, while continuing to pass. It calls `season_odds` for real and then asserts the two
things the descriptions promise -- that the answer carries its `assumptions` block, and that the
call left a row in `action_log`.

## The tools (35)

| Tool | What it does | Writes? |
|---|---|---|
| `read_board` | top available players by OUR auction $ value, optional position filter | no |
| `player_detail` | one player: value, ECR/ESPN ranks, ADP, market value, usage, injury, Vegas total | no |
| `read_my_team` | my current roster | no |
| `read_needs` | open roster slots + max legal bid | no |
| `read_actions` | the action log (what the agent has done) | no |
| `read_levers` | every strategy knob with its range | no |
| `draft_player` | add a player to my roster at a price | **yes** (logged) |
| `drop_player` | remove a player from my roster | **yes** (logged) |
| `set_price` | change a roster entry's price | **yes** (logged) |
| `set_lever` | tune one strategy knob (clamped, logged) | **yes** (logged) |
| `navigate` | point the app's embedded ESPN browser at a URL | app state |
| `read_page` | read the visible text of the embedded page | no |
| `click_page` | click an element by visible text or CSS selector; follows popups the webview blocks | app state |
| `discover_leagues` | find my real leagues/teams by reading my ESPN home | writes store |
| `league_sync` | read real league rules (size, scoring, slots, my team) into the store | writes store |
| `read_league` | live roster, standings, draft status | no |
| `fill_page` | type into an input (React-safe native setter) | page |
| `scroll_page` | scroll the page or a scrollable element; wheel-event aware | page |
| `read_dom` | structured elements (tag/text/class/disabled/href), not flat text | no |
| `wait_for` | poll until text or a selector appears | no |
| `read_block` | live auction: player, offer, your legal max, canBid | no |
| `read_turn` | is it OUR nomination turn | no |
| `read_draft_roster` | your roster AS ESPN SEES IT in the live room | no |
| `place_bid` | **places a REAL bid** (quick bid, or a guarded jump bid) | **LIVE $** |
| `nominate_player` | nominate a player in the live room | **LIVE** |
| `season_odds` | playoff + title odds for all sixteen teams, ours flagged, with conservation checks AND the current objective regime | no |
| `lineup_recommend` | this week's best legal lineup + who cannot play and why. It maximises EXPECTED POINTS, which is the right objective only when the game is close -- an underdog wants variance and a favourite wants the floor. A second objective that maximises P(beating this week's opponent) exists behind `lineupRecommend`'s `objective` argument and is NOT reachable from this tool, deliberately: it measured -0.59pp of team-weeks won over 2018-2025 (docs/validation.md, Track H) | no |
| `waiver_targets` | each add+drop scored by the change in OUR PLAYOFF probability, with playoff-week points and title delta beside it, plus FAAB guidance | no |
| `trade_check` | one named offer scored from BOTH sides | no |
| `trade_finder` | one-for-ones balanced on consensus value, ranked by the PLAYOFF delta | no |
| `handcuffs` | what each backup scores if the man ahead of him misses | no |
| `depth_risk` | what losing one player costs, and who insures him | no |
| `power_rankings` | the league by best starting lineup, with each team's odds beside it | no |
| `playoff_sos` | weeks 15-17 opponent strength, solved from the posted lines | no |
| `stream_recommend` | whom to START or ADD at ONE position this week, out of my men AND the free pool, in POINTS -- with p10/p90, P(zero) where the serving model publishes one, and the artifact that served each position | no |

### The in-season tools (the copilot surface)

Ten READ-ONLY verbs over ONE sim context (`src/inseason/copilot.ts`), reached through ONE dispatcher
(`src/inseason/copilotActions.ts`) that `ff copilot <verb>` also uses. That single path is the point:
six scripts used to hand-build the same context, three on the real schedule and three on a generated
one, and the same roster returned a base title probability of 4.17%, 4.56% or 5.1% depending on which
tool you asked. A terminal and the Assistant now cannot disagree, because there is one place the
number is computed.

**ONE UNIT OF MEASURE, AND IT CHANGED IN PHASE 3 (2026-09-09).** Everything that can be is scored
under common random numbers, with the run's own noise floor returned beside the ranking. Points
cannot see a mandatory slot going empty, cannot see that this league pays on a 7-of-16 threshold and
then top-heavy, and cannot see that a sixth receiver on a roster with five effective receiving slots
is worth approximately nothing.

The unit used to be OUR CHAMPIONSHIP PROBABILITY. It is now **the change in P(PLAYOFFS)**, because
that is the factor the simulator was measured to know something about: scored against 114 real
team-seasons it beats a uniform baseline on the playoff berth (Brier 0.2370 vs 0.2451) and loses to
it on the champion (0.0659 vs 0.0652). Every scored row carries `playoffsPp` (primary),
`playoffWeekPts` (expected optimal-lineup points in weeks 15-17) and `titlePp` (reported alongside,
never used alone), plus `rankValue` -- whichever the active regime ranks on. Above a 70% playoff
probability, derived from the calibration reliability table, the primary becomes playoff-week
strength; `season_odds` returns the regime and the threshold. Every result carries an `objective`
block naming all of it, and the caveat sentence each summary ends with names the primary quantity, so
an Assistant cannot quote a delta without saying what it is a delta IN.

**EVERY ANSWER CARRIES ITS ASSUMPTIONS.** Every result has an `assumptions` block:

| field | what it tells you |
|---|---|
| `schedule` | `real` (the league's actual matchups; needs the app) or `generated` (deterministic, offline, and NOT this league's playoff seeding) |
| `basis` | `simulation` (a Monte Carlo probability), `projection` (a points quantity, no simulation), or `market` (solved from posted betting lines) |
| `trials`, `seeds` | how much simulation is behind it; `null` when the basis is not a simulation |
| `artifact` | the data stamp: season, board rows, seasons the variance model was fitted on, sampler, projection artifact |
| `asOf` | when it was computed |

This is not decoration. A model handed a bare "6.5%" will quote it as a fact; handed the number with
its caveats attached it cannot. The tool descriptions say the same thing again in prose, and the
one-line summary each tool returns ahead of the JSON ends with the caveat sentence -- so a model that
reads only the first line still cannot quote the headline number naked.

**REFUSALS ARE NAMED, NOT SILENT.** `season_odds` refuses to return a table that breaks a
conservation law (one win per game played, `playoffTeams` berths, exactly one champion).
`lineup_recommend` refuses a lineup that starts a man on a bye or ruled OUT -- checked against the
SOURCE rather than the flags the optimizer was handed, which is the only version a disconnected
availability pipeline cannot satisfy. `waiver_targets` refuses a drop that would leave a mandatory
slot unfillable and says which, rather than simulating an empty slot nobody would ever field.

**THE ACTION LOG COVERS ADVICE (D3).** No ESPN write exists in this phase, and the instinct is
therefore that there is nothing to log. That is backwards: what the Assistant DOES here is give
advice, and advice a human acts on is still the agent driving the team. So every call writes an
`action_log` row -- verb, arguments, and the summary -- at status `recommended`, BEFORE the answer is
returned, and a call that throws leaves the row at `failed`. When the write tools arrive, an ESPN
move will sit in the same log directly beneath the recommendation that produced it. The write lives
in the dispatcher rather than in each tool for the D7 reason: a caller cannot forget to log if there
is no path to the answer that skips logging.

**WHERE THESE ARE WEAK, in the tool descriptions and worth repeating:**
- the PLAYOFF number is more trustworthy than the TITLE number, and this is now MEASURED rather than
  argued from the shape of the format: over 114 real team-seasons the simulator beats a uniform
  baseline on the berth and is WORSE THAN UNIFORM on the champion. Lead with the playoff figure;
  quote the title figure as context, never as the reason for a decision;
- `lineup_recommend` runs the weekly projector, but the SHIPPED weekly artifact is the
  season-line-only floor, whose projection IS the season line per game. So the numbers are still the
  season projection spread flat: it ranks a roster correctly and has no matchup, form or weather in
  it. Read `assumptions.basis` -- `weekly-model` means every player came from the projector,
  `projection` means at least one fell back, and `assumptions.basisNote` names who;
- `lineup_recommend` returns `weekSource`. It now usually reads `schedule`, derived from
  `raw_nfl_game` kickoff dates on the LOCAL calendar; `default` means the store has no schedule for
  the season and nobody knew, in which case pass `week` explicitly;
- the FAAB figure is a STATED RULE OF THUMB (10% of budget per +1pp of PLAYOFF probability, capped
  at 50%), not a fitted value -- nothing in this repo has measured what a point of playoff
  probability is worth in FAAB dollars. The rule is unchanged from Phase 2c; the quantity it is
  applied to is now the one the simulator can predict, and the rule's own text says so;
- `power_rankings` ranks teams by the same board we bid from, so it is not an independent grade of
  our own roster. Read the spread between teams, not the absolutes;
- `playoff_sos`'s `costPerWeek` is under a point a week for a typical starter. It breaks ties; it
  does not overturn a projection gap. Check `pricedPlayoffGames` -- early in the season most
  playoff-week games have no posted line yet.

**Verified against the live league (2026-09-08, read-only, through the app bridge.)** All five
read-only verbs run end to end on the real sixteen rosters and the REAL schedule; `season_odds`
returns 49.4% playoffs / 7.1% title for us against a 6.25% random baseline, and every conservation
law holds on the real data as well as on the fixture.

```
node --import tsx scripts/copilot-crosscheck.mjs --schedule real --week 1
```

That script exists because a fixture cannot tell you the REAL bye column arrived populated or that
the REAL injury table joins on the key the optimizer looks up. Two of its checks are POSITIVE
CONTROLS -- "no starter is ruled OUT" passes vacuously if the availability map is empty, so it also
asserts the store carries OUT designations at all (21 of 93 rows) and that our roster is unavailable
somewhere across weeks 1-18 (7 of 18). And the OUT check is fault-injected in place: the same
predicate is handed a lineup containing a man the store rules out, and must flag him.

The eleven scripts these absorbed (`scripts/season-odds.mjs`, `trade-odds.mjs`, `trade-check.mjs`,
`trade-finder.mjs`, `win-win.mjs`, `waiver-check.mjs`, `waiver-targets.mjs`, `depth-risk.mjs`,
`power-rankings.mjs`, `playoff-sos.mjs`, `season-odds-spread.mjs`) are stamped DEPRECATED and kept,
because `docs/validation.md` and `docs/edges.md` cite numbers they produced.

### The live-draft tools

They delegate to `src/draft/espnAuction.ts` through the webview Page shim -- the same live-verified
reader/actor `ff auto-draft --app` uses. Nothing is reimplemented, so there is no second copy to
drift.

`place_bid` carries three guards, each verified live in a practice auction:

| guard | behaviour |
|---|---|
| nothing on the block / cannot bid | refuses with the reason |
| jump bid without `confirm: true` | refuses (a quick +1 bid needs no confirm) |
| jump bid below the current offer | refuses |
| **jump bid above your budget** | **clamped to ESPN's legal max** -- `$9999` became `$189` |

**Decision note (extends D10):** the deterministic `auto-draft` loop is unchanged and remains how the
draft is actually run. These add a manual/agent-driven path BESIDE it. No LLM sits inside the bid
loop; an agent using `place_bid` is a human-equivalent operator, not part of the engine.

### QA (2026-09-05, live practice auctions)

All nine new tools exercised end-to-end through the stdio surface, not in-process: `wait_for` proven
in BOTH directions (timeout on the impossible, `found` on the real), `fill_page` accepted by a
React-controlled field, `nominate_player` put a real player on the block, `place_bid` placed a real
bid and every guard fired. `auto-draft --app` re-verified afterwards in a clean room -- unchanged,
`cap=50` / `soft168` confirming maxShare 0.25 and starterReserve 4.

**`scroll_page` failed its first live test and was fixed:** ESPN's board is a virtualised
`fixed-data-table` that consumes WHEEL events, so assigning `scrollTop` did nothing (it stayed 0).
It now walks to a scrollable ancestor AND dispatches a real wheel event. Verified by CONTENT, not by
return value -- the top board row changed and rendered rows went 30 -> 54.

Every mutation goes through the same `action_log` the in-app copilot uses, so the two agents share
one audit trail. Writing to ESPN itself (lineups, waivers, trades) is **not** exposed -- reads only.

## Notes

- **stdout is the protocol.** `serveMcpStdio` routes `console.log/info/debug/warn` to stderr before
  connecting, because the DB layer and tool handlers log freely and a stray line would corrupt the
  JSON-RPC framing. Keep it that way; log to stderr in any new tool.
- The copilot's system prompt (`SYSTEM` in `agent.ts`) is **not** shipped over MCP -- an external
  agent brings its own. It encodes things worth repeating to yours: `our_value` is our auction
  valuation, and `vsECR`/`vsESPN` are *consensus rank minus ours*, so **positive = we rank them
  earlier than the room = a value**. Getting that sign backwards inverts every recommendation.
- This does not touch the draft bidding path. `ff auto-draft` is unchanged and does not go through
  the agent or MCP.

## Driving the draft engine inside the app: use `--app`

Playwright's `connectOverCDP` does NOT enumerate an Electron `<webview>` as a page (the guest is a
target of type `webview`; `attach()` sees only the `file://` renderer), so **`--port 9223` hands
every draft verb the renderer** -- `read-block --port 9223` returns all nulls and `launch-practice`
would navigate the app's own UI to ESPN.

`--app` fixes that. `src/browser/webviewPage.ts` implements the slice of Playwright's `Page` API the
draft code actually uses on top of the renderer's `webview.executeJavaScript`, so
**`espnAuction.ts` runs unchanged** against the embedded guest -- no parallel reader/actor to drift.

```
npm run ff -- launch-practice --app     # opens an ESPN practice auction IN the app
npm run ff -- read-block --app          # what's on the block right now
npm run ff -- roster --app
npm run ff -- auto-draft --app          # the agent bids, in the app's own logged-in session
node scripts/webview-selftest.mjs       # positive control for the shim (see below)
```

Verified live on 2026-09-04 in a league-specific practice auction: `launch-practice --app` entered
the room, `read-block --app` returned a populated block (player/offer/myMax/canBid), and
`auto-draft --app` passed, nominated and bid against real opponents.

### Shim notes (the two bugs that made it look like it worked when it did not)

- **The locator resolver must RETURN its IIFE's value.** Without the `return`, every locator
  resolved to `undefined` -> `count() === 0`, which is indistinguishable from "no such element" --
  and outside a draft room, where everything legitimately reads null, completely invisible.
  `scripts/webview-selftest.mjs` exists for exactly this: it drives the shim against DOM that is
  known to exist and asserts NON-empty results (174 anchors, the Practice Draft button found,
  `isDisabled()` false, real geometry). A shim that always returns null passes every null test.
- **`page.evaluate` takes expressions OR statements.** `espnAuction` passes expression strings;
  `cmdLaunchPractice` passes statement strings. Wrapping a statement string in `return (...)` is a
  syntax error, which Electron reports only as a locationless "Script failed to execute", so the
  shim classifies the string by compiling it in Node first (`asBody`).
- `page.url()` is **synchronous** in Playwright (`findPage` does `p.url().includes(...)`), so the
  shim serves a cached value refreshed around navigation.

ESPN opens draft rooms via `window.open`, and the app's `setWindowOpenHandler` sends `http(s)`
popups to `shell.openExternal` -- out to the system browser. Both `launch-practice` and the
`click_page` MCP tool patch `window.open` in the guest (and `click_page` also retargets
`_blank` anchors) so the room lands in the webview instead.

The bro path (`attachBro`, no flag) is unchanged and remains available as a fallback.

---

## `stream_recommend` -- the tenth verb, and the only one about a POOL (Track C, 2026-09-09)

Every other in-season verb is about the twelve men we own. `lineup_recommend` sets the best legal
eleven out of them and cannot answer the question a manager actually asks in October: *my defence is
on bye and there are nine defences free -- which one*. That decision is made at ONE position, out of
a pool, and what decides it is almost entirely the matchup.

```
ff copilot stream --pos DST --week 3
ff copilot stream --pos QB  --week 3 --json
```

**The unit is POINTS and the tool says so.** Everything else in the copilot is scored as a change in
P(playoffs), because points cannot see a mandatory slot going empty or a top-heavy roster. A one-week
start/sit at one position has none of those properties: it is a single slot, this Sunday, and the
noise floor of a season simulation would be larger than the effect it was meant to price. So
`assumptions.basis` is `weekly-model`, `trials` is `null`, and the objective block travels with the
regime unknown -- exactly as `lineup_recommend` does -- rather than dressing a points quantity up as
a probability.

**Read `artifactByPos` and quote it.** The streaming gate is applied PER POSITION, so this is the
only tool on the surface where different rows of one answer can come from different models. A
position that passed serves `streaming-artifact.json`; one that did not serves
`weekly-artifact-lineonly.json` -- the same floor the lineup is served from, which has no matchup, no
form and no weather in it. A reader who cannot tell which would read a floor projection as a
matchup-aware one, and there is no way to infer it from the number.

What it returns: our men and the streamable pool ranked by the weekly projection with p10/p90 and,
where the serving artifact publishes one, P(he scores nothing); the start and the sits with reasons;
and the add/drop with the change in expected points **this week**. A man on ANOTHER roster is never
in the pool -- he cannot be claimed, and recommending him is advice nobody can act on. Drops that
leave a mandatory slot unfillable are REFUSED through the same `rosterGaps` check `waiver_targets`
uses, and named rather than silently skipped.

A position with no feature rows returns empty lists and says so in `assumptions.basisNote`. "We
cannot answer" and "do nothing" are different answers and are not allowed to look the same.

## The lineup objective, and why the tool surface only offers one (Track H, 2026-09-09)

`lineup_recommend` answers "the best legal lineup" by maximising the sum of projected points. That
is the right objective only when the game is close. A fantasy week is head-to-head, and a point
scored past the opponent's total is worth nothing, so a team trailing on projection should buy
variance and a team leading should buy floor.

That second objective is built (`src/inseason/winprob.ts`, reached as
`lineupRecommend(ctx, week, { objective: "winprob" })`) and it is deliberately NOT exposed as an MCP
tool or as a second verb. The replay decided it: over 1,876 team-weeks of this league's real
matchups, 2018-2025, scored against the opponent's actual points, it won **0.59 percentage points
FEWER** team-weeks than the expected-points lineup (95% CI [-1.34, +0.05], season-level bootstrap).
Pre-registered P51 and P57 both failed; P58 held. `docs/validation.md` has the tables.

A tool an LLM can call is a capability it will use. Exposing an objective that measures as a
regression, with the caveat living in prose the model may not read, is exactly the failure mode this
file exists to avoid -- so the caveat is the absence of the tool. `scripts/winprob-lineup.mjs` prints
both lineups side by side for a human who wants the second opinion, and writes the same `action_log`
row before returning.

Revisit the day a weekly artifact passes its coverage gate (`docs/weekly.md`). The diagnostic says
the objective is being taken under the wrong distribution, not that the objective is wrong: the
search claimed +0.50pp under its own sampler and delivered -0.59pp.
