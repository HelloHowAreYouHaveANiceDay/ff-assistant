# AGENTS.md -- canonical instruction file for headless workers

This repo has a WORKING Phase-2 engine: the `ff` TypeScript CLI (draft agent + validation
harness) -- see `README.md` for the current stack and layout. The PACKAGED APP (Electron +
Claude Agent SDK + SQLite, `docs/architecture.md`) is still design-stage and delegated to
follow-up sessions / the dim-factory, driven by `ready` issues compiled from
`wiki/projects/roadmap--ff-assistant.md`. Know which layer you are working on before you start.

## Before writing any code

1. Read `docs/architecture.md` (the whole system), then the relevant `docs/specs/*.md`.
2. Read `docs/decisions.md` -- do NOT silently reverse a recorded decision (D0-D10). If a
   decision looks wrong, raise it as an open question in the wiki roadmap instead of coding
   around it. Note **D10**: the shipped `ff` engine is TypeScript + deterministic (no LLM in the
   bid loop); Python is only the offline data builder; Electron/Agent SDK/SQLite are unbuilt.
3. Build against the acceptance criteria in the specs -- each spec ends with testable criteria.

## Intended stack (once implementation starts)

- Electron shell (D5), Node/TypeScript throughout.
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for the agent, subscription OAuth for auth.
- SQLite (WAL mode) as the single source of truth; a SQLite MCP server exposes it to the agent.
- CDP browser control reusing the `bro` repo's persistent-session machinery.
- node-cron scheduler.

## Hard rules

- ASCII-only in all source, output, and docs (this machine's terminal is CP1252).
- Never request or store an Anthropic API key -- auth is the user's subscription only (D1).
- Never handle the user's Yahoo/ESPN password -- login is manual in the persistent browser (D2).
- The D3 action-log-before-act rule is a **packaged-app** invariant (for the LLM agent + SQLite).
  The current deterministic engine has no LLM and instead writes a per-draft `data/draft-log-*.json`
  (every pick, remaining $, inflation) for review -- keep that log working when you touch the loop.
- Verify every fault-handling guard by fault injection: break the guard, watch the test fail, restore
  it -- a green test that only exercises the happy path does not count. (See the existing
  `test/*.test.ts` fault-injection suites and the pattern in `docs/plan-2026-09-02-pre-draft-hardening.md`.)

## Build / Test / Run

The Phase-2 engine is real code -- there IS something to build and test:

- **Test:** `npm test` (Node's test runner over `test/*.test.ts`). **Typecheck:** `npm run typecheck`
  (`tsc --noEmit`). Both must be green before every commit.
- **Run a command:** `npm run ff -- <cmd>` (e.g. `values`, `cheatsheet`, `backtest`, `sim`,
  `values-check`, `preflight`, `launch-practice`, `auto-draft`). See `README.md` "Key commands".
- **Rebuild data (Python via uv):** `uv run --with nflreadpy --with polars tools/<script>.py`
  (`build_projections`, `build_history`, `build_weekly`), then `npm run ff -- values`.
- ASCII-only in code/docs/output; write files with the editor tools, not shell heredocs.

The packaged Electron app (Intended stack above) is the part still to be scaffolded.
