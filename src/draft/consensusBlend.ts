// The FFToday expert-consensus blend, in ONE place, used by BOTH the arbiter (src/ff.ts backtest, the
// `--consensus-blend` lever) and the live board (src/data/assemble.ts). A second copy would be exactly
// the drift hazard this repo has been bitten by: a value transform that ships on the board but is
// validated by a subtly different copy in the backtest is a copy that will one day disagree.
//
// WHAT IT DOES, and why this shape. The feature-sweep found the FFToday consensus RANK the strongest
// residual signal the shipped model is missing (rho -0.127), and the CPCV arbiter found adopting its
// ORDERING worth ~+2.8pp championships (docs/redesign/experimentation-redesign.md, docs/edges.md). So
// this re-ranks a projection's ORDERING toward the consensus WITHOUT touching its point magnitudes:
// blend each player's within-(pos) percentile with the consensus percentile, then REASSIGN the pool's
// own points by slot. The points DISTRIBUTION -- and therefore the prices computeValues derives -- is
// untouched; only WHICH player gets which projection moves. w=0 is identity; a player the consensus
// does not rank keeps his own percentile. Scale-safe across differing list sizes because it works in
// percentile space, not raw points (a QB total dwarfs a TE's).
import type { Database } from "better-sqlite3";

/** FFToday consensus as a within-(season,pos) PERCENTILE (0 = best), keyed `${season}|${pos}|${name_key}`.
 *  raw_fftoday_proj already carries the canonical name_key, so no re-keying here. Preseason by
 *  construction (a projection published before the season), so knowable at draft time; a season FFToday
 *  does not cover is simply absent, and the blend is identity there. */
export function loadConsensusPct(db: Database): Map<string, number> {
  const rows = db.prepare(
    "SELECT season, pos, name_key, proj_fpts FROM raw_fftoday_proj WHERE proj_fpts IS NOT NULL",
  ).all() as { season: number; pos: string; name_key: string; proj_fpts: number }[];
  const byPS = new Map<string, { name_key: string; proj_fpts: number }[]>();
  for (const r of rows) {
    const k = `${r.season}|${r.pos}`;
    (byPS.get(k) ?? byPS.set(k, []).get(k)!).push(r);
  }
  const pct = new Map<string, number>();
  for (const [k, list] of byPS) {
    list.sort((a, b) => b.proj_fpts - a.proj_fpts);
    const n = list.length;
    list.forEach((r, i) => pct.set(`${k}|${r.name_key}`, n > 1 ? i / (n - 1) : 0));
  }
  return pct;
}

/**
 * Re-rank `rows` toward the consensus. `consensusPctOf(pos, name)` returns the consensus percentile in
 * [0,1] for that player (0 = best) or null if unranked. `w` in [0,1]: 0 = identity, 1 = order purely by
 * the consensus where it ranks a player. Returns a NEW array (rows are not mutated); the returned rows
 * carry the same fields with `points` reassigned. Keyed by NAME within position, matching the arbiter
 * that validated the effect.
 */
export function blendConsensus<T extends { name: string; pos: string; points: number }>(
  rows: T[], consensusPctOf: (pos: string, name: string) => number | null, w: number,
): T[] {
  if (!(w > 0) || rows.length === 0) return rows;
  const byPos = new Map<string, T[]>();
  for (const r of rows) (byPos.get(r.pos) ?? byPos.set(r.pos, []).get(r.pos)!).push(r);
  const reassigned = new Map<string, number>();            // name -> reassigned points
  for (const [pos, players] of byPos) {
    const n = players.length;
    if (n < 2) continue;
    const ourSorted = players.slice().sort((a, b) => b.points - a.points);
    const ourPct = new Map<string, number>();
    ourSorted.forEach((r, i) => ourPct.set(r.name, i / (n - 1)));
    const slots = ourSorted.map((r) => r.points);          // the pool's own points, best-first
    const keyed = players.map((r) => {
      const op = ourPct.get(r.name)!;
      const fp = consensusPctOf(pos, r.name);
      return { name: r.name, key: fp != null ? (1 - w) * op + w * fp : op };
    });
    keyed.sort((a, b) => a.key - b.key);
    keyed.forEach((x, i) => reassigned.set(x.name, slots[i]));
  }
  return rows.map((r) => (reassigned.has(r.name) ? { ...r, points: reassigned.get(r.name)! } : r));
}
