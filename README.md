# ff-assistant

A full-auto fantasy football co-manager that drives the user's own logged-in browser. The end
goal is a double-click desktop app for a non-technical user; **what exists today is the working
engine** -- a TypeScript CLI (`ff`) that runs an ESPN auction draft end-to-end and a validation
harness that decides, by backtest, which strategies actually win.

## Status (2026-09)

**Phase 2 -- the copresent draft agent works.** `ff auto-draft` fills a full legal roster in
budget against a live ESPN mock, bidding our independent values with budget discipline and live
inflation repricing. The draft strategy is validated against a realistic, per-manager-modelled
field (see below). Not yet built: the packaged Electron app + Claude Agent SDK wrapper (Phase 3,
the long-term vision -- `docs/architecture.md`), and the live in-season lineup *writer* (the
recommend path works offline; the ESPN team-page reader gets pinned once our roster exists).

## The two things it is

1. **A copresent draft/season agent.** `bro` (a sibling repo) owns a persistent, logged-in
   ESPN browser; `ff` attaches over CDP and acts inside the user's real session -- reading the
   draft room and bidding. We never log in or handle a password (login is manual, one time).
2. **A validation harness.** Every strategy idea is run through a season+playoffs backtest on
   real historical NFL data before it ships. This has rejected more features than it shipped --
   see `docs/edges.md` and `docs/validation.md`.

## Stack

- **TypeScript (ESM), run with `tsx`** -- no build step for dev; `src/ff.ts` is the CLI
  dispatcher. Node's built-in test runner (`node --test`).
- **`playwright-core` over CDP** -- attaches to bro's persistent ESPN session (never launches
  or authenticates a browser itself). `src/browser/`.
- **Python via `uv` (`nflreadpy` + `polars`)** -- builds projections/values and the historical
  backtest data from nflverse + FantasyPros consensus ranks. `tools/*.py`.
- **No app framework yet.** The packaged app's intended stack (Electron + Claude Agent SDK +
  SQLite) is documented in `docs/architecture.md`/`docs/decisions.md` but not built.

## Layout

```
src/
  ff.ts              # the `ff` CLI: every command dispatches from here
  draft/             # the draft engine
    values.ts        #   VOR -> auction $ values
    strategy.ts      #   Engine<->Strategy seam; budget-aware bidder (+ live inflation)
    espnAuction.ts   #   live draft-room reads (block, roster, board, readDraft, readLeague)
    sim.ts           #   auction simulator + draftField (our strategy vs a realistic bot field)
    managers.ts      #   per-manager bot models, calibrated to this league's 4-yr history
    backtest.ts      #   season + playoffs -> championship rate (the trustworthy objective)
    inflation.ts     #   live remaining$/remaining-value repricing (validated edge)
    nomination.ts    #   drain-nomination policy (built; human-only edge)
    cheatsheet.ts    #   tiered draft-day board
  inseason/          # lineup optimizer (built+tested), waiver copilot, team-page scaffold
  projections.ts     # shared season/week/ROS projection layer
  data/rankings.ts
test/                # node --test fault-injection suites
tools/               # Python (uv): build_projections, build_history, build_points, validators
data/                # values.csv, points.csv, history-*.csv, def-ratings.csv (+ samples)
docs/                # architecture, decisions, specs, and the harness findings (below)
scrape.mjs           # league draft-recap + owner scrape (feeds analyze.mjs)
analyze.mjs          # per-manager scouting -> data/managers.json (bot model input)
```

## Key commands (`npm run ff -- <cmd>`)

- **Data/values:** `values` (VOR->$), `project`, `cheatsheet` (tiered board -> data/cheatsheet.md)
- **Validation:** `sim` (season-points), `backtest` (championship rate), `calibrate` (bot field vs
  real spending)
- **Live draft:** `attach`, `launch-practice` (mock), `enter-draft` (real), `preflight`,
  `auto-draft` (the full-auto bidder), `roster`, `board`, `read-block`
- **In-season:** `lineup --roster <csv>` (optimal-lineup recommendation)
- **Scouting:** `node scrape.mjs` then `node analyze.mjs` (per-manager tendencies)

## What the harness decided (see docs/edges.md, docs/validation.md)

- **Shipped (validated):** independent + current values, budget discipline vs an overpaying
  room, live inflation repricing (+~2 championship pts). ~18% titles draft-only / ~13%
  full-system no-lookahead vs the realistic field (2-3x random).
- **Rejected (measured neutral-to-negative, off by default):** automated waivers, per-position
  inflation, live scarcity/VONA premium, drain-nomination-as-auto (a human-only edge).

## Where planning lives

Roadmap, phases, and issue tracking are in the wiki:
`wiki/projects/project--ff-assistant.md` + `roadmap--ff-assistant.md`. Design rationale is in
`docs/decisions.md` (D1-D8); the draft-day operating procedure is `docs/draft-day-runbook.md`.
