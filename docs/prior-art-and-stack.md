# Prior Art + Stack (recon findings, 2026-08-31)

Distilled from a 5-agent web recon. Full sourced notes live in the wiki:
`wiki/sources/source--fantasy-football-agent-build-2026-08.md`. This page is the actionable
summary for implementation sessions.

## Stack decision (see decisions.md D7)

**TypeScript Electron shell + agent; Python MCP sidecar for football data/math.**

- **Agent + UI + browser: TypeScript.** `@anthropic-ai/claude-agent-sdk` runs natively in
  Electron's Node runtime; `query()` runs the tool-execution loop automatically (no manual tool
  plumbing). The Python Agent SDK exists but would force subprocess bridging in an Electron app.
- **SQLite: via an MCP server**, with `allowedTools: ["mcp__sqlite__*"]` -- the agent gets
  read/write SQL with zero custom DB-tool code.
- **Football ecosystem: Python, behind a stdio MCP.** The libraries and math we want
  (`espn-api`, `nflreadpy`, PuLP optimizers, VOR/VONA) are Python and have no TS equivalent.
  Wrap them in one Python MCP sidecar spawned by the Electron main process. This is the clean
  TS<->Python seam; keep it to ONE sidecar, not many.

MCP mechanics to remember: tool names are `mcp__<server>__<tool>`; stdio servers block startup
until connected (default 30s, `MCP_TIMEOUT`); a failed server does NOT throw -- check the init
message's `mcp_servers[].status` before relying on it for a critical path.

## Reference implementations to study (do not depend on -- all are small/niche)

| Repo | Lang | Why it's useful | Caution |
|------|------|-----------------|---------|
| vanzan01/claude-agent-sdk-starter | TS | Production Electron + Agent SDK template; multi-agent orchestration pattern | Starting point for our shell |
| pheuter/claude-agent-desktop | TS | Working Electron agentic-chat desktop app | Example of the chat-stream pattern |
| makeralchemy/claude-desktop-mcp-sqlite | Py | SQLite MCP (list_tables/describe_table/run_query) | May be enough as-is for the DB layer |
| cwendt94/espn-api | Py | The maintained ESPN library; consumes SWID/espn_s2 cookies | Read layer only -- no write/draft |
| KBThree13/mcp_espn_ff | Py | ESPN private-league MCP (rosters, stats, matchups), 41* | Read-only; a model for our sidecar |
| nflverse/nflreadpy | Py | Stats/PBP; REPLACES deprecated nfl_data_py | Use this, not nfl_data_py |
| FloSchl8/sleeper-mcp | TS | Sleeper MCP w/ waiver/start-sit advice, caching | Sleeper is a later platform (Phase 5+) |
| JayMishra-source/Fantasy-Football-AI-CoManager | TS | ESPN + multi-LLM co-manager, waiver/trade eval | Recommends, doesn't auto-execute |

**Landscape takeaway:** there is NO all-in-one autonomous fantasy agent. Everyone ships modular
tools + MCP glue and stops at *recommendation*. ff-assistant's differentiator is
**full-auto execution end-to-end (draft -> lineup -> waivers) for a non-technical user**, not a
smarter model.

## ESPN access (confirms D2)

- API is undocumented/reverse-engineered; v3 base `lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/`.
- Private-league reads need `SWID` + `espn_s2` cookies that **cannot be fetched
  programmatically** -- only from a logged-in browser. Our bro-style persistent session is
  therefore both the auth source (harvest cookies -> hand to espn-api for fast reads) and the
  action surface (drive the DOM for writes ESPN exposes no API for).
- **Hybrid read strategy worth prototyping:** use the browser session's cookies with `espn-api`
  for fast structured reads, and reserve DOM automation for writes + anything the API omits.

## Draft day = the hard part (Phase-N risk, scope carefully)

- ESPN has **no draft API and no programmatic pick override.** A live snake/auction draft must
  be driven through the draft-room DOM under a strict per-pick clock (existing tools sync in
  ~1-3s). This is the highest-risk autonomous capability.
- Recommendation: treat draft automation as its OWN later phase with a **confirm/assist fallback**
  (surface the VOR-ranked pick with seconds on the clock; auto-submit only once DOM reliability
  is proven). Weekly lineup + waivers are far lower-stakes and should ship first.

## Data plan (no single free source is enough)

- **Sleeper API** -- free, no auth: players, and (for Sleeper leagues) league/roster. No
  projections/injuries/news.
- **FantasyPros API** -- expert consensus projections + injuries + news; free dev tier,
  ~$8.99/mo for production, `x-api-key`. The projections/news backbone.
- **nflreadpy** -- free Python, stats/play-by-play enrichment (NOT nfl_data_py, deprecated).
- **ESPN (espn-api + our cookies)** -- native ESPN league state (the source of truth for the
  user's actual team).

## Draft/lineup math (Python-native, well-trodden)

VOR = ProjectedPoints - ReplacementBaseline; VBD drafts highest VOR; snake adds VONA (one-round
lookahead); auctions re-rank on live spend. Optimizers: integer programming (PuLP), Gaussian
KDE. For a single-user app, a straightforward VOR/VONA + a PuLP lineup solve is sufficient --
the multi-agent CrewAI designs seen in the wild are heavier than we need.
