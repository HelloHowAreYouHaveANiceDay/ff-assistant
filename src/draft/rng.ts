/**
 * IDENTITY-KEYED RANDOM DRAWS -- what makes common random numbers actually work.
 *
 * THE BUG THIS FIXES. season.ts drew every random value from ONE sequential stream, consumed in
 * roster order: team 1's players, then team 2's, week by week. Passing the same seed to two
 * simulations therefore guaranteed only that the stream STARTED the same. Swap a single player and
 * the number of draws changes, and so does who receives which value -- draw #338 was Hall's injury
 * check in one run and somebody else's performance roll in the other. The two runs desynchronise
 * inside the first simulated week and thereafter share a seed and nothing else.
 *
 * That silently cost us the entire benefit of paired comparison. Measured (scripts/sim-convergence.mjs):
 * the spread of a trade delta WITHOUT sharing a seed was 1.01, 0.89, 0.81, 1.01 and 0.80 times the
 * spread WITH it -- i.e. identical within noise, and half the values below one. We were paying for
 * two independent noisy estimates while believing we had the matched-pairs discount.
 *
 * WHY THE OBVIOUS CHECK MISSED IT. Re-simulating an identical roster returned an identical number,
 * and that was read as proof CRN worked. It only proves the generator is DETERMINISTIC -- same input,
 * same output. Whether two DIFFERENT rosters receive aligned draws is a separate property, and it was
 * the one that mattered.
 *
 * THE FIX. Derive each value from WHO IT IS FOR rather than from how many draws came before it.
 * A draw is a pure function of (seed, trial, week, player, purpose), so Breece Hall's week-9 injury
 * roll is the same number no matter what else changed on any roster. Shared players then live
 * through identical seasons in both arms, and the difference between two rosters is attributable to
 * the swap rather than to luck.
 *
 * Integer mixing rather than hashing a string per draw: a 3200-trial sweep makes tens of millions of
 * draws and a string hash in that path would cost more than the variance reduction is worth. Player
 * identity is interned to a stable integer id once.
 */

/** MurmurHash3 finalizer -- a cheap, well-tested 32-bit avalanche. */
function mix32(a: number): number {
  a = a | 0;
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (a ^ (a >>> 16)) >>> 0;
}

/** Purposes are distinct constants so two different questions about the same player-week cannot
 *  collide onto the same value (an injury roll and a performance roll must be independent). */
export const PURPOSE = {
  projErr: 0x1000,
  injury: 0x2000,
  perf: 0x3000,
  copulaA: 0x4000,
  copulaB: 0x5000,
  playoffInjury: 0x6000,
  playoffPerf: 0x7000,
} as const;

/**
 * A uniform in [0,1) keyed by identity. Same arguments always give the same value; different
 * arguments give independent-looking values.
 */
export function draw(seed: number, trial: number, week: number, pid: number, purpose: number): number {
  let h = mix32(seed ^ Math.imul(trial + 1, 0x9e3779b1));
  h = mix32(h ^ Math.imul(pid + 1, 0x85ebca6b));
  h = mix32(h ^ Math.imul(week + 1, 0xc2b2ae35) ^ purpose);
  return h / 4294967296;
}

/** A standard normal keyed by identity, via Box-Muller on two keyed uniforms. */
export function drawGauss(seed: number, trial: number, week: number, pid: number, purpose: number): number {
  const u = Math.max(1e-12, draw(seed, trial, week, pid, purpose));
  const v = draw(seed, trial, week, pid, purpose ^ 0x5bf03635);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Stable integer ids for player names.
 *
 * Interning must be INDEPENDENT of roster composition -- assigning ids in the order players happen to
 * appear would reintroduce exactly the bug being fixed, because a swap changes that order. So the id
 * is a hash of the name, and the table only exists to make collisions detectable rather than silent:
 * two players sharing an id would share every draw, which is a correlation nobody asked for.
 */
export class PlayerIds {
  private byName = new Map<string, number>();
  private byId = new Map<number, string>();
  collisions: string[] = [];

  id(name: string): number {
    const hit = this.byName.get(name);
    if (hit !== undefined) return hit;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = mix32(h ^ name.charCodeAt(i));
    let id = h >>> 1;
    // Linear probe on collision, and RECORD it -- a silent remap would be a correlated pair.
    while (this.byId.has(id) && this.byId.get(id) !== name) {
      this.collisions.push(`${name} vs ${this.byId.get(id)}`);
      id = (id + 0x9e3779b1) >>> 1;
    }
    this.byName.set(name, id);
    this.byId.set(id, name);
    return id;
  }
}
