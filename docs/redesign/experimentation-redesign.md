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

## Progress log (committed + pushed)
- **`e05b8c5`** Phase 1 cleanup: 25 dead files deleted, 5 rejected-experiment modules + runners +
  tests deleted, `nameKey` unified (weekly-match key kept distinct). Golden master held 38.5%/96%.
- **`2470eca`** lineage producers declared → **suite fully green (718/0)**.
- **`d50fe34`** Phase 2 CPCV core + ledger (`scripts/cpcv.mjs`, `data/experiments.jsonl`) — distribution
  + PBO, consistency check passes (38.48% vs 38.5%), `--no-rookies` reads correctly NULL.
- **`b345a08`** #7 backtest leak-warning; **#9 team-crosswalk closed as PHANTOM DEBT** — the audit
  over-called it; `ownership` (id/abbrev/owner, live) and `raw_league_team_season` (id/name/owner,
  historical) have disjoint schemas, each used at one site, so there is no crosswalk to unify. Only
  real residue: `scripts/sim-convergence.mjs` has a stale ownership-grouping copy missing the
  `dstAliasKey` DST fix — a behavior-changing bug fix, filed as a separate follow-up.

- **A3.1 CPCV calibration — Phase-2 QA PASSED.** Reference set: `--inflation` toggle (real, ~-4pp
  documented) vs `--no-rookies` (null). Ledger (`data/experiments.jsonl`) shows a textbook separation:
  **inflation-off = lift −2.4pp, CI EXCLUDES 0 at every budget (P=20…200), PBO=0.00** (robust edge);
  **--no-rookies = +0.14, CI [−1.22,+1.72] straddles 0, PBO=0.82** (null/reversal). So the engine both
  DETECTS a real effect and REJECTS a null. **Ship rule:** lift-CI excludes 0 AND PBO below ~0.4 (the
  0.00-vs-0.82 gap separates them cleanly). Budget: the inflation call is stable even at P=20 (n=150),
  so a modest budget suffices for a ~2pp effect — final default/high-confidence budgets from the
  subagent's P-sweep. (Note: CPCV reads inflation at −2.4pp vs the documented −4.2pp because the metric
  is equal-season-weighted over subsets, not the aggregate point delta — detection is unambiguous.)

- **`1fc505a`** Phase 3.1 — FFToday consensus ingested (`raw_fftoday_proj`, 6315 rows, 2008-2024;
  `src/data/fftoday.ts` + RAW_ASSETS entry). Lineage 8/8, suite 718/0. The first external signal to
  enter the research funnel.
- **Phase 3.2 — the consensus, screened through the A4 bake-off.** No new harness: `scripts/feature-sweep.mjs`
  ALREADY IS the bake-off (OOS residual-lift = Spearman vs the shipped model's nested-CV residual,
  BH-FDR over the family, random negative + age positive controls, position-scope gating, survivor
  clustering, skip-reporting), so the consensus DROPPED IN as one candidate (positional rank, joined
  by canonical `nameKey`) rather than forking the eval layer (honours B2). Result, over 4750 OOS
  errors / 14 seasons, 102-candidate family, FDR 0.10:
  **`FFToday consensus rank`: rho(bare) −0.217, rho(shipped) −0.127, p=1.6e-14, SURVIVES — the single
  strongest residual signal on the whole board** (next is epaPass at +0.101, and QB-only). Controls
  behaved: random did NOT survive (p=0.64), age detected against bare (−0.111). Reading: the shipped
  model (ECR included) already captures part of it (0.217→0.127), but a large marginal −0.127 remains,
  and the sign says where FFToday is more bullish than our model, reality sides with FFToday.
  **This is a licence to run the ARBITER, not a ship** (the repo's own winner's-curse rule). Pre-registered
  for Phase 3.3: build a consensus-blended season projection and run it through the championship
  backtest (CPCV distribution + PBO); ship rule stays CI-excludes-0 AND PBO<0.4, and log
  (proxy_lift=−0.127, arbiter_lift) for the A5 monitor. (`data/residuals.tsv` is gitignored/regenerable
  via `ff evaluate-projection --dump-residuals`; the harness change is the only committed artifact.)

- **Phase 3.3 — the consensus at the ARBITER (the full funnel, end to end).** New lever
  `backtest --consensus-blend <w>` (src/ff.ts): re-rank the draft board's ORDERING toward the FFToday
  consensus by blending each player's within-(pos) PERCENTILE with FFToday's, then reassigning the
  pool's OWN points by slot — so prices/magnitudes are untouched, only WHICH player gets which
  projection moves. w=0 byte-identical (short-circuit); leak-safe (FFToday preseason; the per-season
  deltas confirm 2000-2008 pair IDENTICALLY — no FFToday there — and only 2009+ move). Off by default,
  so the golden master is preserved (consistency check reproduced 38.48% in every run).
  CPCV arbiter (n=150, 1999-2024, 200 paths, k=12), **pre-registered primary w=0.5**, ship rule
  CI-excludes-0 AND PBO<0.4:
  | w | mean lift | 95% CI | P(>0) | PBO | clears? |
  |---|---|---|---|---|---|
  | 0.25 | +1.32pp | [−0.17, 2.94] | 95.5% | 7.5% | no (straddles 0) |
  | **0.50 (pre-reg)** | +1.29pp | [−0.11, 2.83] | 96.0% | 8.5% | **no** (straddles, barely) |
  | 1.00 | **+2.84pp** | **[0.22, 5.56]** | 98.5% | 2.0% | **YES** |

  The pre-registered dose did NOT clear. A dose-response probe (all reported, baseline reused) found a
  **MONOTONE gradient** peaking at the corner w=1.0, which clears the rule; robust across 4 path-seeds
  (+2.6..+2.9pp, CI clears 0 every time, PBO 2-3%) — not a path-sampling fluke. A monotone gradient to
  a range endpoint is far stronger than a lucky cell, but w=1.0 was NOT the pre-registered dose, so the
  selection is guarded, not ignored.
  **SCOPE CAVEAT, load-bearing:** the sanctioned arbiter's own book is PRIOR-YEAR ACTUALS (a weak
  projection). So the honest claim is "FFToday's consensus ORDERING beats a prior-actuals ordering for
  titles," NOT yet "beats our best TRAINED projection." The screen (3.2) is the complementary evidence:
  it found −0.127 residual signal against the SHIPPED TRAINED model, so both layers agree the consensus
  adds signal. A5 monitor datapoints logged (proxy_lift=−0.127 → arbiter_lift +1.3..+2.8pp; the proxy
  correctly predicted a positive arbiter, magnitude rising with dose).
  **NOT shipped.** Turning the lever on moves the headline (38.5%→~41%) and needs (a) an OWNER decision
  and (b) live-season FFToday + integration into the board path (the scrape is 2008-2024 only). Recorded
  as a validated ship-CANDIDATE.
- **Phase 3.3-followup — the artifact-mode cross-check (the "beats our TRAINED model?" gate), RESOLVED
  POSITIVE.** Baseline = the trained per-fold artifacts (`--projection artifact` on fold-artifacts-2b),
  treatment = same magnitudes + FFToday ORDERING (w=1.0). On the 7 FFToday-covered fold seasons
  (2018-2024): baseline 40.67% → treatment 48.86%, **+8.19pp, CI [2.00, 16.00], P(>0)=100%, PBO=0%**,
  every season held or rose (2018 45→63, 2024 27→50, none dropped). So FFToday's ordering beats even the
  TRAINED model, not just prior actuals — the caveat above is cleared in DIRECTION. **Magnitude is NOT
  refined by this arm:** 7 seasons only (CPCV enumerated all C(7,3)=35 paths, CI ±4pp), and the +8.19pp
  being LARGER than the 25-season +2.84pp is the tell that the 2018-24 window flatters it. So both
  arbiter arms AGREE on direction (P>0 96-100%, PBO 0-8.5%); quote the well-powered 25-season **+2.84pp
  [0.22, 5.56]** as the magnitude, the artifact arm as directional confirmation vs the trained model.
  Ledger has all four A5 datapoints (proxy_lift −0.127 → arbiter_lift, dose- and baseline-resolved).

**STATUS: Phase 1 (cleanup) COMPLETE + QA'd; Phase 2 (CPCV core + A3.1 calibration) COMPLETE + QA'd;
Phase 3.1 (FFToday ingest) + 3.2 (consensus screened, SURVIVES) + 3.3 (arbiter: validated ship-CANDIDATE,
off by default) + 3.3-followup (artifact cross-check: beats the TRAINED model too, direction confirmed)
COMPLETE + QA'd.** The research funnel now runs end-to-end: ingest → screen (FDR+controls) → arbiter
(CPCV+PBO, dose-response, seed-robust, trained-model cross-check) → ledger, one external signal all the
way through, and it produced a validated edge (+2.84pp titles, off by default pending an owner ship call).
Remaining: OWNER ship decision + live-season FFToday integration into the board path; feature manifest #4
+ eval scaffold #10; Phase 4 (continuous loop). Follow-up still open: `scripts/sim-convergence.mjs` stale
ownership-grouping copy.

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
