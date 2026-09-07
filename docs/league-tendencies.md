# League Tendencies: seacaptaindate.com (462233)

**Regenerate, do not hand-edit:** `node --import tsx scripts/tendencies.mjs 2022 2026`
(the desktop app must be open and logged in). Format history: `scripts/scoring-history.mjs`.
Last regenerated **2026-09-07**, seasons 2022-2026, straight from the league API through the
platform adaptor -- earlier revisions of this doc were transcribed by hand from
`data/draft-recap-*-raw.txt` and drifted.

## Read this before comparing any two years

- **League size changed: 2022-2024 were 14-team, 2025-2026 are 16-team.** Two more teams means
  ~$400 more money and 20 more roster spots chasing the same players, so raw **dollar totals are
  comparable only within an era**. Every cross-era claim below uses **share of the money in the
  room**, which is comparable. The bench also shrank (5 -> 4) in 2025.
- **Scoring has ALWAYS been half-PPR** -- reception points = 0.5 in every season 2023-2026
  (verified via `scoring-history.mjs`). Any older reasoning that explained this room's spending
  *by* no-PPR was never valid, not merely stale.

## Draft

| season | teams | picks | total $ | avg | median | top | >$50 | >$30 | $1-5 |
|---|---|---|---|---|---|---|---|---|---|
| 2022 | 14 | 182 | 2796 | 15.4 | $3 | 92 | 21 | 30 | 58% |
| 2023 | 14 | 182 | 2783 | 15.3 | $2 | 88 | 22 | 36 | 61% |
| 2024 | 14 | 182 | 2767 | 15.2 | $2 | 106 | 22 | 39 | 61% |
| 2025 | 16 | 192 | 3157 | 16.4 | $2 | 103 | 25 | 43 | 61% |
| 2026 | 16 | 192 | 3148 | 16.4 | $2 | 102 | 23 | 35 | 59% |

**The single most stable fact about this room: the median player costs $2, and ~60% of every
draft goes for $1-5.** That has held across five seasons and a league-size change. The money is
concentrated in ~23 players above $30; everyone else is loose change.

### Positional share of spend (era-comparable)

| season | QB | RB | WR | TE | K | DST |
|---|---|---|---|---|---|---|
| 2022 | 9.0% | 42.9% | 37.9% | 8.9% | 0.6% | 0.8% |
| 2023 | 11.2% | 39.3% | 40.5% | 7.7% | 0.6% | 0.7% |
| 2024 | 6.9% | 38.1% | 46.5% | 7.2% | 0.7% | 0.6% |
| 2025 | 10.4% | 40.9% | 40.9% | 6.5% | 0.6% | 0.6% |
| **2026** | **7.6%** | **43.0%** | **38.6%** | **7.6%** | **1.5%** | **1.7%** |

**2026 drift vs the 2022-25 mean:** RB **+2.7pp** (40.3 -> 43.0), WR **-2.8pp** (41.4 -> 38.6),
QB **-1.8pp**. The room rotated money out of receivers and back into backs this year.

**K + DST cost 3.2% of the room in 2026, against ~1.3% in every prior season -- roughly $60 of
league money that historically was not spent there.** Worth watching rather than acting on: one
season is one observation, and it may be a couple of managers rather than a shift in the room.

## In-season

New section (2026-09-07). A draft recap says how a manager values positions in August and nothing
about how they behave in November. Source: per-team activity counters, cross-checked between the
JSON API and the rendered Transaction Counter page (they agree exactly; only the API carries FAAB).

| season | adds/team | FAAB spent/team | trades/team | lineup moves/team |
|---|---|---|---|---|
| 2022 | 15.0 | 53.7 | 0.1 | -- |
| 2023 | 14.8 | 55.3 | 0.1 | 37.7 |
| 2024 | 12.4 | 46.4 | 0.1 | 34.4 |
| 2025 | 16.5 | 48.1 | 0.1 | 37.7 |

### The two findings that should change behaviour

**1. THIS ROOM DOES NOT TRADE.** About **one completed deal per season across the entire league**,
every year, for four years. Six of fourteen regular owners have never made one. Any plan that
depends on acquiring a player by trade is betting against a very stable base rate -- expect
silence, and treat a manager who engages at all as the rare exception. It also means the waiver
wire, not the trade market, is where in-season roster improvement actually happens here.

**2. Spending FAAB is the one activity measure associated with finishing well** -- r = **-0.319**
against final rank over 58 team-seasons (noise threshold ~0.26 at this n; negative = more spending,
better finish). Adds (+0.05), trades (-0.00) and lineup moves (-0.01) are all indistinguishable
from noise. Points-for is -0.737, which is tautological and only there as a sanity check that the
correlation code detects a real relationship.

Read (2) carefully: it is **correlational and confounded**. Teams already winning may spend to
press an advantage, and teams hit by injuries are forced to spend. It does **not** say "bid
aggressively on anyone". It says **hoarding the budget to zero is the one habit visibly associated
with finishing badly** -- and the bottom of the per-owner table agrees (bigwilly7009 $17/yr, avg
finish 11.3; TeamFBGM $15/yr, 8.0; christopher.alme $25/yr, 10.0).

### Per-owner, 4-season averages

| owner | adds | FAAB | trades | moves | avg finish |
|---|---|---|---|---|---|
| PooperScooperer | 30.8 | 73 | 0.0 | 68 | 10.0 |
| jellowl | 22.3 | 86 | 0.3 | 44 | 8.3 |
| RShroff888 | 19.3 | 100 | 0.8 | 42 | **5.0** |
| CLUTCH_CITY | 19.0 | 75 | 0.3 | 38 | 6.8 |
| elicoria2385 | 15.8 | 59 | 0.0 | 34 | 5.5 |
| ahampton13 | 15.8 | 38 | 0.5 | 48 | 10.0 |
| MAJORA3379588 | 14.0 | 41 | 0.0 | 43 | 9.0 |
| christopher.alme | 12.8 | 25 | 0.0 | 26 | 10.0 |
| Tehodgi | 12.5 | 87 | 0.0 | 32 | 7.3 |
| slthompson446 | 12.0 | 35 | 0.0 | 36 | 7.8 |
| young1ceasar | 12.0 | 40 | 0.5 | 29 | 5.5 |
| bigwilly7009 | 8.5 | 17 | 0.5 | 26 | 11.3 |
| Arince56 | 7.8 | 43 | 0.0 | 31 | 7.8 |
| TeamFBGM | 7.0 | 15 | 0.3 | 24 | 8.0 |

**Four seasons per owner is a small n and these rows are hints, not profiles.** The held-out test
in `scripts/manager-stability.mjs` is blunt about the limit: personalised draft profiles do NOT
beat "everyone drafts league-average" out of sample (-11.2% vs the naive baseline, winning 25/56
held-out cases). Trust the league-wide correlations; treat any single owner's row as weak prior.

## Caveats

- Activity counters are ESPN's own tallies. `moveToActive` counts lineup changes, which is an
  engagement proxy, not skill -- PooperScooperer leads the league in both adds and moves and
  finishes 10th on average.
- `finalRank` blends regular-season record and playoff result; it is the league's own ordering.
- 2026 is excluded from every in-season average -- the season is days old and its counters are
  near zero, which would drag the league toward "passive" if included.
