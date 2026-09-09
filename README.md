# ff-assistant

A full-auto fantasy football co-manager. It has two faces: a **TypeScript engine** (`ff`) that
runs an ESPN auction draft end-to-end and backtests strategies against real NFL history, and a
**desktop app** ("Fantasy Mission Control") that wraps that engine with a live, per-league board,
authenticated ESPN browsing, and an always-present AI **Assistant**. The end goal is a double-click
app a non-technical friend can run; the engine underneath is deterministic and validated.

## Status (2026-09)

- **Engine — working.** `ff auto-draft` fills a full legal roster in budget against a live ESPN
  auction, bidding our independent values with budget discipline and live inflation repricing. The
  strategy is validated against a realistic, per-manager-modelled field (below).
- **App — working.** The Electron app runs: a persistent Assistant, a league-synced value **Board**
  with live ownership, authenticated ESPN pages (My Team / Scoreboard / Standings / Draft Room), a
  **News** feed, and a **Data** page that renders the warehouse as a Dagster-style DAG with
  per-asset "materialize" buttons.
- **Config-driven.** Everything the ranking depends on — scoring, roster slots, budget, playoff
  format, levers — lives in one per-league `settings.config`. The sim, backtest, and values all read
  it, so the app can be handed to a friend with a different league and it re-tailors itself.
- **In-season copilot — working, read-only.** Nine decisions (season odds, weekly lineup, waivers,
  trade check, trade finder, handcuffs, depth risk, power rankings, playoff SOS) as callable
  functions over one sim context, reached identically from `ff copilot <verb>` and from the
  Assistant's MCP surface, almost all scored as a change in our championship probability. Verified
  end to end against the live league. See `docs/in-season-design.md`.
- **Warehouse — one key space, and the league's own history is in it.** Every table keyed on
  `player_sk` now shares a single surrogate-key space with the identity registry (7,939 of 7,939
  shared gsis ids agree, against 59 before), and `identity_rekey` records where every moved key went
  so a write-once table can be migrated rather than regenerated. Nine seasons of this league's real
  drafts, results and schedule are facts in the store (`fact_draft_pick`, `fact_team_season`,
  `fact_matchup`), reproducible by re-fetching, and they now feed the price model, the bot field, the
  positional gates and the season simulator's calibration. `docs/data-layers.md`.
- **Not yet built:** the in-season lineup *writer* (the recommend path works; the ESPN write tools
  are deferred until after the live draft), multi-league fan-out (one synced league today), and the
  SCORING half of the preseason odds accrual — `scorecard` freezes 32 rows of playoff/title
  probability and has no branch that scores them when the season settles.

## The three things it is

1. **A copresent draft/season agent.** The agent acts inside a real, logged-in ESPN session and
   never handles a password (login is manual, once). Two attach paths: **`--app`** drives the
   desktop app's own embedded ESPN webview (the validated path — all 10 live mock drafts ran through
   it) via `src/browser/webviewPage.ts`; without the flag it attaches to a `bro` browser session.
   Note a plain `--port <app port>` does NOT work: Playwright cannot see an Electron `<webview>` as
   a page and hands the draft verbs the app's own UI window instead. `src/browser/`.
2. **A validation harness.** Every strategy idea runs through a season+playoffs backtest on real
   historical NFL data before it ships. This has rejected more features than it shipped — see
   `docs/edges.md`, `docs/validation.md`. `src/draft/backtest.ts`.
3. **A desktop cockpit.** An Electron shell (`app/`) over the engine + a SQLite store, with a Claude
   Agent SDK Assistant that reads the live value board to answer draft questions. `src/agent/`.

## Stack

- **TypeScript (ESM), run with `tsx`** — no build step for dev; `src/ff.ts` is the CLI dispatcher.
  Node's built-in test runner (`node --test`, fault-injection suites in `test/`).
- **`better-sqlite3`** — a layered store (`src/db/`, `schema.sql`) is the single source of truth;
  every data source ingests into it (`src/data/`) and the board/values are marts over it.
- **Electron + electron-builder** — the packaged app (`app/`); vanilla-JS renderer, no UI framework.
- **`@anthropic-ai/claude-agent-sdk`** — the Assistant (`src/agent/`); the agent has read tools over
  the board/players/league, but the *bid loop itself is deterministic TS, no LLM* (decision D10).
- **`playwright-core` over CDP** — attaches to bro's persistent ESPN session; never launches or
  authenticates a browser itself.
- **Python via `uv` — legacy, superseded.** The original nflverse/FantasyPros pipeline; ported to
  the TS data layer (`src/data/*`). Kept for provenance only — see `tools/README.md`.

## Layout

```
src/
  ff.ts              # the `ff` CLI: every command dispatches from here
  agent/             # the Assistant: Claude Agent SDK tools over the board/league (agent.ts, auth.ts)
  browser/           # playwright-core CDP attach to bro's logged-in ESPN session
  db/                # better-sqlite3 store (db.ts) + schema.sql
  data/              # TS ingesters -> the store: ingest, assemble, news, projections, history,
                     #   advanced, rankings, nflverse, appdata, paths  (the data warehouse)
  draft/             # the draft engine
    values.ts        #   VOR -> auction $ values          scoring.ts  # per-league scoring model
    strategy.ts      #   Engine<->Strategy seam; bidder   levers.ts   # tunable strategy knobs
    espnAuction.ts   #   live draft-room reads            sim.ts      # auction sim + bot field
    managers.ts      #   per-manager bot models           scout.ts    # per-manager tendency mining
    backtest.ts      #   season+playoffs -> title rate    inflation.ts# live value repricing
    nomination.ts / cheatsheet.ts
  inseason/          # the in-season decision surface
    copilot.ts       #   the nine decisions as PURE functions over one SimContext, each result
                     #   carrying its own assumptions (schedule/trials/seeds/data stamp)
    copilotStore.ts  #   the read-only loading copilot.ts refuses to do (availability, depth, lines)
    copilotActions.ts#   ONE dispatcher for `ff copilot` and the MCP tools + the D3 action-log write
    lineup.ts        #   the optimizer                   handcuff.ts   # measured handcuff model
    rosterValue.ts   #   roster value under availability  waivers.ts   # the points-based scaffold
    espnTeam.ts      #   team-page scaffold (no writes exposed)
  news.ts            # news CLASSIFIER (category/severity -> draft flag); projections.ts # proj layer
app/
  main.js            # Electron main: window, IPC handlers (each shells the `ff` engine bundle)
  preload.js         # the IPC bridge exposed to the renderer
  renderer/          # the UI: app.js/app.css/index.html (two tab rows: leagues / pages) + dagre DAG
  package.json       # electron-builder config (NSIS installer -> ../dist-app)
test/                # node --test fault-injection suites
tools/               # legacy Python pipeline, superseded by src/data/* (see tools/README.md)
data/                # values.csv, points.csv, history-*.csv (+ samples); real per-league data gitignored
docs/                # architecture, decisions (D0-D10), specs, and the harness findings (below)
scrape.mjs / analyze.mjs  # league draft-recap + owner scrape -> per-manager bot model input
```

## Running it

- **CLI (dev):** `npm run ff -- <cmd>` — no build step (`tsx`).
- **App (dev):** `cd app && npm run build:engine && npm start` (electronmon hot-reload).
- **Build + publish the installer:** `cd app && npm run dist:installer` → `dist-app/` (Windows NSIS).
  `build:engine` first bundles the engine to `app/engine/ff.cjs` (esbuild); the app ships that bundle
  + a pinned node runtime, so the packaged app has no dev dependencies.
- **Check:** `npm run typecheck` and `npm test`.
- **New machine:** `npm install better-sqlite3` FIRST, then `npm install` (a bare install aborts on
  a node-gyp source build and leaves nothing runnable), then `bash scripts/bootstrap-machine.sh`.
  See `docs/draft-day-runbook.md`.

### Key commands (`npm run ff -- <cmd>`)
- **Data/values:** `ingest` (all sources -> store), `ingest-source <id>` (one asset + downstream),
  `values`, `project`, `cheatsheet`, `build-history` (per-league backtest data)
- **Identity (run in this order after `ingest-playerids`):** `build-identity` (the surrogate-key
  registry; `--rebuild` re-mints it from scratch and is a recorded migration, not a routine),
  `build-staging` (`stg_player`, which READS the registry -- it does not decide identity -- and
  writes `identity_rekey` plus migrates the write-once `scorecard_prediction` subjects through it).
  Every `player_sk`-keyed table must be rebuilt behind a rekey; `docs/data-layers.md` has the order.
- **Model pipeline:** `build-features` (the point-in-time `feat_*` tables -- run after
  `build-history`), `build-picks` (`fact_draft_pick` + `fact_team_season` + `fact_matchup`: nine
  seasons of this league's real picks, results and schedule, with the consensus as it stood and the
  auction state at each pick), `build-managers` (the sim's bot field, rebuilt from those facts
  instead of a browser scrape), `build-artifact --curve-only` (the projection artifact;
  `ff projections` REFUSES to run without one rather than falling back to a bare curve)
- **Validation:** `sim`, `backtest` (championship rate; `--full --no-lookahead` is the trustworthy
  mode), `calibrate`, `evaluate-projection` (nested CV through the SHIPPED projector, with the
  trainer re-invoked blind to each held-out season; `--dump-residuals`, `--keep-artifacts`),
  `residuals` (which slices the model is systematically wrong about)
- **Backtest arbiter flags that change what "38.2%" MEANS** (all off by default, all measured in
  docs/validation.md Phase 2b):
  - `--market ecr` -- the room drafts on the REAL preseason consensus with rookies in the pool and
    each bot holding an independent view, instead of on our own projection plus one shared error.
    2020-2024 only (the FantasyPros archive starts in 2020). `--market-noise 0` is the other honest
    calibration of it and the two answers are 26 points apart.
  - `--bot-book price|rank|vor` -- `price` is fitted on this room's 1,102 real picks from the six
    seasons the ECR archive covers (LOSO MAE $3.72 against $7.42 for `rank` and $7.61 for `vor`; on
    the held-out 2026 draft $4.70 against $5.59 and $7.23); `vor` is the default and is our own
    valuation function, i.e. a mirror.
  - `--bot-churn` -- the field works the waiver wire at this room's observed rate. Costs us 12.8
    championship points, which is about a third of the headline.
  - `--bot-noise` -- each bot's INDEPENDENT view, log-sd, default 0.20. With `--market ecr
    --market-noise 0` this is the whole of the room's disagreement, which is the honest arbiter
    Phase 2c measured; see docs/validation.md.
- **Model measurement (offline):** `scripts/price-loso.mjs` (leave-one-season-out price model vs both
  books), `scripts/market-noise.mjs` (the consensus's realised error by rank band),
  `scripts/verify-marginal.mjs` (the copula's marginals and both correlation stages),
  `scripts/season-calibration.mjs` (the season simulator's playoff and title probabilities scored
  against 114 real team-seasons, 2018-2025: real rosters, the real schedule, the real outcomes, plus
  a shuffled-outcome control. `scripts/sim-calibration.mjs` is superseded and refuses to run --
  it scored against a generated schedule and, absent a file nobody had, against outcomes drawn from
  the simulator itself).
- **Training (Python, off the hot path):**
  `uv run --with scikit-learn --with numpy tools/train_projection.py --db data/ff.db --out
  data/projection-artifact.json` -- the curve's own construction (window, monotone repair, ECR level
  weight, base form) is selected per position inside the fold, and the selected curve ships ON the
  artifact. And `tools/train_price.py --db data/ff.db --out data/price-model.json` for the market.
  Both artifacts carry a golden block the TypeScript loader recomputes; a disagreement over 1e-6 is
  refused.
- **Live draft (add `--app` to drive the desktop app's ESPN webview):** `attach`, `launch-practice`,
  `enter-draft`, `preflight`, `auto-draft`, `roster`, `board`, `read-block`. `auto-draft` holds a
  single-instance lock — two agents in one seat bid against each other.
- **Raw sources:** `ingest-raw --list` shows every `raw_*` asset (this league's own 15 seasons of
  auction history, nflverse games with the Vegas line and weather, injuries, depth charts, snap
  counts, the NFL draft, participation, contracts, the FFC ADP archive);
  `ingest-raw <id> [--seasons 2013-2025]` materializes one. Inventory: `docs/data-sources.md`.
- **Feature extensions:** `build-features-ext --seasons 2013-2025` builds `feat_player_week_context`
  (opponent, line, rest, prior snap and route share, the Wednesday and Friday injury reports,
  team-mates out, depth rank) and `feat_player_season_ext` (draft capital, contract year, prior-season
  usage, September 1 depth and injury, preseason ADP), plus `feat_coverage`. It never rewrites the
  Phase 2a tables, so it can run before or after `build-features`.
- **Weekly model (`docs/weekly.md`):** `build-weekly-features` (the point-in-time
  `feat_player_week_model` view, with a leakage guard that is fault-injected against its own
  detector), `evaluate-weekly` (nested by season; the decision metric is LINEUP REGRET, not RMSE),
  `scorecard --season 2026` (freezes predictions before kickoff and scores each settled week; the
  prediction table is write-once so a mid-season model change cannot rewrite its own record).
  Trainer: `uv run --with scikit-learn --with numpy tools/train_weekly.py --db data/ff.db
  --seasons 2010-2025 --out data/weekly-artifact.json`.
- **BYO agent:** `mcp` serves the Assistant's own 34-tool control surface over stdio MCP, so Claude
  Code (or any MCP client) can drive the draft and the season. `docs/mcp.md`; `claude mcp add
  ff-draft -- npx tsx <repo>/src/ff.ts mcp`.
- **In-season copilot (`ff copilot <verb>`)** — the decision surface, READ-ONLY, and the same nine
  functions the Assistant reaches as MCP tools (`src/inseason/copilot.ts`, one dispatcher in
  `copilotActions.ts`, so a terminal and the Assistant cannot quote different numbers):

  ```
  npm run ff -- copilot season-odds --schedule real --trials 3000
  npm run ff -- copilot lineup --week 5
  npm run ff -- copilot waivers
  npm run ff -- copilot trade-check --give "Chris Godwin Jr." --get "Jalen Hurts"
  npm run ff -- copilot trade-finder
  npm run ff -- copilot handcuffs --pos RB --free
  npm run ff -- copilot depth-risk --player "Breece Hall"
  npm run ff -- copilot power-rankings
  npm run ff -- copilot playoff-sos
  ```

  Almost everything is scored in ONE unit — the change in our championship probability, under common
  random numbers, with the run's own noise floor printed beside the ranking, because points cannot
  see a mandatory slot going empty or that this league pays on a 7-of-16 threshold. Every result
  carries an `assumptions` block (REAL vs GENERATED schedule, trials, seeds, data stamp) so a number
  cannot be quoted without its caveat, and every call is written to `action_log` at status
  `recommended` BEFORE it is returned (D3) — advice a human acts on is still the agent driving the
  team. `--schedule real` needs the app running and FAILS rather than silently substituting a
  generated schedule. `node --import tsx scripts/copilot-crosscheck.mjs --schedule real` checks the
  conservation laws and the bye/injury path against the live league.
- **In-season (other):** `lineup --roster <csv>` (offline optimal-lineup from a CSV), `sync-rosters`

## What the harness decided (docs/edges.md, docs/validation.md)

Headline: **38.2% championships / 96% playoffs** (full-system, no-lookahead, 25 scored seasons
1999-2024, random = 6.3%). Shipped levers: `aggr 0.7`, `benchDiscount 0.25`, `starterReserve 4`,
`maxShare 0.25`, `premium 2`, all positional multipliers `1.0`, inflation ON.

**Read that number with its arbiter attached (Phase 2c, 2026-09-09).** It is measured against a field
that drafts on our own projection plus one shared error of an asserted sd 0.30, and that never
touches its roster after August. Neither is true of this room. Give the field the REAL published
consensus with an independent view per bot AND the waiver wire — the honest arbiter — and the same
strategy wins **12-21%** rather than 33-41%, depending on which book the bots price with. Thirty
points, none of it a change to our strategy. The direction of every lever below survives; the
absolute rate is a statement about the opponent as much as about us. docs/validation.md has the grid.

**Recommended default (a recommendation, not applied).** Keep the flagless number as the regression
tripwire it already is — it reproduces to the season and that is its whole job — and quote
`--market ecr --market-noise 0 --bot-noise 0.20 --bot-churn --bot-book price` over 2020-2024, which
is **14.5%**, as the championship rate a plan should budget against. `price` because it is the only
opponent book FITTED on this room's own 1,102 picks and the best-calibrated of the three against nine
real drafts (8/10 metrics, against 7 for `rank` and 6 for `vor`). Then check the conclusion survives
the other two, per this repo's standing rule: the same cell reads 21.0% with `rank` and 11.9% with
`vor`. The DEFAULT is unchanged, because changing it would silently re-baseline every number already
recorded here.

- **Shipped (validated):** independent + current values; **bid shading (`aggr` 0.7)** — the biggest
  single lever, a winner's-curse correction worth ~+10pp; **`benchDiscount` 0.25** (a bench-only
  player cannot score, so he is not worth his standalone value, +4.4pp); live inflation repricing
  (+4.2pp, clamped [0.8,1.4]); points-weighted FLEX baselines in the value curve.
- **Rejected (measured neutral-to-negative, off by default):** all four **positional value
  multipliers** (QB/RB/WR/TE — each looked like a gain until re-measured against a corrected
  baseline, then vanished or reversed), automated waivers, per-position inflation, live
  scarcity/VONA, drain-nomination-as-auto, injury-proneness discount, rookie weighting.
- **Known model limits (documented, not hidden):** per-manager opponent profiles carry **no
  out-of-sample signal** — re-measured in Phase 2c on 112 team-seasons from nine real drafts, they
  are still no better than assuming league-average (11.51pp against 11.43pp, winning 56/112) — so
  per-owner targeting advice is not trustworthy; the sim's price curve is least reliable at the very
  top, which is what `maxShare` governs; and the **season simulator is over-confident**, measured
  against 114 real team-seasons: its playoff Brier beats a uniform baseline (0.2370 against 0.2451)
  but its TITLE Brier does not (0.0659 against 0.0652), and the 50-70% predicted playoff band
  realises 46% (`scripts/season-calibration.mjs`). Shrinking toward uniform does not fix it — chosen
  leave-one-season-out the held-out Brier gets worse — so no correction is applied.

## Where planning lives

Roadmap, phases, and issue tracking are in the wiki (`wiki/projects/project--ff-assistant.md` +
`roadmap--ff-assistant.md`). Design rationale is `docs/decisions.md` (D0-D10, incl. **D10**: the
engine is deterministic TS, no LLM in the bid loop). The draft-day procedure is
`docs/draft-day-runbook.md`.
