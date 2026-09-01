# Spec: Agent + Scheduler

How the Claude Agent SDK session is configured, what tools it has, its system prompt shape, and
how the full-auto scheduler drives it. Read `docs/decisions.md` D3 first.

## The agent session

- Engine: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), running headless inside the
  Electron main process (or a child process it manages).
- Auth: the user's subscription (spec-auth-and-budget Part A).
- Streaming: the SDK's streamed turns are piped into the chat pane; the same turns' `usage`
  objects are written to `usage_log`.

## Tool belt

Exposed to the agent (SQLite via the MCP server; the rest as SDK tools):

| Tool | Purpose | Writes action_log? |
|------|---------|--------------------|
| `db.query(sql)` | read league/usage/action state | no |
| `db.write(...)` | parameterized state writes | no |
| `refresh_league()` | scrape roster/matchup into SQLite | no |
| `get_projections(week)` | fill `projection` | no |
| `get_injuries()` | update `player.status` | no |
| `set_lineup(changes)` | drive browser to set starters | YES (before) |
| `submit_waiver(claim)` | drive browser to claim | YES (before) |
| `notify(message)` | surface a plain-English summary | YES (as notify) |

Action tools follow the D3 rule: write `action_log` (planned) -> act -> verify via re-read ->
update (done/failed).

## System prompt (shape, not final wording)

The agent is a fantasy football co-manager for ONE league. It should:

- Before any lineup lock: refresh the league, pull projections and injuries, and set the
  optimal legal starting lineup for the current week's scoring.
- On waiver night: identify the highest-value available adds vs the weakest bench, and submit
  claims within league rules.
- Always: log every change and notify the user in plain English with the reason
  ("Benched X (questionable) for Y (projected +6.2)").
- Never: exceed the league's roster rules; take an action it cannot verify took effect.

The prompt encodes that it is running unattended -- it must act, not ask -- while the action log
and notifications keep the human informed.

## Scheduler (node-cron in the shell)

Batched, NOT continuous polling (subscription-usage discipline -- spec-auth-and-budget):

| Job | Cadence (per league timezone) | run_type |
|-----|-------------------------------|----------|
| Lineup pass | Sunday morning before first lock; re-check before late games | `lineup` |
| Waiver pass | The league's waiver processing eve | `waiver` |
| Injury check | Daily light check; can escalate a lineup pass if a starter flips to OUT | `injury_check` |

Every job:
1. Runs the budget governor's pre-run check (spec-auth-and-budget Part C). Skip + log + notify
   if it would exceed the cap.
2. Wraps the run in the plan-limit handler (spec-auth-and-budget Part D).
3. Assigns a `run_id` so its usage_log and action_log rows are correlated.

## Acceptance criteria

- A scheduled lineup pass, given a roster with an OUT starter and a healthy bench option at the
  same position, benches the OUT player and starts the healthy one, verified on the platform,
  with a matching done `action_log` row and a notification stating the reason.
- The pre-run budget check and the plan-limit handler both provably fire (fault injection:
  cap=1 -> skip; simulated limit error -> failed row + retry).
- No scheduled job starts the agent without first assigning a `run_id` and running the budget
  check (assert every `action_log`/`usage_log` row has a non-null `run_id`).
