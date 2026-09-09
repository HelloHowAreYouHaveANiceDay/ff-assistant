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
node scripts/copilot-mcp-smoke.mjs      # -> COPILOT MCP SMOKE PASSED     (in-season surface)
```

The second one exists because the copilot tools are a different animal from `read_board`: each
builds a full sim context and runs a Monte Carlo, so "the server lists nine new tools" says nothing
about whether any of them can execute. It calls `season_odds` for real and then asserts the two
things the descriptions promise -- that the answer carries its `assumptions` block, and that the
call left a row in `action_log`.

## The tools (34)

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
| `season_odds` | playoff + title odds for all sixteen teams, ours flagged, with conservation checks | no |
| `lineup_recommend` | this week's best legal lineup + who cannot play and why | no |
| `waiver_targets` | each add+drop scored by the change in OUR title probability, with FAAB guidance | no |
| `trade_check` | one named offer scored from BOTH sides | no |
| `trade_finder` | one-for-ones balanced on consensus value, ranked by title delta | no |
| `handcuffs` | what each backup scores if the man ahead of him misses | no |
| `depth_risk` | what losing one player costs, and who insures him | no |
| `power_rankings` | the league by best starting lineup, with each team's odds beside it | no |
| `playoff_sos` | weeks 15-17 opponent strength, solved from the posted lines | no |

### The in-season tools (the copilot surface)

Nine READ-ONLY verbs over ONE sim context (`src/inseason/copilot.ts`), reached through ONE dispatcher
(`src/inseason/copilotActions.ts`) that `ff copilot <verb>` also uses. That single path is the point:
six scripts used to hand-build the same context, three on the real schedule and three on a generated
one, and the same roster returned a base title probability of 4.17%, 4.56% or 5.1% depending on which
tool you asked. A terminal and the Assistant now cannot disagree, because there is one place the
number is computed.

**ONE UNIT OF MEASURE.** Everything that can be is scored as a change in OUR championship
probability, under common random numbers, with the run's own noise floor returned beside the ranking.
Points cannot see a mandatory slot going empty, cannot see that this league pays on a 7-of-16
threshold and then top-heavy, and cannot see that a sixth receiver on a roster with five effective
receiving slots is worth approximately nothing.

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
- the PLAYOFF number is more trustworthy than the TITLE number -- a 7-of-16 threshold is far less
  sensitive to tail assumptions than a single-elimination bracket;
- `lineup_recommend` divides the season projection by 17. It ranks a roster correctly and has no
  matchup, form or weather in it; it is not a weekly projection model;
- the store usually cannot tell you what week it is (no kickoff dates in `game`, no rows in
  `matchup`), so `lineup_recommend` returns `weekSource` and says `default` when nobody knew. Pass
  `week` explicitly;
- the FAAB figure is a STATED RULE OF THUMB (10% of budget per +1pp of title probability, capped at
  50%), not a fitted value -- nothing in this repo has measured what a point of title probability is
  worth in FAAB dollars;
- `power_rankings` ranks teams by the same board we bid from, so it is not an independent grade of
  our own roster. Read the spread between teams, not the absolutes;
- `playoff_sos`'s `costPerWeek` is under a point a week for a typical starter. It breaks ties; it
  does not overturn a projection gap. Check `pricedPlayoffGames` -- early in the season most
  playoff-week games have no posted line yet.

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
