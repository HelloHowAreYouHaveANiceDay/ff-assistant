// Compute OUR independent auction $ values from a projected-points table, via VOR -> $ (the
// standard VBD auction formula; see docs/value-methods.md). Pure + unit-testable.

export interface PointsRow { name: string; pos: string; points: number; }
export interface ValueRow { name: string; pos: string; value: number; }

export interface ValueLeague {
  teams: number;
  budget: number;
  rosterSpots: number; // total roster size (for the $1 min-bid reserve)
  starters: Record<string, number>; // dedicated starters per team (QB/RB/WR/TE/K/DST), plus FLEX
}

// rosterSpots MUST equal SIM_LEAGUE.slots.length (12) -- the real league is 16 teams x 12 slots.
// Kept as a literal (not imported from sim.ts, which imports THIS file) and bound by a test.
export const DEFAULT_VALUE_LEAGUE: ValueLeague = {
  teams: 16, budget: 200, rosterSpots: 12,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

/** Replacement baseline points per position = the points of the first NON-startable player at
 *  that position across the whole league (dedicated starters + this position's share of FLEX). */
export function baselines(points: PointsRow[], lg: ValueLeague): Record<string, number> {
  const byPos: Record<string, number[]> = {};
  for (const p of points) (byPos[p.pos] ??= []).push(p.points);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b - a);
  const flexTotal = (lg.starters.FLEX ?? 0) * lg.teams;
  const out: Record<string, number> = {};
  for (const pos of Object.keys(byPos)) {
    const dedicated = (lg.starters[pos] ?? 0) * lg.teams;
    const flexShare = FLEX_ELIGIBLE.includes(pos) ? Math.round(flexTotal / FLEX_ELIGIBLE.length) : 0;
    const startable = dedicated + flexShare;
    const arr = byPos[pos];
    out[pos] = arr[startable] ?? arr[arr.length - 1] ?? 0; // first non-starter's points
  }
  return out;
}

/** Points table -> auction $ values. value = max(1, 1 + VOR x rate), rate spreads the
 *  discretionary money (total budget minus $1 per roster spot) across total positive VOR. */
export function computeValues(points: PointsRow[], lg: ValueLeague = DEFAULT_VALUE_LEAGUE): ValueRow[] {
  const base = baselines(points, lg);
  const withVor = points.map((p) => ({ ...p, vor: Math.max(0, p.points - (base[p.pos] ?? 0)) }));
  const totalVor = withVor.reduce((s, p) => s + p.vor, 0) || 1;
  const discretionary = lg.teams * lg.budget - lg.teams * lg.rosterSpots * 1;
  const rate = discretionary / totalVor;
  return withVor
    .map((p) => ({ name: p.name, pos: p.pos, value: Math.max(1, Math.round(1 + p.vor * rate)) }))
    .sort((a, b) => b.value - a.value);
}
