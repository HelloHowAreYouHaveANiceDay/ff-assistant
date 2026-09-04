// The Engine <-> Strategy seam (see docs/mvp-draft-auction.md). The Engine owns auction
// mechanics + hard legality; the Strategy owns judgment (values, max bids, nominations). Keep
// this interface stable -- future strategies are new implementations of `Strategy`, and the
// Engine never changes when you swap one in.

import type { Pos } from "../data/rankings.js";
import { computeInflation, scarcityPremium } from "./inflation.js";
import { dstAliasKey } from "./values.js";

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

/** The legal cap for a bid: ESPN's `myMax` if readable, else our own `affordableMax` (which is
 *  unit-verified to equal ESPN's reserve). Never returns 0 just because `myMax` was unreadable --
 *  that silently passed on everything (finding #9, Step 6). Pure. */
export function legalCap(maxBid: number, myMax: number | null | undefined, state: DraftState): number {
  return Math.min(maxBid, myMax ?? affordableMax(state));
}

/** Where to jump-bid to when we are outbid but still under our cap: a FIXED step above the current
 *  offer, never past our cap (Step 8). The old 34%-of-gap term overpaid relative to the sim's
 *  clear-at-second+1; a flat $jump wins fast auctions without leaping far past the runner-up. Pure. */
export function jumpTarget(offer: number, cap: number, jump: number): number {
  return Math.min(cap, offer + jump);
}

// --- v2 plug: budget-aware, value-based, balanced ----------------------------------------
//
// The quality lever over v1: bid up to our VALUE for a player, but never more than we can
// afford while keeping a real BASELINE for every OTHER open slot (starters reserved higher
// than bench). This wins studs early (we can afford up to their value while surplus is high)
// AND keeps the roster balanced (the per-starter reserve stops us stranding other starters),
// then tightens automatically as budget draws down.

export interface V2Config {
  values?: Record<string, number>; // OUR value overrides, keyed by nameKey(name) (else ESPN pre-draft val)
  nameKey?: (s: string) => string; // normalizer to key `values` by (default: identity)
  targets?: Record<string, number>; // per-player premium multiplier (e.g. 1.2)
  avoids?: Set<string>;
  starterReserve?: number; // $ to keep for each other open STARTER slot (default 15 -- balanced, Step 5/Tier2)
  benchReserve?: number; // $ to keep for each other open BENCH slot (default 1)
  premium?: number; // small bump to outbid at consensus (default 1)
  aggr?: number; // global aggressiveness multiplier on value (default 1.0)
  maxShare?: number; // hard cap on ONE player as a fraction of STARTING budget (default 0.35 -- Step 5)
  startBudget?: number; // total budget (for maxShare); default 200
  inflation?: boolean; // LIVE: reprice by remaining$ / remaining value (needs board + teams in state)
  scarcity?: boolean;  // LIVE: add a positional VONA premium as a position runs dry (needs board)
  posInflation?: boolean; // LIVE: fade positions the room is overpaying (needs state.posInflation)
  maxKDst?: number; // hard cap on ANY K/DST bid (default 2). Defence in depth: the value table's
  // own $2 clamp is keyed by name, and live ESPN shows "Texans D/ST" where our table stores
  // "HOU D/ST" -- the lookup misses and falls back to ESPN's UNCAPPED on-screen value (F3).
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
  const starterReserve = cfg.starterReserve ?? 15;
  const benchReserve = cfg.benchReserve ?? 1;
  const premium = cfg.premium ?? 1;
  const aggr = cfg.aggr ?? 1.0;
  const maxShare = cfg.maxShare ?? 0.35;
  const startBudget = cfg.startBudget ?? 200;
  const maxKDst = cfg.maxKDst ?? 2;
  const nk = cfg.nameKey ?? ((s: string) => s);
  // Resolve a player's value AND where it came from: our table (src=ours), ESPN's on-screen value
  // (src=espn), or the $1 floor (src=floor). The source is surfaced in the bid reason so a silent
  // fallback (a name our table missed) is visible in the live log (finding #5).
  const valSrc = (p: PlayerRef): { v: number; src: string } => {
    const ours = cfg.values?.[nk(p.name)];
    if (ours != null) return { v: ours, src: "ours" };
    // DST second chance: ESPN shows "Texans D/ST", our table stores "HOU D/ST" (F3). Without this
    // every defense falls through to the ESPN value and leaves the inflation universe unpriced.
    if (p.pos === "DST") {
      const alias = dstAliasKey(p.name);
      const aliased = alias != null ? cfg.values?.[alias] : undefined;
      if (aliased != null) return { v: aliased, src: "ours(dst-alias)" };
    }
    if (p.espnPreDraftVal != null) return { v: p.espnPreDraftVal, src: "espn" };
    return { v: 1, src: "floor" };
  };
  const val = (p: PlayerRef) => valSrc(p).v;

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
      // Never draft a K or DST onto the bench: they stream at ~$1 and a bench K/DST is dead roster.
      // The room punts K/DST at $1 (docs/league-tendencies.md); enforce it here (finding #1).
      if (fillingBench && (base === "K" || base === "DST")) return { maxBid: 0, reason: "bench K/DST" };
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
      // Apply the outbid premium only to real values (>= $5); the $1 tail must not be overpaid by
      // $premium (a $1 filler should stay $1, not become $3 -- finding, Step 6).
      const wantVal = Math.round(liveVal) + (liveVal >= 5 ? premium : 0);
      // Concentration cap: never sink more than maxShare of the STARTING budget into one player
      // (stops the stars-and-scrubs failure where 3 studs eat the budget and the tail can't fill).
      const shareCap = Math.floor(startBudget * maxShare);
      // K/DST cap, applied to the FINAL number (after premium/inflation) so no repricing path can
      // route around it -- and independent of whether the value table resolved the name at all.
      const kdstCap = (base === "K" || base === "DST") ? maxKDst : Infinity;
      let maxBid = Math.min(wantVal, softAffordable, shareCap, kdstCap);
      // Fill-floor: never let a reserve BLOCK a needed slot we can legally afford ($1).
      if (maxBid < 1 && hardAffordable >= 1) maxBid = 1;
      maxBid = Math.max(0, Math.min(maxBid, hardAffordable));
      return { maxBid, reason: `val${val(p)} src=${valSrc(p).src} soft${softAffordable} -> ${maxBid}` };
    },
    // LIVE nomination. The sim never calls this (draftField has its own nomination paths), so this
    // is live-only behavior and does not move backtest numbers.
    //
    // The policy it replaces ("first player worth <= $1, else the lowest-value VISIBLE player") was
    // bad in a real room in both halves of the draft (F4). ESPN's board virtualizes to ~18 rows, so
    // EARLY every visible player is valuable and "lowest visible" is a mid-tier player -- possibly
    // one of our own targets -- put up at $1. LATE it nominates scrubs we explicitly do not want,
    // and an unwanted $1 nomination in a real room often draws no other bidder, so WE win the player
    // we chose precisely for being unwanted, burning one of only 4 bench slots.
    //
    // Instead: EARLY/MID drain the room's money on the most expensive player we are NOT targeting
    // (no self-win risk -- the room bids real dollars on a real player -- and our own targets come
    // up later, when everyone else is poorer). LATE, when everything visible is cheap, nominate the
    // best player we would be HAPPY to own: self-winning a $1 sleeper into a bench slot is a feature.
    nominate(state) {
      const rostered = new Set(state.myRoster.map((r) => r.name));
      const avail = state.board.filter((p) => !rostered.has(p.name));
      const byVal = avail.slice().sort((a, b) => val(b) - val(a));
      const fills = (p: PlayerRef) => (state.mySlots[p.pos] ?? 0) > 0
        || (["RB", "WR", "TE"].includes(p.pos) && (state.mySlots.FLEX ?? 0) > 0)
        || (state.mySlots.BENCH ?? 0) > 0;
      // Our live targets = the top-N fillable players by OUR value (N=8, a judgment call: deep
      // enough to cover a nomination round, shallow enough to leave real drain candidates).
      const targets = new Set(byVal.filter(fills).slice(0, 8).map((p) => p.name));
      const drain = byVal.find((p) => !targets.has(p.name) && val(p) >= 10);
      if (drain) return { player: drain, openingBid: 1, reason: `drain non-target $${val(drain)}` };
      const keeper = byVal.find((p) => fills(p) && p.pos !== "K" && p.pos !== "DST")
        ?? byVal[0] ?? state.board[0];
      return { player: keeper, openingBid: 1, reason: "late: best cheap keeper" };
    },
  };
}
