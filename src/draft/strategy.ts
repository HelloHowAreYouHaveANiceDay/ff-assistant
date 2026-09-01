// The Engine <-> Strategy seam (see docs/mvp-draft-auction.md). The Engine owns auction
// mechanics + hard legality; the Strategy owns judgment (values, max bids, nominations). Keep
// this interface stable -- future strategies are new implementations of `Strategy`, and the
// Engine never changes when you swap one in.

import type { Pos } from "../data/rankings.js";

export interface PlayerRef {
  name: string;
  pos: Pos;
  team: string;
  espnPreDraftVal: number | null; // ESPN's on-screen auction value, if visible
}

/** Everything the Engine knows at a decision point; passed to the Strategy. */
export interface DraftState {
  myBudget: number; // dollars remaining
  mySlots: Record<string, number>; // remaining OPEN slots by slot key (QB/RB/WR/TE/FLEX/K/DST/BENCH)
  myRoster: PlayerRef[]; // players we've already won
  onBlock: PlayerRef | null; // player currently up for bid
  currentOffer: number | null; // current high bid
  secondsLeft: number | null; // per-player clock (drives clock-aware bidding)
  iAmHighBidder: boolean;
  board: PlayerRef[]; // available players (for nomination + planning)
  teams: Array<{ name: string; budgetLeft: number }>; // opponent budgets (optional for v1)
}

/** What the Strategy tells the Engine. The Engine still clamps to legality. */
export interface BidDecision {
  maxBid: number; // most we'd pay for the on-block player right now; 0 = do not want
  reason?: string;
}
export interface NominateDecision {
  player: PlayerRef;
  openingBid?: number; // default $1
  reason?: string;
}

export interface Strategy {
  /** Our dollar value for a player (judgment; Engine does not clamp this). */
  value(p: PlayerRef, state: DraftState): number;
  /** Ceiling for the on-block player this instant. Engine bids up to min(this, legal). */
  maxBid(state: DraftState): BidDecision;
  /** Whom to nominate on our turn. */
  nominate(state: DraftState): NominateDecision;
}

// --- v1 plug: our own values, never overpay our value, drain-nominate ------------------

export interface V1Config {
  /** Our dollar value per player name (from projections -> VOR -> $, built pre-draft). */
  values: Record<string, number>;
  /** Optional per-player premium multiplier for targets (e.g. 1.15 = pay up to +15%). */
  targets?: Record<string, number>;
  /** Players to never bid on. */
  avoids?: Set<string>;
}

export function makeV1Strategy(cfg: V1Config): Strategy {
  const val = (name: string) => cfg.values[name] ?? 0;
  return {
    value(p) {
      return val(p.name);
    },
    maxBid(state) {
      const p = state.onBlock;
      if (!p) return { maxBid: 0, reason: "no player on block" };
      if (cfg.avoids?.has(p.name)) return { maxBid: 0, reason: "on avoid list" };
      const premium = cfg.targets?.[p.name] ?? 1;
      const our = Math.round(val(p.name) * premium);
      return { maxBid: our, reason: `v1 value ${val(p.name)} x${premium}` };
    },
    nominate(state) {
      // v1: nominate the highest-value board player we do NOT want (drain opponents);
      // fall back to any board player (keeps the draft moving). Robust hook for later.
      const wanted = new Set(state.myRoster.map((r) => r.name));
      const sorted = state.board
        .filter((p) => !wanted.has(p.name))
        .sort((a, b) => val(b.name) - val(a.name));
      const drain = sorted.find((p) => val(p.name) <= 0) ?? sorted[sorted.length - 1] ?? state.board[0];
      return { player: drain, openingBid: 1, reason: "v1 drain-nominate" };
    },
  };
}

/**
 * Hard legality the ENGINE applies to any Strategy's maxBid (never overspend, always keep a
 * legal roster completable). Pure function so it is unit-testable via fault injection.
 */
export function affordableMax(state: DraftState): number {
  const openSlots = Object.values(state.mySlots).reduce((a, b) => a + Math.max(0, b), 0);
  // Reserve $1 for every slot that would remain open AFTER winning the on-block player.
  const slotsAfter = Math.max(0, openSlots - 1);
  const cap = state.myBudget - slotsAfter;
  return Math.max(0, cap);
}
