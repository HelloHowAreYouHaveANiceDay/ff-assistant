// Compute OUR independent auction $ values from a projected-points table, via VOR -> $ (the
// standard VBD auction formula; see docs/value-methods.md). Pure + unit-testable.
//
// SLOT VOCABULARY LIVES IN ./slots.ts (I-2/I-3). `slotEligibility` used to be defined HERE and the
// bench test was a fifth hand-typed regex; both now come from the one module every consumer shares,
// and `slotEligibility` is re-exported so the dozen existing importers are unchanged.
import { isBenchSlot, slotEligibility } from "./slots.js";
export { slotEligibility, isBenchSlot, slotAdmits, slotAccepts, startingSlots, splitTemplate, isFlexSlot, eligibilityOf } from "./slots.js";

export interface PointsRow { name: string; pos: string; points: number; }
export interface ValueRow {
  name: string;
  pos: string;
  value: number;
  /** Which of his eligible positions the VOR was taken at. Equal to `pos` for everyone who is
   *  eligible at one position, i.e. for every player in this league today. */
  valuePos?: string;
}

/**
 * ELIGIBILITY, when the caller has it: nameKey -> the positions ESPN says a man may be started at.
 *
 * Absent, every function here behaves exactly as it did -- a player is eligible at his own position
 * and nowhere else. Present, a player named in the map is valued at the BETTER of his baselines.
 * `src/data/eligibility.ts` builds it, and deliberately omits single-eligible players: a missing
 * entry means "[his own position]", so an all-single league produces an EMPTY map and the diff is
 * visible in the map's size rather than hidden in its contents.
 */
export type EligibilityMap = Map<string, string[]>;

/** The positions a man may be valued at: his own, plus anything the map adds. Order is stable and
 *  starts with his own position, which is what makes the tie-break below a no-op for singles. */
function eligibleFor(p: PointsRow, elig?: EligibilityMap): string[] {
  const extra = elig?.get(nameKey(p.name));
  if (!extra || !extra.length) return [p.pos];
  const out = [p.pos];
  for (const x of extra) if (x !== p.pos) out.push(x);
  return out;
}

/** Canonical name key that survives ESPN-vs-our-CSV spelling drift (finding #5): lowercases, drops
 *  generational suffix tokens (Jr/Sr/II..V), drops a trailing d/st|dst token (so "Broncos D/ST"
 *  keys the same as "Broncos"), and strips everything but letters. Used to key our value table AND
 *  to look a player up, so both sides of the join normalize identically. */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/\bd\/?st\b/g, " ")
    .replace(/[^a-z]/g, "");
}

// Our value table stores defenses by ABBREVIATION ("HOU D/ST" -> nameKey "hou"), but ESPN's draft
// room displays the NICKNAME ("Texans D/ST" -> nameKey "texans"), so a live DST lookup misses and
// falls back to ESPN's on-screen value (F3). This maps every nickname/city spelling ESPN might show
// onto the abbreviation our table is keyed by. Built through nameKey so both sides normalize
// identically -- note "49ers" keys as "ers" once non-letters are stripped, which is exactly why the
// map is derived rather than hand-typed.
const DST_ALIASES: [string, string][] = [
  ["Cardinals", "ARI"], ["Arizona", "ARI"], ["Falcons", "ATL"], ["Atlanta", "ATL"],
  ["Ravens", "BAL"], ["Baltimore", "BAL"], ["Bills", "BUF"], ["Buffalo", "BUF"],
  ["Panthers", "CAR"], ["Carolina", "CAR"], ["Bears", "CHI"], ["Chicago", "CHI"],
  ["Bengals", "CIN"], ["Cincinnati", "CIN"], ["Browns", "CLE"], ["Cleveland", "CLE"],
  ["Cowboys", "DAL"], ["Dallas", "DAL"], ["Broncos", "DEN"], ["Denver", "DEN"],
  ["Lions", "DET"], ["Detroit", "DET"], ["Packers", "GB"], ["Green Bay", "GB"],
  ["Texans", "HOU"], ["Houston", "HOU"], ["Colts", "IND"], ["Indianapolis", "IND"],
  ["Jaguars", "JAC"], ["Jacksonville", "JAC"], ["Chiefs", "KC"], ["Kansas City", "KC"],
  ["Chargers", "LAC"], ["Rams", "LAR"], ["Raiders", "LV"], ["Las Vegas", "LV"],
  ["Dolphins", "MIA"], ["Miami", "MIA"], ["Vikings", "MIN"], ["Minnesota", "MIN"],
  ["Patriots", "NE"], ["New England", "NE"], ["Saints", "NO"], ["New Orleans", "NO"],
  ["Giants", "NYG"], ["Jets", "NYJ"], ["Eagles", "PHI"], ["Philadelphia", "PHI"],
  ["Steelers", "PIT"], ["Pittsburgh", "PIT"], ["Seahawks", "SEA"], ["Seattle", "SEA"],
  ["49ers", "SF"], ["San Francisco", "SF"], ["Niners", "SF"],
  ["Buccaneers", "TB"], ["Bucs", "TB"], ["Tampa Bay", "TB"],
  ["Titans", "TEN"], ["Tennessee", "TEN"], ["Commanders", "WAS"], ["Washington", "WAS"],
];

/** nameKey(ESPN's DST spelling) -> nameKey(our table's "<ABBR> D/ST" spelling). Abbreviations map to
 *  themselves so an already-correct name is a no-op. */
export const DST_KEY_ALIASES: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [alias, abbr] of DST_ALIASES) m[nameKey(alias)] = nameKey(abbr);
  for (const [, abbr] of DST_ALIASES) m[nameKey(abbr)] = nameKey(abbr);
  return m;
})();

/** Resolve any DST spelling to the key our value table uses; null if it is not a known defense. */
export function dstAliasKey(name: string): string | null {
  return DST_KEY_ALIASES[nameKey(name)] ?? null;
}

export interface ValueLeague {
  teams: number;
  budget: number;
  rosterSpots: number; // total roster size (for the $1 min-bid reserve)
  starters: Record<string, number>; // dedicated starters per team (QB/RB/WR/TE/K/DST), plus FLEX
  /** Dedicated (single-position) starters per team, keyed by position. Same numbers `starters` carries
   *  minus the flex buckets. Optional so a hand-built ValueLeague (DEFAULT_VALUE_LEAGUE) still works --
   *  `resolveSlots` reconstructs these from `starters` when absent. */
  dedicated?: Record<string, number>;
  /** Flex slot GROUPS per team, each with the positions it admits. This is what makes SUPERFLEX real:
   *  a `Q/W/R/T` group admits QB, so QBs compete for it and QB replacement level reflects it. ESPN's
   *  single `[RB,WR,TE]` group reproduces the old single-FLEX behavior exactly. */
  flexGroups?: { elig: string[]; count: number }[];
}

/** Split a ValueLeague into per-team dedicated counts + flex groups, from the new fields when present
 *  and reconstructed from the legacy `starters` map otherwise (so DEFAULT_VALUE_LEAGUE still works). */
function resolveSlots(lg: ValueLeague): { dedicated: Record<string, number>; flexGroups: { elig: string[]; count: number }[] } {
  if (lg.dedicated && lg.flexGroups) return { dedicated: lg.dedicated, flexGroups: lg.flexGroups };
  const dedicated: Record<string, number> = {};
  for (const [k, v] of Object.entries(lg.starters)) if (k !== "FLEX") dedicated[k] = v;
  const flexGroups = (lg.starters.FLEX ?? 0) > 0 ? [{ elig: FLEX_ELIGIBLE.slice(), count: lg.starters.FLEX }] : [];
  return { dedicated, flexGroups };
}

// rosterSpots MUST equal SIM_LEAGUE.slots.length (12) -- the real league is 16 teams x 12 slots.
// Kept as a literal (not imported from sim.ts, which imports THIS file) and bound by a test.
// Fallback only -- the live values come from resolveValueLeague(config). Starters match the real
// league's ESPN settings (1 RB, 1 WR, 2 FLEX), so even the fallback is honest.
export const DEFAULT_VALUE_LEAGUE: ValueLeague = {
  teams: 16, budget: 200, rosterSpots: 12,
  starters: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 2, K: 1, DST: 1 },
};

const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

/** Derive the VBD ValueLeague from the app config (the single source of format truth). Starters are
 *  counted from the configured slots (bench/IR excluded; FLEX kept as its own bucket), so changing
 *  the league's roster in config actually moves replacement levels and therefore the $ values. */
export function resolveValueLeague(cfg: { teams: number; budget: number; slots: string[] }): ValueLeague {
  const starters: Record<string, number> = {};
  const dedicated: Record<string, number> = {};
  const flexByKey = new Map<string, { elig: string[]; count: number }>();
  for (const s of cfg.slots) {
    if (isBenchSlot(s)) continue;
    const elig = slotEligibility(s);
    if (elig.length === 1) {
      dedicated[elig[0]] = (dedicated[elig[0]] ?? 0) + 1;
      starters[elig[0]] = (starters[elig[0]] ?? 0) + 1;      // legacy map: dedicated under its position
    } else {
      // Flex group, keyed by its (sorted) eligibility so W/R/T and Q/W/R/T are distinct buckets.
      const key = [...elig].sort().join("/");
      const g = flexByKey.get(key) ?? { elig, count: 0 };
      g.count++; flexByKey.set(key, g);
      starters.FLEX = (starters.FLEX ?? 0) + 1;              // legacy map: all flex collapse to FLEX
    }
  }
  return {
    teams: cfg.teams, budget: cfg.budget, rosterSpots: cfg.slots.length,
    starters, dedicated, flexGroups: [...flexByKey.values()],
  };
}

/**
 * THE POSITIONS THIS LEAGUE CAN ACTUALLY START -- dedicated slots plus anything a flex group admits.
 *
 * Yahoo 129048 rosters NO KICKER AND NO DEFENSE. Nothing in the value model knew that: the pool came
 * from a history CSV that scores K and DST rows (under the DEFAULT tables, because this league
 * declares none), `baselines()` computed a replacement level for them off that pool, and
 * `computeValues` handed every kicker a dollar figure. The consequences were not cosmetic -- the
 * board carried kickers a manager cannot roster, `waivers` could and did offer one, and the K/DST
 * reserve arithmetic had a live denominator for positions with zero slots.
 *
 * Returns `null` when the league is a LEGACY hand-built `ValueLeague` (a `starters` map with no
 * `dedicated`/`flexGroups`), because such a league has not told us its slot template -- only
 * `resolveValueLeague` knows it, and inferring "no K slot" from a map that simply omits the key
 * would silently delete kickers from `DEFAULT_VALUE_LEAGUE` and from every test fixture. Absent
 * evidence, nothing is excluded: this filter only ever fires on a league that named its slots.
 */
export function startablePositions(lg: ValueLeague): Set<string> | null {
  if (!lg.dedicated || !lg.flexGroups) return null;
  const out = new Set<string>(Object.keys(lg.dedicated));
  for (const g of lg.flexGroups) for (const p of g.elig) out.add(p);
  return out;
}

/**
 * The six positions this value model claims to price. Anything else in a pool (see below) is outside
 * its universe and is left exactly where it is.
 *
 * DUPLICATED FROM `slots.ts` ON PURPOSE -- that module is the slot vocabulary and imports nothing; a
 * second consumer importing a private constant back out of it is not what it is for. The two lists
 * are bound by `test/snake-kdst.test.ts`, which asserts this set is exactly the set of tokens
 * `slotEligibility` treats as a dedicated position.
 */
const PRICED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

/**
 * Drop players at positions the league has no slot for. Identity for ESPN (which starts a K and a
 * DST) and for any legacy `ValueLeague`; for Yahoo it removes every K and DST.
 *
 * THE SCOPE IS THE SIX PRICED POSITIONS, and that restriction is a measured decision, not timidity.
 * `data/history-points.csv` -- the incumbent's own backtest pool -- carries 24,579 IDP rows (LB
 * 7,350 / DB 9,669 / DL 7,560) alongside 16,666 skill rows. The ESPN league starts no linebacker
 * either, so a literal "drop every position with no slot" ALSO deletes those, and they are not
 * inert: `openIdxFor` puts them on the bench, so they really are drafted as bench filler, and their
 * VOR really does sit in `computeValues`'s denominator. Dropping them moved the incumbent golden
 * from 39.5%/96% to 36.0%/94% (measured, 1999-2024 n=150, 2026-09-16). That may well be an
 * improvement -- dead roster is dead roster -- but it is a VALUE CHANGE, and the one rule (D13) says
 * a value change is gated and signed off, not smuggled in inside a draft-seam refactor. So WP11
 * fixes the defect it was asked to fix (a league with no kicker slot must not be shown kickers) and
 * leaves the IDP question on the table with its number attached.
 */
export function filterToStartable(points: PointsRow[], lg: ValueLeague): PointsRow[] {
  const ok = startablePositions(lg);
  if (!ok) return points;
  return points.filter((p) => !PRICED_POSITIONS.has(p.pos) || ok.has(p.pos));
}

/** Replacement baseline points per position = the points of the first NON-startable player at
 *  that position across the whole league (dedicated starters + this position's share of FLEX).
 *
 *  The FLEX share is allocated POINTS-WEIGHTED by default (`flexWeighted`): the league's FLEX slots
 *  are filled with the best leftover FLEX-eligible players by projected points, and each position's
 *  share is however many of those it actually claims. The old even 3-way split
 *  (`round(flexTotal / 3)`) handed TE ~11 phantom starting slots in this league -- a weighted fill
 *  gives TE ZERO -- which took TE's baseline 11 ranks too deep and inflated every TE's VOR (and
 *  symmetrically starved WR). Measured at 13.6% -> 22.2% championships on the 2015-2024 backtest
 *  (docs/validation.md). `flexWeighted = false` keeps the old behavior for regression tests.
 *
 *  `eligibility` changes ONE thing and deliberately not more: which position a dual-eligible player
 *  is COUNTED UNDER when the FLEX slots are filled. It does NOT move him between the positional
 *  pools the baselines are read off. That restraint is the point -- moving a man from the RB list
 *  into the WR list changes the replacement level of every other RB and every other WR, which is a
 *  far larger claim than "this man may also be started at receiver", and nothing in ESPN's
 *  eligibleSlots supports it. So with no dual-eligible player in the pool the output is byte-for-byte
 *  the old one, which is the property test/values.test.ts asserts. */
export function baselines(
  points: PointsRow[], lg: ValueLeague, flexWeighted = true, eligibility?: EligibilityMap,
): Record<string, number> {
  const byPos: Record<string, { name: string; pts: number }[]> = {};
  for (const p of points) (byPos[p.pos] ??= []).push({ name: p.name, pts: p.points });
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.pts - a.pts);
  const { dedicated, flexGroups } = resolveSlots(lg);
  // The positions any flex group admits (RB/WR/TE for ESPN; +QB when a SUPERFLEX group exists).
  const flexElig = new Set<string>();
  for (const g of flexGroups) for (const p of g.elig) flexElig.add(p);
  const flexTotal = flexGroups.reduce((s, g) => s + g.count, 0) * lg.teams;

  // WHICH POSITION CLAIMS A DUAL-ELIGIBLE MAN IN THE FLEX FILL. Decided against the baselines
  // computed WITHOUT eligibility, because the question "where is he worth most" needs an answer
  // before the flex fill it feeds into can be run. One pass, not a fixed point: with nobody dual the
  // recursive call and this one agree exactly, and with a handful of duals a second iteration moves
  // nothing that the first did not.
  let claimOf: Map<string, string> | null = null;
  if (eligibility?.size) {
    const base0 = baselines(points, lg, flexWeighted);
    claimOf = new Map<string, string>();
    for (const p of points) {
      const cand = eligibleFor(p, eligibility).filter((x) => base0[x] != null);
      if (cand.length < 2) continue;
      let best = cand[0];
      for (const x of cand) if (p.points - base0[x] > p.points - base0[best]) best = x;
      claimOf.set(p.name, best);
    }
  }

  let flexCount: Record<string, number> | null = null;
  if (flexWeighted) {
    // Pool = every flex-eligible player beyond his position's DEDICATED starters, league-wide, tagged
    // with the position he is COUNTED under (his own, or a dual-eligible claim).
    const pool: { pos: string; pts: number }[] = [];
    for (const pos of flexElig) {
      const ded = (dedicated[pos] ?? 0) * lg.teams;
      const arr = byPos[pos] ?? [];
      for (let i = ded; i < arr.length; i++) {
        const claim = claimOf?.get(arr[i].name);
        pool.push({ pos: claim && flexElig.has(claim) ? claim : pos, pts: arr[i].pts });
      }
    }
    pool.sort((a, b) => b.pts - a.pts);
    // Fill flex slots by a LAMINAR GREEDY: each player (best first) takes the MOST-CONSTRAINED open
    // group that admits him. For nested eligibilities (W/R/T subset of Q/W/R/T) this maximizes total
    // starter points and puts QBs into SUPERFLEX only where they beat the available flex bodies --
    // which, under Yahoo's 6-pt/superflex scoring, is essentially all of them, taking QB replacement
    // level from ~QB13 to ~QB25. With a single [RB,WR,TE] group it reduces to "take the top flexTotal",
    // i.e. byte-for-byte the previous behavior (test/values.test.ts asserts the no-superflex case).
    const groups = flexGroups
      .map((g) => ({ elig: new Set(g.elig), size: g.elig.length, remaining: g.count * lg.teams }))
      .sort((a, b) => a.size - b.size);
    flexCount = {};
    for (const pos of flexElig) flexCount[pos] = 0;
    for (const p of pool) {
      const g = groups.find((grp) => grp.remaining > 0 && grp.elig.has(p.pos));
      if (g) { g.remaining--; flexCount[p.pos]++; }
    }
  }
  const evenShare = flexElig.size ? Math.round(flexTotal / flexElig.size) : 0;
  const out: Record<string, number> = {};
  for (const pos of Object.keys(byPos)) {
    const ded = (dedicated[pos] ?? 0) * lg.teams;
    const flexShare = flexElig.has(pos) ? (flexCount ? flexCount[pos] : evenShare) : 0;
    const startable = ded + flexShare;
    const arr = byPos[pos];
    out[pos] = (arr[startable] ?? arr[arr.length - 1])?.pts ?? 0; // first non-starter's points
  }
  return out;
}

/** Points table -> auction $ values. value = max(1, 1 + VOR x rate), rate spreads the
 *  discretionary money (total budget minus $1 per roster spot) across total positive VOR.
 *  K/DST are clamped to `maxKDst` ($2) -- this league streams them at $1-2 (finding #1), so a
 *  nominal points curve must not be allowed to price them like real starters. */
export function computeValues(
  points: PointsRow[], lg: ValueLeague = DEFAULT_VALUE_LEAGUE, maxKDst = 2, flexWeighted = true,
  eligibility?: EligibilityMap,
): ValueRow[] {
  // A POSITION WITH NO SLOT IS NOT PRICED (WP11). See `startablePositions`: for ESPN and for every
  // legacy `ValueLeague` this is the identity, so no incumbent number moves; for Yahoo it is what
  // stops the board carrying a kicker in a league that cannot start one.
  points = filterToStartable(points, lg);
  const base = baselines(points, lg, flexWeighted, eligibility);
  const ptsBy = new Map(points.map((p) => [p.name, p.points])); // for the tail tie-break below
  // A DUAL-ELIGIBLE PLAYER IS WORTH THE BETTER OF HIS BASELINES. VOR is the max over the positions
  // ESPN says he may be started at, and `valuePos` records which one won -- because "he is worth $34"
  // and "he is worth $34 AS A TIGHT END" are different facts, and only the second one tells a drafter
  // which hole the money filled. With no eligibility map every player has exactly one candidate and
  // this is the old single-position expression, unchanged.
  const withVor = points.map((p) => {
    const cand = eligibleFor(p, eligibility).filter((x) => base[x] != null);
    let bestPos = cand[0] ?? p.pos;
    for (const x of cand) if ((base[x] ?? 0) < (base[bestPos] ?? 0)) bestPos = x;
    return { ...p, valuePos: bestPos, vor: Math.max(0, p.points - (base[bestPos] ?? 0)) };
  });
  const streamed = (pos: string) => pos === "K" || pos === "DST";

  // K/DST are EXCLUDED from the VOR pool, not merely clamped after it.
  //
  // They used to be clamped at the end while their VOR still sat in the denominator. That was
  // harmless only because the projection curve gave them a fake ~20-point season, so their VOR was
  // ~0 and the denominator barely moved. Once K/DST got REAL projections (2026-09-07) their VOR
  // entered the pool properly, cut `rate` for every other player, and then evaporated at the clamp:
  // Gibbs fell $111 -> $96, a ~13% deflation of the entire book. Bidding a uniformly 13%-low book
  // against a room that is not 13% low would have quietly lost auctions, on top of the deliberate
  // `aggr` shading which is calibrated against a correctly-scaled book.
  //
  // The right accounting: if the policy is to spend at most $maxKDst on these positions, that money
  // is not discretionary and their surplus is not competing for it. Reserve their spend, take them
  // out of the denominator, and share what remains among the players actually being bid on.
  // ...but they get their OWN pool rather than no pool. A first version of this simply dropped them
  // from the denominator, which collapsed every kicker to the $1 floor and made `maxKDst` INERT --
  // the same dead-lever shape as the pre-2026-09-07 bug where the cap could not bind because the
  // pool held no K/DST to cap. test/values.test.ts caught it: its own fixture guard ("not exercising
  // the cap") fired, which is precisely why that guard is written to assert the cap CAN bind rather
  // than only that it does.
  const totalVor = withVor.reduce((s, p) => s + (streamed(p.pos) ? 0 : p.vor), 0) || 1;
  const kdstVor = withVor.reduce((s, p) => s + (streamed(p.pos) ? p.vor : 0), 0) || 1;
  // Reserve is per ACTUAL K/DST starter slot -- teams*2 for a league with a K and a DST (ESPN,
  // unchanged), but ZERO for a skill-only league (Yahoo rosters no K/DST), so no phantom money is
  // reserved out of the discretionary pool for positions that cannot be started.
  const ded = resolveSlots(lg).dedicated;
  const kdstSlots = ((ded.K ?? 0) + (ded.DST ?? 0)) * lg.teams;
  const reserved = kdstSlots * Math.max(0, maxKDst - 1);   // above the $1 floor everyone already gets
  const discretionary = lg.teams * lg.budget - lg.teams * lg.rosterSpots * 1 - reserved;
  const rate = discretionary / totalVor;
  const kdstRate = reserved / kdstVor;   // scales WITH maxKDst, so the lever stays live
  return withVor
    .map((p) => {
      const raw = Math.max(1, Math.round(1 + p.vor * (streamed(p.pos) ? kdstRate : rate)));
      const value = streamed(p.pos) ? Math.min(raw, maxKDst) : raw;
      return { name: p.name, pos: p.pos, value, valuePos: p.valuePos };
    })
    // Ties break on PROJECTED POINTS, not arbitrarily. Below replacement level VOR is 0 and every
    // player collapses to the $1 floor -- correct as valuation (no surplus over a freely available
    // body) but it destroys the ordering of a large, useful tail. At QB the baseline is the 17th QB
    // (one slot x sixteen teams, no FLEX), so ~10 startable quarterbacks all price at $1 despite a
    // 74-point spread between them. In the 2026-09-06 draft our cap was floored at $1 for the last
    // several slots, and the book gave the bidder no way to prefer Jordan Love (222 pts) over Jacoby
    // Brissett (149) -- it took whoever happened to be nominated. Dollar values are unchanged, so the
    // value gates are unaffected; this only fixes the ORDER the tail is presented in.
    .sort((a, b) => b.value - a.value || (ptsBy.get(b.name) ?? 0) - (ptsBy.get(a.name) ?? 0));
}
