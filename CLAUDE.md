# CLAUDE.md — working context for Claude sessions in this repo

`README.md` is the tour and `AGENTS.md` is the headless-worker contract. This file is the stuff that
is expensive to rediscover: how to tell truth from noise here, and the traps that have already cost
real time. Read it before changing strategy, the sim, or anything that produces a number.

## The one rule

**The championship backtest is the only arbiter of a VALUE or STRATEGY change.** Not `ff sim`
(season-points proxy, over-rewards top-heavy rosters), not a live mock draft, not intuition. The
**PRIMARY gate metric is PLAYOFF probability** (the axis the sim has measured skill on: playoff Brier
0.2370 vs uniform 0.2451). **Title% is reported alongside as CONTEXT, not the gate** -- the sim CANNOT
predict the single-elim title (title Brier 0.0659 vs uniform 0.0652, P16 FAILED). This is D13
(`docs/decisions.md`); the arbiter (`scripts/cpcv.mjs`) gates on the playoff column, golden master
96.0% playoff (`--golden`, re-pinned by D15 now both title-edges are demoted), and prints title% as
secondary (`--golden-title` 38.5%).

```
npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
# shipped default: ~96% playoffs (PRIMARY gate) / ~38.5% championships (context; random 6.3%). The two former
# "edges" -- consensusBlend=1 and benchDiscount=0.35 -- were BOTH DEMOTED (D14/D15): each was title-only and
# NULL on the playoff gate the sim can actually predict, and neither survives family FDR. Shipped posture is now
# consensusBlend=0 and benchDiscount=0.25 (still a real discount; 0 collapses depth). `--consensus-blend 1` /
# `--bench-discount 0.35` reproduce the old title-tuned posture. History in data/experiments.jsonl, docs/edges.md,
# docs/decisions.md D13/D14/D15. Rookies are IN the pool by default (draft
# capital, src/draft/rookieModel.ts;
# --no-rookies drops them), a NEUTRAL effect (paired ~-0.2pp). (The "~39.7%" effective-format tripwire
# in docs/validation.md predates both the rookie rebuild and this edge; it is measured under the
# league's real 13-week/7-team format, a slightly different config than this flagless run.)
```

A materially different number means an input drifted — find it before doing anything else.

## Charter — how to work in this repo (standing rules, 2026-09-15)

Distilled from a long session that kept producing plausible-looking-but-wrong conclusions, and the
discipline that caught them (three of them were caught by the owner, not by any green check). These
govern HOW to apply everything below.

1. **No ship without a stop-and-confirm.** A change to a deployed artifact, a shipped value/lever, or
   anything outward-facing gets explicit owner sign-off BEFORE it lands — never as a side effect of a
   long autonomous chain. Refit/generate to a TEMP path, gate + serve-check, present the before/after,
   THEN swap. (The D23 weekly re-pin was done exactly this way; the sign-off IS the "safe stopping"
   that makes persistence safe rather than dangerous.)

2. **Pre-filter before the expensive screen.** Every candidate feature earns a full paired-floor screen
   only after a cheap orthogonality/predictiveness check (correlation, and partial-corr against the
   incumbent AND the level). It kills level-in-disguise and redundant candidates in minutes instead of
   hours — it caught that raw `prior_vol` was 0.58-correlated with the level the model already carries,
   which a naive screen would have ADMITTED for the wrong reason. Fail the pre-filter, skip the screen.

3. **Explain a surprising number before acting on it.** A delta, an anomaly, a "regression" is
   diagnosed to its input first, never trusted or shipped on face. The population-hash drift (benign
   2026-live-sync + build-method, NOT data loss) and the cja 17% outlier (real division-of-death +
   roster variance, NOT a bug) were both resolved this way. The one-rule's "a different number means an
   input drifted" applies to EVERY number, not just the backtest.

4. **A plausible-looking output is the default failure mode; positive controls + domain judgment are
   the defense.** Green tests, a passing golden block, and a strong-looking correlation can all be wrong
   in sophisticated ways (the "regression" that was a forward small-sample artifact; the level-proxy
   that looked orthogonal). Before believing a null, prove the lever is CONNECTED (positive control);
   before believing a gain, prove a broader lever doesn't already explain it; and keep the owner's
   domain read as the final arbiter — automation cannot tell "surprising-but-real" from "bug" as well.

5. **Persist through diagnosis, stop at boundaries.** Persistence is an asset for tracing a bug to its
   root, reproducing a store deterministically, or exhausting a feature frontier. It becomes a liability
   the instant it would cross an irreversible or outward-facing boundary without a checkpoint. Persist
   on the analysis; stop at the deploy.

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

## Browser access — always the Electron app, never Claude in Chrome

**Never use the Claude-in-Chrome tools (`mcp__claude-in-chrome__*`) in this repo.** All browser work —
reading ESPN pages, trade/message inboxes, the draft room, anything live — goes through OUR Electron
app's embedded ESPN webview, driven with `--app` (see the trap below). It carries the real ESPN login
and is the only surface the draft/in-season verbs actually control. If a task needs the browser, reach
for the `--app` path or the `ff-draft` MCP tools, not Chrome. (Standing owner instruction 2026-09-13.)

**RUN EXACTLY ONE APP INSTANCE — multiple instances split-brain (2026-09-13, cost ~an hour).** The
MCP browser tools attach to a FIXED CDP port (9223, first instance to bind wins); the app bridge is
whatever the NEWEST instance wrote to `data/app-bridge.json`. With two instances up, those are
DIFFERENT webview guests: the symptom is the bridge reading one page (e.g. the fantasy home) while
the MCP tools drive another (the clubhouse), and every click/read landing on the wrong one. It is
easy to end up with several — each `npm run start:plain` is a new instance, and killing the launching
shell does not kill the tree. Before driving the app, assert one instance:
`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where CommandLine -like '*ff-assistant\app*'`
and (excluding `--type=*` children) confirm a single main. Kill extras with `taskkill /PID <pid> /T /F`.
The `/read-frame` and `/click` bridge routes now resolve the ESPN guest by scanning `webContents`
for the one on `espn.com` (not `win`), which is robust to this — but the MCP CDP path still can't be,
so one instance is the rule.

**The ESPN Fantasy Chat (trade DMs / notes) is a CROSS-ORIGIN iframe (`chat.espn.com`).** The
top-document readers (`read_page`/`read_dom`, and the guest's own `executeJavaScript`) cannot see
into it, and the reads API (`?view=kona_league_communication`) carries chat message METADATA, not the
typed bodies. Read it with the `read_frame` tool / `/read-frame` bridge route (a main-process frame
walk; `scrollUp` loads a virtualized thread), and click INSIDE it with `press`/`/click` using the
`frame:"chat.espn.com"` arg. The hardened clicker fires exactly ONE click (a synthetic click PLUS
`el.click()` double-toggles a click-driven toggle like Pending Moves; the pointer/mouse down-up are
for controls that open on those, e.g. the chat launcher).

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
- A backgrounded job survives a tool timeout and stays invisible to Git Bash `ps`; two concurrent
  backtests once turned a 2-minute job into a 2-hour stall. That stall was **orphaned background jobs**,
  NOT CPU oversubscription: a single `ff backtest` is **single-threaded -- MEASURED at 1.03 of 32 cores
  (3.2%), 2026-09-14** (the `runPool` worker pool in `src/draft/simPool.ts` is used by nothing but its
  own self-test; the season loop is a plain synchronous `for`). So N concurrent backtests use N cores of
  32 and do NOT oversubscribe -- the real hazards are orphans invisible to `ps` and the shared `data/ff.db`
  writer. If you DO want to parallelise a sweep, use the `src/util/pool.ts` primitive (`pMap` +
  `withCpuSlot`; the global `cpuBudget` bounds the whole tree), each backtest a single-core task -- the
  same primitive the nested-CV fold loop now uses. Still check for orphans by exact PID after any fan-out.

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

- **Multi-league / multi-format (D24, `docs/multi-format-design.md`):** the model is tailored per league
  and keyed by FORMAT, not league. Scoring model (incl. Yahoo's non-linear/positional rules — milestone
  bonuses, per-position receptions, first downs, 40+ plays): `src/draft/scoring.ts` (`YAHOO_129048_SCORING`
  is ground-truthed 8/8 vs Yahoo's applied points). Format content-hash keys: `src/data/formatKey.ts`.
  Per-format target/model builders: `scripts/build-format-{target,features}.mjs` → `data/formats/<key>/`
  (gitignored; each has a ~1GB `features.db`, trained by `train_projection.py --db <that>`). Superflex
  value (slots as eligibility sets + laminar flex fill): `src/draft/values.ts` (`slotEligibility`,
  `resolveValueLeague` emits `flexGroups`). Yahoo waiver/trade/lineup analysis:
  `scripts/yahoo-{analysis,waiver-trade,ros-analysis}.mjs`. Snake-draft value and the per-format gate are
  both CLOSED (2026-09-16): the snake `DraftModel` is `src/draft/draftModel.ts` (WP11, reached by
  `ff backtest --league <id>` when the format's `draftType` is snake), and the gate is a per-format
  `golden.json` read by `scripts/cpcv.mjs --league <id>` (WP7) -- `data/golden.json` 96.0/38.5 for the
  incumbent, `data/formats/sc-a845f67652fb/golden.json` 99.2/39.8 for Yahoo 129048. CAVEAT, and it is on
  the file itself: the Yahoo number is a **CANDIDATE GOLDEN** -- an executor-pinned regression tripwire,
  not an owner-signed posture like D13/D14/D15 -- and its playoff axis is nearly saturated (8-of-12
  field), so read it as a downward tripwire and the title column for direction.
  **The one rule (D13) now applies PER FORMAT** — a value/strategy change is gated by that format's golden.
- Strategy/levers: `src/draft/{strategy,levers,values,sim,backtest}.ts`
- Findings + every rejected idea with its number: `docs/validation.md`, `docs/edges.md`
- Unscreened feature candidates (NGS efficiency, QB-change, durability) + the screening recipe: `docs/feature-frontier.md`
- The pre-deep-learning ladder (multi-year lags, shrinkage, pooling, a spline basis, an external
  projection, a boosted challenger) and each rung's verdict: `docs/validation.md` ("THE PRE-DEEP-LEARNING
  LADDER" sections). A rung that is a trainer FLAG rather than a column is gated by
  `scripts/gate-variant.mjs` (same paired-season 2.9*SE verdict as `admit-feature.mjs`; `--cand-rung
  challenger` scores a learner's sidecar predictions). Nothing on the ladder is a default until it clears
  the floor AND gets owner sign-off (D14/D15). **Two did, and shipped (D16, 2026-09-14): the projector's
  served heads for QB/RB/WR/TE are now gradient-boosted ensembles carried ON the artifact (schema 2,
  `learner: "gbm"`, walked by `projector.ts`, golden-checked against scikit-learn's own predict), and
  FFToday's preseason projection (`fftoday_proj`) is a default feature -- so the board needs the FFToday
  archive scraped each preseason.** `--learner ridge` reproduces the pre-D16 linear model. **The weekly
  track was redone on top of it (2026-09-14, docs/weekly.md section 7, D17):** the weekly season-line
  anchor is projected from a projection artifact at rebuild time, and a historical season's line MUST
  come from an artifact blind to that season -- `ff build-weekly-features --seasons 2010-2026
  --current-season 2026 --artifact-dir data/fold-artifacts-d16` (one blind artifact per season from
  `train_projection.py --holdout-season Y`; regenerate the directory whenever the projector changes).
  Without `--artifact-dir` every historical line comes from an artifact that has SEEN its season (the
  build warns per season); the weekly trainer/evaluator window is 2012-2025 because 2010-2011 cannot be
  fitted blind. `ff scorecard` rebuilds only the live season, which always uses the shipped artifact.
- **The season simulator starts from the season so far (D18, 2026-09-14):** `loadSimContext` seeds every
  trial with the SETTLED weeks' real standings and prices each rostered man at his preseason line updated
  on his played weeks (K = 6 weeks, `data/ros-blend.json`; `scripts/fit-ros-blend.mjs` refits it, in the
  per-scheduled-week frame -- the per-game frame is a scale mismatch and the script prints why). A week
  is settled only when its last NFL game day is behind today AND the store has scored rows, so after
  Monday night run `ff sync-actuals` then `ff ingest-raw league-rosters`; every copilot caveat states the
  seed. The same K also shrinks each player's level uncertainty for the remaining weeks by sqrt(K/(K+k))
  (`played.priorWeeks`). Gate: `scripts/season-calibration.mjs --at-week W --artifact-dir data/fold-artifacts-d16`,
  four arms (docs/validation.md D18: seeding is decisive from week 5, 8/8 seasons; the shrink clears the
  floor at week 8). `--schedule real` now falls
  back to the store's synced matchups when the app's CDP port is unreachable and says so.
- **The served weekly BAND is calibrated ON the artifact (D32, 2026-09-17, docs/weekly.md section 12):**
  `bandCalibration` -- per-position MULTIPLICATIVE conformal scales on p10/p90, fitted train-only out of
  fold by `tools/train_weekly.py --band-conformal-k 5` (a SECOND fold pass; `--conformal-k` calibrates the
  conditional heads and moves p50, this one must not). It is a SCALE and not the additive shift D16 uses
  one horizon up because the two-part p10 sits on the ZERO ATOM wherever P(zero week) > 0.10, and an
  additive offset would turn every ruled-out man's realised 0 into a below-p10 miss. Absent field = the
  old band byte-for-byte; a position with no entry is served uncalibrated; DST is NOT calibrated (its
  artifact comes from `tools/train_dst_stream.py`). Only 64% of scored rows claim a p10 above zero, so
  POOLED 10% below p10 is unattainable and is not the target -- read `<p10` beside that share, never alone.
  The band calibration moves NO mean and NO median, so it moves no lineup; assert that before reading any
  coverage table. A fit now costs ~4m34s instead of ~3m41s.
- **One per-week strength for a rostered man (D33):** `perGameStrength` (`src/draft/rosBlend.ts`), read by
  `src/draft/season.ts` AND by both fallback callers in `lineupRecommend`. The lineup used to price a man
  the weekly projector had no row for at the preseason line over 17 while the simulator priced him at the
  D18 blend. Neither historical harness can measure the change (`inseason-backtest-lineup.mjs` falls back
  to `td_ppg`; `lineup-stress.mjs`'s D33 arms report their positive control returning ZERO because those
  men have no `season_line_pg` in the weekly table) -- it is proved by unit test on a context that carries
  `rosPerGame`.
- **The lineup serve states its MARGIN (D34):** `LineupResultJson.contested` -- per slot, the seated man,
  the best legal sitting alternative, the gap, both bands, and the gap as a fraction of the band. Bands are
  loaded for BOTH objectives now. No number moves.
- Draft-day procedure and machine setup: `docs/draft-day-runbook.md`
- The MCP control surface (39 tools, shared with the in-app Assistant): `docs/mcp.md`. The count is
  `TOOL_NAMES.length` in `src/agent/agent.ts`, not a number to retype -- `scripts/copilot-mcp-smoke.mjs`
  asserts it. Besides the ten copilot decisions it now includes `read_frame`/`press` (read a nested
  cross-origin iframe like Fantasy Chat, and a hardened frame-aware click), `refresh` (rerun the data
  pipeline), and `propose_trade` (the gated ESPN trade write, dry-run by default -- shares
  `executeTradeProposal` with `ff propose-trade`). The last ten are the in-season copilot's, and the same ten decisions are reachable
  from a terminal as `ff copilot <verb>` through one dispatcher (`src/inseason/copilotActions.ts`),
  so a number printed in a shell and a number the Assistant quotes cannot differ. The tenth is
  `stream_recommend` / `ff copilot stream`: of the men nobody rosters, who to start this week -- at
  any of the six positions (`STREAM_SERVE_POS`). The weekly serve at every position is now the FORM
  model (`WEEKLY_SERVE` -> `CHALLENGER_WEEKLY_ARTIFACT`, `src/weekly/streamingServe.ts`) per the
  2026-09-12 owner override D11; the streaming artifact ships nowhere now, so `SHIPPED_STREAMING_POSITIONS`
  is empty. See `docs/decisions.md` D11 and `docs/validation.md`.
- The in-season decision surface and its limits: `docs/in-season-design.md`; the weekly model and its
  write-once scorecard: `docs/weekly.md`. **Since D27 (2026-09-17) the SERVED weekly artifact carries
  the expert-consensus columns (`ecr_wk_rank`/`ecr_wk_sd`; **26 features since D30 dropped the dead
  `inj_feed` -- a constant over the fitted population, whose removal is bit-identical on all fourteen
  seasons; the COLUMN is still built and audited, just not fitted**), so it now DEPENDS on the
  `rankings` routine running every week** -- the feed publishes only its latest scrape and a missed
  week cannot be backfilled; with the column absent the model degrades toward its season-line anchor
  and gives back the +0.036 pooled CRPS the consensus was admitted on (5/0 covered seasons).
  `ff evaluate-weekly`'s flagless `--features` is that artifact's own list, not the trainer's `all`.
- Recorded decisions D0-D34 (do not silently reverse): `docs/decisions.md`
- Current multi-league/multi-format finding list + fix plan: `docs/architecture-review-2026-09-16.md`
- Planning/roadmap lives in the wiki, not here: `wiki/projects/project--ff-assistant.md`
