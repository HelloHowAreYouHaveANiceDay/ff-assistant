/**
 * PER-PLAYER SEASON SPREAD -- the p10/p50/p90 band behind every projection.
 *
 * WHY THIS EXISTS. The board shows `ProjPts 319.2`, and that tenth of a point is a lie. We measured
 * the ceiling ourselves: seasonal projections explain 14-26% of within-position variance, and QB --
 * which sits at the top of the board where a dollar error is largest -- is the LEAST predictable
 * position at 7-15%. A point estimate presents a distribution as a scalar and invites the reader to
 * compare 319.2 against 288.4 as though the gap meant something. Usually it does not.
 *
 * WHY IT DOES NOT USE THE CORRELATED SIMULATOR, which is the surprising part and was verified rather
 * than assumed (scripts/verify-marginal.mjs, 200k draws). bootstrap.ts couples teammates with a
 * Gaussian copula, and the defining property of a copula is that it changes the JOINT distribution
 * while leaving every MARGINAL exactly as it was. Measured on a QB + his own WR + his own TE -- the
 * hardest-coupled case there is -- the realised per-player quantiles matched each player's own pool
 * to within 0.87% of his p10-p90 span, while the realised QB-WR correlation came back +0.336 against
 * a +0.347 target and cross-team QB-RB came back +0.002. So the coupling is real AND the marginals
 * are untouched.
 *
 * That makes resampling a player's own pool the EXACT answer, not a cheap approximation: running the
 * full correlated simulation would return the same distribution at many times the cost. The sim
 * remains required for everything JOINT -- P(A beats B) for teammates, team weekly totals, playoff
 * and title odds -- where the coupling is the entire point. Splitting the two is a statement about
 * which quantity is being asked for, not a latency compromise.
 *
 * WHAT THE BAND INCLUDES, because a reader will reasonably ask. The pools are real historical weekly
 * outcomes posted by players who entered a season at that positional rank, so they already carry the
 * zeros: torn ACLs, healthy scratches, benchings. A wide band therefore means "this rank has
 * historically produced a wide range of seasons", which is the honest reading. It does NOT include
 * our own projection error about which rank a player belongs at -- that is a separate and larger
 * uncertainty, and pretending otherwise would understate the true spread.
 */
import { prepare, type CorrelationModel, type PoolPlayer, type RankOutcomes, type Calibration } from "./bootstrap.js";

export interface Spread { p10: number; p50: number; p90: number }

/** Deterministic PRNG so a board build is reproducible; a band that moves between builds of the
 *  same data would be indistinguishable from a band that moved because the data changed. */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileOf(sorted: number[], u: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * u, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * The season-total distribution for one player: the sum of `weeks` independent draws from his pool.
 * Weeks are independent within a player -- the copula couples ACROSS players in a week, never a
 * player to his own next week -- so this is the correct convolution, not a simplification.
 */
export function seasonSpread(pool: number[], weeks: number, trials: number, rng: () => number): Spread | null {
  if (!pool.length || weeks <= 0 || trials <= 0) return null;
  const totals = new Array<number>(trials);
  for (let t = 0; t < trials; t++) {
    let s = 0;
    for (let w = 0; w < weeks; w++) s += pool[(rng() * pool.length) | 0];
    totals[t] = s;
  }
  totals.sort((a, b) => a - b);
  return {
    p10: Math.round(quantileOf(totals, 0.10) * 10) / 10,
    p50: Math.round(quantileOf(totals, 0.50) * 10) / 10,
    p90: Math.round(quantileOf(totals, 0.90) * 10) / 10,
  };
}

export interface SpreadInput { name: string; pos: string; team?: string; posRank: number; projPts: number }
export interface SpreadOptions { weeks?: number; trials?: number; seed?: number; calibration?: Calibration }

/**
 * Spreads for a whole board. Pools are CALIBRATED to each player's own projection (`prepare`'s
 * "scale" mode) so the band is centred on the number it annotates -- an interval whose median
 * disagreed with the ProjPts printed beside it would be worse than no interval, because a reader
 * would have no way to tell which of the two was wrong.
 *
 * prepare()'s [0.5, 2.0] guard still applies and still matters: a pool that would need rescaling
 * beyond that is a broken projection, not a modelling choice, and is left alone and REPORTED. Those
 * players get no band rather than a fabricated one.
 */
export function boardSpreads(
  players: SpreadInput[],
  outcomes: RankOutcomes,
  corr: CorrelationModel,
  opts: SpreadOptions = {},
): { spreads: Map<string, Spread>; uncalibrated: { name: string; pos: string; ratio: number }[] } {
  const weeks = opts.weeks ?? 17;
  const trials = opts.trials ?? 20000;
  const rng = mulberry32(opts.seed ?? 20260907);
  const pp: PoolPlayer[] = players.map((p) => ({
    name: p.name, pos: p.pos, team: p.team, rank: p.posRank,
    projPerGame: p.projPts > 0 ? p.projPts / weeks : undefined,
  }));
  // Correlation is passed through because prepare() builds the team groups, but those groups are
  // unused here -- only `pools` is read. Kept rather than stubbed so this shares ONE pool-building
  // and one calibration path with the simulator; two implementations of "what is this player's
  // pool" would be free to drift, and the band would stop describing the thing the sim samples.
  const prep = prepare(pp, outcomes, corr, opts.calibration ?? "scale");
  // NO BAND RATHER THAN A WRONG ONE. An uncalibrated pool is one the guard refused to rescale, so
  // its band would sit somewhere other than the ProjPts printed beside it -- and a median that
  // disagrees with the number it annotates is worse than a blank cell, because the reader cannot
  // tell which of the two to believe.
  //
  // Measured on the live board: 113 of 523, EVERY ONE with a ratio below 0.5, and they are backups
  // -- Flacco 0.42, Mariota 0.40, Klubnik 0.36. The rank join assumes a player will actually occupy
  // the rank he is joined on; a backup QB we project for 40 points is joined to pools posted by
  // players who really were QB30 and really played, so the raw band would show him a p50 near 200.
  // That is not a wide band, it is a different player's band. All 113 sit deep on the bench, so the
  // top of the board is unaffected.
  const skip = new Set(prep.uncalibrated.map((u) => u.name));
  const spreads = new Map<string, Spread>();
  for (const p of pp) {
    if (skip.has(p.name)) continue;
    const pool = prep.pools.get(p);
    if (!pool || !pool.length) continue;
    const s = seasonSpread(pool, weeks, trials, rng);
    if (s) spreads.set(p.name, s);
  }
  return { spreads, uncalibrated: prep.uncalibrated };
}
