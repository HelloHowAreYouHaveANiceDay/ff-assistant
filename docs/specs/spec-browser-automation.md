# Spec: Browser Automation (bro-style saved sessions)

Covers reading walled league data and taking actions ("Claude plays") on Yahoo and ESPN via a
persistent, human-logged-in browser. Read `docs/decisions.md` D2 first. Reuse the existing
`bro` repo machinery wherever possible rather than reinventing CDP session management.

## Model

- The app launches a real Chrome/Edge with:
  - a **dedicated persistent profile directory** (so login survives restarts), and
  - a **remote-debugging port** (CDP), so the agent's tools can drive it.
- The user performs login **manually, like a human**, in that browser window -- including 2FA.
  The app never handles the password.
- Session persists until the platform expires it; re-login is the user's only recurring manual
  step. The app detects the logged-out state and prompts for re-login rather than failing
  silently.

## Connect flow (per platform)

1. User clicks "Connect Yahoo" (or ESPN) in the UI.
2. The persistent browser opens to the platform login page.
3. User logs in normally; the app polls for a signed-in signal (a known post-login DOM element
   or URL).
4. On success: the app scrapes league/team identifiers into the `league` table and marks the
   platform connected.

## Agent-facing tools (implemented over CDP)

Read tools:
- `refresh_league()` -- scrape current roster, matchup, and league scoring into SQLite.
- `read_matchup(week)` -- current opponent + projections as shown on the platform.

Action tools (each writes an `action_log` row status=planned BEFORE acting -- D3):
- `set_lineup(changes)` -- move players between starting slots / bench to realize a target
  lineup; verify the platform reflects the change; update the log row.
- `submit_waiver(claim)` -- place a waiver/free-agent claim (add X, optionally drop Y);
  verify submission; update the log row.

Each action tool MUST:
- Re-read the page state and confirm the intended change actually took effect (do not trust that
  a click "probably worked"); record done vs failed accordingly.
- Be idempotent-safe: if the desired end-state already holds, do nothing and log it.

## Platform notes

- **Yahoo:** OAuth-based API exists but is avoided per D2; drive the web UI. Lineup lock times
  and the waiver process are platform-specific -- encode them per platform.
- **ESPN:** No easy public data without cookie auth; the persistent-session approach is doing
  the heavy lifting here. DOM differs substantially from Yahoo.
- Build and STABILIZE ONE platform end-to-end before adding the second (D2). **ESPN is first**
  (Q1 resolved -- there is a live ESPN league to validate against); Yahoo is the Phase 5 add.

## Reliability requirements

- Selectors/scrapers are isolated per platform in their own module so a DOM change on one
  platform cannot break the other.
- Every scrape validates it actually got data (e.g. non-empty roster of expected size) before
  writing -- a silent empty scrape must be treated as a failure, not as "no players."
- Timeouts and a bounded retry (per the machine convention: if a page/element does not respond
  after a few attempts, stop and surface the problem, do not spin).

## Safety

- The browser profile and any session cookies live on the user's machine only; nothing is sent
  to the developer (storage location + user-facing assurance is open question Q4).
- Never trigger native browser dialogs (alert/confirm) via automation -- they block CDP.

## Acceptance criteria

- After a manual login, `refresh_league()` populates `roster` with the correct starters/bench
  for the connected league, verified against what the site visually shows.
- `set_lineup()` applied to a known desired lineup results in the platform showing that lineup,
  confirmed by a re-read, with a matching done `action_log` row.
- A logged-out session causes tools to report "please reconnect," not a garbled/empty write.
