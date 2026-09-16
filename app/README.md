# Fantasy Mission Control (desktop app)

The Electron window for the ff-assistant engine. Since **D26 (2026-09-16)** it is deliberately small:
the agent surface is Claude Code driving the `ff` CLI and the `ff-draft` MCP server, and this window
is the **login / bridge / board cockpit** -- the three things a terminal cannot be.

1. **Two logged-in `<webview>` guests** (ESPN and Yahoo, each on its own persistent partition) plus
   the **loopback app bridge** (`/fetch`, `/read`, `/read-frame`, `/click`, `/write-transaction`).
   12+ engine modules and the 11 browser MCP tools reach the platforms only through the login a
   human performed in this window. There is no CLI equivalent and there cannot be one.
2. **A stable CDP target** on port 9223, which is what `ff <verb> --app` attaches to.
3. **A dense board** you scan rather than query, and **one Status page** that answers "is the system
   healthy, and what will Claude Code see".

## Run
```
cd app
npm install                 # once; if node_modules/electron/dist/electron.exe is missing:
                            #   node node_modules/electron/install.js
npm start                   # opens the Mission Control window
```

**Exactly ONE instance may run.** The MCP browser tools attach to a fixed CDP port (first instance to
bind wins) and the bridge file is whatever the newest instance wrote, so two instances split-brain.
See the root `CLAUDE.md`.

## The data
The board reads the SQLite store LIVE, through the engine (`window.mc.appData()` -> `ff serve`'s
`app-data`). There is no generated `data.js` any more: it was a 284 KB checked-in snapshot nothing
regenerated, which rendered identically to live data, so every failure of the live path degraded in
silence into plausible old dollar values. If the live path fails now, a red bar says so and the board
is empty.

Rebuild values from a terminal: `ff refresh` (or MCP `refresh`); one asset with
`ff ingest-source <id>`.

## Layout
- `main.js` -- Electron main: the window, the **app bridge**, the in-season scheduler, and a
  read-only IPC surface (16 channels: 12 invoke + 4 push). `MC_CDP_PROBE=1` reports whether the guest is CDP-attachable.
- `bridgeHosts.js` -- the bridge's per-platform url allowlist (dependency-free, unit-tested).
- `preload.js` -- the `window.mc` surface. Every channel here has a handler in `main.js` AND a caller
  in the renderer; `test/app-ipc-map.test.ts` asserts both directions.
- `renderer/index.html` -- the shell: league tabs, three page tabs, the two webviews.
- `renderer/app.js` -- Board, Browser, Status.
- `renderer/app.css` -- styling.

## What was removed, and where it went
| Removed | Use instead |
|---|---|
| The in-app Assistant (chat, OAuth screen, stub planner) | Claude Code + `ff-draft` MCP (D26) |
| Draft start/stop/pause bar, the cockpit rail | `ff auto-draft`, `ff launch-practice`, `data/PAUSE` |
| Setup page: sync / build board / levers | `ff league-sync`, `ff refresh`, `ff set-lever` / MCP `set_lever` |
| Data page DAG + "Rebuild all" | `ff ingest-source <id>`, `ff refresh` |
| Model page graph/trace/ledger | `ff model-page --json`, `docs/validation.md` |
| News page, My Team page, the board's `+` tally | MCP `read_board` / `read_my_team`, the Owner overlay |

Evidence for each, control by control: `docs/ui-audit-2026-09-16.md`.
