# Design Decision Log

Each decision is stated with its rationale and the constraint it accepts. Implementation
sessions should not silently reverse these; if a decision looks wrong, raise it as an open
question in the wiki roadmap.

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

## D2 -- Browser access via bro-style saved sessions, not platform APIs/tokens

**Decision:** For both Yahoo and ESPN, the app launches a real Chrome/Edge with a persistent
profile and a remote-debugging port (the `bro` pattern). The user logs in like a human once
(handling 2FA); the session persists. Claude drives that already-authenticated browser over
CDP for both reading walled data and taking actions.

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

## D7 -- Language: TypeScript shell + agent, Python MCP sidecar for football data/math

**Decision (2026-08-31, from recon -- see `prior-art-and-stack.md`):** The Electron shell,
Claude Agent SDK session, and browser control are **TypeScript**. The football-specific data +
optimization layer (espn-api, nflreadpy, VOR/VONA, PuLP) is **Python**, wrapped in a single
stdio-MCP sidecar spawned by the Electron main process. SQLite is exposed via an MCP server.

**Why:** The TS Agent SDK runs natively in Electron's Node runtime (the Python SDK would force
subprocess bridging for the *agent itself*); but the mature fantasy-football libraries and math
are Python with no TS equivalent. A Python MCP sidecar is the clean seam -- one process, not a
scattered bridge. This matches the dominant 2025-2026 pattern (TS agent/UI + Python data, glued
by MCP).

**Accepted constraint:** two runtimes to package (Node via Electron + a bundled Python). Keep it
to ONE Python sidecar. Revisit only if a capable TS ESPN/stats library matures.

## D8 -- Draft automation is a late, separately-gated phase with an assist fallback

**Decision:** Weekly lineup + waivers (lower-stakes) ship first. Live-draft automation is its own
later phase because ESPN exposes no draft API and no programmatic pick override -- it must be
driven through the draft-room DOM under a per-pick clock. Until DOM reliability is proven, draft
mode surfaces the VOR/VONA-ranked pick for the user with a countdown and auto-submits only as a
proven step, not on day one.

**Why:** It is the highest-risk autonomous capability and the easiest to get embarrassingly
wrong live; everything else is recoverable. (Recon: existing tools all stop at recommendation
for exactly this reason.)

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
