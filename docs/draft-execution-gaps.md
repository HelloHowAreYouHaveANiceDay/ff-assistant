# Draft-Day Execution: Gap Analysis

What stands between "the MVP drafts a full team in a PRACTICE auction" and "the agent runs my
REAL league draft unattended." Ranked by severity. Status: [DONE] built+verified, [PARTIAL]
built but unproven on the real path, [OPEN] not built, [RISK] external/operational.

## CRITICAL -- would break the real draft

### G1 [OPEN] Entering the REAL draft room (we only ever tested PRACTICE launch)
Everything to date enters via the mock lobby's "Practice Draft" -> `window.open` capture. The REAL
draft is entered differently: at the scheduled time the league's draft room opens and you join it
from the league (not the mock lobby). We have NEVER exercised that path. The draft-room DOM should
be identical (same auction app), so `readBlock`/`readRoster`/`quickBid`/`jumpBid` should transfer
-- but "should" is untested. **Action:** find + script the real-draft entry (league draft URL or
"Enter Draft" control), and do a dry run against the real league's draft room the moment it's
reachable (ESPN opens the draft room a few minutes before start).

### G2 [RISK] Being present and RUNNING at the exact draft start time
The agent only acts while `ff auto-draft` is running. If it isn't running when the draft starts,
picks are missed / ESPN autopicks. No scheduler exists. **Action:** either (a) a human starts
`ff auto-draft` a few minutes before start and watches, or (b) a scheduled launcher keyed to the
draft time. Also: the pre-draft "DRAFTING IN mm:ss" countdown -- the engine now tolerates empty
roster reads at startup, but confirm it bids from the first live nomination.

### G3 [OPEN] Nomination on OUR turn
On our nomination turn ESPN currently auto-nominates for us (bots keep the board moving), which is
why fill works without it. But auto-nomination is not OUR choice -- it can nominate a player we
must then decide on, and a real draft may PAUSE on our turn waiting for us (practice bot rooms did
not). If it pauses, the draft stalls. **Action:** build `nominate()` (verified selectors: board is
`.fixedDataTableLayout_main`; a per-row action + a nominate/confirm control -- needs live DOM
capture) and a strategy for WHOM to nominate (drain opponents / feed our targets).

## HIGH -- degrades results or risks a stall

### G4 [PARTIAL] Real league settings (12-man (16 teams) roster, scoring, slot mix)
The real league is 16-team $200 with a 12-slot roster (2025 recap = 192 picks); SIM_LEAGUE and
DEFAULT_VALUE_LEAGUE now match (9 starters + 3 bench).
`readRoster` reads whatever slots ESPN renders (adapts automatically), and legality keys off the
live open slots -- so this SHOULD adapt. **Action:** confirm on the real draft room that
`readRoster` returns the real slot set (esp. any OP/IDP/IR slots, and 2QB/superflex if present),
and that `hasOpenSlotFor` handles every slot label present.

### G5 [OPEN] OUR values (currently ESPN's on-screen pre-draft value)
The value source is pluggable (a values CSV overrides per name), but we have no real value table
yet -- it falls back to ESPN's pre-draft value. That's serviceable but it's the field's consensus,
so we have no EDGE and can't target. **Action:** generate an auction value table for OUR league's
settings (projections -> VOR -> $, or a trusted source), keyed by name, and load via `--csv`.
Must match ESPN's scoring (HALF-PPR here -- synced `ppr: 0.5`) and $200/16 budget.

### G6 [PARTIAL] Roster BALANCE (stars-and-scrubs tendency)
v2 + jump-bidding wins studs but over-concentrated in the first live run ($176/3). Tuned via
`starterReserve` (10) + `maxShare` (0.45); validation in progress. **Action:** finish tuning so
the roster is balanced (few studs + solid mids + cheap bench), verified across several drafts.

### G7 [PARTIAL] Player + position matching robustness
`readBlock` extracts pos from the block DOM (with a rankings fallback); names are normalized
(lowercase, alnum). Edge cases: D/ST names ("Broncos D/ST"), suffixes (Jr./III), duplicate names,
and value-CSV name mismatches. **Action:** verify pos + name matching against a full draft's worth
of players; add alias handling where a value CSV is used.

## MEDIUM -- resilience / operations

### G8 [RISK] Disconnection & recovery mid-draft
ESPN allows ONE draft connection; a duplicate kicks us ("disconnected from another location"). If
the CDP client drops, a bot/ESPN-autopick takes over our picks until we reconnect. The engine has
no auto-reconnect/resume. **Action:** a supervising loop that re-attaches on drop; never open a 2nd
draft tab (already handled in launch); confirm `ff auto-draft` resumes cleanly if restarted
mid-draft (it reads live roster state, so it should).

### G9 [RISK] Auth/session on the day
Runs on the persistent bro `espn` session (login reused). If it's logged out on draft day, the
agent can't act. **Action:** verify `bro session start espn` is LIVE and logged in ~30 min before;
one-time human re-login if needed (the only human auth step).

### G10 [PARTIAL] Launch/UI reliability
Practice-launch flaked on cold lobby (fixed with networkidle + reload retry) -- but the real draft
uses a different entry (G1), so this specific flake may not apply. **Action:** harden whatever the
real-entry path turns out to be.

### G11 [PARTIAL] Human oversight / override during the real draft
Copresent design lets the human grab the wheel. Now shipped (Step 9): a **`data/PAUSE` file** stops
the agent bidding/nominating (reads only) without killing the CLI -- delete to resume. Taking a
player is implicit: bid above the agent's cap and it stops contesting (it never overpays OUR value).
Still open: a live dashboard of what the agent is doing/planning; explicit human-bid *detection*
(9b -- stay out of a player the human is driving even below cap) and roster-anchoring under another
team's open panel (9c, defensively anchored on `.players-table`, needs a human-present verification).

## LOW -- nice to have

### G12 Bid timing efficiency
Jump-bidding wins studs, but pacing (1.4s poll) and jump-size heuristic (~1/3 gap) are untuned for
price efficiency (may overpay vs a perfect last-second bid). Fine for MVP; refine later.

### G13 Nomination/pool intelligence
Reading opponent budgets (`ul.picklist`) and the remaining-value pool to time nominations and
detect inflation -- a real edge, not required to draft a legal competitive team.

## Progress (closed / advanced 2026-09-01)
- **G1 real-draft entry** -- SCRIPTED: `ff enter-draft` (Enter-Draft control + direct URL, detects
  success) + `ff preflight` (session/login/league check, VERIFIED against the real league 462233,
  logged in: true). Runbook: `docs/draft-day-runbook.md`. Success path verifies when the room opens.
- **G2/G9 readiness** -- `ff preflight` covers session-live + logged-in + league-reachable.
- **G3 nominate** -- ADVANCED: `readBoard()` + `nominate()` (clicks a board player's "Select") built;
  Engine anti-stall wired (idle -> nominate cheapest slot-filler). `readBoard` verified live; the
  nominate SUCCESS path needs a real nomination turn to confirm (bots auto-nominate in practice).
- **G5 our values** -- ADVANCED: value-source hook + CSV loader (`player,pos,value`) + format doc
  (`docs/values.md`) + sample done and seam-tested. Remaining = the DATA (a real value table),
  which is pre-draft prep, not code.
- **G13 board/pool read** -- DONE (visible window): `readBoard()` returns name/pos/$value live.
- **G6 balance** -- TUNED: `starterReserve` 10 + `maxShare`; wins studs in budget, further balance
  tuning is parameter work.

## Summary of what to close before draft day (in order)
1. **G1** enter the REAL draft room (dry run).  2. **G3** nominate() (stall risk).
3. **G5** OUR value table.  4. **G6** finish balance tuning.  5. **G2/G9** be running + logged in
at start.  6. **G8** reconnect resilience.  Everything else is refinement.
