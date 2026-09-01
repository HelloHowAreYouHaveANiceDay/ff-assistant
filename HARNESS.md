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

`inspect-draft` writes `data/draft-dom-snapshot.json` -- the evidence we use to write real
selectors in `src/draft/espnReader.ts` (`readBoard`, `makePick`). Do NOT guess selectors first.

## Ranking (offline, no browser)

```
npm run ff -- rank                 # top players by VOR from data/rankings.sample.csv
```
Swap `data/rankings.csv` for a real free projections+ADP export; pass `--csv path`.

## Running a mock (after selectors exist)

```
npm run ff -- mock
```
Read board -> rank (VOR/VONA) -> surface pick -> override window -> auto-pick. Validated by
completing several ESPN mock drafts with zero missed picks (D9).

## Status

- [x] Skeleton: bro-subdriver attach, `goto`, `inspect-draft` DOM dump, rankings loader, VOR/VONA, loop shell
- [x] bro `espn` site added; `ff bro` passthrough; port resolved from bro's registry
- [ ] Real ESPN selectors in `espnReader.ts` (blocked on a live mock-draft DOM snapshot)
- [ ] End-to-end mock draft completes
