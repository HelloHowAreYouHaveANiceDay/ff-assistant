# OUR values (the value source knob)

The Strategy bids up to OUR dollar value for a player. That value comes from, in order:
1. a **values CSV** you pass via `ff auto-draft --csv <file>` (the "our values" override), else
2. **ESPN's on-screen pre-draft value** (consensus; the zero-setup fallback).

## Values CSV format

Columns (header row required): **`player,pos,value`** (a full projections CSV with
`player,pos,team,proj,adp,value` also works -- only `player`+`pos` are required, `value` optional).

```
player,pos,value
Ja'Marr Chase,WR,62
Bijan Robinson,RB,60
...
```
- `value` = OUR auction dollar value, scaled to the league budget ($200) and scoring (No-PPR here).
- `player` names must match ESPN's (normalized: case/space/punct-insensitive). D/ST as the team
  name ESPN shows (e.g. `Ravens`). See `data/values.sample.csv`.

## Generating a real value table (the edge -- G5)

ESPN's pre-draft values are consensus, so overriding with OUR values is where an edge comes from:
1. Get projections for the league's scoring (No-PPR): nflreadpy / FantasyPros / your own.
2. Compute **VOR** (points over the last starter at each position, given 16 teams x the roster
   slots) and convert to **auction $** so the total across draftable players ~= 16 x $200, minus
   $1 x (roster spots) held back. (Standard value-based auction math.)
3. Write `player,pos,value`; pass `--csv values.csv`.

Until that exists, the ESPN fallback drafts a legal, competitive team -- it just has no edge and
cannot target. Building the table is pre-draft prep, not code.

## Note

`readBoard()` already reads ESPN's per-player value off the draft board live, so a future step can
snapshot a full baseline value table from ESPN and hand-edit it for our opinions.
