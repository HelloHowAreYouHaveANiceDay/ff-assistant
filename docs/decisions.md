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

## Working mode (2026-08-31)

Iterate **ad-hoc**, not via `/pave`, to keep the loop fast. The roadmap stays `exec: off`; work
is driven directly in follow-up sessions against the specs. Flip to `/pave` + `exec: on` only
once the spine stabilizes and parallel factory execution is worth the overhead.
