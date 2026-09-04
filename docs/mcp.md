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

## Known limitation: the embedded webview cannot be DRIVEN by the bidding engine

`navigate` / `read_page` / `click_page` reach the webview through the renderer
(`webview.executeJavaScript`), which is why they work. The auction engine does not: `ff auto-draft`
/ `launch-practice` / `read-block` attach with Playwright (`attach()` =
`browser.contexts().flatMap(c => c.pages())`), and **Playwright does not enumerate an Electron
`<webview>` as a page**. Measured on this machine (Electron 32.3.3, CDP 9223):

- `GET /json/list` shows the guest as a target of type **`webview`** at `fantasy.espn.com`;
- `ff attach --port 9223` reports exactly one page, the `file://` renderer.

So `--port 9223` hands every draft verb the RENDERER, not ESPN -- `read-block` returns all nulls,
and `launch-practice` would navigate the app's own UI window to the ESPN lobby. The app's
"Start agent (practice)" button (`app/main.js` -> `ffSpawn(["launch-practice", "--port", CDP_PORT])`)
depends on this and is affected.

The path that works for bidding is a real browser where ESPN is a TOP-LEVEL page -- the bro session
(`attachBro`), which is what the live mock runs of 2026-09-01/02 used.

Separately, ESPN opens every draft room via `window.open`, and the main window's
`setWindowOpenHandler` sends `http(s)` popups to `shell.openExternal` -- i.e. out to the system
browser, not into the app. `click_page` patches `window.open` in the guest to capture and follow
such URLs in-place, which handles the general case, but the lobby's "Practice Draft" button did not
route through `window.open` in testing.
