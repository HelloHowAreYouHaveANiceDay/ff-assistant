# Draft-day runbook

The order to run things on draft day, tying together everything the harness validated. The agent bids
from `data/values.csv`; you co-pilot from `data/cheatsheet.md`. Both come from the same values.

## The evening before

1. **Restart + log in the browser session** (only human step): `cd H:/working/bro && npm run -s bro -- session start espn`, then log into ESPN. The agent attaches over CDP; it cannot log in itself.
2. **Rebuild projections + values fresh** (the #1 edge is an independent, current projection):
   ```
   uv run --with nflreadpy --with polars tools/build_projections.py   # -> data/points.csv (current consensus ranks x historical curve)
   npm run ff -- values                                               # -> data/values.csv (VOR -> auction $)
   ```
3. **Pick the config on the final projections** (input-sensitive; don't hardcode faith in one run):
   `npm run ff -- sim --n 400` -- default is reserve 5 / max-share 0.6 / premium 2 (aggressive-lean).
4. **Generate the cheat sheet:** `npm run ff -- cheatsheet` -> `data/cheatsheet.md`. Keep it open.

## What the cheat sheet gives you (the human copilot view)

- **Tiers by position** -- tier BREAKS are the decision points: it's worth paying up to stay in a tier,
  and worth waiting once a tier empties (the next tier is a cliff cheaper).
- **Budget plan** -- 2-3 studs (~$120 on the top 3), keep ~$40 for mid-value, >=$1/slot for depth.
  The room is stars-and-scrubs (61% of picks $1-5): stay disciplined, let bidding wars pass.
- **Nomination drain plan** -- nominate a top QB/TE early to bleed the known payers (Maria Jose/Nick/
  Eli on QB; McDermott/Ari on TE). NB: backtested as a human-only edge (rational bots don't tilt), so
  it's a live read, not something the agent auto-does. QB/TE go cheap once the payers are spent -- wait.

## During the draft (agent)

1. **Enter the room:** `npm run ff -- launch-practice` (mock) or the real-draft entry when live.
2. **Preflight:** `npm run ff -- attach` (session alive? ESPN tab found?).
3. **Run the bidder:** `npm run ff -- auto-draft` -- fills a full legal roster in budget, bids our
   values with budget discipline, **live inflation ON** (reprices as money/talent leave; +~2 champ pts,
   validated). Watch the log: each bid shows `infl=` (the live factor) and `[$ left, open N]`.
4. A per-draft log lands at `data/draft-log-*.json` (every pick, remaining $, global + per-position
   inflation) for review.

## Toggles (defaults are the backtested winners -- change only with reason)

- `--no-inflation` -- disable live inflation repricing (default ON, +~2 pts).
- `--starter-reserve N --max-share F --premium N` -- strategy dials (default 5 / 0.6 / 2).
- REJECTED by backtest, off by default, don't enable to "win": `--scarcity`, `--pos-inflation`,
  `--drain-nom`, `--waivers` (all measured neutral-to-negative -- see docs/edges.md).

## What's validated vs not (so you trust the right things)

- **Validated edges (shipped):** independent+current values, budget discipline vs an overpaying room,
  live inflation. ~18% championships draft-only / ~13% full-system no-lookahead vs a realistic field
  (2-3x random). docs/validation.md.
- **Human-only / not auto:** nomination gamesmanship (bots don't tilt).
- **Not yet live:** in-season lineup SUBMIT (the recommend path works offline: `ff lineup --roster`;
  the live team-page reader gets pinned at season start -- src/inseason/espnTeam.ts).
