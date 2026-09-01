# ESPN mock-draft flow (observed live, 2026-08-31)

Captured by driving the copresent session (bro `espn` session + ff). Feeds the selectors in
`src/draft/espnReader.ts`. DOM snapshots are in `data/*.json` (gitignored).

## The lobby -> waiting room -> draft app path

1. **Mock draft lobby** -- `https://fantasy.espn.com/football/mockdraftlobby`
   - Content is in the top DOM (NOT the iframes -- those are just the Disney/ESPN OneID login).
   - A list of mocks as `<a>` links, text like `Beginner 10-Team H2H Points Mock`,
     `Expert 12-Team H2H Points PPR Mock`, `... Salary Cap` (= auction). Plain "Points" = snake.
   - Clicking a mock -> a **waiting room** at `/football/waitingroom?leagueId=<id>`.

2. **Waiting room** -- `/football/waitingroom?leagueId=<id>`
   - Title: `Waiting Room - <mock name> - ESPN Fantasy Football`.
   - Shows Draft Type (Snake), Scoring (No PPR), League Size (10), and
     `This Draft Starts: <day> at <time>` with a countdown `00:00:MM:SS`.
   - A **"Join This League"** button claims a team slot -- REQUIRED, else you are a spectator.
   - Team table lists the joined teams (ORDER / TEAM / ABBREV).
   - "There is a three-minute window between the draft time and when the draft actually starts,
     to allow all members to join the live draft application."

## The blocker we hit (and the fix)

Public scheduled mocks are unreliable for on-demand testing:
- They start on a FIXED clock, not when you're ready.
- They fill instantly and BUMP late joiners -- twice we saw "This draft has begun" / "this league
  has been filled" with our slot gone, and were told to "Find Another Mock Draft".
- The live draft **application does not open in the same tab** ("join the live draft application")
  and did not auto-open a new tab in our runs.

**Deterministic route to a live draft room: CREATE a mock draft** (bots autofill empty teams,
starts on a short timer you control). The lobby's top-level "Create" link we first clicked went to
create-a-LEAGUE (`/football/welcome`), not create-a-mock -- the correct create-mock entry point
still needs to be located. Alternatively, use the real ESPN league's own draft.

## BREAKTHROUGH: the agent launches the draft room itself (no human click)

The "Practice Draft" launch opens the draft app via `window.open`, which the popup blocker
drops for programmatic clicks. Solution (implemented in `ff launch-practice`): **shim
`window.open` to RECORD the target URL without opening a real popup, then navigate our single
tab to it.** Proven live 2026-08-31 -- the agent went lobby -> configure modal -> Start ->
captured `https://fantasy.espn.com/football/draft?leagueId=<practiceId>&...&teamId=8&memberId=...`
-> navigated in -> "Fantasy Football Draft - ESPN". This is the draft-day launch path.

Launch sequence (all in `launch-practice`):
1. Lobby -> click the **"Practice Draft"** BUTTON (by role; the same text also appears as a
   heading "League Specific Practice Draft" -- must match the button, exact name).
2. A **"Configure Practice Draft" modal** opens (`configure-practice-draft-modal` lightbox):
   shows team count + "Select Draft Position" + **"Start Practice Draft"** button.
3. Click "Start Practice Draft" -> `window.open(draftUrl)` (captured by the shim) -> navigate.

**Gotchas:**
- **ONE draft connection only.** Opening two draft tabs (our navigate + a real popup) triggers
  "You have been disconnected... from another location." The shim must NOT open the real popup.
- **Never close the last page** -- closing all tabs quits Chrome and kills the bro session.
  `launch-practice` picks/creates a non-draft working tab, then closes only OTHER draft tabs.
- Reliability caveat (2026-08-31): on a freshly-restarted session the lobby SPA sometimes hasn't
  rendered the "Practice Draft" button when we click (title empty). Needs a proper
  "wait for app ready" before step 1 (retry loop added, still flaky on cold start).

## MAJOR FINDING: the real league is a 16-team AUCTION (salary-cap) draft

The practice draft inherits the real league's settings, which revealed: league `462233`
("seacaptaindate.com") is a **16-team, $200 salary-cap AUCTION draft** ("PK 1 OF 192", per-team
"$200 / AUTO" budgets) -- NOT a snake draft. This reshapes draft strategy:
- Snake VONA logic in `rank.ts` is the WRONG model for draft day. We need **auction values**
  (cross-positional $ values from projections) + live **nomination/bidding** logic (track
  remaining budgets, max bids, positional runs).
- The weekly-lineup/waiver VOR work is unaffected; only DRAFT strategy changes.
- Open question for the user: build the auction bidder for the real league, and/or keep a snake
  path for other leagues.

## Draft-room DOM structure (captured live, auction practice room)

From `data/draftroom.json` (fixed-data-table based app):
- `div.fixedDataTableLayout_main ... rows=30` -- the AVAILABLE PLAYERS board (virtualized; only
  visible rows are in the DOM -- must scroll/paginate to read all).
- `ul.picklist rows=16` -- the teams / nomination order.
- `table.Table rows=13` -- roster slots.
- `ul.tabs__list rows=6` -- position filter tabs.
- Header shows `PK n OF 192`, a pick clock (`--:--` between picks), and per-team `$budget`.
- Selectors for readBoard/makePick still need pinning to specific cell classes (next step).

## VERIFIED auction reader (live, 2026-08-31)

`src/draft/espnAuction.ts` `readBlock(page)` returns live values, confirmed against a running
practice auction (`ff read-block`):
`{ player:"Jonathan Taylor", currentOffer:92, myMax:189, preDraftVal:94, quickBidLabel:"Offer $93" }`.

Stable selectors (anchor on these, not jsx-<hash>):
- On the block: `[data-testid="player-selected"]`; name `.playerinfo__playername`.
- Offer + our max: `[class*="player-nominated-fo"]` text "Current offer: $X Manual offer (max $Y)".
- ESPN suggested value: `span.player-default-bid` "Pre-Draft Val: $N" (use as v1 valuation).
- Quick bid (current+$1): `button.bid-player__button` text "Offer $N" (disabled when not biddable).
- Bid history: `ul.bid-history__list li.bid` ("$62 <team>"). Per-team budgets: `ul.picklist`.
- Available board: `div.fixedDataTableLayout_main` (virtualized -- scroll to read all).

`quickBid(page)` clicks the "Offer $N" button. Still to build: readBoard (what to nominate + max
per player), readBudgets (per-team $ left), nominate(name), and the bid STRATEGY.

## Still needed

- The **draft-room** DOM (the pick UI): available-players list, on-the-clock indicator, pick
  timer, my-roster panel, and the pick/confirm controls. Not yet captured -- blocked on getting
  into a started draft with us in it. Once captured, fill `readBoard`/`makePick`.

## Auth anchor: the persistent bro `espn` session (reuse, don't re-auth)

The `espn` bro site uses `browser: persistent` -- a per-site profile that keeps ESPN's
(long-lived) login across restarts. Log in ONCE via `bro session start espn`; every ff run
attaches to that same session. Do NOT build any per-run login/token flow -- the persistent
session is the single auth anchor (confirmed reusable live 2026-08-31). If a run ever finds it
logged out, the fix is a one-time human re-login in that window, nothing more.

## ff harness commands proven this session

`ff bro session start espn` (bro owns login) | `ff attach` | `ff goto <url>` | `ff click "<text>"`
| `ff text` | `ff inspect-draft --out <file>` | `ff rank`. All drive the copresent session over CDP.
