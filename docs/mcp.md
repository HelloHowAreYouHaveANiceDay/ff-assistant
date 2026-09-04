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

## The tools (15)

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
