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

## Still needed

- The **draft-room** DOM (the pick UI): available-players list, on-the-clock indicator, pick
  timer, my-roster panel, and the pick/confirm controls. Not yet captured -- blocked on getting
  into a started draft with us in it. Once captured, fill `readBoard`/`makePick`.

## ff harness commands proven this session

`ff bro session start espn` (bro owns login) | `ff attach` | `ff goto <url>` | `ff click "<text>"`
| `ff text` | `ff inspect-draft --out <file>` | `ff rank`. All drive the copresent session over CDP.
