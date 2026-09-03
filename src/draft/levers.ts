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
}

// Defaults reproduce the proven BALANCED auto-draft posture (reserve 15 / max-share 0.35 / premium 2).
export const DEFAULT_LEVERS: Levers = {
  tierBreak: 0.75, maxKDst: 2, starterReserve: 15, benchReserve: 1, maxShare: 0.35, aggr: 1.0, premium: 2, sleeperThreshold: 5,
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
