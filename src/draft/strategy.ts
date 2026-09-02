// The Engine <-> Strategy seam (see docs/mvp-draft-auction.md). The Engine owns auction
// mechanics + hard legality; the Strategy owns judgment (values, max bids, nominations). Keep
// this interface stable -- future strategies are new implementations of `Strategy`, and the
// Engine never changes when you swap one in.

import type { Pos } from "../data/rankings.js";
import { computeInflation, scarcityPremium } from "./inflation.js";

// Rough share of league STARTING demand by position (QB1 RB2 WR2 TE1 FLEX1 K1 DST1, FLEX -> RB/WR/TE).
// Used only to estimate live positional need for the scarcity premium.
const POS_DEMAND: Record<string, number> = { QB: 0.11, RB: 0.30, WR: 0.30, TE: 0.12, K: 0.07, DST: 0.07 };

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
  liveInflation?: number; // LIVE: a precomputed inflation multiplier (start-normalized); overrides the board calc
  posInflation?: Record<string, number>; // LIVE: per-position repricing factor (fade overpaid positions)
  board: PlayerRef[]; // available players (for nomination + planning)
  teams: Array<{ name: string; budgetLeft: number; openSlots?: number }>; // ALL teams' budgets + open slots (for live inflation)
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

// --- v2 plug: budget-aware, value-based, balanced ----------------------------------------
//
// The quality lever over v1: bid up to our VALUE for a player, but never more than we can
// afford while keeping a real BASELINE for every OTHER open slot (starters reserved higher
// than bench). This wins studs early (we can afford up to their value while surplus is high)
// AND keeps the roster balanced (the per-starter reserve stops us stranding other starters),
// then tightens automatically as budget draws down.

export interface V2Config {
  values?: Record<string, number>; // OUR value overrides by name (else ESPN pre-draft val)
  targets?: Record<string, number>; // per-player premium multiplier (e.g. 1.2)
  avoids?: Set<string>;
  starterReserve?: number; // $ to keep for each other open STARTER slot (default 10)
  benchReserve?: number; // $ to keep for each other open BENCH slot (default 1)
  premium?: number; // small bump to outbid at consensus (default 1)
  aggr?: number; // global aggressiveness multiplier on value (default 1.0)
  maxShare?: number; // hard cap on ONE player as a fraction of STARTING budget (default 0.45)
  startBudget?: number; // total budget (for maxShare); default 200
  inflation?: boolean; // LIVE: reprice by remaining$ / remaining value (needs board + teams in state)
  scarcity?: boolean;  // LIVE: add a positional VONA premium as a position runs dry (needs board)
  posInflation?: boolean; // LIVE: fade positions the room is overpaying (needs state.posInflation)
}

const isBench = (slotKey: string) => /^(BE|BENCH|IR)$/i.test(slotKey);

/** Reserve we must keep for OTHER open slots if we win a slot of kind `fillingBench`. Pure. */
export function reserveForOthers(state: DraftState, fillingBench: boolean, starterReserve: number, benchReserve: number): number {
  let starters = 0, bench = 0;
  for (const [k, n] of Object.entries(state.mySlots)) {
    const c = Math.max(0, n);
    if (isBench(k)) bench += c; else starters += c;
  }
  // Remove the one slot THIS player fills from the reserve pool.
  if (fillingBench) bench = Math.max(0, bench - 1);
  else starters = Math.max(0, starters - 1);
  return starters * starterReserve + bench * benchReserve;
}

export function makeV2Strategy(cfg: V2Config = {}): Strategy {
  const starterReserve = cfg.starterReserve ?? 10;
  const benchReserve = cfg.benchReserve ?? 1;
  const premium = cfg.premium ?? 1;
  const aggr = cfg.aggr ?? 1.0;
  const maxShare = cfg.maxShare ?? 0.45;
  const startBudget = cfg.startBudget ?? 200;
  const val = (p: PlayerRef) => cfg.values?.[p.name] ?? p.espnPreDraftVal ?? 1;

  return {
    value: (p) => val(p),
    maxBid(state) {
      const p = state.onBlock;
      if (!p) return { maxBid: 0, reason: "no player on block" };
      if (cfg.avoids?.has(p.name)) return { maxBid: 0, reason: "avoid" };
      // Would this player go to a dedicated/FLEX (starter) slot, or only bench?
      const base = p.pos;
      const starterOpen = (state.mySlots[base] ?? 0) > 0 || (["RB", "WR", "TE"].includes(base) && (state.mySlots.FLEX ?? 0) > 0);
      const fillingBench = !starterOpen;
      // Soft reserve (balanced target: keep real $ for other starters) limits early concentration.
      const softAffordable = state.myBudget - reserveForOthers(state, fillingBench, starterReserve, benchReserve);
      // Hard reserve ($1/other slot) is the never-strand floor -- a legal roster stays completable.
      const hardAffordable = state.myBudget - reserveForOthers(state, fillingBench, 1, 1);
      // LIVE repricing: correct the static value table for how the auction is actually flowing.
      let liveVal = val(p) * aggr * (cfg.targets?.[p.name] ?? 1);
      if ((cfg.inflation || cfg.scarcity) && state.board.length && state.teams.length) {
        const remaining = state.board.map((b) => ({ name: b.name, pos: b.pos, value: val(b) }));
        const remainingDollars = state.teams.reduce((s, t) => s + Math.max(0, t.budgetLeft), 0);
        const remainingSlots = state.teams.reduce((s, t) => s + Math.max(0, t.openSlots ?? 0), 0);
        // LIVE passes a start-normalized, bounded multiplier (state.liveInflation) because the live
        // board is virtualized; the backtest passes an exact board and computes it here.
        if (cfg.inflation) liveVal *= state.liveInflation ?? (remainingSlots > 0 ? computeInflation(remaining, remainingDollars, remainingSlots) : 1);
        if (cfg.scarcity) {
          const needAtPos = Math.max(1, Math.round(remainingSlots * (POS_DEMAND[p.pos] ?? 0.1)));
          liveVal += scarcityPremium({ name: p.name, pos: p.pos, value: val(p) }, remaining, needAtPos);
        }
      }
      // Per-position fade needs only state.posInflation (not the board), so it runs independently.
      if (cfg.posInflation && state.posInflation) liveVal *= state.posInflation[p.pos] ?? 1;
      const wantVal = Math.round(liveVal) + premium;
      // Concentration cap: never sink more than maxShare of the STARTING budget into one player
      // (stops the stars-and-scrubs failure where 3 studs eat the budget and the tail can't fill).
      const shareCap = Math.floor(startBudget * maxShare);
      let maxBid = Math.min(wantVal, softAffordable, shareCap);
      // Fill-floor: never let a reserve BLOCK a needed slot we can legally afford ($1).
      if (maxBid < 1 && hardAffordable >= 1) maxBid = 1;
      maxBid = Math.max(0, Math.min(maxBid, hardAffordable));
      return { maxBid, reason: `val${val(p)} soft${softAffordable} -> ${maxBid}` };
    },
    nominate(state) {
      const wanted = new Set(state.myRoster.map((r) => r.name));
      const sorted = state.board.filter((p) => !wanted.has(p.name)).sort((a, b) => val(b) - val(a));
      const drain = sorted.find((p) => val(p) <= 1) ?? sorted[sorted.length - 1] ?? state.board[0];
      return { player: drain, openingBid: 1, reason: "drain-nominate" };
    },
  };
}
