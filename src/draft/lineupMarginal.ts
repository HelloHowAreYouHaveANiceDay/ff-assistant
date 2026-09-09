/**
 * THE ROSTER-AWARE MARGINAL A BIDDER CAN AFFORD -- analytic, not simulated.
 *
 * WHY THIS EXISTS BESIDE `rosterMarginal.ts`, which measures the same thing properly. That module
 * runs the season simulator twice per candidate: about 400 ms, which is fine inside an auction tick
 * and impossible inside a backtest. The championship arbiter drafts 192 players a season, 300 times
 * a season, over thirteen seasons; a simulated marginal per bid is roughly ten million season
 * simulations and would take weeks. A strategy that cannot be run through the arbiter cannot be
 * validated at all, and an unvalidated strategy is the one thing this repo will not ship.
 *
 * SO THIS IS A SURROGATE, and it is stated as one. It computes the EXPECTED OPTIMAL-LINEUP POINTS a
 * roster produces over the season, in closed form, and the marginal is the difference that adding
 * one man makes to it. It is the same quantity the simulator spends its trials estimating, minus
 * everything downstream of the lineup: no head-to-head schedule, no seeding, no bracket. What it
 * keeps is exactly the part `computeValues` throws away --
 *
 *   DEPTH        a man only scores when he is the best available body at a slot he is eligible for,
 *                so the second quarterback behind a healthy starter contributes p2 x a2 x (1 - a1),
 *                which is a few points a season rather than a starter's worth;
 *   BYES         in his starter's bye week a1 is zero and the backup collects the whole slot, which
 *                is why two otherwise identical men on different byes are worth different amounts;
 *   STREAMING    a slot nobody can fill scores the measured replacement level, not zero, so punting
 *                a position is priced rather than forbidden;
 *   FLEX         the two flex slots are filled from whoever is left across RB/WR/TE, so a sixth
 *                receiver on a roster with five receiving slots is worth almost nothing.
 *
 * THE APPROXIMATION, named rather than buried: slot assignment is done GREEDILY per week -- each
 * slot takes the expectation of the best available man from its queue and then consumes the queue's
 * nominal head -- instead of taking the expectation over the true joint assignment. That is exact
 * for a single slot and slightly conservative for a position feeding several slots, because it
 * commits the top man to the first slot before knowing whether he is available. The direction of the
 * error is the same for every candidate, and `scripts/marginal-agreement.mjs` measures the rank
 * correlation against the simulated marginal, which is the check that matters.
 */

export interface LmPlayer {
  name: string; pos: string; proj: number; bye?: number | null;
  /**
   * Probability he is available in a week that is not his bye, if the caller knows it PER PLAYER.
   *
   * IT MATTERS ENORMOUSLY AND THE POSITION AVERAGE IS NOT A SUBSTITUTE. The fitted availability rates
   * are per TIER of the full positional pool, and they run 0.91 down to 0.13 at quarterback -- the
   * bottom tiers are men who barely played. Averaging the four tiers models the starting quarterback
   * of a sixteen-team league as playing eight games of seventeen, which triples what a backup is
   * worth and is exactly how the first V3 draft came away with three quarterbacks. A drafted player
   * is a top-tier player and should be priced as one.
   */
  avail?: number;
}

export interface LmOpts {
  /** The league's starting template plus bench, e.g. QB,RB,WR,TE,FLEX,FLEX,DST,K,BE,BE,BE,BE. */
  slots: string[];
  flexOk?: readonly string[];
  /** NFL weeks a season projection is spread over. */
  weeks: number;
  /** Probability a man of this position is available in a week that is not his bye. */
  avail: Record<string, number>;
  /** Per-WEEK points freely available off waivers at each position -- the streaming floor. */
  replacement?: Record<string, number>;
}

const isBench = (s: string) => /^(BE|BENCH|IR|ER)$/i.test(s);
const FLEX_KEYS = new Set(["FLEX", "OP", "RB/WR", "WR/TE"]);
const DEFAULT_FLEX = ["RB", "WR", "TE"];

/**
 * AVAILABILITY BY POSITION, derived from the fitted variance model rather than asserted.
 *
 * `data/variance-model.json` holds a per-position, per-TIER games/17 rate, and the tiers are
 * fractions of the FULL positional pool. `tiers` here says which of them a drafted player occupies:
 * a sixteen-team league rosters the top third or so of every position, so the honest default is the
 * top two tiers, NOT all four. Averaging all four models a starting quarterback as playing eight
 * games of seventeen (0.47 against a real 0.91) and triples what a backup is worth -- which is
 * precisely how the first V3 draft came away holding three quarterbacks.
 *
 * A caller that knows a player's rank should set `LmPlayer.avail` per man instead; this is the
 * fallback for one that does not.
 */
export function availFromVarianceModel(vm: { pos: Record<string, { avail: number[] }> }, tiers = 2): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pos, m] of Object.entries(vm.pos ?? {})) {
    const a = (m.avail ?? []).filter((x) => Number.isFinite(x)).slice(0, Math.max(1, tiers));
    if (a.length) out[pos] = Math.min(1, Math.max(0.05, a.reduce((x, y) => x + y, 0) / a.length));
  }
  return out;
}

/** Per-player availability from the same fitted model, tiered by his rank within the positional
 *  pool -- the same tiering `simulateSeasons` uses, so the bidder and the simulator agree about who
 *  is fragile. */
export function availForRank(
  vm: { tiers?: number; pos: Record<string, { avail: number[] }> },
  pos: string,
  rank: number,
  of: number,
): number | undefined {
  const m = vm.pos?.[pos];
  if (!m?.avail?.length) return undefined;
  const n = vm.tiers ?? m.avail.length;
  const t = Math.min(n - 1, Math.max(0, Math.floor((rank / Math.max(1, of)) * n)));
  const a = m.avail[Math.min(t, m.avail.length - 1)];
  return Number.isFinite(a) ? Math.min(1, Math.max(0.05, a)) : undefined;
}

/**
 * Expected optimal-lineup points for ONE week.
 *
 * `week` decides byes only. Pass 0 for a week nobody is off, which is what the season total below
 * uses for the majority of weeks.
 */
export function expectedWeekPoints(roster: readonly LmPlayer[], week: number, o: LmOpts): number {
  const flex = o.flexOk ?? DEFAULT_FLEX;
  const start = o.slots.filter((s) => !isBench(s));
  // Per-position queue of (per-game points, availability this week), best first.
  const q = new Map<string, { pg: number; a: number }[]>();
  for (const p of roster) {
    const a = (p.bye != null && Number(p.bye) === week) ? 0 : (p.avail ?? o.avail[p.pos] ?? 0.85);
    const list = q.get(p.pos) ?? q.set(p.pos, []).get(p.pos)!;
    list.push({ pg: p.proj / o.weeks, a });
  }
  for (const l of q.values()) l.sort((x, y) => y.pg - x.pg);
  const ptr: Record<string, number> = {};

  /** E[best available] over a queue, plus the streaming floor for the case nobody is up. */
  const expected = (cands: { pg: number; a: number }[], floor: number): number => {
    let e = 0, none = 1;
    for (const c of cands) { e += none * c.a * c.pg; none *= 1 - c.a; }
    return e + none * floor;
  };

  let total = 0;
  for (const slot of start) {
    const rep = o.replacement?.[slot] ?? 0;
    if (FLEX_KEYS.has(slot)) {
      // The flex queue is whatever is LEFT across the eligible positions, merged by points.
      const merged: { pg: number; a: number; pos: string }[] = [];
      for (const pos of flex) {
        const l = q.get(pos) ?? [];
        for (let i = ptr[pos] ?? 0; i < l.length; i++) merged.push({ ...l[i], pos });
      }
      merged.sort((x, y) => y.pg - x.pg);
      const floor = Math.max(0, ...flex.map((p) => o.replacement?.[p] ?? 0));
      total += expected(merged, floor);
      if (merged.length) ptr[merged[0].pos] = (ptr[merged[0].pos] ?? 0) + 1;
    } else {
      const l = q.get(slot) ?? [];
      const from = ptr[slot] ?? 0;
      total += expected(l.slice(from), rep);
      if (from < l.length) ptr[slot] = from + 1;
    }
  }
  return total;
}

/**
 * Expected optimal-lineup points over the whole season.
 *
 * Only the weeks that CONTAIN a bye are evaluated individually; every other week is the same
 * calculation and is multiplied. That is not an approximation -- byes are the only thing `week`
 * changes -- and it takes a 17-week loop down to about eight evaluations.
 */
export function expectedSeasonPoints(roster: readonly LmPlayer[], o: LmOpts, weeksOverride?: readonly number[]): number {
  const byes = new Set<number>();
  for (const p of roster) if (p.bye != null && Number(p.bye) > 0) byes.add(Number(p.bye));
  if (weeksOverride) {
    let t = 0;
    for (const w of weeksOverride) t += expectedWeekPoints(roster, byes.has(w) ? w : 0, o);
    return t;
  }
  const plain = expectedWeekPoints(roster, 0, o);
  let total = plain * (o.weeks - byes.size);
  for (const w of byes) total += expectedWeekPoints(roster, w, o);
  return total;
}

/**
 * WHAT ADDING ONE MAN IS WORTH TO THIS ROSTER, in expected starting-lineup points.
 *
 * Non-negative by construction: a man you never start cannot cost you points, and the greedy
 * assignment can produce a tiny negative from the queue-consumption approximation.
 */
export function lineupMarginal(roster: readonly LmPlayer[], add: LmPlayer, o: LmOpts, weeksOverride?: readonly number[]): number {
  const before = expectedSeasonPoints(roster, o, weeksOverride);
  const after = expectedSeasonPoints([...roster, add], o, weeksOverride);
  return Math.max(0, after - before);
}

/**
 * THE BUDGET PATH: what our remaining money buys, one upgrade at a time.
 *
 * This is the analytic twin of `MarginalBook.budgetCurve` and it exists for the same reason -- to
 * turn a marginal in POINTS into a price in DOLLARS -- and against the same failure. The obvious
 * rule, "his share of the total marginal value our budget can buy", prices the best player in the
 * draft at about a twelfth of the budget, because twelve marginals each measured against the SAME
 * empty roster are nearly equal: every one of them is mostly "a body where there was a replacement".
 * You cannot buy twelve first running backs. The money's real return is DIMINISHING, and a stud is
 * worth far more than his share of a sum that double-counts the same slot twelve times.
 *
 * So the money is walked instead: fill every open slot with the cheapest legal body, then repeatedly
 * take the best points-per-dollar upgrade still affordable, recording the cumulative spend and the
 * resulting expected lineup points. Inverting that path -- how much money must we give up to lose as
 * much as this man gains -- is the indifference price, and it is bounded by the budget by
 * construction because it is the same money on both sides.
 *
 * The upgrade is CHOSEN on a cheap weighted-projection proxy and then SCORED with the real
 * expectation, which is what keeps this affordable inside a two-hundred-pick auction.
 */
export interface PathPoint { spent: number; value: number }

const BENCH_WEIGHT: Record<string, number> = { QB: 0.05, K: 0.02, DST: 0.02, RB: 0.25, WR: 0.25, TE: 0.15 };

export function budgetPath(
  roster: readonly LmPlayer[],
  openSlots: readonly string[],
  pool: readonly LmPlayer[],
  priceOf: (p: LmPlayer) => number,
  budget: number,
  o: LmOpts,
  limits: { poolSize?: number; steps?: number } = {},
): PathPoint[] {
  const flex = o.flexOk ?? DEFAULT_FLEX;
  const accepts = (slot: string, pos: string) => isBench(slot) || (FLEX_KEYS.has(slot) ? flex.includes(pos) : slot === pos);
  const price = (p: LmPlayer) => Math.max(1, Math.round(priceOf(p)));
  const wproj = (slot: string, p: LmPlayer) => (isBench(slot) ? (BENCH_WEIGHT[p.pos] ?? 0.2) : 1) * p.proj;
  // THE CANDIDATE SET NEEDS BOTH ENDS OF THE MARKET. Truncating the pool to the top N by projection
  // -- which is what the first version did -- leaves it with no DOLLAR BODIES at all, so the path
  // starts from an empty roster rather than from a legal cheap one, and the whole curve measures
  // "what the budget buys instead of nothing" rather than "instead of the free option". It priced
  // the best player in the draft at $7.
  const ranked = [...pool].sort((a, b) => b.proj - a.proj);
  const cands = ranked.slice(0, limits.poolSize ?? 60);
  const have = new Set(cands.map((p) => p.name));
  for (const pos of new Set(ranked.map((p) => p.pos))) {
    const cheap = ranked.filter((p) => p.pos === pos && price(p) <= 1).slice(0, 4);
    for (const c of cheap) if (!have.has(c.name)) { cands.push(c); have.add(c.name); }
  }
  const opts: LmOpts = { ...o, slots: [...roster.map(() => "BE"), ...openSlots] };

  const filled: (LmPlayer | null)[] = openSlots.map(() => null);
  const taken = new Set<string>();
  let money = budget, spent = 0;
  // Cheapest legal body first, scarcest slot first.
  const order = openSlots.map((_s, i) => i).sort((a, b) => {
    const rank = (s: string) => (isBench(s) ? 2 : FLEX_KEYS.has(s) ? 1 : 0);
    return rank(openSlots[a]) - rank(openSlots[b]);
  });
  for (const i of order) {
    let hit: LmPlayer | null = null;
    for (const p of cands) {
      if (taken.has(p.name) || !accepts(openSlots[i], p.pos) || price(p) > 1) continue;
      if (!hit || wproj(openSlots[i], p) > wproj(openSlots[i], hit)) hit = p;
    }
    if (!hit || price(hit) > money) continue;
    taken.add(hit.name); filled[i] = hit; money -= price(hit); spent += price(hit);
  }
  const current = () => [...roster, ...filled.filter((x): x is LmPlayer => x != null)];
  const path: PathPoint[] = [{ spent, value: expectedSeasonPoints(current(), opts) }];

  for (let step = 0; step < (limits.steps ?? 40); step++) {
    let best: { i: number; p: LmPlayer; ratio: number; cost: number } | null = null;
    for (let i = 0; i < openSlots.length; i++) {
      const cur = filled[i];
      const curCost = cur ? price(cur) : 0;
      const rep = cur ? wproj(openSlots[i], cur) : 0;
      for (const p of cands) {
        if (taken.has(p.name) || !accepts(openSlots[i], p.pos)) continue;
        const extra = price(p) - curCost;
        if (extra <= 0 || extra > money) continue;
        const gain = wproj(openSlots[i], p) - rep;
        if (gain <= 0) continue;
        const ratio = gain / extra;
        if (!best || ratio > best.ratio) best = { i, p, ratio, cost: extra };
      }
    }
    if (!best) break;
    const old = filled[best.i];
    if (old) taken.delete(old.name);
    taken.add(best.p.name); filled[best.i] = best.p; money -= best.cost; spent += best.cost;
    path.push({ spent, value: expectedSeasonPoints(current(), opts) });
  }
  // Monotone in VALUE: the proxy chooses the upgrade, so an occasional step can score slightly
  // worse under the real expectation. Left in, the inversion below would be multi-valued.
  for (let i = 1; i < path.length; i++) path[i].value = Math.max(path[i].value, path[i - 1].value);
  return path;
}

/** Invert the path: the money we must give up to lose as much as `marginal` gains. */
export function priceFromPath(path: readonly PathPoint[], marginal: number, budget: number): number {
  if (!(marginal > 0)) return 0;
  // NOTHING ELSE TO BUY. A path with one point means the money cannot improve the roster at all, so
  // giving it up costs nothing and the man is worth every dollar of it. Returning 0 here -- which is
  // what "no data, no price" looks like -- would make us refuse to bid precisely when the pool has
  // run dry and the man on the block is the only thing left worth having.
  if (path.length < 2) return budget;
  const end = path[path.length - 1];
  for (let i = path.length - 2; i >= 0; i--) {
    const loss = end.value - path[i].value;
    if (loss >= marginal) {
      const prev = path[i + 1], lossPrev = end.value - prev.value;
      const span = loss - lossPrev;
      const frac = span > 0 ? (marginal - lossPrev) / span : 0;
      const level = prev.spent - frac * (prev.spent - path[i].spent);
      return Math.max(0, Math.min(budget, Math.round(end.spent - level)));
    }
  }
  return budget;
}

/** The same marginal restricted to the fantasy playoff weeks -- the SECONDARY objective. Byes do not
 *  fall in weeks 15-17, so this is three plain weeks and reduces to a depth-and-availability
 *  question, which is exactly what it should be. */
export function playoffWeekMarginal(roster: readonly LmPlayer[], add: LmPlayer, o: LmOpts, playoffWeeks: readonly number[]): number {
  const strip = (r: readonly LmPlayer[]) => r.map((p) => ({ ...p, bye: null }));
  const before = playoffWeeks.length * expectedWeekPoints(strip(roster), 0, o);
  const after = playoffWeeks.length * expectedWeekPoints(strip([...roster, add]), 0, o);
  return Math.max(0, after - before);
}
