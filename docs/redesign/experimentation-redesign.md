# Experimentation-system redesign — design plan

Status: DRAFT (Phase 0). Golden-master baseline captured in `docs/redesign/golden-master.txt` +
`golden-backtest.out`. Part B (cleanup) is grounded by the audit in `scripts/`-census; the ranked
inventory is folded in below once the audit's consolidated dump lands.

Owner decisions locked (this session): (1) DELETE dead code, git history is the archive; (2) CLEANUP
FIRST, then the CPCV core; (3) find the CPCV compute budget EMPIRICALLY (Pareto experiment, §A3.1);
(4) FULL tech-debt sweep for a clean migration.

The organizing discipline is **quantitative-finance backtesting** (López de Prado): the backtest is a
liability to be spent sparingly, overfitting is quantified, validation is purged/embargoed, and
research is done on predictive content — not by iterating against the backtest.

---

## Part A — Target architecture

### A0. Axioms
1. The enemy is **overfitting a short, noisy history under many trials** (~25 seasons, ~15 with modern
   signals; dozens of hypotheses already tested).
2. **Two metrics in tension**: predictive accuracy (cheap, high-power, biased) vs championship value
   (expensive, low-power, true). They disagree — this is the repo's whole "accuracy ≠ decision value".
3. **The backtest is not a research tool.** Iterating against it overfits it. It confirms, rarely.
4. **The unit is the season, and seasons autocorrelate** (career arcs, roster continuity) — validation
   must purge AND embargo, not merely split.

### A1. The research / arbiter wall + experiment ledger
A hard separation, the single biggest structural change.
- **Research layer** (high-power, run freely): all feature discovery, screening, ranking, on
  out-of-sample *predictive* metrics.
- **Arbiter layer** (low-power, run rarely, logged): the CPCV championship/calibration sim. Touched
  only to confirm a **pre-registered** hypothesis; never to browse or tune.
- **The ledger**: every arbiter invocation appends `{config_hash, pre_registered_hypothesis, metric,
  threshold, result, seed, data_version, timestamp}` to `data/experiments.jsonl`. The cumulative
  **trial count T** is a first-class number — it drives the deflation in A2. `docs/edges.md` remains
  the human-readable findings view; `experiments.jsonl` is the machine view.
- Pre-registration prevents the garden-of-forking-paths: you state the hypothesis and the pass bar
  *before* the run, and the run can only confirm or refute it.

### A2. The CPCV backtest engine (a distribution, not a point)
Replaces today's single fragile point estimate (the thing that made 0.2343-vs-0.2345 untrustworthy).
- **Combinatorial Purged CV**: from the N seasons choose k as a held-out test group; enumerate many
  such combinations → many backtest **paths** → a **distribution** of the title-lift metric.
- **Purge**: drop training rows whose outcome window overlaps the test season. **Embargo**: also drop
  the season(s) adjacent to test from training (year-N ↔ year-N+1 correlate). Tightens the existing
  leave-one-season-out fold artifacts + fold-models.
- **Output of any change** is `lift = +X pp titles, over M paths, P(lift>0)=…, path SD=…` — an
  honestly-powered statement.
- **PBO (Probability of Backtest Overfitting)**: across paths, how often does the best in-sample config
  underperform out-of-sample. Reported with every candidate as the standing overfit gauge.
- **Deflated threshold**: a change ships only if its lift distribution clears a bar that RISES with T
  (deflated-Sharpe analog). Turns "quote the holdout, not the discovery number" into an automatic
  haircut instead of a remembered discipline.

#### A3.1 Pareto budget experiment (calibrates the engine before we trust it)
Runs first thing once the engine exists. Cost per run ≈ P·n·S (P paths, n draft trials/path, S
seasons/path). Question: at fixed compute, go **broad** (high P, low n) or **deep** (low P, high n)?
- Ground truth: reference changes with known arbiter effects — value-curve on/off (~+11pp), churn on
  (~−6% skill, #16), share-copula (~0, #13), rookies on/off (~−0.2pp). Pin each with one very-high-
  budget run (P=60,n=200) as gold.
- Grid: P∈{5,10,20,40} × n∈{25,50,100,150}, each ×3 seeds, on all four references.
- Per config record: cost; bias vs gold; variance across seeds; **decision accuracy** (fraction of
  references classified correctly re: sign + ship/reject at the deflated threshold); PBO stability.
- Read: decision-accuracy (and 1/RMSE-to-truth) vs cost → knee = routine budget. Hold P·n fixed to
  settle broad-vs-deep with data. Output a **default** budget (everyday screening) and a
  **high-confidence** budget (final ship decisions).

### A4. Feature registry + research funnel (the high-power layer)
- **Feature registry** — each feature a first-class object `{fn(as_of), source, coverage_years, deps,
  leak_test}`. Unifies today's scattered lists (`WEEKLY_FEATURE_FIELDS`, `RAW_ASSETS`/`L1_ASSETS`,
  `POS_GATED`, the `train_*.py` lists). New signals (FFToday consensus, win totals + `wt_rating`,
  expected points, ECR dispersion, RAS) drop in here; the leak test auto-runs (perturb week w, assert
  the feature doesn't move).
- **Bake-off** — one command evaluates every candidate through the SAME purged/embargoed CV:
  **residual lift** (marginal signal over the *current* model, not raw correlation — kills the
  "broader-lever-already-explains-it" trap), **BH-FDR** across the family, and **two controls** (a
  random feature must ≈0, a known-good feature must fire). Emits a ranked table; survivors get
  pre-registered for the arbiter.

### A5. Proxy → arbiter correlation monitor
The funnel assumes proxy gains predict arbiter gains; that assumption can rot. For every candidate that
clears (or fails) both gates, log `(proxy_lift, arbiter_lift)`. Over time this reveals WHICH proxy
metrics actually predict titles (maybe rank-lift at QB does, RMSE doesn't). If the correlation
collapses, fix the *screening metric*, not the features.

### A6. The continuous loop
```
new data ─▶ re-derive features (registry) ─▶ RESEARCH (purged-CV lift + FDR + controls)
             │                                     │ survivors, pre-registered
             └─ re-measurement registry triggers   ▼
                re-runs on dependency drift   ARBITER (CPCV distribution + PBO, logged, T++)
                                                     │
                                                ship / record → edges.md + experiments.jsonl
```

---

## Part B — Cleanup & tech-debt remediation (full sweep)

> Grounded by the codebase audit. Dead-code shortlist confirmed; harness-consolidation map and
> tech-debt citations folded in from the audit's consolidated dump. (This section finalized once the
> dump is merged.)

### B1. Dead-code deletion (confirmed candidates)
- **Hard-superseded → DELETE**: `scripts/sim-calibration.mjs` (self-declares SUPERSEDED by
  `season-calibration.mjs`), `scripts/feature-value.mjs`.
- **True orphans**: `scripts/rookie-model-validate.mjs` → DELETE (zero refs; superseded by
  `rookie-holdout.mjs`); `scripts/inseason-backtest-denial.mjs` → ARCHIVE finding-note then delete
  (records the denial-handcuff measurement; unreachable).
- **Comment/glob-only dead one-offs**: `scripts/league-selftest.mjs`, `scripts/inseason-probe{,2..6}.mjs`
  family.
- **Deprecated copilot-track scripts (11)** — superseded by the `ff copilot` dispatcher.
- **Rejected-experiment modules** (findings #7 progressive/role-trend, #8 SOS, #9 prospect, plus the
  refuted change-metrics/aggregate/playprob/lineup-info runners): the runner `.mjs` + their
  `src/inseason/backtest/*.ts` experiment modules move together to `experiments/` (or delete — the
  reproduction command in edges.md is the record). **Verify first that none are wired into the shipped
  board/sim.**
- **Confirm reverted**: `#13` share-copula (`coupleCorr`/`targetShare`) and `#16` churn
  (`churn`/`faPhantoms`) are fully gone from `src/` — grep as a guard (already reverted this session).

### B2. Eval-harness consolidation
The audit found the evaluators cluster into a few patterns:
- **Nested-by-season eval trio** — `ff evaluate-projection` (`src/model/evaluate.ts`),
  `evaluate-weekly` (`src/weekly/evaluate.ts`), `evaluate-streaming` (`src/weekly/streamingEvaluate.ts`)
  all share "nested-by-season + CRN + a decision metric (regret)". → extract a **shared nested-eval
  scaffold** (top-10 #10). This becomes the research-layer harness in A4.
- **In-season decision A/B** — `ff inseason-backtest <verb>` (`src/inseason/backtest/harness.ts`) is
  already the unified single implementation; the 16 `inseason-backtest-*.mjs` are thin spawners but
  only 11 are promoted to verbs (5 experiment-only bypass the surface → those go to `experiments/`).
- **Sim calibration** — `season-calibration.mjs` (outcome Brier vs 114 team-seasons, per-fold
  artifacts) is the arbiter for season-sim changes; `face-validity.mjs` checks price-shape.
  `sim-calibration.mjs` is hard-superseded → delete.
- **The draft arbiter** — `ff backtest` stays the sole strategy arbiter; the CPCV engine (A2) WRAPS it.
Consolidation is Phase 1 (scaffold extraction) → Phase 2 (CPCV wrap); the fitters (`fit-*.mjs`, now
`FIT_EXCLUDE`-aware) stay as the leave-season-out model builders.

### B3. Shared-primitive cleanup
- **Name-key: 4 defs → DONE (Phase 1).** There are legitimately TWO key-spaces, not one:
  (a) **strict identity** — `src/draft/values.ts:39 nameKey` (letters only, strips `d/st`); `league/index.ts`
  and `eligibility.ts nameKeyLocal` were byte-equivalent and now **delegate** to it (behavior-preserving,
  import paths unchanged). (b) **loose weekly-match** — `copilot.ts:435 lineupNameKey` KEEPS digits +
  word-separating spaces and does NOT strip `d/st`, because the weekly-projection Map is keyed by that
  looser form on both sides of its join; unifying it would silently break weekly lineup matching, so it
  is intentionally SEPARATE (now documented at its definition). The feature registry (A4) should expose
  these as two NAMED normalizers, not collapse them. `dstAliasKey` was already single-source. Verified:
  tsc clean, 34 name-matching tests pass.
- **League-team identity** (abbr ↔ `raw_league_team_season.name` ↔ `team_id`) spans 5+ `src/data/*`
  files with self-documented silent-fail — centralize into **one crosswalk** (top-10 #9). (`TEAM_ALIAS`/
  `canonTeam` for NFL teams is already single-copy in `nflverse.ts:27` — leave it.)
- **`scripts/lever-connected.mjs:29`** hardcodes a STALE baseline (`starterReserve:15` etc.) instead of
  the shipped config → fix to read `read-config` (top-10 #6).
- No TODO/FIXME markers exist; the lever registry (`levers.ts LEVER_SPECS`, 13 shipped) is disciplined.

### B4. Feature-pipeline & registry unification (top-10 #4)
Flow: `raw_*` (37 tables, `RAW_ASSETS`) → `stg_*` (3) → `feat_*` (13, `src/features/*`) → artifacts →
`projectSeason`/`projectWeekly`. The debt: feature lists are **duplicated across languages** — TS
loaders validate (`FEATURE_FIELDS` projector.ts:27, `PRICE_FEATURE_FIELDS` price.ts:36,
`WEEKLY_FEATURE_FIELDS` features.ts:55 + `streamingFields.ts`) what the Python trainers emit
(`train_projection.py`, `train_weekly.py:135`, `train_streaming.py`, `train_price.py`, `train_faab.py`).
Two hand-maintained lists in two languages = producer/consumer drift. → **one language-neutral feature
manifest** (name + pos-gate + source table) read by BOTH the Python trainers and the TS loaders. This
is also the A4 registry's backing store. Plus: decide `feat_player_prospect`'s fate — built by
`src/features/prospect.ts`, consumed by no model (edges #9) → park or wire (top-10 #8).

### B5. Other confirmed items
- Make the backtest's per-fold (leak-free) projection the **documented default or warn** — the default
  artifact has seen replayed seasons (`validation.md:2457`) (top-10 #7).
- `scripts/` reorg: split into `pipeline/` (fit-*, market-noise, feature-sweep), `checks/`
  (paired-analysis, lever-connected, face-validity, sim-vs-mock, book-compare), `experiments/`
  (rejected-hypothesis runners), delete dead (top-10 #1).

---

## Part C — Execution

### C0. Golden master (safety net, done first)
Snapshot the current shipped numbers BEFORE any change so every cleanup step is provably
behavior-preserving: championship backtest (shipped flagless config), season-calibration (un-leaked),
the test suite, and artifact hashes → `docs/redesign/golden-master.txt`. A cleanup that moves any of
these is a bug, not a refactor. (Backtest capture in progress.)

### C1. Phase roadmap
- **Phase 0** — golden master + this doc. *(in progress)*
- **Phase 1 — Cleanup (full sweep, B1–B4).** Delete dead code, consolidate harnesses, fix shared
  primitives, unify the feature registry. Every step checked against the golden master.
- **Phase 2 — CPCV core (A1–A3).** ENGINE + LEDGER DONE (`scripts/cpcv.mjs`, `data/experiments.jsonl`).
  Reuses `--dump-trials` CRN pairs; samples 200 season-subset paths → lift distribution + PBO; logs each
  run. CONSISTENCY CHECK PASSES (baseline full-set 38.48% vs golden 38.5%). Validated on `--no-rookies`:
  correctly NULL (CI [-1.22,+1.72] straddles 0, P(lift>0)=57%). **PBO scale note:** with two complementary
  splits, train/test lifts are mechanically anti-correlated, so a NULL drives PBO HIGH (~0.8-1.0) and a
  robust edge drives it toward 0 — read PBO RELATIVELY; A3.1 calibrates the ship bar against known-large
  references. REMAINING: (a) the Pareto budget experiment (A3.1) to set default/high-confidence budgets
  and the PBO/lift ship thresholds; (b) v2 embargo (needs per-fold refit excluding adjacent seasons).
- **Phase 3 — Research funnel (A4–A5).** Registry + bake-off + proxy→arbiter monitor. First real run:
  re-evaluate ALL features (existing + the 5 new signals).
- **Phase 4 — Continuous loop (A6).** Triggers on data refresh; re-measurement registry wired in.

### C2. Migration / compatibility
The shipped 2026 board + in-season sim must keep working throughout. Rule: cleanup is
behavior-preserving (golden-master gated); the CPCV core is ADDITIVE (a new evaluation path, the
shipped `ff backtest` stays until Phase 3 proves the new path reproduces it). No value/strategy change
ships from this redesign without clearing the (new) arbiter — the redesign is about HOW we evaluate,
not a change to the shipped model.

### C3. Validation & rollback
- Golden-master equality test after each Phase-1 step.
- The CPCV engine must reproduce the shipped point-backtest as its distribution's center (a
  consistency check) before it's trusted.
- Everything is a branch; rollback = revert the branch.

### C4. Risks & open questions
- **CPCV compute cost** — multiplies the arbiter; mitigated by the Pareto budget (breadth over depth).
- **Low power is intrinsic** — even CPCV can only resolve large effects; most features will land
  "accuracy-positive, decision-null" and that's correct, not a failure.
- **Deleting rejected-experiment code loses the reproduction path** — mitigated: the finding + command
  stay in edges.md; the CODE is what we drop.
- Open: exact embargo width (1 season vs 2); whether the ledger lives as a file or a `feat_experiments`
  table; how aggressively to consolidate the in-season decision backtests vs the draft backtest (they
  answer different questions and may not merge).
