# Data centralization and the ingest contract

The store (`ff.db`) is the single source of truth. Every external source -- ESPN through the app's
logged-in session, nflverse, FantasyPros ECR, FantasyFootballCalculator, the odds feed -- is a
datasource we **pull from, write to the DB, and then validate the write landed**. This file records
the contract and the one thing it must never do: report a successful sync that wrote nothing.

## The contract (`src/data/validatedIngest.ts`)

Pull -> write -> validate, with the validation durable in the DB:

- **`assertPulled(count, source)`** / **`refreshDecision(pulled, existing)`** run *before* a
  destructive write. A full-refresh sync that deletes then re-inserts must not wipe real rows on an
  empty pull -- an empty read is a session/endpoint failure, not "the data is now empty". `ownership`
  had exactly this bug (delete-then-insert-nothing wiped the table and exited 0); `refreshDecision`
  now returns `replace` / `refuse-empty-wipe` / `noop-empty` so a lost session keeps the existing
  rows and a genuine pre-draft empty stays a harmless no-op.
- **`auditIngest(db, {source, season, rowsWritten, readback, policy})`** runs *after* the write. It
  checks two independent signals -- the writer's own count (`rowsWritten` 0 = the pull was empty,
  which a readback cannot see when stale rows remain) and a re-query of the table (`rowsReadback` 0 =
  the write did not persist) -- plus an optional `minFractionOfPrev` collapse guard (200 rows last
  week, 3 today). Every call writes one row to **`ingest_audit`**, so "we validated it" is durable
  state, not a log line that scrolled away.
- A **sync verb** treats a failing verdict as fatal (throws / `failStep` -> exit 1); a best-effort
  refresh (the optional ESPN weekly baseline) records the verdict without failing.

Where it is applied:

| Layer | Enforcement |
|---|---|
| RAW_ASSETS (nflverse + ESPN league history/rosters/transactions/eligibility) | `ingestRawOnly` reads back the primary table for the seasons targeted and **throws** on a degenerate write. The throw -> exit 1 -> `ff sync-league` marks the step FAIL (it already gates on child exit codes). |
| L1 board-feeding sources (ecr, byes, odds, ...) | audit **recorded** (some live feeds are legitimately sparse; `ecr` already throws on 0 rows at its source). |
| `ownership` (`ff sync-rosters`) | `refreshDecision` guard + league-scoped read-back + audit. |
| `league_sync` config | refuses a degenerate settings pull before overwriting config; reads back the slot count. |
| ESPN weekly projection (`ff scorecard --espn`) | audit recorded with a collapse guard (optional baseline, not fatal). |

`ff store` prints the resolved DB path, warns if the DB and its data root are split, and shows the
latest `ingest_audit` verdict per source -- the fast answer to "which store am I on, is it fresh, did
the last pull land?".

## The single canonical store

Two run modes: dev opens `data/ff.db` with sidecars in `data/`; a packaged install redirects BOTH the
DB (`FF_DB`) and the data root (`FF_DATA`) into a writable userData dir. They agree only because the
app injects both together. `storeInfo()` computes whether the DB's folder and `FF_DATA` are the same
root, and `openDb` warns once on a split (a CLI run with `FF_DB` set but `FF_DATA` unset lands the DB
in one place and its `points.csv` / cache / `live-state.json` in another -- how a clone ends up looking
empty). The app announces its store path on boot.

## What is intentionally NOT in the DB

Centralizing *data* does not mean every byte becomes a row. Two categories stay as files, on purpose:

- **Fitted model artifacts** (`*-artifact.json`, `age-curve.json`, `price-model.json`,
  `faab-model.json`, `rank-outcomes.json`, ...) -- these are model *weights*, versioned outputs of the
  `tools/train_*.py` trainers, not data pulled from a source. They belong beside the code that
  produced them, checked against the store by their golden blocks, not inside it.

- **Runtime/derived intermediates flagged for future migration**: `data/cache/espn/*.gz` (the raw ESPN
  payload cache -- note it is served *instead of* a live fetch, so a stale cache can mask live ESPN;
  a freshness guard on it is the next step), `data/live-state.json` (a per-tick live-draft mirror of
  the `draft_state` table), the per-draft `draft-log-*.json` event logs, and `data/points.csv` (a
  valuation intermediate `openLeague` reads directly). These hold data the DB does not fully capture
  and are the remaining edges of "everything in the DB"; they are named here so the gap is explicit
  rather than discovered.

## Transient external reads: persist vs keep-live

Not every live read should become a cached table. Some ESPN reads are *point-in-time inputs to one
analysis* and caching them would serve stale truth:

- **Kept live, by design** -- `EspnLeague.teams()` / `freeAgents()` / `read_league` / the live-draft
  DOM reads. A trade or waiver analysis wants the roster and free-agent pool *as they are right now*;
  a cached copy would silently answer with last sync's rosters. These stay live reads.
- **Worth persisting (a defined next step, not yet built)** -- **percent-owned / rostered%** is
  slow-changing external truth referenced repeatedly, so it is a genuine candidate for a
  `player_market` table populated by a validated `sync-market` verb (same `auditIngest` contract).
  It is deferred rather than shipped here because a new ESPN-session pull cannot be acceptance-tested
  without the running app, and shipping an untested live pull is the failure this whole programme
  exists to avoid. When it lands it goes through the contract like every other source.
