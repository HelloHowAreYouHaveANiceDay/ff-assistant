# Validation harness (how we know a change is better, not a regression)

Two tools, both offline/fast/deterministic per seed:
- **`ff backtest`** (the trustworthy one for CHAMPIONSHIPS): drafts on a past season's projections,
  then plays a real head-to-head season + playoffs on that season's ACTUAL weekly results ->
  reports our **championship rate**. Weekly variance, byes, and single-elim playoffs are real, so it
  rewards the RIGHT thing.
- **`ff sim`** (fast season-points proxy): one draft, score by starting-lineup season points. Handy
  for quick iteration, but it over-rewards top-heavy rosters (no playoffs) -- prefer backtest for
  strategy calls.

## `ff backtest` -- optimize championship wins (2024)

`npm run ff -- backtest --n 800 [--starter-reserve N --max-share F --premium N]`
Draft with 2024 values (data/values-2024.csv, from data/points-2024.csv), simulate the 2024 season
(weeks 1-14) + playoffs (top 6, weeks 15-17) on real weekly points (data/weekly.csv). Lineups are set
each week by projection, scored by ACTUAL, and a bye/injured starter can't play -> DEPTH matters.

**Projection UNCERTAINTY (the key knob, default sd 0.30):** everyone drafts on a NOISY projection of
the season (a stud can be mis-projected), scored by the real weekly truth. Without it the draft has
perfect foresight and trivially rewards concentration; with it, buying "studs" carries real bust risk.

### Run it across MANY seasons (essential -- single seasons overfit)

`ff backtest --seasons 2014-2024 --n 150` loops every season in `data/history-{points,weekly}.csv`
(built by `tools/build_history.py`) and aggregates. **Always use the multi-season number** -- a
single season's championship estimate swings 25%<->50% for the SAME config just on seed/sample
noise, so single-season "findings" are overfit (I made that mistake: a 2024-only run showed
"reserve 5 = 50.6%, optimal", which did NOT replicate -- 2024 at high N is ~25%).

> [!note] The absolute %s in the two sweeps below were measured against the OLD uniform bot (pre
> src/draft/managers.ts). The DIRECTIONS still hold (aggression ~neutral; an independent/tighter
> projection is the top lever), but the absolute championship levels are lower against the realistic
> field -- re-run any sweep you want to quote to the decimal.

### What 11 seasons (2014-2024) actually show
Championship rate, ~1650 sims/config (random = 6.3%):
- reserve 5 / max-share 0.6 (default): **27.3%**
- over-balanced (reserve 20 / 0.25): 27.6%
- max stars-and-scrubs (premium 30 / 0.85): 27.9%
- moderate (reserve 10 / 0.45): 27.7%

**The aggression dial is roughly NEUTRAL for championships across seasons (~27%, all within noise).**
Its effect is real within any one season but washes out across seasons -- so do NOT over-tune it.

**Where the edge actually is:** our team wins ~27% of titles = **4.4x the 6.3% random baseline**, and
makes the playoffs ~92% of the time, REGARDLESS of config. That edge comes from drafting rational
values against a field that OVERPAYS for studs (your league's real tendency) -- not from the
stars-and-scrubs vs balanced choice.

### VALUE edge, quantified (`--our-noise` vs `--market-noise`)

`ff backtest --our-noise F --market-noise 0.30` gives the market (bots) a projection with error sd
`market-noise` and US a projection with error sd `our-noise`. If ours is tighter (or just
INDEPENDENT), we spot mis-priced players and win value; everyone still scores by the real weekly
truth. Sweep (11 seasons, config fixed):
- our projection = the shared consensus everyone uses -> ~27% (no value edge, discipline only).
- our OWN projection, SAME accuracy (independent errors) -> ~39%. **+12 pts just for not sharing the
  room's blind spots.**
- tighter accuracy: 0.25 -> 41%, 0.20 -> 43%, 0.12 -> 44%, 0.05 -> 46%.
So VALUES are the top tunable lever (config is not). Full breakdown: docs/edges.md. So: keep a sane MODERATE default (reserve 5-8, max-share
0.5-0.6) for steadiness (balanced has the widest bad-year swings), invest in better VALUES + keeping
our discipline vs the room, and don't chase a "perfect" aggression setting -- there isn't one.

## FULL-SYSTEM backtest (`--full --no-lookahead`) -- the whole pipeline end-to-end

`ff backtest --full --no-lookahead` runs the ACTUAL production modules together on real historical
seasons: values.ts (VOR->$) -> strategy.ts (draftField) -> projections.ts -> inseason/lineup.ts
(the real optimizer, availability-aware), scored by real weekly results + playoffs.
- `--full` = our team sets each week's lineup with the REAL `optimalLineup`, not a synthetic noise.
- `--no-lookahead` = our projection for season Y is season Y-1's actuals (a real, crude forecast
  with ZERO future knowledge); scored by Y's weekly truth.

Result (2015-2024) against the REALISTIC per-manager field (see below): **~13% championships,
~2.1x random, 66% playoffs**, stable 6-23% by year. Draft-only is ~18% (2.9x). These REPLACED the
earlier ~36%/~27% numbers, which were measured against a uniform "everyone overpays for studs" bot;
that bot left random value everywhere and flattered us. The realistic heterogeneous field
(QB-payers, RB-first, QB/TE-punters, calibrated to real spending) is a genuinely harder, more honest
opponent -- trust these lower numbers, not the old ones.

## REALISTIC opponent field (src/draft/managers.ts) -- the bot model

The 15 bot seats are each a REAL manager from this league, modelled on 4 years of auction history
(docs/league-managers.md, `data/managers.json`). Each bot reproduces its owner's positional appetite
(a QB-payer chases QB; a punter won't), a per-position spend budget (share x $200 -> stops chasing a
position once its allocation is spent), and a concentration-scaled stars-and-scrubs curve.

**Calibrate it: `ff calibrate --n 300`** runs an all-bot field and prints simulated vs real positional
share + concentration + biggest-buy per owner. Current fit: mean-abs-error QB 7% / RB 8% / TE 2% /
concentration 8% (WR ~18%, the soft spot). This is the fault-injection guard -- the RB-heavy manager
must come out RB-heavy, or the model is disconnected from the data.

**Nomination (`--drain-nom`, `--greedy-nom`) -- backtested, NOT a win.** Drain-nominating the known
position-payers LOWERS championships (18% -> 12%); greedy "nominate the best non-target" also trails
(15.5%) the value-greedy default. Rational bots don't tilt, so the sim can't reward nomination
gamesmanship (docs/edges.md) -- it's a human-only edge, kept as a documented live option, not defaulted.

**Live repricing (`--inflation`, `--scarcity`) -- inflation WINS, scarcity loses.** Repricing our
values by remaining$/remaining-book-value (`src/draft/inflation.ts`) adds **+~2 championship pts /
+3 playoff pts** (draft-only 17->19%, full no-lookahead 12->14%; stable at n=300). Unlike nomination,
this is a mechanical market correction the rational bots don't neutralize -> it's real. **ON by
default in the live bidder** (`--no-inflation` to disable). Live uses a start-normalized, bounded
[0.8,1.4] estimate (the draft board is virtualized, so exact remaining book value isn't cheaply
readable). SCARCITY/VONA premium tested NEGATIVE (-4.5 pts) -> OFF by default: the deep 16-team pool
keeps the next-available player close, so a live premium mostly overpays.

Confirmed in a live ESPN mock: inflation reads ~1.0 early and drifts down as the room spends down
(money leaves faster than talent here), so the agent gets more patient and snipes value late -- the
validated mechanism, live. (Live inflation is now computed EXACTLY from the scraped drafted set via
`espnAuction.readDraft`, not the old virtualized-board proxy.)

**Per-position inflation (`--pos-inflation`) -- backtested, REJECTED.** Fading the position the room is
overpaying adds ~nothing over global inflation and slightly hurts combined (draft-only 19.1->18.8%,
full-system no-lookahead 13.9->13.4%; ~neutral alone). Disciplined value-bidding + global inflation
already fades overpaid positions, so explicit fading double-counts. OFF by default; the per-position
empirical inflation is kept in the draft log as a human signal only (docs/edges.md).

**Waivers (`--waivers`) -- backtested and REJECTED as an auto-feature.** Adding automated waiver
churn (swap our weakest for the best-producing free agent, trailing-avg or ROS-blend, no lookahead)
DROPPED championships 36% -> ~24-27%, and more churn made it worse. In a deep 16-team league the
free-agent pool is replacement-level, so churn trades real drafted talent for hot-hand noise. -> the
waiver feature is a conservative HUMAN-GATED copilot (`src/inseason/waivers.ts`), not auto-execution.
The backtest prevented shipping a title-losing feature.

**Read it honestly:** the 36% is a FLOOR on projection quality -- last-year actuals miss rookies and
undervalue players who were hurt last year, so a real preseason projection (ffanalytics/FantasyPros)
would do better. It also omits waivers/trades, which would ADD edge. The bot field is a model, so
trust the multiple-of-random (~5.7x) and the cross-season stability, not the absolute %.

## `ff sim` (season-points proxy)

## What it does

1. Loads a **projection** table (`data/points.csv`) and OUR **values** (`data/values.csv`).
2. Drafts 16 teams: **our team uses the REAL `makeV2Strategy`** (so the sim validates production
   code, not a copy); the 15 bots bid a market model anchored to true value but **overpaying for
   studs** (calibrated to seacaptaindate.com's tendencies -- docs/league-tendencies.md).
3. **Projection RISK:** each player's REALIZED points = projection x (1 + noise, sd 35%). A stud
   can bust. This is what makes concentration risky and balance valuable -- without it the sim has
   perfect foresight and trivially favors buying the priciest studs.
4. Scores every team by its best legal STARTING-lineup realized points, and reports our roster's
   points, average finish (of 16), and 1st / top-3 rate, averaged over N seeds.

Run: `npm run ff -- sim --n 300 [--values FILE] [--starter-reserve N --max-share F --premium N]`

## The regression-guard workflow

Change one thing (a value table, a strategy param), run `ff sim --n 300` before and after:
- **our starting pts up + avg finish down (toward 1) = better.**
- pts down / finish up = **regression** -- revert.
Use N>=300 so seed noise averages out; compare the same N.

## What it found (and how the guidance evolved)

The harness repeatedly corrected intuition -- which is the point:
- **From tendencies alone I guessed "go fully balanced." Wrong.** Over-balance (reserve 20,
  max-share 0.25) finishes WORST in every run.
- On the **2024-actuals** proxy, MODERATE won (reserve ~8, ~$95 on top 3).
- On the **forward-looking 2025 projections** (steep top, deep 16-team No-PPR), **CONCENTRATION
  wins** -- more aggression -> better finish (reserve 2 / max-share 0.8 / $181-on-3 finished ~2.6
  vs ~3.5 for moderate). This MATCHES the league's real behavior (61% of picks are $1-5).
- **Default = aggressive-lean but not extreme** (reserve 5, max-share 0.6, premium 2; ~$120 on the
  top 3). The optimum is INPUT-SENSITIVE, so re-run `ff sim` on the final projections before the
  draft and pick the config -- don't hardcode faith in one run.

## Known limitation to weigh (why we don't just go max-aggression)

Scoring = sum of the starting lineup's realized points. This likely **over-rewards top-heavy
rosters**: it counts a $1 replacement WR2 as "some points" without fully penalizing that a lineup
of 3 studs + 6 waiver-level starters has a low weekly floor and loses head-to-head matchups the
season-sum metric can't see. So treat "max stars-and-scrubs wins" as an upper bound; the default
keeps real depth. A future harness upgrade: simulate weekly head-to-head wins, not season points.

## Honest limits (so we don't over-trust it)

- The **bot model and the 35% projection noise are assumptions**; the ABSOLUTE numbers (e.g. "50%
  firsts") are inflated because the bots are simple. Trust the RELATIVE comparison between configs,
  not the absolute win rate.
- Scoring truth = `data/points.csv`, now **2025 forward-looking projections** (FantasyPros redraft
  consensus ranks mapped onto a 2024 No-PPR points-by-rank curve -- `tools/build_projections.py`).
  Independent of ESPN. A true multi-source projection (ffanalytics / a projections API) would sharpen
  it further; the harness workflow is unchanged.
- The sim does not model nomination gamesmanship, keepers, or in-season waivers.

## Files
`src/draft/values.ts` (VOR->$), `src/draft/sim.ts` (simulator), `tools/build_projections.py`
(2025 FantasyPros ranks -> points), `tools/build_points.py` (2024 actuals variant), `data/points.csv`,
`data/values.csv`. Rebuild before the draft:
`uv run --with nflreadpy --with polars tools/build_projections.py` then `npm run ff -- values`,
then re-run `npm run ff -- sim --n 400 ...` to pick the config.
