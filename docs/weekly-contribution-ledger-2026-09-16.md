# The weekly model's contribution ledger (M2g, 2026-09-16)

> **HISTORICAL AS OF 2026-09-17. EVERYTHING FROM HERE TO THE HORIZONTAL RULE BEFORE "THE RERUN ON THE
> SERVED 26-COLUMN DESIGN" IS THE 25-COLUMN STUDY.** The rerun against the design that ships today is
> the dated section at the end of this file, and it supersedes every table above. This one is KEPT
> rather than replaced because it is the record D27 and D30 were decided against, and because the
> comparison between the two designs turned out to be a finding of its own (five leave-one-out verdicts
> flip on a two-column change; promoting the consensus halved the model's holdout exposure to a dark
> usage feed). The original 2026-09-17 banner follows, unaltered.
>
> **SUPERSEDED IN SCOPE ON 2026-09-17 -- read every number below as "the 25-column design".** D27
> (WP16b) promoted `ecr_wk_rank` and `ecr_wk_sd` into the served artifact, which is now **27**
> features. Nothing in this study is retracted: every arm, fold and verdict here is a correct
> measurement of the design that was served when it ran, and the two new columns were explicitly
> NOT in it. But the ledger's headline claim -- *what each SHIPPED weekly feature contributes today*
> -- is a claim about the served design, and that design moved. So (a) this table has no row for the
> two new columns, and (b) the contribution of the other twenty-five was measured without them
> present, and a correlated column can only shrink a neighbour's leave-one-out. **The driver
> (`scripts/weekly-contribution-ledger.mjs`) HAS been moved to the 27-column design** and carries an
> `ecr` family, because the test that pins it exists to stop the ledger ablating a model nobody
> serves; re-running the study against that design is an open follow-up and is ~31 arms x 14 folds
> x ~4.7 min. Until it runs, this document is dated rather than wrong.

**Nothing here is shipped.** No default feature list, trainer default, lever or artifact changed.
`tools/train_weekly.py`, `src/weekly/**` and `scripts/weekly-paired-floor.mjs` are untouched by this
work. The store was read through a `VACUUM INTO` snapshot; every fold artifact, every arm JSON and
every cache went to a scratch dir. The four served weekly artifacts are byte-identical at the end
(`weekly-artifact.json` a3871f4c489164abbda8e29734b16f53, `weekly-artifact-lineonly.json`
d2982b1c809838356bd450b8e0e3ae3f, `dst-stream-artifact.json` adf5069013d2f65b7328b1ae4dfd4ace,
`weekly-artifact.candidate-ecr.json` 89e133ec8225f248f12664a0b5b87eb3).

## The question nobody had asked

Every weekly feature was admitted, or rejected, against the baseline of its own day, and the last
three sessions of weekly work (M2a/M2b ECR, D19 boosting, D20 DST) all asked "does adding X help?".
The symmetric question -- *what does each of the 25 shipped weekly features still contribute TODAY,
given every other shipped feature?* -- had never been asked.
`docs/contribution-ledger-2026-09-16.md` is the same study one horizon up, on the SEASON projector;
this is its weekly twin, and the two are built to be read side by side.

## What is actually in the served weekly fit

25 features, enumerated from `data/weekly-artifact.json` itself rather than from the trainer's
`ALL_FEATURES` (which is 29: it also declares `rz_share_td`, `prior_vol_cv` and the two `ecr_wk_*`
columns, all REJECTED or not-yet-shippable candidates). `test/weekly-contribution-ledger.test.ts`
asserts the list against the served artifact, so a 26th served column fails the suite rather than
being quietly measured as 25.

| family | members | n |
|---|---|---|
| level anchor | `season_line_pg` | 1 |
| form | `td_ppg`, `t4_mean`, `t4_sd`, `td_games` | 4 |
| usage | `td_fd`, `td_ts`, `td_attempts`, `td_rush_yards`, `prior_snap_share`, `prior_route_share`, `depth_rank` | 7 |
| availability | `inj_out`, `inj_doubtful`, `inj_questionable`, `prac_dnp`, `prac_limited`, `inj_feed`, `teammates_out` | 7 |
| game context | `spread_line`, `total_line`, `implied_team_total`, `days_rest`, `home`, `week_no` | 6 |

**This is NOT `train_weekly.py`'s `MASKABLE_GROUPS`, deliberately.** That grouping is by HOW a block
goes absent AT SERVE -- there the four to-date workload columns sit in "form" because they vanish
with the rest of the to-date block on a forward week, and the three odds columns are their own
"odds" group. This grouping is by WHAT THE MODEL LEARNS FROM: workload is usage, not scoring, and
the odds columns are game context alongside `home`/`days_rest`/`week_no`. Both are right about
different questions; the divergence is stated rather than reconciled.

## Method

- **One script version for every arm.** `scripts/weekly-contribution-ledger.mjs` (new, read-only)
  trains the folds with `tools/train_weekly.py` -- a character-for-character copy of the invocation
  `src/weekly/evaluate.ts`'s `trainHoldout` issues -- and scores each arm with
  `ff evaluate-weekly --keep-artifacts <arm dir> --reuse-artifacts --json`. The verdict, the 2.9\*SE
  floor (WS1) and the selection/holdout split (WS2) are `scripts/lib/arbiter.mjs` and
  `scripts/lib/holdout.mjs`; nothing here re-implements a statistic.
- **Window 2012-2025, 14 leave-one-season-out folds per arm**, `--rosters 300` -- the same call
  section 7.3 of `docs/weekly.md` gates on. The window is NAMED rather than defaulted, because the
  2026 rows were being rewritten by another session while these arms ran.
  **DECISION block 2012-2020 (9 seasons); CONFIRM block 2021-2025, quoted once, never gating.**
- **Metric: pooled CRPS of the `weekly` model per held-out season** (`bySeason[Y].weekly.crps`), the
  exact field `weekly-paired-floor.mjs` reads. `contribution = CRPS(ablated) - CRPS(full)`, so a
  **positive** number means removing the thing HURT.
- **The unit of analysis is the SEASON.** Every arm sees the same held-out rows and the same
  common-random-number roster draws, so the per-season deltas are matched pairs.
- **31 trained arms x 14 folds = 434 fold trainings**, plus 31 fold-reusing score-only arms.
- Family-wide **BH FDR (WS4)** across the 21 retrained LOO rows. The serve-mask rows are NOT members
  of that family -- they are a different quantity measured on the same folds.

### The constraint this study does not fight, and what stands in for it

`tools/train_weekly.py` REFUSES `--zero-model two-part` -- what the shipped artifact is -- unless
`inj_out`, `depth_rank`, `teammates_out` and `prior_snap_share` are all in the fitted set. Its own
comment says why: a two-part model whose first stage sees only to-date scoring "fits the CONSEQUENCE
of an injury rather than the injury". So those four have **no training-time leave-one-out arm**, and
neither does a bare season-line-only knock-in floor.

Three options existed; the choice is stated rather than implied.

1. Work around the guard (fit those four arms as `--zero-model quantile`). **Rejected** -- it would
   measure a different model, so the four rows would not be comparable to the other 21.
2. Compare stage-two (ratio-given-played) heads only. **Rejected** -- the served quantity is the
   MIXTURE, so a stage-two-only comparison answers a question nobody serves.
3. **CHOSEN: a SERVE-TIME MASK.** `ff evaluate-weekly --mask-serve <col>` nulls the column on the
   SCORED rows and leaves the fold's training untouched (`applyServeMask`, `src/weekly/evaluate.ts`),
   so the projector turns it into the artifact's declared `missing` for the linear heads and NaN for
   the boosted design -- byte for byte what a Sunday with that feed dark hands the serving path.

**It is a DIFFERENT quantity and it has its own table.** A leave-one-out asks "what does the model
lose if it never learns from this column"; a serve mask asks "what does it lose on a week the column
is absent, having learned from it". The mask was run for **all 25 features and all 5 families**, not
only the four refused ones, precisely so the two tables can be read column by column -- and section 3
is what that comparison turned out to be worth.

### The knock-in floor

The smallest design the two-part contract permits is `season_line_pg` plus the four required
columns. **Every knock-in arm is that floor plus one family**, so the four required columns are held
CONSTANT across the whole knock-in table rather than being credited to any family; otherwise
"availability" and "usage" would each be handed two of them for free and the table would be reading
its own construction. The level family therefore gets no knock-in row (it IS the floor) and no
leave-family-out row (it IS its own leave-one-out).

### Positive controls (charter rule 4 / the repo checklist's item 3)

A page of "no measurable contribution" rows is exactly what a DISCONNECTED harness prints, so the
controls come before the tables.

1. **THE CROSS-SESSION REPRODUCIBILITY CONTROL, and it is the strongest available.** The full
   25-feature arm's 14 per-season CRPS reproduce the M2a screen's BASELINE arm
   (`docs/weekly-ecr-screen-2026-09-16.md` 5.2) to four decimals on **every one of the 14 seasons**
   -- 2.7220, 2.7970, 2.6769, 2.7106, 2.6214, 2.7063, 2.8616, 2.8362, 2.8624, 2.8149, 2.6871,
   2.7261, 2.8382, 2.8229 -- and so does the decision metric (standard-15 **85.537** vs the recorded
   85.54; deep-18 **90.463** vs 90.46). Different session, different driver, different fold
   directory, a snapshot rather than the live store, single-threaded children. If this driver's
   plumbing had changed what is fitted or scored, this is the number that would have moved.
2. **The trainer is deterministic, checked on bytes, three ways.** The same fold (`full`/2012)
   trained (a) by an interrupted predecessor run hours earlier, (b) fresh with all 32 cores
   available, and (c) fresh pinned to one OpenMP thread are all md5
   `01aee27d054cac5a338aed9cae9f6a3d`.
3. **DEGENERATE is reachable against a real pair of runs, not only against a fixture.** `full_dup`
   re-scores the full arm's own folds with an EMPTY mask, LAST, after every other arm: largest
   per-season |delta| **0.00e+0**, reported as DEGENERATE. That is both the "the harness did not
   move under the study" check and the only proof that `isDegenerate` can return its positive value.
4. **Every arm's folds fit exactly the arm's feature list, read off the producer's own bytes.**
   `--verify` re-read all 434 fold artifacts: *"every fold of 31 trained arms carries exactly its
   arm's feature list, two-part/gbm, rostered/in_population, holdout excluded."* A stale or
   mis-targeted fold produces a perfectly well-formed CRPS and is invisible in every number below;
   this is the only thing separating "the ablation happened" from "the ablation did not".
5. **The serve mask is connected and can produce small, large and zero.** `depth_rank` +0.560,
   `home` +0.00043, `inj_feed` exactly 0.000000 -- from the same code path, same invocation shape.
   A mask that could only ever be a no-op would print a page of zeros; a mask that always moved
   something would print no exact zeros. Both extremes are present.
6. **The floor can say KEEP and can say sub-floor**, fault-injected in
   `test/weekly-contribution-ledger.test.ts` (a clean 0.20 CRPS loss must clear 2.9\*SE; an
   alternating +/-0.05 must not), alongside the sign of `contribution`, the degenerate-vs-noisy-zero
   distinction, the five-family partition, and that every trained arm really drops what it claims.

### What this study cost, and the one engineering finding in it

A fold of the shipped recipe (25 features, `--zero-model two-part --learner gbm`) is **4m44s alone**
on this box, and `evaluateWeekly` runs its 14 folds in a plain sequential `for` -- so one arm is ~66
minutes on ONE core of 32, and 31 trained arms is 33 core-hours serialised into 33 wall-hours. The
driver therefore trains the (arm, season) grid itself in a bounded pool and hands the harness the
folds through `--reuse-artifacts`.

**The measurement that made that work.** The first pooled run at 26-way concurrency took **20-24
minutes per fold** -- a 5.6x speedup for 26x the processes. The cause is not memory or disk:
scikit-learn defaults to one OpenMP thread PER CORE, so 26 folds in flight ask for 26 x 32 = 832
threads on 32 cores and the pool spends its time in the scheduler. Pinning each child to one thread
(`OMP_NUM_THREADS=1` and its four siblings) took per-fold time to **706-835s at the same
concurrency** -- ~2.0 folds/minute, ~10x the serial rate, and the 434 folds landed in ~3 hours with
**zero failures**. It changes nothing about what is fitted, and that was checked on bytes rather than
argued (control 2 above). Scoring an arm from folds already on disk is **55 seconds**.

---

## 1. THE LEAVE-ONE-OUT LEDGER (ESPN incumbent, 25 shipped features)

Full design pooled CRPS **2.76471** over 14 seasons; decision-block mean **2.75493**.
`+` = removing the feature hurt that season.

| feature | contribution +/- SE (sel 2012-2020) | floor 2.9\*SE | wins | verdict | BH q (n=21) | holdout 2021-2025 | confirmed |
|---|---|---|---|---|---|---|---|
| `season_line_pg` | **+0.03344 +/- 0.00189** | 0.00548 | 9/9 | **KEEP** | 0.000 | **+0.03436 (5/5)** | **yes** |
| `week_no` | **+0.01025 +/- 0.00298** | 0.00865 | 8/9 | **KEEP** | 1.0e-3 | +0.00503 (4/5) | no |
| `td_games` | **+0.00998 +/- 0.00205** | 0.00595 | 9/9 | **KEEP** | 6.0e-6 | +0.00538 (5/5) | no |
| `inj_doubtful` | **+0.00572 +/- 0.00157** | 0.00456 | 8/9 | **KEEP** | 5.8e-4 | **+0.01063 (5/5)** | **yes** |
| `prac_dnp` | **+0.00524 +/- 0.00133** | 0.00387 | 8/9 | **KEEP** | 2.3e-4 | +0.00462 (4/5) | no |
| `prac_limited` | **+0.00302 +/- 0.00070** | 0.00202 | 8/9 | **KEEP** | 4.8e-5 | +0.00156 (4/5) | no |
| `implied_team_total` | +0.00238 +/- 0.00100 | 0.00290 | 7/9 | DROP (sub-floor) | 2.0e-2 | +0.00407 (5/5) | no |
| `td_ppg` | +0.00227 +/- 0.00095 | 0.00276 | 7/9 | DROP (sub-floor) | 2.0e-2 | +0.00353 (4/5) | no |
| `td_ts` | +0.00201 +/- 0.00080 | 0.00232 | 7/9 | DROP (sub-floor) | 1.8e-2 | -0.00069 (2/5) | no |
| `td_rush_yards` | +0.00114 +/- 0.00087 | 0.00252 | 7/9 | DROP (sub-floor) | 1.8e-1 | +0.00186 (4/5) | no |
| `home` | +0.00081 +/- 0.00058 | 0.00168 | 6/9 | DROP (sub-floor) | 1.7e-1 | +0.00149 (4/5) | no |
| `inj_questionable` | +0.00002 +/- 0.00084 | 0.00243 | 4/9 | DROP (sub-floor) | 7.8e-1 | +0.00229 (5/5) | no |
| `inj_feed` | **+0.00000 exactly** | 0.00000 | 0/9 | **DEGENERATE** | -- | +0.00000 (0/5) | -- |
| `days_rest` | -0.00002 +/- 0.00048 | 0.00138 | 6/9 | DROP (negative) | 7.8e-1 | +0.00043 (3/5) | no |
| `td_attempts` | -0.00018 +/- 0.00048 | 0.00139 | 3/9 | DROP (negative) | 8.5e-1 | +0.00065 (4/5) | no |
| `spread_line` | -0.00025 +/- 0.00086 | 0.00249 | 3/9 | DROP (negative) | 8.5e-1 | +0.00108 (4/5) | no |
| `prior_route_share` | -0.00055 +/- 0.00114 | 0.00329 | 5/9 | DROP (negative) | 8.5e-1 | +0.00210 (4/5) | no |
| `total_line` | -0.00088 +/- 0.00079 | 0.00228 | 4/9 | DROP (negative) | 9.6e-1 | +0.00383 (5/5) | no |
| `td_fd` | -0.00122 +/- 0.00118 | 0.00341 | 5/9 | DROP (negative) | 9.6e-1 | -0.00020 (3/5) | no |
| `t4_sd` | -0.00167 +/- 0.00081 | 0.00235 | 2/9 | DROP (negative) | 9.8e-1 | -0.00080 (3/5) | no |
| `t4_mean` | -0.00175 +/- 0.00118 | 0.00341 | 3/9 | DROP (negative) | 9.8e-1 | +0.00336 (5/5) | no |
| `prior_snap_share` | REFUSED by the two-part contract -- see the serve-mask row (+0.04611) | | | | | | |
| `depth_rank` | REFUSED -- see the serve-mask row (**+0.56046**) | | | | | | |
| `teammates_out` | REFUSED -- see the serve-mask row (+0.01234) | | | | | | |
| `inj_out` | REFUSED -- see the serve-mask row (+0.03579) | | | | | | |

**Reading.** Six of the 21 measurable columns clear the 2.9\*SE floor; the level anchor is 3.3x the
next-largest and is the only row with a confirmed holdout and a perfect 9/9 AND 5/5 record. The
**sum of all 21 LOO contributions is +0.0698 CRPS against a full-design 2.7647 -- 2.5% of the loss**,
and 48% of that is `season_line_pg` alone. Three of the six KEEPs are availability columns, which is
the block D19's own missingness work said the boosted heads lean on.

**BH is the looser bar here, not the stricter one, and the floor wins.** Nine rows survive BH at
q<=0.10 but only six clear 2.9\*SE; `td_ts` (q 0.018), `td_ppg` (q 0.020) and `implied_team_total`
(q 0.020) are significant-but-sub-floor. WS1's own logic applies: a keep/drop rule with no
effect-size floor eventually admits noise, so these are reported as DROP.

**`inj_feed` is not a small number, it is an EXACT zero, and it is diagnosed.** Both its leave-one-out
arm (retrained without the column) and its serve-mask arm (trained with, served without) reproduce
the full design **bit for bit on all 14 seasons**. The reason is in the store: over the 70,011 rows
of the decision population, 2012-2025, `inj_feed` takes **exactly one non-null value -- 1 -- in every
season**, with a structural block of 512-544 NULLs per season. It is a constant plus a missingness
pattern, so no head can split on it and no coefficient can move on it. (Note this contradicts
`docs/weekly.md` line 169, "On 2025 `inj_feed` is 1 nowhere": in the current store 4,811 of 5,355
2025 population rows carry `inj_feed = 1`. The doc statement predates a rebuild; worth correcting
separately, and it does not change this row.)

## 2. THE LEAVE-FAMILY-OUT LEDGER, and the knock-in from the floor

Two bounds on the same block. The leave-family-out is the LOWER bound (what is lost when the block
goes, every correlate still present); the knock-in is the UPPER bound (what the block carries alone,
on top of the 5-column floor). Two families can only be dropped down to what the two-part contract
allows, and are marked partial.

| family | leave-family-out (sel) | floor | wins | verdict | holdout | knock-in over floor (sel) | floor | wins | verdict | holdout |
|---|---|---|---|---|---|---|---|---|---|---|
| level (`season_line_pg`) | **+0.03344 +/- 0.00189** | 0.00548 | 9/9 | **KEEP** | +0.03436 (5/5) | *(is the floor)* | | | | |
| game context (6 of 6) | **+0.03404 +/- 0.00474** | 0.01376 | 9/9 | **KEEP** | +0.03141 (5/5) | **+0.02813** | 0.00932 | 9/9 | **ADMIT** | +0.05087 (5/5) |
| availability (5 of 7) | **+0.02816 +/- 0.00259** | 0.00752 | 9/9 | **KEEP** | +0.03011 (5/5) | **+0.02700** | 0.01149 | 9/9 | **ADMIT** | +0.04110 (5/5) |
| form (4 of 4) | **+0.01822 +/- 0.00437** | 0.01268 | 9/9 | **KEEP** | +0.01336 (5/5) | **+0.03885** | 0.01297 | 9/9 | **ADMIT** | +0.03867 (4/5) |
| usage (5 of 7) | +0.00131 +/- 0.00147 | 0.00425 | 4/9 | **DROP (sub-floor)** | +0.00472 (4/5) | **+0.02270** | 0.01017 | 9/9 | **ADMIT** | +0.02051 (5/5) |

The knock-in floor's decision-block mean CRPS is **2.85780** against the full design's **2.75493**,
so **the 20 non-floor columns are jointly worth +0.10287 CRPS** -- 3.7% of the loss.

### Redundancy notes

- **Every family masks itself, three of them heavily.** Joint minus sum-of-members' LOO:
  game context **+0.02175** (members sum +0.01229, joint +0.03404), availability **+0.01416**
  (+0.01400 -> +0.02816), form **+0.00939** (+0.00883 -> +0.01822), usage **+0.00011**
  (+0.00120 -> +0.00131, additive). The three odds columns and the five practice/designation columns
  substitute for one another almost perfectly, which is why every one of them reads as a sub-floor
  nothing on its own. **A LOO table alone can never license dropping a family.**
- **Across the whole design the redundancy is 2.8x.** The 20 non-floor columns sum to **+0.03632**
  individually (the 21 LOO rows minus `season_line_pg`) against a joint **+0.10287**. Most of what
  the weekly model knows beyond the line is carried by more than one column.
- **The families are themselves sub-additive.** The four knock-ins sum to +0.11668 against the
  joint +0.10287, so ~12% of what any family carries alone is already carried by another.
- **`usage` is the one block that is redundant in BOTH directions**, and it is the only DROP verdict
  in the table: the five droppable usage columns are worth +0.0227 ALONE on the floor, and +0.0013
  (4/9, inside the floor) once the rest of the design is present. Everything they know, `td_games`,
  the availability block and the line already know.

## 3. THE SERVE-TIME MASK -- a different quantity, and the study's biggest structural finding

Fit-WITH, serve-WITHOUT: the full design's 14 folds, re-scored with the column nulled on the scored
rows. This is the only measurement available for the four columns the trainer will not drop, and it
was run for all 25 so the two tables line up.

| feature | serve mask (sel) | floor | wins | verdict | holdout | leave-one-out (sel) | mask / LOO |
|---|---|---|---|---|---|---|---|
| `depth_rank` | **+0.56046 +/- 0.04372** | 0.12679 | 9/9 | **KEEP** | +0.60702 (5/5) | *(refused)* | -- |
| `t4_mean` | **+0.20356 +/- 0.03109** | 0.09015 | 9/9 | **KEEP** | +0.19040 (5/5) | **-0.00175** | sign flip |
| `season_line_pg` | **+0.09712** | 0.01679 | 9/9 | **KEEP** | +0.09880 (5/5) | +0.03344 | 2.9x |
| `td_ppg` | **+0.05984** | 0.02264 | 9/9 | **KEEP** | +0.11814 (5/5) | +0.00227 | 26x |
| `prior_snap_share` | **+0.04611** | 0.01876 | 8/9 | **KEEP** | +0.04039 (5/5) | *(refused)* | -- |
| `inj_out` | **+0.03579** | 0.01059 | 9/9 | **KEEP** | +0.04132 (5/5) | *(refused)* | -- |
| `td_games` | **+0.02432** | 0.00861 | 9/9 | **KEEP** | +0.01826 (5/5) | +0.00998 | 2.4x |
| `week_no` | **+0.01981** | 0.00756 | 9/9 | **KEEP** | +0.01438 (5/5) | +0.01025 | 1.9x |
| `inj_questionable` | **+0.01666** | 0.00559 | 9/9 | **KEEP** | +0.00850 (5/5) | +0.00002 | 833x |
| `implied_team_total` | **+0.01464** | 0.00432 | 9/9 | **KEEP** | +0.01498 (5/5) | +0.00238 | 6.2x |
| `teammates_out` | **+0.01234** | 0.00292 | 9/9 | **KEEP** | +0.00650 (4/5) | *(refused)* | -- |
| `inj_doubtful` | **+0.00917** | 0.00385 | 9/9 | **KEEP** | +0.01177 (5/5) | +0.00572 | 1.6x |
| `prac_dnp` | **+0.00901** | 0.00404 | 9/9 | **KEEP** | +0.01061 (5/5) | +0.00524 | 1.7x |
| `prac_limited` | **+0.00739** | 0.00268 | 9/9 | **KEEP** | +0.00676 (5/5) | +0.00302 | 2.4x |
| `days_rest` | **+0.00485** | 0.00278 | 8/9 | **KEEP** | +0.00742 (5/5) | -0.00002 | sign flip |
| `spread_line` | **+0.00455** | 0.00253 | 9/9 | **KEEP** | +0.00361 (5/5) | -0.00025 | sign flip |
| `total_line` | **+0.00281** | 0.00218 | 8/9 | **KEEP** | +0.00606 (5/5) | -0.00088 | sign flip |
| `td_ts` | +0.00485 | 0.00518 | 8/9 | sub-floor | +0.00168 (4/5) | +0.00201 | 2.4x |
| `t4_sd` | +0.00176 | 0.00226 | 7/9 | sub-floor | +0.00082 (4/5) | -0.00167 | sign flip |
| `prior_route_share` | +0.00149 | 0.00309 | 4/9 | sub-floor | +0.00669 (5/5) | -0.00055 | sign flip |
| `td_rush_yards` | +0.00127 | 0.00194 | 7/9 | sub-floor | +0.00209 (4/5) | +0.00114 | 1.1x |
| `home` | +0.00043 | 0.00066 | 7/9 | sub-floor | +0.00158 (5/5) | +0.00081 | 0.5x |
| `td_fd` | +0.00040 | 0.00326 | 6/9 | sub-floor | +0.00197 (4/5) | -0.00122 | sign flip |
| `td_attempts` | +0.00013 | 0.00105 | 4/9 | sub-floor | -0.00111 (2/5) | -0.00018 | sign flip |
| `inj_feed` | **+0.00000 exactly** | 0.00000 | 0/9 | **DEGENERATE** | +0.00000 | +0.00000 | 0/0 |

| family | serve mask (sel) | floor | wins | verdict | holdout | leave-family-out (sel) |
|---|---|---|---|---|---|---|
| usage (all 7) | **+0.39950 +/- 0.02024** | 0.05870 | 9/9 | **KEEP** | +0.39148 (5/5) | +0.00131 (5 of 7) |
| availability (all 7) | **+0.14107 +/- 0.00682** | 0.01977 | 9/9 | **KEEP** | +0.13337 (5/5) | +0.02816 (5 of 7) |
| level | **+0.09712** | 0.01679 | 9/9 | **KEEP** | +0.09880 (5/5) | +0.03344 |
| form (all 4) | **+0.08291** | 0.02816 | 9/9 | **KEEP** | +0.06525 (5/5) | +0.01822 |
| game context (all 6) | **+0.05938** | 0.01498 | 9/9 | **KEEP** | +0.06430 (5/5) | +0.03404 |

**THE FINDING: a leave-one-out measures REDUNDANCY; a serve mask measures RELIANCE, and for this
model they are almost unrelated.** `t4_mean` is the cleanest case. Its leave-one-out is **-0.0018**
-- take it out of the design and the boosted heads re-learn the same thing from `td_ppg`/`t4_sd`/
`td_games`, and the model is fractionally *better*. Its serve mask is **+0.2036, 9/9, holdout 5/5**:
lose it on a Sunday, having fitted on it, and the model loses two orders of magnitude more than the
LOO says it is worth. Eight of the 21 measurable columns flip sign between the two tables, and the
family ordering inverts completely -- `usage` is the LEAST valuable family to remove from the design
(+0.0013, DROP) and by far the MOST expensive to lose at serve (+0.3995, 3x the next). The reason is
structural and D19 already named half of it: the trees route on feature COMBINATIONS, so removing a
column at training time lets every other column re-cover its ground, while nulling it at serve time
pushes the row onto a branch the fit never intended.

**Both numbers are needed, and they answer different questions.** "Should this column stay in the
design?" is the LOO. "What does a dead feed cost us this week?" is the mask -- and for the four
columns whose LOO the trainer refuses, only the second is available, which is worth saying out loud
because `depth_rank`'s mask (**+0.560, twenty times any other column's**) is easy to misread as
"depth_rank is twenty times as important". It is not a leave-one-out and it is not comparable to one.

## 4. THE DECISION LAYER -- does any of this move a lineup?

Mean captured points, weekly model, same 300 common-random-number rosters per scenario, from the
same invocations. A CRPS drop that moves no lineup is a curiosity.

| arm | standard-15 | delta | deep-18 | delta |
|---|---|---|---|---|
| **full design** | **85.537** | -- | **90.463** | -- |
| *(shipped `week()` baseline, for scale)* | 76.982 | -8.555 | 80.524 | -9.939 |
| LOO `season_line_pg` | 84.939 | **-0.598** | 89.738 | **-0.724** |
| LOO `inj_doubtful` | 85.411 | -0.126 | 90.337 | -0.125 |
| LOO `td_games` | 85.434 | -0.104 | 90.407 | -0.056 |
| LOO `week_no` | 85.460 | -0.078 | 90.392 | -0.070 |
| LOO `prac_dnp` | 85.482 | -0.055 | 90.397 | -0.066 |
| LOO `t4_sd` | 85.632 | **+0.095** | 90.621 | **+0.158** |
| fam **availability** | 85.192 | **-0.346** | 90.006 | **-0.457** |
| fam **game context** | 85.356 | -0.181 | 90.244 | -0.219 |
| fam **form** | 85.412 | -0.125 | 90.345 | -0.117 |
| fam **usage** | 85.547 | **+0.010** | 90.556 | **+0.093** |
| knock-in **floor** (5 columns) | 84.458 | **-1.079** | 89.113 | **-1.350** |
| knock-in floor + form | 84.980 | -0.557 | 89.790 | -0.672 |
| knock-in floor + availability | 84.810 | -0.727 | 89.559 | -0.903 |
| knock-in floor + usage | 84.786 | -0.752 | 89.540 | -0.922 |
| knock-in floor + game context | 84.749 | -0.788 | 89.458 | -1.005 |
| serve-mask fam **form** | 82.019 | **-3.518** | 86.247 | **-4.215** |
| serve-mask fam **usage** | 83.614 | -1.924 | 87.977 | -2.486 |
| serve-mask fam **availability** | 83.765 | -1.773 | 88.409 | -2.054 |
| serve-mask fam **game context** | 85.089 | -0.448 | 89.956 | -0.507 |
| serve-mask fam **level** | 85.130 | -0.407 | 90.045 | -0.418 |

**The decision layer re-orders the families, and it disagrees with CRPS in both tables.** By
leave-family-out CRPS the order is context (+0.0340) > level (+0.0334) > availability (+0.0282) >
form (+0.0182) > usage (+0.0013). By lineup regret it is **level (-0.60) > availability (-0.35) >
context (-0.18) > form (-0.13) > usage (+0.01)**. Availability and the level anchor move starters
roughly twice as hard as their CRPS rank implies, and game context roughly half as hard -- which is
what you would expect if the odds columns sharpen the whole distribution slightly while availability
decides *whether a man plays at all*, and a lineup only cares about the latter.

**The whole 20-column apparatus beyond the floor is worth ~1.1 points a lineup**, and no single
feature is worth more than 0.13 except the line itself (0.60). Against the shipped `week()` baseline
the model is +8.6 points, so ~87% of the decision value is the floor -- the line plus the four
availability/usage columns the two-part contract requires -- and ~13% is everything else.

**Two arms IMPROVE the lineup while their CRPS says "no measurable contribution".** Dropping `t4_sd`
(+0.095/+0.158) and dropping the five droppable usage columns (+0.010/+0.093) both leave the manager
fractionally better off. Both are far inside sampling noise for this metric and neither is a
recommendation on its own -- but they are the two rows where the CRPS DROP verdict and the decision
metric agree in sign, which is the only combination that makes a drop candidate interesting.

## 5. Plain reading

**Which family carries the weekly model: the LEVEL ANCHOR, and then availability -- and the answer
depends on which question you asked.** For "what would we lose by not fitting it", the level anchor
is the only column with a confirmed holdout and it is 48% of the +0.0698 that all 21 measurable
columns add; the three block-level KEEPs are game context, availability and form, each 9/9 on the
decision block and 5/5 on the holdout. For "what would we lose on a Sunday the feed is dark", it is
**usage** (+0.3995) and **availability** (+0.1411), three and one times the level anchor
respectively. For "what actually changes the starting lineup", it is **level** (-0.60/pt) then
**availability** (-0.35). No single ordering is the right one and this document does not pick one.

**The DROP candidates, and their holdouts.**

1. **`inj_feed`, alone, and it is not a judgement call.** Retrained without it and served without it,
   the model is **bit-identical on all 14 seasons**, decision block and holdout alike, at CRPS and at
   lineup regret. The store says why: one distinct non-null value in every season of the fitted
   window. This is a dead column, not a small one -- the only row in either ledger where "carries
   nothing" is a proof rather than a failure to resolve.
2. **The five droppable usage columns `td_fd`, `td_ts`, `td_attempts`, `td_rush_yards`,
   `prior_route_share`, as a JOINT selection of five.** Leave-family-out +0.00131 +/- 0.00147 (4/9)
   on the decision block, inside its 0.00425 floor; holdout +0.00472 (4/5), also inside; lineup
   regret **+0.010 / +0.093**, i.e. fractionally better without them. Three things must be said
   before anyone acts on it: (a) it is **one drop of five columns measured together**, not five
   independent drops -- and unusually for this repo the masking runs the *other* way here (members
   sum +0.00120, joint +0.00131), so the joint is honest; (b) the effect is inside the floor, so the
   claim is "no measurable contribution", not "harmful"; (c) **the serve mask says the opposite about
   the block as a whole** (+0.3995 for all seven), which is not a contradiction -- it is the
   difference between a column the design can do without and a feed the serving path cannot -- but it
   does mean the two columns the contract keeps (`prior_snap_share`, `depth_rank`) are doing that
   work, not the five proposed for removal.
3. **Nothing else.** `t4_sd` and `t4_mean` are negative on the decision block and `t4_mean` is
   positive on the holdout (5/5) with a +0.204 serve mask; that is a column the design does not need
   and the serving path does. Leave it.

**Where the headroom is, and the ledger's answer is "not in another weekly column".** 25 fitted
features; 15 of the 21 measurable ones cannot be resolved from noise on nine decision seasons; the
entire fitted set adds 2.5% of the loss on top of the line, and the 20 non-floor columns add 3.7%
jointly while summing to 1.3% individually -- a 2.8x redundancy that says the design is already
carrying several copies of the same signal. The floor on nine decision seasons is 0.002-0.014 CRPS,
0.07-0.5% of the loss, so anything smaller is unmeasurable here no matter how real. That is the same
verdict `docs/contribution-ledger-2026-09-16.md` reached for the season projector and the same one
M1 reached for the Yahoo screen, now at the weekly horizon.

**But the weekly track has one lever the season track does not, and this study found it.** The two
largest numbers in the whole document are serve-time, not training-time: `depth_rank` **+0.560** and
the usage family **+0.3995** -- 5x and 4x what the entire 20-column non-floor design is worth as a
fit (+0.103). The weekly model is not short of features; it is short of **feed availability on the
week it serves**. `docs/weekly.md` section 8 already measured half of this (the D19 all-imputed 2026
regime) and M2a/M2b hit exactly the same wall from the other side (a feature that ADMITs and cannot
be served). Weekly feature engineering should be considered closed at this power; **weekly feed
engineering -- keeping `depth_rank`, the snap/route shares and the injury designations alive and
dated on the live week -- is worth 4-5x more than any column anyone could add.**

## Reproduce

```
# the arm plan (31 trained arms, 31 fold-reusing arms, 4 refused by the two-part contract)
node --import tsx scripts/weekly-contribution-ledger.mjs --plan

# 434 fold trainings into <dir>/_folds/<arm>/, single-threaded children, resumable
node --import tsx scripts/weekly-contribution-ledger.mjs --train  --out-dir <dir> --db <snapshot> --concurrency 26

# the positive control that makes the tables mean anything
node --import tsx scripts/weekly-contribution-ledger.mjs --verify --out-dir <dir>

# 62 arms x 55s, stdout streamed to a file (never a pipe buffer)
node --import tsx scripts/weekly-contribution-ledger.mjs --score  --out-dir <dir> --db <snapshot> --concurrency 6
node --import tsx scripts/weekly-contribution-ledger.mjs --report --out-dir <dir>

# one row, directly, through the existing floor:
node --import tsx scripts/weekly-paired-floor.mjs --baseline <dir>/loo__td_ppg.json --candidate <dir>/full.json
```

## Gates

`npm run typecheck` clean. `npm test` green (1045 tests, 0 fail, 2 skipped, including the 12 new
`test/weekly-contribution-ledger.test.ts` cases). The four served weekly artifacts byte-identical
(md5s at the top). `data/ff.db` never opened by this study -- every read went through the
`VACUUM INTO` snapshot `ff-m2g.db` (md5 048cdc4c7e4bb4073da45183b41d14fb).

---
---

# THE RERUN ON THE SERVED 26-COLUMN DESIGN (WP18, 2026-09-17)

**This section supersedes every table above.** Everything above was measured on the **25-column**
pre-D27 design; this is the same study, same driver, same folds-per-arm, same statistic, on the design
that ships today (D27 added `ecr_wk_rank`/`ecr_wk_sd`; D30 dropped the dead `inj_feed`). The 25-column
tables are kept, banner and all, because they are the record the two promotions were decided against
and because the comparison BETWEEN the two designs is itself a finding.

**WHAT SHIPPED, unlike the study above.** The 25-column study shipped nothing. This rerun is the
POST-PROMOTION measurement of two changes that did ship on the strength of the earlier one: D27
(consensus in) and D30 (`inj_feed` out). The rerun itself ships nothing -- it wrote no artifact, no
default and no lever, and read a `VACUUM INTO` snapshot rather than the store.

**34 trained arms x 14 folds = 476 fold trainings, zero failures**, plus 33 fold-reusing score-only
arms, over ~2h20 at 24-way concurrency with each child pinned to one OpenMP thread. Same window
2012-2025, same decision block 2012-2020 / confirm block 2021-2025, `--rosters 300`, the same
`VACUUM INTO` snapshot (`ff-wp18.db`). Nothing was written to `data/ff.db`.

**Controls, first.**

- **DEGENERACY:** `full_dup` re-scores the full arm's own folds LAST, after every other arm, with an
  empty mask: largest per-season |delta| **0.00e+0**. The harness did not move under the study, and
  `isDegenerate` is shown returning its positive value against a real pair of runs rather than a fixture.
- **EVERY FOLD FITTED ITS OWN ARM'S LIST**, re-read off the producer's bytes (`--verify`): *"every fold
  of 34 trained arms carries exactly its arm's feature list, two-part/gbm, rostered/in_population,
  holdout excluded."*
- **The full arm's per-season CRPS reproduces the D30 drop screen's `served27`/`cand26` arms exactly**
  (2.7252, 2.7981, 2.6796, 2.7123, 2.6210, 2.7017, 2.8522, 2.8408, 2.8259, 2.7881, 2.6525, 2.6753,
  2.7802, 2.8113; lineup 85.729 / 90.704) -- a different driver, a different out-dir, a different day's
  fold set. Full pooled CRPS **2.74829**, decision-block mean **2.75074**.

## R1. The leave-one-out ledger, 26 columns

`+` = removing the feature hurt. Four rows are REFUSED a training-time leave-one-out by the trainer's
two-part contract (`inj_out`, `depth_rank`, `teammates_out`, `prior_snap_share`) and appear only in the
serve-mask table, exactly as before.

| feature | contribution (sel 2012-2020) | floor 2.9\*SE | wins | verdict | BH q (n=22) | holdout 2021-2025 | all 14 |
|---|---|---|---|---|---|---|---|
| `season_line_pg` | **+0.03536 +/- 0.00236** | 0.00684 | 9/9 | **KEEP** | 0.0 | **+0.03384 (5/5)** | +0.03482 (14/14) |
| `td_games` | **+0.00847 +/- 0.00176** | 0.00511 | 9/9 | **KEEP** | 8.5e-6 | **+0.00749 (5/5)** | +0.00812 (14/14) |
| `prac_dnp` | **+0.00576 +/- 0.00150** | 0.00434 | 7/9 | **KEEP** | 3.2e-4 | +0.00390 (4/5) | +0.00510 (11/14) |
| `inj_doubtful` | **+0.00486 +/- 0.00111** | 0.00323 | 8/9 | **KEEP** | 4.6e-5 | **+0.00841 (5/5)** | +0.00613 (13/14) |
| `week_no` | +0.00813 +/- 0.00312 | 0.00906 | 8/9 | DROP (sub-floor) | 1.7e-2 | +0.00433 (4/5) | +0.00677 (12/14) |
| `ecr_wk_rank` | +0.00256 +/- 0.00201 | 0.00584 | 6/9 | DROP (sub-floor) | 2.2e-1 | **+0.01531 (5/5)** | +0.00711 (11/14) |
| `prac_limited` | +0.00235 +/- 0.00082 | 0.00237 | 7/9 | DROP (sub-floor) | 9.1e-3 | +0.00118 (3/5) | +0.00193 (10/14) |
| `td_ppg` | +0.00194 +/- 0.00103 | 0.00299 | 5/9 | DROP (sub-floor) | 8.1e-2 | +0.00310 (5/5) | +0.00236 (10/14) |
| `implied_team_total` | +0.00155 +/- 0.00074 | 0.00215 | 6/9 | DROP (sub-floor) | 5.7e-2 | +0.00318 (5/5) | +0.00213 (11/14) |
| `td_ts` | +0.00122 +/- 0.00105 | 0.00305 | 5/9 | DROP (sub-floor) | 2.5e-1 | +0.00019 (2/5) | +0.00085 (7/14) |
| `td_rush_yards` | +0.00085 +/- 0.00056 | 0.00163 | 7/9 | DROP (sub-floor) | 1.6e-1 | +0.00196 (4/5) | +0.00124 (11/14) |
| `spread_line` | +0.00068 +/- 0.00077 | 0.00224 | 5/9 | DROP (sub-floor) | 3.2e-1 | -0.00068 (2/5) | +0.00019 (7/14) |
| `days_rest` | +0.00064 +/- 0.00062 | 0.00179 | 5/9 | DROP (sub-floor) | 2.7e-1 | +0.00092 (3/5) | +0.00074 (8/14) |
| `ecr_wk_sd` | +0.00026 +/- 0.00061 | 0.00178 | 5/9 | DROP (sub-floor) | 5.3e-1 | **+0.00286 (5/5)** | +0.00119 (10/14) |
| `t4_mean` | -0.00012 +/- 0.00119 | 0.00346 | 4/9 | DROP (negative) | 7.9e-1 | +0.00143 (3/5) | +0.00044 (7/14) |
| `home` | -0.00019 +/- 0.00057 | 0.00166 | 4/9 | DROP (negative) | 8.1e-1 | +0.00110 (3/5) | +0.00027 (7/14) |
| `total_line` | -0.00020 +/- 0.00100 | 0.00290 | 4/9 | DROP (negative) | 8.0e-1 | +0.00233 (3/5) | +0.00070 (7/14) |
| `t4_sd` | -0.00049 +/- 0.00116 | 0.00335 | 2/9 | DROP (negative) | 8.1e-1 | -0.00038 (2/5) | -0.00045 (4/14) |
| `td_attempts` | -0.00053 +/- 0.00053 | 0.00152 | 4/9 | DROP (negative) | 9.3e-1 | -0.00087 (1/5) | -0.00065 (5/14) |
| `prior_route_share` | -0.00056 +/- 0.00060 | 0.00173 | 3/9 | DROP (negative) | 9.3e-1 | +0.00355 (5/5) | +0.00091 (8/14) |
| `td_fd` | -0.00066 +/- 0.00038 | 0.00109 | 3/9 | DROP (negative) | 9.7e-1 | +0.00130 (3/5) | +0.00004 (6/14) |
| `inj_questionable` | -0.00107 +/- 0.00058 | 0.00168 | 3/9 | DROP (negative) | 9.7e-1 | +0.00230 (5/5) | +0.00014 (8/14) |
| `prior_snap_share` / `depth_rank` / `teammates_out` / `inj_out` | REFUSED by the two-part contract -- serve-mask rows only | | | | | | |

**Four of the 22 measurable columns clear the floor**, against six of 21 on the 25-column design. The
22 rows sum to **+0.07083 against a 2.75074 decision-block mean -- 2.57% of the loss**, and the level
anchor is 50% of it. Both figures are within a hair of the 25-column edition's (+0.0698, 2.5%, 48%):
**the design got two columns, lost one, and carries almost exactly as much as it did.**

## R2. The five verdicts that FLIPPED, and why each one is a reading rather than a result

This is what the comparison between the two designs buys, and it is mostly a lesson about how thin
these rows are.

| row | 25-column | 26-column | what moved |
|---|---|---|---|
| `week_no` | **KEEP** +0.01025 (floor 0.00865) | DROP (sub-floor) +0.00813 (floor 0.00906) | the estimate fell 20% AND the SE rose 5% -- it crossed from both sides at once |
| `prac_limited` | **KEEP** +0.00302 (floor 0.00202) | DROP (sub-floor) +0.00235 (floor **0.00237**) | **misses by 0.00002.** A verdict decided in the fifth decimal is not a finding in either direction |
| `home` | DROP (sub-floor) +0.00081 | DROP (negative) -0.00019 | sign flip inside a 0.0017 floor |
| `inj_questionable` | DROP (sub-floor) +0.00002 | DROP (negative) -0.00107 | ditto, and its serve mask is +0.0157 either way |
| `spread_line`, `days_rest` | DROP (negative) | DROP (sub-floor) | sign flips the other way, same verdict class |
| `inj_feed` | **DEGENERATE** (+0.00000 exactly) | *(no row -- D30 dropped it)* | the one row that was a proof, acted on |

**The honest reading of the flips is that nothing survived contact with a 2-column change except the
rows that were never close.** `season_line_pg`, `td_games`, `inj_doubtful` and `prac_dnp` are KEEP in
both designs, 9/9 or 8/9 in both, and BH-significant in both. Every flip happened inside 0.005 CRPS,
which is between a third and twice the floor on nine seasons -- i.e. exactly the resolution limit this
study has been reporting since its first table. **Do not read `week_no` as "demoted" or `prac_limited`
as "rejected"**: read the pair as a demonstration that a keep/drop verdict on a sub-0.01 row is a
coin the design's composition can flip.

## R3. The two new columns, and the shape of a feature that only exists on part of the range

`ecr_wk_rank` and `ecr_wk_sd` are a family of their own, and the serve mask says out loud which
seasons the archive actually covers: masking `ecr_wk_rank` changes **exactly nothing** on
**2012-2018 and 2025**, and moves six seasons, **2019-2024**. That is the coverage, measured from the
model's own behaviour rather than from a coverage query.

| | decision block 2012-2020 (7 of 9 seasons have NO column) | holdout 2021-2025 (4 of 5 have it) |
|---|---|---|
| `famloo__ecr` (leave the family out) | +0.00419, 4/9, floor 0.01246 -- **sub-floor** | **+0.03635, 5/5** |
| knock-in over the 5-column floor | +0.01533, 7/9, floor 0.03050 -- sub-floor | **+0.08490, 4/5** |
| `maskfam__ecr` (serve without it) | +0.00497, 2/9 -- sub-floor | **+0.03715, 4/5** |
| lineup regret, family dropped | **-0.192 / -0.242** | |

**The decision block CANNOT resolve this family and never could**, because seven of its nine seasons
are blank for it; the holdout is where the column exists, and there it is the second-largest family
knock-in in the table. This is the same asymmetry the M2a screen reported when it admitted the column
on the covered seasons and measured an exact null (+0.00015) on the uncovered ones -- so the ledger's
DROP verdict on `famloo__ecr` is **a statement about the archive's start date, not about the feature**,
and it is the one row in this document where the selection/holdout split must not be read the usual
way round. D27's promotion stands on the covered seasons, as recorded.

## R4. Families, and the knock-in

| family | leave-family-out (sel) | floor | wins | verdict | holdout | knock-in over floor (sel) | floor | wins | verdict | holdout |
|---|---|---|---|---|---|---|---|---|---|---|
| level (`season_line_pg`) | **+0.03536** | 0.00684 | 9/9 | **KEEP** | +0.03384 (5/5) | *(is the floor)* | | | | |
| availability (5 of 6) | **+0.02613** | 0.00629 | 9/9 | **KEEP** | +0.02831 (5/5) | **+0.02700** | 0.01149 | 9/9 | **ADMIT** | +0.04110 (5/5) |
| game context (6 of 6) | **+0.02519** | 0.01112 | 9/9 | **KEEP** | +0.02443 (5/5) | **+0.02813** | 0.00932 | 9/9 | **ADMIT** | +0.05087 (5/5) |
| form (4 of 4) | **+0.01786** | 0.01170 | 9/9 | **KEEP** | +0.00903 (4/5) | **+0.03885** | 0.01297 | 9/9 | **ADMIT** | +0.03867 (4/5) |
| ecr (2 of 2) | +0.00419 | 0.01246 | 4/9 | DROP (sub-floor) | **+0.03635 (5/5)** | +0.01533 | 0.03050 | 7/9 | sub-floor | **+0.08490 (4/5)** |
| usage (5 of 7) | +0.00010 | 0.00402 | 5/9 | DROP (sub-floor) | **+0.00643 (5/5)** | **+0.02270** | 0.01017 | 9/9 | **ADMIT** | +0.02051 (5/5) |

The knock-in floor's decision-block mean CRPS is **2.85782** against the full design's **2.75074**, so
the 21 non-floor columns are jointly worth **+0.10707** -- 3.9% of the loss. They sum to **+0.03547**
individually, a **3.0x redundancy** (2.8x on the 25-column design). The five knock-ins sum to
**+0.13201** against that joint **+0.10707**, so ~19% of what any family carries alone is carried by
another too. Masking, family by family (joint minus sum-of-members): context **+0.01458**,
availability **+0.01423**, form **+0.00805**, ecr +0.00137, usage **-0.00022** -- usage is again the
one block that is sub-additive, i.e. genuinely additive-to-nothing.

**AND THE USAGE ROW IS THE ONE THAT MATTERED THIS WEEK.** `famloo__usage` is the D30 21-column
candidate, and the number that stopped it is in this table: sub-floor on the decision block as always,
but **+0.00643 on the holdout, 5 of 5, against a holdout floor of 0.00519** -- resolvable there, where
on the 25-column design it had been +0.00472 at 4/5 and inside. With lineup regret at **-0.051 /
-0.060** it is two signals out of three against the drop. See D30.

## R5. The serve-time mask, and THE ONE GENUINELY NEW FINDING

| feature | serve mask (sel) | floor | wins | verdict | holdout | 25-column mask (sel) |
|---|---|---|---|---|---|---|
| `depth_rank` | **+0.64309** | 0.25926 | 9/9 | **KEEP** | +0.30917 (5/5) | +0.56046 |
| `t4_mean` | **+0.16503** | 0.07670 | 9/9 | **KEEP** | +0.16568 (5/5) | +0.20356 |
| `season_line_pg` | **+0.09505** | 0.01677 | 9/9 | **KEEP** | +0.10451 (5/5) | +0.09712 |
| `td_ppg` | **+0.05349** | 0.03111 | 9/9 | **KEEP** | +0.05392 (5/5) | +0.05984 |
| `prior_snap_share` | **+0.04809** | 0.01919 | 8/9 | **KEEP** | +0.04655 (5/5) | +0.04611 |
| `inj_out` | **+0.03144** | 0.01037 | 9/9 | **KEEP** | +0.03661 (5/5) | +0.03579 |
| `td_games` | **+0.02372** | 0.00787 | 9/9 | **KEEP** | +0.01770 (5/5) | +0.02432 |
| `week_no` | **+0.01910** | 0.00883 | 9/9 | **KEEP** | +0.01529 (5/5) | +0.01981 |
| `inj_questionable` | **+0.01565** | 0.00578 | 9/9 | **KEEP** | +0.01082 (5/5) | +0.01666 |
| `implied_team_total` | **+0.01328** | 0.00513 | 9/9 | **KEEP** | +0.01499 (5/5) | +0.01464 |
| `teammates_out` | **+0.01158** | 0.00467 | 9/9 | **KEEP** | +0.01327 (5/5) | +0.01234 |
| `prac_dnp` | **+0.01052** | 0.00434 | 9/9 | **KEEP** | +0.01189 (5/5) | +0.00901 |
| `inj_doubtful` | **+0.00782** | 0.00361 | 9/9 | **KEEP** | +0.01223 (5/5) | +0.00917 |
| `prac_limited` | **+0.00645** | 0.00249 | 9/9 | **KEEP** | +0.00701 (5/5) | +0.00739 |
| `days_rest` | **+0.00459** | 0.00279 | 8/9 | **KEEP** | +0.00731 (5/5) | +0.00485 |
| `td_ts` | **+0.00416** | 0.00353 | 8/9 | **KEEP** | +0.00111 (3/5) | +0.00485 |
| `ecr_wk_rank` | +0.00332 | 0.00868 | 2/9 | sub-floor | **+0.02820 (4/5)** | *(new)* |
| `spread_line` | **+0.00228** | 0.00133 | 8/9 | **KEEP** | +0.00079 (4/5) | +0.00455 |
| `prior_route_share` | +0.00219 | 0.00246 | 5/9 | sub-floor | +0.00699 (5/5) | +0.00149 |
| `total_line` | +0.00146 | 0.00241 | 6/9 | sub-floor | +0.00587 (5/5) | +0.00281 |
| `t4_sd` | +0.00140 | 0.00382 | 6/9 | sub-floor | +0.00070 (3/5) | +0.00176 |
| `td_rush_yards` | +0.00102 | 0.00123 | 7/9 | sub-floor | +0.00205 (4/5) | +0.00127 |
| `ecr_wk_sd` | +0.00066 | 0.00187 | 2/9 | sub-floor | +0.00417 (3/5) | *(new)* |
| `td_fd` | +0.00058 | 0.00259 | 6/9 | sub-floor | +0.00082 (4/5) | +0.00040 |
| `home` | +0.00023 | 0.00108 | 6/9 | sub-floor | +0.00187 (5/5) | +0.00043 |
| `td_attempts` | -0.00011 | 0.00101 | 5/9 | sub-floor | -0.00095 (2/5) | +0.00013 |

| family | serve mask (sel) | floor | wins | holdout | 25-column (sel / holdout) |
|---|---|---|---|---|---|
| usage (all 7) | **+0.35956** | 0.09430 | 9/9 | **+0.18323 (5/5)** | +0.39950 / **+0.39148** |
| availability (all 6) | **+0.13917** | 0.02015 | 9/9 | +0.14311 (5/5) | +0.14107 / +0.13337 |
| level | **+0.09505** | 0.01677 | 9/9 | +0.10451 (5/5) | +0.09712 / +0.09880 |
| form (all 4) | **+0.07299** | 0.02176 | 9/9 | +0.06038 (5/5) | +0.08291 / +0.06525 |
| context (all 6) | **+0.04761** | 0.01291 | 9/9 | +0.05666 (5/5) | +0.05938 / +0.06430 |
| ecr (all 2) | +0.00497 | 0.01335 | 2/9 | **+0.03715 (4/5)** | *(new)* |

**THE FINDING: promoting the weekly consensus HALVED the model's holdout exposure to a dark usage
feed, and nothing was designed to measure that.** The usage family's serve mask is essentially
unchanged on the decision block (+0.3995 -> +0.3596) and **falls from +0.3915 to +0.1832 on the
holdout** -- and the split lands exactly where the consensus archive starts. The mechanism is
visible in the same tables: `ecr_wk_*` is null on 2012-2018 and moves the model on 2019-2024, which is
7 of the 9 decision seasons blank and 4 of the 5 holdout seasons covered. On a recent Sunday with the
snap/route/depth feeds dark, the model now has an outside opinion about this week to fall back on;
before D27 it had only the level and the to-date block. **This is an OBSERVATION, not a designed
test** -- the two designs differ by exactly the ECR columns, the pattern matches the coverage, and the
selection block (mostly uncovered) barely moved, which is as much as an unplanned comparison can
carry. But it is the first quantified answer to "what does the consensus buy us beyond CRPS", and the
answer is *robustness to the feed failure this study named as the weekly track's biggest exposure*.

**Everything else in section 3 above stands.** A leave-one-out measures REDUNDANCY and a serve mask
measures RELIANCE, and they remain almost unrelated: `t4_mean` is -0.00012 to leave out and **+0.165**
to lose at serve; `inj_questionable` is -0.00107 and **+0.0157**; `depth_rank`'s mask is **+0.643**,
twenty-seven times any leave-one-out in the table and still not comparable to one. The family ordering
still inverts -- usage is the least valuable family to remove from the design and by far the most
expensive to lose at serve.

## R6. The decision layer

| arm | standard-15 | delta | deep-18 | delta |
|---|---|---|---|---|
| **full design (26)** | **85.729** | -- | **90.704** | -- |
| knock-in **floor** (5 columns) | 84.458 | **-1.272** | 89.113 | **-1.592** |
| fam **availability** | 85.404 | -0.325 | 90.262 | -0.442 |
| fam **game context** | 85.536 | -0.193 | 90.465 | -0.240 |
| fam **ecr** | 85.537 | -0.192 | 90.463 | -0.242 |
| fam **usage** | 85.679 | **-0.051** | 90.645 | **-0.060** |
| fam **form** | 85.754 | **+0.025** | 90.750 | **+0.046** |
| LOO `season_line_pg` | 85.297 | -0.433 | 90.165 | -0.540 |
| serve-mask fam **form** | 82.860 | **-2.870** | 87.181 | **-3.523** |
| serve-mask fam **availability** | 83.957 | -1.773 | 88.608 | -2.096 |
| serve-mask fam **usage** | 84.057 | -1.672 | 88.666 | -2.038 |
| serve-mask fam **context** | 85.263 | -0.467 | 90.133 | -0.572 |
| serve-mask fam **level** | 85.342 | -0.388 | 90.297 | -0.408 |
| serve-mask fam **ecr** | 85.616 | -0.113 | 90.601 | -0.104 |

**The whole 21-column apparatus beyond the floor is worth ~1.3 points a lineup** (up from ~1.1 on the
25-column design), and the ordering by lineup regret is now **level (-0.43) > availability (-0.33) >
context (-0.19) ~ ecr (-0.19) > usage (-0.05) > form (+0.03)**, which still disagrees with both CRPS
tables. The `usage` family drop is the row D30 weighed: fractionally NEGATIVE here, where on the
25-column design it was fractionally positive -- the third of the three signals that turned.

## R7. Reproduce

```
node --import tsx scripts/weekly-contribution-ledger.mjs --plan
node --import tsx scripts/weekly-contribution-ledger.mjs --train  --out-dir <dir> --db <snapshot> --concurrency 24
node --import tsx scripts/weekly-contribution-ledger.mjs --verify --out-dir <dir>
node --import tsx scripts/weekly-contribution-ledger.mjs --score  --out-dir <dir> --db <snapshot> --concurrency 6
node --import tsx scripts/weekly-contribution-ledger.mjs --report --out-dir <dir>
```

`SHIPPED` in that driver is pinned to the served artifact's own feature list by
`test/weekly-contribution-ledger.test.ts`, so the next promotion fails that test rather than being
quietly measured at the old width -- which is how this rerun came to be scheduled at all.
