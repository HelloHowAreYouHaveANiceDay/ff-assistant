# Validation harness (how we know a change is better, not a regression)

`ff sim` is an offline auction-draft simulator that scores our drafting objectively, so we can
iterate on values/strategy and SEE whether each change helps or hurts -- no live drafts, fast,
deterministic per seed.

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

## What it found (and how it corrected us)

Tuned defaults come from the harness, not intuition:
- **Over-balance loses:** starter-reserve 20, max-share 0.25 -> avg finish 1.99, only 36% firsts.
- **Full stars-and-scrubs is risky:** premium 30 / max-share 0.7 ($169 on top 3) -> high points but
  more busts (lower top-3 rate under projection risk).
- **Moderate wins:** starter-reserve ~6-8, max-share ~0.5 (~2 studs, ~$95 on the top 3) -> best
  finish (~1.76) with less variance. This is now the default. (My earlier "go fully balanced" read
  from the tendencies alone was wrong -- the harness with risk showed moderate-aggressive is best.)

## Honest limits (so we don't over-trust it)

- The **bot model and the 35% projection noise are assumptions**; the ABSOLUTE numbers (e.g. "50%
  firsts") are inflated because the bots are simple. Trust the RELATIVE comparison between configs,
  not the absolute win rate.
- Scoring truth = `data/points.csv`. It is currently **2024 ACTUALS as a projection proxy** -- swap
  in real 2025 preseason projections (docs/value-methods.md) and rebuild values (`ff values`) for a
  sharper table; the harness workflow is unchanged.
- The sim does not model nomination gamesmanship, keepers, or in-season waivers.

## Files
`src/draft/values.ts` (VOR->$), `src/draft/sim.ts` (simulator), `tools/build_points.py`
(nflverse points), `data/points.csv`, `data/values.csv`. Rebuild: `uv run --with nflreadpy --with
polars tools/build_points.py` then `npm run ff -- values`.
