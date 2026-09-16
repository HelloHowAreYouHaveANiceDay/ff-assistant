/**
 * THE DRAFT SEAM (WP11) -- "how does a league hand players out", as a value.
 *
 * WHY THIS EXISTS. Every line of the draft engine in this repo assumes an AUCTION: `computeValues`
 * turns VOR into DOLLARS, `sim.ts` clears a second-price ascending auction, `nomination.ts` decides
 * whom to put up, and half the lever registry (`aggr`, `maxShare`, `starterReserve`, `maxBuy`) is
 * denominated in money. Yahoo 129048 is a 12-team SUPERFLEX SNAKE. None of those quantities has a
 * referent there -- which is exactly why `requireAuction` refused the pre-draft verbs rather than
 * printing a plausible dollar figure for a league with no dollars.
 *
 * So the draft becomes an interface with two implementations, and `backtest.ts` branches on the
 * format's `draftType` instead of calling `draftField` directly:
 *
 *   AuctionModel  a THIN wrapper over the existing `draftField` call, argument for argument. It adds
 *                 no behaviour and takes none away; the proof is the incumbent golden line, which
 *                 must stay byte-identical across this refactor (docs/validation.md records both
 *                 runs).
 *   SnakeModel    net-new: a serpentine pick order, a room that drafts BEST-AVAILABLE off a shared
 *                 book with an independent per-bot view, and a legality rule that stops anybody
 *                 drafting a fourth quarterback while a starting tight end slot is still open.
 *
 * WHAT IS DELIBERATELY *NOT* SHARED, because sharing it would be a wrong number rather than reuse:
 *
 *   - DOLLAR LEVERS. `aggr`, `maxShare`, `premium`, `starterReserve`, `benchReserve`, `maxBuy`,
 *     `maxKDst`, inflation, budget pressure, nomination (drain/greedy) -- all of them price or time
 *     a bid. A snake drafter cannot pay more; he can only pick sooner. They are IGNORED here, and
 *     `SNAKE_IGNORED_LEVERS` names them so a sweep can see the list instead of discovering it.
 *   - `starterReserve`'s SEMANTICS do survive, but as the legality rule rather than as a number:
 *     "hold money back for slots you still have to fill" becomes "hold PICKS back for slots you
 *     still have to fill", which is `startingDeficit(roster) <= picksLeft`. That is not a softened
 *     version of the dollar lever, it is the hard constraint the dollar lever was approximating.
 *   - DOLLAR VALUE. Our book for a snake is VOR in POINTS (`vorBook` below), not `computeValues`'s
 *     dollars. The dollar conversion divides the room's discretionary money across total positive
 *     VOR -- a monotone transform of VOR, so it would ORDER the board identically, but it would also
 *     round to integers and collapse the whole sub-replacement tail to $1, destroying the ordering
 *     of exactly the bench players rounds 11-17 are made of.
 *
 * WHAT IS SHARED, because it is genuinely draft-type-neutral: the pool and the market's view of it
 * (`--market`/`--market-noise`, applied upstream in `runBacktest`), the per-bot independent view
 * (`--bot-noise`), the value league (`resolveValueLeague`, superflex-aware), the slot vocabulary
 * (`slots.ts`), `benchDiscount`, `posMult`, `maxAtPos`, and every post-draft stage -- the schedule,
 * byes, the lineup optimizer, waivers, seeding and the bracket.
 */
import { splitTemplate } from "./slots.js";
import { baselines, nameKey, resolveValueLeague, startablePositions, type PointsRow, type ValueLeague } from "./values.js";
import { draftField, mulberry32, rankBook, type SimLeague, type DraftFieldOpts } from "./sim.js";
import type { V2Config } from "./strategy.js";
import type { ManagerProfile } from "./managers.js";

/** One drafted roster, in pick order. The backtest attaches projections itself. */
export type DraftedTeam = { name: string; pos: string }[];

/** The levers a snake draft has no referent for. Named, not discovered. */
export const SNAKE_IGNORED_LEVERS = [
  "aggr", "maxShare", "premium", "starterReserve", "benchReserve", "maxKDst",
  "inflation", "posInflation", "scarcity", "budgetPressure", "maxPressure", "drainNom", "greedyNom",
] as const;

/** THE ROOM. Draft-type-neutral where the field permits it; `adp` is snake-only. */
export interface DraftFieldSpec {
  botBook?: "vor" | "rank" | "price";
  /**
   * AUCTION ONLY, and a NO-OP for a snake BY CONSTRUCTION rather than by omission. It replaces every
   * bot's `managers.json` profile with one league-average manager; the snake room has no per-owner
   * profiles to replace (this league's own draft log is not in the store -- there is no
   * `raw_league_pick` for 129048 -- so the field is already a homogeneous best-available room). The
   * distinction matters: "already true" and "silently ignored" look identical in a sweep's output.
   */
  homogeneous?: boolean;
  /** Per-bot independent view, as a log-sd. The auction applies it to a bid; the snake applies it to
   *  the bot's perceived VALUE, which is the same perturbation one layer earlier. */
  botIdioSd?: number;
  profiles?: ManagerProfile[];
  variancePath?: string;
  /**
   * SNAKE ONLY -- the room's ORDER when a real preseason ADP archive exists for the season:
   * `nameKey(name)` -> ADP (lower = earlier). The value CURVE still comes from the pool's own VOR; only the ORDER is
   * ADP's. That construction is deliberate: an ADP is a rank, not a points estimate, and inventing a
   * decay to turn it into one would be a second, unmeasured model wearing the archive's authority.
   */
  adp?: Map<string, number>;
}

/** OUR side of the table. */
export interface OurSide {
  /** OUR book: dollars for an auction (`computeValues`), VOR points for a snake (`vorBook`). */
  values: Map<string, number>;
  cfg: V2Config;
  drainNom?: boolean;
  greedyNom?: boolean;
  /** SNAKE ONLY. Our 0-based draft slot. `null`/undefined = drawn at random per trial from the
   *  trial's own seed, so it is a COMMON RANDOM NUMBER: the same trial index draws the same slot in
   *  every arm and the pairing survives. */
  slot?: number | null;
}

export interface DraftModel {
  readonly kind: "auction" | "snake";
  /**
   * Run one draft. Returns one roster per team with OUR team at index 0 (both models), which is the
   * invariant `runBacktest` scores against.
   *
   * `seed` rather than an `rng` function, deliberately: the auction derives several independent
   * streams from the integer seed (`mulberry32(seed)`, `seed*104729+3`, ...), so handing it a single
   * pre-built generator would change the incumbent's numbers for no reason. The snake derives its
   * streams from the same integer the same way.
   */
  runDraft(pool: PointsRow[], league: SimLeague, field: DraftFieldSpec, ours: OurSide, seed: number): DraftedTeam[];
}

// =================================================================================================
// AUCTION -- the incumbent, wrapped and otherwise untouched
// =================================================================================================

export const AuctionModel: DraftModel = {
  kind: "auction",
  runDraft(pool, league, field, ours, seed) {
    const opts: DraftFieldOpts = {
      drainNom: ours.drainNom, greedyNom: ours.greedyNom,
      botBook: field.botBook, homogeneous: field.homogeneous,
      botIdioSd: field.botIdioSd, variancePath: field.variancePath,
      profiles: field.profiles,
    };
    const picks = draftField(pool, ours.values, ours.cfg, seed, league, opts);
    const rosters: DraftedTeam[] = Array.from({ length: league.teams }, () => []);
    for (const p of picks) rosters[p.team].push({ name: p.name, pos: p.pos });
    return rosters;
  },
};

// =================================================================================================
// SNAKE
// =================================================================================================

/** IR/ER slots are NOT draft rounds -- nobody drafts into injured reserve. Everything else on the
 *  template is (a bench slot is a real pick). Yahoo 129048: 19 slots - 2 IR = 17 rounds. */
const IR_SLOT = /^(IR|ER)$/i;
export function draftRounds(slots: readonly string[]): number {
  return slots.filter((s) => !IR_SLOT.test(String(s).trim())).length;
}

/** The serpentine order as an array of DRAFT POSITIONS, one entry per pick. */
export function serpentineOrder(teams: number, rounds: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < teams; i++) out.push(r % 2 === 0 ? i : teams - 1 - i);
  }
  return out;
}

/**
 * HOW MANY STARTING SLOTS THIS ROSTER STILL CANNOT FILL.
 *
 * The numeric sibling of `season.ts:rosterGaps` -- same template split (`splitTemplate`), same
 * narrowest-group-first laminar fill, same answer, as a count instead of a list of sentences.
 * `test/snake-legality.test.ts` asserts the two agree (deficit > 0 exactly when `rosterGaps` speaks),
 * because two implementations of "is this roster legal" that can disagree is precisely the bug this
 * repo keeps finding.
 */
export function startingDeficit(roster: readonly { pos: string }[], slots: readonly string[], flexOk?: Iterable<string>): number {
  const have: Record<string, number> = {};
  for (const p of roster) have[p.pos] = (have[p.pos] ?? 0) + 1;
  return deficitFromCounts(have, splitTemplate(slots, flexOk));
}

/** The same arithmetic over an already-parsed template and an already-counted roster. `runSnakeDraft`
 *  parses the template ONCE and calls this per (pick, candidate position) rather than re-parsing the
 *  slot list ~86 million times a sweep -- the answer is identical, which `test/snake-legality.test.ts`
 *  asserts against the parsing form above. */
export function deficitFromCounts(
  counts: Readonly<Record<string, number>>,
  tpl: { dedicated: Record<string, number>; flex: { elig: string[]; count: number }[] },
): number {
  const { dedicated: need, flex: groups } = tpl;
  const have: Record<string, number> = { ...counts };
  let deficit = 0;
  const spare: Record<string, number> = { ...have };
  for (const [pos, n] of Object.entries(need)) {
    const fill = Math.min(spare[pos] ?? 0, n);
    deficit += n - fill;
    spare[pos] = (spare[pos] ?? 0) - fill;
  }
  for (const g of groups) {                       // narrowest first -- laminar, so greedy is optimal
    let take = g.count;
    for (const pos of g.elig) {
      if (take <= 0) break;
      const use = Math.min(take, Math.max(0, spare[pos] ?? 0));
      spare[pos] = (spare[pos] ?? 0) - use;
      take -= use;
    }
    deficit += take;
  }
  return deficit;
}

/**
 * OUR BOOK FOR A SNAKE: VOR in POINTS, from the same `baselines()` the auction prices off.
 *
 * Not dollars (see the file header): the dollar conversion rounds and floors the sub-replacement
 * tail at $1, and rounds 11-17 of a 17-round draft are made entirely of that tail. VOR is floored at
 * 0 for the same reason the auction floors it -- a man below replacement is worth the same as the
 * next body off the wire -- but the raw points are kept as the tie-break so the tail still ORDERS.
 */
export function vorBook(points: readonly PointsRow[], lg: ValueLeague): Map<string, number> {
  const base = baselines([...points], lg);
  // A POSITION THE LEAGUE CANNOT START IS WORTH EXACTLY ZERO, and this is not a refinement -- without
  // it the model drafted 18% of every Yahoo roster as DEAD WEIGHT. The incumbent's history CSV
  // carries 24,579 IDP rows (LB/DB/DL) and the Yahoo target re-scores them, so they are in the pool;
  // their VOR is floored at 0 because the baseline at a position with no slot is the BEST player at
  // it. That left only the tie-break to order them, and the tie-break was raw points -- so a 200-point
  // linebacker outranked every sub-replacement receiver and rounds 12-17 filled with men who cannot
  // be started. Measured before the fix: 149 of 816 drafted players (2005/2012/2019/2024), ~18% of
  // every roster; after, zero.
  //
  // Zero rather than negative because the pick loop's comparison is strict `>`: every startable
  // player with any projection at all carries a positive tie-break, so an unstartable one can only be
  // taken when literally nothing else is legal. And it is scoped to the SNAKE book on purpose -- the
  // auction prices these men at the $1 floor and drafts them as bench filler today, which is a live
  // behaviour under the incumbent golden and a separate, gated question (docs/validation.md).
  const startable = startablePositions(lg);
  const out = new Map<string, number>();
  // The tie-break is a ten-thousandth of a point per point of raw projection: strictly smaller than
  // any real VOR gap, so it can only order players whose VOR is identical (i.e. the floored tail).
  for (const p of points) {
    const usable = !startable || startable.has(p.pos);
    out.set(p.name, usable ? Math.max(0, p.points - (base[p.pos] ?? 0)) + p.points * 1e-4 : 0);
  }
  return out;
}

/**
 * THE ROOM'S BOOK when the draft is a snake.
 *
 * Two forms, and which one runs is a property of the ARCHIVE, not a preference:
 *
 *   ADP present   the ORDER is the real preseason ADP for that season; the VALUE CURVE is the pool's
 *                 own VOR re-dealt in that order. Players the archive does not rank keep their own
 *                 VOR, ranked after everyone it does (an unranked man is a late-round body, which is
 *                 what "not in the top ~200 of a 12-team ADP" means).
 *   ADP absent    the pool's own VOR under this league's roster economics -- the snake analogue of
 *                 `--bot-book vor`, and superflex-aware for free because `resolveValueLeague` is.
 *                 `--bot-book rank` swaps in the independent rank-decay curve.
 */
export function roomBook(
  pool: readonly PointsRow[], lg: SimLeague, field: DraftFieldSpec,
  rankCurve?: Map<string, number>,
): Map<string, number> {
  const own = rankCurve ?? vorBook(pool, resolveValueLeague(lg));
  if (!field.adp || field.adp.size === 0) return own;
  // KEYED BY `nameKey`, not by the raw string. The FFC archive spells suffixes differently from the
  // history CSV ("Travis Etienne Jr." vs "Travis Etienne"), and a key miss is the WORST kind of
  // failure here: the player silently falls into the unranked tail and the arm degrades toward the
  // default book while still printing "ADP". `ff backtest` prints the per-season match count for
  // exactly that reason -- a zero would be visible instead of being read as a null result.
  const adpOf = (n: string) => field.adp!.get(nameKey(n));
  // Re-deal our own value curve in ADP order. Sorting is stable on ties via the name, so the book is
  // deterministic regardless of the pool's array order.
  const curve = [...own.values()].sort((a, b) => b - a);
  const ranked = [...pool].filter((p) => adpOf(p.name) != null);
  const unranked = [...pool].filter((p) => adpOf(p.name) == null);
  ranked.sort((a, b) => (adpOf(a.name)! - adpOf(b.name)!) || a.name.localeCompare(b.name));
  unranked.sort((a, b) => (own.get(b.name) ?? 0) - (own.get(a.name) ?? 0) || a.name.localeCompare(b.name));
  const out = new Map<string, number>();
  [...ranked, ...unranked].forEach((p, i) => out.set(p.name, curve[i] ?? 0));
  return out;
}

function gauss(rng: () => number): number {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * THE ROOM'S BENCH DISCOUNT.
 *
 * The same NUMBER as the shipped `benchDiscount` lever default (0.25), and that is the point rather
 * than a coincidence: it makes the positive control exact. With `--bot-noise 0` and our book equal to
 * the room's book, a room that also prices bench bodies the way we do must hand every seat the same
 * quality of roster, so "our roster value == the field average" is a REAL null rather than a null we
 * arranged by using a different rule on each side. Any difference between our lever and this constant
 * is then an edge we are deliberately taking, and `test/snake-face-validity.test.ts` measures it.
 *
 * It is a constant and not a read of our lever because the room does not run our strategy.
 */
export const BOT_BENCH_MULT = 0.25;

export interface SnakeOptions {
  /** Our 0-based draft slot, overriding `ours.slot` -- for a harness that sweeps the slot without
   *  rebuilding the whole `OurSide`. `null` keeps the per-trial draw. */
  ourSlotOverride?: number | null;
  /** Emit a pick log: round, draft position, team, player. Used by the face-validity harness. */
  log?: SnakePick[];
}

export interface SnakePick { round: number; pick: number; draftPos: number; team: number; name: string; pos: string; }

/**
 * A SNAKE DRAFT.
 *
 * The room picks BEST AVAILABLE off a shared book, each bot through its own independent view, subject
 * to one hard rule: a pick is legal only if the roster can still fill every starting slot with the
 * picks it has left. That single rule is what stops a bot taking a fourth quarterback in round 14 and
 * fielding an illegal lineup -- and it is the rule, not a heuristic, so it cannot be tuned away.
 * Within legality a player who FILLS a starting slot is preferred to one who can only sit on the
 * bench, by the bench multiplier (`BOT_BENCH_MULT` for the room, `cfg.benchDiscount` for us).
 *
 * WHAT WE DO DIFFERENTLY, and it is the entire edge surface: we pick off OUR value (`ours.values`),
 * with `posMult` and `maxAtPos` applied, and with no idiosyncratic noise (our projection error is
 * already in the pool the caller handed us). Everything else -- the order, the legality, the bench
 * rule -- is identical to the room's, so a measured difference is a difference of BOOK.
 */
export function runSnakeDraft(
  pool: PointsRow[], league: SimLeague, field: DraftFieldSpec, ours: OurSide, seed: number,
  opts: SnakeOptions = {},
): DraftedTeam[] {
  const T = league.teams;
  const rounds = draftRounds(league.slots);
  const rng = mulberry32(seed * 2654435761 + 11);
  // OUR SLOT. Drawn from the trial's own seed so it is a common random number across arms.
  const slotArg = opts.ourSlotOverride ?? ours.slot;
  const ourSlot = slotArg == null ? Math.floor(rng() * T) : ((slotArg % T) + T) % T;

  // draft position -> team index, with US at team 0. Bots take 1..T-1 in draft-position order.
  const teamAt: number[] = new Array(T).fill(-1);
  { let b = 1; for (let p = 0; p < T; p++) teamAt[p] = p === ourSlot ? 0 : b++; }

  // `--bot-book rank` gives the room the INDEPENDENT rank-decay curve instead of our own VOR -- the
  // same escape from self-reference the auction has, with ONE caveat that has to be said rather than
  // buried: `rankBook` anchors each position's LEVEL to `managers.json`'s league spend mix, which is
  // the ESPN 1-QB room's. Under superflex that understates QB demand, so for a superflex snake this
  // arm is a ROBUSTNESS check biased AGAINST our QB-heavy book, not a second honest room. (`price`
  // is fitted on ESPN auction dollars for one specific room and has no snake meaning at all; it
  // falls back to the same curve.)
  const curve = field.botBook === "rank" || field.botBook === "price" ? rankBook(pool, league) : undefined;
  const book = roomBook(pool, league, field, curve);
  const posOf = new Map(pool.map((p) => [p.name, p.pos]));
  const idio = field.botIdioSd ?? 0;
  // EACH BOT'S OWN VIEW, drawn once per (bot, player) rather than per pick -- a bot that re-drew its
  // opinion every round would have no opinion at all, and the room would converge on the book.
  const botView: Map<string, number>[] = [];
  for (let t = 0; t < T; t++) {
    if (t === 0) { botView.push(new Map()); continue; }
    const m = new Map<string, number>();
    if (idio > 0) for (const p of pool) m.set(p.name, Math.exp(gauss(rng) * idio - 0.5 * idio * idio));
    botView.push(m);
  }

  const rosters: DraftedTeam[] = Array.from({ length: T }, () => []);
  const available = new Set(pool.map((p) => p.name));
  const order = serpentineOrder(T, rounds);
  const flexOkNone = undefined;    // `flex_ok` is an ESPN league override; a snake format uses the slot token

  const ourBench = ours.cfg.benchDiscount ?? 1;
  const posMult = ours.cfg.posMult ?? {};
  const maxAtPos = ours.cfg.maxAtPos ?? {};

  // The template is parsed ONCE, and the deficit "if I add a player at position P" is computed once
  // per (pick, POSITION) rather than once per candidate -- there are at most six positions and there
  // are hundreds of candidates, and the answer depends only on the position.
  const tpl = splitTemplate(league.slots, flexOkNone);
  const positions = [...new Set(pool.map((p) => p.pos))];

  for (let pick = 0; pick < order.length; pick++) {
    const t = teamAt[order[pick]];
    const roster = rosters[t];
    const picksLeftAfter = rounds - Math.floor(pick / T) - 1;
    const posCount: Record<string, number> = {};
    for (const p of roster) posCount[p.pos] = (posCount[p.pos] ?? 0) + 1;
    const deficitNow = deficitFromCounts(posCount, tpl);
    const afterAt: Record<string, number> = {};
    for (const p of positions) afterAt[p] = deficitFromCounts({ ...posCount, [p]: (posCount[p] ?? 0) + 1 }, tpl);

    let bestName: string | null = null, bestScore = -Infinity, bestPos = "";
    for (const name of available) {
      const pos = posOf.get(name);
      if (!pos) continue;
      if (t === 0 && maxAtPos[pos] != null && (posCount[pos] ?? 0) >= maxAtPos[pos]) continue;
      const after = afterAt[pos];
      // THE LEGALITY RULE. `starterReserve`'s semantics, as a hard constraint: a pick is legal only
      // if the picks remaining still cover every starting slot the roster cannot fill.
      if (after > picksLeftAfter) continue;
      let v = book.get(name) ?? 0;
      if (t === 0) v = (ours.values.get(name) ?? 0) * (posMult[pos] ?? 1);
      else if (idio > 0) v *= botView[t].get(name) ?? 1;
      // BENCH-ONLY = he reduces no starting deficit. Uniform once the starters are full, so it only
      // discriminates while a starting slot is still open -- which is when it should.
      if (after >= deficitNow) v *= t === 0 ? ourBench : BOT_BENCH_MULT;
      if (v > bestScore) { bestScore = v; bestName = name; bestPos = pos; }
    }
    if (bestName == null) continue;      // nothing legal left for this seat (short pool)
    available.delete(bestName);
    roster.push({ name: bestName, pos: bestPos });
    opts.log?.push({ round: Math.floor(pick / T) + 1, pick: pick + 1, draftPos: order[pick], team: t, name: bestName, pos: bestPos });
  }
  return rosters;
}

export const SnakeModel: DraftModel = {
  kind: "snake",
  runDraft(pool, league, field, ours, seed) { return runSnakeDraft(pool, league, field, ours, seed); },
};

/** The model for a format's `draftType`. A third draft type is a named refusal, not a silent auction. */
export function draftModelFor(draftType: string): DraftModel {
  if (draftType === "auction") return AuctionModel;
  if (draftType === "snake") return SnakeModel;
  throw new Error(`no DraftModel for draft type "${draftType}" -- the backtest knows "auction" and "snake".`);
}
