# Design Decision Log

Each decision is stated with its rationale and the constraint it accepts. Implementation
sessions should not silently reverse these; if a decision looks wrong, raise it as an open
question in the wiki roadmap.

## D0 -- The COPRESENT DESIGN (the core thesis; supersedes where it conflicts)

**Decision:** The agent operates INSIDE the user's own live, logged-in browser session. It
perceives the league through the same rendered DOM the user sees, and acts through the same
controls the user would click. There is ONE data plane -- the live browser -- for BOTH reading
status/information AND taking actions. No separate API client, no credential extraction, no
server-side model of the league that can drift from what the user sees.

**Why:**
- **Auth is solved for free** -- the user is already logged in; nothing to extract or store.
- **Uniform across platforms** -- it lives at the UI layer, so ESPN and Yahoo work the same way
  without per-platform API reverse-engineering.
- **Trust through copresence (bidirectional).** The user and the agent are present in the SAME
  session: the user can watch the agent act in real time, take over the wheel at any moment, and
  hand it back. This is what makes an unattended full-auto tool trustworthy rather than a black
  box acting somewhere the user cannot see.
- **Browser automation is a proven path** in this shop (the bro pattern); we rely on it as the
  single mechanism.

**Accepted constraint:** DOM automation is slower and more brittle than a structured API, and it
is per-platform at the selector level. The mitigation is the mock-draft validation harness (see
D8) and per-platform selector modules. For draft day the binding constraint is the per-pick
clock -- reads + decision + click must complete inside it; validating that is the whole point of
mock-draft rehearsal.

**Supersedes:** the recon's hybrid-read suggestion (browser cookies + espn-api for fast reads).
espn-api / a structured API is now at most a LATER optional speed optimization, never the
primary path. All reads go through the browser.

## D1 -- Auth via the user's Claude subscription (OAuth), not an API key

**Decision:** The app authenticates to Claude using the end user's Max/Pro subscription through
the standard OAuth "Log in with Claude" flow -- the same one Claude Code CLI uses. The app
bundles the `claude` CLI; the Agent SDK reuses the stored credentials.

**Why:** The user is non-technical. Creating an Anthropic API key is the step they cannot do.
Subscription OAuth is one button. No per-token bill accrues to the developer or the user beyond
their existing plan.

**Accepted constraint (verified against Anthropic docs, 2026-08-31):**
- Per-turn token usage IS exposed: every response carries a `usage` object with
  `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
  These can be summed for session/weekly self-accounting.
- Subscription plan quota (the 5-hour rolling window and weekly caps that the CLI shows via
  `/usage`) is NOT programmatically accessible -- no SDK method, no endpoint, no response
  header. The `anthropic-ratelimit-*` headers track per-minute API throughput, a different
  system, not subscription quota.
- Therefore the app CANNOT display "percent of plan remaining." It can only display what it has
  itself spent, and detect plan exhaustion reactively via the error the backend returns
  ("You've hit your weekly/session limit").

**Supportedness:** Using subscription OAuth with the Agent SDK is within Anthropic's supported
patterns (same flow as the CLI). Reading plan-level quota is not a supported external interface
and must not be depended on.

## D2 -- Browser access via bro as a session SUBDRIVER (not bro-style; the real bro)

**Decision (refined 2026-08-31):** ff does NOT launch or log into a browser itself. **bro** (the
studio browser runner) owns the persistent, logged-in session -- `bro session start espn` holds a
real Chrome/Edge with a per-site persistent profile on a CDP port and records it in bro's shared
`sessions.json`. **ff attaches Playwright to that session** by resolving the port from bro's
registry (`bro sessions --json`), and exposes `ff bro <args>` as a passthrough -- exactly the
`bim bro` pattern. The user logs in once (2FA included); ff drives the authenticated browser over
CDP for both reads and actions. Same mechanism for Yahoo later (add a bro `yahoo` site).

**Why the refinement:** the earlier "bro-style" wording invited us to reimplement bro's launch +
CDP + session registry (we briefly did, in a `launch-chrome.mjs`). Reusing bro directly is the
shop pattern, avoids duplicating its persistent-profile/port machinery, and keeps coupling in the
correct direction (ff depends outward on bro). bro site configs are local per machine (bro
gitignores `sites/*`), like every other bro site.

**Why:** It is the most intuitive path for the user ("Connect Yahoo" -> a browser opens -> log
in normally) and it sidesteps ESPN cookie extraction (`espn_s2`/`SWID`) and Yahoo OAuth app
registration entirely. It reuses machinery that already exists in the `bro` repo.

**Accepted constraint:** Sessions expire; re-login is the user's only recurring manual step.
DOM scraping is brittle and platform-specific -- build and stabilize ONE platform end-to-end
before adding the second.

## D3 -- Full autonomy, with an action log (not per-action confirmation)

**Decision:** Claude sets lineups and submits waiver claims on a schedule with no per-action
approval gate. But every action is written to `action_log` (status=planned) BEFORE execution,
updated after (done/failed), and summarized to the user via `notify()`.

**Why:** The user explicitly wants "full auto" -- the magic is that it just plays. The action
log + notification is a black-box recorder that makes any move visible and explainable without
gating it.

**Accepted constraint:** Some roster moves are hard to reverse. The log + notification is the
mitigation, not prevention. Where a platform supports undo within a window, expose it.

## D4 -- User-adjustable token budget cap as the primary cost control

**Decision:** Because plan quota is invisible (D1), the app enforces its OWN budget: a
user-adjustable weekly token cap over a rolling window, computed from `usage_log` (numbers the
app fully owns). Checked BEFORE each scheduled run using a trailing per-run-type estimate, and
between turns within a run. On cap: pause + notify, with a one-tap "raise for this week."

**Why:** It is the one budget number the app can display and enforce accurately, and it gives
the non-technical user explicit, honest control over what their football bot costs.

**Two independent brakes, distinguished in the UI:**
- Cap hit (app's governor) -> user can raise it instantly.
- Plan limit hit (Anthropic's, caught as error) -> user must wait for reset.

## D5 -- Electron, not Tauri

**Decision:** Electron for the shell.

**Why:** The Agent SDK, CDP browser control, and node data scripts are all Node-native;
Electron ships Node. Tauri is lighter but would mean fighting the Node dependency. Revisit only
if installer size becomes a real problem.

## D6 -- One league, Yahoo/ESPN only, in v1

**Decision:** Design the data model for potentially many leagues but ship v1 for a single
league on one of Yahoo or ESPN. Sleeper (clean public API) is a cheap later add.

**Why:** Keep the flaky-scraper surface minimal until the spine is proven.

---

## D7 -- Engine is a CLI (the shop pattern); the agent reaches it via a CONSTRAINED tool surface

**Decision (2026-08-31; corrects the recon's "MCP-first" framing):** The football data + logic
layer is a **`ff` CLI** (Python -- espn-api-style reads via the copresent browser where needed,
nflreadpy, VOR/VONA, PuLP), consistent with the established studio pattern (bro, bim-cli, assist).
The CLI is the real engine: independently runnable, testable, and debuggable in a terminal.

How each caller reaches it:
- **Developer + interactive Claude Code:** invoke the `ff` CLI via Bash, exactly like bro/bim-cli.
- **The embedded UNATTENDED full-auto agent:** reaches a **fixed, thin tool surface** (custom
  Agent SDK tools, or a thin MCP wrapping the CLI) -- NOT an open Bash tool.

**Why a constrained surface for the embedded agent specifically (not MCP for its own sake):**
- **The log-before-act invariant (D3) is only enforceable through a controlled set of tools.** An
  open Bash tool lets the agent act without logging; a fixed tool surface makes every action pass
  through a wrapper that writes `action_log` first.
- **Unattended + arbitrary shell is the wrong risk posture** for something driving a browser on
  the user's machine with nobody watching. A tight allow-list (exactly `draft_pick`, `set_lineup`,
  `submit_waiver`, `read_board`, `query`, ...) is the safety boundary.

The shell/agent/browser layer stays **TypeScript** (Agent SDK is Electron-native). SQLite is owned
by the CLI (writes) with the agent reading via `ff` output -- likely no separate SQLite MCP needed.

**Accepted constraint:** two runtimes to package (Node via Electron + a bundled Python CLI).
Under the copresent design (D0) the browser is the primary I/O surface; the CLI is the supporting
data/math engine. Revisit the split only if a capable TS fantasy-stats library matures.

## D8 -- Draft day is Phase 1, validated via mock drafts (REVERSES the earlier "late-gate")

**Decision (2026-08-31):** The live draft is the FIRST and most important capability -- the real
ESPN draft is ~one week out. It is built and hardened NOW, and validated by running **mock drafts
on ESPN and Yahoo** (both have mock-draft lobbies available year-round) as a repeatable rehearsal
harness against the exact draft-room DOM the real draft will use.

The agent reads the draft board (available players, my roster, whose pick, the clock) through the
copresent browser session (D0), decides via VOR/VONA over pre-loaded projections + ADP, and makes
the pick through the draft-room controls. Auto-pick is the goal; the copresent design gives the
natural safety valve -- the user can override on the clock and the agent picks only if they don't.

**Why the reversal:** the earlier decision deferred draft as "highest risk." The risk is real but
the deadline makes it the priority, AND the mock-draft harness removes most of the risk: we can
rehearse the full pick loop dozens of times before it counts. A capability you can rehearse on
demand is not the same risk as one you meet cold on game day.

**Accepted constraint:** the per-pick clock is the hard gate -- read+decide+click must fit inside
it. Mock drafts exist precisely to measure and prove that latency. If auto-submit proves unstable
in mocks, the fallback is assist-with-countdown (still a win), decided from mock evidence, not
guessed.

## D9 -- Mock-draft rehearsal is the validation harness

**Decision:** Draft automation is validated by running real mock drafts (ESPN + Yahoo lobbies),
not by unit tests alone. Each mock is an end-to-end rehearsal of the copresent pick loop:
join room -> read board -> rank -> pick within the clock -> repeat. Success criteria measured
from mocks: pick made within the clock every round, correct roster construction, no missed picks.

**Why:** it is the only test that exercises the real DOM under the real clock. Per the machine's
own testing discipline: the layer that would notice a break here is a live draft room, so we drive
a live (mock) draft room.

## D10 -- The engine is TypeScript + DETERMINISTIC; no LLM in the bid loop (corrects D7)

**Decision (2026-09-02):** D7 framed the `ff` engine as a **Python** CLI reached by an LLM agent
through a constrained tool surface. What was actually built is the opposite on both counts, and D10
records the as-built truth:

- **The `ff` engine is TypeScript (ESM, run with `tsx`)** -- `src/ff.ts` dispatches every command;
  the draft reader/actor (`src/draft/espnAuction.ts`), strategy (`strategy.ts`), values (`values.ts`),
  and the sim/backtest harness are all TS, tested with `node --test`. **Python is only the offline
  DATA builder** (`tools/*.py`: nflreadpy -> projections/values + historical backtest data). So the
  runtime split is TS-engine + Python-data-scripts, not "a Python CLI."
- **The draft bid loop is DETERMINISTIC** -- values are VOR->$ from a static table; `maxBid` is
  budget + reserve + inflation arithmetic; nomination and pacing are rule-based. **No LLM runs in the
  bidding loop.** That is why the trustworthy test is the championship backtest + mock rehearsals,
  not a prompt eval. The Claude Agent SDK, Electron shell, and SQLite from D1/D5/D7 belong to the
  **packaged-app phase and are NOT built**; the engine writes a plain `data/draft-log-*.json` for the
  action-log role (D3) until that phase exists.

**Why:** a reader who trusts D7 would look for a Python CLI and an LLM in the bid path and find
neither, and would mis-scope any change. D0-D2/D8/D9 (copresent browser, bro session, mock harness)
stand as written; D7's *runtime/agent* framing is what D10 supersedes.

## Resolved design questions

- **Q1 (RESOLVED 2026-08-31): ESPN first.** The developer has a live ESPN league used to
  validate features. The ESPN scraper is built and hardened first; Yahoo is the Phase 5 second
  platform.
- **Q2 (RESOLVED 2026-08-31): Desktop notifications only for v1.** Email/text for the
  away-from-computer case is deferred (not ruled out; revisit after the desktop path works).
- **Q3 (RESOLVED 2026-08-31): No guessed cap default -- benchmark it empirically.** We instrument
  our own real test runs to measure actual per-run-type token cost, and set the default
  `weekly_cap_tokens` and the cold-start seed estimates from those measured numbers rather than a
  guess. Until a benchmark exists, treat the cap as advisory (log/warn, do not hard-skip) so
  early iteration is not throttled by an arbitrary ceiling.

## Open design questions

- **Q4: Credential/profile storage location + safety.** Where the persistent browser profile
  and the Claude credentials live on disk, and how the app communicates that these never leave
  the machine.

## D11 -- Ship the form weekly model over the streaming serve, as an explicit GATE OVERRIDE (2026-09-12)

The weekly serve (`WEEKLY_SERVE`, `src/weekly/streamingServe.ts`) now points all six positions at
`CHALLENGER_WEEKLY_ARTIFACT` (`weekly-artifact.json`) -- the two-part model over the full weekly
feature set, including the player's own trailing form (`t4_mean`). It replaces `STREAMING_ARTIFACT`,
shipped at D-time 2026-09-09.

This OVERRIDES the pre-registered ship gate, deliberately, and is recorded as an override rather than
dressed up as a pass. `ff evaluate-weekly --rosters 200` (holdout 2012-2025, 69,825 scored rows):
- The form model is MORE ACCURATE at every position: pooled CRPS **2.82 vs 3.34** (streaming) and
  **3.32** (season-line floor); RMSE **6.45 vs 7.02**; bias -0.03. Per position the CRPS win holds
  (e.g. RB 2.72 vs 3.37, WR 2.97 vs 3.46, QB 3.34 vs 4.65).
- It FAILS gate clause (b), coverage-given-positive, at **0.851 pooled** against the [0.75, 0.85]
  band -- its intervals are ~0.001 too wide. Streaming passes (b) at 0.827 and is the worse model.

The owner chose accuracy over the 0.001 calibration miss, and explicitly chose NOT to fit the gate by
shrinking the sd to squeak under 0.85 (the repo forbids gate-fitting). Two things make this safe to
reverse: it is a one-line change back to `STREAMING_ARTIFACT`, and `ff scorecard` now scores this
exact model against 2026 actuals every week (the predict->verify loop, wired 2026-09-12), so the
override is under continuous out-of-sample audit. What made the form model meaningful at all was
`ff sync-actuals` feeding real current-season results into `feat_player_week`, from which the forward
board derives the trailing form the model reads.

REVERSAL CONDITION: if the live 2026 scorecard shows the form model losing to streaming/season-line on
CRPS over a meaningful sample, revert `WEEKLY_SERVE` to `STREAMING_ARTIFACT`; or replace the override
with a calibrated refit (a train-only interval recalibration) that passes clause (b) on its own merit.

## D12 -- Keep the agent browser-tool surface BROAD (do NOT narrow per the paused hardening plan) (2026-09-13)

The 2026-09-09 architecture-hardening review proposed *narrowing* the Assistant/MCP surface -- removing
the unrestricted click/fill/navigate tools in the name of safety (see `wip/architecture-hardening`,
now dropped). This session went the other way and *extended* it (`read_frame`, `press`, a frame-aware
click, `refresh`, `propose_trade`), taking the surface 35 -> 39. Owner call: **keep it broad -- we want
agents to have a good capability set.** The narrowing items from that plan are explicitly NOT adopted.

Why this is safe without narrowing the read/interact tools:
- **Writes stay gated, not removed.** `propose_trade` is the ONLY ESPN write and defaults to a dry run
  (`confirm: true` to send) -- same gate as `ff propose-trade [--send]`. Draft/roster mutations are
  logged (D3) and the auto-draft **ownership lock** (extracted this session, race-free) serializes seat
  access, so a broad *action* surface still cannot double-enter or write silently.
- **Everything runs through OUR authenticated webview**, never Claude-in-Chrome (the standing browser
  rule) -- a broad surface is broad over one controlled, logged session, not the open internet.

So the guardrail is the WRITE gate + the lock + the single-session boundary, not a thin tool list.
REVERSAL CONDITION: revisit only if a broad read/interact tool is shown to cause an unintended
league-visible side effect that the write gate did not catch -- then gate that specific tool, don't
blanket-narrow.

## D13 -- The draft arbiter's gate is PLAYOFF probability, not title% (2026-09-13, rigor program WS5)

The championship backtest stays the ONLY arbiter of a draft value/strategy change (the "one rule"),
but the PRIMARY gate metric moves from title% to **playoff probability**. The golden-master
consistency check, the pass/fail verdict, and the headline line in `scripts/cpcv.mjs` now key on the
playoff column; title% is still computed and printed, explicitly labelled SECONDARY/context.

**Why:** the simulator's own calibration says it CANNOT predict titles but CAN predict the playoff
berth (`docs/validation.md`, P15/P16, per-season format):
- **title Brier 0.0659 vs uniform 0.0652 -- P16 FAILED** (1.0% WORSE than a coin flip). The single-elim
  championship is a lottery the sim has no measured skill on. Gating ship/no-ship on this axis was
  gating on the no-skill dimension.
- **playoff Brier 0.2370 vs uniform 0.2451 -- P15 HELD** (+3.3% skill). The berth is the LEARNABLE
  proximate target, and it is what a value edge can actually move.

The golden master was re-pinned on the primary axis: **97.0% playoff** (default `--golden 97.0`),
reproduced from two shipped-config dumps (`data/trials/struct-base.tsv`,
`data/trials/sweep-bench-discount-0.35.tsv`, both 42.35% title / 97.04% playoff -- the old 42.3% title
golden reproduced). The old title golden (42.3%) survives only as `--golden-title`, printed for
context and never gated.

**Interplay with D11 (they do NOT conflict -- different surfaces):** D11 ships the WEEKLY FORM model
on lineup ACCURACY (CRPS) and is the in-season start/sit surface. D13 sets the DRAFT arbiter's GATE
axis (playoff probability) and is the auction-value/strategy surface. Different models, different
metrics, different decisions -- D13 does not touch the weekly serve and D11 does not touch the draft
arbiter. Both share the same underlying honesty rule: gate on the axis the model has measured skill
on, and record an override rather than dress a miss as a pass.

REVERSAL CONDITION: if a future calibration shows the sim gaining real, out-of-sample skill on the
title Brier (beating uniform by a margin that survives the season-bootstrap), title% may return as a
co-primary or primary gate; until then, playoff% is the gate. Reverting is one edit: set the
`--golden` default back and re-key `consistencyOK` on `fullA` in `scripts/cpcv.mjs`.

## D14 -- Re-validation of the two shipped edges under the new regime; RECOMMENDATION pending owner sign-off (2026-09-13, rigor program WS6)

WS6 re-validated the two shipped draft edges -- `consensusBlend=1` and `benchDiscount=0.35` -- through the
four lenses the earlier work streams built: the effect-size floor (WS1, 2.9*SE), the selection-blind holdout
(WS2, confirm on 2021-2025), family-wide multiplicity (WS4, BH-FDR across the baseline_label family), and the
D13 playoff-primary gate (WS5). **This decision RECORDS the finding and RECOMMENDS an action. It changes NO
lever or default** (mirroring how D11 recorded an override honestly rather than dressing a miss as a pass).

**FINDING (per-edge four-lens verdict; full numbers + RAN-vs-CARRIED provenance in docs/edges.md):**

| edge | playoff (GATE) vs floor | family BH-FDR 0.10 | holdout confirm (2021-2024) | title% (context) |
|---|---|---|---|---|
| consensusBlend=1 | +0.73pp, res ~1.56pp -> NULL/underpowered | 98.5% -> 70.0% -- FAILS | +0.33pp [-3.33,4.67], 2/4 | +2.84pp [0.22,5.56] REAL; surrogate t=3.72 |
| benchDiscount=0.35 | +0.00pp, PBO 98%, res ~0.78pp -> NULL | 83.6% -> 18.2% -- FAILS | +1.67pp [0.67,2.67], 4/4 | +1.09pp [0.16,2.11] REAL; surrogate t~5-7 |

Both edges are **NULL on the D13-gated playoff axis and neither survives family-wide FDR at 0.10.** Both are
**REAL on the title/roster-ceiling** (the title% and the higher-powered surrogate index). This is the exact
tension edges.md already records: at this roster's ~96-97% playoff-berth rate the seed has almost no headroom,
so a playoff-null is EXPECTED and is not evidence the edge is fake; the value, if real, lives on the
title/roster-ceiling axis -- which is the no-skill axis D13 deliberately demoted from the gate.

**RECOMMENDATION (an OWNER DECISION, NOT YET APPLIED).** Under a strict reading of D13 (playoff% is THE gate),
both edges fail the gate and family FDR, so the mechanical new-regime action is to **DEMOTE both**, each a
one-line revert:
- consensusBlend: `--consensus-blend 0` (and set the stored lever / default back to 0)
- benchDiscount: `--bench-discount 0.25` (revert the 0.25 -> 0.35 re-optimisation)

The honest counter-case, which the owner should weigh before reverting: the playoff-null is a ceiling artifact,
not an absence of value; the title-aligned surrogate resolves both edges decisively (consensus t=3.72,
bench t~5-7); and edges.md's own D13 corollary states that for a team at a ~96% berth the title/roster-ceiling
is the operative objective. If the owner accepts that reasoning, the alternative to demotion is to **KEEP both
ON as explicitly recorded overrides** (the D11 pattern): kept on the title/surrogate axis, with the standing
acknowledgement that they do NOT clear the playoff gate D13 makes primary. benchDiscount has the marginally
stronger case (its 2021-2024 holdout playoff confirm was +1.67pp, 4/4 up, vs consensus's flat +0.33pp, 2/4).

Recommended path: surface both to the owner as one decision. Default lean, absent an override, is DEMOTE (it
is what D13's gate mechanically says); but this is genuinely a judgement about whether the playoff gate or the
title/roster-ceiling is the operative objective for THIS near-ceiling roster, so it is the owner's to make.
Neither revert has been applied.

REVERSAL/RESOLUTION CONDITION: this D-entry is resolved when the owner either (a) authorises the reverts above
(then a follow-up commit flips the levers + re-pins the golden master via `--consensus-blend 0
--bench-discount 0.25`, `--golden 96.0`), or (b) records a KEEP-ON override with the title/surrogate rationale.
Until then both levers stay at their shipped values (`consensusBlend=1`, `benchDiscount=0.35`).

**OWNER DECISION -- PER-EDGE, APPLIED (2026-09-13).**
- **consensusBlend: DEMOTED.** `DEFAULT_LEVERS.consensusBlend` 1 -> 0 (`src/draft/levers.ts`, status -> experimental)
  and the stored lever set to 0 (`node scripts/set-lever.mjs consensusBlend 0`; the `1 -> 0` confirmed a
  STORED 1 was overriding the default -- the config-precedence trap, so the code change alone would have been a
  no-op). It is null on the D13 playoff gate and fails family-wide FDR (WS4/WS6); its value lived only on the
  no-skill title axis. Still available via `--consensus-blend 1`; re-ship only on a powered playoff-axis re-test.
  - CONNECTIVITY (CORRECTED 2026-09-13): consensusBlend IS connected -- `backtest --consensus-blend 0` vs `1`
    moves the outcome (30%->40% champ / 95%->100% playoff on a small n=20/2-season probe; the magnitude is
    noise, the CONNECTION is real). An earlier draft of this bullet claimed the lever was "inert" and that
    FFToday "stops at 2024"; BOTH were wrong. `raw_fftoday_proj` has 2026 rows (344), and the
    `ff board --consensus-blend` / `lever-connected` checks that showed "identical / DEAD" were FLAWED: they
    draft from the STATIC data/values.csv and never re-assemble the board, so they cannot see a BOARD lever
    (lever-connected has since been fixed to say so instead of reporting a false dead). The demotion below
    rests SOLELY on WS6's powered playoff-null + family-FDR-fail, never on any inertness.
  - DATA GAP (RESOLVED 2026-09-14): `raw_fftoday_proj` had been missing SEASON 2025, so consensusBlend's WS6
    measurement carried a hole in 1 of 25 seasons. 2025 was scraped and filled (338 rows; now 2024:355 /
    2025:338 / 2026:344), and consensusBlend was RE-VALIDATED on the complete data: two fresh full backtests
    (consensus-blend 0 -> 39.7% champ / 96% playoff; 1 -> 42.3% / 97%) + a playoff-primary CPCV with the
    selection-blind 2021-2025 holdout. **PLAYOFFS (GATE) +0.22pp, CI [-0.32, 0.79], t 0.73, 6/21 up, PBO 57%,
    resolvable >= ~0.88pp -> still NULL.** Titles +2.10pp (also below its ~4.11pp resolution). Holdout playoff
    confirm +2.83pp but 3/4 with CI crossing 0 (underpowered). CONCLUSION: filling 2025 did NOT flip it -- the
    demotion is **CONFIRMED on complete data**, not pending. (Ledger: data/experiments.jsonl, config_hash 26c96dd1.)
- **benchDiscount: KEPT at 0.35 (no change).** Its 2021-2024 holdout playoff confirm was +1.67pp (CI [0.67,2.67],
  4/4 seasons up), so demoting it would discard a signal the selection-blind holdout supports; it is FLAGGED for
  a properly-powered playoff-axis re-test rather than reverted. (It still fails full-set family FDR -- the re-test
  is to resolve the holdout-vs-full-set tension, not to ratify it.)

This resolves D14.

## Rigor program -- acceptance runs (2026-09-14)

The three heavy acceptance runs the earlier work streams deferred, now executed:

- **benchDiscount powered playoff re-test (bears on D14).** Fresh full backtests (0.25 -> 38.5%champ/96%playoff;
  0.35 -> 39.7%/96%) + playoff-primary CPCV with the selection-blind 2021-2025 holdout: **PLAYOFFS +0.51pp
  CI[-0.03,1.08], PBO 8%, resolvable >=0.85pp -> NULL**; titles +1.43pp CI[0.35,2.48] PBO 1% -> real; **holdout
  confirm 2021-2024 = -0.83pp (1/4 up)** -- i.e. NEGATIVE, not the +1.67pp WS6 read (from surrogate dumps) that
  justified KEEPING it. So on a direct powered re-test, benchDiscount is null-to-negative on the playoff gate and
  real only on the no-skill title axis -- the SAME profile that demoted consensusBlend. **OPEN OWNER DECISION:**
  the keep-rationale did not survive; benchDiscount now looks demotable (revert `--bench-discount 0.25`). Not
  applied -- surfaced for sign-off, per the no-silent-revert rule. (Ledger: config_hash e625249e.)
- **contract_year admission floor (WS1) -- RESOLVED: leave-one-out says DROP (2026-09-14).** The earlier run
  was INCONCLUSIVE because `--candidate contract_year` added a feature already in the defaults (a no-op; the
  trainer refuses to duplicate a column). The follow-up is done: `admit-feature.mjs` now has a `--remove`
  (LEAVE-ONE-OUT) mode + a `--remove-features` trainer flag, fault-verified (errors on an absent column; the
  default artifact carries contract_year in 25 specs, the `--remove-features` artifact in 0). Re-run
  `--candidate contract_year --remove --seasons 2008-2025`: **the feature's own contribution is +0.0039 pinball
  (SE 0.0035), floor 0.0100, wins 3/9 -> DROP** (within the floor = noise); holdout 2021-2025 confirm +0.0181,
  floor 0.0593, NOT confirmed. This matches the trainer's own comment (train_projection.py:132-141: contract_year
  "PREDATES that floor and would not clear it"). **APPLIED (owner decision, 2026-09-14): DROPPED.** Removed from
  `INDICATOR_FEATURES` (the default fit list) in train_projection.py; KEPT in `EXT_INDICATOR` as an
  --add-features candidate and as a `feat_player_season_ext` column (data-layer coverage), so re-admitting it
  is one flag + a passing gate. Not because it hurt (it is inert, ~0 effect) but because WS1 requires a feature
  to clear the floor to be carried, and a grandfathered noise column is what the floor exists to catch. The
  shipped `data/projection-artifact.json` was REGENERATED without it (contract_year specs 25 -> 0), re-validated
  through the shipped loader + golden self-check (test/projector.test.ts green), and the flagless backtest is
  UNCHANGED at 38.5% champ / 96% playoff -- the correct gate for a projector feature is projection pinball
  (measured ~0), and the downstream championship number does not move. Re-admit later via `--add-features
  contract_year` only if a powered screen clears the floor.
- **Adjacent-season embargo (WS3) -- CONFIRMED at full scale.** The 18-fold `--embargo 1 --keep-artifacts
  data/fold-artifacts-2b-embargo` regen ran (P5 HELD, coverage 0.752 in band); the 2015 fold artifact EXCLUDES
  2014 and includes 2013 (max 2013). The embargo mechanism works end-to-end at full 18-fold scale.
- **Feature frontier screened (2026-09-14) -- all five candidates REJECT.** With the admission gate now able
  to screen new columns (and `--pos` for position-gated ones), the three raw-store signal families the frontier
  map flagged were wired as opt-in candidates and screened: durability (`prior_out_games`), roster-context
  (`qb_changed`), and NGS advanced efficiency (`prior_yac_oe`/`prior_ryoe`/`prior_cpoe`). NONE clears the
  2.9*SE effect-size floor (full table in docs/feature-frontier.md). The workload-share features already hold
  the resolvable signal; NGS is additionally data-starved (2016+, top players only). No shipped-model change --
  all five are DECLARED-not-fitted, kept as candidates for re-screening as data accrues. The wiring surfaced a
  producer-consumer contract bug (a fitted feature must be in projector.ts FEATURE_FIELDS or the loader refuses
  the artifact) that the loud guard caught -- recorded in feature-frontier.md as the positive-control lesson.

## D15 -- benchDiscount DEMOTED 0.35 -> 0.25 (2026-09-14, owner decision, APPLIED)

The OPEN OWNER DECISION D14 surfaced (the acceptance-run block above) is resolved: **DEMOTE.** benchDiscount's
powered playoff re-test is the same profile that demoted consensusBlend -- NULL on the D13 playoff gate, real
only on the no-skill title axis -- and, decisively, the keep-rationale from D14 did NOT survive a direct test.

- **Why the D14 "keep" was withdrawn.** D14 kept benchDiscount at 0.35 on a +1.67pp (4/4 up) 2021-2024 holdout
  *playoff* confirm. That number came from surrogate/dump re-scoring, not a direct backtest. The direct powered
  re-test (config_hash e625249e) measured the holdout 2021-2024 playoff confirm at **-0.83pp (1/4 up)** -- the
  opposite sign. The keep rested on a number a direct measurement reversed, so it does not stand.
- **The gate verdict.** Playoffs (D13 PRIMARY gate) +0.51pp, CI [-0.03, 1.08], PBO 8%, resolvable >= ~0.85pp
  -> **NULL/underpowered.** Titles (context) +1.43pp [0.35, 2.48], PBO 1% -> real, but on the no-skill axis D13
  demoted from the gate. Fails full-set family BH-FDR (WS4). Same shape as consensusBlend under D14.
- **APPLIED.** `DEFAULT_LEVERS.benchDiscount` 0.35 -> 0.25 (`src/draft/levers.ts`) AND the stored lever set to
  0.25 (`node scripts/set-lever.mjs benchDiscount 0.25`; config-precedence trap -- a STORED 0.35 was overriding,
  so the code change alone would have been a no-op). 0.25 is the pre-re-optimisation value, NOT off: some bench
  discount is real (0 collapses depth to 19.6% titles). The demotion reverts the 0.25 -> 0.35 tuning, not the
  lever. `status` stays "shipped" (0.25 is the shipped posture); still tunable via `--bench-discount 0.35`.
- Both title-only draft edges are now demoted off the playoff gate (consensusBlend D14, benchDiscount D15). The
  golden master is unaffected -- both demotions were already NULL on the playoff axis the golden pins (97.0%),
  so the flagless backtest playoff% does not move; see the verification note in docs/edges.md.

REVERSAL CONDITION: re-ship 0.35 only on a properly-powered playoff-axis re-test that clears the D13 gate and
family FDR -- the title/surrogate signal alone is explicitly not sufficient (that is what D13 decided).

## D16 -- The pre-deep-learning ladder: two ADMITs surfaced for sign-off, nothing applied (2026-09-14)

The question "what would you try before deep learning?" was worked as a ladder, one rung at a time, each
rung gated by the WS1 paired-season floor (`admit-feature.mjs` for a column; the new `gate-variant.mjs`
for a trainer flag), each mechanism fault-injected before its number was read, holdout 2021-2025 quoted
once. Full record: docs/validation.md ("THE PRE-DEEP-LEARNING LADDER" sections).

- **REJECT (nulls):** rung 2 multi-year lags (consistent, sub-floor; the Marcel blend confirms on the
  holdout but the decision block rejects), rung 3 games-weighted shrinkage and partial pooling across
  positions (both negative on the holdout), rung 4 a spline/hinge/log basis. The linear projector is
  exhausted along "more history, more shrinkage, more pooling, more basis".
- **ADMIT, pending sign-off:** rung 7, FFToday's preseason projection as a ratio feature
  (`fftoday_proj`): +0.33 pinball vs floor 0.28, holdout +0.50 (5/5), not explained by the ADP market
  rank (a null). Rung 5, a gradient-boosted challenger fitted inside the fold on the same rows: +0.37 vs
  floor 0.28, holdout +0.71 (5/5), robust to capacity; partly additive with rung 7 (each adds ~0.22 on
  top of the other, both confirmed on the holdout).

**This decision RECORDS the findings and RECOMMENDS two actions. It changes NO shipped number.** Per
D14/D15: (a) `fftoday_proj` may join the defaults only on owner sign-off. Its D13 playoff-gate check WAS
run (matched per-fold artifact sets 2012-2024, 1,800 paired trials, ledger `2388604e481c57d2`): playoffs
-0.58pp, CI [-2.08, +0.92], 3/8 up, resolvable ~2.4pp -> **NULL / underpowered**, holdout +0.17pp (3/4 up).
The system is already at 95.5% playoffs, so no projector change can resolve there; the precedent
(`contract_year`, `depth_rank_sep1`) is that a projector feature is gated on pinball with the draft number
reported. Status: ADMIT on the projector gate, NULL on the draft gate. It also makes the board depend on an
external archive that must be scraped each preseason (`scripts/scrape-fftoday.mjs`), which is an
operational commitment the owner should choose; (b) the boosted model has NO serving path and cannot ship
as it stands -- the recommendation is to build the tree evaluator (JSON ensembles on the artifact, a
TypeScript walker in `projector.ts`, a golden block), which this screen justifies, then re-gate the
served path end to end.

REVERSAL CONDITION for either, once shipped: the same WS1 gate re-run on a later season block, or a D13
playoff-gate null.

**APPLIED (owner decision, 2026-09-14): "admit the two admits".**
- `fftoday_proj` is a default `RATIO_FEATURES` member of `tools/train_projection.py`.
- The served heads for QB/RB/WR/TE are the boosted ensembles, carried ON the artifact (schema 2,
  `learner: "gbm"`, `boosted` block) and walked by `src/model/projector.ts`; the golden block's expected
  values are scikit-learn's own `predict()`, the trainer self-checks its serialisation against `predict()`
  before writing, and the loader refuses a perturbed leaf, a missing block or an out-of-range feature.
  `--learner ridge` reproduces the pre-D16 linear artifact.
- The boosted quantile heads FAILED the pre-registered P5 coverage clause on first measurement (0.729
  pooled vs [0.75, 0.85]); per D11's own remedy they are now split-conformally calibrated on TRAIN-ONLY
  out-of-fold residuals (`--conformal-k 5`, the shift folded into each head's baseline), and the re-run
  nested CV holds every P5 clause: RMSE 50.62 vs 55.54 curve, pinball 11.32 vs 13.16, coverage 0.757,
  bands 0.802 / 0.810 / 0.821 / 0.773 / 0.751 / 0.716. The served model re-gated against the linear one:
  +0.2485 pinball (9/9), holdout +0.3317 (5/5), confirmed.
- Regenerated: `data/projection-artifact.json`, `test/fixtures/trained-artifact.json`, `data/points.csv`
  (2026 board: QB startable share 21.2% -> 19.7%).
- NOT done, deliberately: the weekly track. Its season-line anchor is projected from this artifact at
  rebuild time, so `feat_player_week_model` must be rebuilt, the weekly model retrained and re-gated
  before the weekly table is touched (docs/validation.md D16 section; CLAUDE.md).

## D17 -- The weekly track redone on honest season lines; the D11 override retired (2026-09-14, owner: "redo the weekly", APPLIED)

In season, with week 1 one game from settled. Full record: docs/weekly.md section 7.

- **The lines were leaking, and D16 would have made it worse.** Every historical season's
  `season_line_pg` came from the single all-history projection artifact -- a model that had seen the
  season it projected -- recorded in docs/weekly.md as a "mild" inherited limit when the artifact was a
  ridge. Measured on the D16 boosted artifact: its 2024 line correlates 0.818 with 2024 actuals, the
  blind artifact's 0.778. The builder now takes `--artifact-dir` and projects each historical season
  with an artifact blind to it (`data/fold-artifacts-d16`), warns per season when it cannot, and the
  training window is 2012-2025 (2010-2011 cannot be fitted blind).
- **Retrained and re-gated on honest lines: GATE PASSED, every clause, on its own merit** -- (a) CRPS
  2.9036 vs 3.4182, (b) coverage 0.848 in [0.75, 0.85] with every position inside, (c) zero share
  0.249 vs 0.246. The D11 override (clause (b) at 0.851 on leaky lines) is retired.
- **`WEEKLY_SERVE` follows the per-position measurement:** QB/RB/WR/TE serve the two-part form model;
  K and DST serve the season-line floor (the form model ties the floor there to the third decimal and
  fails clause (a) by that hair). D11 had all six on the form model.
- Lineup regret +5.28 points per lineup over the shipped baseline (standard-15), +5.77 (deep-18).
- The write-once forward record keeps 2026 week 2 as it was frozen (D11 model, old lines); the redone
  serve reaches the record from the next frozen week. The live serve picked up the new artifact at once.
- Backups: `data/ff.pre-weekly-redo-2026-09-14.db` (the live store before the rebuild) and the two
  `*.pre-redo.bak.json` artifacts.

REVERSAL CONDITION: the live 2026 scorecard turning against the form model on CRPS over a meaningful
sample, or a re-gate on a later window failing clause (a)-(c); the one-line revert is `WEEKLY_SERVE`.

## D18 -- The season simulator starts from the season so far (2026-09-14, owner: "close this gap well", APPLIED)

Until now every in-season odds, trade, waiver and trade-finder number simulated the season from
scratch: 0-0 standings, preseason lines, whatever the date. Measured (docs/validation.md D18), that
from-scratch arm sits at playoff Brier 0.22-0.24 against a uniform floor of 0.245 at every checkpoint
from week 3 to week 11 -- it barely knew a season was happening.

- **Seeded standings** (`simulateSeasons` `opts.played`, built by `loadSimContext` from the SETTLED
  weeks -- last NFL game day behind today AND scored rows in the store -- with team scores from the
  started lineup, ESPN applied points where synced, synced actuals otherwise, unmatched starters named):
  playoff Brier 0.222 -> 0.180 at week 5, 0.236 -> 0.148 at week 8, 0.232 -> 0.099 at week 11, **better
  in 8 of 8 seasons at each, t -5.4 to -5.9**; a null at week 3. Sanity: with every week settled the
  seeded arm reproduces the realised 2025 field exactly (Brier 0.0000).
- **Rest-of-season lines** (`SeasonPlayer.rosPerGame` = (K*line + k*rate)/(K+k), K fitted by
  `scripts/fit-ros-blend.mjs` in the simulator's per-scheduled-week frame: **K = 6 weeks**, chosen in all
  14 leave-one-season-out folds, rest-of-season per-week RMSE 4.37 vs 4.93 line-only, -11%). On playoff
  Brier a small further gain from week 8 (-0.008 to -0.009, 5/8 seasons, t -1.6 at week 11), never a
  material cost. Shipped on its own gate (the quantity it models) with the odds-level check
  non-negative; reversal is `K` in `data/ros-blend.json` (delete the file = the old behaviour, reported).
- Every copilot caveat now states the seed ("from wk2: standings seeded from 1 settled week, ROS lines
  blend K=6 on 192 men" / "no settled week yet: full-season simulation from preseason lines").
- The gate is permanent: `scripts/season-calibration.mjs --at-week W --artifact-dir data/fold-artifacts-d16`.
- Also closed: `--schedule real` fell silently to a generated schedule whenever the app's CDP port was
  unbound; `loadSimContext` now uses the store's synced matchups and says which source served.

OPERATOR RULE: after the last game of a week, `ff sync-actuals` then `ff ingest-raw league-rosters`, and
the next decision runs from the settled state. Today (2026-09-14) week 1 has a game to play, so nothing
is seeded yet and every number is byte-identical to before; tomorrow it is not.

- **Level-uncertainty shrink (applied in the same pass, owner: "go").** `played.priorWeeks` = the same
  K = 6: the spread of each player's true level for the remaining weeks scales by sqrt(K/(K+k)) --
  parametric projection error and bootstrap season level alike, zeros untouched. No new parameter.
  Gated as arm D: null at week 3, -0.0015 at week 5, **-0.0037 +/- 0.0012 at week 8 (7/8, t -3.2)**,
  -0.0028 +/- 0.0011 at week 11 (6/8, t -2.7). Everything together vs the old from-scratch simulator:
  -0.100 at week 8 and -0.143 at week 11, better in 8 of 8 seasons. Recorded, not claimed fixed: the top
  reliability bin stays under-confident late (88.8% -> 97.1% at week 11), so the too-wide late-season
  spread is not the level; the pool's weekly variance for the remaining weeks is the next candidate.

## D19 -- The weekly model is gradient-boosted (dvp dropped), made robust to the 2026 missing-feature serve; injury-horizon HELD (2026-09-14)

> **GATE-7 BLOCKER RESOLVED (2026-09-14) -- missingness augmentation + NaN passthrough.** The first
> boosted `weekly-artifact.json` served HISTORICAL rows perfectly but COLLAPSED on the 2026 live serve:
> on any row whose availability/usage block is NULL -- forward/ROS weeks, the current week before the
> feed is built, and ALL 2025+ weeks (the injury feed stopped publishing report dates) -- the boosted
> zero-classifier routed the all-imputed vector into a pathological high-P(zero) leaf and projected
> locked starters at a few points (`ff copilot lineup` week 1: Jared Goff **4.57**, Breece Hall 4.86,
> Amon-Ra St. Brown 4.31; golden row 4, an all-missing RB, mean 4.11 / pZero 0.63). ROOT CAUSE: trees
> route on feature COMBINATIONS, and "everything imputed to its mean" is an out-of-distribution
> combination the historical training rows -- which almost all carry a real availability block -- never
> contained. The linear model is immune because it is additive (missing -> mean -> ~0 contribution ->
> the projection reverts to the season-line anchor).
>
> THE FIX (`tools/train_weekly.py`, `src/weekly/projector.ts`), applied identically in train and serve:
> (1) the boosted design feeds a MISSING raw value as **NaN** (`feature_value_nan` / `weeklyFeatureValueBoosted`),
> engaging HistGradientBoosting's NATIVE per-split missing direction -- not `spec['missing']` (which the
> linear heads still read); (2) **missingness augmentation** (`--aug-frac 0.5`, `MASKABLE_GROUPS` /
> `MASK_DROP_P`): a fraction of training rows are duplicated with the availability / usage / odds / form
> blocks masked to NaN at rates matched to the MEASURED 2026 serve regime, so the trees learn that an
> all-missing-availability row is a normal healthy player and fall back on the always-present anchors
> (`season_line_pg`, in every position's keep set, plus home / days_rest / week_no / td_games). The
> augmented copies keep their source target and are sampled uniformly, so the zero rate and level -- and
> gate clause (c) -- are preserved. A NaN-only split's `+/-inf` threshold is clamped to a finite
> sentinel (identical routing for every finite value); `boosted_self_check` proves the clamped walker
> still reproduces scikit-learn to 1e-9.
>
> AFTER: the same serve is sane -- Goff 17.7 (wk1) / 15.2 (wk3 forward) / 17.2 (wk2 with live-context),
> Hall 9.9, St. Brown 11.6; golden row 4 mean 9.09 / pZero 0.19; K/DST unchanged on the floor. Fault
> injection confirms the availability lever is still CONNECTED: on a synthetic elite QB (line 24), the
> availability block absent projects 26.3 (graceful, reverts to anchor) while an injected OUT
> designation collapses it to 1.4 / pZero 0.95.
>
> THE HONEST GAIN UNDER THE 2026 REGIME (`--mask-serve availability`, fit-with / serve-without, the
> exact state of the live team; paired floor, selection-blind 2021-2025 holdout): boosted STILL beats
> linear by **+0.110 CRPS, 5/0 seasons** with the availability block masked, versus **+0.126 CRPS, 5/0**
> full-feature. The boost's edge is NOT primarily an availability effect -- masking availability costs
> only ~0.015 CRPS of the ~0.126 edge; the rest is the nonlinear use of the anchors, form and odds that
> the live team always has. (2025, already feed-silent, is identical masked vs full at +0.044, a mask
> no-op that confirms the measurement.) So the boost, made robust, is a real gain for the live 2026 team,
> not a historical-only artifact.


The weekly serve at QB/RB/WR/TE (`CHALLENGER_WEEKLY_ARTIFACT` = `data/weekly-artifact.json`) is now a
gradient-boosted two-part model instead of the linear logistic+ridge one. Same machinery the season
model adopted one horizon up (D16): per fitted position the artifact carries a `boosted` block
(schema 2, `learner: "gbm"`) -- a HistGradientBoosting classifier for the zero stage and one regressor
per served head (mean + the quantile grid), depth 3, 300 rounds at 0.05, min-leaf 30, L2 1.0, the
quantile heads conformally calibrated train-only. K and DST stay intercept-only on the floor. The
linear `coef` heads remain on the artifact as the required fallback; `src/weekly/projector.ts`
overrides them with the ensemble walk only for the heads a boosted position names.

- **The seam is checked against the producer, not a second walker.** The trainer's `boosted_self_check`
  walks each serialised head with the same arithmetic `projector.ts` uses and refuses to write unless
  it reproduces scikit-learn's `decision_function`/`predict` to 1e-9; the artifact's golden block then
  carries the trainer's own predictions and the TypeScript loader recomputes them on the boosted path
  to 1e-6. A perturbed leaf is refused on both sides.
- **Paired-season floor (the decisive number).** boosted-no-dvp vs the linear shipped model, per-season
  pooled CRPS across the held-out seasons (`scripts/weekly-paired-floor.mjs`, unit of analysis the
  SEASON, common-random-number rosters): ADMIT on the selection-blind 2021-2025 holdout, **+0.126 CRPS,
  5/0 seasons** full-feature. Every gate clause (a) CRPS, (b) coverage-given-positive, (c) zero-share
  still passes. AND -- the decision-relevant number for the live team -- **+0.110 CRPS, 5/0** with the
  availability block masked to the 2026 serve regime (`--mask-serve availability`, fit-with / serve-without;
  see the resolved-blocker note above). The gain survives the regime the 2026 team is actually in.
- **Robust to the missing-feature serve.** The boosted heads read NaN for a missing feature (native
  HistGradientBoosting handling) and are fitted with missingness augmentation matched to the 2026 regime,
  so a locked starter whose availability/usage/odds block is absent falls back on the season-line anchor
  instead of an out-of-distribution leaf -- the way the linear model always did. `--aug-frac 0` reproduces
  the pre-robustness (collapsing) heads. The measurement-only `ff evaluate-weekly --mask-serve` /
  `--reuse-artifacts` flags produce the fit-with / serve-without floor above; they never touch the shipped
  serve path. See the resolved-blocker note at the top of this decision for the mechanism and the numbers.
- **dvp (`dvp_mult`/`dvp_n`) is DROPPED** from the weekly feature dictionary and the trainer's
  CENTER/SELECT_COLS as a neutral-under-boosting simplification: the D16-era rejection of dvp removal
  was under the LINEAR model (base commit `docs: record dvp_mult removal REJECTED`); under boosting the
  matchup signal it carried is subsumed and the paired floor is unchanged by its removal. It survives
  only as a dormant stored column (`schema.sql`, the `feat_player_week_model` storage list) and feeds
  the scorecard's legacy `shipped_week` comparison arm; the served `weekly` model never reads it. The
  streaming artifact (`train_streaming.py`, which serves nowhere -- `SHIPPED_STREAMING_POSITIONS` is
  empty) inherits the dvp-free CENTER/SELECT_COLS and was regenerated so it still loads under the
  narrowed dictionary.
- **Injury-horizon ADMITS under boosting but is HELD.** The injury-horizon block (an on-report flag plus
  the injury-episode tracker's accumulated games-missed) clears the paired floor on the holdout (+0.0078
  CRPS) once the learner is boosted -- a real signal the linear screen missed. It is NOT shipped because
  it is DEAD AT SERVE: the nflverse injury feed stopped publishing report DATES from 2025, so the episode
  table has no rows for 2025-2026 and the live path supplies no horizon column -- a coefficient learned
  on 2012-2024 would serve zero on every 2026 lineup. Rebuild pointer: it lives intact on branch
  `explore/weekly-boost` (the boost worktree); shipping it needs a live horizon feed first, then
  `--learner gbm` already fits it. (No injury-horizon code is in this ship, by design.)

REVERSAL CONDITION: the live 2026 scorecard turning against the boosted model on CRPS over a meaningful
sample. The one-line revert is `--learner linear` at rebuild and dropping the boosted artifact back to
the linear one; `src/weekly/projector.ts` serves the retained linear `coef` heads unchanged. Restoring
dvp is a second, independent revert (re-add `dvp_mult`/`dvp_n` to `WEEKLY_FEATURE_FIELDS` and the
trainer lists, rebuild).

## D20 -- DST is served by a matchup (streaming-feature) model, not the season-line floor (2026-09-14, APPLIED)

D17 left K and DST on the season-line floor because on the WEEKLY feature set they tied it to the
third decimal. That feature set did NOT include the point-in-time OPPONENT columns in
`feat_player_week_stream` -- what the opponent allows per position, the stadium, and the Vegas implied
total. A screen (scripts/`kdst-stream-probe.mjs`, `kdst-stream-export.mjs`, `kdst_stream_fit.py`) proved
DST weekly points ARE predictable from those columns, materially better than the floor. Reproduced
end-to-end on the SERVED arithmetic (`tools/train_dst_stream.py --gate`, blind LOSO):

- **Connection:** out-of-sample corr(pred, actual) **0.251 vs the floor's 0.043**; the opponent implied
  total is the dominant feature (a fault-injected leak feature dominates the real coefficients, so the
  harness can see signal).
- **Accuracy (the gate the sim can predict):** paired-season MAE improvement **+0.126 on the 2021-2025
  holdout, 5/5 seasons** (SELECTION +0.143, 9/9); CRPS agrees.
- **Decision (the edge that matters):** picking the model's top STREAMABLE DST (excluding the top-12
  always-rostered elites) beats the season-line pick by **+2.66 realized pts/wk on the holdout, 5/5**
  (model 8.72 vs floor 6.46; SELECTION +2.03, 9/9). The FULL-pool pick holdout is a NULL, as in the
  screen; the streamable tier is the one a manager actually decides.
- **K STAYS ON THE FLOOR.** On the same features K's streamable pick is a NULL and it LOSES the
  full-pool pick (8.20 vs 8.85). Nothing to ship; K is unchanged.

WHAT SHIPPED. `tools/train_dst_stream.py` fits a ridge mean head + three linear quantile heads on the
ratio `pts / season_line_pg` (so the WeeklyArtifact serve `line * clamp(ratio)` applies) from the twelve
matchup columns, full-data for `data/dst-stream-artifact.json` and blind per-season for the gate. It
REUSES `train_weekly.py`'s feature/serve arithmetic (the golden source mirrored in
`src/weekly/projector.ts`), self-checks `evaluate()` against scikit-learn's own prediction to 1e-9
before writing, and carries a golden block the TS loader re-checks to 1e-6. The route is a one-line
table move: `WEEKLY_SERVE["DST"] = DST_STREAM_ARTIFACT` in `src/weekly/streamingServe.ts`. Both DST
consumers read that table -- `stream_recommend` via `loadStreamingProjection`, and the season
simulator's weekly DST points via `loadWeeklyProjection` -> `projectStreamingWith` -- so nothing new
runs at the serve boundary and there is nothing new to collapse.

SERVE ROBUSTNESS (the D19 lesson, verified not assumed). Ridge was chosen over a GBM precisely because a
linear head cannot have a tree cliff: a missing matchup column imputes to its centred mean (0), routing
an unknown-matchup DST to `line * intercept` ~= the season-line floor. Verified on the live 2026 board:
`ff copilot stream --pos DST` for the CURRENT week (week 1: sane, START MIN D/ST 5.51, top free TEN D/ST
7.26, differentiated by matchup) AND FORWARD weeks 10/15 where `opp_implied_total` is entirely absent
(0 non-finite rows; projections narrow to 5.4-6.3, i.e. degrade to ~the floor, no NaN/collapse).
`test/dst-stream-serve.test.ts` locks this in.

REVERSAL CONDITION: the live 2026 scorecard turning against the DST model, or a preference to simplify.
The one-line revert is `WEEKLY_SERVE["DST"] = SHIPPED_WEEKLY_ARTIFACT` in `src/weekly/streamingServe.ts`
(back to the floor); the artifact and trainer can stay on disk unused.

## D21 -- Per-position consensus blend: consensusBlendQB DEFAULT 0.5 (QB toward market); RB/WR/TE stay 0 (2026-09-14, APPLIED)

The projector is anti-predictive at QB out of sample (b_proj -0.016), so its QB ORDERING is worse than
the FFToday preseason consensus. `consensusBlendQB` now defaults to **0.5** -- the QB board ordering (and
the proj_pts persisted from it) is blended halfway toward the FFToday consensus. RB/WR/TE stay at 0.
The transform is the existing per-position one (`consensusWeights` in `src/draft/levers.ts`, applied at
board assembly `src/data/assemble.ts` and, identically, in the draft arbiter `cmdBacktest`), so the same
posture reaches the draft board AND the in-season simulator (`loadSimContext` reads `board.ProjPts`).

WHY QB, AND WHY 0.5. Three measurements, on the axes the sim can actually predict:

- **Projection accuracy (OOS, per-fold):** QB->market lifts Spearman **+0.024, CI excludes 0, 10/12
  folds**. This is the direct evidence the projector's QB ordering is the weak link and the market is
  better.
- **Draft playoff gate (D13 primary axis): NULL, i.e. HARMLESS.** The flagless golden-master draft
  backtest with QB=0.5 default reproduces **96% playoffs (golden 96.0% +/- 3.0pp) / 39.5% titles**
  (`npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150`) -- unchanged
  from the pre-blend golden. Paired, the draft effect is -0.24pp (within noise). So this ships on a NULL
  draft gate, exactly as a change justified by projection accuracy + in-season calibration should.
- **In-season simulator calibration (the real gain):** `scripts/season-calibration.mjs
  --artifact-dir data/fold-artifacts-d16` (2018-2025, 3000 trials, seed 7, per-fold artifacts blind to
  each season). Baseline (blend 0) playoff Brier **0.2294**, skill vs uniform **6.4%**; with QB=0.5 (env
  `BLEND_QB=0.5`) playoff Brier **0.2244**, skill **8.4%** -- better in **7/8 seasons** (only 2020
  regresses, +0.003). Title stays no-skill both arms (0.064), as expected on the axis P16 failed.

WR MUST STAY 0. The projector has a REAL out-of-sample edge at WR (+0.25 slope); blending WR toward the
market destroys it. RB/TE showed no reason to blend. This is why the lever is PER-POSITION rather than
the old scalar `consensusBlend` (demoted to 0 by D14): a single global blend cannot help QB without
hurting WR.

WHAT SHIPPED. `consensusBlendQB` spec default 0->0.5, status experimental->shipped, in
`src/draft/levers.ts` (DEFAULT_LEVERS derives from the spec). The stored `data/ff.db` config carries
`consensusBlend: 0` but no per-position key, so the deep-merge (`{...DEFAULT_LEVERS, ...stored}` in
`getConfig`) leaves QB=0.5 live flagless -- confirmed by `node scripts/read-config.mjs` +
`consensusWeights` returning `{QB:0.5,RB:0,WR:0,TE:0}`. The 2026 board was rebuilt (`ff assemble`): Goff
moves QB4->QB6 (ProjPts 240.2->232.8), pulled toward his market ECR (QB15); `ff copilot power-rankings`
and `ff copilot lineup` serve clean (no NaN/Inf, finite projections).

REVERSAL CONDITION: the live 2026 scorecard turning against the QB blend, or a powered re-test failing.
The one-line revert is `consensusBlendQB` default back to 0 in `src/draft/levers.ts` (falls back to the
scalar `consensusBlend`, i.e. off) -- then rebuild the board with `ff assemble`.

## D22 -- Injury availability restored for the dateless (2025+) feed; weekly model refit on it; injury-horizon HELD (2026-09-15, APPLIED)

The "injury feed is dead from 2025" limitation (weekly.md section 5, D17) was NOT true -- it was the same
class of error as the DST-release bug: nflverse dropped the `date_modified` column in its 2025 injuries
file, so `raw_injury` held week-keyed `report_status`/`practice_status` but empty `report_date`, and the
availability builder (which places each filing at its Friday date) dropped every undated row. So
`feat_player_week_model`'s availability block (`inj_out`/`prac_*`) and `feat_injury_horizon` were NULL for
all of 2025 and the live 2026 serve -- which is WHY D19's boosted weekly model had to be made NULL-robust.

- **The fix (data pipeline).** A dateless fallback in `src/features/sources/weekContext.ts`/`injuryDuration.ts`:
  when a season's injury rows carry no usable date, read the week-keyed report directly (the nflverse
  weekly file IS the consolidated FINAL pre-game report -- point-in-time-safe for a week-w feature).
  Historical dated path (<=2024) byte-identical (SHA-256 verified); the leak guard HELD on both dated
  (2019) and dateless (2025) and is provably connected (fault injection moves 9868 cells). 2025 now
  populated (inj_out 429 Out; feat_injury_horizon 1781 rows), spot-checks pass (Kirk/Godwin/Likely Out).
- **Frontier test A -- refit the boosted weekly model on restored availability: SHIPPED.** Retrained on
  the fixed data; 2025 CRPS 2.94->2.78 (+0.16), other 13 seasons flat, lineup regret better; golden
  self-check holds. The paired floor "rejects" only because the gain is concentrated in the one broken
  season -- not a regression. **The real win is live: the 2026 serve now READS real injuries** (a player
  marked Out is downweighted -- Tua 9.1->1.85 -- instead of NULL-imputed). Shipped as `data/weekly-artifact.json`.
- **Frontier test B -- injury-horizon into the weekly first stage: HELD.** It ADMITS the paired floor
  historically (+0.00546 CRPS, 5/0) even against the availability-restored baseline -- genuinely not
  redundant on past data -- but it is DEAD at the live serve and serving it empty ACTIVELY HURTS: the
  live horizon path (`build-live-context`) supplies no horizon rows for the current week, and in that
  empty regime the ih model is -0.0095 CRPS WORSE. The fix restored the ARCHIVE feed (training +
  backtests), not the LIVE horizon path. Wiring stays dormant (off by default; branch `explore/ih-weekly`).

Also scoped a hindsight leak-guard (featuresExt "ADP before first kickoff") to COMPLETED seasons only --
the live 2026 season legitimately anchors its ADP at the 09-09 opener; the guard still fires for every
finished season. REVERSAL: the fix is a pure addition (dateless branch); to revert the refit, restore the
prior `weekly-artifact.json` and `--learner`/config are unchanged.

## D23 -- Weekly artifacts re-pinned to the D17-blind decision population (2026-09-15, APPLIED)

After a session that pulled in new raw data (pbp backfill, injury/snap/depth-chart refreshes) and rebuilt
`feat_player_week_model`, the three pinned weekly artifacts (`weekly-artifact.json`, `-lineonly`,
`streaming-artifact.json`) failed their population-guard tests: the store's `populationHash` had moved
`3898c9dacbc5ae40` -> `7ca2e2be49fc5aa7` and the D22 pin no longer matched, so the live weekly serve was
falling back to the season-line floor.

- **The drift is BENIGN, verified, not a data regression.** Every historical input is stable
  (`feat_player_week` 09-10, `feat_player_season` 09-12, projection + `fold-artifacts-d16` 09-14,
  `fact_roster_week` unchanged). The delta is two small pieces: (a) ~99 rows of 2026 LIVE drift (the
  board/roster legitimately changed this session), and (b) ~245 rows of historical build-method -- the D22
  pin was built with a higher-coverage (no-blind) line population; the D17-correct **blind**
  (`--artifact-dir data/fold-artifacts-d16`) build gives 79,567 historical. The 2026 component drifted
  irreversibly, so `3898` cannot be reproduced -- the artifact MUST be re-pinned.
- **Fix: refit the three artifacts on the D17-blind store and re-pin to `7ca2`.** Feature set UNCHANGED
  (weekly 25, streaming 37). A trap was caught and avoided: `rz_share_td` had been added to
  `train_weekly.py` `ALL_FEATURES`, so `--features all` would have silently shipped the rejected weekly
  candidate -- the refit pins the explicit shipped feature lists instead. Serve-check passed (consumer
  probe golden block to 1e-6; boosted heads self-check vs sklearn to 1e-9).
- **The re-pin changes nothing material (measured).** Refit vs shipped over all 2026 player-weeks: mean
  |Δmean| 0.39 settled / 0.44 forward, no systematic bias, p95 |Δ| ~2 pts, across every position. The
  blind refit is serve-equivalent AND removes the latent no-blind line inconsistency the D22 build carried.
- **Two known follow-ups (not blockers):** (1) `populationHash` includes the volatile LIVE season, so it
  goes stale on every in-season roster sync -- the pin should exclude the live season (a `population.ts`
  change) so a routine sync stops breaking the guard. (2) Rare extreme-form forward outliers: a hot-start
  player with one big game (e.g. Bijan post-27-pt week) is projected aggressively on FORWARD weeks (mean
  ~2.7x line) -- a forward small-sample regression issue, present in both artifacts, worse in the refit, an
  edge case only.
- REVERSAL: restore the prior `weekly-artifact.json` / `-lineonly` / `streaming-artifact.json` (the pre-swap
  copies are in the session scratchpad and git history). Feature set and `--learner gbm` config unchanged.

## D24 -- Multi-format architecture: the model is keyed by FORMAT, not league (2026-09-16, owner: "make it multi league... the edge comes from customizing config to each league", APPLIED for scoring/projection/value)

The system runs more than one league, and the edge is a model TAILORED to each league's rules, not one
model stretched across formats. The design separates three identities that had been one -- **League** (an
account you manage, keyed by `league_id`), **Format** (the ruleset), and **Model** (the trained artifacts +
values) -- and keys the Model by the FORMAT, so two leagues with the same rules share one model. Full design
+ verification ledger: `docs/multi-format-design.md`. The second league (Yahoo 129048: superflex, full-PPR,
bonus scoring) is the proving ground: its scoring, projector and value book are trained and verified
per-format (below), but nothing in `src/` reads `data/formats/` yet -- the resolver that would make the
board/backtest/in-season paths actually serve the Yahoo model is the subject of the 2026-09-16
architecture review (`docs/architecture-review-2026-09-16.md`, findings F-2..F-4).

What is APPLIED (each with an ESPN-byte-exact positive control, so single-format behavior is unchanged):

- **Scoring generalized** (`src/draft/scoring.ts`). `ScoringRules` gained OPTIONAL non-linear/positional
  terms -- yardage milestone bonuses, per-position receptions (TE premium), first-down points, 40+ yard-play
  points. A ruleset that omits them scores byte-for-byte as the old linear model. `YAHOO_129048_SCORING` was
  ground-truthed **8/8 exact** against Yahoo's own applied points. Every component was already in the
  nflverse feed, so no re-ingest was needed. `scoreWeek(r, s, pos?)` is now position-aware.
- **Layered format keys, partially built** (`src/data/formatKey.ts`): the module exports `scoringKey`
  (projection target + heads) and the `canonicalJson` helper it is built on. `valueKey` (value book) and
  `formatKey` (strategy + gate) are DESIGNED (see the layering above and `docs/multi-format-design.md`)
  but do not exist as functions yet, and no resolver walks `config -> format -> artifact paths`. The gap
  between this design and the code, and the fix plan, is the subject of the 2026-09-16 architecture
  review: `docs/architecture-review-2026-09-16.md` (finding F-2).
- **Per-format target + model**: `buildHistory` gained an `outDir`; a format's re-scored history + trained
  projector live under `data/formats/<scoringKey>/` (a copy of the store with `feat_player_season` rebuilt
  under the format's scoring), trained by the SAME `train_projection.py --db <that>` -- no python change. The
  ESPN active files are never touched. `data/formats/` is gitignored (regenerable; each holds a ~1GB db).
- **Superflex valuation** (`src/draft/values.ts`): roster slots are modeled as ELIGIBILITY SETS
  (`slotEligibility`) and filled by a laminar greedy that reduces byte-for-byte to the old single-flex fill
  for ESPN and correctly pulls QBs into a `Q/W/R/T` slot -- deepening QB replacement from ~QB13 to ~QB25.
  QBs go from **2/24 to 8/24** of top value under Yahoo. K/DST reserve is now per actual slot (0 for a
  skill-only league). `resolveValueLeague` emits `dedicated` + `flexGroups` beside the legacy `starters`.
- **In-season**: the D18 rest-of-season blend (`rosPerGame`, K=6) is applied per format to fold the season
  so far into the value (`scripts/yahoo-ros-analysis.mjs`). K is currently a shared NFL-level constant.

NOT yet done (tracked in `docs/multi-format-design.md`): per-format championship GATE (each format's own
golden number, lazily); a SNAKE-draft value/backtest path (the draft engine is auction-only -- not needed
for the in-season analysis, which starts from the current roster per D18); Yahoo-native market anchors
(`fftoday_proj`/`ecr` are half-PPR-scaled features the model rescales); refitting the ROS blend K per format;
verb/UX threading of `--league` through every surface. The one rule (D13) still gates every value/strategy
change -- now PER FORMAT, against that format's golden.

## D25 -- Three approved in-season corrections (2026-09-16, owner sign-off on the three "Open, needing
OWNER SIGN-OFF" items of `docs/architecture-review-2026-09-16.md` section 5; executed as WP10)

Each of the three moves a live ESPN in-season number, so each was applied the charter way: arbiter
measured BEFORE, change applied, arbiter measured AFTER with the SAME command and the SAME seeds, and
the before/after written down here. All three were APPLIED. The store was mutating under the session
(other executors), so the calibration arbiter was pointed at a VACUUM snapshot (`--db`) and both arms
of every pair read the same bytes; the `reg` arm reproduces the pre-change run exactly, which is the
positive control that the flag is the lever and the snapshot is the live store.

### D25.1 -- The streaming replacement level is in the `/17` frame, not `/regWeeks`

**What was wrong.** `src/draft/simContext.ts` built the per-position streaming floor as
`seasonPts / regWeeks` (13 for ESPN 462233) while every consumer compares it against a `proj / 17`
quantity -- `season.ts` prices every rostered man at `rosPerGame ?? proj / 17`, and `emptySlotPoints`
puts this floor straight beside those numbers. The floor was high by 17/regWeeks = **1.3077x**, so a
starting slot nobody can fill was worth MORE than it is, which systematically flattened the cost of
thin depth: every bye the bench cannot cover, every injury week, every depth-risk question.
`src/draft/sim.ts` already divided by 17; simContext was the odd one out. Fixed at the PRODUCER, so
there is now exactly ONE frame in the in-season stack (the `NFL_WEEKS` comment block in
`src/inseason/copilot.ts` records it). `scripts/season-calibration.mjs` carried a SECOND COPY of the
same rule -- correcting only the module would have left the arbiter measuring the old behaviour and
reporting "no change" -- so it gained `--replacement-frame nfl|reg` (default `nfl`) and both arms come
from one version of that script.

**Arbiter** (D18's four arms, playoff Brier; lower is better):

```
node --import tsx scripts/season-calibration.mjs --db <snapshot> --at-week {4,8} \
     --artifact-dir data/fold-artifacts-d16 --replacement-frame {reg,nfl}
node --import tsx scripts/season-calibration.mjs --db <snapshot> \
     --artifact-dir data/fold-artifacts-d16 --replacement-frame {reg,nfl}   # preseason, for title Brier
```

| arm (pooled playoff Brier, 114 team-seasons) | BEFORE (`reg`) | AFTER (`nfl`) | delta |
|---|---|---|---|
| week 8, A from scratch      | 0.2362 | 0.2342 | -0.0020 |
| week 8, B seeded standings  | 0.1476 | 0.1455 | -0.0021 |
| week 8, C + ROS lines       | 0.1391 | 0.1377 | -0.0014 |
| week 8, D + level shrink    | 0.1351 | **0.1336** | -0.0015 |
| week 4, A                   | 0.2328 | 0.2315 | -0.0013 |
| week 4, B                   | 0.2052 | 0.2046 | -0.0006 |
| week 4, C                   | 0.2007 | 0.2005 | -0.0002 |
| week 4, D                   | 0.2007 | **0.2004** | -0.0003 |

BETTER in all eight arm/week cells. Paired by season on the shipped arm D at week 8: mean -0.00155
+/- SE 0.00104 (t -1.49, better in 6/8 seasons) -- an improvement inside noise, which is the honest
reading; the point is that it does not get WORSE. The D18 arm structure is unchanged (seeding still
decisive at week 8, -0.0888 +/- 0.0149, 8/8; the shrink still clears, -0.0042 +/- 0.0012, 7/8) and the
shuffled-outcome control still loses (D 0.2950 honest 0.1336). Reliability bands move only inside a
bucket or two of counting noise.

The PRESEASON arm (a from-scratch full season, where the streaming floor matters least) is the one
place the number does not improve: pooled playoff Brier 0.2294 -> 0.2297 (skill 6.4% -> 6.3%), paired
mean **+0.00020 +/- SE 0.00106, t 0.19, better in 5/8 seasons** -- i.e. indistinguishable from zero,
which is the applied/reverted test ("not worse beyond noise"). Title Brier, reported as CONTEXT only
per D13, IMPROVES: 0.0641 -> 0.0636, paired mean -0.00047 +/- 0.00047 (t -1.01, 6/8), skill 1.8% ->
2.5%. **APPLIED.**

**Conservation + live verbs** (`copilot-crosscheck.mjs --schedule real`: ALL CHECKS PASSED before and
after, all 15 lines byte-identical including the fault injection; playoff shares 7.0000, title 1.0000
both ways). Live 462233 numbers that moved:

| verb | BEFORE | AFTER |
|---|---|---|
| `season-odds`, us (8==3) playoff% / title% | 65.75 / 13.50 | 66.45 / 13.50 |
| `season-odds`, largest playoff move (MILE) | 50.95 | 54.05 |
| `season-odds`, mean points per team | 883.6-1032.4 | 874.7-1028.5 (every team 4-9 pts lower) |
| `waivers`, base playoff% | 66.6 | 67.1 |
| `waivers`, recommended DROP on 3 of 4 rows | Michael Pittman Jr. | **Isaiah Likely** |
| `waivers`, top row playoffsPp | 0.0 (none cleared noise) | +0.1 |
| `depth-risk` Breece Hall, costPp | 18.2 | **21.75** |
| `depth-risk` Breece Hall, costTitlePp | 6.4 | 8.35 |
| `depth-risk`, free-agent insurers recoversPp | -3.6 / -4.0 | +0.65 / +0.7 |
| `stream --pos QB` | unchanged (identical but for the `asOf` stamp) | |

The depth-risk move is the correction working as intended: losing a starter now leaves a slot at the
CORRECT (lower) streaming floor, so thin depth costs what it costs -- 3.5pp more than we were quoting.

### D25.2 -- The handcuff / depth horizon is the LEAGUE's season, not the NFL's

**What was wrong.** `src/inseason/copilotActions.ts` passed `NFL_WEEKS` (17) where `handcuffBoard`'s
own header says `weeks` is "the REMAINING horizon" -- how long this backup still has to pay off. That
question ends when OUR season ends: ESPN 462233's last playoff week is 16. Every row was quoted over a
horizon a week longer than it has, and the `--week W` remaining-weeks arithmetic was off by one all
season. `leagueSeasonWeeks(ctx)` (WP5) reads the league's own format block, so a league that really
does run to week 17 (Yahoo 129048) is unchanged.

**Arbiter** (`node --import tsx scripts/inseason-backtest-{handcuff,promotion}.mjs`, same seasons
2018-2025 / 2018-2024): **byte-identical before and after** (only the wall-clock line differs).

| | BEFORE | AFTER |
|---|---|---|
| handcuff REALIZED diff/decision | 0.015, CI [-0.13, 0.15], P 58%, differed 37 | identical |
| handcuff SIM (distr.) | -0.048, CI [-0.08, -0.02], P 0%, differed 37 | identical |
| handcuff positive control (drop-best) | -36.6 pts | identical |
| promotion (all gates, P39, per-fold RMSE) | | identical |

That identity is STRUCTURAL and is stated rather than read as a null: `backtest/handcuffSignal.ts`
hardcodes `weeks: 1` so the per-week signal is scale-free, and `inseason-backtest-promotion.mjs` never
reaches the copilot at all. Neither arbiter CAN see this lever. The real evidence is the live verb.

**A DEAD ARBITER WAS FOUND AND FIXED FIRST.** `scripts/inseason-backtest-handcuff.mjs` picked its
league with `ORDER BY last_synced_at DESC LIMIT 1` -- one of the S-1 resolvers the architecture review
deleted from `src/`, left behind in this script. With Yahoo 129048 the newest-synced row it resolved
to a league holding NO `fact_roster_week` rows, so the harness evaluated ZERO decisions and printed
`diff/decision 0.000 ... (differed 0)` with a **positive control of 0.0** -- an empty set that reads
exactly like "the handcuff signal does nothing". It now resolves through `resolveLeagueContext` (with
`--league`), threads the league into `makeHandcuffValueFn`/`makeSimExpectedScorer`, and REFUSES
(exit 3) on zero evaluated decisions rather than printing a zero. The table above is from the fixed
harness; every figure in it was unobtainable before.

**Live verbs** (462233, ESPN, last playoff week 16 -> horizon 16):

| `ff copilot handcuffs --pos RB` | BEFORE | AFTER |
|---|---|---|
| basisNote horizon | "over 17 weeks" | "over 16 weeks" |
| Stevenson basePerWk / activePerWk | 7.77 / 10.73 | 8.26 / 11.40 |
| Corum basePerWk / activePerWk | 6.45 / 9.79 | 6.86 / 10.40 |
| every per-week magnitude | | x 17/16 = 1.0625 exactly |
| `expectedPts` (tier rows) | | UNCHANGED (lift ~ 1/weeks, games ~ weeks) |
| `expectedPts` (injury-model rows, e.g. Stevenson) | 8.5 | 8.8 |
| row ORDER | | 64 of 66 identical; one 2dp tie (RJ Harvey / Aaron Jones, 8.53 -> 9.06 vs 9.07) swaps |

`depth-risk` does not take this horizon (it is a simulated playoff-probability question); its move in
the table above is D25.1's. **APPLIED.**

### D25.3 -- `starterBaselines` fills FLEX by ELIGIBILITY GROUP, not by one `flex_ok` list

**What was wrong.** `src/draft/lineupMarginal.ts`'s `starterBaselines` counted every flex-ish slot
(`isFlexSlot`) and then filled them ALL from the league's single `flex_ok` array. Under a SUPERFLEX
template that is two errors at once: quarterbacks compete for no flex slot (QB replacement level sits
at the last DEDICATED quarterback, far too shallow, so V3 prices the whole position against the wrong
man), and the [RB,WR,TE] pool is handed the superflex slot as well (the RB/WR/TE baselines run one
slot-per-team too deep). `values.ts baselines()` was generalised to groups by D24; this is the same
laminar-greedy fill on the same input, via `splitTemplate` from the one slot module. `expectedWeekPoints`
now prices a flex slot against ITS OWN group cutoff (`baseline[<slot token>]`, falling back to `FLEX`)
and falls back to the replacement level over what THAT slot admits.

**Consumers, checked by grep rather than assumed.** `starterBaselines` has exactly ONE production
consumer: `src/draft/strategyV3.ts`. `rosterValue.ts`, `rosterMarginal.ts`, the trade tools and the
copilot do not call it. The V2 bidder is the default (`sim.ts`: `useV3 = opts.strategy === "v3" ||
FF_STRATEGY === "v3"`), so **no live verb's number moves today** -- this is a V3 value-book correction
that lands before a Yahoo/snake pre-draft path needs it.

**Arbiter: the championship backtest, which must stay byte-identical, plus a direct old-vs-new diff.**
The old implementation (git HEAD) was run beside the new one over the live 529-row 2026 board:

| template | BEFORE | AFTER |
|---|---|---|
| ESPN 462233, openFraction 1 / 0.5 / 0.25 | | **0 differing keys**, all 7 baselines identical at all three |
| Yahoo 129048 superflex, QB baseline (pts/wk) | 12.935294 | **10.594118** (deeper replacement -> QB VOR rises) |
| Yahoo, FLEX cutoff | 5.370588 | 5.835294 (the 3 FLEX slots no longer absorb the superflex) |
| Yahoo, RB / WR / TE | 5.335 / 5.371 / 5.324 | 5.741 / 5.835 / 5.441 |
| Yahoo, SUPERFLEX cutoff | (no entry) | 10.594118 |
| FAULT INJECTION: Yahoo with the `SUPERFLEX` token removed | | **every key identical to the old answer** |

That last row is the decisive half: a generalisation that changed the baselines for any reason OTHER
than the superflex slot would fail it, and a dead one would fail the superflex row. Locked durably in
`test/marginal-superflex.test.ts` (5 tests) against a deterministic 314-man fixture: the pre-D25 ESPN
numbers at two openFractions, agreement with `values.ts baselines()` (the independent reference, which
D25 did not touch), the superflex direction, the fault injection, and a `floorFor` check that moving
ONLY the `SUPERFLEX` baseline moves only the SUPERFLEX slot. The lock was itself fault-injected
(`+ 1` on a group's slot count): 3 of the 5 fail, so it is connected. **APPLIED.**

**Golden (`backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150`): 39.5% / 96%**,
as required. The per-season line reproduces the pre-change baseline on 24 of 25 seasons; **2017 reads
34% against the baseline's 33%**, and that drift is NOT D25's: a 2016-2018 run with
`src/draft/lineupMarginal.ts` restored to git HEAD prints the identical `2017:34% 2018:41%`, and the
other two D25 files are not on the draft path at all (`ff backtest` never loads `simContext.ts`;
`copilot.ts`/`copilotActions.ts` are reached only from `cmdCopilot`). It belongs to the concurrently
edited `src/draft/{values,backtest,rosBlend}.ts` (WP11's K/DST + snake work, which records its own
golden measurements in `values.ts`).

**Not done, and it is the right shape to name:** the laminar fill now exists TWICE -- in
`values.ts baselines()` and here. Neither `values.ts` nor `slots.ts` exports it as a primitive and
both are other executors' files this pass, so the duplication is recorded rather than removed. The
fix is one exported `laminarFlexFill(pool, groups)` in `slots.ts` with both call sites on it; until
then `test/marginal-superflex.test.ts`'s agreement check is what stops the two drifting.

## D26 -- The in-app Assistant is retired; Claude Code + MCP is the agent surface; the app is the login/bridge/board cockpit (2026-09-16, owner)

**Decision:** The in-app chat Assistant is **RETIRED**. The agent surface is **Claude Code driving
the `ff` CLI and the `ff-draft` MCP server** (`ff mcp` -> `src/agent/mcp-stdio.ts`, tool registry
`src/agent/agent.ts`). The desktop app keeps exactly the three jobs a terminal cannot do: the two
logged-in `<webview>` guests plus the loopback **app bridge**, a stable **CDP target** on 9223, and
the **board + one Status page**. Every control that merely shelled an `ff` verb is cut.

**Why this needed a decision at all.** The removal had been happening for weeks, in code, recorded
NOWHERE -- a comment in `index.html` said the Assistant was "redundant now that Claude Code drives
the app directly over CDP", while `README.md` listed "persistent Assistant" under **App -- working**,
`docs/mcp.md:3` framed MCP as a way to drive the draft "**instead of** the in-app chat" (an
alternative, not a replacement), and `docs/architecture.md` described the panel as live. Meanwhile
the panel itself returned at its second line (`initCopilot()` -> `#cop-q` absent) and ~350 lines of
its remains, two live IPC channels, an OAuth path and a probe harness were kept alive to serve it.
The 2026-09-16 UI audit (`docs/ui-audit-2026-09-16.md` 5.3) refused to settle it and flagged it for
an owner call; this is that call. The half-state was the worst of the three options.

**Why retire rather than restore.** It needed nothing it lacked -- `mc.authStatus()` returned
`{authenticated:true, source:"subscription", subscriptionType:"max"}` and `ff agent-ask` was wired
and demonstrably working -- so this is not a capitulation to a broken feature. It is that rebuilding
a chat box inside the app rebuilds a **worse Claude Code**: the same Agent SDK, the same 39-tool MCP
surface, the same engine, but without a transcript, interruption, file access or a second opinion.
D12 (2026-09-13) kept the agent surface deliberately BROAD (35 -> 39 tools) and pointed all of it
through our own authenticated webview; this decision does not narrow that surface by one tool. It
moves the *client*.

**What this decision does NOT touch.** `src/agent/agent.ts`'s tool registry, `mcp-stdio.ts`,
`browserTools.ts`, `src/agent/auth.ts` and `ff agent-ask` all stay: `auth.ts` is reached from the
`ff auth` CLI verb and the `auth-status` serve method, and `agentAsk` from the `ff agent-ask` verb,
so none of them is reachable only from the removed UI (grepped, WP14). Exactly ONE engine surface
died with the buttons: the `data-sources` serve method, whose only consumer anywhere was a UI handler
the Data page stopped calling (audit 4.3).

**The constraint accepted:** a non-terminal user can no longer onboard, set a lever, or rebuild the
board by clicking. That is deliberate -- this is a tool for an operator with a terminal, and the
alternative was three buttons sharing one handler plus a Setup page that duplicated `ff league-sync`
/ `ff refresh` / `ff set-lever`. `app/README.md` carries the one-to-one map from each removed control
to the verb that replaces it.

**Applied by WP14** (the minimal UI): 3 pages (Board / Browser / Status), 15 preload channels (was
36), `app/renderer/app.js` 1,416 -> ~700 lines, `data.js` (284 KB) and the vendored dagre deleted.
Two defects fixed in the same pass, both of which had been running silently: the scheduler's
scorecard routine (`RangeError: Missing named parameter "fk"`, every 15 minutes, with no surface in
the app on which `ok:false` could appear -- now `ok`, and Status renders a failing tick in red), and
`/write-transaction`'s guest resolution (the last bridge route still using
`getElementById("espnview")`, the pattern the P-3 no-fallback fix converted its five siblings off).

## Working mode (2026-08-31)

Iterate **ad-hoc**, not via `/pave`, to keep the loop fast. The roadmap stays `exec: off`; work
is driven directly in follow-up sessions against the specs. Flip to `/pave` + `exec: on` only
once the spine stabilizes and parallel factory execution is worth the overhead.
