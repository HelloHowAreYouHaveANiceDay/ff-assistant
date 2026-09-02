# Draft-day sprint harness

The dev harness for the copresent draft agent (Phase 2). Not the packaged app -- this is
what we run in a terminal to build and rehearse the ESPN draft loop against live mock drafts.

## Architecture: bro owns the session, ff attaches

Per D0/D2, we do NOT launch or log into a browser ourselves. **bro** (the studio's browser
runner, a sibling repo) owns the persistent, logged-in session; **ff attaches Playwright** to it
over CDP, resolving the port from bro's shared session registry. `ff bro ...` is a passthrough to
the bro CLI, like `bim bro`.

ff finds bro at `../bro` by default; override with `BRO_DIR=/path/to/bro`.

## One-time setup

```
npm install
```

An `espn` site must exist in bro at `<bro>/sites/espn/site.json`. bro gitignores real site
configs (`sites/*`), so they are local-only per machine -- recreate it if setting up fresh:

```json
{
  "name": "ESPN Fantasy",
  "loginUrl": "https://www.espn.com/login",
  "homeUrl": "https://fantasy.espn.com/football/",
  "source": "espn",
  "authedWhen": { "urlNot": "login" },
  "headed": true,
  "browser": "persistent",
  "interactive": true
}
```

## Start the copresent session (bro; log in once)

```
npm run ff -- bro session start espn      # opens ESPN with a persistent profile + CDP port
# log into ESPN in that window; LEAVE IT RUNNING (it holds the session)
npm run ff -- bro sessions                 # confirm it's LIVE and see the port
npm run ff -- attach                       # ff joins bro's session; lists tabs
```

Stop it later with `npm run ff -- bro session stop espn`.

## Navigate + inspect a mock draft

```
npm run ff -- goto https://fantasy.espn.com/football/mockdraftlobby   # agent navigates itself
# join a mock draft (we automate the join once we've seen the lobby DOM)
npm run ff -- inspect-draft                                           # dump the draft-room DOM
```

`inspect-draft` writes a draft-room DOM snapshot -- the evidence we use to write real selectors.
The live auction reads/writes now live in `src/draft/espnAuction.ts` (`readBlock`, `readRoster`,
`readBoard`, `readDraft`, `readLeague`, `quickBid`, `jumpBid`, `nominate`). Do NOT guess selectors.

## Ranking (offline, no browser)

```
npm run ff -- rank                 # top players by VOR from data/rankings.sample.csv
```
Swap `data/rankings.csv` for a real free projections+ADP export; pass `--csv path`.

## Running a mock (the auction path)

```
npm run ff -- launch-practice      # enter a practice auction (window.open capture)
npm run ff -- auto-draft           # full-auto: fills a legal roster in budget, live inflation on
```
Bids our values with budget discipline; runs to a full roster (see docs/draft-day-runbook.md).
Validated by completing full ESPN practice auctions end-to-end.

## Status

- [x] bro-subdriver attach, `goto`, `inspect-draft` DOM dump; `ff bro` passthrough; port from registry
- [x] Live auction reads/writes pinned in `espnAuction.ts` (block/roster/board/readDraft/readLeague/bids)
- [x] End-to-end practice auction completes (full legal roster in budget)
- [ ] Real-league draft-room entry verified live (G1 -- see docs/draft-execution-gaps.md)
- [ ] In-season team-page reader pinned (blocked until our 2026 roster exists)
