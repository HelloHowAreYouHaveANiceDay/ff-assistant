// Backtest = the CHAMPIONSHIP harness. Draft with a season's values, then play a real head-to-head
// season + playoffs using that season's ACTUAL WEEKLY results, and see how often OUR team wins the
// title. Weekly variance, bye weeks, and single-elim playoffs are real here -> a top-heavy roster
// with a thin bench correctly loses titles when a stud has a down week or is out. This is what makes
// the strategy verdict trustworthy for "optimize championship wins" (season-points sim can't see it).

import { draftField, mulberry32, SIM_LEAGUE, type SimLeague } from "./sim.js";
import { computeValues, type PointsRow } from "./values.js";
import { optimalLineup } from "../inseason/lineup.js";
import type { V2Config } from "./strategy.js";

function gauss(rng: () => number): number { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export type Weekly = Map<string, Map<number, number>>; // name -> week -> actual points
const REG_WEEKS = Array.from({ length: 14 }, (_, i) => i + 1); // fantasy weeks 1-14
const PLAYOFF_WEEKS = [15, 16, 17];

export interface BacktestResult { champ: boolean; madePlayoffs: boolean; wins: number; regPoints: number; }

/** Choose the lineup by a selection value (default = season projection = a NAIVE manager who ignores
 *  weekly matchup/health), score by that week's ACTUAL. A skilled manager passes `sel` = a WEEKLY
 *  projection (actual + forecast noise) -> starts the right players that week. Byes/inactives are
 *  unstartable -> depth matters. */
function weekScore(roster: { name: string; pos: string; proj: number }[], week: number, weekly: Weekly, lg: SimLeague, sel?: Map<string, number>): number {
  const startable = roster
    .map((p) => ({ pos: p.pos, proj: sel ? (sel.get(p.name) ?? p.proj) : p.proj, actual: weekly.get(p.name)?.get(week) }))
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

/** FULL-SYSTEM week score for our team: run the REAL lineup optimizer (inseason/lineup.ts) using OUR
 *  per-game projection, on the players who actually PLAYED that week (availability), score by ACTUAL.
 *  This exercises the production lineup code end-to-end (not a synthetic noise proxy). */
function realWeekScore(roster: { name: string; pos: string; proj: number }[], week: number, weekly: Weekly, lg: SimLeague, perGame: Map<string, number>): number {
  const players = roster.map((p) => ({ name: p.name, pos: p.pos, proj: perGame.get(p.name) ?? p.proj / 17, available: weekly.get(p.name)?.get(week) != null }));
  const res = optimalLineup(players, lg.slots);
  let total = 0;
  for (const s of res.starters) { const a = weekly.get(s.name)?.get(week); if (a != null) total += a; }
  return total;
}

export function runBacktest(seasonPoints: PointsRow[], weekly: Weekly, _ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE, marketSd = 0.30, ourSd?: number, ourWeeklySd?: number, botWeeklySd?: number, realLineup = false, ourWaivers = false): BacktestResult {
  const rngM = mulberry32(seed * 104729 + 3);
  const rngU = mulberry32(seed * 15485863 + 7);
  const us = ourSd == null ? marketSd : ourSd; // our projection error; < marketSd => a VALUE EDGE
  // The MARKET (bots) draft on a consensus projection = truth x (1 + noise, sd marketSd). WE draft
  // on OUR projection = truth x (1 + noise, sd ourSd). If ours is tighter we spot mis-priced players
  // and win value. Everyone SCORES by the real weekly truth; lineups are set by the market view (so
  // this isolates the VALUE edge from any lineup-setting skill).
  const projMarket: PointsRow[] = seasonPoints.map((p) => ({ ...p, points: Math.max(0, p.points * (1 + gauss(rngM) * marketSd)) }));
  const projUs = new Map(seasonPoints.map((p) => [p.name, Math.max(0, p.points * (1 + gauss(rngU) * us))]));
  const projMap = new Map(projMarket.map((p) => [p.name, p.points]));
  const useValues = new Map(computeValues(seasonPoints.map((p) => ({ ...p, points: projUs.get(p.name) ?? 0 }))).map((v) => [v.name, v.value]));
  const picks = draftField(projMarket, useValues, cfg, seed, lg);
  const rosters: { name: string; pos: string; proj: number }[][] = Array.from({ length: lg.teams }, () => []);
  for (const p of picks) rosters[p.team].push({ name: p.name, pos: p.pos, proj: projMap.get(p.name) ?? 0 });

  // In-season LINEUP skill: our team (0) can set each week's lineup by a WEEKLY projection
  // (actual + forecast noise, sd ourWeeklySd) instead of the season average -> starts the right
  // players that week. Bots stay naive (season projection). Isolates the lineup-management edge.
  const ourPerGame = new Map([...projUs.entries()].map(([n, v]) => [n, v / 17])); // our weekly talent estimate
  const selFor = (t: number, wk: number): Map<string, number> | undefined => {
    const sd = t === 0 ? ourWeeklySd : botWeeklySd;
    if (sd == null) return undefined; // naive: start by season projection
    const m = new Map<string, number>();
    for (const p of rosters[t]) { const a = weekly.get(p.name)?.get(wk); if (a != null) m.set(p.name, Math.max(0, a * (1 + gauss(rngU) * sd))); }
    return m;
  };
  // FULL-SYSTEM: our team (0) uses the REAL lineup optimizer on OUR projection; others use the sel model.
  const wkS = (t: number, wk: number) => (realLineup && t === 0)
    ? realWeekScore(rosters[t], wk, weekly, lg, ourPerGame)
    : weekScore(rosters[t], wk, weekly, lg, selFor(t, wk));

  // In-season WAIVERS (our team): each week, using ONLY prior-week production (no lookahead), swap our
  // weakest player for the best-producing free agent whose trailing average clearly beats them. This
  // is the roster-churn edge -- a manager who works the wire upgrades over a stand-pat field.
  const posOf = new Map(projMarket.map((p) => [p.name, p.pos]));
  const drafted = new Set(picks.map((p) => p.name));
  const freeAgents = ourWaivers ? [...weekly.keys()].filter((n) => !drafted.has(n) && posOf.has(n)) : [];
  const trailAvg = (name: string, uptoWk: number): { avg: number; g: number } => {
    let s = 0, g = 0; for (let w = 1; w < uptoWk; w++) { const p = weekly.get(name)?.get(w); if (p != null) { s += p; g++; } }
    return { avg: g ? s / g : 0, g };
  };
  // Rest-of-season per-game estimate (NO lookahead): shrink recent form toward preseason talent --
  // early weeks trust the draft projection, later weeks trust actuals. Stops us dropping a
  // slow-starting stud for a hot-hand free agent who regresses (naive trailing-avg churn LOSES).
  const rosPerGame = (name: string, wk: number): number => {
    const pre = (projMap.get(name) ?? 0) / 17;
    const { avg, g } = trailAvg(name, wk);
    if (g === 0) return pre;
    const w = Math.min(1, (wk - 1) / 9); // weight on actuals ramps to 1 by ~week 10
    return (1 - w) * pre + w * avg;
  };
  const runWaiver = (wk: number) => {
    if (!ourWaivers || wk < 3) return;
    const fa = freeAgents.map((n) => ({ n, ros: rosPerGame(n, wk), g: trailAvg(n, wk).g })).filter((x) => x.g >= 2).sort((a, b) => b.ros - a.ros)[0];
    if (!fa) return;
    const weakest = rosters[0].map((p) => ({ p, ros: rosPerGame(p.name, wk) })).sort((a, b) => a.ros - b.ros)[0];
    if (weakest && fa.ros > weakest.ros + 3) { // only a CLEAR rest-of-season upgrade
      rosters[0] = rosters[0].filter((p) => p !== weakest.p).concat([{ name: fa.n, pos: posOf.get(fa.n)!, proj: projMap.get(fa.n) ?? fa.ros * 17 }]);
      freeAgents.splice(freeAgents.indexOf(fa.n), 1); freeAgents.push(weakest.p.name);
    }
  };

  const wins = new Array(lg.teams).fill(0);
  const totPts = new Array(lg.teams).fill(0);
  for (const wk of REG_WEEKS) {
    runWaiver(wk); // process waivers before this week's games
    const order = [...Array(lg.teams).keys()];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rngM() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const scores = rosters.map((_, t) => wkS(t, wk));
    for (let i = 0; i < lg.teams; i += 2) {
      const a = order[i], b = order[i + 1];
      totPts[a] += scores[a]; totPts[b] += scores[b];
      if (scores[a] >= scores[b]) wins[a]++; else wins[b]++;
    }
  }
  const seeds = [...Array(lg.teams).keys()].sort((x, y) => wins[y] - wins[x] || totPts[y] - totPts[x]).slice(0, 6);
  const madePlayoffs = seeds.includes(0);
  const beat = (a: number, b: number, wk: number) => (wkS(a, wk) >= wkS(b, wk) ? a : b);
  const [s1, s2, s3, s4, s5, s6] = seeds;
  const w36 = beat(s3, s6, 15), w45 = beat(s4, s5, 15);
  const semi1 = beat(s1, w45, 16), semi2 = beat(s2, w36, 16);
  const champ = beat(semi1, semi2, 17);
  return { champ: champ === 0, madePlayoffs, wins: wins[0], regPoints: Math.round(totPts[0]) };
}
