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

  for (const pos of Object.keys(byPos) as Pos[]) {
    const dedicated = (league.starters[pos] ?? 0) * league.teams;
    // Approximate the FLEX draw on this position: split flex slots across eligible pos.
    const flexShare = FLEX_ELIGIBLE.includes(pos)
      ? Math.round((flex * league.teams) / FLEX_ELIGIBLE.length)
      : 0;
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

/**
 * Rank the AVAILABLE players for the current pick. Score = VOR + VONA, where VONA
 * is the drop-off to the next available player at the same position (positional
 * scarcity). Roster need can further weight this later; kept simple for the sprint.
 */
export function rankForPick(available: Valued[]): Array<Valued & { vona: number; score: number }> {
  const byPos = groupByPos(available);
  const nextBest: Record<string, number> = {};
  for (const pos of Object.keys(byPos) as Pos[]) {
    const sorted = byPos[pos].slice().sort((a, b) => b.vor - a.vor);
    // VONA for the top player at a position = its VOR minus the 2nd best available.
    nextBest[pos] = sorted[1]?.vor ?? 0;
  }
  return available
    .map((p) => {
      const vona = p.vor - (nextBest[p.pos] ?? 0);
      // Only the current best-at-position gets full VONA credit; others ~0.
      const scarcity = vona > 0 ? vona : 0;
      return { ...p, vona: scarcity, score: p.vor + scarcity };
    })
    .sort((a, b) => b.score - a.score);
}

function groupByPos<T extends PlayerRank>(pool: T[]): Record<Pos, T[]> {
  const out = {} as Record<Pos, T[]>;
  for (const p of pool) (out[p.pos] ??= []).push(p);
  return out;
}
