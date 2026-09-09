/**
 * THE LINEUP THAT MAXIMISES P(WIN THIS WEEK), rather than the lineup that maximises expected points.
 *
 * WHY THE TWO ARE NOT THE SAME QUESTION. A fantasy week is a head-to-head game: the only thing that
 * is paid out is beating ONE opponent's total, and a point scored past his total is worth exactly
 * nothing. Expected points is the right objective only when the game is close, because only then is
 * P(win) locally linear in our total. Away from that:
 *
 *   TRAILING BADLY   we need a tail. A boom-or-bust receiver who projects two points below a steady
 *                    one still wins more of the weeks we were going to lose, because the only
 *                    outcomes that matter are the ones in his upper tail.
 *   LEADING BADLY    we need a floor. The steady man wins, for the mirror-image reason: the only
 *                    outcomes that matter now are the ones where WE collapse, and he collapses less.
 *
 * That asymmetry is the whole content of this module, and it is a statement about the SHAPE of each
 * player's weekly distribution, not about his mean. The weekly projector already publishes the shape
 * -- p10, p50, p90 and, for a two-part artifact, P(zero week) -- so nothing here has to be invented;
 * what is added is a way to turn those bands into a joint distribution over a lineup's total and to
 * search the legal lineups under it.
 *
 * WHAT IS SAMPLED, AND WHAT IS NOT.
 *
 *   MARGINAL   each player's own published band, read as a quantile function (`quantileFn` below).
 *              His marginal under the sampler IS his band, by construction -- there is no fitted
 *              distribution in between that could disagree with the projector.
 *   DEPENDENCE a Gaussian copula over NFL TEAMMATES, with the pairwise correlations the repo already
 *              measured (`data/correlation-model.json`, fitted on 14,021 real team-weeks) and the
 *              Cholesky/normal-CDF machinery already in `src/draft/bootstrap.ts`. It is CALLED here,
 *              not reimplemented: a quarterback and his receiver boom together, and a lineup search
 *              that drew them independently would systematically understate our own variance --
 *              which is precisely the quantity the search exists to trade.
 *   NOT MODELLED  any dependence between players on DIFFERENT NFL teams, and any dependence between
 *              a player's band and the availability news that arrives after the projection was made.
 *              Both are stated in `caveats` on every result rather than left for a reader to assume.
 *
 * COMMON RANDOM NUMBERS ARE THE POINT. Every candidate lineup is scored on the SAME sampled matrix:
 * each player's draw is keyed to (seed, his own index, the simulation number) and to nothing else, so
 * adding or removing a player from the lineup does not re-roll anybody. Two lineups therefore differ
 * only by the players that differ between them -- exactly the paired-comparison rule CLAUDE.md states
 * for the championship backtest, applied one level down. Without it a +1pp difference in P(win)
 * between two lineups would be indistinguishable from sampler noise at any affordable sample size.
 *
 * WHAT THIS IS NOT. It is not a season objective. Maximising this week's win probability every week
 * is not the same as maximising the probability of making the playoffs -- a team that needs to win
 * out should take more variance than one that needs to win half -- and nothing here knows the
 * standings. `objectiveFor` in copilot.ts is where the season regime lives; this module answers the
 * one-week question it is given and says so.
 */
import { optimalLineup, type RosterPlayer } from "./lineup.js";
import { cholesky, normalCdf, type CorrelationModel } from "../draft/bootstrap.js";

// ---------------------------------------------------------------------------------------------
// THE MARGINAL: a published band, read as a quantile function.
// ---------------------------------------------------------------------------------------------

/**
 * One player-week's shape, exactly as `projectWeekly` publishes it. `pZero` is present only for a
 * two-part artifact; a quantile artifact does not have one and does not get a fabricated one, so the
 * zero atom is then represented only as far as p10 sitting on it.
 */
export interface WeeklyBand {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  pZero?: number | null;
  /** Where the band came from, carried so a result can say how many were real. */
  source?: string;
}

export interface WinProbPlayer {
  name: string;
  pos: string;
  /** Every slot he may be STARTED at (ESPN's own eligibleSlots). Absent means `[pos]`. */
  eligible?: string[];
  /** false = bye / OUT -- not startable, and never sampled. */
  available: boolean;
  /** NFL team. Two players sharing one are coupled; a null team is drawn independently. */
  team?: string | null;
  /** The mean, i.e. what the EXPECTED-POINTS lineup maximises. */
  proj: number;
  /** The shape. Null means we have only a mean for him -- he is then a POINT MASS, which reads as a
   *  zero-variance player and would be silently preferred whenever the search wants a floor. Counted
   *  and reported as `pointMass` rather than left invisible. */
  band?: WeeklyBand | null;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * A band as an inverse CDF, with the zero atom explicit.
 *
 * The knots are the levels the projector actually published -- 0.10, 0.50, 0.90 -- plus two the
 * shape forces: the atom's top at u = pZero maps to exactly 0, and the upper tail beyond p90 is
 * extended by one more (p90 - p50) so the ninety-ninth percentile is not clipped to the ninetieth.
 * That extension is an ASSUMPTION and it is the only one in here: without it every lineup's ceiling
 * would be capped at the sum of its p90s, which would bias the search against variance precisely
 * where variance is what we are shopping for. Linear interpolation between published levels is the
 * honest default -- it invents no shape the projector did not state.
 *
 * Non-decreasing is enforced. A quantile crossing (p50 below p10) is a property of fitting levels
 * independently, and letting one through would produce a sampler whose median is below its own
 * tenth percentile.
 */
export function quantileFn(band: WeeklyBand): (u: number) => number {
  const z = clamp01(band.pZero ?? 0);
  const lv: number[] = [z];
  const va: number[] = [0];
  let prev = 0;
  for (const [l, v] of [[0.10, band.p10], [0.50, band.p50], [0.90, band.p90]] as [number, number][]) {
    if (!(l > z)) continue;                       // the atom swallows this level entirely
    const w = Math.max(prev, Math.max(0, v));
    lv.push(l); va.push(w); prev = w;
  }
  // The upper tail. One more p90-to-p50 step beyond p90, or a 25% step where p50 == p90 (which is
  // what a near-certain zero looks like) so the tail is never exactly flat.
  const top = Math.max(prev, band.p90, band.mean);
  const step = Math.max(band.p90 - band.p50, 0.25 * top, 0.5);
  lv.push(1); va.push(top + step);

  return (u: number): number => {
    const x = clamp01(u);
    if (x <= z) return 0;
    for (let i = 1; i < lv.length; i++) {
      if (x <= lv[i]) {
        const span = lv[i] - lv[i - 1];
        return span > 0 ? va[i - 1] + (va[i] - va[i - 1]) * ((x - lv[i - 1]) / span) : va[i];
      }
    }
    return va[va.length - 1];
  };
}

// ---------------------------------------------------------------------------------------------
// THE RNG: keyed per (seed, player, simulation) so nothing re-rolls when a lineup changes.
// ---------------------------------------------------------------------------------------------

/**
 * A FULL AVALANCHE, not a cheap one, and the reason is a defect this module actually shipped.
 *
 * The first version of this hash folded the three keys in with one multiply each and one final
 * shift-xor. It looked fine: `scripts/winprob-copula-check.mjs` reported a mean correlation of
 * -0.006 across 124 uncoupled real teammate pairs, which is exactly what independence looks like.
 * It was not independence. The mean was averaging SIGNED correlations that cancelled; the worst
 * uncoupled pair was 0.48 -- sixty-eight sampling errors -- and the coupling calibration built on
 * top of it would have been fitting a hash artifact rather than the copula.
 *
 * `scripts/winprob-rng-check.mjs` is the check that finds it, and it looks at the WORST pair over
 * several seeds rather than the mean of all of them, because a defect of this shape is invisible in
 * an average by construction. This is the murmur3 finalizer applied once per key, which passes it.
 */
function mix32(x: number): number {
  let h = x >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x21f0aaad) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0xd35a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}
function hash3(a: number, b: number, c: number): number {
  let h = mix32((a ^ 0x9e3779b9) >>> 0);
  h = mix32((h ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0);
  h = mix32((h ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0);
  return h;
}
const unit = (h: number): number => (h + 0.5) / 4294967296;

/** A standard normal keyed to (seed, player index, simulation) and to NOTHING ELSE -- which is what
 *  makes two lineups a paired comparison. Box-Muller on two hashes of adjacent sub-streams. */
function keyedNormal(seed: number, pi: number, sim: number): number {
  const u1 = unit(hash3(seed, pi, sim * 2));
  const u2 = unit(hash3(seed, pi, sim * 2 + 1));
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * HOW HARD THE COPULA COUPLES, as a multiple of the measured pairwise Pearson correlation.
 *
 * The same attenuation `WEEKLY_COUPLING_DEFAULT` documents applies here and for the same reason: the
 * copula's parameter is a correlation between NORMALS imposed on RANKS, while `correlation-model.json`
 * holds a PEARSON correlation between weekly fantasy scores, whose marginal is right-skewed with an
 * atom at zero. Rank dependence maps to Pearson dependence with attenuation across a marginal of that
 * shape, so passing rho straight through under-delivers.
 *
 * MEASURED HERE, not inherited. `scripts/winprob-copula-check.mjs` samples this module's own output
 * and reports the realised same-week Pearson against the fitted target; the shipped value is the one
 * that lands it. The season sampler's 1.8 is NOT reused blindly -- that number was calibrated for a
 * two-stage season-then-week construction against a bootstrap marginal, and this is a one-stage draw
 * against a published band, which is a different mapping, and it measures a MILDER attenuation:
 *
 *   coupling   QB-WR   QB-TE   K-DST   QB-RB      (targets 0.3475 / 0.2251 / 0.2241 / 0.0799)
 *   0.00       0.001  -0.001  -0.001   0.000      <- the positive control, and the one that matters
 *   0.50       0.153   0.096   0.102   0.035         most: with the copula OFF the sampler must
 *   1.00       0.307   0.194   0.207   0.070         produce no correlation at all. A number here
 *   1.15       0.354   0.223   0.239   0.081      <- SHIPPED  would mean the co-movement came from
 *   1.20       0.369   0.233   0.249   0.084         somewhere else -- and once it DID, see below.
 *   1.80       0.560   0.353   0.378   0.127
 *
 * (2024 week 8, 124 real teammate pairs over 32 NFL teams, real challenger bands, 20,000 sims.)
 * One scalar lands all four pairs within 0.015 of their fitted values, which is itself evidence that
 * the attenuation is a property of the mapping rather than of any one pair. Re-run the script if the
 * correlation model is refitted or the marginal's tail extension changes.
 *
 * AND THE TABLE ABOVE IS NOT SUFFICIENT ON ITS OWN. Its coupling-0 row is a MEAN over 124 pairs, and
 * the first version of this module's RNG passed it at -0.006 while carrying uncoupled pairs
 * correlated at 0.48 -- signed correlations cancelling in an average. `scripts/winprob-rng-check.mjs`
 * is the check with teeth: the WORST uncoupled pair over several seeds, against the sampling error.
 * Run both, or the calibration above may be fitting a hash.
 */
export const WINPROB_COUPLING_DEFAULT = 1.15;

// ---------------------------------------------------------------------------------------------
// THE SAMPLER
// ---------------------------------------------------------------------------------------------

export interface SampleMatrix {
  /** pts[i][s] -- player i's points in simulation s. */
  pts: Float64Array[];
  sims: number;
  /** How many players were drawn as a point mass because they had no band. */
  pointMass: number;
  /** How many NFL-team groups were coupled, and how many players are in them. */
  coupledGroups: number;
  coupledPlayers: number;
}

/**
 * Draw `sims` correlated weeks for a whole set of players at once.
 *
 * ONE MATRIX FOR EVERY LINEUP. The players of both rosters go in together, so our receiver and the
 * opponent's quarterback -- who may be on the same NFL team -- co-move in the same draw. Splitting
 * the two sides into separate samples would make every shoot-out week independent of itself.
 */
export function sampleWeek(
  players: WinProbPlayer[],
  o: { sims: number; seed: number; coupling?: number; corr?: CorrelationModel } = { sims: 2000, seed: 7 },
): SampleMatrix {
  const sims = Math.max(1, Math.floor(o.sims));
  const coupling = o.coupling ?? WINPROB_COUPLING_DEFAULT;
  const corr = o.corr ?? { pairs: {} };
  const n = players.length;

  const q: ((u: number) => number)[] = [];
  let pointMass = 0;
  for (const p of players) {
    if (p.band) q.push(quantileFn(p.band));
    else { pointMass++; const v = Math.max(0, p.proj); q.push(() => v); }
  }

  // NFL-team groups, in a stable order so the Cholesky factor and the member indices cannot drift.
  const byTeam = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const t = players[i].team;
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push(i);
  }
  /**
   * THE OFF-DIAGONAL, and why `pairCorr` is not called for it directly.
   *
   * `pairCorr(model, a, b)` returns 1 when the two position strings are EQUAL -- which is right when
   * the question is "how correlated is a position with itself", and wrong here, where the two
   * arguments are two DIFFERENT men who happen to play the same position. Two receivers on one NFL
   * team are not the same player; they share a quarterback and split his targets, which is if
   * anything a negative dependence. The correlation model has no WR-WR pair fitted, so the honest
   * value is the one it publishes -- nothing -- and the honest reading of nothing is ZERO, not one.
   * Taking the shortcut would have made a stack of same-position teammates a single player with a
   * multiplied projection, which inflates the lineup's variance enormously and is exactly the shape
   * the underdog side of the search reaches for.
   */
  const pairOf = (a: number, b: number): number => {
    const pa = players[a].pos, pb = players[b].pos;
    return corr.pairs[`${pa}-${pb}`] ?? corr.pairs[`${pb}-${pa}`] ?? 0;
  };
  const groups: { idx: number[]; L: number[][] }[] = [];
  let coupledPlayers = 0;
  for (const [, idx] of [...byTeam.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (idx.length < 2) continue;
    const M = idx.map((a) => idx.map((b) => (a === b ? 1 : Math.max(-0.95, Math.min(0.95, pairOf(a, b) * coupling)))));
    groups.push({ idx, L: cholesky(M) });
    coupledPlayers += idx.length;
  }
  const inGroup = new Uint8Array(n);
  for (const g of groups) for (const i of g.idx) inGroup[i] = 1;

  const pts: Float64Array[] = Array.from({ length: n }, () => new Float64Array(sims));
  const zs = new Float64Array(n);
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) zs[i] = keyedNormal(o.seed, i, s);
    for (const g of groups) {
      for (let a = 0; a < g.idx.length; a++) {
        let v = 0;
        for (let k = 0; k <= a; k++) v += g.L[a][k] * zs[g.idx[k]];
        pts[g.idx[a]][s] = q[g.idx[a]](normalCdf(v));
      }
    }
    for (let i = 0; i < n; i++) if (!inGroup[i]) pts[i][s] = q[i](normalCdf(zs[i]));
  }
  return { pts, sims, pointMass, coupledGroups: groups.length, coupledPlayers };
}

// ---------------------------------------------------------------------------------------------
// THE SEARCH
// ---------------------------------------------------------------------------------------------

export interface WinProbSwap {
  /** The slot the displaced man was occupying in the EXPECTED-POINTS lineup. */
  slot: string;
  out: string;
  in: string;
  /** Expected points given up (positive = the swap costs points). */
  epCost: number;
  /** Percentage points of P(win) gained by this one swap, at the moment it was taken. */
  winPp: number;
  /** Standard deviation of the man coming in, minus that of the man going out. */
  sdDelta: number;
  /** Tenth percentile of the man coming in, minus that of the man going out. */
  p10Delta: number;
  why: string;
}

export interface WinProbResult {
  /** The lineup that maximises P(win). */
  starters: { slot: string; name: string; pos: string; proj: number }[];
  /** The lineup that maximises expected points -- what ships today. */
  epStarters: { slot: string; name: string; pos: string; proj: number }[];
  winPct: number;
  epWinPct: number;
  gainPp: number;
  totalProj: number;
  epTotalProj: number;
  /** Expected points given up to buy that gain. Never negative: the EP lineup is the EP maximum. */
  epCostPts: number;
  swaps: WinProbSwap[];
  /** Our EP total minus the opponent's projected total. Negative = we are the underdog. */
  projMargin: number;
  posture: "underdog" | "even" | "favourite";
  oppMeanTotal: number;
  oppSdTotal: number;
  sims: number;
  seed: number;
  coupling: number;
  /** THE SEARCH COST, measured rather than asserted: candidate lineups evaluated, and passes taken. */
  evaluated: number;
  passes: number;
  pointMass: number;
  caveats: string[];
}

/** The posture band. Inside +/- `evenBand` points the game is close enough that P(win) is locally
 *  linear in our total, which is exactly the condition under which expected points IS the objective. */
export const EVEN_BAND_PTS = 5;

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Points-per-simulation for a set of player indices. */
function totalsOf(m: SampleMatrix, idx: number[]): Float64Array {
  const out = new Float64Array(m.sims);
  for (const i of idx) { const c = m.pts[i]; for (let s = 0; s < m.sims; s++) out[s] += c[s]; }
  return out;
}

/** P(ours > theirs), ties counted as half. Ties are not hypothetical: two lineups can both post 0. */
function pWin(ours: Float64Array, theirs: Float64Array): number {
  let w = 0, t = 0;
  for (let s = 0; s < ours.length; s++) { if (ours[s] > theirs[s]) w++; else if (ours[s] === theirs[s]) t++; }
  return (w + 0.5 * t) / ours.length;
}

/** Same, for a lineup that differs from `ours` by one column. No array is rebuilt. */
function pWinSwapped(ours: Float64Array, theirs: Float64Array, outCol: Float64Array, inCol: Float64Array): number {
  let w = 0, t = 0;
  for (let s = 0; s < ours.length; s++) {
    const v = ours[s] - outCol[s] + inCol[s];
    if (v > theirs[s]) w++; else if (v === theirs[s]) t++;
  }
  return (w + 0.5 * t) / ours.length;
}

const stddev = (a: Float64Array): number => {
  let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length;
  let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2;
  return Math.sqrt(v / Math.max(1, a.length - 1));
};
const pct10 = (a: Float64Array): number => {
  const s = Array.from(a).sort((x, y) => x - y);
  return s[Math.floor(0.10 * s.length)];
};

/** `optimalLineup` as a FEASIBILITY oracle: hand it exactly as many players as there are slots and
 *  it either seats all of them (the set is legal) or reports an empty slot (it is not). Kuhn's
 *  augmenting-path insertion finds a maximum-cardinality assignment, so "no empty slot" is a proof
 *  of legality rather than a property of the order the players arrived in. */
function seat(set: WinProbPlayer[], slots: string[], flexOk?: string[]):
  { slot: string; name: string; pos: string; proj: number }[] | null {
  const rp: RosterPlayer[] = set.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: true, ...(p.eligible ? { eligible: p.eligible } : {}) }));
  const r = optimalLineup(rp, slots, flexOk);
  if (r.starters.some((s) => s.name === "(empty)")) return null;
  const placed = new Set(r.starters.map((s) => s.name));
  if (placed.size !== set.length) return null;
  return r.starters;
}

export interface WinProbOpts {
  sims?: number;
  seed?: number;
  coupling?: number;
  corr?: CorrelationModel;
  /** Hill-climbing passes. Each pass evaluates every legal single-player substitution and takes the
   *  best improving one; the default is generous enough that it is never the binding constraint on
   *  these roster sizes (a 9-slot lineup has at most 9 men to change). */
  maxPasses?: number;
  /** Only take a swap that gains at least this much P(win), in percentage points. Sampling noise on
   *  `sims` paired draws is roughly 100*sqrt(p(1-p)/sims) * a small factor for the correlation; a
   *  threshold below that buys noise. Default scales with `sims`. */
  minGainPp?: number;
  /**
   * FAULT-INJECTION HANDLE. True disables the swap search entirely, so `winprob` returns the
   * expected-points lineup with a P(win) attached. Every test that claims the search MOVES a lineup
   * is re-run with this set, and must fail -- a search that is not connected and a search that
   * correctly declines to move produce the same output, and nothing else can tell them apart.
   */
  noSearch?: boolean;
  evenBandPts?: number;
}

/**
 * THE SEARCH, and its cost, stated.
 *
 * NEIGHBOURHOOD: every single-player substitution -- one of the current starters out, one of the
 * available bench men in -- filtered to those that leave a LEGAL assignment. That is deliberately
 * defined on the SET rather than on the slot: a receiver who is not eligible for the slot the man he
 * replaces was sitting in can still be legal once the rest of the lineup is re-seated, and a
 * slot-keyed neighbourhood would silently miss exactly those. `seat` re-runs the assignment for each
 * candidate, which is what makes the answer legal by construction rather than by argument.
 *
 * MOVE RULE: steepest ascent. Each pass evaluates the whole neighbourhood and takes the single best
 * improving swap, then repeats until no swap gains more than `minGainPp` or `maxPasses` is reached.
 *
 * COST: with S starting slots and B available bench men, one pass evaluates at most S*B candidates,
 * each costing one assignment check (tiny) plus `sims` comparisons -- no array is rebuilt, because a
 * one-player substitution is a one-column delta on the running total. Passes are bounded by S, since
 * each takes at least one improving step and a lineup has S men to change. So the whole search is
 * O(S^2 * B * sims) in the worst case and, on this league's 9-slot template with four or five
 * startable bench men, about 40 candidates a pass and two or three passes in practice. `evaluated`
 * and `passes` are returned so the cost is a measurement rather than this paragraph.
 *
 * WHY HILL-CLIMBING AND NOT AN EXACT SOLVE. P(win) is not additive over players -- that is the whole
 * point of it -- so there is no matroid to be greedy on and no assignment problem to solve exactly.
 * An exhaustive search over legal lineups is combinatorial. Hill-climbing from the EP lineup is not
 * guaranteed optimal, and the honest claim is the one the return value makes: this lineup is at
 * least as good as the expected-points lineup under this sampler, by `gainPp`, and no single swap
 * improves it further.
 */
export function winProbLineup(
  ours: WinProbPlayer[],
  opponentStarters: WinProbPlayer[],
  slots: string[],
  flexOk?: string[],
  o: WinProbOpts = {},
): WinProbResult {
  const sims = o.sims ?? 2000;
  const seed = o.seed ?? 7;
  const coupling = o.coupling ?? WINPROB_COUPLING_DEFAULT;
  const maxPasses = o.maxPasses ?? 12;
  const evenBand = o.evenBandPts ?? EVEN_BAND_PTS;
  // The floor under a taken swap. 1.4 is the usual allowance for a DIFFERENCE of two correlated
  // estimates under common random numbers -- the same factor `noiseFloorPp` uses, for the same
  // reason -- applied to the worst-case binomial standard error at p = 0.5.
  const minGainPp = o.minGainPp ?? r3(100 * 0.5 / Math.sqrt(sims) * 1.4);

  const startSlots = slots.filter((s) => s !== "BE" && s !== "BENCH");
  const availOurs = ours.filter((p) => p.available);

  // ONE sample matrix over both rosters, so a shared NFL team couples across the matchup.
  const all = [...availOurs, ...opponentStarters];
  const m = sampleWeek(all, { sims, seed, coupling, corr: o.corr });
  const oursOffset = 0, oppOffset = availOurs.length;
  const idxOf = new Map<WinProbPlayer, number>();
  availOurs.forEach((p, i) => idxOf.set(p, oursOffset + i));
  opponentStarters.forEach((p, i) => idxOf.set(p, oppOffset + i));

  const theirs = totalsOf(m, opponentStarters.map((p) => idxOf.get(p)!));
  let oppMean = 0; for (let s = 0; s < sims; s++) oppMean += theirs[s]; oppMean /= sims;

  // THE STARTING POINT: the expected-points lineup, from the same optimizer that ships today.
  const epRes = optimalLineup(
    ours.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: p.available, ...(p.eligible ? { eligible: p.eligible } : {}) })),
    slots, flexOk,
  );
  const byName = new Map(ours.map((p) => [p.name, p]));
  const epStarters = epRes.starters.filter((s) => s.name !== "(empty)");
  let current: WinProbPlayer[] = epStarters.map((s) => byName.get(s.name)!).filter(Boolean);

  const epTotalProj = current.reduce((a, p) => a + p.proj, 0);
  let ourTotals = totalsOf(m, current.map((p) => idxOf.get(p)!));
  const epWin = pWin(ourTotals, theirs);
  let win = epWin;

  const projMargin = epTotalProj - oppMean;
  const posture: WinProbResult["posture"] =
    projMargin < -evenBand ? "underdog" : projMargin > evenBand ? "favourite" : "even";

  const swaps: WinProbSwap[] = [];
  let evaluated = 0, passes = 0;
  if (!o.noSearch) {
    for (; passes < maxPasses; passes++) {
      const inSet = new Set(current.map((p) => p.name));
      const bench = availOurs.filter((p) => !inSet.has(p.name));
      let best: { out: WinProbPlayer; add: WinProbPlayer; win: number } | null = null;
      for (const out of current) {
        for (const add of bench) {
          const set = current.filter((p) => p !== out).concat(add);
          if (set.length !== current.length) continue;
          if (!seat(set, startSlots, flexOk)) continue;
          evaluated++;
          const w = pWinSwapped(ourTotals, theirs, m.pts[idxOf.get(out)!], m.pts[idxOf.get(add)!]);
          if (!best || w > best.win) best = { out, add, win: w };
        }
      }
      if (!best || 100 * (best.win - win) < minGainPp) break;
      const oc = m.pts[idxOf.get(best.out)!], ic = m.pts[idxOf.get(best.add)!];
      swaps.push({
        slot: epRes.starters.find((s) => s.name === best!.out.name)?.slot ?? "-",
        out: best.out.name, in: best.add.name,
        epCost: r2(best.out.proj - best.add.proj),
        winPp: r2(100 * (best.win - win)),
        sdDelta: r2(stddev(ic) - stddev(oc)),
        p10Delta: r2(pct10(ic) - pct10(oc)),
        why: posture === "underdog"
          ? "trailing on projection, so the tail is what pays: the man coming in wins more of the weeks we were losing"
          : posture === "favourite"
            ? "leading on projection, so the floor is what pays: the man coming in loses fewer of the weeks we were winning"
            : "the game is close, so this swap is bought on shape at almost no cost in points",
      });
      const nt = new Float64Array(sims);
      for (let s = 0; s < sims; s++) nt[s] = ourTotals[s] - oc[s] + ic[s];
      ourTotals = nt;
      current = current.filter((p) => p !== best!.out).concat(best!.add);
      win = best.win;
    }
  }

  const seated = seat(current, startSlots, flexOk);
  const totalProj = current.reduce((a, p) => a + p.proj, 0);

  const caveats = [
    "P(win) is a one-week head-to-head probability under this sampler, not a season objective: nothing here knows the standings, and a team that must win out should take more variance than this returns.",
    `the marginal of every sampled player IS his published band (p10/p50/p90${all.some((p) => p.band?.pZero != null) ? " and P(zero week)" : ""}); no distribution was fitted in between`,
    `dependence is a Gaussian copula over NFL TEAMMATES only (${m.coupledGroups} group(s), ${m.coupledPlayers} player(s)), at ${coupling}x the measured pairwise correlation; players on different NFL teams are drawn independently`,
    "the upper tail beyond p90 is EXTENDED by one further p90-p50 step -- the one assumption in the marginal, made because capping the ceiling at p90 would bias the search against variance",
  ];
  if (m.pointMass) caveats.push(`${m.pointMass} of ${all.length} sampled players had NO band and were drawn as a POINT MASS at their mean -- a zero-variance player, which the floor side of this search will prefer for the wrong reason`);
  if (o.noSearch) caveats.push("THE SWAP SEARCH WAS DISABLED (noSearch): this is the expected-points lineup with a P(win) attached, nothing more");

  return {
    starters: (seated ?? epRes.starters.filter((s) => s.name !== "(empty)")).map((s) => ({ ...s, proj: r2(s.proj) })),
    epStarters: epStarters.map((s) => ({ ...s, proj: r2(s.proj) })),
    winPct: r2(100 * win),
    epWinPct: r2(100 * epWin),
    gainPp: r2(100 * (win - epWin)),
    totalProj: r2(totalProj),
    epTotalProj: r2(epTotalProj),
    epCostPts: r2(epTotalProj - totalProj),
    swaps,
    projMargin: r2(projMargin),
    posture,
    oppMeanTotal: r2(oppMean),
    oppSdTotal: r2(stddev(theirs)),
    sims, seed, coupling,
    evaluated, passes,
    pointMass: m.pointMass,
    caveats,
  };
}

/** The opponent's own best legal lineup on his own projections -- what he is assumed to start. He is
 *  not modelled as making the same win-probability trade we are: he is the FAVOURITE or the underdog
 *  of the mirror-image problem and would move his own lineup, and assuming he does not is a stated
 *  simplification rather than a claim about him. */
export function opponentStarters(
  roster: WinProbPlayer[], slots: string[], flexOk?: string[],
): WinProbPlayer[] {
  const r = optimalLineup(
    roster.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: p.available, ...(p.eligible ? { eligible: p.eligible } : {}) })),
    slots, flexOk,
  );
  const byName = new Map(roster.map((p) => [p.name, p]));
  return r.starters.filter((s) => s.name !== "(empty)").map((s) => byName.get(s.name)!).filter(Boolean);
}
