/**
 * ROSTER VALUE UNDER AVAILABILITY -- what a roster is actually worth once players miss games.
 *
 * WHY THE OBVIOUS METRIC IS WRONG, and it produced a wrong answer here before this existed. Scoring
 * a roster by its optimal lineup on point projections asks "what do my best eight score if everyone
 * plays". Under that metric a backup running back is worth exactly ZERO -- he never starts, so he
 * never contributes -- and a trade search built on it will report, correctly and uselessly, that no
 * trade for a second RB improves anything. That is not a fact about running backs. It is the metric
 * being unable to represent the thing being bought.
 *
 * Depth is insurance, and insurance has no expected-value story at all until you price the event it
 * covers. So this scores a roster the way the season actually resolves: each week every player is
 * available or not, drawn from the SAME fitted availability the season simulator uses, and the
 * lineup is optimised over whoever is left. A mandatory slot with nobody to fill it scores zero,
 * which is precisely the cost a handcuff removes and precisely what the point-estimate metric cannot
 * see.
 *
 * THE FITTED avail IS games/17 AND ALREADY INCLUDES THE BYE, so it must have the bye divided back
 * out before it can be read as a weekly injury rate -- season.ts makes the same correction, and
 * getting it wrong benches every player twice. Shared here rather than re-derived so the two
 * surfaces cannot disagree about how durable a given tier is.
 *
 * WHAT THIS IS NOT. It is not a playoff-odds model: it returns expected weekly starting points under
 * availability, which is a lineup quantity. Converting that to a title probability needs the full
 * season simulator with its schedule and opponents, and quoting one here would imply precision this
 * does not have.
 */
import { optimalLineup } from "./lineup.js";
import type { VarianceModel } from "../draft/season.js";

export interface RosterPlayer { name: string; pos: string; proj: number; poolRankFrac?: number }

/** Deterministic PRNG so two rosters are compared under the SAME injury draws -- see below. */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-week probability a player is UNAVAILABLE, from the fitted per-tier availability. */
export function missProb(vm: VarianceModel, pos: string, poolRankFrac: number): number {
  const m = vm.pos[pos];
  if (!m) return 0.10;
  const tiers = vm.tiers ?? m.avail.length;
  const tier = Math.min(m.avail.length - 1, Math.max(0, Math.floor((poolRankFrac || 0) * tiers)));
  const perPlayable = Math.min(1, (m.avail[tier] ?? 0.85) / (16 / 17));
  return Math.max(0, Math.min(1, 1 - perPlayable));
}

export interface RosterScore { expected: number; p10: number; floor: number; emptySlotRate: number }

/**
 * Expected weekly starting points under availability, plus the downside.
 *
 * COMMON RANDOM NUMBERS ARE THE POINT of taking a seed. Two rosters differing by one player must be
 * compared under IDENTICAL injury draws, or the difference between them is swamped by which sim drew
 * a worse season -- a roster can "win" a comparison purely because its opponent's copy of Hall got
 * hurt more often. Same seed, same draws, and the delta is attributable to the roster change.
 */
export function scoreRoster(
  players: RosterPlayer[],
  slots: string[],
  flexOk: string[],
  vm: VarianceModel,
  opts: { weeks?: number; sims?: number; seed?: number } = {},
): RosterScore {
  const weeks = opts.weeks ?? 17;
  const sims = opts.sims ?? 400;
  const rng = mulberry32(opts.seed ?? 20260907);
  const miss = players.map((p) => missProb(vm, p.pos, p.poolRankFrac ?? 0));
  const weekly: number[] = [];
  let emptyWeeks = 0, totalWeeks = 0;
  for (let s = 0; s < sims; s++) {
    let seasonPts = 0;
    for (let w = 0; w < weeks; w++) {
      const avail = players.map((p, i) => ({ ...p, available: rng() >= miss[i] }));
      const r = optimalLineup(avail, slots, flexOk);
      seasonPts += r.starters.reduce((a, x) => a + x.proj, 0);
      totalWeeks++;
      if (r.starters.some((x) => x.name === "(empty)")) emptyWeeks++;
    }
    weekly.push(seasonPts / weeks);
  }
  weekly.sort((a, b) => a - b);
  const q = (u: number) => {
    const i = (weekly.length - 1) * u, lo = Math.floor(i), hi = Math.ceil(i);
    return weekly[lo] + (weekly[hi] - weekly[lo]) * (i - lo);
  };
  return {
    expected: weekly.reduce((a, b) => a + b, 0) / weekly.length,
    p10: q(0.10),
    floor: weekly[0],
    emptySlotRate: totalWeeks ? emptyWeeks / totalWeeks : 0,
  };
}
