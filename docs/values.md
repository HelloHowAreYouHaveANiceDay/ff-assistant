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
- `value` = OUR auction dollar value, scaled to the league budget ($200) and scoring (HALF-PPR
  here -- the synced ESPN settings are `ppr: 0.5`; this doc previously said No-PPR, incorrectly).
- `player` names must match ESPN's (normalized: case/space/punct-insensitive). D/ST as the team
  name ESPN shows (e.g. `Ravens`). See `data/values.sample.csv`.

## Generating a real value table (the edge -- G5)

ESPN's pre-draft values are consensus, so overriding with OUR values is where an edge comes from:
1. Get projections for the league's scoring (HALF-PPR, `ppr: 0.5`): nflreadpy / FantasyPros / your own.
2. Compute **VOR** (points over the last starter at each position, given 16 teams x the roster
   slots) and convert to **auction $** so the total across draftable players ~= 16 x $200, minus
   $1 x (roster spots) held back. (Standard value-based auction math.)
3. Write `player,pos,value`; pass `--csv values.csv`.

Until that exists, the ESPN fallback drafts a legal, competitive team -- it just has no edge and
cannot target. Building the table is pre-draft prep, not code.

## Dual eligibility (2026-09-09)

`computeValues` takes an optional eligibility map (nameKey -> the positions ESPN says a man may be
STARTED at, from `src/data/eligibility.ts`). A player named in it has his VOR taken as the
**maximum over his eligible positions** of `points - that position's baseline`, and the row carries
`valuePos` saying which one won. Without the map -- and for anyone not named in it -- the expression
is the old single-position one, character for character.

What eligibility deliberately does **not** do is move a man between the positional pools the
baselines are read off. Moving him from the RB list to the WR list changes the replacement level of
every other RB and every other WR, which is a far larger claim than "he may also be started at
receiver", and nothing in ESPN's `eligibleSlots` supports it. Its one baseline effect is the FLEX
fill: a dual man counts toward the flex share of the position that **claims** him (the one his value
was taken at), because that is the slot he would actually occupy.

Measured on the live 2026 pool: **zero** of the 523 players on the board are eligible at two or more
of QB/RB/WR/TE, so the map is empty and `data/values.csv` is byte-identical. That is an identity by
construction rather than a coincidence, which is why the tests come in pairs -- see
`test/values.test.ts`, where marking one fixture receiver WR/TE moves his price and nobody else's
position. The board carries an `Eligible` column and `player_value_position` records the position
each value was taken at; both are **blank/absent** when eligibility has never been ingested, because
a blank and a confident wrong answer look identical downstream and only one says so.

Run `ff ingest-source espn-eligibility` to refresh it (read-only, through the desktop app's session).

## Note

`readBoard()` already reads ESPN's per-player value off the draft board live (`ff dump-values`
snapshots it; note the board is virtualized so a full scroll-scrape only reliably gets the top
players). The Strategy reads ESPN's value for whoever is on the block LIVE, so it never lacks a value.

## Decision for THIS league (2026-09-01): no custom values table needed for v1

The nflverse/dynastyprocess datasets were evaluated (github.com/dynastyprocess/data):
`values.csv` / `values-players.csv` are **DYNASTY** values (age-weighted -- Smith-Njigba ranks
above Bijan), **wrong for redraft**; nflverse has **no preseason projections** (only actuals +
expected points + FantasyPros ECR ranks). A `db_playerids.csv` name<->ESPN crosswalk exists if we
ever need one (`raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv`).

**Conclusion:** for seacaptaindate.com the edge is NOT a fancier value table -- it is DISCIPLINE.
The room overpays studs ($80-106) vs ESPN book (docs/league-tendencies.md), so bidding ESPN's own
live values with a **balanced, disciplined posture** captures value -- and that is a STRATEGY-PARAM
change, not a data file. Defaults now encode it: `starterReserve 15`, `maxShare 0.35`, `premium 2`
(the balanced backtest winner -- Step 5, docs/validation.md).

**Optional future edge (v3):** a real REDRAFT value table from FantasyPros redraft ECR (via
`nflreadpy.load_ff_rankings(type="draft")`) or a projections source -> VOR->$ (docs/value-methods.md),
name-matched via the dynastyprocess crosswalk. Only worth it if we want to disagree with ESPN's
book; the disciplined-on-ESPN-values approach already beats an overpaying room.
