/**
 * Apply the fitted OPPORTUNITY model to a projection.
 *
 * The rank curve knows the CONSENSUS view of a player and nothing about how he got his points. Two
 * receivers ranked WR20 are identical to it even when one drew 28% of his team's targets and the
 * other drew 15% and scored on broken plays. This is a multiplier fitted on the ratio of actual
 * points to rank-predicted points, against prior-season usage -- see scripts/fit-opportunity.mjs.
 *
 * IT EARNED ITS PLACE BEFORE BEING BUILT, and the pooled version of the test says NOTHING. Every
 * share feature lands within +/-0.0007 of a rank+position baseline when pooled, because one slope is
 * forced to mean the same thing for a back and a receiver -- position dummies move the intercept
 * only. Fitted and scored WITHIN each position, out of sample, one season held out at a time:
 *
 *   RB +0.0289    WR +0.0286    TE +0.0189    QB -0.0014
 *
 * Larger than the age curve's own per-position numbers, which are already shipped.
 *
 * TWO NULL CONTROLS, both predicted before the run rather than read off after it. QB has no target
 * share, so nothing should help there -- nothing does, and QB is left FLAT rather than fitted. And
 * efficiency should not persist while volume does -- `racr` came back negative for RB and WR. A run
 * where efficiency had won would have been a reason to distrust the harness, not a discovery.
 *
 * THE FEATURES ARE RELATIVE TO THE RANK, which is what stops this double-counting the rank itself. A
 * WR5's raw target share is high BECAUSE he is a WR5, and that is already priced into his rank.
 * What carries new information is whether he saw more usage than players at his rank typically do,
 * so each feature is divided by its mean for that rank bucket and 1.0 means "exactly as expected".
 *
 * PER-POSITION AMPLITUDE, scaled to each position's own measured lift, for the reason the age curve
 * had to learn twice: a pooled result cannot say FOR WHOM, and an unscaled curve gave QB the widest
 * swing on the smallest signal. RB 100%, WR 99%, TE 65%, QB flat.
 *
 * MISSING USAGE MEANS A MULTIPLIER OF 1, never a guess -- a rookie, or anyone under four games last
 * season, gets the unadjusted rank projection. That is the same rule the age curve uses for an
 * unknown birth date, and it is why this is safe to apply to the whole board.
 */

export interface OpportunityModel {
  bucket: number;
  maxRank: number;
  season: number;
  amplitude: Record<string, number>;
  pos: Record<string, { b0: number; bFd: number; bTs: number; mean: number; amp: number } | null>;
  players: Record<string, { fd: number; ts: number }>;   // "season|Name" -- fallback
  bySk?: Record<string, { fd: number; ts: number }>;     // "season|player_sk" -- preferred
  bucketMeans: Record<string, Record<string, { fd: number; ts: number }>>;
}

/** Clamp matching the fit: a linear model extrapolates without limit, and a 60% haircut on a
 *  player whose usage collapsed is a bet the data does not support. */
const LO = 0.75, HI = 1.25;

/**
 * Multiplier for one player at a given within-position rank.
 * `posRank` is 1-based -- the same rank the projection curve is being indexed at.
 */
export function opportunityFactor(model: OpportunityModel | null, name: string, pos: string, posRank: number, season: number, sk?: number | null): number {
  if (!model) return 1;
  const p = model.pos?.[pos];
  // Two distinct ways a position carries no opinion, and they are NOT the same code path:
  //   `null`   -- never fitted (too few cases, or a measured signal at or below zero)
  //   amp == 0 -- fitted but shrunk to nothing by its own measured lift
  // QB has moved between these as the sample grew: on 10 seasons it measured -0.0014 and was left
  // null; on 20 it measures slightly positive and ships with amplitude 0.05, i.e. a swing of about
  // one percent. So "QB is flat" is true in effect and false in mechanism, and a guard that only
  // handled `null` would silently stop protecting the moment a refit nudged a position off zero.
  if (!p || !(p.amp > 0)) return 1;
  // PRIOR season's usage, which is the only thing knowable before this season is played. Keying on
  // `season` itself would be lookahead -- it would project 2026 using 2026 usage, score beautifully
  // in any backtest, and be worthless in production. The key carries the year precisely so this
  // cannot be got wrong silently.
  // PREFER THE STABLE KEY, same rule as the age curve: bySk is keyed "season|player_sk" and decides
  // when present, with the name map as the fallback for players the registry does not know. The
  // season stays in both keys because usage is a per-season fact, unlike a birth year.
  const u = (sk != null ? model.bySk?.[`${season - 1}|${sk}`] : undefined) ?? model.players?.[`${season - 1}|${name}`];
  if (!u) return 1;                                    // no prior-season usage -> no opinion
  if (!Number.isFinite(posRank) || posRank < 1 || posRank > model.maxRank) return 1;
  const bucket = Math.floor((posRank - 1) / model.bucket);
  const m = model.bucketMeans?.[pos]?.[String(bucket)];
  if (!m) return 1;
  // Guard the denominators: a bucket whose mean usage is ~0 makes the ratio explode, and for a
  // position/rank where nobody sees targets that ratio is meaningless rather than large.
  const relFd = m.fd > 0.05 ? u.fd / m.fd : 1;
  const relTs = m.ts > 0.005 ? u.ts / m.ts : 1;
  const val = p.b0 + p.bFd * relFd + p.bTs * relTs;
  if (!Number.isFinite(val) || !(p.mean > 0)) return 1;
  const shape = Math.max(LO, Math.min(HI, val / p.mean));
  return 1 + (shape - 1) * p.amp;
}

/** How many of `names` the model can actually adjust for `season` -- reported, never assumed. */
export function opportunityCoverage(model: OpportunityModel | null, players: { name: string; sk?: number | null }[], season: number): { known: number; total: number } {
  if (!model) return { known: 0, total: players.length };
  let known = 0;
  for (const p of players) if ((p.sk != null && model.bySk?.[`${season - 1}|${p.sk}`]) || model.players?.[`${season - 1}|${p.name}`]) known++;
  return { known, total: players.length };
}
