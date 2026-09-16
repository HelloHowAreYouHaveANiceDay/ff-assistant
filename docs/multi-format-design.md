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

1. **Superflex valuation.** `FLEX_ELIGIBLE` excludes QB (values.ts:102), so an OP/superflex slot is valued
   as an RB/WR/TE flex and QB replacement level is wrong — which is the *entire* point of superflex. Fix:
   make flex-eligibility part of the format (`slot → eligible positions`), and let `baselines()`
   (values.ts:135) fill a superflex slot from QB+RB+WR+TE. Surgical, but it moves numbers → re-gate.
2. **Snake draft engine.** None exists; the auction path (VOR→$, second-price sim, nomination) is
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

## Status 2026-09-16

The 2026-09-16 architecture review (`docs/architecture-review-2026-09-16.md`) read this design against
the live tree and found the phases above landed the ARTIFACTS but not the plumbing that would make a
reader actually use them. Read this document as "the format-native model exists and is verified
offline", not "format-native end to end" -- three things a reader should not take literally:

- **Nothing in `src/` reads `data/formats/` yet.** No resolver computes a format key or maps
  `config -> format -> artifact paths`; the Yahoo model is reachable only from five `scripts/yahoo-*.mjs`
  that hardcode the key and the league id (finding F-2).
- **The Yahoo model is script-only.** There is no Yahoo platform adaptor in `src/league/` (`src/league/`
  has ESPN only) and no verb dispatches on it; `config:129048` itself is a byte-copy of the ESPN config
  with a few fields edited by hand, not synced from Yahoo's own settings (findings F-1, P-5).
- **The format DB's weekly table is a half-PPR copy.** `feat_player_week_model` inside
  `data/formats/sc-a845f67652fb/features.db` is a row-for-row copy of the ESPN half-PPR table
  (`build-format-features.mjs` never rebuilds it), so any weekly serve off it today would silently be
  half-PPR, not Yahoo-scored (finding F-4).

See that review's work packages WP1-WP7 for the fix plan.

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
blind), and a `golden.json` -- `cpcv.mjs` has no `--league` axis yet, so the championship gate is
still the incumbent's (F-9, WP7).
