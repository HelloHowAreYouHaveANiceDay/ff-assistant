/**
 * Apply the fitted AGE CURVE to a projection.
 *
 * The rank curve knows nothing about WHO holds a rank: a 33-year-old back and a 25-year-old back
 * entering a season ranked RB8 get identical projections without this. The curve is a multiplier
 * fitted on the ratio of actual points to rank-predicted points by age -- see fit-age-curve.mjs.
 *
 * IT EARNED ITS PLACE BEFORE BEING BUILT. feature-value.mjs measured it out-of-sample, holding out
 * one season at a time AND controlling for position: +0.0154 R-squared over rank+position. The
 * position control was essential -- without it the same test inflates a sibling feature's value
 * threefold, because carries-vs-targets silently identifies position.
 *
 * READ THE CURVE CORRECTLY. It is a CHANGE curve (points relative to prior-year rank), not an
 * absolute-level aging curve. It declines monotonically from the early twenties, which is what an
 * absolute peak near 27 looks like in these units: a 23-year-old at a given rank is ascending and
 * beats it, a 30-year-old at the same rank is descending and misses it.
 *
 * MISSING AGE MEANS A MULTIPLIER OF 1, never a guess. A rookie or an unmatched name gets the
 * unadjusted rank projection -- the same answer as before this existed. Silently defaulting a
 * missing age to, say, the league mean would move projections for players we know nothing about.
 */

export interface AgeCurve {
  minAge: number;
  maxAge: number;
  pos: Record<string, Record<string, number>>;
  birthYear: Record<string, number>;
}

/** Multiplier for a player at `season`; 1 when age is unknown or the position is not fitted. */
export function ageFactor(curve: AgeCurve | null, name: string, pos: string, season: number): number {
  if (!curve) return 1;
  const by = curve.birthYear?.[name];
  if (!by) return 1;
  const age = season - by;
  if (!Number.isFinite(age)) return 1;
  const clamped = Math.min(curve.maxAge, Math.max(curve.minAge, age));
  const f = curve.pos?.[pos]?.[String(clamped)];
  return typeof f === "number" && f > 0 ? f : 1;
}

/** How many of `names` the curve can actually age -- for reporting coverage rather than assuming it. */
export function ageCoverage(curve: AgeCurve | null, names: string[]): { known: number; total: number } {
  if (!curve) return { known: 0, total: names.length };
  let known = 0;
  for (const n of names) if (curve.birthYear?.[n]) known++;
  return { known, total: names.length };
}
