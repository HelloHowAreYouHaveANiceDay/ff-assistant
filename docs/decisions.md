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

## Open design questions (resolve before or during the relevant build phase)

- **Q1: Yahoo or ESPN first?** Which is the friend's primary league? Drives which scraper is
  built and hardened first.
- **Q2: Notification channel.** Desktop notification only, or also email/text for the
  away-from-computer case (a Sunday lineup that couldn't be set)?
- **Q3: Default weekly cap value + estimation cold-start.** What sensible default cap ships, and
  how does the per-run estimate behave before any run history exists (fixed seed estimate)?
- **Q4: Credential/profile storage location + safety.** Where the persistent browser profile
  and the Claude credentials live on disk, and how the app communicates that these never leave
  the machine.
