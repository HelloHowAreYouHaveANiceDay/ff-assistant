# Draft-Day Runbook

The exact steps to run the agent for the REAL league draft (462233, seacaptaindate.com,
16-team $200 auction). All commands from `H:/working/ff-assistant`.

## ~30 min before the draft

1. **Session up + logged in** (G9):
   ```
   npm run ff -- bro session start espn     # if not already running; leave it running
   npm run ff -- preflight                  # expects: attached, logged in: true, real league reachable
   ```
   If `preflight` says not logged in, log into ESPN in the bro browser window once.

2. **Values ready** (G5, optional but recommended): have `data/values.csv`
   (`player,pos,value` for the league's No-PPR/$200 settings -- see `docs/values.md`).
   Without it the agent uses ESPN's on-screen values (legal, competitive, no edge).

## When the draft room opens (a few min before start)

3. **Enter the real draft room** (G1):
   ```
   npm run ff -- enter-draft
   ```
   Expect: `IN THE DRAFT ROOM: ...leagueId=462233...` + the real roster slot layout. If it says
   "not reachable yet", the room hasn't opened -- retry every ~30s.

4. **Sanity-check the reads** against the real 16-team settings:
   ```
   npm run ff -- roster        # slot layout matches the real league (incl. any extra slots)
   npm run ff -- read-block    # if a player is up: name/pos/offer/myMax/canBid look right
   npm run ff -- board         # available players + values
   ```

## Run the draft

5. **Full-auto**:
   ```
   npm run ff -- auto-draft --csv data/values.csv
   ```
   (Omit `--csv` to use ESPN values.) Tuning knobs if needed:
   `--starter-reserve N` (higher = more balanced/less concentration; default 10),
   `--premium N`, `--aggr F`, `--rounds N`. A 16-team auction is long (~20-40 min) -- the last
   bench slots fill in the cheap late phase; that is normal. Re-run the same command to continue
   if a pass ends before the roster is full (it reads live state and resumes).

## Watch + override (copresent, G11)

- Keep the bro browser window VISIBLE. You see every bid; click in the room any time to take the
  wheel (the agent yields when it is not the high bidder and resumes next pick).
- To stop the agent: Ctrl-C the `auto-draft` process (the draft continues; you drive).

## If it disconnects (G8)

- ESPN allows ONE draft connection. Do NOT open a second draft tab. If `auto-draft` errors/exits
  mid-draft, just re-run `npm run ff -- auto-draft --csv data/values.csv` -- it re-attaches and
  reads live state. Meanwhile ESPN autopick covers your team.

## Known caveats to watch live (from the gap analysis)

- **enter-draft** and **nominate()** success paths are verified only up to the point the real
  draft allows -- watch the first nomination turn (does the agent nominate, or does ESPN?).
- If the real roster has slots we haven't seen (IDP/OP/IR), confirm `roster` shows them and the
  agent isn't skipping a needed position.
