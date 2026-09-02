# Draft-day runbook

The exact steps to run the agent for the REAL league draft (462233, seacaptaindate.com, 16-team
$200 auction). All commands from `H:/working/ff-assistant`. The agent bids from `data/values.csv`;
you co-pilot from `data/cheatsheet.md` -- both come from the same values.

## The evening before

1. **Session up + logged in** (only human step): `cd H:/working/bro && npm run -s bro -- session start espn`, then log into ESPN in that browser window. `ff` attaches over CDP; it never logs in or handles a password. Verify: `npm run ff -- preflight` (attached, logged in, real league reachable).
2. **Rebuild projections + values fresh** (the #1 edge is an independent, current projection):
   ```
   uv run --with nflreadpy --with polars tools/build_projections.py   # -> data/points.csv
   npm run ff -- values                                               # -> data/values.csv (VOR -> $)
   ```
   Without `values.csv` the agent uses ESPN's on-screen values (legal, competitive, but no edge).
3. **Pick the config on the final projections** (input-sensitive; don't hardcode faith in one run):
   `npm run ff -- sim --n 400` -- default reserve 5 / max-share 0.6 / premium 2 (aggressive-lean).
4. **Generate the cheat sheet:** `npm run ff -- cheatsheet` -> `data/cheatsheet.md`. Keep it open.

## What the cheat sheet gives you (the human copilot view)

- **Tiers by position** -- tier BREAKS are the decision points: pay up to stay in a tier, wait once
  a tier empties (the next tier is a cliff cheaper).
- **Budget plan** -- 2-3 studs (~$120 on the top 3), ~$40 for mid-value, >=$1/slot for depth. The
  room is stars-and-scrubs (61% of picks $1-5): stay disciplined, let bidding wars pass.
- **Nomination drain plan** -- nominate a top QB/TE early to bleed the known payers (Maria Jose/
  Nick/Eli on QB; McDermott/Ari on TE). Human-only edge (rational bots don't tilt), so it's a live
  read, not something the agent auto-does. QB/TE go cheap once the payers are spent -- wait them out.

## When the draft room opens

5. **Enter the real room:** `npm run ff -- enter-draft` (expect `IN THE DRAFT ROOM ...leagueId=462233`).
   For a rehearsal use `npm run ff -- launch-practice` instead.
6. **Sanity-check the reads** against the real settings:
   ```
   npm run ff -- roster        # slot layout matches the real league (incl. any extra slots)
   npm run ff -- read-block    # if a player is up: name/pos/offer/myMax/canBid look right
   npm run ff -- board         # available players + values
   ```

## Run the draft

7. **Full-auto:** `npm run ff -- auto-draft` (add `--csv data/values.csv` to force our values).
   - Fills a full legal roster in budget; bids our values with budget discipline; **live inflation
     ON** (reprices as money/talent leave, +~2 champ pts). The bid log shows `infl=` and `[$ left,
     open N]`. It runs to a full roster (defaults to 1600 rounds and a draft-over/stall guard) --
     the last bench slots fill in the cheap late phase; that is normal.
   - A per-draft log lands at `data/draft-log-*.json` (every pick, remaining $, global +
     per-position inflation) for review.

## Toggles (defaults are the backtested winners -- change only with reason)

- `--no-inflation` -- disable live inflation repricing (default ON, +~2 pts).
- `--starter-reserve N --max-share F --premium N` -- strategy dials (default 5 / 0.6 / 2; higher
  reserve = more balanced/less concentration).
- REJECTED by backtest, off by default, don't enable to "win": `--scarcity`, `--pos-inflation`,
  `--drain-nom`, `--waivers` (all measured neutral-to-negative -- see docs/edges.md).

## Watch + override

- Keep the bro browser window VISIBLE. You see every bid; click in the room any time to take the
  wheel (the agent yields when it is not the high bidder and resumes next pick).
- Stop the agent: Ctrl-C the `auto-draft` process (the draft continues; you drive).

## If it disconnects / errors mid-draft

- ESPN allows ONE draft connection -- do NOT open a second draft tab. If `auto-draft` exits mid-
  draft, just re-run it: it re-attaches, reads live state, and resumes. ESPN autopick covers your
  team in the gap. Never close the last browser tab (that quits Chrome and ends the bro session).

## Caveats to watch live

- `enter-draft`/`nominate()` success paths are verified up to what a mock allows -- watch the first
  nomination turn (does the agent nominate, or does ESPN auto-nominate?).
- If the real roster has slots we haven't seen (IDP/OP/IR), confirm `roster` shows them and the
  agent isn't skipping a needed position.

## What's validated vs not (trust the right things)

- **Validated + shipped:** independent+current values, discipline vs an overpaying room, live
  inflation. ~18% titles draft-only / ~13% full-system no-lookahead vs a realistic field (2-3x
  random). docs/validation.md.
- **Human-only (not auto):** nomination gamesmanship.
- **Not yet live:** in-season lineup SUBMIT (recommend path works offline: `ff lineup --roster`).
