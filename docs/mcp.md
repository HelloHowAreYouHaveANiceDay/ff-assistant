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
node scripts/mcp-smoke.mjs      # -> MCP STDIO SMOKE PASSED
```

## The tools (16)

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
