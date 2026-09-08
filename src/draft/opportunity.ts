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
 *   RB +0.0186    WR +0.0148    TE +0.0218    QB +0.0051
 *
 * EACH POSITION IS SCORED ON ITS OWN COLUMNS, and the QB row above is a correction, not a refit.
 *
 * For twenty seasons every position was measured as `receiving first downs + target share`. A
 * quarterback has neither, so QB usage was in practice his scrambles: it measured -0.0014, and that
 * number was then written down as a fact about quarterbacks -- "QB has no target share, so nothing
 * should help there" -- used to leave QB flat, and finally hardened into a guard in models.ts that
 * REJECTED any QB amplitude above 0.15. A measurement that had never been connected to the right
 * column became a fact, then a rule enforcing that fact, and the guard's remaining job was to keep
 * the fix out.
 *
 * What a quarterback's workload actually is: pass attempts and rushing yards. Nested (inner-CV model
 * selection, scripts/qb-usage-probe.mjs) that scores +0.0035, and the inner loop picks the same pair
 * in 18 of 19 folds. The shipped pair scored -0.0060 on the same data, so the correction is worth
 * about 0.0095 at QB rather than 0.0035.
 *
 * THE SURVIVING NULL CONTROL, predicted before the run rather than read off after it: efficiency
 * should not persist while volume does -- `racr` came back negative for RB and WR. A run where
 * efficiency had won would have been a reason to distrust the harness, not a discovery. The OTHER
 * null control this file used to claim -- "QB should show nothing, and shows nothing" -- was not a
 * control at all. It predicted the result of a broken measurement and was confirmed by it, which is
 * the most expensive kind of agreement.
 *
 * THE FEATURES ARE RELATIVE TO THE RANK, which is what stops this double-counting the rank itself. A
 * WR5's raw target share is high BECAUSE he is a WR5, and that is already priced into his rank.
 * What carries new information is whether he saw more usage than players at his rank typically do,
 * so each feature is divided by its mean for that rank bucket and 1.0 means "exactly as expected".
 *
 * PER-POSITION AMPLITUDE, scaled to each position's own measured lift, for the reason the age curve
 * had to learn twice: a pooled result cannot say FOR WHOM, and an unscaled curve gave QB the widest
 * swing on the smallest signal. TE 100%, RB 85%, WR 68%, QB 24%.
 *
 * MISSING USAGE MEANS A MULTIPLIER OF 1, never a guess -- a rookie, or anyone under four games last
 * season, gets the unadjusted rank projection. That is the same rule the age curve uses for an
 * unknown birth date, and it is why this is safe to apply to the whole board.
 */

export interface OpportunityModel {
  bucket: number;
  maxRank: number;
  season: number;
  /** 2 = per-position feature sets. Absent or 1 = the old fd/ts-for-everyone shape, which measured a
   *  quarterback's workload with a receiver's columns; such a file is REJECTED rather than run down a
   *  legacy path, because a silently-degraded model is what this schema change exists to end. */
  schema?: number;
  features?: Record<string, string[]>;
  floor?: Record<string, number>;
  amplitude: Record<string, number>;
  pos: Record<string, { feats: string[]; b: number[]; mean: number; amp: number } | null>;
  players: Record<string, Record<string, number>>;   // "season|Name" -- fallback
  bySk?: Record<string, Record<string, number>>;     // "season|player_sk" -- preferred
  bucketMeans: Record<string, Record<string, Record<string, number>>>;
}

/** Below these a bucket's mean usage is ~0, and dividing by it produces a meaningless number rather
 *  than a large one. Mirrors FLOOR in fit-opportunity.mjs; the model carries its own copy so a refit
 *  with different floors cannot drift from the consumer. */
const DEFAULT_FLOOR: Record<string, number> = { fd: 0.05, ts: 0.005, attempts: 1.0, rushYards: 0.5 };

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
  // Each position reads ITS OWN features. QB is attempts + rushing yards; the pass catchers are first
  // downs + target share. Before this, every position was read as fd + ts, so a quarterback -- who
  // has neither -- was adjusted on his scrambles, measured at ~0, and that null shipped as a fact.
  const feats = p.feats;
  if (!Array.isArray(feats) || !feats.length || !Array.isArray(p.b) || p.b.length !== feats.length + 1) return 1;
  const floor = model.floor ?? DEFAULT_FLOOR;
  let val = p.b[0];
  for (let i = 0; i < feats.length; i++) {
    const c = feats[i];
    const mv = m[c], uv = u[c];
    // Guard the denominator: a bucket whose mean usage is at or below the floor makes the ratio
    // explode, and for a position/rank where nobody sees that kind of work it is meaningless rather
    // than large. A missing input contributes exactly 1 -- "as expected" -- never a guess.
    const rel = (uv != null && Number.isFinite(uv) && mv != null && mv > (floor[c] ?? 0)) ? uv / mv : 1;
    val += p.b[i + 1] * rel;
  }
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
