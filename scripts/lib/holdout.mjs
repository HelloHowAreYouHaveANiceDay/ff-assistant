// THE ONE SELECTION-BLIND HOLDOUT DEFINITION (rigor program WS2).
//
// WHY THIS EXISTS. The feature screen and the admission/lever gates saw ALL seasons, so every
// shipped-edge number was "selected on all data" -- the winner's curse docs/validation.md concedes
// ("expect roughly half") but never corrected. This module quarantines a block of seasons that NO
// selection step may look at. It is used ONCE, afterwards, to confirm.
//
// WHAT "SELECTION-BLIND" MEANS, precisely, because it is subtle: it constrains WHICH features/levers
// get CHOSEN, not what the models FIT. Models still fit strictly walk-forward (a fold for season Y
// trains on seasons < Y, which MAY include selection seasons -- that is NOT selection leakage). The
// holdout is blind only to the CHOICE: the screen filters its rows to the selection block, the
// admission verdict is decided on selection folds, and a lever/config search's decision metric
// excludes the holdout. The holdout number is then quoted once as the honest confirmation.
//
// DRY: defined here and read everywhere (scripts/feature-sweep.mjs, scripts/admit-feature.mjs,
// scripts/cpcv.mjs, test/selection-holdout.test.ts). Do not retype the range anywhere else.

/** The canonical holdout block: the most recent ~5 seasons. Override with parseHoldout(spec). */
export const HOLDOUT_SEASONS = [2021, 2022, 2023, 2024, 2025];

/**
 * Parse a `--holdout-seasons` override into an explicit, sorted, de-duplicated season list.
 * Accepts "2021-2025" (inclusive range), "2021,2022,2025" (list), or a mix "2019,2021-2023".
 * A null/empty spec returns a copy of the canonical HOLDOUT_SEASONS.
 */
export function parseHoldout(spec) {
  if (spec == null || String(spec).trim() === "") return [...HOLDOUT_SEASONS];
  const out = [];
  for (const part of String(spec).split(",")) {
    const p = part.trim();
    if (!p) continue;
    const rng = p.split("-").map(Number);
    if (rng.length === 2 && Number.isFinite(rng[0]) && Number.isFinite(rng[1])) {
      for (let y = Math.min(rng[0], rng[1]); y <= Math.max(rng[0], rng[1]); y++) out.push(y);
    } else if (Number.isFinite(rng[0])) {
      out.push(rng[0]);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * PURE partition of a season list into { selection, holdout }. Exhaustive by construction --
 * selection ∪ holdout == all, and the two are disjoint -- because it partitions `all` by membership
 * in `holdout` (a season not present in `all` cannot appear on either side). This is the primitive
 * the guard and every consumer split through, so the split can never be done a second, different way.
 */
export function splitSeasons(all, holdout = HOLDOUT_SEASONS) {
  const hs = new Set(holdout);
  const selection = [], held = [];
  for (const y of all) (hs.has(y) ? held : selection).push(y);
  return { selection, holdout: held };
}

/**
 * THE LOAD-BEARING GUARD. Throws if any holdout season leaked into a set that a selection step is
 * about to use. A screen or a decision that quietly included a holdout season looks exactly like one
 * that did not -- both just print numbers -- so this is the only thing that distinguishes "blind" from
 * "not connected". Call it on the screened rows' seasons and on the admission DECISION seasons.
 */
export function assertSelectionBlind(selectionSeasons, holdout = HOLDOUT_SEASONS) {
  const hs = new Set(holdout);
  const leak = [...new Set(selectionSeasons)].filter((y) => hs.has(y));
  if (leak.length) {
    throw new Error(
      `selection-blind violated: holdout season(s) ${leak.sort((a, b) => a - b).join(", ")} ` +
      `present in the selection set (holdout = ${[...hs].sort((a, b) => a - b).join(", ")}). ` +
      "A selection step must never see the holdout block.",
    );
  }
  return true;
}
