// Per-manager bot models, derived from 4 years of this league's real auction spending
// (data/managers.json, built by analyze.mjs from data/recaps.json + data/owners.json).
//
// The generic old bot ("everyone overpays for studs equally") ignored that this room is
// heterogeneous: some managers pay premium QB every year, some never bid QB/TE, some are RB-first.
// A realistic field reproduces each manager's positional appetite AND the league-wide
// stars-and-scrubs concentration -- which is exactly what makes nomination gamesmanship (draining
// the known position-payers) a real, testable edge. See docs/league-managers.md.

import { readFileSync } from "node:fs";
import { dataPath } from "../data/paths.js";

export interface ManagerProfile {
  owner: string;
  abbrev: string;
  seasons: number[];
  share: Record<string, number>; // avg positional $ share (QB/RB/WR/TE/K/DST)
  conc: number;                  // avg top-3 concentration (stars-and-scrubs degree)
  maxBuy: number;                // avg biggest single buy $
  cheap: number;                 // avg $1-5 picks/yr
}
export interface ManagerData { leagueShare: Record<string, number>; profiles: ManagerProfile[]; }

// Generic heterogeneous field for installs with NO league history file (any shipped build, or a
// friend's fresh install). Four archetypes -- balanced / RB-first / WR-heavy / QB-lover -- that
// assignSeats cycles across the seats, so the practice sim is realistic without anyone's real data.
const GENERIC_MANAGERS: ManagerData = {
  leagueShare: { QB: 0.11, RB: 0.33, WR: 0.33, TE: 0.10, K: 0.02, DST: 0.02 },
  profiles: [
    { owner: "Balanced", abbrev: "BAL", seasons: [], share: { QB: 0.11, RB: 0.33, WR: 0.33, TE: 0.10, K: 0.02, DST: 0.02 }, conc: 0.52, maxBuy: 52, cheap: 5 },
    { owner: "RB-First", abbrev: "RBF", seasons: [], share: { QB: 0.06, RB: 0.44, WR: 0.30, TE: 0.08, K: 0.02, DST: 0.02 }, conc: 0.60, maxBuy: 62, cheap: 6 },
    { owner: "WR-Heavy", abbrev: "WRH", seasons: [], share: { QB: 0.08, RB: 0.28, WR: 0.44, TE: 0.08, K: 0.02, DST: 0.02 }, conc: 0.56, maxBuy: 58, cheap: 5 },
    { owner: "QB-Lover", abbrev: "QBL", seasons: [], share: { QB: 0.20, RB: 0.30, WR: 0.28, TE: 0.14, K: 0.02, DST: 0.02 }, conc: 0.48, maxBuy: 48, cheap: 4 },
  ],
};

let _cache: ManagerData | null = null;
export function loadManagers(): ManagerData {
  if (_cache) return _cache;
  try {
    // per-league profiles built by `ff scrape-league` into the writable data root (FF_DATA-aware)
    _cache = JSON.parse(readFileSync(dataPath("managers.json"), "utf8")) as ManagerData;
  } catch {
    _cache = GENERIC_MANAGERS; // no history file: use the generic field so the sim still runs
  }
  return _cache;
}

/** A bot's MILD per-position premium: a QB-lover outbids a QB-punter for the same QB, but only
 *  slightly -- the positional MIX is enforced by the spend budget below, not by paying N x value
 *  (that made one bot monopolize a whole position). Maps share-vs-league to ~0.8..1.3x. */
export function posPremium(profile: ManagerProfile, leagueShare: Record<string, number>, pos: string): number {
  if (pos === "K" || pos === "DST") return 0.6; // nobody pays up here
  const ls = Math.max(leagueShare[pos] ?? 0.01, 0.01);
  const rel = (profile.share[pos] ?? 0) / ls;   // 1 = league-average appetite for this position
  return Math.max(0.8, Math.min(1.3, 0.9 + (rel - 1) * 0.25));
}

/** Stars-and-scrubs curve: pay a premium for top-tier studs, a discount for depth. Scaled by the
 *  manager's own concentration (conc ~0.70-0.91 here) so high-concentration managers pay MORE at the
 *  top and LESS on the tail. league-mean conc ~0.78 is the neutral point. */
export function studCurve(rank: number, conc: number): number {
  const c = (conc - 0.78) * 2; // -0.16..+0.26 -> scaled
  if (rank < 24) return 1.05 + Math.max(0, c) * 0.7;   // elite: premium, bigger for concentrators
  if (rank < 66) return 1.0;                            // mid: about value
  return 0.8 - Math.max(0, c) * 0.2;                    // depth: discount, deeper for concentrators
}

// Bidder now sees how much this team has already spent per position + its total budget, so it can
// enforce a realistic positional BUDGET (share x startBudget) -- once a manager has spent its RB
// allocation it stops chasing RBs, which is what keeps the field from monopolizing a position.
export type BotBidder = (trueVal: number, pos: string, studRank: number, spentByPos: Record<string, number>, rng: () => number) => number;

export function makeBotBidder(profile: ManagerProfile, leagueShare: Record<string, number>, startBudget = 200): BotBidder {
  return (trueVal, pos, studRank, spentByPos, rng) => {
    const prem = posPremium(profile, leagueShare, pos);
    const curve = studCurve(studRank, profile.conc);
    const noise = 0.85 + rng() * 0.3; // +-15% bidder-to-bidder jitter
    let bid = trueVal * prem * curve * noise;
    // Positional spend budget: target = this owner's historical share of the cap. Once spent, the
    // bot only makes bargain bids for that position (it would rather allocate elsewhere).
    const target = (profile.share[pos] ?? 0) * startBudget;
    const remaining = target - (spentByPos[pos] ?? 0);
    const favored = (profile.share[pos] ?? 0) > (leagueShare[pos] ?? 0);
    if (remaining <= 0) bid *= 0.2;                        // target hit -> only steal a bargain
    else {
      bid = Math.min(bid, remaining + trueVal * 0.4);     // allow one stud to modestly exceed target
      // Catch-up: deploy the allocation instead of leaving it unspent. A FAVORED position (they
      // overweight it) gets bid well above VOR; core starters (RB/WR/TE) that are still under budget
      // get a gentler nudge so a manager actually fills its required WR/RB starters near value
      // instead of at $1 scraps after a splurge elsewhere.
      if (studRank < 66) {
        if (favored) bid = Math.max(bid, Math.min(remaining * 0.55, trueVal * 1.6));
        else if (pos === "RB" || pos === "WR" || pos === "TE") bid = Math.max(bid, Math.min(remaining * 0.4, trueVal * 1.1));
      }
    }
    // BUDGET ANXIETY at the top of the market. Without this the field bid a top price of $132-147,
    // which no manager in this league has ever paid: historical maxBuy runs $47-89 (mean $72), and
    // the real top price is $88-106 -- ESPN mock rooms independently top out at $105. A bot that
    // will bid $147 makes the elite tier look hotter than it is, which is exactly the price region
    // maxShare governs.
    //
    // maxBuy is an AVERAGE of yearly maxima, so a manager can exceed it in a given year -- the cap
    // is soft, drawn per bid in [0.95, 1.30] x maxBuy, rather than a hard ceiling that would clip
    // the top of the distribution flat.
    if (profile.maxBuy > 0) bid = Math.min(bid, profile.maxBuy * (0.95 + rng() * 0.35));
    return Math.max(1, Math.round(bid));
  };
}

/** Assign real manager profiles to the (teams-1) bot seats deterministically. Seat 0 is US, so we
 *  take the most-recent (2025) league order for the rest, cycling if the sim has more seats. */
export function assignSeats(nBots: number): ManagerProfile[] {
  const { profiles } = loadManagers();
  // prefer owners present in 2025 (the current league), then the rest, for a realistic field
  const ranked = [...profiles].sort((a, b) => (b.seasons.includes(2025) ? 1 : 0) - (a.seasons.includes(2025) ? 1 : 0) || b.seasons.length - a.seasons.length);
  const seats: ManagerProfile[] = [];
  for (let i = 0; i < nBots; i++) seats.push(ranked[i % ranked.length]);
  return seats;
}
