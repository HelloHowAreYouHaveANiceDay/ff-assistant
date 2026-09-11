# CLAUDE.md — working context for Claude sessions in this repo

`README.md` is the tour and `AGENTS.md` is the headless-worker contract. This file is the stuff that
is expensive to rediscover: how to tell truth from noise here, and the traps that have already cost
real time. Read it before changing strategy, the sim, or anything that produces a number.

## The one rule

**The championship backtest is the only arbiter of a VALUE or STRATEGY change.** Not `ff sim`
(season-points proxy, over-rewards top-heavy rosters), not a live mock draft, not intuition.

```
npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
# shipped default: ~39% championships / 96% playoffs (random 6.3%). Rookies are now IN the pool by
# default (priced by draft capital, src/draft/rookieModel.ts); --no-rookies drops them. The rookie
# effect is NEUTRAL (paired ~-0.2pp) -- the arbiter now REPRESENTS rookies without a systematic edge.
# (The old "~33%" note was stale; the effective tripwire in docs/validation.md is ~39.7%.)
```

A materially different number means an input drifted — find it before doing anything else.

## How to know a result is real (this repo's hard-won checklist)

Most wrong conclusions here came from a measurement, not from the code under test.

1. **The unit of analysis is the SEASON, not the trial.** `n=800 × 25 seasons` is 800 noise re-draws
   over the same seasons; effective n is ~25. Seeds are common random numbers
   (`seed = s + 1 + yr*1000`), so every trial is a matched pair — use `--dump-trials <path>` +
   `scripts/paired-analysis.mjs` (McNemar + season-level bootstrap CI), not two aggregate percentages.
2. **Re-measure a candidate against the baseline you intend to SHIP**, never the one it was found on.
   Three positional multipliers each looked like a +1pp gain and then vanished or reversed sign when
   the baseline moved.
3. **Before believing a null, prove the lever is CONNECTED** — `scripts/lever-connected.mjs`. A dead
   lever and a real null produce identical flat lines.
4. **Before believing a gain, check a BROADER lever does not already explain it.** `multQB` was the
   global shading effect wearing a costume; it measured exactly 0.0 once `aggr` shipped.
5. **Selection is itself a winner's curse.** Picking the best of ~91 configs inflates its estimate:
   one cell's +3.4pp became +1.0pp on held-out seasons. Quote the holdout number.
6. **Validate a challenger model before letting it overrule a result.** An uncalibrated opponent book
   (median price $8 vs the room's real $2) briefly overturned a correct `aggr` value. Face validity
   first: `scripts/face-validity.mjs`, `scripts/sim-vs-mock.mjs`, `scripts/book-compare.mjs`.

## What the sim is, and where it is wrong

`src/draft/sim.ts` — 16 seats, second-price clearing (`min(bestMax, secondMax + 1)`, a fair model of
an ascending auction), bots from `data/managers.json`, scored on real weekly results with byes and
single-elim playoffs.

Two opponent books, and **a conclusion should survive both**:
- `--bot-book vor` (default) — bots price with `computeValues`, i.e. OUR OWN function. Self-referential;
  this is what hid the FLEX-baseline bug for months.
- `--bot-book rank` — an independent rank-decay book (`RANK_DECAY`, calibrated to the league's real
  price distribution), plus `--homogeneous` for a null field of identical league-average managers.

Documented limits, all measured:
- **Per-manager profiles have NO out-of-sample signal** — predicting an owner's held-out season from
  their own history is *worse* than assuming league-average (7.99pp vs 7.67pp, 44/92 wins). So
  `ff calibrate` is an in-sample fit statistic, not validation, and **per-owner targeting advice —
  including the cheatsheet's "drain plan" — is not trustworthy.**
- **The top of the price curve is the least reliable region**, which is exactly what `maxShare`
  governs. Bots now carry budget anxiety from `maxBuy`, bringing top price to ~$100 against a real
  $88–106, but treat elite-tier conclusions with more suspicion than mid-tier ones.
- `marketSd = 0.30` is an assumption `calibrate` never measures. The `aggr` optimum was swept across
  0.20–0.45 and held; re-check it if you lean on that parameter.

## Live-draft traps

- **`--app` drives the desktop app's embedded ESPN webview; plain `--port 9223` does NOT.**
  Playwright's `connectOverCDP` does not enumerate an Electron `<webview>` as a page, so `--port`
  silently hands draft verbs the app's own UI window. `src/browser/webviewPage.ts` bridges it by
  implementing the slice of the `Page` API `espnAuction.ts` actually uses — so `espnAuction.ts`
  stays unchanged. `scripts/webview-selftest.mjs` is its positive control (a shim that always
  returns null passes every null test).
- **`auto-draft` holds a single-instance lock.** Killing the launching shell does NOT kill the node
  tree on Windows — three concurrent agents once shared one seat and bid against each other. Git
  Bash `pgrep` cannot see Windows processes; use PowerShell `Get-CimInstance Win32_Process` and kill
  by exact PID.
- **Never run `enter-draft` against the real league before the room opens** — a duplicate connection
  kicks the seat. Use `launch-practice --app` to rehearse.
- Duplicate NOMINATIONS in the log are benign and were investigated: the repeat targets the same
  player and exactly one nomination results. Do not "fix" it again without new evidence.

## Config precedence (silent-failure risk)

`getConfig` deep-merges **stored** levers (`settings.config` in `data/ff.db`) OVER code defaults in
`src/draft/levers.ts`. Changing `DEFAULT_LEVERS` alone does nothing on a machine that already has a
stored value, and nothing warns you.

```
node scripts/read-config.mjs          # what the engine will ACTUALLY use — trust this
node scripts/set-lever.mjs <k> <v>    # writes AND reads back
```

After changing a default, verify the **flagless** backtest reproduces the intended number. A lever
that is defined but not wired reads exactly like a lever that does nothing.

## Shell traps on this machine

- **Backslashes do not survive a heredoc to Python**, even a quoted one. `"\\n"` arrives as a real
  newline, so an anchor containing `\n`/`\t` matches nothing and the edit reports success having
  changed nothing. Use the **Edit/Write tools** for anything with escapes or quotes.
- Backticks inside a double-quoted `python -c "..."` are **command substitution to bash**.
- Bash-tool cwd resets between calls — always `cd <repo> && ...` in one call.
- A backgrounded job survives a tool timeout and stays invisible to `ps`; two concurrent backtests
  turned a 2-minute job into a 2-hour stall. Run sweeps **sequentially** and check for orphans.

## Setup on a new machine

```
npm install better-sqlite3     # FIRST — a bare `npm install` aborts on a node-gyp source build
npm install                    #         and leaves tsx missing, so nothing runs. Retrying fails too.
(cd app && npm install)        # check app/node_modules/electron/dist/electron.exe actually landed
bash scripts/bootstrap-machine.sh
```

Levers travel in code; `data/ff.db`, `managers.json`, `history-*.csv` and the ESPN login do not.
Verified end-to-end on a clean clone: gates pass, config cross-checks, 72/72 tests, backtest 32.9%.

## Where things live

- Strategy/levers: `src/draft/{strategy,levers,values,sim,backtest}.ts`
- Findings + every rejected idea with its number: `docs/validation.md`, `docs/edges.md`
- Draft-day procedure and machine setup: `docs/draft-day-runbook.md`
- The MCP control surface (35 tools, shared with the in-app Assistant): `docs/mcp.md`. The count is
  `TOOL_NAMES.length` in `src/agent/agent.ts`, not a number to retype -- `scripts/copilot-mcp-smoke.mjs`
  asserts it. The last ten are the in-season copilot's, and the same ten decisions are reachable
  from a terminal as `ff copilot <verb>` through one dispatcher (`src/inseason/copilotActions.ts`),
  so a number printed in a shell and a number the Assistant quotes cannot differ. The tenth is
  `stream_recommend` / `ff copilot stream`: of the men nobody rosters, who to start this week -- at
  any of the six positions, since the 2026-09-09 owner decision widened `SHIPPED_STREAMING_POSITIONS`
  (`src/weekly/streamingServe.ts`) to all of QB/RB/WR/TE/K/DST on the decision-population measurement
  in `docs/validation.md`.
- The in-season decision surface and its limits: `docs/in-season-design.md`; the weekly model and its
  write-once scorecard: `docs/weekly.md`
- Recorded decisions D0–D10 (do not silently reverse): `docs/decisions.md`
- Planning/roadmap lives in the wiki, not here: `wiki/projects/project--ff-assistant.md`
