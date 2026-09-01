# Architecture

One-page picture of ff-assistant. Component detail lives in `docs/specs/`; the rationale
behind each choice lives in `docs/decisions.md`.

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

## What is explicitly out of scope (v1)

- Multiple leagues per user (design for one; leave room for N).
- Platforms beyond Yahoo + ESPN (Sleeper is a cheap later add via its public API).
- Any server the developer must run -- the app is fully local; the only remote call is to
  Anthropic (via the user's subscription) and to the fantasy sites (via the user's browser).
