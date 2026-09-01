# AGENTS.md -- canonical instruction file for headless workers

This repo is in its DESIGN + SPECIFICATION phase. There is no application code yet.
Implementation is delegated to follow-up sessions / the dim-factory, driven by `ready` issues
compiled from `wiki/projects/roadmap--ff-assistant.md`.

## Before writing any code

1. Read `docs/architecture.md` (the whole system), then the relevant `docs/specs/*.md`.
2. Read `docs/decisions.md` -- do NOT silently reverse a recorded decision (D1-D6). If a
   decision looks wrong, raise it as an open question in the wiki roadmap instead of coding
   around it.
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
- Every automated action writes an `action_log` row BEFORE it executes (D3).
- Verify every fault-handling guard by fault injection: prove the budget cap SKIPS a run
  (set cap=1) and the plan-limit handler FIRES (simulate the error) -- a green test that only
  exercises the happy path does not count.

## Build / Test / Run

To be defined by the first scaffolding issue (Phase 2 of the roadmap). Until then this repo is
docs-only; there is nothing to build or test.
