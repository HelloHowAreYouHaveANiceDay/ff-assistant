/**
 * BOOTSTRAP weekly sampling with CORRELATED NFL teammates.
 *
 * Two changes from the parametric sampler this replaces, one of which matches the reference
 * implementation and one of which goes past it.
 *
 * 1. BOOTSTRAP, joined on preseason positional rank. A player projected as the RB5 draws real weekly
 *    outcomes posted by players who entered a season ranked RB5 -- busts, injuries and league-winners
 *    in their historical proportions. This is what ffsimulator does (its source merges rankings to
 *    outcomes `by = c("pos","rank")` and resamples with replacement), and it subsumes three separate
 *    hand-tuned mechanisms at once: the weekly distribution shape, projection error, and availability.
 *    A fitted lognormal cannot produce the atom at exactly 0 that a torn ACL puts in the record.
 *
 * 2. CORRELATED TEAMMATES -- which ffsimulator does NOT do. Its resampling is per player
 *    (`sample(.SD$week_outcomes[[1]], ...)` inside a per-player group), so a QB and his own WR boom
 *    independently. We impose the measured correlation with a GAUSSIAN COPULA: draw correlated
 *    normals, map them to uniforms, and read each player's own bootstrap pool at that quantile. The
 *    marginal distribution is therefore EXACTLY the bootstrap pool -- correlation is added without
 *    distorting any player's own distribution, which is the property that makes a copula the right
 *    tool rather than, say, scaling correlated noise onto the scores.
 *
 * WHY A MATRIX AND NOT A SINGLE FACTOR. Measured on 13,469 team-weeks of our own history
 * (scripts/fit-correlation.mjs, residualised so it captures within-team co-movement rather than
 * "good offenses score more"): QB-WR +0.348, QB-TE +0.223, QB-RB +0.080, K-DST +0.227, and
 * WR-TE/RB-WR/RB-TE all indistinguishable from zero. A one-factor model cannot fit that: it would
 * force WR-TE positive whenever both load on the QB, and it cannot produce K-DST +0.227 alongside
 * QB-DST +0.010. The structure is really two separate mechanisms -- passing volume lifts a QB and his
 * receivers while target share stays zero-sum between the receivers, and a blowout helps a kicker and
 * a defense together. So the pairwise matrix is built per team group and Cholesky-decomposed.
 */

/**
 * SCHEMA 2 -- pools of whole player-SEASONS, not a flat bag of weeks.
 *
 * Schema 1 stored `pos[POS][rank] = number[]`, every week from every player-season at that rank
 * poured into one array, and the simulator drew weeks from it independently. Measured on
 * data/history-weekly.csv, that understates SEASON-TOTAL dispersion by 1.6-2.8x at every position
 * and rank (RB1 empirical sd 108 vs iid 47; QB5 86 vs 35; TE3 53 vs 27), because a player-season is
 * not a set of independent weeks. It carries persistent state -- a season-ending injury, a bust, a
 * breakout -- and independent draws average exactly that away.
 *
 * The consequences were all in the direction of false confidence: spread.ts bands were about half
 * their true width, every title and playoff probability out of season.ts was over-confident, and
 * depth was therefore under-priced. season.ts even drops `projSd` in bootstrap mode on the grounds
 * that the pool already carries projection error -- it carries it PER WEEK, which is not the same
 * claim, and the two together compounded the understatement.
 */
export interface RankOutcomes { schema?: number; pos: Record<string, Record<string, number[][]>> }
export interface CorrelationModel { pairs: Record<string, number> }

/** One player-season: the weeks his team played, in order, with a 0 where he did not appear. */
export interface Trajectory { weeks: number[]; total: number }

export const TRAJECTORY_SCHEMA = 2;

/**
 * A schema-1 file must be REFUSED, not read leniently.
 *
 * Its inner arrays are numbers where schema 2 has arrays, so a tolerant reader would see each WEEK
 * as a one-week season: every trajectory length 1, season totals equal to single weekly scores, and
 * a season-total distribution roughly 4x too narrow -- i.e. the exact bug this schema exists to fix,
 * silently reintroduced by the file rather than by the code, with nothing failing.
 */
export function assertTrajectorySchema(o: RankOutcomes): void {
  if (Number(o?.schema) === TRAJECTORY_SCHEMA) return;
  throw new Error(
    "data/rank-outcomes.json is schema " + (o?.schema ?? 1) + ", which stores a FLAT bag of weekly " +
    "scores per rank. The simulator now resamples whole player-SEASONS, because drawing weeks " +
    "independently understates season-total spread by 1.6-2.8x. Refit with:  " +
    "node --import tsx scripts/fit-bootstrap.mjs",
  );
}

/** Correlation between two positions on the same NFL team; 0 when unmeasured or below noise. */
export function pairCorr(model: CorrelationModel, a: string, b: string): number {
  if (a === b) return 1;
  return model.pairs[`${a}-${b}`] ?? model.pairs[`${b}-${a}`] ?? 0;
}

/**
 * Cholesky decomposition with a SHRINKAGE REPAIR.
 *
 * A matrix assembled from independently-measured pairwise correlations is not guaranteed positive
 * semi-definite, and a failed decomposition must not silently become garbage. On failure the
 * off-diagonals are shrunk toward zero and it retries; at worst it converges to the identity, i.e.
 * to independent draws -- degrading to the behaviour we are replacing rather than to nonsense.
 */
export function cholesky(m: number[][]): number[][] {
  const n = m.length;
  for (let shrink = 0; shrink <= 10; shrink++) {
    const f = 1 - shrink * 0.1;
    const a = m.map((row, i) => row.map((v, j) => (i === j ? v : v * f)));
    const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = a[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (s <= 1e-9) { ok = false; break; }
          L[i][i] = Math.sqrt(s);
        } else {
          L[i][j] = s / L[j][j];
        }
      }
    }
    if (ok) return L;
  }
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 on erf). Maps a correlated normal to a uniform. */
export function normalCdf(z: number): number {
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** The empirical quantile of a SORTED pool. This is what keeps the marginal exactly the bootstrap. */
export function quantile(sorted: number[], u: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(u * sorted.length)));
  return sorted[i];
}

export interface PoolPlayer { name: string; pos: string; team?: string; rank: number; projPerGame?: number }

/**
 * How to reconcile the pool's level with our own projection, since the rank join keeps our ORDERING
 * but discards our MAGNITUDES.
 *
 * Measured on the 2026 board (scripts/bootstrap-calibration.mjs): pool means run 0.67-0.90 of our
 * projections for skill positions, because our projections are healthy-season figures and the pools
 * include the weeks players missed. That gap is REAL and worth keeping -- but it also means the
 * simulator would silently answer about a lower-scoring league than our board describes.
 *
 * `scale` rescales each player's pool to our projected mean, keeping the empirical SHAPE (the atom at
 * zero, the skew, the ceiling weeks) while restoring our board's level and spread.
 *
 * THE GUARD MATTERS MORE THAN THE CHOICE. A ratio far from 1 is not a modelling decision, it is a
 * broken projection -- K and DST came back at 6.0-6.5x because the projection curve had no K/DST
 * history to learn from. Rescaling those would have propagated the bug into the simulator and
 * quietly deleted ~125 points a season per team. So a pool outside [0.5, 2.0] is left ALONE and
 * reported, rather than trusted in either direction.
 */
export type Calibration = "none" | "scale";
export const CALIBRATION_LIMITS: [number, number] = [0.5, 2.0];

/**
 * Prepare per-player sorted bootstrap pools plus, for each NFL team with 2+ rostered players, the
 * Cholesky factor of their correlation matrix. Done once per simulation, not per week.
 */
export function prepare(players: PoolPlayer[], outcomes: RankOutcomes, corr: CorrelationModel, calibration: Calibration = "none") {
  assertTrajectorySchema(outcomes);
  const pools = new Map<PoolPlayer, Trajectory[]>();
  const uncalibrated: { name: string; pos: string; ratio: number }[] = [];
  for (const p of players) {
    const byRank = outcomes.pos[p.pos] ?? {};
    // nearest rank we actually have a pool for -- ranks beyond the fitted range fall back to the deepest
    let pool = byRank[String(p.rank)];
    if (!pool) {
      const keys = Object.keys(byRank).map(Number).sort((a, b) => a - b);
      if (!keys.length) { pools.set(p, []); continue; }
      const best = keys.reduce((a, b) => (Math.abs(b - p.rank) < Math.abs(a - p.rank) ? b : a), keys[0]);
      pool = byRank[String(best)];
    }
    let trajs = pool.map((weeks) => weeks.slice());
    if (calibration === "scale" && p.projPerGame != null && p.projPerGame > 0) {
      // The ratio is still measured PER WEEK -- the mean of every week in the pool -- so it is the
      // same quantity the schema-1 guard used and the [0.5, 2.0] limits keep their meaning. Scaling
      // multiplies every week of every trajectory, which preserves both the weekly shape and the
      // season-to-season dispersion this schema exists to carry.
      let sum = 0, n = 0;
      for (const t of trajs) for (const v of t) { sum += v; n++; }
      const pm = n ? sum / n : 0;
      const ratio = pm > 0 ? p.projPerGame / pm : 1;
      if (ratio >= CALIBRATION_LIMITS[0] && ratio <= CALIBRATION_LIMITS[1]) {
        trajs = trajs.map((t) => t.map((v) => v * ratio));
      } else {
        uncalibrated.push({ name: p.name, pos: p.pos, ratio: pm > 0 ? p.projPerGame / pm : 0 });
      }
    }
    // SORTED BY SEASON TOTAL, which is what makes the copula's uniform a SEASON quantile: u = 0.9
    // must mean "a top-decile year for this player", or coupling teammates would couple nothing
    // meaningful. Sorting by anything else (or not at all) would still run and still look correct.
    const withTotals: Trajectory[] = trajs
      .map((weeks) => ({ weeks, total: weeks.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => a.total - b.total);
    pools.set(p, withTotals);
  }
  const groups: { members: PoolPlayer[]; L: number[][] }[] = [];
  const byTeam = new Map<string, PoolPlayer[]>();
  for (const p of players) {
    if (!p.team) continue;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team)!.push(p);
  }
  for (const [, members] of byTeam) {
    if (members.length < 2) continue;
    const M = members.map((a) => members.map((b) => pairCorr(corr, a.pos, b.pos)));
    groups.push({ members, L: cholesky(M) });
  }
  return { pools, groups, uncalibrated };
}

/**
 * One simulated week for the whole set of players. Returns name -> points.
 * `gauss` must return standard normal draws; `unif` uniform [0,1).
 */
/**
 * `gauss` and `unif` take the PLAYER they are drawing for, so the value can be keyed to his identity
 * rather than to his position in a stream. Passing bare `() => number` generators -- which this used
 * to -- makes every draw depend on how many draws came before it, so swapping one player on one
 * roster shifts every subsequent value and two "paired" simulations stop sharing anything. See
 * draft/rng.ts. Callers that genuinely want an unkeyed stream can ignore the argument.
 *
 * THE COPULA'S z VECTOR IS KEYED PER MEMBER, not per group, and that detail is load-bearing: keying
 * it to the group would make a team's shared draw depend on that group's membership, so adding or
 * removing one teammate would re-roll the whole stack. Each member's own normal is his, and the
 * Cholesky mixing below turns them into the correlated vector.
 */
/**
 * ONE SEASON per player, drawn once per trial, coupled across NFL teammates by the copula.
 *
 * This is the schema-2 replacement for the old per-week `sampleWeek`. The draw moved UP a level --
 * from "which week does he post" to "which season does he have" -- and everything else is unchanged:
 * the same Cholesky groups, the same identity-keyed RNG, the same empirical quantile. Because the
 * pools are sorted by SEASON TOTAL, a teammate correlation now couples season outcomes: a quarterback
 * having a career year makes his own receiver's good season more likely, which is the dependence a
 * fantasy roster actually lives or dies by.
 *
 * The marginal is still exactly the pool -- the copula property. Each player's set of seasons is
 * untouched; only which of them co-occur changes.
 */
export function sampleSeason(
  players: PoolPlayer[],
  prepared: ReturnType<typeof prepare>,
  gauss: (p: PoolPlayer, i: number) => number,
  unif: (p: PoolPlayer) => number,
): Map<PoolPlayer, Trajectory | null> {
  const u = new Map<PoolPlayer, number>();
  const coupled = new Set<PoolPlayer>();
  for (const g of prepared.groups) {
    const z = g.members.map((m, i) => gauss(m, i));
    for (let i = 0; i < g.members.length; i++) {
      let v = 0;
      for (let k = 0; k <= i; k++) v += g.L[i][k] * z[k];
      u.set(g.members[i], normalCdf(v));
      coupled.add(g.members[i]);
    }
  }
  for (const p of players) if (!coupled.has(p)) u.set(p, unif(p));
  const out = new Map<PoolPlayer, Trajectory | null>();
  for (const p of players) {
    const pool = prepared.pools.get(p) ?? [];
    if (!pool.length) { out.set(p, null); continue; }
    const uu = u.get(p) ?? 0.5;
    out.set(p, pool[Math.min(pool.length - 1, Math.max(0, Math.floor(uu * pool.length)))]);
  }
  return out;
}

/**
 * Week `week` (1-based) of a drawn season.
 *
 * Trajectories hold the weeks a player's TEAM played, 16-17 of them. The simulator's playoff weeks
 * can run past that, so the index wraps rather than falling off the end -- returning 0 there would
 * silently bench every player in the championship week, which is a far worse answer than reusing a
 * real week from the same season. Byes are applied by the caller from the real schedule, exactly as
 * before: they were never in the pool to begin with.
 */
export function weekOf(t: Trajectory | null | undefined, week: number): number {
  if (!t || !t.weeks.length) return 0;
  return t.weeks[(week - 1) % t.weeks.length];
}
