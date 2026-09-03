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
2b. **Refresh the NEWS aggregator and read it** (general league-neutral feed, then tailored to you):
   ```
   uv run --with nflreadpy --with polars --with feedparser --with requests tools/build_player_news.py  # -> data/player-news.csv
   npm run ff -- news                                                 # your draftable players with news
   ```
   Layer 1 (`build_player_news.py`) aggregates a GENERAL per-player feed -- nflverse injuries +
   depth-chart role + live RSS headlines (ESPN/Yahoo/CBS/PFT/RotoWire/Yardbarker) + Sleeper trending
   adds/drops, no league assumptions. Layer 2 (`ff news`)
   tailors it to YOUR value table: AVOID (OUT) / WATCH (Questionable) / BURIED (depth) flags plus the
   live headlines for players you'd draft. Read-only -- the bidder does NOT auto-apply it yet; use it
   to set `--avoids` or to bid with your eyes open. (`--no-headlines` for just the flags.)
3. **Confirm the config on the trustworthy harness** (championship rate, not season points):
   `npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 400` -- default
   reserve 15 / max-share 0.35 / premium 2 (BALANCED; the reserve 12-20 plateau is ~24%, beats the old
   aggressive-lean 5/0.6 by ~8.5 championship pts; 15 chosen over 20 for live robustness -- see
   validation.md). `ff sim` is a season-points proxy only -- don't pick the config from it.
4. **Generate the cheat sheet:** `npm run ff -- cheatsheet` -> `data/cheatsheet.md`. Keep it open.
4b. **Full draft board (Google-Sheets table):**
   ```
   uv run --with nflreadpy --with polars --with requests tools/build_report.py   # -> data/player-report.csv + .tsv
   ```
   One exhaustive row per player (~28 cols): OUR value/rank + proj pts + team/bye + bio (age, exp,
   ht/wt, 40yd) + per-source rankings to compare (Us/ECR/ESPN positional, ECR + best/worst,
   ESPN_Rank, ESPN_ADP, Rostered%, Sleeper buzz) + last-year pts/games + depth + latest-news (linked).
   Paste `data/player-report.tsv` into A1, or File > Import the `.csv`.
   **Live Google Sheet in ONE command** (rebuilds news+report, then pushes data+formatting+news links):
   ```
   uv run python tools/push_sheet.py --spreadsheet <id-or-url>        # refresh an existing sheet
   uv run python tools/push_sheet.py                                  # create a new sheet, prints URL
   ```
   Add `--no-rebuild` to push the current CSV without refetching. Uses bim-cli's google driver
   (`bim google login` once if auth lapses).

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
- `--starter-reserve N --max-share F --premium N` -- strategy dials (default 15 / 0.35 / 2; higher
  reserve = more balanced/less concentration). The balanced default is the backtested winner (Step 5).
- `--stall-min N` -- stop after N min of no new league picks (default 10; WARN at ~3 min).
- REJECTED by backtest, off by default, don't enable to "win": `--pos-inflation`, `--drain-nom`,
  `--waivers` (all measured neutral-to-negative -- see docs/edges.md). `--scarcity` was removed from
  `auto-draft` entirely (rejected + its live wiring was wrong); it survives only in `backtest`.

## Watch + override

- Keep the bro browser window VISIBLE. You see every bid.
- **Take a player yourself:** just bid above the agent's cap on it. The agent never bids past OUR
  value for a player, so once you push a player above its cap it stops contesting that player and
  moves on. (It does not detect "you" specifically -- it simply won't overpay its own value; earlier
  runbook text said it "yields when not the high bidder," which was backwards.)
- **Pause it (Step 9):** create an empty `data/PAUSE` file -- the agent keeps READING the room but
  places no bids or nominations and logs `PAUSED`; delete the file to resume (logs `RESUMED`).
- **Hard stop:** Ctrl-C the `auto-draft` process. Re-run `auto-draft` to resume; ESPN autopick covers
  gaps while it is down. (If your seat's ESPN auto-draft is ON, it will also fill during a PAUSE --
  turn it OFF in the draft room if you want the PAUSE to hand the wheel fully to you.)

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
  inflation (clamped [0.8,1.4]). With the balanced default (reserve 15 / max-share 0.35), ~25% titles
  draft-only / ~24% full-system no-lookahead vs a realistic field (~4x random). docs/validation.md.
- **Human-only (not auto):** nomination gamesmanship.
- **Not yet live:** in-season lineup SUBMIT (recommend path works offline: `ff lineup --roster`).
