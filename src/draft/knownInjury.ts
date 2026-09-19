/**
 * A KNOWN INJURY DESIGNATION, turned into simulated weeks missed.
 *
 * Commit 3 of docs/week-state-design-2026-09-18.md. NOT ENABLED BY DEFAULT -- it is a model change
 * and it is gated by the championship backtest (D13) and owner sign-off. Absent an episode map the
 * simulator is bit-identical to before.
 *
 * WHAT IS WRONG WITHOUT IT. `src/draft/season.ts` prices every remaining week of every rostered man
 * at `m.avail[tier]` -- a per-position, per-tier rate fitted as games/17 -- drawn INDEPENDENTLY each
 * week. Two properties, both wrong for a man with a designation:
 *
 *   UNCONDITIONAL. A tier-1 RB is 0.871 whether he is healthy or has been Out three weeks with a
 *   foot. `src/inseason/injuryHorizon.ts` records the comparison on men actually on the report:
 *   nested log loss 0.92 for the unconditional rate against 0.35 for the conditional model and 0.40
 *   for a designation-only baseline. The rate is not merely imprecise there, it is WORSE THAN A
 *   CONSTANT.
 *
 *   I.I.D. ACROSS WEEKS. Real injuries persist: a man who misses week 3 is far more likely to miss
 *   week 4. Independent weekly draws model transient absence, not an injury.
 *
 * WHY AN EPISODE AND NOT FOUR WEEKLY PROBABILITIES. The horizon model publishes a CUMULATIVE
 * statement -- P(he misses the next k games), k in 1..4 -- which is a survival curve. Converting it
 * to four independent per-week marginals and drawing them separately reproduces exactly the i.i.d.
 * error this exists to fix, while looking correct on the MEAN. The means are similar either way;
 * the VARIANCE is not, and playoff probability is made of variance. So one episode length is drawn
 * per trial, and the weeks it covers are missed together.
 *
 * BEYOND k=4 THE MODEL SAYS NOTHING, and the owner's decision (2026-09-19) is to EXTRAPOLATE rather
 * than fall back. The extrapolation is the empirical tail, not a parametric guess: `fact_injury_episode`
 * holds 11,285 real episodes, so the conditional hazard past four weeks is MEASURED from episodes
 * that reached four weeks, per injury group where there is enough of it. See `tailHazardFor`.
 *
 * IR IS MODELLED FROM THE DATA, NOT FROM THE RULEBOOK. An IR designation carries a league-rules
 * minimum, and those rules have changed repeatedly; reciting one from memory would be inventing a
 * constant. The empirical distribution of weeks missed after an IR designation answers the same
 * question and cannot be out of date relative to the seasons being simulated.
 */

/** P(miss >= k) for k = 1..4, as the horizon model publishes it. */
export type HorizonCurve = [number, number, number, number];

/**
 * The per-trial episode: which weeks this man misses, given his curve and one uniform draw.
 *
 * INVERSE-TRANSFORM ON THE SURVIVAL CURVE. `S[k-1]` is P(miss at least k). A single uniform u maps
 * to the largest k with u < S[k-1], so the draw respects the curve exactly and the weeks come out
 * CONTIGUOUS -- which is what an injury is.
 *
 * `tailHazard` continues past k=4: having already missed four, each further week is missed with
 * that probability. Geometric in the tail is a modelling choice and is stated as one; what makes it
 * defensible is that the hazard is MEASURED from real episodes rather than assumed.
 */
export function drawEpisodeLength(curve: HorizonCurve, u: number, tailHazard: number, maxWeeks: number): number {
  let k = 0;
  for (let i = 0; i < curve.length; i++) {
    if (u < curve[i]) k = i + 1; else break;
  }
  if (k < curve.length) return k;                 // resolved inside the model's own horizon
  // Past k=4: keep extending while the same uniform stays under the compounding tail survival.
  let survive = curve[curve.length - 1];
  while (k < maxWeeks) {
    survive *= tailHazard;
    if (u < survive) k++; else break;
  }
  return k;
}

/**
 * THE MEASURED TAIL. P(miss another week | already missed 4), from `fact_injury_episode`.
 *
 * Computed per injury group where the group has enough long episodes to say anything, and from the
 * pooled population otherwise. `minEpisodes` exists because a hazard fitted on three episodes is a
 * number with a decimal point rather than an estimate, and using it per-group would be worse than
 * using the pool.
 */
export function tailHazardFrom(
  episodes: { injury_group: string | null; weeks_missed: number | null }[],
  opts: { minEpisodes?: number } = {},
): { pooled: number; byGroup: Record<string, number>; n: number } {
  const minEpisodes = opts.minEpisodes ?? 40;
  const long = episodes.filter((e) => (e.weeks_missed ?? 0) >= 4);
  const hazardOf = (rows: typeof long): number | null => {
    if (rows.length < 2) return null;
    // Among episodes that reached 4 weeks, what share reached 5? That IS the conditional hazard.
    const reached5 = rows.filter((e) => (e.weeks_missed ?? 0) >= 5).length;
    return reached5 / rows.length;
  };
  const pooled = hazardOf(long) ?? 0.5;
  const byGroup: Record<string, number> = {};
  const groups = new Set(long.map((e) => e.injury_group ?? "").filter(Boolean));
  for (const g of groups) {
    const rows = long.filter((e) => (e.injury_group ?? "") === g);
    if (rows.length < minEpisodes) continue;      // too thin to beat the pool
    const h = hazardOf(rows);
    if (h != null) byGroup[g] = h;
  }
  return { pooled, byGroup, n: long.length };
}

/**
 * WHICH WEEKS A MAN MISSES THIS TRIAL, as a set of absolute week numbers.
 *
 * `fromWeek` is the first week the simulation prices -- the episode starts there, because the
 * designation is a statement about now. Returns an empty set for a man with no designation, which
 * is the overwhelming majority and the reason this is cheap.
 */
export function missedWeeks(
  curve: HorizonCurve | null, u: number, tailHazard: number, fromWeek: number, throughWeek: number,
): Set<number> {
  const out = new Set<number>();
  if (!curve) return out;
  const L = drawEpisodeLength(curve, u, tailHazard, Math.max(0, throughWeek - fromWeek + 1));
  for (let w = fromWeek; w < fromWeek + L && w <= throughWeek; w++) out.add(w);
  return out;
}
