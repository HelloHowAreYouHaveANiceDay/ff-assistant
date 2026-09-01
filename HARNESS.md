# Draft-day sprint harness

The dev harness for the copresent draft agent (Phase 2). Not the packaged app -- this is
what we run in a terminal to build and rehearse the ESPN draft loop against live mock drafts.

## One-time setup

```
npm install
```

## The copresent loop

The agent joins the browser YOU are logged into (D0). Two ways to get an attachable browser:

**Option A -- launch a dedicated, persistent browser (recommended for the sprint):**
```
npm run chrome            # Chrome; add -- --edge for Edge
```
A browser opens with a persistent profile (./.chrome-profile, gitignored) and CDP on port 9222.
Log into ESPN in that window ONCE; the login persists across restarts.

**Option B -- attach to an existing browser** already started with
`--remote-debugging-port=9222`.

Then verify the connection:
```
npm run ff -- attach
```

## Navigating + inspecting a mock draft

```
npm run ff -- goto https://fantasy.espn.com/football/mockdraftlobby   # agent navigates itself
# join a mock draft in the browser (or we automate the join once we see the lobby DOM)
npm run ff -- inspect-draft                                           # dump the draft-room DOM
```

`inspect-draft` writes `data/draft-dom-snapshot.json` -- the evidence we use to write real
selectors in `src/draft/espnReader.ts` (`readBoard`, `makePick`). Do NOT guess selectors before
inspecting.

## Ranking (offline, no browser)

```
npm run ff -- rank                 # top players by VOR from data/rankings.sample.csv
```
Swap `data/rankings.csv` for a real free projections+ADP export; pass `--csv path` to use it.

## Running a mock (after selectors exist)

```
npm run ff -- mock
```
Runs the draft loop: read board -> rank (VOR/VONA) -> surface the pick -> override window ->
auto-pick. Validated by completing several ESPN mock drafts with zero missed picks (D9).

## Status

- [x] Skeleton: CDP attach, `goto`, `inspect-draft` DOM dump, rankings loader, VOR/VONA, loop shell
- [ ] Real ESPN selectors in `espnReader.ts` (blocked on a live mock-draft DOM snapshot)
- [ ] End-to-end mock draft completes
