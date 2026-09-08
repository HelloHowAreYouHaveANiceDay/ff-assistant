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
  // KEYED "POS|Name". A name-only key merges distinct people who share one -- almost always father
  // and son in this data -- and it silently put the wrong birth year on 38 names, one of which
  // reached the live board (Antonio Williams the RB, born 1997, aged with the 2004 birth year of
  // Antonio Williams the WR: a 29-year-old scored as 22 and marked up 19.5%).
  //
  // No name-only fallback. Adding one would restore exactly the ambiguity this key removes, and a
  // missing entry already means a multiplier of 1 -- the same answer as before the curve existed,
  // which is the correct thing to do when we do not know who someone is.
  const by = curve.birthYear?.[`${pos}|${name}`];
  if (!by) return 1;
  const age = season - by;
  if (!Number.isFinite(age)) return 1;
  const clamped = Math.min(curve.maxAge, Math.max(curve.minAge, age));
  const f = curve.pos?.[pos]?.[String(clamped)];
  return typeof f === "number" && f > 0 ? f : 1;
}

/** How many of `names` the curve can actually age -- for reporting coverage rather than assuming it. */
export function ageCoverage(curve: AgeCurve | null, players: { name: string; pos: string }[]): { known: number; total: number } {
  if (!curve) return { known: 0, total: players.length };
  let known = 0;
  // Coverage must ask the SAME question ageFactor asks. It previously took bare names and counted
  // name-only hits, which would now report a coverage number the model cannot actually use -- the
  // classic shape of a check that measures something adjacent to the thing it claims to measure.
  for (const p of players) if (curve.birthYear?.[`${p.pos}|${p.name}`]) known++;
  return { known, total: players.length };
}
