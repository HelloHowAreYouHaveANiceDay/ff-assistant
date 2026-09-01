// Backtest = the CHAMPIONSHIP harness. Draft with a season's values, then play a real head-to-head
// season + playoffs using that season's ACTUAL WEEKLY results, and see how often OUR team wins the
// title. Weekly variance, bye weeks, and single-elim playoffs are real here -> a top-heavy roster
// with a thin bench correctly loses titles when a stud has a down week or is out. This is what makes
// the strategy verdict trustworthy for "optimize championship wins" (season-points sim can't see it).

import { draftField, mulberry32, SIM_LEAGUE, type SimLeague } from "./sim.js";
import { computeValues, type PointsRow } from "./values.js";
import type { V2Config } from "./strategy.js";

function gauss(rng: () => number): number { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export type Weekly = Map<string, Map<number, number>>; // name -> week -> actual points
const REG_WEEKS = Array.from({ length: 14 }, (_, i) => i + 1); // fantasy weeks 1-14
const PLAYOFF_WEEKS = [15, 16, 17];

export interface BacktestResult { champ: boolean; madePlayoffs: boolean; wins: number; regPoints: number; }

/** Choose the lineup by season projection (intended starters), score by that week's ACTUAL points.
 *  Players with no entry that week (bye/inactive) are not startable -> depth matters. */
function weekScore(roster: { name: string; pos: string; proj: number }[], week: number, weekly: Weekly, lg: SimLeague): number {
  const startable = roster
    .map((p) => ({ pos: p.pos, proj: p.proj, actual: weekly.get(p.name)?.get(week) }))
    .filter((p) => p.actual != null) as { pos: string; proj: number; actual: number }[];
  // pick starters by proj, but the "points" we total are ACTUAL -> reuse startingPoints by feeding
  // proj as the selection value, then map back. Simplest: group, sort by proj, sum actual of chosen.
  const FLEX_OK = new Set(["RB", "WR", "TE"]);
  const byPos: Record<string, { proj: number; actual: number }[]> = {};
  for (const p of startable) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.proj - a.proj);
  let total = 0; const used = new Set<{ proj: number; actual: number }>();
  for (const slot of lg.slots) {
    if (slot === "BE") continue;
    if (slot === "FLEX") { let best: { proj: number; actual: number } | null = null; for (const p of FLEX_OK) { const a = (byPos[p] || []).find((x) => !used.has(x)); if (a && (!best || a.proj > best.proj)) best = a; } if (best) { used.add(best); total += best.actual; } }
    else { const a = (byPos[slot] || []).find((x) => !used.has(x)); if (a) { used.add(a); total += a.actual; } }
  }
  return total;
}

export function runBacktest(seasonPoints: PointsRow[], weekly: Weekly, ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE, projNoiseSd = 0.30): BacktestResult {
  const rng = mulberry32(seed * 104729 + 3);
  // PROJECTION UNCERTAINTY: everyone drafts on a NOISY projection of the season (a stud can be
  // mis-projected), but we SCORE by the real weekly actuals. This is what stops perfect-foresight
  // from trivially rewarding concentration -- your projected stud might bust.
  const proj: PointsRow[] = projNoiseSd > 0
    ? seasonPoints.map((p) => ({ ...p, points: Math.max(0, p.points * (1 + gauss(rng) * projNoiseSd)) }))
    : seasonPoints;
  const projMap = new Map(proj.map((p) => [p.name, p.points]));
  // our bid values come from the SAME noisy projection (edge is STRATEGY here, not private info)
  const useValues = projNoiseSd > 0 ? new Map(computeValues(proj).map((v) => [v.name, v.value])) : ourValues;
  const picks = draftField(proj, useValues, cfg, seed, lg);
  const rosters: { name: string; pos: string; proj: number }[][] = Array.from({ length: lg.teams }, () => []);
  for (const p of picks) rosters[p.team].push({ name: p.name, pos: p.pos, proj: projMap.get(p.name) ?? 0 });

  const wins = new Array(lg.teams).fill(0);
  const totPts = new Array(lg.teams).fill(0);
  // regular season: each week a random pairing of the 16 teams (seeded)
  for (const wk of REG_WEEKS) {
    const order = [...Array(lg.teams).keys()];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const scores = rosters.map((r) => weekScore(r, wk, weekly, lg));
    for (let i = 0; i < lg.teams; i += 2) {
      const a = order[i], b = order[i + 1];
      totPts[a] += scores[a]; totPts[b] += scores[b];
      if (scores[a] >= scores[b]) wins[a]++; else wins[b]++;
    }
  }
  // seed: top 6 by wins then points
  const seeds = [...Array(lg.teams).keys()].sort((x, y) => wins[y] - wins[x] || totPts[y] - totPts[x]).slice(0, 6);
  const madePlayoffs = seeds.includes(0);
  // playoffs: 1,2 bye; wk15: 3v6,4v5; wk16 semis: 1 vs winner(4/5), 2 vs winner(3/6); wk17 final.
  const wkS = (t: number, wk: number) => weekScore(rosters[t], wk, weekly, lg);
  const beat = (a: number, b: number, wk: number) => (wkS(a, wk) >= wkS(b, wk) ? a : b);
  const [s1, s2, s3, s4, s5, s6] = seeds;
  const w36 = beat(s3, s6, 15), w45 = beat(s4, s5, 15);
  const semi1 = beat(s1, w45, 16), semi2 = beat(s2, w36, 16);
  const champ = beat(semi1, semi2, 17);
  return { champ: champ === 0, madePlayoffs, wins: wins[0], regPoints: Math.round(totPts[0]) };
}
