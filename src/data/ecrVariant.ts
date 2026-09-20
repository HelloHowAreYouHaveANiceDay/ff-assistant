/**
 * WHICH EXPERT CONSENSUS LIST DOES THIS LEAGUE ACTUALLY PLAY UNDER?
 *
 * `ranking` held ONE consensus per player per season -- FantasyPros' `redraft-overall` -- and every
 * league read it. That is correct for a redraft, one-QB league and wrong for anything else, in a way
 * that is invisible because a rank is a rank: nothing about the number says which game it describes.
 *
 * MEASURED against the DynastyProcess archive (2026-09-20), redraft vs dynasty positional rank over
 * the top 12 at each position: **25.4% identical, mean |d| 3.02 ranks**, with exactly the signature
 * dynasty should have --
 *
 *     Travis Hunter (rookie)   redraft 31 -> dynasty 17
 *     Omarion Hampton (rookie) redraft 20 -> dynasty  9
 *     Tyreek Hill (31)         redraft 17 -> dynasty 33
 *     Davante Adams (32)       redraft 18 -> dynasty 34
 *     Christian McCaffrey (29) redraft  6 -> dynasty 16
 *
 * -- young players rise, veterans fall. And superflex is starker still: `redraft-overall` puts the
 * first QB at overall rank 25, `dynasty-op` puts Josh Allen at 1 with four QBs in the top five.
 *
 * WHAT THIS IS NOT FOR. The WEEKLY consensus (`ecr_wk_rank`) is a POSITIONAL rank, and positional
 * ordering is nearly format-independent: the same measurement over the startable range (top 12 per
 * position) gives **85.6% identical, mean |d| 0.17 ranks**, QB 0.08. Superflex changes what a QB is
 * WORTH, not which QB is better this week. So the weekly feature is left alone -- switching it would
 * be churn, and doing it naively would be worse than churn, because the superflex weekly list is an
 * OVERALL ranking and substituting it would silently redefine a fitted feature from "rank among WRs"
 * to "rank among everyone".
 *
 * WHY A SOURCE STRING RATHER THAN A NEW TABLE. `ranking`'s primary key is already
 * `(player_id, source, season)`, so variants coexist with NO schema change and the incumbent's rows
 * keep their exact source name and values. Partitioning the table by league would have been the
 * wrong axis anyway: two dynasty superflex leagues share a consensus, they do not each have one.
 */
import { slotEligibility } from "../draft/slots.js";

/** The source string for the baseline list. UNCHANGED, and deliberately not derived, so every
 *  existing row and every existing query keeps working byte-for-byte. */
export const ECR_SOURCE = "fantasypros_ecr";

export interface EcrVariant {
  /** The `page_type` to filter the FantasyPros feed on. */
  pageType: string;
  /** The `ranking.source` these rows are stored under. */
  source: string;
  /** True when this is the baseline redraft list (the incumbent path). */
  baseline: boolean;
  /** Present when the league's true variant is NOT published and this is a stated substitute. */
  caveat?: string;
}

/** Does this slot template start a QB anywhere other than the dedicated QB slot? */
export function isSuperflex(slots: readonly string[]): boolean {
  return slots.some((s) => {
    const u = String(s).trim().toUpperCase();
    if (u === "QB") return false;                       // the dedicated slot is not what makes it superflex
    return slotEligibility(u).includes("QB");
  });
}

/**
 * The consensus list for a league, from its type and its slots.
 *
 * FALLS BACK LOUDLY, NEVER SILENTLY. FantasyPros publishes `dynasty-op` (dynasty superflex) and
 * `weekly-op`, but the current feed carries NO redraft superflex list -- so a redraft superflex
 * league gets `redraft-overall` WITH a caveat naming what it is missing, rather than a number that
 * looks like it describes its format.
 */
export function ecrVariantFor(opts: { leagueType?: string | null; slots?: readonly string[] | null }): EcrVariant {
  const t = String(opts.leagueType ?? "").trim().toLowerCase();
  const dynastyish = t === "dynasty" || t === "keeper";
  const sf = isSuperflex(opts.slots ?? []);

  if (dynastyish && sf) return { pageType: "dynasty-op", source: `${ECR_SOURCE}:dynasty-op`, baseline: false };
  if (dynastyish) return { pageType: "dynasty-overall", source: `${ECR_SOURCE}:dynasty-overall`, baseline: false };
  if (sf) {
    return {
      pageType: "redraft-overall", source: ECR_SOURCE, baseline: true,
      caveat: "this league is SUPERFLEX but FantasyPros publishes no redraft superflex list in this feed " +
        "(only dynasty-op and weekly-op), so the consensus here is the ONE-QB redraft ranking -- which " +
        "puts the first QB around overall rank 25 where a superflex market puts him at 1.",
    };
  }
  return { pageType: "redraft-overall", source: ECR_SOURCE, baseline: true };
}
