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
  /**
   * PER-WEEK POINTS OF THE LAST STARTER THE LEAGUE ROSTERS AT EACH POSITION, plus a `FLEX` entry for
   * the last man taken into the league's flex slots. This is the floor a STARTING slot is measured
   * against, and supplying it is the difference between VOR and a waiver-wire book.
   *
   * WHY IT EXISTS, because it is the defect P30 named. An empty starting slot used to score the
   * STREAMING FLOOR, so the first man at a position was priced by how far he beats the waiver wire.
   * At quarterback that is a very long way -- the wire holds the thirtieth-best quarterback in a
   * league that starts sixteen -- and V3 therefore paid 31-34% of its budget on quarterbacks against
   * a room that pays 8-11% and a SIMULATED roster-aware book that says 15-16%. Nobody in a one-QB
   * league ever has to accept the waiver quarterback: the alternative to the best one is the
   * seventeenth, and that is the comparison a bid is actually about.
   *
   * K AND DST DELIBERATELY KEEP THE STREAMING FLOOR, and so does every bench slot. There the waiver
   * wire really is the alternative -- this league streams both positions at $1-2 all season -- so a
   * last-starter baseline would be modelling a scarcity that does not exist.
   *
   * Absent, every slot falls back to `replacement` and the module behaves exactly as it did before,
   * which is what keeps the existing assertions meaningful rather than silently re-baselined.
   */
  baseline?: Record<string, number>;
}

/** Positions whose alternative really is the waiver wire, so a last-starter baseline does not apply. */
const STREAMED = new Set(["K", "DST"]);

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
 * THE LAST STARTER THE LEAGUE ROSTERS AT EACH POSITION, from the REMAINING pool and the REMAINING
 * league-wide demand -- i.e. `values.ts baselines()`, recomputed at a decision point instead of once.
 *
 * It is deliberately the same construction, index for index: dedicated starting slots across the
 * league, plus this position's POINTS-WEIGHTED share of the flex slots, and the man at that index is
 * the baseline. `baselines()` allocates the flex by filling it greedily from the best leftovers,
 * which is what gives a league with two flex slots a TE baseline of zero flex share; an even
 * three-way split handed TE eleven phantom starting slots and was measured at 13.6% -> 22.2%
 * championships when it was fixed. Reproducing the wrong allocation here would reintroduce that bug
 * inside V3 only, where no existing test looks.
 *
 * WHY IT MOVES DURING THE DRAFT. Demand is scaled by `openFraction`, the share of the league's roster
 * slots still unfilled, so with the room half drafted the baseline sits at half the starting demand
 * INTO A POOL THAT HAS ALSO HALVED. Both ends tighten, which is the behaviour wanted: early, the
 * alternative to the best quarterback is the seventeenth; late, when eleven are gone, it is whoever
 * is actually left. The approximation, named rather than buried, is that the room's remaining slots
 * are assumed to be spread across positions in the SAME proportions as the league template -- the
 * Engine's `DraftState` carries a per-seat open-slot COUNT and no per-position breakdown, so a finer
 * allocation would be invented rather than measured.
 *
 * The returned record carries one entry per position seen in the pool plus a `FLEX` entry: the last
 * man taken into the flex slots, which is the flex's own cutoff and is NOT the max (or the min) of
 * the positional baselines.
 */
export function starterBaselines(
  pool: readonly { pos: string; proj: number }[],
  lg: { teams: number; slots: readonly string[] },
  openFraction: number,
  weeks: number,
  flexOk: readonly string[] = DEFAULT_FLEX,
): Record<string, number> {
  const frac = Math.min(1, Math.max(0, openFraction));
  const byPos = new Map<string, number[]>();
  for (const p of pool) (byPos.get(p.pos) ?? byPos.set(p.pos, []).get(p.pos)!).push(p.proj);
  for (const l of byPos.values()) l.sort((a, b) => b - a);

  const dedicatedSlots = (pos: string) => lg.slots.filter((s) => s === pos).length;
  const flexSlots = lg.slots.filter((s) => FLEX_KEYS.has(s)).length;
  const dedicated = (pos: string) => Math.round(dedicatedSlots(pos) * lg.teams * frac);
  const flexTotal = Math.round(flexSlots * lg.teams * frac);

  // The flex pool: every flex-eligible man beyond his own position's dedicated demand, best first.
  const flexPool: { pos: string; pts: number }[] = [];
  for (const pos of flexOk) {
    const arr = byPos.get(pos) ?? [];
    for (let i = dedicated(pos); i < arr.length; i++) flexPool.push({ pos, pts: arr[i] });
  }
  flexPool.sort((a, b) => b.pts - a.pts);
  const claimed: Record<string, number> = {};
  for (const p of flexPool.slice(0, flexTotal)) claimed[p.pos] = (claimed[p.pos] ?? 0) + 1;

  const out: Record<string, number> = {};
  for (const [pos, arr] of byPos) {
    if (!arr.length) continue;
    const startable = dedicated(pos) + (flexOk.includes(pos) ? (claimed[pos] ?? 0) : 0);
    out[pos] = Math.max(0, (arr[startable] ?? arr[arr.length - 1]) / weeks);
  }
  // The flex's own cutoff: the last man the league's flex slots reach. With nothing left to reach
  // for, the best remaining flex-eligible body is the honest answer rather than zero.
  const lastFlex = flexPool[Math.max(0, Math.min(flexPool.length - 1, flexTotal))];
  if (lastFlex) out.FLEX = Math.max(0, lastFlex.pts / weeks);
  return out;
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

  // THE FLOOR A SLOT SCORES WHEN NOBODY WE HOLD IS UP. A dedicated starting slot at a position the
  // league actually rosters is measured against the LAST STARTER at it; K, DST and the flex are the
  // exceptions, and the flex has its own entry because the three flex-eligible positions do not
  // share a cutoff (a league that gives TE zero flex slots has a TE baseline well above the flex
  // margin, so taking the max over positions would price the flex against the wrong man).
  const floorFor = (slot: string): number => {
    if (FLEX_KEYS.has(slot)) {
      const b = o.baseline?.FLEX;
      if (b != null) return b;
      return Math.max(0, ...flex.map((p) => o.replacement?.[p] ?? 0));
    }
    if (!STREAMED.has(slot)) {
      const b = o.baseline?.[slot];
      if (b != null) return b;
    }
    return o.replacement?.[slot] ?? 0;
  };

  let total = 0;
  for (const slot of start) {
    const rep = floorFor(slot);
    if (FLEX_KEYS.has(slot)) {
      // The flex queue is whatever is LEFT across the eligible positions, merged by points.
      const merged: { pg: number; a: number; pos: string }[] = [];
      for (const pos of flex) {
        const l = q.get(pos) ?? [];
        for (let i = ptr[pos] ?? 0; i < l.length; i++) merged.push({ ...l[i], pos });
      }
      merged.sort((x, y) => y.pg - x.pg);
      total += expected(merged, rep);
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
 *  fall in the league PLAYOFF WEEKS (weeks 14-16 under the current format block), so this is three plain weeks and reduces to a depth-and-availability
 *  question, which is exactly what it should be. */
export function playoffWeekMarginal(roster: readonly LmPlayer[], add: LmPlayer, o: LmOpts, playoffWeeks: readonly number[]): number {
  const strip = (r: readonly LmPlayer[]) => r.map((p) => ({ ...p, bye: null }));
  const before = playoffWeeks.length * expectedWeekPoints(strip(roster), 0, o);
  const after = playoffWeeks.length * expectedWeekPoints(strip([...roster, add]), 0, o);
  return Math.max(0, after - before);
}
