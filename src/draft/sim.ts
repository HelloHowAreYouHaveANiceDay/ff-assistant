// Draft field + one-shot season-points sim. `draftField` runs the auction (our real strategy vs a
// stud-overpaying bot field) and returns every team's roster -- reused by runSim (season points)
// AND by backtest.ts (real weekly schedule + playoffs -> championship rate). See docs/validation.md.

import { makeV2Strategy, type DraftState, type V2Config } from "./strategy.js";
import { computeValues, DEFAULT_VALUE_LEAGUE, type PointsRow } from "./values.js";

export interface SimLeague { teams: number; budget: number; slots: string[]; }
export const SIM_LEAGUE: SimLeague = {
  teams: 16, budget: 200,
  slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE", "BE", "BE", "BE", "BE", "BE"],
};
const FLEX_OK = new Set(["RB", "WR", "TE"]);

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rng: () => number): number { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export interface Pick { name: string; pos: string; team: number; price: number; }

/** Run the auction. Our team (0) uses the real makeV2Strategy; bots overpay for studs (this
 *  league's tendency). Returns every won player with its team + price. Deterministic per seed. */
export function draftField(points: PointsRow[], ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE): Pick[] {
  const rng = mulberry32(seed);
  const posMap = new Map(points.map((p) => [p.name, p.pos]));
  const trueVal = new Map(computeValues(points, DEFAULT_VALUE_LEAGUE).map((v) => [v.name, v.value]));
  const studRank = new Map([...trueVal.entries()].sort((a, b) => b[1] - a[1]).map(([n], i) => [n, i]));

  const teams: { us: boolean; budget: number; slots: (string | null)[] }[] = [];
  for (let i = 0; i < lg.teams; i++) teams.push({ us: i === 0, budget: lg.budget, slots: lg.slots.map(() => null) });
  const picks: Pick[] = [];

  const openIdxFor = (t: { slots: (string | null)[] }, pos: string): number => {
    let i = t.slots.findIndex((s, k) => t.slots[k] === null && lg.slots[k] === pos);
    if (i >= 0) return i;
    if (FLEX_OK.has(pos)) { i = t.slots.findIndex((s, k) => t.slots[k] === null && lg.slots[k] === "FLEX"); if (i >= 0) return i; }
    return t.slots.findIndex((s, k) => t.slots[k] === null && lg.slots[k] === "BE");
  };
  const openCount = (t: { slots: (string | null)[] }) => t.slots.filter((s) => s === null).length;
  const affordable = (t: { budget: number; slots: (string | null)[] }) => t.budget - Math.max(0, openCount(t) - 1);
  const slotsOpenByKey = (t: { slots: (string | null)[] }): Record<string, number> => {
    const out: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
    t.slots.forEach((s, k) => { if (s === null) { const key = lg.slots[k] === "BE" ? "BENCH" : lg.slots[k]; out[key] = (out[key] ?? 0) + 1; } });
    return out;
  };

  const ourStrat = makeV2Strategy(cfg);
  const available = new Set(points.map((p) => p.name));
  let nom = 0, guard = 0;
  while (teams.some((t) => openCount(t) > 0) && available.size > 0 && guard++ < 6000) {
    let n = nom % lg.teams, tries = 0;
    while (openCount(teams[n]) === 0 && tries++ < lg.teams) n = (n + 1) % lg.teams;
    nom = n + 1;
    const nt = teams[n];
    const cand = [...available].map((name) => ({ name, pos: posMap.get(name) ?? "", v: trueVal.get(name) ?? 0 }))
      .filter((c) => c.pos && openIdxFor(nt, c.pos) >= 0).sort((a, b) => b.v - a.v)[0];
    if (!cand) { available.delete([...available][0]); continue; }
    const { name, pos } = cand;

    let bestTeam = -1, bestMax = 0, secondMax = 0;
    for (let ti = 0; ti < lg.teams; ti++) {
      const t = teams[ti];
      if (openIdxFor(t, pos) < 0) continue;
      const aff = affordable(t);
      if (aff < 1) continue;
      let max: number;
      if (t.us) {
        const state: DraftState = { myBudget: t.budget, mySlots: slotsOpenByKey(t), myRoster: [], onBlock: { name, pos: pos as never, team: "", espnPreDraftVal: ourValues.get(name) ?? null }, currentOffer: null, secondsLeft: null, iAmHighBidder: false, board: [], teams: [] };
        max = Math.min(ourStrat.maxBid(state).maxBid, aff);
      } else {
        const base = trueVal.get(name) ?? 1;
        const rank = studRank.get(name) ?? 999;
        const prem = rank < 24 ? 1.15 + rng() * 0.35 : rank < 60 ? 1.0 + rng() * 0.15 : 0.6 + rng() * 0.5;
        max = Math.min(Math.round(base * prem), aff);
      }
      if (max > bestMax) { secondMax = bestMax; bestTeam = ti; bestMax = max; }
      else if (max > secondMax) secondMax = max;
    }
    available.delete(name);
    if (bestTeam < 0 || bestMax < 1) continue;
    const price = Math.max(1, Math.min(bestMax, secondMax + 1));
    const t = teams[bestTeam];
    t.slots[openIdxFor(t, pos)] = name; t.budget -= price;
    picks.push({ name, pos, team: bestTeam, price });
  }
  return picks;
}

export interface SimResult { ourPoints: number; ourRank: number; fieldMean: number; ourSpentTop3: number; teams: number; }

/** One-shot season-points evaluation (fast; a rough proxy). For championship rate use backtest. */
export function runSim(points: PointsRow[], ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE): SimResult {
  const rng = mulberry32(seed * 7919 + 1);
  const realized = new Map(points.map((p) => [p.name, Math.max(0, p.points * (1 + gauss(rng) * 0.35))]));
  const picks = draftField(points, ourValues, cfg, seed, lg);
  const scores: number[] = [];
  for (let ti = 0; ti < lg.teams; ti++) scores.push(startingPoints(picks.filter((r) => r.team === ti).map((r) => ({ pos: r.pos, points: realized.get(r.name) ?? 0 })), lg));
  const ours = scores[0];
  const rank = [...scores].sort((a, b) => b - a).indexOf(ours) + 1;
  const ourTop3 = picks.filter((r) => r.team === 0).sort((a, b) => b.price - a.price).slice(0, 3).reduce((s, r) => s + r.price, 0);
  return { ourPoints: Math.round(ours), ourRank: rank, fieldMean: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length), ourSpentTop3: ourTop3, teams: lg.teams };
}

/** Best legal starting-lineup points for a set of rostered players (used for weekly + season). */
export function startingPoints(players: { pos: string; points: number }[], lg: SimLeague): number {
  const byPos: Record<string, { points: number }[]> = {};
  for (const p of players) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.points - a.points);
  let total = 0; const used = new Set<{ points: number }>();
  for (const slot of lg.slots) {
    if (slot === "BE") continue;
    if (slot === "FLEX") { let best: { points: number } | null = null; for (const p of FLEX_OK) { const a = (byPos[p] || []).find((x) => !used.has(x)); if (a && (!best || a.points > best.points)) best = a; } if (best) { used.add(best); total += best.points; } }
    else { const a = (byPos[slot] || []).find((x) => !used.has(x)); if (a) { used.add(a); total += a.points; } }
  }
  return total;
}
