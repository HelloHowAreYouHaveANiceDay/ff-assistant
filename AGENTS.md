# AGENTS.md -- canonical instruction file for headless workers

> **Claude sessions: read `CLAUDE.md` first.** It carries the measurement discipline (the backtest
> is the only arbiter; re-measure candidates against the baseline you intend to ship; prove a lever
> is connected before believing its null) and the traps that have already cost real time -- the
> Electron webview not being a Playwright page, the auto-draft single-instance lock, stored-vs-code
> lever precedence, and the npm install order. This file is the work contract; that one is the map.

This repo has a WORKING engine AND a working desktop app -- see `README.md` for the current stack
and layout. The `ff` TypeScript CLI is the draft agent + validation harness + in-season copilot; the
PACKAGED APP (Electron + Claude Agent SDK + SQLite, `docs/architecture.md`) is BUILT and runs -- a
persistent Assistant, the live Board, authenticated ESPN pages, and News/Data/Model pages. Further
work is driven by `ready` issues compiled from `wiki/projects/roadmap--ff-assistant.md`. Know which
layer you are working on before you start.

## Before writing any code

1. Read `docs/architecture.md` (the whole system), then the relevant `docs/specs/*.md`.
2. Read `docs/decisions.md` -- do NOT silently reverse a recorded decision (D0-D24). If a
   decision looks wrong, raise it as an open question in the wiki roadmap instead of coding
   around it. Note **D10**: the shipped `ff` engine is TypeScript + deterministic (no LLM in the
   bid loop); Python is only the offline data builder; the app (Electron/Agent SDK/SQLite) is BUILT.
3. Build against the acceptance criteria in the specs -- each spec ends with testable criteria.

## Stack

- Electron shell (D5), Node/TypeScript throughout.
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for the agent, subscription OAuth for auth.
- SQLite (WAL mode) as the single source of truth; the agent reads it through the tools in `src/agent/`.
- CDP browser control reusing the `bro` repo's persistent-session machinery.
- In-app scheduler for in-season routines (`src/inseason/routines.ts` + the Electron main-process timer).

## Keys: the one policy that silently corrupts a store

**`player_sk` is a SNAPSHOT-LOCAL surrogate. Never join it across databases.**

It is a minted `AUTOINCREMENT` key. The same number means different players in different stores, and
an identity rebuild reassigns it -- this store's own `identity_rekey` log records one rebuild moving
**11,974 of 12,021 keys**. A cross-database `INSERT ... SELECT` or `JOIN ... USING (player_sk)`
therefore attaches rows to the wrong players, **every row still matches something, and nothing
errors**. There is no natural signal that it happened.

- To join a published dataset to anything, use **`dim_player_key`** -> a stable external id
  (`gsis_id`, `mfl_id`, `pfr_id`, ...). `resolved_by` records which route produced each row.
- `DST:<TEAM>` keys are deterministic by construction and are the **only** keys safe to carry across.
- To bring a release into a store, use **`ff import-dataset --file <f>`** (dry-run by default). It
  does the bridging, refuses a file with no crosswalk, and reports what it could not bridge. Do not
  write another bespoke import script -- that is where this bug keeps being reintroduced.
- `test/dataset-import-keys.test.ts` is the guardrail; `src/data/datasetImport.ts` is the reasoning.

## Database safety

- **`data/ff.db` is gitignored and is not reproducible from the repo.** Never commit it; never
  `rm` it. Back it up before any destructive import or migration -- `ff import-dataset` without
  `--write` is a dry run precisely so you can look first.
- The store is SQLite in WAL mode: copying it means copying `-wal` and `-shm` too.
- This is a **shared checkout**. Another session may hold the DB or a `git index.lock`; check before
  assuming a lock is stale, and stage explicit paths rather than `git add -A`.

## ESPN / Yahoo sessions: what needs the desktop app

One resolver decides, `src/league/session.ts`: explicit `io` -> `--session`/`--cookie-file` ->
`FF_SESSION`/`FF_SESSION_COOKIE_FILE` -> **the Electron bridge (the default)**.

- **Reads work headless.** Any `Platform` method takes an injected `io`, so a cookie session drives
  `discover`/`syncSettings`/`syncRosters`/`readTeam` with no app running.
- **Writes default to the app** and are ESPN-only: the allowlist is one ESPN transactions URL and the
  permitted operation list is `["TRADE_PROPOSAL"]` (`src/league/writeIO.ts`). Waivers and lineups are
  refused by the operation check, not merely unimplemented.
- **The draft verbs need the app.** `--app` drives the embedded webview; plain `--port` does not (see
  CLAUDE.md's live-draft traps).
- Adding a platform: `npm run ff -- platform-contract`, and `docs/platform-adapter.md`.

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

- **Test:** `npm test` -- which runs `scripts/run-tests.mjs`, driving **Node's built-in test runner**
  (`node:test`) over `test/*.test.ts`. **This repo does NOT use vitest or jest.** Do not install one;
  `describe`/`it`/`expect` are not available. Use `test()` from `node:test` and `assert` from
  `node:assert/strict`, as every existing file does.
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`). **Lint:** `npm run lint`. Test and typecheck
  must both be green before every commit.
- **If `npm test` fails on a fresh clone, suspect the install before the code.** `npm install` must be
  run as `npm install better-sqlite3` FIRST, then `npm install` -- a bare install aborts on the
  node-gyp build and leaves `tsx` missing, so nothing runs and the failures look like real breakage.
  See "Setup on a new machine" in `CLAUDE.md`.
- **Data-dependent tests SKIP, they do not fail.** `data/ff.db` and four other artifacts
  (`history-points.csv`, `history-weekly.csv`, `rank-outcomes.json`, `variance-model.json`) are
  gitignored, and every test that needs them is behind an `existsSync` guard and reports a skip. If
  you see failures rather than skips on a clean clone, that is a real defect -- report it with the
  test names rather than working around it.
- **Run a command:** `npm run ff -- <cmd>` (e.g. `values`, `cheatsheet`, `backtest`, `sim`,
  `values-check`, `preflight`, `launch-practice`, `auto-draft`). See `README.md` "Key commands".
- **Rebuild data (Python via uv):** `uv run --with nflreadpy --with polars tools/<script>.py`
  (`build_projections`, `build_history`, `build_weekly`), then `npm run ff -- values`.
- ASCII-only in code/docs/output; write files with the editor tools, not shell heredocs.
