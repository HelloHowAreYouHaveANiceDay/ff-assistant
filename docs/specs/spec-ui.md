# Spec: UI + Packaging (Electron)

The desktop shell a non-technical user actually touches. Read `docs/decisions.md` D5.

## Principles

- Nothing technical is ever required of the user: no terminal, no key, no config file editing.
- Every automated action is discoverable after the fact (the action log is a first-class view,
  not a debug panel).
- The two cost brakes (budget cap vs plan limit) are always distinguishable at a glance.

## Screens / panels

### 1. Onboarding (first run)
- "Log in with Claude" button -> OAuth flow (spec-auth-and-budget Part A).
- "Connect your league" -> pick Yahoo or ESPN -> the persistent browser opens for manual login
  (spec-browser-automation).
- A one-line honest note: "This runs on your Claude subscription. We show what this app uses;
  your overall plan limits live in claude.ai."

### 2. Chat pane
- Streams the agent's turns (SDK streaming).
- Free-form: the user can ask "who should I start at flex?" and get reasoning from the same
  agent + tools that run the automation.

### 3. Roster / matchup dashboard
- Reads SQLite directly: current starters/bench, this week's matchup, projections, injury flags.
- A pure view of the latest `roster` + `matchup` snapshot.

### 4. Activity (the action log)
- Chronological `action_log`: what the bot did/planned/skipped/failed and why.
- Skipped-for-cap and failed-for-plan-limit rows render with their distinct messaging.

### 5. Budget panel
- Cap slider / number field (`weekly_cap_tokens`) + window.
- Usage meter: `weekly_used / cap` bar (self-tracked, accurate).
- Trailing per-run cost history (from `usage_log` grouped by `run_type`).
- Status line: normal | "approaching cap (>=soft_warn_pct)" | "cap reached -- [raise for this
  week]" | "Claude plan limit reached -- resets ~<time>".
- The last two are visibly different (D4): one is user-raisable, one is wait-only.

## Notifications

- Desktop notifications for: action taken, cap reached (skip), plan limit reached (fail+retry),
  re-login needed.
- **Desktop-only for v1** (Q2 resolved 2026-08-31). Email/text for the away-from-computer case
  is deferred, not ruled out -- revisit after the desktop path works.

## Packaging

- Ship as a signed installer (.exe / .dmg) the user double-clicks. No developer-run server.
- Bundle: Electron + Node runtime, the Agent SDK, the `claude` CLI (for OAuth login), the data
  scripts, and the SQLite engine. The browser used for automation is the user's installed
  Chrome/Edge driven via CDP (not a bundled Chromium), to keep the installer small and the
  login flow familiar.

## Acceptance criteria

- A non-technical user can, from a fresh install, reach a first automated lineup pass using only
  GUI buttons (login + connect league + leave it running).
- The budget panel's weekly number matches a direct SUM over `usage_log`.
- Cap-reached and plan-limit-reached states are rendered with clearly different text/color and
  the correct available action (raise vs wait).
- The activity view shows a planned->done transition for a real executed action.
