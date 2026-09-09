# Architecture

One-page picture of ff-assistant. Component detail lives in `docs/specs/`; the rationale
behind each choice lives in `docs/decisions.md`.

> **Built vs planned (2026-09).** What follows is the LONG-TERM packaged-app target (Electron +
> Claude Agent SDK + SQLite). It is NOT built yet. What IS built is the Phase-2 engine -- the `ff`
> TypeScript CLI (draft agent + validation harness) that this app will eventually wrap. For the
> current, working system and its stack, read `README.md`. This doc is the destination, not the
> present state.

## The problem being solved

A non-technical user wants the "Claude drives my fantasy team" experience but cannot set up
Claude Code, an API key, or a terminal. The app must hide three technical pieces -- the agent
loop, a local database, and the data/browser scripts -- behind a chat window and a few buttons,
and run unattended (full-auto) on the user's own Claude subscription.

## System diagram

```
+-------------------------------------------------------------------+
|  Desktop app  (Electron)                                          |
|                                                                   |
|  +----------------+  +------------------+  +------------------+    |
|  |  Chat pane     |  |  Roster / matchup |  |  Budget panel   |    |
|  |  (streams the  |  |  dashboard        |  |  (cap slider +  |    |
|  |   agent turns) |  |  (reads SQLite)   |  |   usage meter)  |    |
|  +--------+-------+  +---------+---------+  +--------+---------+    |
|           |                   |                     |             |
|  +--------v-------------------v---------------------v---------+    |
|  |  Claude Agent SDK  (headless session)                      |    |
|  |  auth: user's Claude subscription via OAuth                |    |
|  |  system prompt: "fantasy football co-manager"             |    |
|  |  budget governor wraps every run (see spec-auth-and-budget)|    |
|  +--+-------------+------------------+----------------------+-+    |
|     |             |                  |                             |
|  +--v----+   +----v------+   +-------v-----------------+           |
|  |SQLite |   |data scripts|   |bro-style CDP browser    |          |
|  |MCP    |   |(projections|   |(Yahoo / ESPN, persistent|          |
|  |server |   | injuries,  |   | logged-in profile)      |          |
|  |       |   | stats)     |   | -- the "Claude plays"   |          |
|  +---+---+   +-----+------+   +-----------+-------------+          |
|      |             |                     |                        |
|      +------> SQLite file <--------------+                        |
|             (league state, usage_log, action_log, settings)      |
|                                                                   |
|  Scheduler (node-cron): Sun lineup pass, waiver-night pass,       |
|                         injury-check pass                         |
+-------------------------------------------------------------------+
```

## Components

| Layer | Choice | Spec |
|-------|--------|------|
| Shell / packaging | Electron, signed installer (.exe / .dmg) | `spec-ui.md` |
| Agent | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | `spec-agent.md` |
| Auth | Claude subscription OAuth (bundled `claude` login) | `spec-auth-and-budget.md` |
| Cost control | User-adjustable self-tracked token budget cap | `spec-auth-and-budget.md` |
| Database | SQLite, exposed to the agent as an MCP server | `spec-data-model.md` |
| Data ingest | Public APIs where available + browser scrape for walled data | `spec-data-model.md`, `spec-browser-automation.md` |
| Actions ("plays") | bro-style persistent CDP browser (Yahoo / ESPN) | `spec-browser-automation.md` |
| Scheduling | node-cron in the shell | `spec-agent.md` |

## The league calendar is an INPUT, not a constant

Everything that produces a season-shaped number -- the backtest bracket, the season simulator, the
copilot's playoff-week reasoning, playoff strength of schedule -- needs to know how long the regular
season is, how many teams make the playoffs, which weeks the bracket runs in, and how the field is
seeded. None of that is a property of the software; all of it is a property of one league in one
year, and this league has changed it twice (13 weeks / 6 teams / one division through 2020; 14 weeks
from 2021; 16 teams / four divisions / 7-team field from 2025).

So it is modelled as a single `LeagueFormat` block (`src/league/types.ts`) with a **source**:

```
config.format       the block IN FORCE      source "espn" | "owner-override"
config.formatEspn   what ESPN last said, kept even while an override is in force
config.regWeeks     \  MIRRORS of the block, for readers that predate it.
config.playoffTeams /  Written FROM it, never independently.
```

`formatFromEspnSettings()` in `src/league/index.ts` is the only place ESPN's `scheduleSettings` is
interpreted, and **a missing field throws instead of defaulting** -- the whole point, because the
previous `regWeeks ?? 14` gave the right answer for this league while never reading anything, so a
code path that had lost its input looked exactly like one that had it. `effectiveFormat()` is how
every consumer asks, and it refuses a block that is absent, half-written, or self-contradictory (13
regular weeks with the bracket starting in week 15). `ff format show | sync | set` is the surface.

Seeding is part of the format, not a constant in the simulators: `seedField()` in
`src/draft/schedule.ts` is the one implementation of both `record` and `division-winners-first`, and
`backtest.ts` and `season.ts` both call it.

## The core thesis: the copresent design (D0)

The agent works **inside the user's own live, logged-in browser session**. It sees the league
through the same DOM the user sees and acts through the same controls the user would click. One
data plane -- the live browser -- for BOTH reading status AND taking actions; no separate API
client, no credential extraction. It is bidirectional: the user can watch the agent, take the
wheel, and hand it back. This solves auth for free, works uniformly across ESPN and Yahoo, and is
what makes an unattended full-auto tool trustworthy. Draft day is the first proving ground
(driving the draft-room DOM under the pick clock), validated by mock drafts.

## The other defining decisions

1. **Auth = the user's Claude subscription, not an API key.** The app bundles the `claude` CLI
   and rides its OAuth login, so the SDK draws against the user's Max/Pro plan. This removes the
   single hardest onboarding step. Cost: subscription usage limits apply and are *not*
   programmatically visible -- see decision D1 and `spec-auth-and-budget.md`.

2. **Browser access = bro-style saved sessions, not API tokens.** Instead of extracting ESPN
   cookies or registering a Yahoo OAuth app, the app launches a real browser with a persistent
   profile; the user logs in like a human once, and Claude drives that authenticated session.
   Reuses the existing `bro` machinery. See decision D2.

3. **Autonomy = full-auto, governed by an adjustable cap + an action log.** Claude sets lineups
   and submits claims on a schedule with no per-action approval, but every action is recorded
   before execution and notified after, and a user-set token budget can pause automation. See
   decisions D3 and D4.

## Data + control flow (a scheduled lineup pass)

1. Scheduler fires the Sunday lineup job.
2. Budget governor checks `weekly_used + estimate(lineup_pass)` against the cap. If it would
   exceed, skip + log + notify; done.
3. Agent runs: `refresh_league()` scrapes the current roster into SQLite via the CDP browser;
   `get_projections()` / `get_injuries()` fill the data tables.
4. Agent reasons over the DB, decides lineup changes.
5. For each change: write an `action_log` row (status=planned), then `set_lineup()` drives the
   browser to execute, then update the row (status=done/failed).
6. Agent calls `notify()` with a plain-English summary.
7. Every turn's `usage` is appended to `usage_log`; the budget meter updates.

## The data pipeline

Three sources, one direction of flow, and one rule: **nothing downstream re-derives what an upstream
layer already owns.**

```
nflverse (raw truth)          ESPN (league truth)         our board
  stats_player_week   ---+      scoringItems  ---+          points.csv
  stats_team_week        |      rosters/schedule |          values.csv
  schedules/games        |                       |
                         v                       v
              src/draft/scoring.ts  <-- LeagueScoring (rules + kicker + defense)
                         |
                         v
              src/data/history.ts  -->  history-points.csv / history-weekly.csv
                         |                      (both carry player_sk, appended last)
                         v
              src/features/build.ts  -->  feat_player_season / feat_player_week / feat_curve
                         |                                    fact_draft_pick
                         v
              tools/train_projection.py  -->  data/projection-artifact.json  (golden block)
                         |
                         v
              src/model/projector.ts  (PURE: artifact + feature rows -> projections)
                    /              \
        project() -> points.csv     backtest --projection artifact
                         |
                         v
              backtest (strategy)  |  season.ts (this year's odds)
```

**One projector, two callers, and the multipliers applied exactly once.** The board and the backtest
each used to look the curve up and multiply the age and opportunity factors in themselves, a thousand
lines apart and with slightly different arguments. `src/model/projector.ts` is a pure function of
(artifact, feature rows) -- no file reads, no network, no clock -- which is precisely what lets the
two callers be tested against each other. The multipliers live in the artifact's `multiplicative`
stage, so there is one place they are applied; `test/projector.test.ts` asserts `mean == base x
factors` exactly, a claim a double application is structurally incapable of satisfying.

**The feature layer is point-in-time.** Every `feat_*` row carries an `as_of` and nothing in it may
depend on information that did not exist then -- which is why the curve columns are refitted per
season on an expanding window instead of fitted once on everything. A curve fitted on all 27 seasons
and used as a feature for 2010 is lookahead moved one level UP, into the model, where no data-level
check can see it. See `docs/data-layers.md`.

**Training is Python, serving is TypeScript, and the seam is validated.** The artifact carries five
fixture rows with the trainer's own predictions; the TS loader recomputes them and refuses the
artifact if they disagree by more than 1e-6. It also refuses an artifact naming a feature it cannot
compute, or missing a quantile head -- each of which would otherwise degrade to "that coefficient
contributes zero", a slightly different projection and no error at all.

**Sources are addressed in one place.** `src/data/nflverse.ts` owns every URL (`URLS`,
`playerWeekUrl`, `teamWeekUrl`) and the team-abbreviation map (`canonTeam`). The per-season stats
URLs used to be built inline at each call site and `TEAM_ALIAS` existed in two files -- two copies of
a join key that must agree, where disagreement fails SILENTLY (a team simply matches nothing).

**Scoring is one model, synced or not as a whole.** `LeagueScoring` bundles offence, kicking and
defence. Previously only the offensive third was league-driven: `history.ts` called
`scoreKickerWeek(r)` and `scoreDefenseWeek(r, pa)` with *no rules argument*, so a different league
would adapt its QB/RB/WR/TE scoring and keep scoring K and DST by our league's book, with nothing
failing. `scoringFromEspn()` now builds all three from `scoringItems`, and `ff build-history` prints
whether the K/DST rules are league-synced or defaults rather than leaving it unknowable.

**The one part that cannot be synced** is the DST points-allowed ladder: ESPN spreads it across stat
ids whose tier *boundaries* are absent from the settings payload. It is derived empirically instead
(175 scored DST weeks) and marked as such in `scoring.ts`.

**Correctness is checked against the other side, not against ourselves.**
`scripts/validate-scoring.mjs` recomputes ESPN's own `appliedTotal` for ~700 player-weeks. QB/RB/WR/
TE reproduce it exactly; K is within 0.24 pts/week; DST within 1.84. Face validity on *ranking* --
which this pipeline passed for weeks while the DST ladder was overstating every defense by 4-5
points a game -- cannot see a level error. Only the cross-check can.

**Our own CSVs are comma-safe by construction:** `history.ts` runs every name through `clean()`,
which strips commas, so downstream `split(",")` is sound *for files we write*. It is NOT sound for
nflverse feeds, which contain quoted headshot URLs -- always use `fetchCsv` there.

## The Data and Model pages are views, not documents (Track K, 2026-09-09)

Both app pages used to be hand-maintained: a curated node/edge list for the Data page (`WH_CURATED`/
`WH_DERIVE`/`WH_EDGES`), and prose on the Model page written 2026-09-08 describing "a curve times two
multipliers" -- true that day, and stale within the week once the projection became a trained
artifact with five sibling artifacts, a per-position serve table, a scorecard, and a prediction
ledger, none of which the page could grow to show without someone editing it by hand.

The fix in both cases is the same shape: put a real assembler between the registry and the renderer,
and make the renderer a dumb consumer of its JSON.

- **Data page**: `src/lineage/dag.ts` computes the lineage graph from `src/data/ingest.ts` +
  `src/lineage/registry.ts` (see `docs/data-layers.md`). `app/renderer/app.js` draws exactly the served
  nodes/edges, grouped by `kind`, wired to rebuild via `node.materialize`.
- **Model page**: `src/lineage/modelPage.ts` assembles one JSON from `src/draft/models.ts` (`MODELS`,
  `EVALUATED_NOT_SHIPPED`, `modelStatus()`), `src/weekly/streamingServe.ts` (which artifact serves each
  position), `src/weekly/scorecard.ts` (frozen/scored counts per kind, live scores), and
  `src/lineage/ledger.ts` (the `fact_prediction` table). The renderer's new sections
  (`renderWeeklyServe`, `renderScorecardSection`, `renderLedgerSection`) contain no number of their
  own -- `test/model-page.test.ts` extracts each function's real source and fault-injects a literal
  figure to prove the guard would catch one.

Both pages refresh in place on a push from the engine: `ff serve` gained cheap `lineage-stamp` /
`models-stamp` probes, and the existing board-change chokepoint in `app/main.js` (every `ff`
invocation passes through `ffRun` or `rpc()`) now also watches them, pushing
`mc:lineageChanged`/`mc:modelsChanged` on the same principle as the pre-existing `mc:boardChanged` --
a cheap stamp compared against what was last seen, not a per-command emit list to fall behind.

## What is explicitly out of scope (v1)

- Multiple leagues per user (design for one; leave room for N).
- Platforms beyond Yahoo + ESPN (Sleeper is a cheap later add via its public API).
- Any server the developer must run -- the app is fully local; the only remote call is to
  Anthropic (via the user's subscription) and to the fantasy sites (via the user's browser).
