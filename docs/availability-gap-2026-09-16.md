# The availability information gap: measured, bounded, and closed as a routine (M2c)

2026-09-16. Executor pass. **Nothing about the model, the levers or any served artifact changed.**
What changed is that the repo can now (a) say how big the gap is, per class, with a positive control
on the instrument, and (b) take a second read of availability on Sunday morning and freeze it, so the
season accrues paired evidence instead of an argument.

`docs/in-season-backtest.md` states the mechanism in one sentence: our lineup starts a man who scores
exactly zero more often than the managers do, and "that is an information gap, not an optimisation
gap". That is a hypothesis about WHICH zeros. This pass turns it into counts.

---

## 1. What was measured

`scripts/availability-gap.mjs` (new, read-only) replays every team-week of league 462233, 2018-2025,
rebuilds OUR recommended lineup exactly as `scripts/inseason-backtest-lineup.mjs` does (same
`loadWeekContext`, same `optimalLineup`, same point-in-time availability block), and classifies every
zero-scoring START into four classes:

| class | definition | who can fix it |
|---|---|---|
| **a `friday`** | designated Out/Doubtful before the week's first kickoff, in `feat_player_week_model.inj_out` / `inj_doubtful` **or** in `feat_player_week_context.report_status_fri` | nobody -- we already refuse to start him. A non-zero count here is an availability-**plumbing** defect |
| **b `inactive`** | no Friday designation, and **zero snaps** in `raw_snap_count` | a Sunday-morning re-read. **This class is the whole subject of this document** |
| **c `played`** | took snaps, scored nothing | nothing. The irreducible floor |
| **d `dst`** | a team defence -- a synthetic key with no PFR snap row at all | not applicable; kept separate so it cannot inflate (b) |

The same classifier runs over the **managers'** own started men, on the same rosters, in the same
loop. That is the test of the story rather than a restatement of it.

### The positive control comes first, because class (b) is an ABSENCE

A man is called `inactive` because he has **no** snap row. An absent row is also exactly what a broken
crosswalk produces, so the script measures the crosswalk before it measures the NFL: **every player
who SCORED POINTS must carry a snap row.** Over 2018-2025 that is **99.6% (41,820 / 41,993, team
defences excluded)**. The run refuses below 95%, and `test/availability-gap.test.ts` fault-injects the
break -- corrupting `player_xref('pfr')` drives the rate to 0, so the control is demonstrably able to
fail.

---

## 2. The classification -- ours against the managers'

League 462233, 2018-2025, **1,896 team-weeks**, served arm (`WEEKLY_SERVE`, the mapping the live seam
resolves through):

| | starts | zeros | **a** friday | **b** inactive | **c** played | **d** dst |
|---|---|---|---|---|---|---|
| **ours (served)** | 15,096 | 527 (3.49%) | **0 (0.00%)** | **303 (2.01%)** | 217 (1.44%) | 7 |
| **the managers** | 15,108 | 527 (3.49%) | 68 (0.45%) | **211 (1.40%)** | 223 (1.48%) | 25 |

Three readings, in order of how much they change the picture.

**1. The headline zero RATE is no longer the story -- the COMPOSITION is.** `docs/in-season-backtest.md`
records 6.4% (floor) and 4.4% (challenger) against the managers' 3.5%. On the arm that actually
ships, ours is **3.49% against their 3.49%** -- identical. The gap in the aggregate closed when the
projector improved (the floor arm still reads 5.74%, and that difference is the model, not the feed).
What did **not** close is the part this document is about: **we lose 2.01% of starts to game-day
inactives and they lose 1.40%** -- 0.61 points of starting percentage, 92 extra scratches over eight
seasons. They pay it back elsewhere: **68 of their zeros were men already designated Out or Doubtful
on the Friday report**, which our rule refuses to start at all, and 25 were team defences against our
7. So the two totals are equal for opposite reasons. **The pre-registered test HELD**: their class-(b)
share is lower than ours, which is what "they read Sunday news and we do not" predicts.

**2. Class (a) in our own started set is ZERO, in all 1,896 team-weeks.** This was the check that
could have found a bug and did not. Every man our lineup started was startable under the
point-in-time block; no designation reached `feat_player_week_context.report_status_fri` and failed to
reach the column the optimiser reads. The availability path is connected, and the remaining loss is
genuinely information we did not have rather than information we had and dropped.

**3. The gap is shrinking on its own.** Per season, our class-(b) count: 38, 28, 39, **65**, 41, 35,
31, **26**. 2021 is an outlier in both arms; 2025 is the lowest of the eight. Read the bound below
against that trend, not against 2021.

Per season, in full:

```
  season   n   a/friday  b/inactive  c/played  ours-zero%  mgr-zero%  oracle gain
   2018  224         0         38        32       3.97%      2.75%       1.438
   2019  224         0         28        30       3.25%      3.38%       1.060
   2020  224         0         39        28       3.81%      3.20%       1.254
   2021  238         0         65        23       4.74%      4.11%       2.366
   2022  238         0         41        25       3.50%      4.01%       0.994
   2023  238         0         35        26       3.22%      3.05%       1.519
   2024  238         0         31        26       3.06%      3.99%       0.736
   2025  272         0         26        27       2.55%      3.37%       0.580
```

---

## 3. The recoverable-points bound

The bound is **not** derived from the class counts (a zero-scorer's cost depends on who replaces him,
not on how many there are). It is a paired re-run: the same team-week, the same projections, the same
template, with every class-(b) man marked UNAVAILABLE -- a **perfect** game-day read -- and the
resulting lineup scored on the same real results. Unit of analysis is the season, per CLAUDE.md.

| arm | recoverable, per team-week | season bootstrap (8 seasons) |
|---|---|---|
| **served (`WEEKLY_SERVE`, what ships)** | **+1.231 pts** | [0.908, 1.625] |
| challenger | +1.231 pts | [0.908, 1.625] |
| floor (season-line only) | +3.027 pts | [2.273, 3.909] |

**This is an UPPER bound and must be quoted as one.** The oracle knows every inactive perfectly; a
live 11:30 ET feed knows only what is published by 11:30, and neither catches a man hurt in the first
quarter. The realisable fraction is exactly what the `weekly_sunday` kind exists to measure, one week
at a time, against rows that were frozen before the games.

### It disagrees with edges.md #11, and the reason is legible

Edge #11 records **1.79 pts/team-week (2018-2024, 1,330 team-weeks)** and attributes it to
`scripts/inseason-backtest-lineup-info.mjs`. **That script is not in the repo** -- neither it nor
`src/inseason/backtest/playProb.ts`, the other artifact the edge names -- so 1.79 cannot be reproduced
today and is a recorded claim about a file rather than a number anybody can re-derive. (Per CLAUDE.md:
a reference to shipped code is a claim, not a fact. This one does not check out.)

The two numbers are not in conflict about the NFL; they are measured against different lineups over
different windows. 1.79 was the gap against a lineup built from the pre-`WEEKLY_SERVE` projector over
2018-2024. The floor arm here reads **3.03** and the served arm **1.23** on 2018-2025, which says the
same thing the composition table says: **the model improving has already taken most of it, and what is
left is about 1.2 points a week at the ceiling.** `scripts/availability-gap.mjs` supersedes the named
script; edge #11's 1.79 should be read as historical.

---

## 4. The workflow: the `sunday` routine and the `weekly_sunday` kind

### Why a new kind rather than a better Friday snapshot

The week's `weekly` rows are already frozen and `scorecard_prediction` is `INSERT OR IGNORE` by
design, so "update the projection with Sunday news" is not available and must not be: a record that
can be improved after the fact is not a record. The Sunday read is therefore a **separate, equally
write-once series** on the same players in the same week, and `ff scorecard` scores both against the
same actuals when the week settles. From week 3 on, the season produces the paired evidence directly:
Friday lineup, Sunday lineup, actual.

### The rows are COPIED, not re-projected

`freezeSundayKind` reads the frozen `weekly`/`weekly` rows for the week and writes them back under
kind `weekly_sunday`, **zeroing exactly the men the game-day feed rules out**. Re-projecting instead
would mean a difference between the two series could be the re-read OR a week's worth of new feature
rows, with nothing in the table saying which. Copying isolates the one variable. A zeroed man is what
"benched" means to `lineupRegret`: it will never pick him.

`weekly_sunday` is in `WHOLE_FIELD_KINDS`, so the scoring pass loads the same week's `weekly` rows
beside it as the comparison set -- without them its `lineup_pts` column would be NaN, which is the
number this whole workflow exists to produce.

### The window rule -- a refusal, not a preference

Two windows a Sunday, because the league plays in two waves and a man in the late wave is still
benchable at 15:00 when the early wave has kicked off:

- **early**: from `SUNDAY_LEAD_MINUTES` (90) before the first Sunday kickoff under 16:00 ET, until
  that kickoff. On a standard week that is **11:30-13:00 ET**.
- **late**: the same, against the first kickoff at or after 16:00 ET. On a standard week
  **14:35-16:05 ET**.

Outside both, `resolveSundayWindow` **refuses by name** and prints what the windows were. Between the
waves (13:00-14:35) there is deliberately no window: the early games have started and the late lead
has not. `ff sunday-refresh` evaluates the window **before it touches the network**, so a refused run
fetches nothing and writes nothing.

Everything is **America/New_York**, because `raw_nfl_game.gametime` is and because a kickoff is an ET
fact. The machine's own timezone is never read; `etClock` converts explicitly and `--now` injects an
ET wall clock. (This is the `iso()` bug in `scorecard.ts`'s own header, one timezone further out.)

### What the routine is

`ROUTINES.sunday` -> `ff sunday-refresh`, registered in the tick's `HANDLERS` map, **added to
`DEFAULT_ROUTINES`** after `scorecard` (the Sunday kind is a re-read OF the Friday rows, so it must
run after they are frozen). It rides the ordinary tick rather than a bespoke schedule for a plain
reason: the window is 90 minutes wide, twice a week, at a time nobody is at a terminal, and a routine
that fires only when a human remembers is a routine that does not fire. Running every tick is safe
**because the window is a refusal** and the freeze is `INSERT OR IGNORE`: over-running is a no-op by
construction, the same property `rankings` has.

`platforms: null` (the feed is ESPN's public, keyless NFL scoreboard -- an NFL fact, not a
fantasy-provider one, so the Yahoo league re-reads the same inactive list against its own frozen
rows); `needsApp: false`; `leagueScoped: true` (the rows are format-stamped and the lineup swap is
computed on one league's roster).

**The stored scheduler row overrides `DEFAULT_ROUTINES`, so enabling the cadence is an owner
decision, exactly as it was for `rankings`.** Nothing was enabled by this pass.

---

## 5. The live control, and the fixture dry-run

### Live, today (Wednesday 2026-09-16), against the real store

```
$ npm run -s ff -- sunday-refresh --league 462233
SUNDAY RE-READ 2026 -- 2026-09-16 17:02 ET
  REFUSED: 2026-09-16 is not an NFL Sunday in season 2026 -- raw_nfl_game carries no dated REG
  Sunday game that day, so there is no inactive list to re-read and nothing to freeze.
  Nothing was fetched and nothing was written.
```

**That refusal IS the control.** A run that quietly froze a "Sunday re-read" on a Wednesday would be
indistinguishable in the table from an honest one. Nothing was written to `data/ff.db` by this pass.

### The fixture dry-run: a Sunday, replayed, with players flipped to inactive

Everything below ran against a **scratch copy** of the store, so the production store holds no
`weekly_sunday` row and no fixture-sourced `raw_gameday_status` row. The fixture is a saved feed
(`src/data/gamedayStatus.ts` now splits `fetchGamedayStatus` from `storeGamedayStatus`, with
`loadGamedayFixture`/`saveGamedayFixture` between them) carrying two of our own week-2 starters as
`Out`: Jared Goff (QB, our only quarterback) and Amon-Ra St. Brown (WR).

Outside the window, on the same Sunday, with the same fixture:

```
$ ff sunday-refresh --season 2026 --now 2026-09-20T09:00 ...
  REFUSED: 2026-09-20 09:00 ET is outside every re-read window for week 2. The windows are
  early 11:30-13:00 ET and late 14:35-16:05 ET (90 minutes before each wave's first kickoff).
```

Inside it:

```
$ ff sunday-refresh --season 2026 --now 2026-09-20T11:45 --fixture <saved feed> --dry-run
  feed (fixture): season 2026 week 2 -- 2 designations stored (2 OUT, 0 unresolved) across 1 games
SUNDAY RE-READ 2026 -- 2026-09-20 11:45 ET
  week 2 windows: early 11:30-13:00 ET (8 games), late 14:35-16:05 ET (2 games)
  window: early
  SKIPPED: --dry-run: 530 row(s) WOULD be frozen under kind weekly_sunday model sunday_early
           at 2026-09-20T11:45:00 ET; nothing was written.
  game-day OUT on the frozen population: 2 -- Amon-Ra St. Brown (WR, Out), Jared Goff (QB, Out)
  OUR LINEUP MOVES:
    OUT Jared Goff (QB)         ->  IN (empty) (-)              proj -15.54
    OUT Amon-Ra St. Brown (WR)  ->  IN Ladd McConkey (WR)       proj -1.03
    OUT Ladd McConkey (FLEX)    ->  IN Jameson Williams (WR)    proj -1.49
    OUT Jameson Williams (FLEX) ->  IN Marvin Harrison Jr. (WR) proj -1.07
```

**The lineup moves him out**, and the cascade is real: benching St. Brown pulls Marvin Harrison Jr.
off the bench three slots down. The QB slot **empties** because this roster carries exactly one
quarterback, which is the honest answer and not a bug -- the swap diff is computed **per SLOT**, not
by zipping the dropped list against the added list, because the latter reports "OUT the quarterback ->
IN a receiver", which is not what happened.

Then, without `--dry-run`, on the scratch store:

```
froze 530 row(s) under kind weekly_sunday at as_of 2026-09-20T11:45:00 (write-once)
```

and the write-once + two-series properties, read back out of the table:

| model | rows | as_of | zeroed |
|---|---|---|---|
| `sunday_early` | 530 | `2026-09-20T11:45:00` | 3 |
| `sunday_late` | 530 | `2026-09-20T15:00:00` | 3 |

A second call inside the same window: `SKIPPED: week 2's early Sunday re-read was already frozen --
it is written once, so a second call in the same window is a no-op rather than a rewrite`, and the
first `as_of` survives it. The benched rows carry their reason in `meta`:

```json
{"window":"early","kickoff":"13:00","opens":"11:30","tz":"America/New_York",
 "rereadOf":"weekly/weekly","benched":"Out","source":"gameday(espn)"}
```

(`zeroed: 3` against 2 benched: one player's Friday value was already 0.)

**The `--fixture` path relaxes the NETWORK, never the point-in-time rule.** A fixture run still obeys
the window, and a fixture whose season/week disagrees with the open window is named in a warning
rather than silently used.

### The positive control on the SCORING half: it is not enough that the kind writes

A kind that freezes rows nothing can ever score is a record, not a prediction -- the exact defect
`scorecard.ts` documents having shipped once already with the `odds` kind. So the scratch store was
given a settled week 2 (actuals filled locally, in the scratch copy only) and `ff scorecard` re-run.
`weekly_sunday` scores, both windows, **with a lineup column beside the Friday one**:

```
  week  kind                model               n     RMSE     CRPS    cover   lineup  winShare
  2     weekly              weekly            502    8.582    5.103    0.556    90.83     0.340
  2     weekly              shipped_week      502    8.212        -        -    90.60     0.000
  2     weekly_challenger   two_part          502    8.620    5.124    0.566    88.90     0.310
  2     weekly_sunday       sunday_early      502    8.618    5.145    0.552    88.82     0.335
  2     weekly_sunday       sunday_late       502    8.618    5.145    0.552    88.82     0.335
```

The `lineup` column is the whole point: on a real week it is Friday's number against Sunday's, on the
same actuals, from rows frozen before kickoff. (In THIS control the actuals are synthetic noise, so
the Sunday arm scores slightly LOWER -- it benched two men whose fabricated points were fine. That is
the correct behaviour of the plumbing, not a result, and it is stated so nobody quotes 88.82.)

Before the week settles, the absence is stated rather than left as a gap:
`week 1 has no Sunday re-read (kind weekly_sunday) -- nothing to score for it`.

---

## 6. Tests

`test/availability-gap.test.ts` (13) -- the classifier, every branch from a fixture, plus the two
index builders against a tiny real store:

- `played` / `inactive` driven as a **pair**: the same man with and without a snap row must change
  class. A classifier that only ever returned one of them would pass either half alone.
- the index is keyed by **week**, asserted: reading season-level presence would absolve every inactive
  of every other week.
- a Friday designation wins over the snap test, **from either column**; `Questionable` does not bench;
  a DST is never `inactive`.
- **fault injection on the control**: corrupt `player_xref('pfr')` and the snap control rate must fall
  to 0. A control that cannot fall cannot catch a broken join.

`test/sunday-kind.test.ts` (15) -- the window and the kind, every refusal driven as a pair (the moment
it must refuse **and** the moment it must accept):

- non-Sunday refuses; Sunday-before-the-lead refuses **and names the windows**; inside the lead it
  does not; at kickoff it is too late again.
- the late wave is its own window; the 13:00-14:35 gap is asserted so nobody merges the two.
- the clock is ET: `2026-09-20T16:00Z` must read `12:00` and open the **early** window.
- no frozen `weekly` rows -> refuse; outside the window -> table untouched; inside -> 2 rows written
  **and** the second call writes 0 while the first wrote 2; the late window writes a **second** series
  rather than touching the first.
- a game-day `Out` zeroes that man and leaves everyone else's value **byte-for-byte**; `Questionable`
  does not bench and `Doubtful` does (the same rule as `copilot.ts`'s `OUT_STATUSES`, imported rather
  than copied); a status the feed never sends benches nobody; another format's frozen rows are
  invisible.

`test/routines.test.ts` -- the handler-map check **was a hand-kept enumeration** of the verbs in
`HANDLERS`, i.e. coverage-by-enumeration, which rots exactly when somebody keeps it in step with the
registry and not with the map. It now **parses `HANDLERS` out of `src/ff.ts`** and carries a positive
control on the parse (it caught its own first regex, which stopped early on the generic value type).
Fault-injected: removing `"sunday-refresh"` from the map makes it fail with the right message, and
restoring it makes it pass.

---

## 7. Gates

- `npm run typecheck` -- clean.
- `npm test` -- **1,041 tests, 0 failing** (3 skipped), 28 of them new. The suite's total count drifts
  by a few between runs (some suites are data-driven); the number that matters is 0 failures.
- `npm run lint` -- 46 warnings, **zero new**. Shown directly rather than by subtraction: `eslint` run
  over exactly the eight files this pass created or changed is **clean, exit 0**. The 46 are
  pre-existing `no-useless-assignment` / `no-explicit-any` elsewhere (the four in `src/ff.ts` are at
  lines this pass did not add).
- `npm run ff -- backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024
  --n 150` -- **39.5% / 96%**, per-season line byte-for-byte:
  `2000:28 2001:31 2002:44 2003:47 2004:32 2005:29 2006:49 2007:19 2008:47 2009:55 2010:44 2011:62
  2012:47 2013:41 2014:29 2015:38 2016:29 2017:33 2018:41 2019:36 2020:43 2021:35 2022:54 2023:33
  2024:40`.

Store: backed up first with an online `db.backup()` to `data/ff.db.bak-prem2c-2026-09-16`
(`integrity_check` ok). **The production store was not written by this pass at all** -- the only
window-open runs were against a scratch copy, and the one live run refused. ESPN and Yahoo were read
only through the public, keyless `site.api.espn.com` scoreboard; no click submitted anything; the app
was not driven.

---

## 8. What is NOT closed, said plainly

- **The bound is an oracle.** 1.23 pts/team-week is the ceiling of a perfect read, not a forecast of
  what the 11:30 ET feed delivers. The realised fraction is unknown until `weekly_sunday` has settled
  weeks behind it -- which is the point of freezing it rather than arguing about it.
- **No `weekly_sunday` row exists in the production store yet.** The first real one can only be
  written on 2026-09-20, inside a window, and only if the routine is enabled (or the verb is run by
  hand). **Enabling the cadence is an owner decision.**
- **The feed's own coverage is unmeasured here.** `storeGamedayStatus` now counts unresolved
  designations, which it did not before, but nobody has yet measured what fraction of real game-day
  scratches ESPN's summary block carries at 11:30 against the full inactive list. That measurement
  needs live Sundays.
- **Edge #11 needs an edit** -- its 1.79 figure cites two files that no longer exist. This document
  does not touch `docs/edges.md`; the correction is recorded here and is the owner's to apply.
- **2025's injury block is no longer empty.** `docs/in-season-backtest.md`'s "Limits" says 2025 has no
  injury block so availability there is bye-only; the store now carries 429 `inj_out` rows for 2025,
  so that limit is stale. It does not change any number above (2025's class-(a) count is 0 like every
  other season), but the doc line should be corrected by whoever owns it.
