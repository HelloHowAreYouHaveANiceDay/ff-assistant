// Draft field + one-shot season-points sim. `draftField` runs the auction (our real strategy vs a
// stud-overpaying bot field) and returns every team's roster -- reused by runSim (season points)
// AND by backtest.ts (real weekly schedule + playoffs -> championship rate). See docs/validation.md.

import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../data/paths.js";
import { loadPriceModel, priceFor, type PriceArtifact } from "../model/price.js";
import { makeV2Strategy, type DraftState, type PlayerRef, type V2Config } from "./strategy.js";
import { makeV3Strategy, type V3Config } from "./strategyV3.js";
import { availForRank, availFromVarianceModel } from "./lineupMarginal.js";
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
  botBook?: "vor" | "rank" | "price";
  /** Replace every bot with ONE league-average manager. Per-owner profiles were shown (2026-09-05,
   *  scripts/manager-stability.mjs) to carry NO out-of-sample signal -- predicting an owner's
   *  held-out season from their own history is 18% WORSE than assuming they draft league-average --
   *  so this is the honest null field, and any conclusion that survives both is not relying on
   *  opponent identities we cannot actually predict. */
  homogeneous?: boolean;
  /**
   * PER-BOT INDEPENDENT VIEW, as a log-sd on each bot's own bid.
   *
   * Without it every bot in the room prices from ONE book, so the field agrees about every player by
   * construction and a second-price auction clears within a dollar of the book almost every time.
   * Real rooms disagree, and the disagreement is what makes a nomination worth timing and a bargain
   * worth waiting for. Drawn per (bidder, player), median-preserving.
   *
   * NOT MEASURED DIRECTLY, and that is stated rather than buried: outcomes can only see the room's
   * SHARED error, so nothing in the historical record isolates how far two bidders' private views
   * diverge. It is BOUNDED above by the price model's leave-one-season-out residual dispersion
   * (0.35-0.90 in log dollars by tier over 2018-2025, scripts/price-loso.mjs; it was quoted as
   * 0.43-0.61 from the four-season fit) and set well below it, because a price
   * residual also contains roster need, budget state and auction noise -- all of which this
   * simulator already models separately and would otherwise count twice.
   */
  botIdioSd?: number;
  /**
   * WHICH BIDDER SITS IN OUR SEAT. "v2" (default) is the shipped, hand-tuned one; "v3" is the
   * derived one in strategyV3.ts.
   *
   * It is also readable from `FF_STRATEGY`, the same way `FF_RANK_DECAY` overrides the rank book, so
   * a sweep can select it without every caller in the chain growing a parameter. An explicit option
   * always wins over the environment.
   */
  strategy?: "v2" | "v3";
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

/**
 * THE THIRD BOOK: the price model fitted on this room's own 738 picks (src/model/price.ts).
 *
 * `vor` is our own valuation function, so the field is a noisy copy of us. `rank` is structurally
 * independent but its shape was TUNED until the simulated price distribution looked like the real
 * one. `price` is the only one FITTED on what the room actually paid, and it is the only one whose
 * error has been measured out of sample -- leave-one-season-out MAE $4.32 against $7.12 for `rank`
 * and $7.11 for `vor` (scripts/price-loso.mjs).
 *
 * EACH BOT DRAWS ITS OWN NOISE, which is the second half of the change and arguably the bigger one.
 * The other two books hand every bot the same number and let a small jitter separate them, so the
 * field agrees about every player by construction and a second-price auction clears at almost
 * exactly the book. Real rooms disagree. Here each bot's bid is the model's prediction times a draw
 * from the model's OWN MEASURED RESIDUAL DISTRIBUTION -- lognormal, per tier, mean and sd both taken
 * from the leave-one-season-out residuals rather than assumed:
 *
 *   tier      mean log(actual/pred)   sd
 *   top12            -0.18          0.538
 *   13-36            -0.10          0.429
 *   37-96            -0.04          0.530
 *   tail             -0.27          0.610
 *
 * The MEAN is carried, not discarded. It is the model's measured bias, and a noise term centred on 1
 * would re-introduce exactly the over-prediction the holdout measured. Re-run scripts/price-loso.mjs
 * if the model is refitted.
 */
export const PRICE_BOOK_NOISE: [number, number, number][] = [
  // [max overall rank, mean of log residual, sd of log residual]
  [12, -0.18, 0.538],
  [36, -0.10, 0.429],
  [96, -0.04, 0.530],
  [Infinity, -0.27, 0.610],
];
export const priceNoiseFor = (overallRank: number): [number, number] => {
  const t = PRICE_BOOK_NOISE.find(([hi]) => overallRank <= hi) ?? PRICE_BOOK_NOISE[PRICE_BOOK_NOISE.length - 1];
  return [t[1], t[2]];
};

let _priceModel: PriceArtifact | null | undefined;
/** Lazy, and it FAILS LOUDLY rather than falling back to another book. A `--bot-book price` run that
 *  quietly became a `vor` run would report a number for an opponent that was never used. */
export function loadPriceBook(): PriceArtifact {
  if (_priceModel === undefined) {
    const p = dataPath("price-model.json");
    _priceModel = existsSync(p) ? loadPriceModel(JSON.parse(readFileSync(p, "utf8"))) : null;
  }
  if (!_priceModel) {
    throw new Error(
      `--bot-book price needs ${dataPath("price-model.json")}, which is missing. Fit it with:\n` +
      `  uv run --with scikit-learn --with numpy tools/train_price.py --db data/ff.db --market-state quad`);
  }
  return _priceModel;
}

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

/**
 * OUR PREDICTIVE UNCERTAINTY, by within-position consensus rank, as a log-sd.
 *
 * These are the MEASURED consensus dispersions from `scripts/market-noise.mjs` (2020-2025, 2,851
 * scored player-seasons) -- the same table `--market ecr` uses for the room's shared error. They
 * stand in for the projection artifact's own p10/p90 inside the backtest, where no per-player
 * interval is threaded through the points table, and the substitution is stated rather than hidden:
 * it is the right ORDER of magnitude and the right SHAPE (a top-six player is far more predictable
 * than a 60th), and it is the market's error rather than specifically ours.
 */
export const OUR_SD_BAND: [number, number][] = [[6, 0.459], [12, 0.448], [24, 0.616], [40, 0.814], [60, 1.045], [Infinity, 1.214]];
export const ourSdFor = (posRank: number | null): number =>
  (posRank == null ? 1.214 : (OUR_SD_BAND.find(([hi]) => posRank <= hi) ?? OUR_SD_BAND[5])[1]);

/**
 * THE MARKET'S SHARED REALISED ERROR, by the same rank bands.
 *
 * It is the SAME ARRAY, deliberately and by reference rather than by a retyped copy, because that is
 * the fact the shading correction turns on: `OUR_SD_BAND` was built from `scripts/market-noise.mjs`,
 * which measures the CONSENSUS dispersion over 2020-2025 -- the room's error, not specifically ours.
 * `--market ecr` reads the identical table for the room (`MARKET_SD_BAND` in ff.ts). A second copy
 * here would let the two drift apart silently and make the subtraction below look like it measured
 * something.
 */
export const MARKET_SHARED_SD_BAND = OUR_SD_BAND;
export const marketSharedSdFor = (posRank: number | null): number =>
  (posRank == null ? 1.214 : (MARKET_SHARED_SD_BAND.find(([hi]) => posRank <= hi) ?? MARKET_SHARED_SD_BAND[5])[1]);

/**
 * THE PRIVATE PART OF OUR UNCERTAINTY -- the only part that creates a winner's curse.
 *
 * A SHARED error moves every bid in the room together, so the winner is not selected on it; only the
 * component by which OUR view diverges from the consensus decides how far the winner overpaid.
 * Subtracting the market's shared realised error from our own predictive spread, floored at zero, is
 * that component.
 *
 * AND IT IS EXACTLY ZERO HERE, at every rank, which is a finding rather than a bug. The backtest has
 * no per-player p10/p90 to thread through the historical points table, so V3's "our uncertainty" has
 * always been the measured CONSENSUS dispersion standing in for the artifact's interval -- and the
 * consensus dispersion IS the market's shared error. Our own uncertainty and the room's are the same
 * number in this harness, so combining them in quadrature was counting one quantity twice and the
 * honest shading is the price book's private spread alone.
 *
 * It is written as the subtraction rather than as a zero so the term stays LIVE: give the two bands
 * different numbers -- a real artifact interval, a re-fitted consensus table -- and it returns a real
 * private component with no other edit. A hardcoded zero would be a dead lever that reads exactly
 * like a measured null.
 */
export const ourSdPrivateFor = (posRank: number | null): number =>
  Math.max(0, ourSdFor(posRank) - marketSharedSdFor(posRank));

/**
 * Build V3's config from the same inputs the auction already has.
 *
 * WHAT IS NOT AVAILABLE HERE, said plainly because it bounds what the arbiter can measure about V3:
 * the historical points table carries no BYE WEEK, so the bye-collision term of the roster-aware
 * marginal is inert in the backtest. It is live for the live path and for `scripts/roster-book.mjs`,
 * both of which have byes. V3 is therefore being measured with one of its four advantages switched
 * off, which can only understate it.
 */
export function buildV3Config(
  points: PointsRow[],
  lg: SimLeague,
  o: { byeOf?: (n: string) => number | null; priceOf?: (n: string, pos: string) => number } = {},
): V3Config {
  const projMap = new Map(points.map((p) => [p.name, p.points]));
  const posRank = new Map<string, number>(), overallRank = new Map<string, number>();
  {
    const seen: Record<string, number> = {};
    [...points].sort((a, b) => b.points - a.points).forEach((p, i) => {
      seen[p.pos] = (seen[p.pos] ?? 0) + 1;
      posRank.set(p.name, seen[p.pos]);
      overallRank.set(p.name, i + 1);
    });
  }
  // Availability, from the fitted variance model where it is on disk -- PER PLAYER, tiered by his
  // rank in the positional pool exactly as `simulateSeasons` tiers him, with the positional average
  // over the top two tiers as the fallback.
  let avail: Record<string, number> = { QB: 0.90, RB: 0.82, WR: 0.85, TE: 0.85, K: 0.95, DST: 1.0 };
  let availOf: ((name: string, pos: string) => number | undefined) | undefined;
  {
    const p = dataPath("variance-model.json");
    if (existsSync(p)) {
      const vm = JSON.parse(readFileSync(p, "utf8"));
      avail = { ...avail, ...availFromVarianceModel(vm) };
      const poolOf: Record<string, number> = {};
      for (const r of points) poolOf[r.pos] = (poolOf[r.pos] ?? 0) + 1;
      availOf = (name, pos) => availForRank(vm, pos, (posRank.get(name) ?? 1) - 1, poolOf[pos] ?? 1);
    }
  }
  // THE STREAMING FLOOR, per week, derived the same way `simContext.ts` derives it: the body you can
  // actually add off waivers. League-wide starting demand plus one spare per team is the rank where
  // the free-agent pool begins, so the man at that rank is what an empty slot really scores.
  const NFL_WEEKS = 17;
  const replacement: Record<string, number> = {};
  {
    const byPos = new Map<string, number[]>();
    for (const p of points) (byPos.get(p.pos) ?? byPos.set(p.pos, []).get(p.pos)!).push(p.points);
    for (const [pos, list] of byPos) {
      list.sort((a, b) => b - a);
      const dedicated = lg.slots.filter((s) => s === pos).length;
      const flexShare = ["RB", "WR", "TE"].includes(pos) ? lg.slots.filter((s) => s === "FLEX").length / 3 : 0;
      const idx = Math.min(list.length - 1, Math.round((dedicated + flexShare + 1) * lg.teams));
      replacement[pos] = Math.max(0, (list[idx] ?? 0) / NFL_WEEKS);
    }
  }
  const vorPrice = o.priceOf ? new Map<string, number>() :
    new Map(computeValues(points, resolveValueLeague(lg), 2).map((v) => [v.name, v.value]));
  return {
    proj: (name) => projMap.get(name) ?? 0,
    byeOf: o.byeOf,
    lineup: { slots: lg.slots, flexOk: [...FLEX_OK], weeks: NFL_WEEKS, avail, replacement },
    availOf,
    // Default market: our own VOR book, which at least has a real $1 tail. The sim overrides it with
    // whichever book the room is actually bidding, which is the honest expectation of what we pay.
    priceOf: o.priceOf ?? ((name) => vorPrice.get(name) ?? 1),
    // OUR SIDE OF THE CURSE IS THE PRIVATE COMPONENT ONLY -- `ourSdPrivateFor`, our predictive
    // spread minus the market's shared realised error at the same rank band, floored at zero.
    //
    // The argument is not tuning, it is that a SHARED error creates no curse: if the whole room reads
    // the same projections and the same consensus, an error we all make moves every bid together and
    // the winner is not selected on it. Only the PRIVATE component -- how far two bidders' views of
    // the same man diverge, which is what the price model's residual dispersion measures -- decides
    // how much the winner over-paid. Combining our full spread in quadrature with the market's spread
    // counted the shared half twice, and it cost 12pp of playoff rate on the long churn arm.
    //
    // In this harness that private component is exactly zero at every rank, because the table
    // standing in for our interval IS the consensus dispersion (see `ourSdPrivateFor`). The
    // subtraction is written out anyway so a real artifact interval would make the term live again.
    //
    // `FF_V3_OURSD=full` restores the pre-2026-09-09 behaviour -- our whole spread, shared part
    // included -- which is the arm that measures what the double-count was worth. `FF_V3_SHADE=off`
    // removes the correction entirely, separating "the shading is wrong" from "the value is wrong";
    // without it a losing result cannot be attributed.
    ourSd: process.env.FF_V3_SHADE === "off" ? () => 0
      : process.env.FF_V3_OURSD === "full" ? (name) => ourSdFor(posRank.get(name) ?? null)
      : process.env.FF_V3_OURSD === "0" ? () => 0
      : (name) => ourSdPrivateFor(posRank.get(name) ?? null),
    marketSd: process.env.FF_V3_SHADE === "off" ? () => 0 : (name) => priceNoiseFor(overallRank.get(name) ?? 9999)[1],
    defaultBidders: Math.max(2, Math.round(lg.teams / 2)),
    // League-wide demand, which is what turns the streaming floor into a POSITIONAL REPLACEMENT
    // baseline inside the marginal (P30's defect). Without it V3 prices the first quarterback
    // against the waiver wire.
    //
    // THE BASELINE SENSITIVITY ARM, in the same shape as the two shading arms below it and for the
    // same reason: a result that cannot be attributed to a term is not a result. `FF_V3_BASELINE=off`
    // withholds league-wide demand, which is exactly the pre-2026-09-09 bidder -- every starting slot
    // measured against the waiver wire. Running both arms is what separates "the baseline fix moved
    // it" from "something else did", and it is the only way to say which half of V3 costs what.
    teams: process.env.FF_V3_BASELINE === "off" ? undefined : lg.teams,
  };
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

  // THE MARKET'S OWN ORDERING, from the projections everyone can see. `--bot-book price` is indexed
  // by CONSENSUS POSITIONAL RANK, which is what the model was fitted on, so it has to come from the
  // projection list rather than from a value book -- deriving it from `trueVal` would make the price
  // model a function of whichever book happened to be selected.
  const leagueMoney = lg.teams * lg.budget;
  const totalSlots = lg.teams * lg.slots.length;
  const priceModel = opts.botBook === "price" ? loadPriceBook() : null;
  const posRank = new Map<string, number>();
  const overallRank = new Map<string, number>();
  if (priceModel) {
    const sorted = [...points].sort((a, b) => b.points - a.points);
    const seen: Record<string, number> = {};
    sorted.forEach((p, i) => {
      seen[p.pos] = (seen[p.pos] ?? 0) + 1;
      posRank.set(p.name, seen[p.pos]);
      overallRank.set(p.name, i + 1);
    });
  }
  // The nomination book. For `price` it is the model evaluated at the START of the draft (inflation
  // exactly 1 by construction), so the order players come up in is stable and does not depend on the
  // state of a draft that has not happened yet.
  const trueVal = opts.botBook === "rank"
    ? rankBook(points, lg)
    : priceModel
      ? new Map(points.map((p) => [p.name, priceFor(priceModel, p.pos, {
        ecrPosRank: posRank.get(p.name) ?? null, ecrSd: null,
        moneyLeft: 1, slotsLeft: 1, pickShare: 0, leagueMoney,
      })]))
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

  // WHICH BIDDER SITS IN OUR SEAT. Explicit option first, environment second, V2 by default -- so
  // nothing about the shipped arbiter changes unless somebody asks for it.
  const useV3 = opts.strategy === "v3" || (opts.strategy == null && process.env.FF_STRATEGY === "v3");
  // V3's budget path is a PLAN and a plan needs prices, so it is handed the same book the room is
  // bidding from -- which is what we should honestly expect to pay, and keeps the plan from being
  // priced off our own valuation (the self-reference that hid the FLEX bug for months).
  const ourStrat = useV3
    ? makeV3Strategy(buildV3Config(points, lg, { priceOf: (name) => trueVal.get(name) ?? 1 }))
    : makeV2Strategy(cfg);
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

    // The room's state at THIS nomination, computed once rather than per bidder. Both quantities are
    // shares of their totals, so `infl` -- their ratio -- is exactly 1 at the first pick, which is
    // what makes it a market-state signal rather than a proxy for how far into the draft we are.
    let roomMoneyLeft = 0, roomSlotsLeft = 0;
    if (priceModel) {
      for (const tt of teams) { roomMoneyLeft += Math.max(0, tt.budget); roomSlotsLeft += openCount(tt); }
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
        // V3 reads the board (its shadow price is the value still available to us) and the seats
        // (its shading counts live bidders), so both are populated for it regardless of the V2
        // repricing flags. Neither costs anything when V3 is not in the seat.
        if (cfg.inflation || cfg.scarcity || useV3) {
          board = [...available].map((nm) => ({ name: nm, pos: (posMap.get(nm) ?? "") as never, team: "", espnPreDraftVal: ourValues.get(nm) ?? trueVal.get(nm) ?? null }));
          allTeams = teams.map((tt, k) => ({ name: String(k), budgetLeft: tt.budget, openSlots: openCount(tt) }));
        }
        // Per-position inflation: empirical $/book by position from picks so far (market book = trueVal).
        const posInflation = cfg.posInflation ? positionInflationFactors(picks.map((pk) => ({ pos: pk.pos, price: pk.price, value: trueVal.get(pk.name) ?? 0 }))) : undefined;
        // Room money + unfilled slots, stated explicitly so budgetPressure computes the SAME
        // quantity here and live (ff.ts). Cheap: one pass over teams, only when a term needs it.
        // V3 needs `leagueOpenSlots` for a SECOND reason: its positional replacement baseline scales
        // league-wide starting demand by the share of roster slots still open, so without it the
        // baseline is frozen at the pre-draft board and cannot tighten -- a dead lever wearing the
        // same flat line as a real null. V2's gate is untouched, so no V2 number moves.
        let leagueDollars: number | undefined, leagueOpenSlots: number | undefined;
        if (cfg.budgetPressure || useV3) {
          leagueDollars = teams.reduce((a, tt) => a + Math.max(0, tt.budget), 0);
          leagueOpenSlots = teams.reduce((a, tt) => a + openCount(tt), 0);
        }
        // What we have already WON, by position -- feeds maxAtPos. Cheap: our own filled slots.
        const myPosCounts: Record<string, number> = {};
        for (const nm of t.slots) if (nm) { const pp = posMap.get(nm); if (pp) myPosCounts[pp] = (myPosCounts[pp] ?? 0) + 1; }
        // OUR ROSTER, POPULATED. It was passed empty by both callers, which made anything keyed off
        // it a dead lever -- and V3's whole valuation is keyed off it, so it has to be real. V2 reads
        // it only in `nominate`, which the sim never calls, so filling it moves no V2 number.
        const myRoster: PlayerRef[] = [];
        for (const nm of t.slots) if (nm) myRoster.push({ name: nm, pos: (posMap.get(nm) ?? "") as never, team: "", espnPreDraftVal: null });
        const state: DraftState = { myBudget: t.budget, mySlots: slotsOpenByKey(t), myRoster, myPosCounts, onBlock: { name, pos: pos as never, team: "", espnPreDraftVal: ourValues.get(name) ?? null }, currentOffer: null, secondsLeft: null, iAmHighBidder: false, board, teams: allTeams, posInflation, leagueDollars, leagueOpenSlots };
        max = Math.min(ourStrat.maxBid(state).maxBid, aff);
      } else if (priceModel) {
        // THE PRICE BOOK. Each bot prices the player with the fitted model at the CURRENT market
        // state, then draws its OWN residual from the model's measured error distribution -- so the
        // field genuinely disagrees rather than sharing one number with a jitter on top. Budget
        // anxiety survives: `maxBuy` is the same soft cap the other books apply, and it is what
        // keeps the top of the market from clearing at a price nobody in this room has ever paid.
        const st = {
          ecrPosRank: posRank.get(name) ?? null, ecrSd: null,
          moneyLeft: Math.max(0, roomMoneyLeft / leagueMoney),
          slotsLeft: Math.max(1e-9, roomSlotsLeft / totalSlots),
          pickShare: picks.length / totalSlots,
          leagueMoney,
        };
        const [mu, sd] = priceNoiseFor(overallRank.get(name) ?? 9999);
        let bid = priceFor(priceModel, pos, st) * Math.exp(mu + gauss(rng) * sd);
        const prof = seatProfiles[ti];
        if (prof && prof.maxBuy > 0) bid = Math.min(bid, prof.maxBuy * (0.95 + rng() * 0.35));
        max = Math.min(Math.max(1, Math.round(bid)), aff);
      } else {
        const base = trueVal.get(name) ?? 1;
        const rank = studRank.get(name) ?? 999;
        max = Math.min(bidders[ti]!(base, pos, rank, t.spentPos, rng), aff); // real-manager bid model
      }
      // The bot's OWN view, on top of whichever book it priced from. Applied here rather than inside
      // each book so the three books are perturbed identically and a comparison between them is a
      // comparison of the books.
      if (!t.us && opts.botIdioSd) {
        const s = opts.botIdioSd;
        max = Math.min(Math.max(1, Math.round(max * Math.exp(gauss(rng) * s - 0.5 * s * s))), aff);
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
