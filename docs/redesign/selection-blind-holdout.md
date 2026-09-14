# Selection-blind holdout (rigor program WS2)

Companion to `experimentation-redesign.md` and `power-and-surrogate.md`. This is the correction for
the winner's curse `docs/validation.md` concedes but never applied: the feature screen and the
feature/lever gates saw ALL seasons, so every shipped-edge number was selected on all data.

## What "selection-blind" means here (the subtle part)

It constrains WHICH features/levers get CHOSEN, not what the models FIT.

- Models still fit strictly walk-forward. A fold for season Y trains on seasons `< Y`, which MAY
  include selection seasons. That is not selection leakage -- it is the normal point-in-time fit.
- The holdout block is blind only to the CHOICE. The screen filters its rows to the selection block;
  the admission verdict is decided on selection folds; a lever/config search's decision metric
  excludes the holdout. The held-out block is then scored ONCE as an honest confirmation.

## The one definition

`scripts/lib/holdout.mjs` is the single source of truth, read by every consumer. Do not retype the
range anywhere else.

- `HOLDOUT_SEASONS = [2021, 2022, 2023, 2024, 2025]` -- the canonical block (most recent ~5 seasons).
- `parseHoldout(spec)` -- override via `--holdout-seasons` (`"2021-2025"`, `"2020,2022"`, or a mix).
- `splitSeasons(all, holdout)` -- PURE, exhaustive partition into `{selection, holdout}`
  (selection ∪ holdout == all, disjoint; never invents a season absent from `all`).
- `assertSelectionBlind(selectionSeasons, holdout)` -- the load-bearing guard: throws if any holdout
  season leaked into a set a selection step is about to use.

## How each consumer excludes it

- **`scripts/feature-sweep.mjs`** -- filters the residual rows to the selection seasons BEFORE any
  candidate is scored, prints the split ("screening on 2007-2020; 2021-2025 held out"), and calls
  `assertSelectionBlind` on the screened seasons so a holdout season can never reach a Spearman test.
- **`scripts/admit-feature.mjs`** -- the nested CV still runs over all requested seasons (each fold
  walk-forward), but the per-season pinball maps are partitioned: the ADMIT/REJECT verdict
  (`admissionVerdict`, WS1's `2.9*SE` floor) is decided on the SELECTION seasons only, guarded by
  `assertSelectionBlind`; the held-out seasons are scored once as a separate CONFIRM line, reported
  not gated.
- **`scripts/cpcv.mjs`** -- adds a locked `--holdout-seasons` (default the block). The verdict-driving
  season-paired effect + PBO are computed on the SELECTION seasons only, and the CPCV paths are
  re-partitions of the selection seasons, so a config search cannot tune on the holdout. The holdout
  is quoted once as a PLAYOFFS CONFIRM (underpowered by construction, never gated) and recorded in the
  ledger (`holdout_seasons`, `selection_seasons`, `playoff_confirm_*`). Consistent with WS5's
  playoff-primary gate. The golden-master CONSISTENCY check stays on the FULL set on purpose: it is a
  reproducibility check that the dump matches the point backtest, not a selection decision.

## Verification

- `test/selection-holdout.test.ts` -- fault injection on the split/guard: a clean split passes; a
  holdout season fed into the selection set makes the guard THROW; the split is exhaustive; a custom
  override is still enforced. All pass.
- The runtime `assertSelectionBlind` guard is wired before any scoring (feature-sweep) or decision
  (admit-feature, cpcv), so the "screened rows / decision rows never include a holdout season"
  property is enforced, not merely asserted in a comment.
- ACCEPTANCE (heavy, not run in this workstream): re-run `admit-feature --candidate depth_rank_sep1`
  and record its selection DECISION verdict alongside its holdout CONFIRM number; re-run `cpcv.mjs`
  on a shipped edge and record the SELECTION effect vs the once-quoted holdout confirm. These are the
  WS6 re-validation numbers.
