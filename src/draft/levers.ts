// The tunable LEVERS -- every knob that shapes our values, tiers, and bidding, in ONE typed config
// section so they are visible, editable in the UI, and readable/writable by the assistant. Defaults
// reproduce the previous hardcoded behavior exactly. Each lever carries metadata (range + whether it
// affects the BOARD, i.e. needs a refresh to take effect) used by both the Settings UI and set_lever.

export interface Levers {
  tierBreak: number;        // new positional tier starts when value drops below this fraction of the tier top
  maxKDst: number;          // hard $ cap on K/DST (they stream -- never price them like starters)
  starterReserve: number;   // $ held back for still-unfilled STARTER slots when computing a max bid
  benchReserve: number;     // $ held back per bench slot
  maxShare: number;         // max fraction of the budget to spend on any single player
  aggr: number;             // bidding aggressiveness multiplier (1 = neutral)
  premium: number;          // extra $ willing to pay at the margin to win a targeted player
  sleeperThreshold: number; // min vsECR for a player to count as a SLEEPER (board filter)
  benchDiscount: number;    // value multiplier for a player who can ONLY fill a bench slot
  // Per-position multipliers on OUR value. 1 = trust the VOR book as-is. These correct for the fact
  // that VOR prices a position in isolation, while the ROSTER decides how many startable weeks a
  // dollar there actually buys (1 QB slot vs 4 RB/WR/TE-eligible starting slots).
  // K/DST deliberately have no multiplier: maxKDst hard-caps them at $2, so one could not bind.
  multQB: number;
  multRB: number;
  multWR: number;
  multTE: number;
}

// Defaults = the shipped, holdout-validated posture (2026-09-05): aggr 0.7 / benchDiscount 0.25 /
// starterReserve 4 / maxShare 0.25 / premium 2, all positional multipliers 1.0. ~33% championships
// on 25 scored seasons. Do NOT edit a value here without re-reading docs/validation.md -- several of
// these were measured, rejected, and re-measured, and the reasoning is recorded per lever below.
// benchDiscount 0.25 measured 2026-09-04: full-system no-lookahead championships 24.4% -> 28.0%
// (n=400 x 9 seasons, SE ~0.6). A bench-only player never enters the lineup, so his standalone
// value overstates him; 0 collapses to 19.6% because depth still matters for byes/injuries.
export const DEFAULT_LEVERS: Levers = {
  // aggr 0.7 -- the WINNER'S CURSE correction. Drafting is a common-value auction on noisy
  // estimates, so the winner is disproportionately whoever OVERestimated; shading offsets it.
  // Verified to build a genuinely better team, not merely a cheaper one (+53.5 starting-lineup
  // points, 82% -> 92% of the field outscored, at the SAME spend -- scripts/roster-strength.mjs).
  //
  // Chosen by MINIMAX over two opponent models, because the optimum depends on whose book the bots
  // bid and we cannot know which is right (25 seasons, n=150):
  //     aggr                    0.6    0.65   0.7    1.0
  //     vor book (mirror)      32.9   33.3   34.9   25.3
  //     rank book (calibrated) 34.7   34.2   34.3   25.8
  //     worst case             32.9   33.3   34.3   25.3
  //
  // HISTORY, because the intermediate answer was wrong and the reason is worth keeping: an earlier
  // uncalibrated rank book (decay 2.2) put the optimum at 0.5 and made 0.7 look like a collapse to
  // 27.1%, so 0.6 was briefly shipped on minimax. scripts/face-validity.mjs then showed that book
  // modelled a room that does not exist -- median price $8 and 39% of picks at $1-5, against this
  // league's real $2 and 61%. Calibrating its decay to the real price distribution (RANK_DECAY 5)
  // moved the optimum to a 0.6-0.7 plateau and restored 0.7 as the minimax choice.
  // The lesson: a robustness check is only as good as the realism of the alternative it tests
  // against. Validate the challenger model before letting it overrule a result.
  tierBreak: 0.75, maxKDst: 2, starterReserve: 4, benchReserve: 1, maxShare: 0.25, aggr: 0.7, premium: 2, sleeperThreshold: 5,
  benchDiscount: 0.25,
  // All 1.0 by evidence. multQB 0.7 DID measure +1.3 pts (27.6% -> 28.6%, n=800) while aggr was 1.0
  // -- but that gain was the WINNER'S CURSE correction wearing a QB costume. With aggr 0.7 shipped,
  // multQB 1.0 and 0.7 both score 33.7% at n=800: exactly zero effect. Positional multipliers stay
  // at 1.0 until one of them beats the global dial on its own; see docs/validation.md.
  multQB: 1, multRB: 1, multWR: 1, multTE: 1,
};

export interface LeverMeta { label: string; min: number; max: number; step: number; board: boolean; help: string; }
export const LEVER_META: Record<keyof Levers, LeverMeta> = {
  tierBreak:        { label: "Tier break", min: 0.5, max: 0.95, step: 0.01, board: true, help: "Lower = fewer, bigger tiers (a new tier starts at a steeper value drop)." },
  maxKDst:          { label: "Max K/DST $", min: 1, max: 10, step: 1, board: true, help: "Hard cap on kicker/defense price -- they stream." },
  starterReserve:   { label: "Starter reserve $", min: 0, max: 60, step: 1, board: false, help: "Budget held back for unfilled starting slots when bidding." },
  benchReserve:     { label: "Bench reserve $", min: 0, max: 10, step: 1, board: false, help: "Budget held back per bench slot ($1 each keeps you legal)." },
  maxShare:         { label: "Max share", min: 0.1, max: 0.7, step: 0.01, board: false, help: "Ceiling on the fraction of budget spent on one player." },
  aggr:             { label: "Aggressiveness", min: 0.5, max: 2, step: 0.05, board: false, help: "Bidding multiplier: >1 chases, <1 waits for value." },
  premium:          { label: "Outbid premium $", min: 0, max: 10, step: 1, board: false, help: "Extra dollars to win a specifically targeted player." },
  sleeperThreshold: { label: "Sleeper cutoff (vsECR)", min: 1, max: 20, step: 1, board: false, help: "Min vsECR for the SLEEPERS board filter." },
  benchDiscount:    { label: "Bench discount", min: 0.1, max: 1, step: 0.05, board: false, help: "How much a bench-only player is worth vs his standalone value. 1 = no discount." },
  multQB:         { label: "QB value x", min: 0.4, max: 1.5, step: 0.05, board: false, help: "Multiplier on OUR QB values. <1 = pay less for QB than raw VOR says." },
  multRB:         { label: "RB value x", min: 0.4, max: 1.5, step: 0.05, board: false, help: "Multiplier on OUR RB values. <1 = pay less for RB than raw VOR says." },
  multWR:         { label: "WR value x", min: 0.4, max: 1.5, step: 0.05, board: false, help: "Multiplier on OUR WR values. <1 = pay less for WR than raw VOR says." },
  multTE:         { label: "TE value x", min: 0.4, max: 1.5, step: 0.05, board: false, help: "Multiplier on OUR TE values. <1 = pay less for TE than raw VOR says." },
};

/** Coerce + clamp a single lever to its metadata range. Returns null for an unknown key or NaN. */
export function clampLever(key: string, value: unknown): number | null {
  const meta = (LEVER_META as Record<string, LeverMeta>)[key];
  if (!meta) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(meta.max, Math.max(meta.min, n));
}

/** Merge a partial levers patch onto a base, clamping each provided key. */
export function applyLevers(base: Levers, patch: Record<string, unknown>): Levers {
  const out: Levers = { ...base };
  for (const [k, v] of Object.entries(patch)) { const c = clampLever(k, v); if (c != null) (out as unknown as Record<string, number>)[k] = c; }
  return out;
}
