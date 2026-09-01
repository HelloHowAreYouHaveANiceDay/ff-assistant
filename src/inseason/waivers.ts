// Waiver-wire COPILOT (recommend, don't auto-churn). The backtest is decisive: aggressive automated
// waiver churn is NEGATIVE-EV in a deep 16-team league (36% -> 24% championships) -- the pool is
// mostly replacement-level, so swaps drop real drafted talent for hot-hand noise. So this SURFACES
// only clear rest-of-season upgrades for human judgment; it does not auto-drop. Real waiver value is
// injury-replacement + genuine breakouts, which a human confirms.

export interface RosPlayer { name: string; pos: string; ros: number; }        // our roster, ROS per-game
export interface FreeAgent { name: string; pos: string; ros: number; gp: number; } // available, ROS per-game + games played

export interface WaiverRec {
  add: string; addPos: string; addRos: number;
  drop: string; dropRos: number;
  gain: number;          // ROS per-game upgrade
  faab: number;          // suggested FAAB bid (% of a $100 budget), gated by gain
  note: string;
}

/** Recommend CLEAR upgrades only (default gain >= 4 pts/game), same-position or bench-safe, ranked by
 *  gain. Conservative on purpose (the backtest shows churn hurts). Returns [] if nothing is worth it. */
export function waiverTargets(roster: RosPlayer[], freeAgents: FreeAgent[], opts: { minGain?: number; minGamesPlayed?: number; faabBudget?: number } = {}): WaiverRec[] {
  const minGain = opts.minGain ?? 4;
  const minGp = opts.minGamesPlayed ?? 3;
  const budget = opts.faabBudget ?? 100;
  const recs: WaiverRec[] = [];
  const fas = freeAgents.filter((f) => f.gp >= minGp).sort((a, b) => b.ros - a.ros);
  for (const fa of fas.slice(0, 8)) {
    // our weakest player the add could replace: same position (safe -- no roster-hole created)
    const cand = roster.filter((p) => p.pos === fa.pos).sort((a, b) => a.ros - b.ros)[0]
      ?? roster.slice().sort((a, b) => a.ros - b.ros)[0]; // else our overall weakest
    if (!cand) continue;
    const gain = fa.ros - cand.ros;
    if (gain < minGain) continue;
    // FAAB scales with the upgrade size (bigger edge -> bid more), capped.
    const faab = Math.min(budget, Math.round(Math.min(0.5, gain / 12) * budget));
    recs.push({ add: fa.name, addPos: fa.pos, addRos: Math.round(fa.ros * 10) / 10, drop: cand.name, dropRos: Math.round(cand.ros * 10) / 10, gain: Math.round(gain * 10) / 10, faab, note: `${fa.pos} upgrade +${gain.toFixed(1)}/gm` });
  }
  return recs.sort((a, b) => b.gain - a.gain);
}
