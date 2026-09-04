# League Tendencies: seacaptaindate.com (462233)

Pulled live from ESPN draft recaps 2023-2025 ($200 auction). **League size CHANGED: 2023 and 2024
were 14-team, 2025 and 2026 are 16-team** (verified against ESPN 2026-09-03), so ~$400 less money
was in the 2023/24 rooms -- compare the per-year POSITIONAL TOTALS below only within an era, and
treat **2025 as the year that matches this season's format**. **Scoring: the synced 2026
ESPN settings are HALF-PPR (`ppr: 0.5` in `league.scoring_json`)** -- the engine reads the synced
rules and is correct; earlier revisions of this doc said No-PPR and were wrong. **Verified against
ESPN 2026-09-03 (`scripts/scoring-history.mjs`): reception points = 0.5 in 2023, 2024, 2025 AND
2026 -- the scoring did NOT change, this league has ALWAYS been half-PPR.** So the recap spend
history below is directly comparable to what the room will pay this year (no "expect hotter WRs"
adjustment needed) -- but any reasoning that explained the spend BY No-PPR was never valid, not
merely stale. The league is
long-running (seasons 2012-2026) with mostly returning managers -- so these tendencies are a real,
stable read on how THIS room drafts. Raw data: `data/draft-recap-{2023,2024,2025}-raw.txt`
(analyze with `node analyze.mjs <file>`).

## The numbers (very consistent 3 years running)

| Metric | 2025 | 2024 | 2023 |
|---|---|---|---|
| Total $ spent | 3157 | 2767 | 2783 |
| Avg / pick | 16.4 | 15.2 | 15.3 |
| **Median price** | **$2** | **$2** | **$2** |
| Top price | $103 | $106 | $88 |
| Players > $50 | 25 | 22 | 22 |
| Players > $30 | 43 | 39 | 36 |
| **% picks $1-5** | **61%** | **61%** | **61%** |
| RB total (max) | 1292 ($103) | 1055 ($106) | 1093 ($88) |
| WR total (max) | 1291 ($97) | 1287 ($81) | 1126 ($88) |
| QB total (max) | 328 ($68) | 192 ($32) | 312 ($61) |
| TE total (max) | 206 ($74) | 199 ($47) | 215 ($83) |
| K + D/ST | ~$20 each, max $5 | ~$18 each, max $2 | ~$19 each, max $3 |

## The league's DNA: aggressive stars-and-scrubs

1. **~3-4 studs at $80-106, then the roster filled at $1-5.** 61% of every draft is $1-5 picks
   (median $2) EVERY year. This room concentrates budget hard on the top.
2. **Elite RB/WR set the top of the market at $80-106.** RB studs consistently go highest
   (once attributed to a No-PPR RB premium -- that explanation was simply WRONG: the league was
   half-PPR in every one of these seasons, so this is a genuine revealed preference of THIS room
   for RBs, not a scoring artifact, and it should be expected to persist):
   Bijan $103, Saquon $101, Gibbs $95 in 2025; a $106 RB in 2024.
3. **One elite TE goes big ($74/$47/$83), the rest punt TE** (~$11 avg).
4. **QB is streaky** -- some years an elite QB goes $60-68 (Lamar $68), other years the top QB is
   only $32. So elite QBs are SOMETIMES cheap.
5. **Nobody pays for K/DST** -- $1-2, max $5, all three years. Free.

## What this means for OUR draft (actionable)

- **To WIN a stud here, budget $80-100+.** Our elite values / max bids need that headroom, or we
  accept we won't land a top-5 RB/WR. The v2 budget-aware cap allows it early (surplus is high).
- **The contrarian edge is the MID-TIER ($15-40).** Everyone else goes stars-and-scrubs (studs +
  $1 fills), so the $15-40 band is under-contested. A **balanced build** -- skip the $100 studs,
  load up on 6-7 solid $15-35 players -- is likely optimal against THIS room. Lever: raise
  `--starter-reserve` (more balance) and set a `--max-share` well under 50%.
- **Punt K/DST at $1** (confirmed 3 years). Do not let the agent bid more.
- **Watch for a cheap elite QB** -- in a stars-and-scrubs room, QBs can slip; a $30-40 elite QB is
  a steal. Our values should rate elite QBs fairly so we pounce if the price is low.
- **Expect high inflation on the top tier, deflation in the mid/low tier.** Our live-inflation
  logic (docs/value-methods.md section 3) will read this: as studs go for book+premium, remaining
  players deflate -> our mid-tier targets get cheaper. Lean into that.

## Recommended posture

> **Corrected by the CHAMPIONSHIP backtest (Step 5, docs/validation.md):** the SIM (season points)
> liked concentration, but that proxy over-rewards top-heavy rosters. On the trustworthy full-system
> no-lookahead backtest, **BALANCED wins**: defaults are now `--starter-reserve 15 --max-share 0.35`
> (measured on the EVEN-SPLIT value curve: 24.2% titles vs 15.7% for the old aggressive-lean 5/0.6;
> re-verified on the shipped weighted curve at 25.7% vs 24.6%/24.1% neighbours -- docs/validation.md).
> The room overpays for STUDS that bust
> weekly, so a deep balanced roster banks that overpay -- do NOT chase the top studs.

Historical read (still true): let opponents overpay for the very top ($100 studs), win the $15-40
tier and the cheap-elite-QB window, punt K/DST at $1. But DO buy ~2 studs at fair value. Nominate elite RBs early (drain their
budgets, section 4 of value-methods) since they will overpay.

## Follow-ups (not done)
- Per-MANAGER tendencies (who specifically overpays for RBs / punts QB) -- the recap groups picks by
  team but the scrape didn't reliably attach team labels; a cell-level scrape could map $ to
  manager. Returning managers are identifiable by abbreviation across seasons (e.g. MOOS = <owner>
  <owner>, "Out of the Country, Cant Draft").
- Champions/standings trends (who is good) -- history page has 2012-2026; not yet extracted.
