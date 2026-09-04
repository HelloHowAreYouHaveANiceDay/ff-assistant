// VOR / VONA ranking (D8). Given the projection table, the roster slots a league
// starts, and the number of teams, compute each player's Value Over Replacement,
// then when picking, add VONA (Value Over Next Available) to reflect positional
// scarcity given who is still on the board.

import type { PlayerRank, Pos } from "../data/rankings.js";

export interface LeagueSettings {
  teams: number;
  /** Starting slots per team, e.g. { QB:1, RB:2, WR:2, TE:1, FLEX:1, K:1, DST:1 }. */
  starters: Partial<Record<Pos | "FLEX", number>>;
}

const FLEX_ELIGIBLE: Pos[] = ["RB", "WR", "TE"];

/**
 * Replacement baseline per position = projected points of the player at the
 * "last startable" rank across the league (starters * teams, with FLEX shared
 * across RB/WR/TE). Returns projected points at that baseline index per position.
 */
export function replacementBaselines(
  pool: PlayerRank[],
  league: LeagueSettings,
): Record<Pos, number> {
  const byPos = groupByPos(pool);
  const flex = league.starters.FLEX ?? 0;
  const baselines = {} as Record<Pos, number>;

  // FLEX slots are allocated POINTS-WEIGHTED, mirroring baselines() in values.ts (which is the one
  // the shipped bid table uses). An even 3-way split gives TE phantom starting slots it never wins.
  const flexTotal = flex * league.teams;
  const flexPool: { pos: Pos; proj: number }[] = [];
  for (const pos of FLEX_ELIGIBLE as Pos[]) {
    const dedicated = (league.starters[pos] ?? 0) * league.teams;
    const sorted = (byPos[pos] ?? []).slice().sort((a, b) => b.proj - a.proj);
    for (let i = dedicated; i < sorted.length; i++) flexPool.push({ pos, proj: sorted[i].proj });
  }
  flexPool.sort((a, b) => b.proj - a.proj);
  const flexCount = {} as Record<string, number>;
  for (const pos of FLEX_ELIGIBLE) flexCount[pos] = 0;
  for (const p of flexPool.slice(0, flexTotal)) flexCount[p.pos]++;

  for (const pos of Object.keys(byPos) as Pos[]) {
    const dedicated = (league.starters[pos] ?? 0) * league.teams;
    const flexShare = FLEX_ELIGIBLE.includes(pos) ? flexCount[pos] : 0;
    const startableCount = dedicated + flexShare;
    const sorted = byPos[pos].slice().sort((a, b) => b.proj - a.proj);
    // Baseline = the first NON-startable player's projection (replacement level).
    const baselinePlayer = sorted[startableCount] ?? sorted[sorted.length - 1];
    baselines[pos] = baselinePlayer ? baselinePlayer.proj : 0;
  }
  return baselines;
}

export interface Valued extends PlayerRank {
  vor: number;
}

/** Attach VOR to every player in the pool. */
export function withVOR(pool: PlayerRank[], baselines: Record<Pos, number>): Valued[] {
  return pool.map((p) => ({ ...p, vor: p.proj - (baselines[p.pos] ?? 0) }));
}

function groupByPos<T extends PlayerRank>(pool: T[]): Record<Pos, T[]> {
  const out = {} as Record<Pos, T[]>;
  for (const p of pool) (out[p.pos] ??= []).push(p);
  return out;
}

