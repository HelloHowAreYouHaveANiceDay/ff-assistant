// Draft field + one-shot season-points sim. `draftField` runs the auction (our real strategy vs a
// stud-overpaying bot field) and returns every team's roster -- reused by runSim (season points)
// AND by backtest.ts (real weekly schedule + playoffs -> championship rate). See docs/validation.md.

import { makeV2Strategy, type DraftState, type V2Config } from "./strategy.js";
import { computeValues, resolveValueLeague, type PointsRow } from "./values.js";
import { loadManagers, makeBotBidder, assignSeats, type BotBidder, type ManagerProfile } from "./managers.js";
import { planDrainNomination, payersFrom } from "./nomination.js";
import { positionInflationFactors } from "./inflation.js";

export interface SimLeague { teams: number; budget: number; slots: string[]; }
/** Build the sim/backtest league from the app config, so it simulates the USER's exact format
 *  (teams/budget/roster) rather than a hardcoded one. The single source of format truth. */
export function leagueFromConfig(c: { teams: number; budget: number; slots: string[] }): SimLeague {
  return { teams: c.teams, budget: c.budget, slots: c.slots };
}
// Real league (462233, seacaptaindate.com): 16 teams x 12 slots (2025 recap = 192 picks). Roster per
// the LIVE ESPN settings: 8 starters (QB/RB/WR/TE/2x FLEX/DST/K) + 4 bench. Kept in lockstep with
// DEFAULT_CONFIG.slots (a test binds them); when the app is config-driven end-to-end this comes from config.
export const SIM_LEAGUE: SimLeague = {
  teams: 16, budget: 200,
  slots: ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"],
};
const FLEX_OK = new Set(["RB", "WR", "TE"]);

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rng: () => number): number { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export interface Pick { name: string; pos: string; team: number; price: number; }
export interface DraftFieldOpts { includeUs?: boolean; profiles?: ManagerProfile[]; drainNom?: boolean; greedyNom?: boolean;
  /** How the BOTS price players. "vor" (default) computes their book with computeValues -- OUR OWN
   *  valuation function -- which makes the whole field a noisy copy of us. That self-reference is
   *  what hid the FLEX-baseline bug for months, and it means any edge measured against these bots
   *  might be an edge against ourselves. "rank" gives them a structurally INDEPENDENT book: a
   *  rank-decay curve fitted to how auction prices actually fall off, sharing no code path with
   *  computeValues beyond the raw projection everyone can see. */
  botBook?: "vor" | "rank";
  /** Replace every bot with ONE league-average manager. Per-owner profiles were shown (2026-09-05,
   *  scripts/manager-stability.mjs) to carry NO out-of-sample signal -- predicting an owner's
   *  held-out season from their own history is 18% WORSE than assuming they draft league-average --
   *  so this is the honest null field, and any conclusion that survives both is not relying on
   *  opponent identities we cannot actually predict. */
  homogeneous?: boolean;
}

/** Steepness of the rank-price curve. CALIBRATED against this room's real drafts rather than
 *  guessed: docs/league-tendencies.md reports median $2, 61% of picks $1-5 and a top price of
 *  $88-106 across 2023-2025, and `scripts/face-validity.mjs` scores a candidate book against those.
 *  The first value tried (2.2) spread money far too evenly -- median $8, only 39% cheap picks --
 *  which would have modelled a room that does not exist. Override with FF_RANK_DECAY to re-tune. */
export const RANK_DECAY = Number(process.env.FF_RANK_DECAY ?? 5);
// Calibration result (scripts/face-validity.mjs, 40 all-bot drafts vs 2023-25 real drafts):
//   decay 2.2 -> median $8.0, 39% of picks $1-5   (7/10 metrics)  -- a room that does not exist
//   decay 4   -> median $4.6, 54% cheap, top $121 (9/10)
//   decay 5   -> median $2.9, 60% cheap, top $148 (9/10)  <- SHIPPED
// 5 reproduces the MASS of the real distribution (total $3,157 = 2025 exactly; median $2.9 vs $2;
// 60.1% vs 61% of picks at $1-5) and the positional split (QB $296 vs 192-328, TE $233 vs 199-215).
// KNOWN RESIDUAL: top price $148 vs a real $88-106. Our bots are not budget-anxious at the very top,
// so the stud market is modelled hotter than reality -- treat conclusions about the most expensive
// handful of players (maxShare especially) as the least trustworthy part of the model.

/** An independent market book: price decays with a position's DRAFT RANK rather than with value over
 *  replacement. Real auction prices follow roughly this shape, and critically it is not our formula,
 *  so an edge measured against it is not an edge against a mirror of ourselves. Normalised so the
 *  book totals the league's discretionary money, exactly as computeValues does, to keep the two
 *  books on the same dollar scale (otherwise a cheaper book alone would look like an edge). */
export function rankBook(points: PointsRow[], lg: SimLeague, decay = RANK_DECAY): Map<string, number> {
  const byPos = new Map<string, PointsRow[]>();
  for (const p of points) { if (!byPos.has(p.pos)) byPos.set(p.pos, []); byPos.get(p.pos)!.push(p); }
  const discretionary = lg.teams * lg.budget - lg.teams * lg.slots.length;
  const { leagueShare } = loadManagers();
  const out = new Map<string, number>();
  for (const [pos, arr] of byPos) {
    arr.sort((a, b) => b.points - a.points);
    // Starters demanded league-wide at this position; beyond that the curve flattens to the $1 tail.
    const starters = Math.max(1, (lg.slots.filter((sl) => sl === pos).length + (["RB", "WR", "TE"].includes(pos) ? lg.slots.filter((sl) => sl === "FLEX").length : 0)) * lg.teams);
    const w = arr.map((_, i) => Math.exp(-decay * (i / starters)));
    const wTot = w.reduce((a, b) => a + b, 0) || 1;
    // SHAPE from rank decay (independent of VOR); LEVEL from what this room really spends at the
    // position. Without the level anchor a pure decay prices the top KICKER like an elite RB -- an
    // independent book, but one no real room resembles, so robustness measured against it would be
    // meaningless.
    const posMoney = (leagueShare[pos] ?? 0.01) * discretionary;
    arr.forEach((p, i) => out.set(p.name, Math.max(1, Math.round(1 + (w[i] / wTot) * posMoney))));
  }
  return out;
}

/** Run the auction. Seat 0 is US (real makeV2Strategy) unless includeUs=false; every other seat is a
 *  real MANAGER BOT modelled on this league's history (src/draft/managers.ts): each reproduces that
 *  owner's positional appetite + concentration, so the field is heterogeneous (QB-payers, RB-first,
 *  QB/TE-punters) instead of a uniform stud-overpayer. Returns every won player with team + price.
 *  Deterministic per seed. The returned Pick.team index maps to seatProfiles (see draftFieldSeats). */
export function draftField(points: PointsRow[], ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE, opts: DraftFieldOpts = {}): Pick[] {
  return draftFieldSeats(points, ourValues, cfg, seed, lg, opts).picks;
}

/** Like draftField but also returns which manager profile sits in each seat (for calibration). */
export function draftFieldSeats(points: PointsRow[], ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE, opts: DraftFieldOpts = {}): { picks: Pick[]; seatProfiles: (ManagerProfile | null)[] } {
  const rng = mulberry32(seed);
  const posMap = new Map(points.map((p) => [p.name, p.pos]));
  const trueVal = opts.botBook === "rank"
    ? rankBook(points, lg)
    : new Map(computeValues(points, resolveValueLeague(lg), cfg.maxKDst ?? 2).map((v) => [v.name, v.value]));
  const studRank = new Map([...trueVal.entries()].sort((a, b) => b[1] - a[1]).map(([n], i) => [n, i]));
  const { leagueShare } = loadManagers();

  const includeUs = opts.includeUs !== false;
  // seat -> manager profile (null = us). Bots get real profiles; if a profiles[] is passed use it.
  const botCount = includeUs ? lg.teams - 1 : lg.teams;
  let botProfiles = opts.profiles ?? assignSeats(botCount);
  if (opts.homogeneous) {
    const all = botProfiles;
    const avg = (f: (p: ManagerProfile) => number) => all.reduce((a, p) => a + f(p), 0) / all.length;
    const share: Record<string, number> = {};
    for (const k of Object.keys(all[0].share)) share[k] = avg((p) => p.share[k] ?? 0);
    const mean: ManagerProfile = { owner: "league-average", abbrev: "AVG", seasons: all[0].seasons,
      share, conc: avg((p) => p.conc), maxBuy: avg((p) => p.maxBuy), cheap: avg((p) => p.cheap) };
    botProfiles = all.map(() => mean);
  }
  const seatProfiles: (ManagerProfile | null)[] = [];
  const bidders: (BotBidder | null)[] = [];
  let bi = 0;
  for (let i = 0; i < lg.teams; i++) {
    if (includeUs && i === 0) { seatProfiles.push(null); bidders.push(null); }
    else { const p = botProfiles[bi++ % botProfiles.length]; seatProfiles.push(p); bidders.push(makeBotBidder(p, leagueShare)); }
  }

  const teams: { us: boolean; budget: number; slots: (string | null)[]; spentPos: Record<string, number> }[] = [];
  for (let i = 0; i < lg.teams; i++) teams.push({ us: includeUs && i === 0, budget: lg.budget, slots: lg.slots.map(() => null), spentPos: {} });
  const picks: Pick[] = [];

  const openIdxFor = (t: { slots: (string | null)[] }, pos: string): number => {
    let i = t.slots.findIndex((s, k) => s === null && lg.slots[k] === pos);
    if (i >= 0) return i;
    if (FLEX_OK.has(pos)) { i = t.slots.findIndex((s, k) => s === null && lg.slots[k] === "FLEX"); if (i >= 0) return i; }
    return t.slots.findIndex((s, k) => s === null && lg.slots[k] === "BE");
  };
  const openCount = (t: { slots: (string | null)[] }) => t.slots.filter((s) => s === null).length;
  const affordable = (t: { budget: number; slots: (string | null)[] }) => t.budget - Math.max(0, openCount(t) - 1);
  const slotsOpenByKey = (t: { slots: (string | null)[] }): Record<string, number> => {
    const out: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BENCH: 0 };
    t.slots.forEach((s, k) => { if (s === null) { const key = lg.slots[k] === "BE" ? "BENCH" : lg.slots[k]; out[key] = (out[key] ?? 0) + 1; } });
    return out;
  };

  const ourStrat = makeV2Strategy(cfg);
  const available = new Set(points.map((p) => p.name));
  let nom = 0, guard = 0;
  while (teams.some((t) => openCount(t) > 0) && available.size > 0 && guard++ < 6000) {
    let n = nom % lg.teams, tries = 0;
    while (openCount(teams[n]) === 0 && tries++ < lg.teams) n = (n + 1) % lg.teams;
    nom = n + 1;
    const nt = teams[n];
    let name: string, pos: string;
    if ((opts.drainNom || opts.greedyNom) && includeUs && n === 0) {
      // OUR nomination turn: drain the best-funded position-payer instead of value-greedy.
      const openPosOf = (t: typeof teams[number]) => { const s = new Set<string>(); t.slots.forEach((v, k) => { if (v === null) { const key = lg.slots[k]; s.add(key === "BE" || key === "FLEX" ? "RB" : key); if (key === "BE" || key === "FLEX") { s.add("WR"); s.add("TE"); } } }); return s; };
      const oppo = teams.map((t, ti) => ({ t, ti })).filter((x) => x.ti !== 0 && affordable(x.t) >= 1 && seatProfiles[x.ti])
        .map((x) => ({ share: seatProfiles[x.ti]!.share, budgetLeft: affordable(x.t), openPositions: openPosOf(x.t) }));
      const payers = payersFrom(oppo, leagueShare);
      const boardArr = [...available].map((nm) => ({ name: nm, pos: posMap.get(nm) ?? "", value: trueVal.get(nm) ?? 0 })).filter((p) => p.pos);
      // protect our own likely targets (top fillable-by-us players) from self-nomination
      const wanted = new Set(boardArr.filter((p) => openIdxFor(nt, p.pos) >= 0).sort((a, b) => b.value - a.value).slice(0, 3).map((p) => p.name));
      if (opts.greedyNom) {
        // put up the single best available player we don't want -> maximum field-wide bidding war
        const g = boardArr.filter((p) => !wanted.has(p.name)).sort((a, b) => b.value - a.value)[0] ?? boardArr[0];
        name = g.name; pos = g.pos;
      } else {
        const choice = planDrainNomination(boardArr, wanted, payers);
        name = choice.player.name; pos = choice.player.pos;
      }
    } else {
      const cand = [...available].map((nm) => ({ name: nm, pos: posMap.get(nm) ?? "", v: trueVal.get(nm) ?? 0 }))
        .filter((c) => c.pos && openIdxFor(nt, c.pos) >= 0).sort((a, b) => b.v - a.v)[0];
      if (!cand) { available.delete([...available][0]); continue; }
      name = cand.name; pos = cand.pos;
    }

    let bestTeam = -1, bestMax = 0, secondMax = 0;
    for (let ti = 0; ti < lg.teams; ti++) {
      const t = teams[ti];
      if (openIdxFor(t, pos) < 0) continue;
      const aff = affordable(t);
      if (aff < 1) continue;
      let max: number;
      if (t.us) {
        // Populate the live board + all-team budgets ONLY when repricing is on (per-bid O(available)).
        let board: DraftState["board"] = [], allTeams: DraftState["teams"] = [];
        if (cfg.inflation || cfg.scarcity) {
          board = [...available].map((nm) => ({ name: nm, pos: (posMap.get(nm) ?? "") as never, team: "", espnPreDraftVal: ourValues.get(nm) ?? trueVal.get(nm) ?? null }));
          allTeams = teams.map((tt, k) => ({ name: String(k), budgetLeft: tt.budget, openSlots: openCount(tt) }));
        }
        // Per-position inflation: empirical $/book by position from picks so far (market book = trueVal).
        const posInflation = cfg.posInflation ? positionInflationFactors(picks.map((pk) => ({ pos: pk.pos, price: pk.price, value: trueVal.get(pk.name) ?? 0 }))) : undefined;
        const state: DraftState = { myBudget: t.budget, mySlots: slotsOpenByKey(t), myRoster: [], onBlock: { name, pos: pos as never, team: "", espnPreDraftVal: ourValues.get(name) ?? null }, currentOffer: null, secondsLeft: null, iAmHighBidder: false, board, teams: allTeams, posInflation };
        max = Math.min(ourStrat.maxBid(state).maxBid, aff);
      } else {
        const base = trueVal.get(name) ?? 1;
        const rank = studRank.get(name) ?? 999;
        max = Math.min(bidders[ti]!(base, pos, rank, t.spentPos, rng), aff); // real-manager bid model
      }
      if (max > bestMax) { secondMax = bestMax; bestTeam = ti; bestMax = max; }
      else if (max > secondMax) secondMax = max;
    }
    available.delete(name);
    if (bestTeam < 0 || bestMax < 1) continue;
    const price = Math.max(1, Math.min(bestMax, secondMax + 1));
    const t = teams[bestTeam];
    t.slots[openIdxFor(t, pos)] = name; t.budget -= price;
    t.spentPos[pos] = (t.spentPos[pos] ?? 0) + price;
    picks.push({ name, pos, team: bestTeam, price });
  }
  return { picks, seatProfiles };
}

export interface SimResult { ourPoints: number; ourRank: number; fieldMean: number; ourSpentTop3: number; teams: number; }

/** One-shot season-points evaluation (fast; a rough proxy). For championship rate use backtest. */
export function runSim(points: PointsRow[], ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE): SimResult {
  const rng = mulberry32(seed * 7919 + 1);
  const realized = new Map(points.map((p) => [p.name, Math.max(0, p.points * (1 + gauss(rng) * 0.35))]));
  const picks = draftField(points, ourValues, cfg, seed, lg);
  const scores: number[] = [];
  for (let ti = 0; ti < lg.teams; ti++) scores.push(startingPoints(picks.filter((r) => r.team === ti).map((r) => ({ pos: r.pos, points: realized.get(r.name) ?? 0 })), lg));
  const ours = scores[0];
  const rank = [...scores].sort((a, b) => b - a).indexOf(ours) + 1;
  const ourTop3 = picks.filter((r) => r.team === 0).sort((a, b) => b.price - a.price).slice(0, 3).reduce((s, r) => s + r.price, 0);
  return { ourPoints: Math.round(ours), ourRank: rank, fieldMean: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length), ourSpentTop3: ourTop3, teams: lg.teams };
}

/** Best legal starting-lineup points for a set of rostered players (used for weekly + season). */
export function startingPoints(players: { pos: string; points: number }[], lg: SimLeague): number {
  const byPos: Record<string, { points: number }[]> = {};
  for (const p of players) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.points - a.points);
  let total = 0; const used = new Set<{ points: number }>();
  for (const slot of lg.slots) {
    if (slot === "BE") continue;
    if (slot === "FLEX") { let best: { points: number } | null = null; for (const p of FLEX_OK) { const a = (byPos[p] || []).find((x) => !used.has(x)); if (a && (!best || a.points > best.points)) best = a; } if (best) { used.add(best); total += best.points; } }
    else { const a = (byPos[slot] || []).find((x) => !used.has(x)); if (a) { used.add(a); total += a.points; } }
  }
  return total;
}
