# Week state, feed freshness, and known injury designations in the simulator

**Status:** DESIGN, nothing implemented. Written 2026-09-18 after a session in which six defects
were fixed one at a time and each turned out to be the same defect wearing different clothes.

---

## 1. The fault, stated once

`SimContext` models the league's **structure** — who is on which roster, the schedule, the starting
slots, the board. It does not model the **week's state** — who can play, who is locked, what is
already scored, and how fresh any of that is.

So every verb re-derives the week's state at its own call site, by hand, inside a `switch`. The
coverage that produces, measured on 2026-09-18 across the ten copilot verbs:

| input | reached | of 10 |
|---|---|---|
| `availability` | lineup, stream | **2** |
| kickoff `locked` | lineup | **1** |
| `settledPoints` | lineup | **1** |
| feed freshness | — | **0** |

Every defect found that day is one of those cells being empty:

- the ESPN payload cache never expiring — freshness, 0/10;
- a man on injured reserve reading as startable — availability, 2/10;
- a quarterback who had already played being recommended as a starter — locks, 1/10;
- a headline total of "89.9 projected" when 35.0 of it was already scored — settled, 1/10.

Four of those cells were filled by hand during that session. The design below exists because filling
cells by hand is what produced a 2-of-10 table in the first place.

**The generalisation.** A decision surface consumes an input it never declares, and an absent or
stale input is indistinguishable from a healthy one. That is the same shape as this repo's recorded
scars — the producer/consumer contract drift, the guard keyed on a name, the coverage-by-enumeration
list that rots — and it is why the fix is structural rather than another four call sites.

---

## 2. Commit 1 — `WeekState`, assembled once, non-optional

### What

One object, built by one function, carrying what *this week* is:

```
WeekState {
  season, week            and how the week was decided
  availability            AvailabilityMap      who cannot play, with source + detail
  locked                  Set<nflTeam>         whose game has kicked off
  finished                { byScore, byElapsed }
  settledPoints           Map<playerId, pts>   what a finished man actually scored
  feeds                   FeedStatus[]         see commit 2
}
```

Assembled in `copilotContext()` — which already exists and is already documented as "build the
shared context once" — and hung off the context as `ctx.week`.

### Why non-optional is the whole point

`availability?: AvailabilityMap` on a per-verb options bag is *why* it could be forgotten: a verb
that never mentions it compiles, runs, and returns a confident answer. Moving it onto the context
makes omission impossible to express — a new verb receives it whether or not its author thought
about it.

This is the one part of the design that prevents recurrence. Everything else is hygiene.

### What must NOT be unified

`AvailabilityMap` (a *known* designation: "he is Out") and the simulator's `avail[tier]` (an
*unconditional rate*: "an RB misses 18% of weeks") are different information. Collapsing them is how
a model change gets shipped disguised as a refactor. Commit 3 is where they meet, deliberately, with
a gate.

### Conformance, derived rather than typed

A test that enumerates the verbs from `CopilotVerb` (not a hand-written list) and asserts, per verb,
that a **fault-injected** week state changes the output — an empty `availability`, a full `locked`
set, a `settledPoints` map. A verb that ignores the state it was handed fails there.

This is the anti-enumeration rule the repo already applies to the DST key test and the status
vocabulary test: check against the thing the system maintains, never against a snapshot of it.

### Risk

Low. Additive to the context; the verbs that already take these inputs keep taking them. The
suite's existing "no locks means byte-identical" test is the template for the per-input controls.

---

## 3. Commit 2 — a feed registry, and freshness that every result states

### What

One table: feed id → source table, as-of query, max age, refresh command.

```
gameday-status   raw_gameday_status        max age 1d in season   ff ingest-raw gameday-status
league-rosters   raw_league_roster_week    per-week policy        ff ingest-raw league-rosters
transactions     raw_league_transaction    per-week policy        ff ingest-raw league-transactions
injuries         raw_injury                max age 2d in season   ff ingest-raw injuries
news             news                      max age 1d             ff ingest-source news
ownership        ownership                 max age 1d             ff sync-rosters
```

`weekPayloadFreshAfter` (already written, already shared by the boxscore and transaction sweeps)
generalises into the per-week policy. `ff doctor` reads the same registry, so the check and the
serve cannot disagree about what "fresh" means.

### Behaviour on stale: degrade and say so loudly

Owner decision, 2026-09-18. Every result carries a `feeds` block, and a verb whose critical feed is
stale prints it by name, in the existing DEGRADED style:

```
DEGRADED: gameday-status is 4 days stale (as of 2026-09-14, max age 1d).
Availability may be wrong; the 13 exclusions may be understated.
Refresh: ff ingest-raw gameday-status
```

Refusing was considered and rejected: nflverse's injury feed lags by days and the tool has to stay
usable. The cost of degrading is that it relies on the reader, which is why the wording names the
feed, its age, the affected number, and the exact command.

### The trap this must avoid

A caveat that prints on every run stops being read. The rule is that the block is **silent when
everything is fresh** and names only the feeds that are actually stale.

---

## 4. Commit 3 — known injury designations in the simulator

This is the one the owner asked to be designed properly rather than deferred. The initial framing —
"2 of 192 rostered players are OUT today, so it is low priority" — was wrong, and the way it was
wrong is worth recording: it was a single snapshot, taken on a Friday before the weekend's injuries,
from a feed (`raw_gameday_status`) that only covers ESPN's game-day list, while the feed that would
give the real number (`raw_injury`) is broken upstream for 2026.

### 4.1 What the simulator does today

`src/draft/season.ts`, per player, per week, per trial:

```ts
const healthy = unitDraw(seed, trial, keyWeek, pid(p.name), PURPOSE.injury)
              < Math.min(1, (m.avail[tier] ?? 0.85) / (16 / 17));
```

`m.avail[tier]` is a per-position, per-tier fitted rate (games/17), drawn **independently every
week**. The fitted tiers:

| | tier 1 | tier 2 | tier 3 | tier 4 |
|---|---|---|---|---|
| QB | 0.907 | 0.594 | 0.244 | 0.131 |
| RB | 0.871 | 0.730 | 0.488 | 0.264 |
| WR | 0.892 | 0.754 | 0.523 | 0.292 |
| TE | 0.854 | 0.669 | 0.423 | 0.194 |

Two properties matter, and both are wrong for a man with a known designation:

1. **It is unconditional.** A top-tier RB is 0.871 whether he is healthy or has been Out for three
   weeks with a foot injury.
2. **It is i.i.d. across weeks.** Real injuries are *persistent*: a man who misses week 3 is far
   more likely to miss week 4. Independent weekly draws model transient absence, not an injury.

### 4.2 The prevalence, measured

`fact_roster_week` joined to `raw_injury`, settled seasons, skill positions only:

| season | roster-weeks | OUT | % | started OUT | % of starts |
|---|---|---|---|---|---|
| 2018 | 2339 | 70 | 3.0% | 3 / 1342 | 0.2% |
| 2019 | 2352 | 116 | 4.9% | 9 / 1344 | 0.7% |
| 2020 | 2387 | 90 | 3.8% | 2 / 1344 | 0.1% |
| 2021 | 2538 | 86 | 3.4% | 8 / 1428 | 0.6% |
| 2022 | 2558 | 104 | 4.1% | 11 / 1429 | 0.8% |
| 2023 | 2525 | 73 | 2.9% | 8 / 1427 | 0.6% |
| 2024 | 2520 | 83 | 3.3% | 7 / 1428 | 0.5% |
| 2025 | 2666 | 132 | 5.0% | 16 / 1630 | 1.0% |

**3–5% of rostered player-weeks, but only 0.1–1.0% of STARTED ones.** That gap is the finding:
managers (and the lineup optimizer) already bench the men they know are out. So the error does not
live in the started lineup — it lives in the **season simulator**, which prices every remaining week
of a rostered man at an unconditional rate, and therefore in every base probability that waiver and
trade deltas are measured against.

### 4.3 The model already exists and is already validated

`src/inseason/injuryHorizon.ts` + `data/injury-duration-artifact.json` (schema present, horizons
`[1,2,3,4]`, 31 features) gives **P(he misses the next k games), k = 1..4**, conditional on
designation, practice status, injury group, episode duration so far, prior episodes, age.

Its own header records the comparison, and it is decisive:

| model | nested log loss at k=1 |
|---|---|
| variance model's unconditional rate | **0.92** |
| designation-only baseline | 0.40 |
| the horizon model | **0.35** |

On the men actually on the report, the unconditional rate is not merely imprecise — it is **worse
than a constant**. That is the justification for the seam, and it is a measurement the repo already
made, not one this design is assuming.

**It is consumed by `handcuff.ts` and by a golden check in `models.ts`. Nothing else.** Not the
season simulator, not `seasonOdds`, not `powerRankings`, not `waiverTargets`, not `tradeFinder`.

### 4.4 The design

Replace the *threshold*, never the draw:

```ts
// today
const p = m.avail[tier] ?? 0.85;

// proposed
const p = knownAvailability(player, week) ?? (m.avail[tier] ?? 0.85);
```

`unitDraw` is untouched, so common random numbers are preserved and a player with no designation
produces a **bit-identical** trial. That is the property that makes this testable.

**Persistence is drawn once per trial, not once per week.** This is the part that must not be done
naively. The horizon model gives a *cumulative* statement — P(miss next k) — and converting it to
four independent per-week marginals would reproduce exactly the i.i.d. error the seam exists to fix,
while looking correct on the mean. Instead:

1. At the start of a trial, for each man with a designation, draw **one episode length** `L` from
   the horizon distribution (`P(miss >= 1) ... P(miss >= 4)`, with the tail beyond 4 falling back to
   the unconditional rate).
2. Mark weeks `w .. w+L-1` unavailable for that trial.
3. Weeks beyond the horizon revert to `m.avail[tier]`, because the model genuinely says nothing
   there and inventing a number would be the failure this repo keeps recording.

The mean effect is similar either way; the **variance** is not, and the variance is what playoff
probability is made of.

### 4.5 The constraint that shapes the rollout

The conditional model is **starved of input for 2026**:

```
raw_injury            29 rows, 4 teams   (nflverse upstream gap; the fetch runs and lands rows)
fact_injury_episode   7 rows  (vs 802 in 2025)
feat_injury_horizon   7 rows  (vs 1781 in 2025)
```

So shipping the seam today would give a seam that returns `null` for almost everyone — connected,
correct, and inert. That is a *dead lever* in this repo's vocabulary, and it must be recognised as
one before it is measured, or the backtest will report a null that is really a missing input.

**The bridge already exists.** `espnStatusToReport` (`src/features/sources/weekContext.ts`) maps
ESPN's vocabulary to the report designations the horizon model consumes, and ESPN's game-day feed
*is* current. A designation-only run scores 0.40 against the full model's 0.35 and the status quo's
0.92 — so an ESPN-fed, practice-status-less horizon is still far better than what ships today.

Rollout therefore has an order, and it is not negotiable:

1. Feed `feat_injury_horizon` from ESPN game-day status where nflverse is absent, and **report the
   split** (how many rows came from which source) so a degraded input is visible.
2. Prove the lever is CONNECTED before believing any null — `scripts/lever-connected.mjs`, plus a
   fixture where a man is designated Out for four weeks and his team's odds MUST move.
3. Only then measure.

### 4.6 The gate

This changes every simulated season, so it is a value/strategy change under **D13**:

- `npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150`
- PRIMARY gate is the **playoff** column against golden 96.0%; title 38.5% reported as context only.
- Paired seasons, `--dump-trials` + `scripts/paired-analysis.mjs`, not two aggregate percentages.
- Re-measured against the baseline intended to ship, and quoted on held-out seasons.
- **Owner sign-off before anything lands**, per the charter. Nothing ships as a side effect of this
  design being approved.

### 4.7 The controls, decided in advance

| control | must show |
|---|---|
| no designation anywhere | **bit-identical** trials to today |
| fixture: one starter Out 4 weeks | his team's playoff% **falls**, measurably |
| fixture: designation cleared | returns to the unconditional baseline |
| horizon artifact absent | falls back to `m.avail[tier]`, says so, does not throw |
| 2026 live | reports how many men got a conditional rate vs the unconditional one |

The second row is the one that matters most: it is the positive control. A seam that can only ever
return the unconditional rate is indistinguishable from a working one in every aggregate number.

---

## 5. What this design explicitly does not do

- It does not exclude OUT players from the odds. That prices a two-week injury as season-ending.
- It does not unify the known-designation map with the fitted availability rates.
- It does not touch `benchDiscount`, `consensusBlend` or any shipped lever.
- It does not ship anything from section 4 without the gate and a sign-off.

## 6. Open questions for the owner

1. **Section 4 ordering.** Feed repair (4.5 step 1) before or after the `WeekState` commits? It is
   independent of them, and it is the thing standing between the seam and a real measurement.
2. **Horizon beyond k=4.** Fall back to the unconditional rate (proposed), or extrapolate? Proposed
   is the honest option and is what the model's own contract supports.
3. **Whether IR should be special-cased.** An IR designation is a *rules* fact (a minimum number of
   weeks) as well as a medical one, and the horizon model was not fitted with that in mind.
