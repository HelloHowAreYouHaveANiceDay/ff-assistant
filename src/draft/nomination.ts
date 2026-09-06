// Nomination policy: turn the per-manager scouting (data/league-managers.md -- per-install and
// gitignored, because it names real people) into a concrete
// drain-first nomination. The room is full of known position-payers (Maria Jose pays premium QB
// every year, McDermott buys an elite TE, etc.). On our nomination turn we put up a player WE DON'T
// WANT at a position a well-funded payer craves -- they bid it up, draining budget away from the
// players we actually target. This is the "nomination gamesmanship" edge from docs/edges.md, made
// concrete and testable. Pure functions so the sim and the live agent share one implementation.

export interface NomPlayer { name: string; pos: string; value: number; }
export interface Payer {
  // one opponent's appetite for a position they can still fill, with money to spend
  pos: string;
  budgetLeft: number;
  craving: number; // share/leagueShare for this pos (>1 = overweights it); higher = better drain
}

export interface NominationChoice { player: NomPlayer; openingBid: number; reason: string; }

/** Pick whom to nominate. Prefers to drain the best-funded, hungriest position-payer by nominating
 *  the top available player (we don't want) at their craved position. Falls back to nominating the
 *  cheapest filler we don't want (anti-stall) so a turn never wastes. Pure + deterministic. */
export function planDrainNomination(board: NomPlayer[], wanted: Set<string>, payers: Payer[], opts: { minCraving?: number; minBudget?: number } = {}): NominationChoice {
  const minCraving = opts.minCraving ?? 1.15; // only drain a position they genuinely overweight
  const minBudget = opts.minBudget ?? 20;     // ...and can still meaningfully spend on
  const notOurs = board.filter((p) => !wanted.has(p.name));

  // Rank drain opportunities: a hungry, well-funded payer x a real (expensive) player at that pos.
  const targets = payers
    .filter((p) => p.craving >= minCraving && p.budgetLeft >= minBudget)
    .sort((a, b) => b.craving * b.budgetLeft - a.craving * a.budgetLeft);

  for (const t of targets) {
    // the best (highest-value) available player at the craved position that we don't want
    const cand = notOurs.filter((p) => p.pos === t.pos).sort((a, b) => b.value - a.value)[0];
    if (cand && cand.value >= 8) // must be worth bidding up, or it won't drain much
      return { player: cand, openingBid: 1, reason: `drain ${t.pos}-payer ($${t.budgetLeft} left, craving ${t.craving.toFixed(1)}x)` };
  }

  // Fallback: nominate the cheapest player we don't want (bleed a $1-2 roster spot from someone,
  // never a player we're targeting). Keeps the draft moving on our turn.
  const filler = notOurs.slice().sort((a, b) => a.value - b.value)[0] ?? board[0];
  return { player: filler, openingBid: 1, reason: "no drain target -- nominate a scrub" };
}

/** Build the Payer list from opponent profiles + their remaining budgets + which positions they can
 *  still roster. leagueShare is the baseline; craving = share/leagueShare. Used by both sim + live. */
export function payersFrom(
  opponents: { share: Record<string, number>; budgetLeft: number; openPositions: Set<string> }[],
  leagueShare: Record<string, number>,
): Payer[] {
  const out: Payer[] = [];
  for (const o of opponents) {
    for (const pos of o.openPositions) {
      if (pos === "K" || pos === "DST") continue;
      const ls = Math.max(leagueShare[pos] ?? 0.01, 0.01);
      out.push({ pos, budgetLeft: o.budgetLeft, craving: (o.share[pos] ?? 0) / ls });
    }
  }
  return out;
}
