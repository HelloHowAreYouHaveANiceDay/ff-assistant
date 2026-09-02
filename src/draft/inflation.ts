// Live auction repricing: as the board depletes, a fixed value table goes stale. Two corrections,
// both computed from the LIVE state (remaining players, remaining money, remaining slots):
//
//  - INFLATION: if the money still on the table exceeds the value still on the board, every
//    remaining player will sell above its book value. inflation = remaining$ / remaining draftable
//    value. Reprice by it so we don't sit on our hands and end with unspent budget + worse players.
//    This is a mechanical market correction (not gamesmanship the bots ignore), so it should help.
//  - SCARCITY (VONA, live): a player's real worth is the drop to the NEXT startable player at their
//    position given what's left. When a position is running dry relative to league demand, that drop
//    grows -> a premium; when it's deep, ~0. Murkier; gated separately so we can measure each alone.

export interface RemainingPlayer { name: string; pos: string; value: number; }

/** Inflation multiplier: remaining dollars / value of the top (remainingSlots) players still on the
 *  board. >1 = the room is money-rich vs talent-left (reprice up); <1 = value-rich (be patient).
 *  Clamped to a sane band so a thin end-game board can't produce a runaway multiplier. */
export function computeInflation(remaining: RemainingPlayer[], remainingDollars: number, remainingSlots: number): number {
  if (remainingSlots <= 0 || remaining.length === 0) return 1;
  const values = remaining.map((p) => Math.max(0, p.value)).sort((a, b) => b - a);
  // Only the top `remainingSlots` players will actually be rostered; each slot also costs >=$1.
  const draftable = values.slice(0, remainingSlots);
  let bookValue = draftable.reduce((s, v) => s + Math.max(v, 1), 0); // >=$1 per fillable slot
  // LIVE: the board may list fewer players than there are open slots (it virtualizes to the top ~40,
  // and in a deep league the tail all goes for ~$1). Pad the uncovered slots at $1 each so the ratio
  // isn't overstated by a short board.
  if (draftable.length < remainingSlots) bookValue += (remainingSlots - draftable.length) * 1;
  if (bookValue <= 0) return 1;
  const inf = remainingDollars / bookValue;
  return Math.max(0.7, Math.min(2.0, inf));
}

/** Live scarcity premium for one player: how far this player's value sits ABOVE the value of the
 *  Nth-next available player at the same position (N ~= league's remaining need at that pos, capped).
 *  Returns a $ premium to add (>=0). When the position is deep the next-available is close -> ~0. */
export function scarcityPremium(player: RemainingPlayer, remaining: RemainingPlayer[], remainingNeedAtPos: number): number {
  if (remainingNeedAtPos <= 0) return 0;
  const samePos = remaining.filter((p) => p.pos === player.pos && p.name !== player.name).map((p) => p.value).sort((a, b) => b - a);
  // the "next player we'd settle for" is roughly the one at the edge of remaining league demand
  const idx = Math.min(samePos.length - 1, Math.max(0, remainingNeedAtPos - 1));
  const next = samePos[idx] ?? 0;
  return Math.max(0, player.value - next);
}
