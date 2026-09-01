// In-season weekly LINEUP OPTIMIZER. Given a roster + each player's weekly projection + availability,
// assign the best legal starting lineup and say who to bench + why. Availability is the big lever
// (docs/projections.md): a player on a bye or ruled OUT is NOT startable, so depth covers them.
// Pure + testable; the copresent read/submit (src/inseason/espnTeam.ts) wraps this for the live app.

export interface RosterPlayer {
  name: string;
  pos: string; // QB/RB/WR/TE/K/DST
  proj: number; // this week's projected points (from projections.week)
  available: boolean; // false = bye / OUT / inactive -> not startable
}

export interface LineupResult {
  starters: { slot: string; name: string; pos: string; proj: number }[];
  bench: { name: string; pos: string; proj: number; available: boolean }[];
  totalProj: number;
  flags: string[]; // human-readable notes (unfillable slot, strong bench player, etc.)
}

const FLEX_OK = new Set(["RB", "WR", "TE"]);

/** Assign the highest-projected legal lineup from the AVAILABLE players. `slots` is the starting
 *  template (e.g. QB,RB,RB,WR,WR,TE,FLEX,K,DST); BE entries are ignored (bench is the remainder). */
export function optimalLineup(players: RosterPlayer[], slots: string[]): LineupResult {
  const startSlots = slots.filter((s) => s !== "BE" && s !== "BENCH");
  const byPos: Record<string, RosterPlayer[]> = {};
  for (const p of players) if (p.available) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.proj - a.proj);

  const used = new Set<RosterPlayer>();
  const starters: LineupResult["starters"] = [];
  const flags: string[] = [];
  const take = (pos: string): RosterPlayer | undefined => (byPos[pos] || []).find((x) => !used.has(x));

  for (const slot of startSlots) {
    let pick: RosterPlayer | undefined;
    if (slot === "FLEX") {
      for (const pos of FLEX_OK) { const a = take(pos); if (a && (!pick || a.proj > pick.proj)) pick = a; }
    } else {
      pick = take(slot);
    }
    if (pick) { used.add(pick); starters.push({ slot, name: pick.name, pos: pick.pos, proj: pick.proj }); }
    else { flags.push(`no available player to fill ${slot}`); starters.push({ slot, name: "(empty)", pos: slot, proj: 0 }); }
  }

  const bench = players.filter((p) => !used.has(p)).sort((a, b) => b.proj - a.proj)
    .map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: p.available }));
  const totalProj = Math.round(starters.reduce((s, x) => s + x.proj, 0) * 10) / 10;

  // Flags the user cares about: a benched AVAILABLE player out-projecting a starter at an eligible
  // slot (means the assignment was constrained), and starters that are actually unavailable.
  const weakestStarter = Math.min(...starters.filter((s) => s.proj > 0).map((s) => s.proj));
  for (const b of bench) if (b.available && b.proj > weakestStarter + 0.5) flags.push(`bench ${b.name} (${b.proj}) out-projects a starter -- roster-slot constrained`);
  for (const s of starters) { const pl = players.find((p) => p.name === s.name); if (pl && !pl.available) flags.push(`${s.name} started but not available`); }

  return { starters, bench, totalProj, flags };
}
