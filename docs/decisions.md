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

## Working mode (2026-08-31)

Iterate **ad-hoc**, not via `/pave`, to keep the loop fast. The roadmap stays `exec: off`; work
is driven directly in follow-up sessions against the specs. Flip to `/pave` + `exec: on` only
once the spine stabilizes and parallel factory execution is worth the overhead.
