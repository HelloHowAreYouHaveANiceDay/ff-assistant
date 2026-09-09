// In-season weekly LINEUP OPTIMIZER. Given a roster + each player's weekly projection + availability,
// assign the best legal starting lineup and say who to bench + why. Availability is the big lever
// (docs/projections.md): a player on a bye or ruled OUT is NOT startable, so depth covers them.
// Pure + testable; the copresent read/submit (src/inseason/espnTeam.ts) wraps this for the live app.

export interface RosterPlayer {
  name: string;
  pos: string; // QB/RB/WR/TE/K/DST -- the position his projection is carried at
  proj: number; // this week's projected points (from projections.week)
  available: boolean; // false = bye / OUT / inactive -> not startable
  /**
   * ELIGIBILITY AS A SET: every position he may be STARTED at, per ESPN's own eligibleSlots.
   * Defaults to `[pos]`, which is what every player on the 2026 board actually is -- so a roster
   * built without this field behaves exactly as it did. See src/data/eligibility.ts.
   */
  eligible?: string[];
}

export interface LineupResult {
  starters: { slot: string; name: string; pos: string; proj: number }[];
  bench: { name: string; pos: string; proj: number; available: boolean }[];
  totalProj: number;
  flags: string[]; // human-readable notes (unfillable slot, strong bench player, etc.)
}

/** Default FLEX eligibility. The league's own `flex_ok` overrides it -- see below. */
const FLEX_OK = new Set(["RB", "WR", "TE"]);

/**
 * Assign the highest-projected legal lineup from the AVAILABLE players. `slots` is the starting
 * template (e.g. QB,RB,RB,WR,WR,TE,FLEX,K,DST); BE entries are ignored (bench is the remainder).
 *
 * `flexOk` defaults to RB/WR/TE. It exists because the store already carries `config.flex_ok` and
 * this function used to ignore it -- three callers were passing it as a third argument that the
 * signature did not accept, which TypeScript would have caught had the check not been run through a
 * pipe that swallowed its exit code. Harmless for THIS league, whose flex really is RB/WR/TE, and
 * silently wrong for a superflex league, where a QB is flex-eligible and would never be started. A
 * config value the code ignores is worse than no config value: it reads as configured behaviour.
 *
 * THE ASSIGNMENT IS OPTIMAL, NOT GREEDY IN SLOT ORDER, and that distinction only starts to matter
 * once eligibility overlaps. Filling slots one at a time -- "give QB its best QB, then RB its best
 * RB, then FLEX whoever is left" -- is correct while every player fits exactly one dedicated slot,
 * because then the positions never compete. A man eligible at both RB and WR breaks that: taking him
 * for RB can strand a better receiver, and the loss is invisible because the greedy answer still
 * looks like a full lineup.
 *
 * The method is the MATROID GREEDY with augmenting paths (Kuhn's algorithm): players are considered
 * in descending projection, and each is either dropped into a free eligible slot or admitted by
 * pushing the current occupants along an augmenting path. That is provably optimal here rather than
 * merely better, because a player's value does not depend on WHICH slot he fills -- so the assignable
 * sets of players form a transversal matroid, and greedy by weight is exactly optimal on a matroid.
 * A Hungarian-style full assignment would also work; this is a dozen lines and the rosters are tiny.
 *
 * Two deliberate tie-breaks keep the single-eligible answer bit-for-bit what the slot-order fill
 * produced: a free slot is always preferred to displacing an occupant, and slots are tried in
 * TEMPLATE ORDER (so a running back lands in RB rather than FLEX). Ties on projection fall to the
 * flex-order of the position and then to roster order, which is the old FLEX tie-break exactly.
 */
export function optimalLineup(players: RosterPlayer[], slots: string[], flexOk?: Iterable<string>): LineupResult {
  const flex = flexOk ? new Set(flexOk) : FLEX_OK;
  const flexOrder = [...flex];
  const startSlots = slots.filter((s) => s !== "BE" && s !== "BENCH");

  const eligOf = (p: RosterPlayer): string[] => (p.eligible && p.eligible.length ? p.eligible : [p.pos]);
  const accepts = (slot: string, p: RosterPlayer): boolean =>
    slot === "FLEX" ? eligOf(p).some((e) => flex.has(e)) : eligOf(p).includes(slot);

  const rank = (p: RosterPlayer) => { const i = flexOrder.indexOf(p.pos); return i < 0 ? flexOrder.length : i; };
  const order = players.filter((p) => p.available).map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.proj - a.p.proj || rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);

  const occupant: (RosterPlayer | undefined)[] = new Array(startSlots.length).fill(undefined);
  const seat = (p: RosterPlayer, visited: Set<number>): boolean => {
    // A FREE slot first, in template order. This is what makes the single-eligible answer identical
    // to the old slot-order fill: nobody is ever displaced while a legal seat is empty.
    for (let s = 0; s < startSlots.length; s++) {
      if (!occupant[s] && accepts(startSlots[s], p)) { occupant[s] = p; return true; }
    }
    // Otherwise push the occupants along an augmenting path.
    for (let s = 0; s < startSlots.length; s++) {
      if (visited.has(s) || !accepts(startSlots[s], p)) continue;
      visited.add(s);
      const cur = occupant[s]!;
      occupant[s] = p;
      if (seat(cur, visited)) return true;
      occupant[s] = cur;
    }
    return false;
  };
  for (const p of order) seat(p, new Set<number>());

  const used = new Set<RosterPlayer>();
  for (const o of occupant) if (o) used.add(o);

  const starters: LineupResult["starters"] = [];
  const flags: string[] = [];
  for (let s = 0; s < startSlots.length; s++) {
    const slot = startSlots[s], pick = occupant[s];
    if (pick) starters.push({ slot, name: pick.name, pos: pick.pos, proj: pick.proj });
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
