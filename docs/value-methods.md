# Values Table: Methods & Plan (research synthesis, 2026-09-01)

How to build the `data/values.csv` the Strategy bids against, for our league: **16 teams, $200,
HALF-PPR auction** (the synced ESPN settings are `ppr: 0.5`). This doc was originally written
assuming No-PPR; the formulas are scoring-agnostic, but every positional split quoted below was
reasoned from the OLD No-PPR assumption and reads RB too rich / WR too thin for half-PPR. The
engine takes its scoring from the synced config, not from this page. Sourced from a 3-way web
recon (formulas, inflation/budget, data sources). Cites inline.

## 1. Projections -> VOR -> auction dollars (the core formula)

**VOR** = player's projected points minus a **replacement-level** baseline at their position. Pick
the baseline from league size + starter slots:
- **VOLS (last starter)** -- baseline = the last player at the position who starts across all
  rosters. For 16 teams: QB baseline ~= QB16; RB/WR ~= rank 33-34 (16 x 2 starters, FLEX pulls
  RB/WR/TE up a bit); TE ~= TE16. (VOLS trusts the waiver wire; VORP = worst-bench baseline is more
  conservative; man-games blends for byes.)
  (fantasyanalyticsauthority.com; subvertadown.com VBD baselines guide)

**Convert VOR to $** (standard VBD auction formula):
```
discretionary = (teams x budget) - (teams x rosterSpots x $1)      # money above min bids
rate          = discretionary / sum(max(0, VOR) over all draftable players)
value(player) = max(1, round( 1 + VOR(player) x rate ))
```
For us: teams=16, budget=$200 -> total $3,200; minus $1 x every roster spot. rate = discretionary /
total positive VOR. (fantasyfootballanalytics.net; pitcherlist.com worked example.)

Gotchas: floor every value at $1; INCLUDE bench-worthy players' positive VOR in the sum; scoring
shifts value toward volume RBs vs PPR. (Z-score/std-dev is an alternative that also rewards
consistency, but VOR is the standard and enough for v1.)

## 2. Position budget allocation (sanity targets for $200)

Use to sanity-check the value table and to set the Strategy's per-position tilt
(fantasylife.com; fulltimefantasy.com; si.com):
- **RB 35-45% (~$70-90)** -- real scarcity under the OLD No-PPR assumption; **WR 40-45%
  (~$80-90)** -- deepest;
  **QB 5-7% (~$10-14)** (elite $25-30 but $8-10 gets ~90%); **TE 5-15%**; **K/DST 1-2% ($1-2 each)**.
- **85-90% on starters, 10-15% on bench** ($1-5 each). **Never >70% of budget on 3 players.**

Strategy shapes: **stars-and-scrubs** (60-70% on 3-4 studs) vs **balanced** (40-55% on top 3, mid
tier $15-30 x 4-5). Our v2 `starterReserve` is exactly this dial (higher = more balanced).

## 3. Live inflation adjustment (the in-draft edge)

```
inflation = (money remaining across ALL teams) / (base value of ALL undrafted players) - 1
```
Recompute after each sale; multiply remaining players' base value by (1 + inflation) to get their
live max. inflation > 0 = market hot (studs going over book) -> your targets will come cheaper
later; inflation < 0 = bargains now. (draftexpertpro.com; rotoalpha.com)
We can approximate the inputs live: our budget from `readRoster`, opponent budgets from
`ul.picklist`, undrafted base value from our values table minus won players.

## 4. Nomination strategy (drives our nominate())

(fulltimefantasy.com) -- Early: nominate players you DON'T want (esp. elite RBs at a position you've
filled, and K/DST people overpay for) to drain opponents. Mid: once inflation is high, nominate YOUR
targets (they sell under value). Late: nominate $1-4 players to force thin-budget teams to spend.
Net rule: a nomination that costs an opponent money is +EV; one that costs YOU money is -EV.
-> upgrade `nominate()` from "cheapest filler" to "nominate an elite at a filled position, else a
cheap filler."

## 5. Max-bid discipline

Set max = our value; only chase +$2-5 for a pre-planned TARGET, with budget slack, when the tier is
genuinely thinning (< ~5 left). Enter with TIERS, not strict ranks, so a position run doesn't force a
reach. (draftsharks.com) -- our v2 already caps at value+premium; add tier-thinness as a premium trigger.

## 6. Data sources -- how to actually GET a values table (ranked, easiest first)

**Fastest (ready-made auction values, customize to 16-team/$200/half-PPR, then export to our CSV):**
1. **RotoWire** auction values -- free, customizable, $200/standard default. https://www.rotowire.com/football/auction-values.php
2. **RotoAlpha** auction calculator -- free, no signup, set teams/budget/scoring. https://www.rotoalpha.com/tools/auction-values
3. **Draft Sharks** -- free base values (default 1QB/2RB/2WR/1TE/1FLEX/1K/1DEF, $200). https://www.draftsharks.com/auction-values

**Build our own (projections -> VOR -> $ via section 1):**
4. **ffanalytics** R package -- scrapes 8 sources (ESPN/CBS/FantasyPros/NFL/...) into consensus
   season projections, free. https://github.com/FantasyFootballAnalytics/ffanalytics
5. **FantasyPros API** free tier -- JSON projections, needs a free API key; no auction endpoint.
6. **ESPN projections** -- `readBoard()` ALREADY reads ESPN's per-player $ live off the draft board,
   so a zero-dependency baseline is: snapshot the board once, hand-edit for our opinions.

**Note:** `nflreadpy` has ACTUALS + expected points, NOT preseason projections -- don't use it for
this. (nflreadpy docs; ffopportunity.)

## Plan for this project

- **v1 (before draft):** pull a ready-made **RotoWire/RotoAlpha** auction table set to 16-team /
  $200 / half-PPR -> write `data/values.csv` (`player,pos,value`). Name-match to ESPN (normalized;
  D/ST as team name). This alone gives the Strategy OUR values (a small edge + targeting).
- **v2 (in-strategy):** add **live inflation** (section 3) to `makeV2Strategy` using opponent
  budgets + remaining-pool value; add **tier-thinness premium** and the smarter **nominate()**.
- **v3 (own values):** compute VOR->$ from ffanalytics/FantasyPros projections for a true edge.

## Sources
draftexpertpro.com, fantasylife.com, fulltimefantasy.com, draftsharks.com, si.com,
fantasyanalyticsauthority.com, subvertadown.com, pitcherlist.com, fantasyfootballanalytics.net,
rotoalpha.com, rotowire.com, github.com/FantasyFootballAnalytics/ffanalytics, fantasypros.com/api-data.
