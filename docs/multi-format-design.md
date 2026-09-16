# Multi-format architecture — parallel models under different rulesets

**Owner ask (2026-09-15):** run multiple leagues, and let the EDGE come from *customizing the config/model
to each league*, not from stretching one model across formats. Each league optimizes for the
championship, but "the factors may be different" — so feature engineering is per-format where it pays.

This builds on `docs/multi-league-refactor.md` (Phase 1/2 storage) and replaces its "model layer" sketch
with a concrete, grounded design. It is written against the real seams mapped 2026-09-15 (see that map's
six areas); file:line references below are to that state of the tree.

## The one idea: separate League, Format, and Model — and key the Model by the format, not the league

Three identities are conflated today. Splitting them is the whole design:

| Identity | What it is | Keyed by | Examples |
|---|---|---|---|
| **League** | an account/team you manage | `league_id` | ESPN 462233, Yahoo 129048 |
| **Format** | the ruleset that determines the model | derived key(s) | half-PPR/16-team/auction; superflex-PPR/12-team/snake |
| **Model** | trained artifacts + admitted features + levers + golden | **format key**, NOT league | one per distinct format |

**Two leagues with the same format share one Model.** The format key is a content hash of the
format-relevant config. Add a league whose format already exists → reuse its model for free. Add a league
with a new format → train once, then reuse for any future league that matches. This is what makes
"parallel models under different rulesets" N models for N *formats*, not N copies for N *leagues*.

### Layered cache keys — maximize reuse (the elegant part)

The model is not monolithic; it decomposes into layers of increasing specificity, each with its own key.
A league reuses everything it matches at each layer:

```
Layer 0  COMPONENTS        (no key, one shared copy)
         raw production per player-week: nflverse stats  ⨝  raw_pbp_player_week
         (rush/rec/pass yds, TDs, receptions, first downs, 40+ plays, air yards, RZ/GTG)

Layer 1  PROJECTION        scoringKey = hash(ScoringRules++)
         target pts = Σ_weeks score(components_w, rules);  trained projector + weekly heads
         → shared across any leagues with the SAME SCORING, regardless of roster

Layer 2  VALUE BOOK        valueKey   = hash(scoring + slots + flex-eligibility + teams + draftType)
         VOR→$ (auction) or rank/tier (snake); replacement levels
         → shared across leagues with same scoring AND roster economics

Layer 3  STRATEGY + GATE   formatKey  = hash(everything incl. playoff calendar)
         admitted feature set, strategy levers, golden master (championship gate number)
```

Worked example. ESPN league = `{half-PPR, 16-team, 12-slot, auction, 7-team/wk14-16 playoff}`. Add Yahoo =
`{PPR+bonuses, 12-team, superflex+3flex, snake, 8-team/wk15-17 reseed}`: **new at every layer** (that is
why it is the hard case, and the right one to build first). Add a *third* league that is superflex-PPR
with identical scoring+roster to Yahoo but a different playoff calendar: **reuses Layer 1 and Layer 2,
new only at Layer 3** — one small golden refit, no retrain. That reuse falls out of the key design for free.

Key derivation is canonical: sort keys, round floats to a fixed precision, stringify, hash. Stable so the
same format always maps to the same key; excludes cosmetic/identity fields.

## What is SHARED vs PER-FORMAT vs PER-LEAGUE

- **Shared NFL core (one copy, no key):** raw feeds, identity, the **component substrate** (Layer 0), and
  the candidate feature *library* (all computable columns — the pbp/opportunity/volatility candidates we
  already built plus new ones). Market data (ADP/projections) is *mostly* shared but has a format
  dimension — ADP differs by format (superflex ADP ≠ half-PPR ADP); tag it by `scoringKey`/`valueKey`
  where it is consumed as a value anchor.
- **Per-format (keyed as above):** scoring rules; the target `pts`; the *admitted* feature set; trained
  artifacts (projector, weekly, fold set); the value book + draft model; strategy levers; golden master.
- **Per-league (`league_id`, mostly already done in Phase 2b):** config (which *names* a format), roster/
  standings/waiver state, decision snapshots. `board`/`player_value` become a per-**format** working cache
  (keyed by `valueKey`) instead of a single active-league slot, so two leagues can hold live boards at once.

## The scoring redesign — declarative, component-based, non-linear-safe

Today `scoreWeek(nflverseRow, ScoringRules)` (scoring.ts:269) is a linear dot product and the comment
relies on "per-week sums == season". That linearity is exactly what a bonus format breaks.

1. **Extend `ScoringRules` to a superset expressed as DATA**, so any ruleset is a value, not code:
   - linear per-stat weights (as today);
   - `bonuses: {stat, threshold, points}[]` — yardage milestones (300+ pass, 100+ rush/rec, tiered);
   - `firstDowns: {rush, rec, pass}` — points per first down;
   - `bigPlays: {rush40, rec40, cmp40}` — points per 40+ yard play;
   - keep the existing non-linear K distance buckets and DST points-allowed ladder.
2. **Score on the UNIFIED component row** = nflverse `stats_player_week` ⨝ `raw_pbp_player_week` (first
   downs, 40+ plays, air yards already live there — schema.sql:1008). This makes the richer stats
   *scoreable*, not merely *feature-able*, closing seams #1 and #2 at once.
3. **Score per week, then sum to the season target.** Thresholds are non-linear, so the season `pts` MUST
   be `Σ` of weekly scores, never a scoring of season aggregates. `buildHistory` already scores weekly —
   keep that level; the season target is the weekly sum.

Scoring stays a pure function `score(components, rules) → pts`; the ruleset is data; the target for any
format is `Σ_weeks score`. **`scoringKey = hash(rules)`.**

**Positive controls (charter rule 4):** (a) reproduce ESPN half-PPR *byte-for-byte* through the new path —
generality must not move the incumbent's number; (b) ground-truth Yahoo scoring against Yahoo's own
applied points over real player-weeks, the way DST was ground-truthed (scoring.ts:97-133), before trusting
any Yahoo target.

## Per-format target + retarget pipeline

The mechanism exists (`buildHistory` takes a `LeagueScoring`, history.ts:133). The change is to make it
multi-output and store per-format rather than baking one column:

```
data/formats/<scoringKey>/
  scoring.json            the resolved rules (+ provenance: synced-from / ground-truthed-against)
  history-points.csv      season target baked under THIS scoring (Σ weekly)
  history-weekly.csv      weekly target
  features.json           the ADMITTED feature set for this format (see below)
  projection-artifact.json, weekly artifacts, fold-artifacts/    trained heads
  golden.json             the championship gate number(s) for this format
data/formats/<valueKey>/  value book params (or nested under scoringKey)
```

Artifacts live as **files, not DB tables**: disjoint dirs → parallel trains never contend on the single
`data/ff.db` writer (CLAUDE.md), and it matches the existing on-disk artifact pattern
(`projection-artifact.json`). The shared component tables stay in the DB, read-only, once. `train-format
<key>` bakes the target from components + trains + golden-checks (against scikit predict, as D16). The
legacy baked `feat_player_*.pts` becomes a compatibility cache for the *active* format only.

## Per-format feature engineering — where "the factors may be different" lives

This is the owner's edge thesis, made concrete. The candidate feature **library is shared**; the
**admitted set is per-format**:

- `scripts/admit-feature.mjs`, `weekly-paired-floor.mjs`, `gate-variant.mjs` gain a `--format <key>` axis:
  screen a candidate under *that format's target* and gate on *that format's* championship number.
- A feature ships for a format iff it clears THAT format's paired floor AND that format's gate.
- The trainer reads `data/formats/<key>/features.json` as the fitted set; the Python module constants
  become the DEFAULT candidate *library*; `projector.ts:FEATURE_FIELDS` stays the union allowlist so any
  admitted subset validates.

**Why this is a real edge, not ceremony:** the ~10 pbp/air-yards/volatility candidates we screened and
*rejected this session were rejected under half-PPR scoring*. Air yards / aDOT / deep-target share have an
obvious mechanical reason to clear under a **big-play + first-down** format (Yahoo) that they cannot under
half-PPR — the bonus literally pays for the thing the feature measures. QB rushing / dropback volume have
the same case under **superflex** (QB scarcity + rushing floor). Re-screening the existing library under
the Yahoo target is the single cheapest way to demonstrate the edge, and it reuses machinery we already
built. Same pre-filter discipline first (charter rule 2): orthogonality/partial-corr against the level
under the new target, then the expensive screen.

## The championship gate, per format

Each format gets its own golden master (lazily — approved decision #3 in the refactor doc). `cpcv.mjs` /
`backtest` gain `--format <key>`: read that format's scoring/slots/playoff, use its target CSVs, its value
book + draft model. A feature/lever admits for a format only against that format's golden.

**Sequencing insight that unlocks the Yahoo edge WITHOUT the snake engine:** the championship gate needs a
drafted roster — *except* the D18 season simulator already **starts from the season so far** (seeded from
current real rosters, `loadSimContext`). So Yahoo *in-season* championship odds (playoff %) can be gated
from the actual roster with **no draft engine at all**. The snake engine is required only for *draft-day*
value and *pre-draft* backtesting. That means the in-season "our-model" Yahoo edge (retarget + superflex +
per-format features + seeded playoff-odds gate) is reachable before any snake work.

## The two hard walls (net-new, called out honestly)

1. **Superflex valuation. CLOSED (D24 for the value book, D25.3 for the marginal book, 2026-09-16).**
   The wall as it was originally stated, kept because it is what landed: `FLEX_ELIGIBLE` excludes QB
   (values.ts:102), so an OP/superflex slot is valued as an RB/WR/TE flex and QB replacement level is
   wrong — which is the *entire* point of superflex. Fix: make flex-eligibility part of the format
   (`slot → eligible positions`), and let `baselines()` (values.ts:135) fill a superflex slot from
   QB+RB+WR+TE. Surgical, but it moves numbers → re-gate.

   **What landed.** `src/draft/values.ts` now carries `slotEligibility` and `resolveValueLeague` emits
   `flexGroups`, so a slot is an ELIGIBILITY SET and `baselines()` fills the flex slots laminarly by
   group (D24). `src/draft/lineupMarginal.ts`'s `starterBaselines` was the second, separate copy of the
   same mistake and was fixed the same way, via `splitTemplate` from the one slot module (D25.3).

   **The numbers, both directions.** Yahoo 129048 superflex: the QB baseline moved 12.935294 →
   **10.594118** pts/wk (a deeper replacement, so QB VOR rises — the point of the format); the FLEX
   cutoff moved 5.370588 → 5.835294 (the three FLEX slots no longer absorb the superflex slot); RB/WR/TE
   5.335/5.371/5.324 → 5.741/5.835/5.441; a `SUPERFLEX` cutoff exists where there was no entry at all.
   ESPN 462233, the incumbent, at openFraction 1 / 0.5 / 0.25: **0 differing keys**, all seven baselines
   identical — the generalisation is identity for a non-superflex template. FAULT INJECTION: with the
   `SUPERFLEX` token removed from the Yahoo template, every key returns to the old answer, which is what
   separates "the superflex slot did this" from "something else changed". Locked in
   `test/marginal-superflex.test.ts` (5 tests, itself fault-injected). The championship backtest is
   unmoved: **39.5% titles / 96% playoffs**.

   **Still open inside the closed wall:** the laminar fill now exists TWICE (`values.ts baselines()` and
   `lineupMarginal.ts`), with `test/marginal-superflex.test.ts`'s agreement check as the only thing
   stopping them drifting. One exported `laminarFlexFill(pool, groups)` in `slots.ts` retires it.
2. **Snake draft engine. CLOSED (WP11, 2026-09-16) -- see "Wall 2 -- the snake DraftModel" at the end
   of this document.** The wall as it was originally stated, kept because it is what landed:
   None exists; the auction path (VOR→$, second-price sim, nomination) is
   meaningless for snake. Introduce a `DraftModel` interface with two implementations:
   - `AuctionModel` — the existing computeValues + sim.ts auction.
   - `SnakeModel` — rank/tier value = expected VOR at pick given ADP; the backtest "draft" becomes
     serpentine pick order over a pick-value curve.
   `sim.ts`/`backtest.ts` branch on `format.draftType`. This is the largest build and is **deferrable**:
   nothing in the Yahoo *in-season* edge needs it.

## LeagueContext v2 — the one chokepoint

Extend the Phase-1 stub (leagueContext.ts:17) to carry format identity + lazily-resolved model handles;
`resolveLeagueContext` computes the keys from config and resolves the format dir. Every threaded caller
comes along for free (its whole reason to exist):

```ts
interface LeagueContext {
  leagueId: string | null;
  config: AppConfig;              // names a format
  format: FormatSpec;            // scoring, slots + eligibility, draftType, playoff calendar
  scoringKey: string; valueKey: string; formatKey: string;
  model: ModelHandle;           // resolved paths to this format's artifacts (lazy)
}
```

## Parallel execution

Formats are independent; a backtest is single-threaded (MEASURED 3.2% of cores, CLAUDE.md). So training/
gating N formats is embarrassingly parallel via `src/util/pool.ts` (`pMap` + `withCpuSlot`, the same
primitive the CV fold loop uses), each format a single-core task, writing to disjoint `data/formats/<key>/`
dirs. `ff train-format --all` fans out; the only shared resource is the read-only component DB.

## Phasing (each independently shippable + reversible; STOP-and-CONFIRM before each lands — charter rule 1)

- **3a — Scoring generalization.** Extend `ScoringRules`; unify the component row; week-level non-linear
  scoring. Gate: byte-exact ESPN half-PPR reproduction + Yahoo applied-points ground-truth.
- **3b — Per-format target + `train-format`.** `data/formats/<scoringKey>/`; retarget from components;
  train + golden-check. Positive control: retargeting to half-PPR reproduces the shipped artifact.
- **3c — Per-format feature engineering.** `features.json` per format; re-screen the library under the
  Yahoo target (pre-filter → paired floor). This is the edge demonstration.
- **3d — Superflex valuation.** Eligibility-driven flex fill; re-gate ESPN (must be null) + Yahoo.
- **4 — Per-format championship gate.** `cpcv --format`; per-format golden; in-season uses the D18 seeded
  simulator (no draft).  ← **Yahoo in-season "our-model" analysis is reachable here.**
- **5 — Snake draft engine.** `DraftModel` interface + `SnakeModel`. Draft-day only; deferrable.
- **6 — LeagueContext v2 threading + `train-format --all` + league/format UX.**

## Phase 3a — LANDED (2026-09-15): scoring generalization (pure, no re-ingest)

Owner chose the full stack incl. snake, and to prove the per-format edge early. Started at the
foundation. What landed:

- **`ScoringRules` extended** with OPTIONAL non-linear/positional terms (`src/draft/scoring.ts`):
  `recByPos` (TE premium), yardage milestone tiers (`passYdBonus`/`rushYdBonus`/`recYdBonus`, cumulative),
  first-down points, and 40+ yard-play points. A ruleset that omits them scores byte-for-byte as the old
  linear model.
- **`scoreWeek(r, s, pos?)`** now position-aware (defaults `pos` to the row's own column) and applies the
  extended terms guarded on presence. Threaded `pos` at the history caller.
- **`YAHOO_129048_SCORING`** constant = the league's exact offense table, read from its live settings.
- **Tests** (`test/scoring-model.test.ts`, 14/14): the byte-exact half-PPR POSITIVE CONTROL (row carries
  first-down/40+ columns; a linear ruleset must ignore them), hand-computed Yahoo QB/TE cases, cumulative
  300/400 milestone, TE-premium isolation, and fault injection on each Yahoo term. `tsc` clean.

**The finding that collapses the plan's scope:** every Yahoo component is ALREADY in the nflverse
`stats_player_week` feed `scoreWeek` reads — `passing/rushing/receiving_first_downs` and
`passing_40/rushing_40/receiving_40` (counts of 40+ yд plays), verified against the cached 2024 file.
**So Phase 3a needs NO pbp extension and NO re-ingest** — the pbp 40+/first-down work in the original
sketch is unnecessary. The scorer just reads more of the same row.

**The exact Yahoo 129048 offense scoring (all skill positions; league rosters no K/DST):**
pass 0.04/yд, **6/TD**, **−2/INT**, +2@300 & +3@400 yд; rush/rec 0.1/yд, 6/TD, +2@100 & +3@200 yд;
**rec 1.0 (QB/RB/WR), 1.5 (TE)**; 2PT 2, fumble −2; **40+ cmp/run/rec +2 each**; 1st downs
**pass 0.2 / rush 0.5 / rec 0.5**.

**Phase 3b acceptance gate — PASSED (2026-09-15).** `YAHOO_129048_SCORING` was ground-truthed against
Yahoo's OWN applied points (stat code `S_W_1`, in-league) over 8 real week-1 player-weeks via
`scripts/yahoo-scoring-groundtruth.mjs` + a live scrape: **8/8 EXACT** (Allen 49.26, Lamar 38.66, Goff
22.44, Burrow 20.96, Bijan 35.80, Jefferson 33.70, Nacua 15.40, McBride 32.00). These jointly validate
every uncertain semantic: the 300-yд pass milestone (cumulative reading confirmed), the nflverse
`passing_40`/`receiving_40` to Yahoo "40+ play" mapping (Allen x2, Lamar x3, Nacua x1), the TE reception
premium (McBride 9x1.5), full-PPR receptions, first downs, 6-pt TDs, and INT. Verified against the other
side's numbers, not just internal tests. (Rush-yд milestone / 40+ rush use the identical `tierBonus`/`nz`
code path already validated on the pass side.)

## Phase 3b — target BUILT + verified (2026-09-15)

- **Format keys** (`src/data/formatKey.ts`): `scoringKey(rules)` = `sc-<12hex>` of the canonicalized
  scoring (keys sorted, floats rounded, tier arrays sorted) so identical rules always map to the same key
  and never silently retrain. Yahoo 129048 -> `sc-a845f67652fb`.
- **Per-format target** (`buildHistory` gained an optional `outDir`; `scripts/build-format-target.mjs`):
  re-scored history written to `data/formats/<scoringKey>/history-{points,weekly}.csv`, NEVER touching the
  active league's `data/*.csv`. Built 2014-2025: 19,514 season rows / 194,817 weekly, sk resolved 99.5%.
- **Controls:** the `outDir` redirect is byte-identical across two builds (deterministic + pure); the Yahoo
  target differs from the half-PPR target (scoring actually moves the target). Correctness of the numbers
  themselves rides on the 8/8 scoreWeek ground-truth above -- buildHistory only applies scoreWeek per week
  and sums.
- **Face validity = the edge, made concrete:** the 2025 Yahoo target's top 24 is **QB:13 RB:6 WR:4 TE:1**
  (Stafford 516.5, Allen 502.9, Maye 487.5 lead). That QB dominance is exactly the superflex + 6-pt-passTD +
  full-PPR signal our half-PPR ESPN model is blind to -- concrete proof that retargeting changes what the
  model should value.

**Dependency surfaced for the TRAINING step (3b cont.):** the projector's features are not all
scoring-independent -- prior-season fantasy points and the base rank curve are pts-DERIVED, so retargeting
is the target AND those features, not the target alone. The gate that proves the plumbing is correct:
**retargeting to the ESPN league's own scoring must reproduce the shipped ESPN artifact** (the half-PPR
positive control). Component-stat features (targets, carries, air yards, ...) stay shared.

## Phase 3b — per-format PROJECTOR trained + verified (2026-09-16)

- **Per-format features DB** (`scripts/build-format-features.mjs`): copy the store -> rebuild
  `feat_player_season` under the format target CSVs -> `data/formats/<key>/features.db`. So
  `train_projection.py --db <that>` trains the format model with NO python change (it already takes `--db`).
- **Retarget gate PASSED:** feat `pts` == the 8/8-verified Yahoo target CSV (8/8 top-2024), and
  `prior_pts[Y] == pts[Y-1]` point-in-time invariant 503/503. So the scoring-derived features (pts,
  prior_pts, ranks, curves) really are retargeted, not silently half-PPR.
- **Trained** (`data/formats/sc-a845f67652fb/projection-artifact.json`): same recipe as shipped ESPN
  (`--learner gbm`, 300 trees, 1999-2025). **Self-check vs sklearn `predict()` passed** (the golden gate).
- **Serves correctly Yahoo-scaled** projections: Hurts 497.6 (Yahoo) vs 310.3 (ESPN half-PPR); the QB tier
  lifts to match the verified target.

**HONEST FINDING (charter rule 4).** Raw projected points favor QBs in EVERY format (they score most), so
"QBs dominate the projection top-24" shows up under BOTH artifacts (Yahoo QB:21, ESPN QB:20) and is NOT the
superflex edge. **The superflex edge is a VALUE-layer (Layer 2) effect:** one-QB ESPN gives QBs low VOR
despite high points; superflex makes QB replacement level brutal, so the same tier becomes scarce and
valuable. The projector's job (format-correct raw points) is done and verified; the edge is realized when
Layer 2 converts points -> value under the format's roster. This reorders the "prove the edge" plan: the
most compelling proof is the Layer-2 superflex VOR gap, not a projection-accuracy feature re-screen.

**Known feature approximations carried (flagged, not yet fixed):** `fftoday_proj` and `ecr_pos_rank` are
half-PPR-scaled market anchors used as ratio-form features; the model rescales them but a Yahoo-native
consensus/projection would be cleaner. Component-stat features are format-independent and shared.

## Layer 2 — value book + superflex DONE (2026-09-16)

The value model now treats each roster slot as an ELIGIBILITY SET, not a fixed FLEX bucket
(`src/draft/values.ts`):
- **`slotEligibility(slot)`** parses dedicated positions, keyword flexes (FLEX/OP/SUPERFLEX), and
  slash-forms (Yahoo `W/R/T`, `Q/W/R/T`). `resolveValueLeague` emits per-team `dedicated` counts +
  `flexGroups` (each with its eligible positions), alongside the legacy `starters` map.
- **`baselines` fills flex slots with a laminar greedy** — each player, best first, takes the
  most-constrained open group that admits him. QBs can only fit a SUPERFLEX group, so under Yahoo's
  6-pt/PPR scoring they claim essentially all superflex slots, deepening QB replacement from ~QB13 to
  ~QB25. With a single `[RB,WR,TE]` group it reduces byte-for-byte to the old fill.
- **K/DST reserve** is now per actual K/DST slot (0 for skill-only Yahoo; unchanged `teams*2` for ESPN).

**Controls:** ESPN byte-exact via the existing regression locks (weighted flex fill / even split /
dual-eligible) — all pass; `tsc` clean; +3 new superflex tests incl. fault injection (remove the slot →
QB value reverts). 15/15 in `test/values.test.ts`.

**The edge, concrete** (`scripts/value-format-compare.mjs`, project 2025, same player pool + our models):

| | Yahoo (superflex) | ESPN (1-QB half-PPR) |
|---|---|---|
| QBs in top-24 by VALUE | **8/24** | **2/24** |
| top asset | Hurts $55, Lamar $47 | Bijan $103 (top QB is #11) |
| QB replacement baseline | QB25 (282 pts) | QB17 (229 pts) |

The value posture flips: superflex makes QBs the scarcest, highest-value assets; the ESPN model would
undervalue them badly in Yahoo. This is the format edge, captured by our own model.

**Next (culmination):** feed this into the live Yahoo waiver/trade analysis. That needs 2026 rest-of-season
projections in the format DB (2026 preseason feat rows + the D18 ROS blend, retargeted), then VOR under the
Yahoo config vs the current roster -> our-model waiver/trade advice, replacing the borrowed Yahoo projections.

## Step 4 — rest-of-season blend (D18) applied to Yahoo (2026-09-16)

`scripts/yahoo-ros-analysis.mjs` folds the season so far into the our-model value via the SHIPPED
`rosPerGame` (`src/draft/rosBlend.ts`): `ros_pw = (K*line + k*rate)/(K+k)`, line = our Yahoo preseason
projection/17, rate = to-date Yahoo points/week, K=6 (`data/ros-blend.json`). K is an NFL-level
stabilization constant reused across formats (refitting on a Yahoo weekly table is a minor follow-up
once the weekly track is retargeted). Only NFL week 1 is final upstream, so k=1 -> one week carries ~14%
weight (the D18 discipline that stops a hot week from dominating).

Effect vs the preseason value: the blend starts **Shough at SUPERFLEX ($26) over Goff ($18)** on his
week-1 emergence, and lifts **Gesicki ($9) and Freiermuth ($4)** above the weak-flex line -- the same
emergers Yahoo's ROS flagged, now from our model. This closes the preseason-vs-ROS gap the Layer-2 step
identified: the analysis is now format-native AND in-season-aware.

## Invariants (do not break)

- The one rule (D13) gates every value/strategy change — now **per format**, against that format's golden.
- Single-format behavior stays byte-identical until a second format's model actually exists (every phase
  carries a positive control that reproduces the ESPN incumbent).
- No ship without stop-and-confirm; 3a and 5 are the boundaries that most need it (a scoring change moves
  every number; the draft engine is net-new logic).

## Status 2026-09-16 (morning) -- superseded the same day

The 2026-09-16 architecture review (`docs/architecture-review-2026-09-16.md`) read this design against
the live tree that morning and found the phases above had landed the ARTIFACTS but not the plumbing:
nothing in `src/` read `data/formats/`, the Yahoo model was script-only with a hand-copied config, and the
format DB's weekly table was a half-PPR copy (findings F-1, F-2, F-4, P-5). Every one of those was closed
by the end of the day -- the sections that follow (the Resolver, the Yahoo in-season first run, the Yahoo
weekly track, wall 1 and wall 2) are the current state, and section 5 of the review is the ledger. What
remains open is listed there: no superflex ADP archive, no Yahoo draft history in the store, the
`manifest.weekly` blindness caveats named per section.

## The Resolver (WP3, 2026-09-16) -- all three bullets above are now CLOSED

`src/data/formatResolve.ts` is the single map from "which league" to "which model's files". Read its
header for the full argument; the contract in short:

**The three keys are real functions** (`src/data/formatKey.ts`). `scoringKeyFor({rules, kicker,
defense})` is the projection layer, `valueKey(cfg)` the value book (the eligibility structure
`resolveValueLeague` emits + teams + budget + draftType), `formatKey(cfg)` the gate (valueKey + the
playoff calendar). All three canonicalize first, so key order, float noise below 1e-6, tier-array
order and slot order cannot fork a key, and provenance fields (`source`/`fetchedAt`/`note`/divisions)
are excluded so a re-sync does not fork the gate. The live leagues:
`462233 -> sc-f6143a8dfb13 / vk-c1a75ecab6fc / fk-57c2d3d5bfa2`,
`129048 -> sc-a845f67652fb / vk-93b577871e68 / fk-3a298dfdeb32`.

**Kicker and defense fold in by DEFAULT-ELISION.** They enter the scoring hash only when a league
declares a table DIFFERENT from `DEFAULT_KICKER`/`DEFAULT_DEFENSE`. That keeps both live keys (ESPN
stores the defaults; Yahoo stores `null` because it rosters neither) while a league with its own K or
DST rules gets its own format -- which matters because `history.ts` bakes K and DST rows into the
target. "kicker null" and "kicker at the default" deliberately share a key: both produce the same
target, and whether a league STARTS a kicker is a roster fact carried by `valueKey` one layer down.
The alternative -- a full re-key hashing `{rules, kicker, defense}` unconditionally -- would have
renamed `data/formats/sc-a845f67652fb/` and migrated every `scorecard_*.format_key` row for no
behavioural gain.

**Two rules, both refusals.** (1) The incumbent key aliases the `data/` ROOT, pinned as
`INCUMBENT_SCORING_KEY` and asserted at module load against `DEFAULT_SCORING`. (2) Every other key
must have `data/formats/<key>/` AND a `scoring.json` whose canonical re-hash equals the directory
name -- the preimage that makes a directory NAME falsifiable -- or the resolve THROWS, naming the
build command. There is no fallback to the root, because a fallback serves every unbuilt format the
incumbent's numbers and every one of them renders perfectly.

**Availability is per artifact.** `model.has(name)` / `model.require(name)` over the artifact table
(history CSVs, current-actuals, features db, projection, fold dir, four weekly artifacts,
variance/rank-outcomes/correlation, points/values/def-ratings, golden, scoring, manifest), so a
consumer refuses BY NAME -- "format sc-a845f67652fb has no weekly artifact" -- instead of reading the
root's copy. SHARED-NFL artifacts (injury duration, opponent correlation, age curve, opportunity
model, the ros-blend K, the nflverse cache, `ff.db`) stay at the root by design: they are fitted on
facts about football, not about a ruleset.

**The serve rule.** A format with no weekly artifact yields `null` from `projectStreamingWith`, which
is what the in-season copilot already reads as "no weekly projector was supplied": it falls back to
`basis: "projection"` -- that FORMAT's season line divided by the week count -- and says so in
`assumptions.basisNote`. Never the root artifact.

**What a second format still needs before it is gated end to end:** its own `current-actuals` (`ff
sync-actuals --league <id>`), a weekly artifact, variance/rank-outcomes/correlation fits, a blind
fold set (`manifest.weekly.seasonLineBlind` records honestly when the weekly season line is not
blind), and a `golden.json`. Of those, WP7 landed the actuals, the three fits and the gate AXIS; the
weekly artifact, the fold set and the golden itself are still missing for Yahoo 129048, and the
sections below say exactly what that costs.

## Yahoo in-season, first run (2026-09-16, WP7)

The Yahoo superflex league produced in-season numbers from its OWN model for the first time. Every
figure below is from `ff copilot <verb> --league 129048` on the live store with `active_league`
switched to 129048, week 2 of the 2026 season, and every one of them carries three caveats stated
once here and repeated in each result's own caveat sentence.

**Season odds** (`--schedule real`, 2000 trials, seed 7). Playoff probability over the twelve teams,
which sums to **exactly 8.0000** -- the league's playoff field size, the conservation law this
simulator must satisfy and the first time it has been exercised at anything but 7-of-16:

| team | playoff% | title% | | team | playoff% | title% |
|---|---|---|---|---|---|---|
| T7 | 79.60 | 15.70 | | T3 | 64.95 | 8.25 |
| T12 | 79.05 | 14.85 | | T5 | 61.05 | 4.70 |
| T10 | 71.35 | 9.10 | | T4 | 59.55 | 4.35 |
| T2 | 70.85 | 9.50 | | T8 | 58.85 | 5.70 |
| **T11 (us)** | **68.35** | **10.25** | | T6 | 54.70 | 2.65 |
| T9 | 66.10 | 8.20 | | | | |
| T1 | 65.60 | 6.75 | | **sum** | **8.0000** | **1.0000** |

**Lineup** (week 2, expected-points objective): QB Joe Burrow, WR Garrett Wilson, WR Jameson
Williams, RB Omarion Hampton, RB Chase Brown, TE Kyle Pitts, FLEX Carnell Tate, FLEX Jacory
Croskey-Merritt, FLEX Michael Mayer, **SUPERFLEX Jared Goff** -- the superflex slot filled by the
second quarterback, which is the whole point of WP5's slot module, and neither IR slot flagged.
150.4 projected points; Isiah Pacheco listed OUT (Back).

**Waivers**: base 69.30% playoffs / 10.40% title, noise floor 2.89pp; top claim ADD Mike Gesicki (TE)
/ DROP Isiah Pacheco for +3.20pp playoffs, FAAB ~32 at `faabBasis: "rule"` on the league's OWN $100
FAB budget (10% of budget per +1pp of playoff probability -- a stated rule of thumb, not a fit, and
there is no fitted FAAB model for this league).

**THE THREE CAVEATS, and none of them is small.**

1. **UNGATED.** `cpcv.mjs --league 129048` REFUSES: this format has no `golden.json`, and a pre-draft
   gate would need the snake `DraftModel` that does not exist. Nothing here has been checked against a
   pinned number the way the incumbent's 96.0% playoff golden checks the ESPN board. These are the
   model's answers, not validated answers.
2. **NOT SEEDED, and the season-line inputs are not blind.** The league has played a week, but no
   started-lineup snapshot for it reaches the store (`raw_league_roster_week` is ESPN-only), so the D18
   seeding REFUSES rather than scoring every team zero and handing the home side the tie -- the
   simulation runs the full season from preseason lines and the caveat says so. Separately,
   `manifest.weekly.seasonLineBlind` is `false` for this format: no per-season blind fold set has been
   built, so any historical evaluation of it would be reading a line that has seen its own season.
3. **NO WEEKLY ARTIFACT.** Every point total above is the format's season projection divided by 17
   (`basisNote: "no weekly projector was supplied..."`) -- no matchup, no recent form, no weather. That
   is the honest degradation the serve rule specifies, not a silent read of the incumbent's weekly
   model, but it is a materially weaker projection than the ESPN league gets.

Two smaller things, recorded so they are not rediscovered: the format's `history-weekly.csv` still
scores K and DST under the DEFAULT rules (this league rosters neither, so nothing consumes those rows,
but the K/DST tiers of its variance model are consequently identical to ESPN's); and the format's board
still carries K and DST players, so `waivers` can offer a kicker in a league with no kicker slot.

## The Yahoo weekly track (WP8, 2026-09-16) -- caveats 2 and 3 above are now CLOSED

The three caveats of the first Yahoo in-season run said the weekly serve was the crudest model in the
repo: no blind fold set (so nothing historical could be evaluated), no weekly artifact (so every point
total was the season line over 17), and a rest-of-season K borrowed from the ESPN fit. The weekly track
now exists for this format on the same recipe the ESPN one ships (D16/D17/D19/D23), and every number
below is measured rather than asserted.

### 1. The blind fold set

`tools/train_projection.py --db data/formats/sc-a845f67652fb/features.db --holdout-season Y` for
Y = 2012..2025, into `data/formats/sc-a845f67652fb/fold-artifacts/artifact-Y.json` -- fourteen
artifacts, the same range and the same recipe as the incumbent's `data/fold-artifacts-d16`
(`--learner gbm`, depth 3, 300 rounds; the Yahoo projector's own header). Run seven at a time through
`xargs -P 7`; ~30 s each, single-core, disjoint outputs.

THE BLIND PROOF, and it is three separate facts because "the file exists" is not one of them:
each artifact declares `holdoutSeason: Y` and its `seasons` array ends at Y-1 (so the season it
projects is not in its training set); each loads through the CONSUMER's loader with `checkGolden`, so
the trainer's own five fixture predictions are reproduced by the TypeScript projector to 1e-6; and each
serves Yahoo-SCALED projections (top QB 395-617 across the fourteen seasons, against the ~300 a
half-PPR artifact produces for the same men). `buildInto` additionally REFUSES an artifact whose
`holdoutSeason` disagrees with the season it would anchor.

### 2. The weekly table, rebuilt on blind lines

`scripts/build-format-features.mjs --league 129048 --weekly-only --weekly-seasons 2012-2026
--prune-weekly`. Two changes to that script, both because the honesty flag was weaker than it looked:

- `manifest.weekly.seasonLineBlind` was `existsSync(foldDir)` -- the presence of a DIRECTORY. A
  half-built fold set, or one whose artifact-2019 had seen 2019, set it to `true` exactly as readily as
  a complete one. It is now decided PER SEASON from each artifact's own `holdoutSeason` header, and the
  manifest carries `blindSeasons` / `notBlindSeasons` so a reader asking "can I evaluate on 2019?" gets
  an answer instead of one bit for fourteen seasons.
- `--prune-weekly` removes seasons outside the rebuilt range. 2010 and 2011 cannot be fitted blind (no
  artifact can be trained on seasons before the curve has pairs), and leaving their old rows in the
  table while the manifest described only 2012-2025 is the state where the flag is true and the table
  disagrees with it. The weekly trainer's window is 2012-2025 for the same reason on the ESPN side.

WHAT THE BLIND LINES COST, which is the measurement that says the lookahead was real (mean absolute
change in `season_line_pg`, points per scheduled week, over the 7,694 player-seasons the two builds
share):

| pos | n | identical | mean abs delta | mean relative | max | mean line before -> after |
|---|---|---|---|---|---|---|
| QB | 906 | 101 | 1.589 | 22.6% | 12.88 | 11.585 -> 11.250 |
| RB | 1789 | 260 | 0.851 | 21.7% | 8.59 | 6.025 -> 5.700 |
| TE | 1448 | 161 | 0.707 | 20.4% | 10.93 | 5.025 -> 4.714 |
| WR | 2642 | 364 | 0.645 | 15.6% | 6.92 | 5.919 -> 5.866 |
| DST | 448 | 0 | 0.262 | 4.2% | 1.54 | 6.195 -> 5.987 |
| K | 461 | 0 | 0.164 | 2.7% | 0.68 | 6.650 -> 6.568 |

A fifth of the skill-position anchor moved, and it moved DOWN -- which is what a boosted model that has
seen the season it is projecting does: it knows who hit. The identical rows are the ones the fold
artifact could not price and the rookie curve filled instead (that curve is fitted before the season
either way, so it is blind in both builds).

### 3. The format's weekly artifacts

Same recipe as the shipped ESPN pair, read off `data/weekly-artifact.json`'s own header rather than
retyped: `--zero-model two-part --learner gbm --features all`, target `ratio_to_season_line`,
population `rostered`, `rowFilter: in_population` (the D23 decision population, which the format DB
carries because `buildInto` runs `buildPopulation`), quantile grid 0.05-0.9.

- `data/formats/sc-a845f67652fb/weekly-artifact.json` -- 27 features, 70,266 population rows,
  populationHash `64e92f5e68448e07`, seasons 2012-2025, gbm served for QB/RB/WR/TE with the trainer's
  own self-check against scikit-learn's `predict` passing.
- `data/formats/sc-a845f67652fb/weekly-artifact-lineonly.json` -- the season-line floor the serve table
  names at K (`--season-line-only`, every mean intercept exactly 1.0).

Both were golden-checked THROUGH THE CONSUMER (`scripts/weekly-artifact-probe.mjs`, which loads them
with `loadWeeklyArtifact` and therefore re-runs the six golden rows): "the trainer wrote a file" and
"the engine can serve it" are two facts, and only the second one matters at serve time.

There is no Yahoo DST streaming artifact and there should not be: the league rosters no defence. DST
comes back in `projectStreamingWith`'s `missing` list, by name.


### 4. The evaluation -- the number that says whether this is an improvement

`evaluateWeekly` nested by season on the format's own DB, 2012-2025, every fold retrained by
`tools/train_weekly.py` with that season held out, 300 random rosters per league-week. Two things had
to be parameterised in `src/weekly/evaluate.ts` first, and both were wrong-answer risks rather than
conveniences:

- the harness read the CANDIDATE artifact from `dataPath(CHALLENGER_WEEKLY_ARTIFACT)` -- the ESPN file
  -- to learn which model kind and learner every fold must fit, whatever DB it was scoring. It now
  takes the format's `ModelHandle`; omitted, it is the incumbent, so the ESPN path is unchanged.
- `SCENARIOS`, the roster template the DECISION metric draws over, was the ESPN starting template:
  one FLEX, a kicker, a defence, no superflex. Scoring a superflex league on it measures a lineup
  decision nobody in that league makes. `scenariosForSlots(cfg.slots, cfg.flex_ok)` derives the
  template from the league's own slots through `slotEligibility`, and the ESPN constant stays a pinned
  constant (`test/weekly-scenarios.test.ts` asserts it, and fault-injects the derivation).

Yahoo template: `QB WR WR RB RB TE FLEX FLEX FLEX SUPERFLEX` plus 5 or 8 bench (standard-15 /
deep-18); the bench is drawn from the union of the flex groups' eligibility, so a superflex league
draws quarterbacks onto the bench and the ESPN template draws exactly what it always did.

POOLED, 69,975 scored player-weeks (the decision population, non-bye weeks, a did-not-play week is a
zero):

| model | RMSE | CRPS | coverage | cov(>0) | bias | zeroP | zeroA |
|---|---|---|---|---|---|---|---|
| **weekly (the format model)** | **8.211** | **3.5889** | 0.848 | 0.843 | +0.146 | 0.240 | 0.245 |
| season_line (the floor) | 9.564 | 4.4956 | 0.880 | 0.867 | -0.232 | 0.100 | 0.245 |
| shipped_week (the baseline) | 9.569 | 4.5292 | 0.865 | 0.843 | -0.234 | 0.103 | 0.245 |
| trailing4 (the folk model) | 9.752 | 4.3958 | 0.873 | 0.859 | +1.771 | 0.112 | 0.245 |

THE GATE, the same three pre-registered clauses the ESPN model is held to, PASSES on all three:
(a) pooled CRPS 3.5889 against the baseline's 4.5292; (b) coverage-given-positive 0.843, inside
[0.75, 0.85] pooled with every position inside [0.70, 0.90]; (c) predicted zero share 0.240 against an
actual 0.245, off by 0.006, every position inside 0.03.

PER POSITION, the gate fills the serve table exactly as it does for ESPN -- **QB, RB, WR, TE ship the
two-part form model; K and DST keep the floor**, failing clause (a) by a hair in the third decimal
(K 2.4738 vs 2.4720, DST 3.1331 vs 3.1326), which is the same verdict and the same margin the ESPN
track recorded. CRPS against the floor: QB 4.6185 vs 6.7155, RB 3.4522 vs 4.5744, WR 3.9040 vs 4.8116,
TE 3.3838 vs 4.1067. So `WEEKLY_SERVE` needs no per-format variant: the measurement agrees with it.

THE DECISION METRIC (actual points of the starters each model chose, 72,900 drawn rosters per
scenario, common random numbers so `winShare` is paired against `shipped_week`):

| scenario | weekly | shipped_week | gain | winShare |
|---|---|---|---|---|
| standard-15 | 141.63 | 126.52 | **+15.11 pts/lineup** | 0.810 |
| deep-18 | 153.35 | 134.43 | **+18.92 pts/lineup** | 0.823 |

READ THAT GAIN WITH ITS SOURCE ATTACHED. It is far larger than the ESPN track's, and the reason is
structural rather than a better model: this template starts TEN men including three flexes and a
superflex out of a 15- or 18-man roster, so much more of the roster is a decision, and Yahoo's scoring
(full PPR, 6-point passing TDs, milestone and first-down bonuses) puts more points on each of those
decisions. It is not evidence that the Yahoo model is better than the ESPN one; it is evidence that
this league's weekly decision is worth more, and that the model beats the floor when making it.

SELECTION vs HOLDOUT. Every fold is blind to its own season, so the pooled number is already
out-of-sample; what a split can still show is whether the gain lives in one era. Early (2012-2018)
CRPS 3.5562 against the floor's 4.4445; late (2019-2025) 3.6190 against 4.5427 -- a gain of 0.89 and
0.92 CRPS, with the same coverage and zero-share behaviour in both halves. The recipe itself (feature
set, two-part zero model, gbm learner) was SELECTED on the ESPN track, not on this format, so no
selection budget has been spent here; nothing below the third decimal should be leaned on.

### 5. The rest-of-season blend, per format

`scripts/fit-ros-blend.mjs --league 129048` (a `--league` axis through `scripts/lib/format-paths.mjs`,
the same pattern `fit-variance` uses) fits K on the format's own weekly table in the per-SCHEDULED-week
frame:

| | ESPN (half-PPR, 1QB) | Yahoo (full-PPR superflex) |
|---|---|---|
| fitted K | **6** | **5** |
| rows | 41,524 | 44,101 |
| held-out RMSE | 4.3666 (line-only 4.9295, rate-only 5.1474) | 6.0598 (line-only 6.9176, rate-only 7.0656) |
| K per fold | 6 x 14 | 6, then 5 x 13 |

Both beat both controls, so the blend is doing work in both formats; Yahoo's evidence stabilises one
week sooner. That is why `ros-blend.json` moved OUT of the resolver's SHARED-NFL set (where D18's "an
NFL-level stabilization constant" had put it) and into the per-format artifact table: K is chosen by
minimising RMSE in POINTS, on a format's own lines and a format's own weekly scores, and a full-PPR
superflex point is not a half-PPR point. The incumbent's path is unchanged (`data/ros-blend.json`) and
the flagless refit reproduces the shipped file byte-for-byte apart from its `fittedAt` stamp.

### 6. The serve, live

With the artifacts in place `resolveFormat(db, "129048").model.has("weekly")` is true and the copilot's
weekly path serves them. Week 2 of 2026, `ff copilot lineup --league 129048 --week 2`:

    basisNote: every point total is from the weekly projector (src/weekly/projector.ts) for week 2
    QB Tyler Shough 26.04 | WR Garrett Wilson 14.88 | WR Jameson Williams 12.65
    RB Chase Brown 18.22 | RB Omarion Hampton 17.92 | TE Kyle Pitts 12.97
    FLEX Jacory Croskey-Merritt 12.96 | FLEX Carnell Tate 12.23 | FLEX Michael Mayer 10.46
    SUPERFLEX Joe Burrow 24.83                                        total 163.2

against WP7's `no weekly projector was supplied: every point total is the season projection divided by
17` and 150.4. `ff copilot stream --league 129048 --pos QB` names the files it served:
`artifactByPos {QB,RB,WR,TE: weekly-artifact.json, K: weekly-artifact-lineonly.json}`,
`missing ["DST"]` -- the format's own directory at every position, and a named refusal at the one it
does not have.

TWO THINGS HAD TO CHANGE FOR THAT TO BE A CORRECT NUMBER RATHER THAN A PLAUSIBLE ONE.

- **The ROWS follow the format, not just the artifacts** (`projectStreamingWith`). Resolving the
  artifacts per format while reading the feature rows from whatever store the caller opened is a
  half-fix, and the missing half decides the number: the weekly target is `pts / season_line_pg`, so a
  Yahoo artifact served on the incumbent's rows multiplies a full-PPR superflex ratio by a half-PPR
  line at every position, with full coverage and no error anywhere -- F-4 one table further down. A
  non-incumbent handle now reads its own `features.db`; the incumbent keeps the caller's handle, which
  is what leaves `ff scorecard`'s open transaction and the whole ESPN path untouched.
- **The live season's rows have to exist in that DB.** `ff sync-actuals` writes a non-incumbent
  format's `current-actuals.csv` and then REFUSES the forward-board rebuild, because
  `buildForwardBoard` writes the shared `feat_player_week*` tables; its own note says the fix is "the
  format dir's own feature tables", and those now exist. `scripts/build-format-features.mjs --league
  129048 --forward-only` runs both builders against `data/formats/<key>/features.db` with the format's
  actuals and the format's projector: 590 players x 18 weeks, 10,620 rows, 422 with settled points.
  Positive control, 2026 week 1 mean `season_line_pg` -- QB 11.71 / RB 5.49 / WR 5.19 / TE 5.38 in the
  format DB against 8.09 / 3.73 / 4.01 / 3.35 in the main store: the rows are on the Yahoo scale, not
  the incumbent's.

ESPN IDENTITY, checked the way this pass checks everything: the board's `row_json` differs from
`data/ff.db.bak-prearchfix-2026-09-16` in exactly the same 151 rows and exactly the one key
(`ESPN_ADP`, max delta 0.7) before and after the league switch; `ff copilot lineup --league 462233` is
byte-identical starter-for-starter and projection-for-projection across the switch (91.7 both times);
the store is left `active_league = 462233`.

### What is still NOT closed for this format

- **The first caveat is only half-lifted, and not by WP8.** WP11 landed a CANDIDATE
  `data/formats/sc-a845f67652fb/golden.json` (99.2% playoffs / 39.8% titles under the first
  SnakeModel) while this pass ran, so the format does now have a pre-draft tripwire -- but it is a
  tripwire, its own file says the playoff axis is nearly saturated at 8-of-12, and nothing in the
  WEEKLY track above is checked against it. The weekly gate here is the weekly track's own
  pre-registered gate, which is a different and smaller claim than a championship gate. WP11's golden
  also records that its arm excludes `--projection artifact` "because this format does not have a
  blind per-season fold set" -- it has one now (section 1), so that arm is newly runnable and the
  golden would need re-pinning with it, deliberately, not silently.
- **`simContext` still reads the ROOT ros-blend.** `loadRosBlendFor(model)` exists in
  `src/draft/rosBlend.ts` and the resolver now carries the artifact; the call site
  (`src/draft/simContext.ts`, another work package's file) still calls `loadRosBlend()`, so the live
  Yahoo caveat sentence still says `K=6 (fitted)` where this format's own fit says 5. One line.
- **`ff evaluate-weekly` has no `--league` axis.** The function takes `model` / `scenarios` /
  `flexOk` / `label`; `src/ff.ts` (another work package's file this wave) does not yet pass them, so
  the run above was driven from a scratch runner.
- **The forward build is a script, not a verb.** `ff sync-actuals --league <id>` should call
  `--forward-only`'s two builders instead of printing its refusal, now that the refusal's stated
  precondition is met.
- The format's live weekly rows are only as fresh as the last `--forward-only` run; nothing recomputes
  them when Yahoo actuals land. And 2010-2011 are gone from this format's weekly table by design (no
  blind artifact can exist for them), so its trainer window is 2012-2025 where ESPN's is 2010-2025.

## Wall 2 -- the snake DraftModel (WP11, 2026-09-16): CLOSED, with an honest gate

The draft is an interface now: `src/draft/draftModel.ts`. `AuctionModel` wraps the existing
`draftField` call argument-for-argument (the incumbent golden line is unchanged before and after, and
`test/draft-model.test.ts` asserts the identical player in the identical seat for three seeds);
`SnakeModel` is net-new; `runBacktest` takes a `DraftOptions` and `ff backtest` RESOLVES the model
from the format's `draftType` where it used to refuse with `requireAuction`. A draft type with no
model is still a named refusal, not a silent auction.

**The SnakeModel in one paragraph.** Serpentine order over `teams`, `rounds = slots - IR` (Yahoo
129048: 19 - 2 = 17), our slot drawn from the TRIAL's own seed so it is a common random number and
the CRN pairing the arbiter rests on survives (`--our-slot N` fixes it). The room picks BEST
AVAILABLE off a shared book -- the pool's own VOR under THIS league's roster economics, which is
superflex-aware for free through `resolveValueLeague`'s `flexGroups`, or the real preseason ADP order
when `--snake-adp <format>` supplies one -- each bot through an independent multiplicative view drawn
once per (bot, player) at `--bot-noise`. One hard rule governs everybody: a pick is legal only while
the picks remaining still cover every starting slot the roster cannot fill. That is `starterReserve`'s
semantics with picks in place of dollars, it is what stops a fourth quarterback in round 14, and it is
asserted against `season.ts:rosterGaps` rather than believed. Our side picks off OUR VOR book (points,
not dollars -- the dollar rounding collapses the sub-replacement tail to $1 and rounds 11-17 are made
of that tail) with `benchDiscount`, `posMult` and `maxAtPos`; every dollar lever is inert and
`SNAKE_IGNORED_LEVERS` names them rather than leaving a sweep to discover that `--aggr` measured
nothing.

**The gate number, and what it is worth.** `data/formats/sc-a845f67652fb/golden.json` exists, so
`scripts/cpcv.mjs --league 129048` RUNS instead of refusing -- it also strips the auction-only base
flags for a snake format, loudly, and stamps `draft_type` on the ledger row. The flagless arbiter
(`--full --no-lookahead --seasons 1999-2025 --n 150`, 26 scored seasons, 3,900 paired trials) gives
**99.18% playoffs / 39.82% titles** against 66.7% / 8.3% at random. Read docs/validation.md "Snake
DraftModel, first run" before using either number: the PRIMARY axis is **nearly saturated** (95%-100%
per season; cpcv resolves ~0.57pp there against ~3.7pp on titles), so it is a downward tripwire and
nothing else, and the margin is near-totally dependent on `marketSd 0.30` -- an assumption
`ff calibrate` never measures. Halving it takes titles 40.0% -> 24.8% and playoffs 99% -> 96%; the per-bot view, by contrast, is
nearly irrelevant (--bot-noise 0/0.20/0.40 -> 40.2%/40.0%/41.4%). The
reason a snake is so much more sensitive to it than an auction is structural and worth carrying
forward: **an auction converts the room's projection error into PRICE, a snake converts it into
ROSTER** -- a bot that over-rates a player merely overpays in one and TAKES him in the other.

**The first measurement of that number was WRONG, at 99.77% / 45.69%, and the failure is the useful
part.** This format's target re-scores the same history the incumbent uses, so its pool carries the
24,579 IDP rows; a position with no slot takes its baseline from the BEST player at it, so every one
floors at VOR 0, and the only thing left ordering them was a RAW-POINTS tie-break. A 200-point
linebacker outranked every sub-replacement receiver, rounds 12-17 filled with unstartable men, and
**18% of every roster was dead weight** (149 of 816 drafted players). Nothing failed -- every roster
was legal, the first six rounds of the pick log looked perfect, and all four face-validity checks
passed; the only symptom was a number ~6pp too high on titles. A SECOND defect moved it again:
`--bot-noise` reaches the auction only through `market.idioSd`, which only `--market ecr` populates,
so the snake room ran with ZERO per-bot disagreement while the banner printed `per-bot view 0.2`. It
has its own channel now and a connected-lever test. `vorBook` now prices a position with
no slot at exactly zero, and `test/snake-kdst.test.ts` locks it with a fault injection on the slot
template.

**Two gaps this did not close, both data rather than code.** (1) The store holds no `raw_league_pick`
for 129048, so the field is a generic best-available room, not this league's twelve owners --
`managers.json` is the ESPN auction room and has no snake analogue. (2) **There is no superflex ADP
anywhere in the store.** `raw_adp_history` is FantasyFootballCalculator's 12-team ONE-QB `standard`
(2008-2026), `ppr` (2010-2026) and `half-ppr` (2018-2026); `ranking_history` is 1-QB FantasyPros ECR
(2019-2025). So the `--market ecr` analogue can only be run on a 1-QB consensus, which understates the
room's demand for quarterbacks by exactly the amount superflex creates -- it leaves QBs on the board
for our QB-heavy book, and therefore FLATTERS us. `--snake-adp ppr` is wired and prints its own
per-season name-match count so a key miss is visible rather than silently degrading to the default
book, and it is there for the day a superflex ADP is scraped.

**And the Yahoo pool no longer carries kickers or defenses.** `startablePositions` /
`filterToStartable` (values.ts) drop any of the six PRICED positions the league has no slot for, so
the draft pool, the value book and the waiver wire in a Yahoo backtest hold none -- closing the last
of the two "smaller things" recorded at the end of the WP7 section. The scope is deliberately the six
priced positions and NOT "every position with no slot", and the reason is measured: the INCUMBENT's
own `data/history-points.csv` carries 24,579 IDP rows (LB/DB/DL) that are currently drafted as bench
filler and whose VOR sits in `computeValues`'s denominator, and removing them moves the ESPN golden
from 39.5%/96% to 36.0%/94%. That is a value change under the one rule (D13), so it is left on the
table with its number attached rather than smuggled in inside a draft-seam refactor.
