// Offline auction-draft SIMULATOR = the validation harness. Drafts our team (using the REAL
// makeV2Strategy) against a bot field calibrated to seacaptaindate.com's stud-overpay behavior,
// then scores every roster by its best starting-lineup projected points (the ground truth from
// data/points.csv). Run many seeds -> compare our roster points/rank across value tables and
// strategy configs to see if a change is better or a regression. Deterministic per seed.

import { makeV2Strategy, type DraftState, type V2Config } from "./strategy.js";
import { computeValues, DEFAULT_VALUE_LEAGUE, type PointsRow } from "./values.js";

export interface SimLeague { teams: number; budget: number; slots: string[]; }
// 16-man roster: 9 starters + 7 bench (matches a typical ESPN auction roster).
export const SIM_LEAGUE: SimLeague = {
  teams: 16, budget: 200,
  slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE", "BE", "BE", "BE", "BE", "BE"],
};
const FLEX_OK = new Set(["RB", "WR", "TE"]);

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Standard normal via Box-Muller (from a uniform rng).
function gauss(rng: () => number): number { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export interface SimResult { ourPoints: number; ourRank: number; fieldMean: number; ourSpentTop3: number; teams: number; }

export function runSim(points: PointsRow[], ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE): SimResult {
  const rng = mulberry32(seed);
  // points.csv is our pre-draft PROJECTION. What actually happens (what we score by) is a noisy
  // realization -> a stud can bust. This is what makes concentration risky and balance valuable;
  // without it the sim has perfect foresight and always favors buying the priciest projected studs.
  const projSd = 0.35; // per-player projection error (sd, proportional)
  const pointsMap = new Map(points.map((p) => [p.name, Math.max(0, p.points * (1 + gauss(rng) * projSd))])); // REALIZED
  // "True" market value from PROJECTIONS (what a rational room pays); bots anchor to this.
  const trueVal = new Map(computeValues(points, DEFAULT_VALUE_LEAGUE).map((v) => [v.name, v.value]));
  const rankByVal = [...trueVal.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const studRank = new Map(rankByVal.map((n, i) => [n, i])); // 0 = biggest stud

  const teams: { us: boolean; budget: number; slots: (string | null)[] }[] = [];
  for (let i = 0; i < lg.teams; i++) teams.push({ us: i === 0, budget: lg.budget, slots: lg.slots.map(() => null) });
  const roster: { name: string; pos: string; points: number; price: number; team: number }[] = [];

  const openIdxFor = (t: { slots: (string | null)[] }, pos: string): number => {
    let i = t.slots.findIndex((s, k) => t.slots[k] === null && lg.slots[k] === pos);
    if (i >= 0) return i;
    if (FLEX_OK.has(pos)) { i = t.slots.findIndex((s, k) => t.slots[k] === null && lg.slots[k] === "FLEX"); if (i >= 0) return i; }
    i = t.slots.findIndex((s, k) => t.slots[k] === null && lg.slots[k] === "BE"); return i;
  };
  const openCount = (t: { slots: (string | null)[] }) => t.slots.filter((s) => s === null).length;
  const affordable = (t: { budget: number; slots: (string | null)[] }) => t.budget - Math.max(0, openCount(t) - 1); // $1/other slot reserve

  const ourStrat = makeV2Strategy(cfg);
  const available = new Set(points.map((p) => p.name));
  let nom = 0;
  let guard = 0;
  while ([...teams].some((t) => openCount(t) > 0) && available.size > 0 && guard++ < 5000) {
    // nominating team = next team with an open slot
    let n = nom % lg.teams; let tries = 0;
    while (openCount(teams[n]) === 0 && tries++ < lg.teams) n = (n + 1) % lg.teams;
    nom = n + 1;
    const nt = teams[n];
    // nominate: the highest true-value available player that fits an open slot for the nominator
    const cand = [...available].map((name) => ({ name, pos: posOf(name, points), v: trueVal.get(name) ?? 0 }))
      .filter((c) => c.pos && openIdxFor(nt, c.pos) >= 0)
      .sort((a, b) => b.v - a.v)[0];
    if (!cand) { available.delete([...available][0]); continue; }
    const { name, pos } = cand;

    // each team's max bid
    let bestTeam = -1, bestMax = 0, secondMax = 0;
    for (let ti = 0; ti < lg.teams; ti++) {
      const t = teams[ti];
      if (openIdxFor(t, pos) < 0) continue;
      const aff = affordable(t);
      if (aff < 1) continue;
      let max: number;
      if (t.us) {
        const state: DraftState = {
          myBudget: t.budget,
          mySlots: slotsOpenByKey(t, lg),
          myRoster: [], onBlock: { name, pos: pos as never, team: "", espnPreDraftVal: ourValues.get(name) ?? null },
          currentOffer: null, secondsLeft: null, iAmHighBidder: false, board: [], teams: [],
        };
        max = Math.min(ourStrat.maxBid(state).maxBid, aff);
      } else {
        // bot: anchor to true value, OVERPAY for studs (this league's tendency), plus noise.
        const base = trueVal.get(name) ?? 1;
        const rank = studRank.get(name) ?? 999;
        const studPrem = rank < 24 ? 1.15 + rng() * 0.35 : rank < 60 ? 1.0 + rng() * 0.15 : 0.6 + rng() * 0.5; // top overpaid, deep cheap
        max = Math.min(Math.round(base * studPrem), aff);
      }
      if (max > bestMax) { secondMax = bestMax; bestTeam = ti; bestMax = max; }
      else if (max > secondMax) secondMax = max;
    }
    available.delete(name);
    if (bestTeam < 0 || bestMax < 1) continue; // nobody could take it
    const price = Math.max(1, Math.min(bestMax, secondMax + 1));
    const t = teams[bestTeam];
    const idx = openIdxFor(t, pos); t.slots[idx] = name; t.budget -= price;
    roster.push({ name, pos, points: pointsMap.get(name) ?? 0, price, team: bestTeam });
  }

  // score each team = best starting lineup points
  const scores: number[] = [];
  for (let ti = 0; ti < lg.teams; ti++) scores.push(startingPoints(roster.filter((r) => r.team === ti), lg));
  const ours = scores[0];
  const sorted = [...scores].sort((a, b) => b - a);
  const rank = sorted.indexOf(ours) + 1;
  const ourTop3 = roster.filter((r) => r.team === 0).sort((a, b) => b.price - a.price).slice(0, 3).reduce((s, r) => s + r.price, 0);
  return { ourPoints: Math.round(ours), ourRank: rank, fieldMean: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length), ourSpentTop3: ourTop3, teams: lg.teams };
}

function posOf(name: string, points: PointsRow[]): string { return points.find((p) => p.name === name)?.pos ?? ""; }
function slotsOpenByKey(t: { slots: (string | null)[] }, lg: SimLeague): Record<string, number> {
  const out: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
  t.slots.forEach((s, k) => { if (s === null) { const key = lg.slots[k] === "BE" ? "BENCH" : lg.slots[k]; out[key] = (out[key] ?? 0) + 1; } });
  return out;
}
// Best legal starting lineup points: fill QB/RB/RB/WR/WR/TE/FLEX/K/DST greedily by points.
function startingPoints(players: { name: string; pos: string; points: number }[], lg: SimLeague): number {
  const byPos: Record<string, { points: number }[]> = {};
  for (const p of players) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.points - a.points);
  let total = 0; const used = new Set<{ points: number }>();
  const take = (pos: string) => { const a = (byPos[pos] || []).find((x) => !used.has(x)); if (a) { used.add(a); total += a.points; } };
  for (const slot of lg.slots) {
    if (slot === "BE") continue;
    if (slot === "FLEX") { let best: { points: number } | null = null; for (const p of FLEX_OK) { const a = (byPos[p] || []).find((x) => !used.has(x)); if (a && (!best || a.points > best.points)) best = a; } if (best) { used.add(best); total += best.points; } }
    else take(slot);
  }
  return total;
}
