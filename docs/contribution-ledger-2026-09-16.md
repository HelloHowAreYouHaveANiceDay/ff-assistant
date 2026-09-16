# Contribution ledger -- a leave-one-out ablation of the SEASON projector (M2f, 2026-09-16)

**Nothing here is shipped.** No default feature list, trainer default, lever or artifact changed.
`tools/train_projection.py` is byte-for-byte untouched (`git diff tools/train_projection.py` is empty --
the comma-list `--remove-features` this study needs has been there since the flag was added). Both
databases were read-only; every fold artifact and cache went to a scratch dir.

## The question nobody had asked

Every feature in the projector's default lists was admitted one at a time, against the baseline of its
own day. The symmetric question -- *what does each shipped feature still contribute TODAY, given every
other shipped feature?* -- has been asked exactly once in this repo's history (`contract_year`,
2026-09-14, leave-one-out contribution +0.0039 vs floor 0.0100, DROPPED). This is that question asked
of the whole design.

## What is actually in the default fit (enumerated from the trainer, not the docs)

`tools/train_projection.py` fits **eleven** features by default:

| list | features | position gate (`RATIO_ALLOWED`) |
|---|---|---|
| `RATIO_FEATURES` | `prior_fd`, `prior_ts` | RB/WR/TE |
| | `prior_attempts`, `prior_rush_yards` | QB |
| | `fftoday_proj` | all |
| `CENTER_FEATURES` | `age`, `prior_games`, `draft_round`, `prior_pos_rank`, `depth_rank_sep1` | all |
| `INDICATOR_FEATURES` | `team_changed` | all |

Confirmed against the shipped `data/projection-artifact.json` (`coef.QB.mean` carries exactly these
keys, with `prior_fd`/`prior_ts` pinned at 0.0 by the gate).

> **DOC CORRECTION (worth fixing separately).** `docs/feature-frontier.md` opens by saying the
> projector "fits a small set of prior-season workload-share features (`prior_snap_share`,
> `prior_route_share`, `prior_carries_per_game`, `prior_carry_share`, `prior_air_yards_share`,
> `prior_wopr`, `depth_rank_sep1`, `adp`, `adp_vs_ecr`, `rookie_draft_pick`; indicator
> `team_changed`)". **Only `depth_rank_sep1` and `team_changed` of that list are fitted.** The other
> nine are `EXT_CENTER` candidates -- declared, never admitted (the trainer's own comment says so:
> "NONE is fitted by default"). Anyone reading the frontier page to decide "have we exhausted the
> features?" is reading a list of nine features the model does not have.

## Method

- One script version for every arm. `scripts/contribution-ledger.mjs` (new, read-only) drives
  `scripts/admit-feature.mjs --remove` as a subprocess, once per arm; the verdict, the 2.9*SE floor
  (WS1) and the selection/holdout split (WS2) are the existing code, not a second implementation.
- Window `2013-2025` (the ext table's canonical range, because `depth_rank_sep1` is an ext column).
  **DECISION block 2013-2020 (8 seasons); CONFIRM block 2021-2025, quoted once, never gating.**
- Metric: mean trained-rung **pinball** (`score().crps`, the p10/p50/p90 average) per held-out season,
  nested-CV, trainer re-run blind per fold. `contribution = pinball(without) - pinball(with)`, so a
  **positive** number means removing the feature HURTS -- the feature earns its place.
- **The full-default arm is identical for every row**, so it is fitted once and served from a new
  `--baseline-cache` (keyed on db + season list + scored position -- everything that can change it and
  nothing that cannot). This halves the cost; a cache hit is byte-identical to the run it replaces.
- Family-wide **BH FDR (WS4)** across the eleven pooled LOO rows -- eleven simultaneous keep/drop tests
  against one shared baseline is a family, and the per-row floor controls each test in isolation only.
- A row whose two arms are identical on every decision season exits 3 and is reported **DEGENERATE**,
  never as a zero. (No arm in this study was degenerate; the guard was exercised in the unit test.)

### Positive controls (charter rule 4 / checklist item 3)

1. **The ledger can return KEEP.** `fftoday_proj` leave-one-out returns **KEEP, +0.4491 +/- 0.0570,
   8/8 seasons, floor 0.1653, holdout +0.2438 confirmed**. A page of DROPs is exactly what a
   disconnected harness produces, so this is the row that makes the rest a measurement.
2. **A FAMILY arm really removes every member.** Fitted one artifact directly with
   `--remove-features age,draft_round`: the emitted `coef.QB.mean` keys lost **both** `age` and
   `draft_round` (and nothing else). The comma list was not assumed to work; it was checked on the
   producer's own bytes.
3. **DEGENERATE is reachable and distinguishable.** `test/contribution-ledger.test.ts` fault-injects a
   degenerate dump and asserts it does not read as a DROP.
4. **The `--baseline-cache` does not change a single number.** Re-ran the `age` row with NO cache, so
   both arms were fitted fresh: the 26 per-season pinball values (13 base, 13 candidate) are **bitwise
   identical** to the cached run's, and the verdict matches to 17 significant figures
   (+0.050782076745133686 +/- 0.026097018683256177, 5/8 both). A cache that silently served a
   different model would corrupt every row and look exactly like a result, so this was checked rather
   than argued.

## 1. THE LEAVE-ONE-OUT LEDGER (ESPN incumbent, `data/ff.db`)

Pinball on the decision block, full design = **11.933** pooled over 2013-2020.

| feature | contribution +/- SE | floor (2.9*SE) | wins | verdict | BH q (n=11) | holdout 2021-2025 | confirmed |
|---|---|---|---|---|---|---|---|
| `fftoday_proj` | **+0.4491 +/- 0.0570** | 0.1653 | 8/8 | **KEEP** | 0.000 | +0.2438 | **yes** |
| `prior_pos_rank` | +0.0926 +/- 0.0433 | 0.1255 | 6/8 | DROP | 0.089 | +0.1012 | no |
| `team_changed` | +0.1102 +/- 0.0705 | 0.2043 | 6/8 | DROP | 0.162 | +0.1108 | **yes** |
| `prior_rush_yards` | +0.0760 +/- 0.0549 | 0.1592 | 6/8 | DROP | 0.183 | +0.0972 | no |
| `draft_round` | +0.0620 +/- 0.0604 | 0.1751 | 4/8 | DROP | 0.279 | +0.0172 | no |
| `age` | +0.0508 +/- 0.0261 | 0.0757 | 5/8 | DROP | 0.095 | +0.0615 | no |
| `prior_fd` | +0.0387 +/- 0.0602 | 0.1746 | 5/8 | DROP | 0.390 | -0.0221 | no |
| `prior_games` | +0.0259 +/- 0.0452 | 0.1310 | 5/8 | DROP | 0.390 | +0.0194 | no |
| `depth_rank_sep1` | -0.0012 +/- 0.0194 | 0.0562 | 4/8 | DROP | 0.642 | **+0.1386** | **yes** |
| `prior_attempts` | -0.0241 +/- 0.0101 | 0.0293 | 2/8 | DROP | 0.991 | +0.0008 | no |
| `prior_ts` | -0.0290 +/- 0.0514 | 0.1491 | 4/8 | DROP | 0.785 | -0.0182 | no |

**Position-gated rows re-scored on their own position** (a QB-only feature is diluted ~4x in the pool;
`admit-feature --pos QB`, a different scoring subset, so these are NOT members of the BH family above):

| feature | pos | contribution +/- SE | floor | wins | verdict | holdout | confirmed |
|---|---|---|---|---|---|---|---|
| `prior_rush_yards` | QB | +0.2835 +/- 0.1480 | 0.4293 | 4/8 | DROP | +0.1161 | no |
| `prior_attempts` | QB | -0.1392 +/- 0.0643 | 0.1864 | 2/8 | DROP | +0.0383 | no |

**Reading.** One feature of eleven clears the floor, and it clears it by 2.7x with a perfect 8/8 season
record and a confirmed holdout. The other ten are, individually, **inside the noise of this evaluation**
-- eight positive, two negative, none resolvable. After the BH adjustment only `fftoday_proj` survives
at any sane FDR (q = 0.000; the next best is q = 0.089).

`prior_attempts` is the only row whose sign is negative on BOTH blocks' direction of interest and whose
own position scoring is also negative (-0.139 QB): the model is very slightly better without it. It is
still inside the floor (abs(-0.139) < 0.186), so this is "no measurable contribution", **not** "measurably
harmful" -- the distinction matters and the ledger will not be read as making the stronger claim.

## 2. THE LEAVE-FAMILY-OUT LEDGER

Families are a partition of the eleven defaults, taken from the trainer's own grouping:

| family | members |
|---|---|
| market anchor | `fftoday_proj` (singleton -- `adp` / ECR-derived columns are candidates, not defaults) |
| prior production (the rank-bucket ratios) | `prior_fd`, `prior_ts`, `prior_attempts`, `prior_rush_yards` |
| rank + availability | `prior_pos_rank`, `prior_games` |
| roster context | `depth_rank_sep1`, `team_changed` |
| age + pedigree | `age`, `draft_round` |

| family | joint contribution +/- SE | floor | wins | verdict | holdout | confirmed | sum of members' LOO | joint - sum |
|---|---|---|---|---|---|---|---|---|
| market anchor | **+0.4491 +/- 0.0570** | 0.1653 | 8/8 | **KEEP** | +0.2438 | **yes** | +0.4491 | 0 (singleton) |
| rank + availability | +0.1956 +/- 0.0753 | 0.2185 | 6/8 | DROP | +0.0940 | no | +0.1184 | **+0.0772** |
| age + pedigree | +0.1315 +/- 0.0571 | 0.1656 | 7/8 | DROP | +0.1882 | no | +0.1128 | +0.0187 |
| roster context | +0.0866 +/- 0.0735 | 0.2131 | 5/8 | DROP | **+0.2776** | **yes** | +0.1090 | -0.0224 |
| prior production | **-0.0330 +/- 0.0845** | 0.2451 | 3/8 | DROP | **-0.0401** | no | +0.0615 | **-0.0945** |

### Redundancy notes

- **`rank + availability` masks itself (+0.077).** The joint effect exceeds the sum of the two members'
  individual effects: `prior_pos_rank` and `prior_games` substitute for one another, so each
  leave-ONE-out understates its own family's worth. This is the classic masking pattern, and it is the
  reason a LOO table alone can never license dropping a *pair*.
- **`prior production` is the opposite, and it is the study's biggest finding.** Summing the four
  members' LOO gives +0.062; removing all four TOGETHER gives **-0.033 on the decision block and
  -0.040 on the holdout, winning only 3 of 8 seasons.** The four rank-bucket ratios are mutually
  redundant AND jointly redundant with the market anchor: once `fftoday_proj` is in the design, an
  independent human projection has already priced the player's prior volume, and re-deriving it from
  four ratio columns adds nothing the evaluation can see.
- `age + pedigree` and `roster context` are additive to within their own SEs -- no interaction.
- Sum of all eleven LOO contributions = **+0.851**, against a full-design pinball of 11.933. So the
  entire fitted feature set is worth ~7% of the loss on top of the rank curve, and **53% of that is one
  external projection column**.

## 3. PER-ERA: the decision block, the holdout, and the per-season signs

`+` = removing the feature hurt that season (it earned its place); `-` = the model was better without
it; `0` = the two arms were identical for that season only (`depth_rank_sep1` has no 2013 coverage).

| arm | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `fftoday_proj` | + | + | + | + | + | + | + | + | + | + | + | + | + |
| `prior_pos_rank` | - | + | + | + | + | + | + | - | + | + | + | + | - |
| `age` | - | + | + | + | + | - | + | - | - | + | - | - | + |
| `prior_games` | + | + | - | + | + | + | - | - | + | + | + | + | - |
| `draft_round` | - | - | + | + | + | - | + | - | - | + | - | + | + |
| `depth_rank_sep1` | 0 | + | + | + | - | + | - | - | **+** | **+** | **+** | **+** | **+** |
| `team_changed` | + | + | - | + | + | - | + | + | **+** | **+** | **+** | **+** | **+** |
| `prior_fd` | - | + | + | + | + | + | - | - | - | + | - | + | + |
| `prior_ts` | - | + | - | + | + | - | + | - | - | - | - | + | + |
| `prior_attempts` | - | + | - | - | + | - | - | - | - | + | - | - | + |
| `prior_rush_yards` | - | + | + | + | + | + | - | + | - | + | - | + | + |
| `prior_attempts` [QB] | - | - | - | - | - | + | - | + | - | + | + | - | + |
| `prior_rush_yards` [QB] | - | - | - | + | + | - | + | + | - | + | + | - | + |
| fam prior-production | - | + | - | + | - | + | - | - | - | - | - | + | + |
| fam rank-availability | + | + | + | + | + | + | - | - | - | - | + | + | - |
| fam roster-context | + | + | - | + | + | - | + | - | + | + | + | + | + |
| fam age-pedigree | - | + | + | + | + | + | + | + | + | + | - | + | + |

**A REGIME FLIP, and it is the same shape as `prior_vol_cv` / `hist_ppg_w`.** Two roster-context
features are **null on the decision block and confirmed on the holdout**:

- `depth_rank_sep1`: -0.0012 (4/8) on 2013-2020, **+0.1386, 5/5, floor 0.1046, confirmed** on 2021-2025;
- `team_changed`: +0.1102 (6/8) on 2013-2020, **+0.1108, 5/5, confirmed** on 2021-2025;
- and jointly, the roster-context family: +0.0866 (5/8) decision, **+0.2776, 5/5, confirmed** holdout.

The per-season strip shows this is not an averaging artifact: both are `+` in every one of the five
recent seasons and mixed before 2019. Whatever changed -- depth-chart data quality, or the rise in
real player movement -- the roster-context pair is doing work now that it was not doing in the 2010s.
**This is a reason to KEEP both, not to drop them**, and the holdout may not promote a decision the
selection block did not make, so it is recorded as a regime observation, not a verdict.

Conversely `prior production` is the only family that is `-` more often than `+` in BOTH eras
(decision 3/8, holdout 2/5) -- a consistent, sub-floor nothing.

## 4. THE YAHOO CONTRAST

Same script, same window, same split, `--db data/formats/sc-a845f67652fb/features.db` (full PPR, TE
1.5, 6-pt pass TD, milestones, first downs, 40+ bonuses). The market-anchor family plus the two other
biggest ESPN contributors. Yahoo points are ~1.4x the ESPN scale, so the **relative** column is the
one to compare: decision-block pinball is **16.335** (Yahoo) vs **11.933** (ESPN).

| feature | YAHOO contribution +/- SE | floor | wins | verdict | % of Yahoo pinball | ESPN contribution | % of ESPN pinball |
|---|---|---|---|---|---|---|---|
| `fftoday_proj` (market anchor) | **+0.5698 +/- 0.0941** | 0.2729 | 8/8 | **KEEP** | **3.49%** | +0.4491 | **3.76%** |
| `prior_pos_rank` | +0.0527 +/- 0.0537 | 0.1557 | 7/8 | DROP | 0.32% | +0.0926 | 0.78% |
| `team_changed` | +0.0366 +/- 0.0328 | 0.0950 | 5/8 | DROP | 0.22% | +0.1102 | 0.92% |

Yahoo holdout (quoted once): `fftoday_proj` +0.1884 (3/5, floor 0.4390) -- positive but **not
confirmed**, and notably weaker than its own decision block; `prior_pos_rank` +0.0476 (2/5),
`team_changed` +0.0937 (3/5), neither confirmed.

**The contrast IS the finding: the same family carries both models, in the same proportion.** The
market anchor is 3.5-3.8% of the loss under both rulesets and 8/8 seasons under both; everything else
is inside the floor under both. This is the third independent result pointing the same way as M1 (18
Yahoo screens, zero ADMITs, ESPN residual structure nearly identical): **the Yahoo projector is not a
different model with different drivers, it is the same model at a different scale.**

Two honest caveats, neither of which changes the reading:

- **The Yahoo `fftoday_proj` is a scaling approximation.** FFToday publishes its own (roughly half-PPR)
  projection; the ratio-to-rank-bucket transform divides the scale out, which is why it still works.
  M1 already flagged this. That it remains the single strongest feature under a *different* scoring
  system is evidence the signal is the projector's JUDGEMENT, not its units.
- **`+0.5698 +/- 0.0941, 8/8, floor 0.2729` reproduces M1's recorded number to four decimals**, from a
  different session, a different driver and a fresh fold set. That is a cross-session reproducibility
  check I did not plan and will take: the harness is deterministic.

## 5. Plain reading

**Which family carries the model: the market anchor, alone, and it is not close.** `fftoday_proj`
contributes +0.4491 pinball of a +0.851 total across all eleven defaults -- **53% of everything the
fitted features add on top of the rank curve** -- with the only perfect 8/8 season record, the only
confirmed holdout, and the only BH-surviving q (0.000 vs 0.089 for the runner-up). Under the Yahoo
ruleset it is the same 3.5% of the loss. The projector is, to a first approximation, *the point-in-time
rank curve plus one external human projection*, with nine or ten columns of decoration.

**What is a DROP candidate, and what its holdout says.** Exactly one, and it is a FAMILY, not a
feature: the four rank-bucket prior-production ratios **`prior_fd`, `prior_ts`, `prior_attempts`,
`prior_rush_yards`**, removed together, cost **-0.0330 +/- 0.0845 on the decision block (3/8 seasons)
and -0.0401 on the holdout (2/5)** -- negative on BOTH blocks, i.e. the model was fractionally *better*
without them, in both eras, with no season-level consistency either way. That is the cleanest
"carrying weight for nothing" signal in the ledger.

Three things must be said plainly before anyone acts on it:

1. **This is a JOINT selection.** I am proposing one drop of four columns measured together, not four
   independent drops; the individual LOO rows do NOT support dropping any single member (their sum is
   +0.062 -- the masking runs the other way inside this family). Re-measuring any subset is a new
   comparison against a new baseline.
2. **The effect is inside the floor** (|-0.033| << 0.245). The honest claim is "no measurable
   contribution", not "harmful". The case for dropping is WS1's own logic -- the same logic that
   dropped `contract_year` -- that a grandfathered sub-floor column is exactly what the floor exists to
   catch; it is not a case that accuracy improves.
3. **It is a model change and needs owner sign-off + the D13 playoff gate** before it goes anywhere
   near `RATIO_FEATURES`. Nothing was changed here.

**Two features should explicitly NOT be dropped despite a DROP verdict.** `depth_rank_sep1` (-0.0012
decision) and `team_changed` (+0.1102 decision) are both **confirmed on the holdout** (+0.1386 and
+0.1108, 5/5 seasons each; jointly +0.2776, 5/5), and the per-season strip shows `+` in all five recent
seasons for both. This is a REGIME SPLIT of the same shape as `prior_vol_cv` and `hist_ppg_w`: null in
the 2010s, real now. The holdout may not promote a decision the selection block did not make, so this
is recorded, not acted on -- but it is a positive reason to leave the roster-context pair alone, and a
candidate for a re-gate on a later decision window.

**Where feature engineering has headroom -- and the ledger's answer is "not here".** Eleven fitted
features, ten of which cannot be resolved from noise on eight decision seasons; ~30 screened candidates
over three sessions, all REJECT; and the one feature that works is *someone else's projection*. Two
readings follow:

- **The season-projection surface is saturated at this power.** The floor on 8 decision seasons is
  0.06-0.25 pinball, which is 0.5-2% of the loss; anything smaller than that is unmeasurable here no
  matter how real it is. Adding a twelfth column has a poor prior AND an untestable one. If more
  projection accuracy is genuinely wanted, the lever with leverage is **more external judgement**
  (a second projection source, the way `fftoday_proj` was rung 7) or **more decision seasons**, not
  another derived usage share.
- **The headroom the repo already suspects is elsewhere.** `docs/feature-frontier.md` ends with "the
  likely remaining edge is in the DECISION/roster-construction layer", M1 ends with "the VALUE and
  DECISION layer, not the projector", and this ledger is the third measurement agreeing: the projector
  has one real input and the rest is decoration. Feature work on the season projector should be
  considered closed until either the power or the input class changes.

## Reproduce

```
node --import tsx scripts/contribution-ledger.mjs --arms <spec.json> --out <scratch-dir>
# one row, directly:
node --import tsx scripts/admit-feature.mjs --candidate depth_rank_sep1 --remove --seasons 2013-2025
# a FAMILY row (the trainer's --remove-features has always taken a comma list):
node --import tsx scripts/admit-feature.mjs --candidate prior_fd,prior_ts,prior_attempts,prior_rush_yards --remove --seasons 2013-2025
```
