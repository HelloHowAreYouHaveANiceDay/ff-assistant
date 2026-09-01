# Spec: Auth + Budget

Covers Claude subscription authentication (D1) and the adjustable token budget cap (D4).
Read `docs/decisions.md` D1 and D4 first.

## Part A -- Authentication

### Requirement

The app authenticates to Claude using the end user's Max/Pro subscription. No API key is ever
requested from or stored by the app.

### Mechanism

1. The app bundles the `claude` CLI (or the equivalent login capability of the Agent SDK).
2. On first run, the app triggers the OAuth "Log in with Claude" flow: opens the system
   browser, the user signs into claude.ai, the CLI stores credentials in its standard location.
3. The Agent SDK, when it starts a session, reuses those stored credentials -- no key passed in
   code.
4. The UI shows auth state: "Signed in as <account>" / "Not signed in -> [Log in with Claude]".

### Acceptance criteria

- A fresh install with no prior Claude login can reach a working agent session using ONLY the
  in-app "Log in with Claude" button -- no terminal, no key.
- Removing/expiring the credential surfaces a clear "Please sign in again" state, not a crash.
- No Anthropic API key field exists anywhere in the UI or config.

## Part B -- Token accounting (what CAN be shown)

### Requirement

Display, accurately, what the app itself has spent.

### Mechanism

- After every agent turn, read the `usage` object
  (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)
  and append a row to `usage_log` (see `spec-data-model.md`).
- Compute:
  - **Session total** -- sum over the current app session.
  - **Rolling weekly total** -- sum over the configured window (default 7 days).
  - Optional rough $-equivalent for user intuition (clearly labeled as an estimate).

### Acceptance criteria

- The usage meter's weekly number equals a direct SUM over `usage_log` for the window (assert
  in a test by injecting known rows).
- Cache-read tokens are tracked but shown distinctly (they are ~10% price and do not count
  toward API rate limits).

## Part C -- Budget cap (the governor)

### Requirement

A user-adjustable ceiling on self-tracked token spend that can pause automation. This is the
primary cost control because plan quota is invisible.

### Settings (persisted in the `settings` table)

| Setting | Default | Meaning |
|---------|---------|---------|
| `weekly_cap_tokens` | (Q3 -- pick a sane default) | Hard ceiling over the window |
| `window_days` | 7 | Rolling window length |
| `on_cap_action` | `pause_notify` | `pause_notify` or `ask_to_raise` |
| `soft_warn_pct` | 80 | Notify (but continue) at this fraction of cap |

### Enforcement

- **Before each scheduled run:** compute `projected = weekly_used + estimate(run_type)`. If
  `projected > weekly_cap_tokens`: skip the run, write an `action_log` row (status=skipped,
  reason=cap), notify with a one-tap "raise cap for this week." Do NOT start the agent.
- **Between turns within a run:** re-check `weekly_used` against the cap so a single expensive
  conversation cannot overshoot by a large multiple before the next scheduled check.
- **`estimate(run_type)`:** trailing average of past runs of that type from `usage_log`
  (join via `action_log.run_type`). Cold-start uses a fixed seed estimate per run type (Q3).

### Acceptance criteria

- Setting the cap below `weekly_used` and firing a scheduled run causes the run to be SKIPPED
  with a cap-reason log row and a notification -- the agent never starts (assert by fault
  injection: set cap=1, confirm skip).
- Raising the cap re-enables runs immediately (no restart).
- The estimate is derived from `usage_log`, not a hardcoded constant, once history exists
  (assert the estimate changes after real runs accumulate).

## Part D -- Plan-limit exhaustion (what CANNOT be shown, handled reactively)

### Requirement

When the user's Anthropic subscription plan limit is hit, the app must fail loudly and
recover, since it cannot see the limit coming.

### Mechanism

- Wrap every agent run in a handler that catches the plan-limit error
  ("You've hit your session/weekly/<model> limit").
- On catch: write `action_log` (status=failed, reason=plan_limit), notify
  ("Your Claude subscription limit was reached -- resets ~<time if known>. Will retry."),
  and reschedule.
- The UI status line distinguishes this from a cap hit (D4): cap = user can raise; plan =
  user must wait.

### Acceptance criteria

- Simulating the plan-limit error during a scheduled run produces: a failed action_log row with
  reason=plan_limit, a distinct notification, and a rescheduled retry -- NOT a silent no-op and
  NOT a crash.
- The cap-hit and plan-limit states render as visibly different messages.
