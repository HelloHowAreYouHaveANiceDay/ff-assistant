# ff-assistant

A full-auto fantasy football co-manager, packaged as a double-click desktop app for
non-technical users. It embeds a Claude agent (the Claude Agent SDK -- Claude Code as a
library), a local SQLite database, and a set of data + browser-automation scripts behind a
simple chat + dashboard UI.

The goal: reproduce the "Claude Code + browser control plays my fantasy team" experience for
someone who cannot -- and should not have to -- set up Claude Code themselves.

## What it does

- **Assists and plays.** Claude reasons over live league data (roster, matchups, projections,
  injuries) and, on a schedule, sets the starting lineup and submits waiver claims by driving
  the user's own logged-in browser.
- **Runs on the user's Claude subscription.** One "Log in with Claude" button (OAuth, the same
  flow Claude Code CLI uses). No API key, no per-token bill.
- **Keeps the user in control of cost.** A user-adjustable token budget cap governs how much
  the app is allowed to spend before it pauses and notifies.
- **Logs everything.** Every automated action is recorded before it executes and surfaced as a
  notification, so a Sunday roster change is never a mystery.

## Status

**Design + specification phase.** No application code yet. This repo currently holds the
architecture and the component specs the implementation sessions build against.

Start here:

- [`docs/architecture.md`](docs/architecture.md) -- the whole system, one page
- [`docs/decisions.md`](docs/decisions.md) -- the design decision log
- [`docs/specs/`](docs/specs/) -- one spec per component

Planning (roadmap, phased build, issue tracking) lives in the wiki:
`wiki/projects/project--ff-assistant.md` and `roadmap--ff-assistant.md`. Implementation is
delegated to follow-up sessions / the dim-factory as `ready` issues compiled from that roadmap.

## High-level shape

```
Desktop app (Electron)
  Chat UI  +  Roster/matchup dashboard  +  Budget panel
        |                    |                   |
  Claude Agent SDK (headless session, subscription OAuth)
        | tools:
   SQLite MCP   data scripts   bro-style CDP browser (Yahoo / ESPN)
```

See `docs/architecture.md` for the full picture.
