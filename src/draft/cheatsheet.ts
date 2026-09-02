// Pure tiering for the draft-day cheat sheet. A tier groups players of similar value; a new tier
// starts at a real value CLIFF (drop > max($3, 15% of the prior player)) or when a tier reaches
// maxTierSize (so a cluster of near-equal low values doesn't collapse into one giant blob).

export interface ValuedPlayer { name: string; value: number; }

export function tierize(players: ValuedPlayer[], opts: { maxTierSize?: number; minDrop?: number; dropPct?: number } = {}): ValuedPlayer[][] {
  const maxTierSize = opts.maxTierSize ?? 5;
  const minDrop = opts.minDrop ?? 3;
  const dropPct = opts.dropPct ?? 0.15;
  const ps = players.slice().sort((a, b) => b.value - a.value);
  const tiers: ValuedPlayer[][] = [];
  let cur: ValuedPlayer[] = [];
  for (let i = 0; i < ps.length; i++) {
    if (i > 0) {
      const drop = ps[i - 1].value - ps[i].value;
      const cliff = drop > Math.max(minDrop, ps[i - 1].value * dropPct);
      if (cliff || cur.length >= maxTierSize) { tiers.push(cur); cur = []; }
    }
    cur.push(ps[i]);
  }
  if (cur.length) tiers.push(cur);
  return tiers;
}
