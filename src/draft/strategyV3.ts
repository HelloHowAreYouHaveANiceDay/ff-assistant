/**
 * V3: THE LEVERS DERIVED INSTEAD OF TUNED.
 *
 * V2 is a static VOR book times five hand-tuned corrections: `aggr` 0.7 shades every bid, a
 * `benchDiscount` of 0.25 stands in for "a bench player rarely plays", a `starterReserve` and a
 * `maxShare` stand in for "do not strand the rest of the roster", a `premium` buys the last dollar,
 * and a positional multiplier sits ready for the case where the book prices a position wrongly.
 * Every one of them is a correction for the same missing quantity -- what the player is worth TO
 * THIS ROSTER. Measure that and they are not needed.
 *
 * So V3 is three terms and nothing else:
 *
 *   VALUE     the roster-aware marginal: expected starting-lineup points this man adds to the roster
 *             we actually hold, with depth, byes, FLEX and the streaming floor in it
 *             (draft/lineupMarginal.ts). This is what makes `benchDiscount`, `maxAtPos`, the bench
 *             K/DST refusal and the positional multipliers redundant rather than merely unused.
 *   PRICE     that marginal divided by a BUDGET SHADOW PRICE -- the marginal value per dollar of the
 *             best alternative use of our remaining money, taken as the summed marginals of the best
 *             men still available who fit our open slots. Live inflation, budget pressure, the
 *             starter reserve and the concentration cap are all consequences of this one ratio: a
 *             rich pool makes our dollars cheap and our bids fall; an empty one makes them dear.
 *   SHADING   a winner's-curse correction DERIVED from how uncertain we are about the player and how
 *             many bidders are live, rather than a tuned constant. Winning a common-value auction is
 *             evidence that you over-estimated, and the expected size of that over-estimate is the
 *             dispersion of views times the expected maximum of that many rival draws.
 *
 * V2 IS UNTOUCHED AND STAYS SELECTABLE. Whether V3 should replace it is a question for the
 * championship arbiter, and the arbiter's answer is recorded in docs/validation.md -- not assumed
 * here, and not decided by how clean the derivation looks.
 */
import { reserveForOthers, type DraftState, type PlayerRef, type Strategy } from "./strategy.js";
import { budgetPath, lineupMarginal, priceFromPath, type LmOpts, type LmPlayer, type PathPoint } from "./lineupMarginal.js";

export interface V3Config {
  /** SEASON projected points for a player. The only view of talent V3 has. */
  proj: (name: string, pos: string) => number;
  /** His bye week, if known. Absent, a bye collision cannot be priced and the marginal is the
   *  no-bye one -- a real degradation, so callers should pass it. */
  byeOf?: (name: string) => number | null;
  /** The league's slot template, availability by position, and the streaming floor. */
  lineup: LmOpts;
  /** Per-player availability, where the caller can tier him. Far better than the positional average
   *  -- see `LmPlayer.avail` for the three-quarterback story. */
  availOf?: (name: string, pos: string) => number | undefined;
  /** OUR predictive uncertainty for this player as a log-sd -- from the projection artifact's
   *  p10/p90. Zero for every player turns the shading off, which is the fault injection. */
  ourSd?: (name: string, pos: string) => number;
  /** The MARKET's spread for this player as a log-sd -- the price model's measured residual
   *  dispersion by tier (sim.ts `PRICE_BOOK_NOISE`). */
  marketSd?: (name: string, pos: string) => number;
  /** What the market charges for a pool player. The budget path is a PLAN, and a plan needs prices;
   *  in the sim this is the same book the bots bid from, which is the honest thing for us to expect
   *  to pay. */
  priceOf: (name: string, pos: string) => number;
  /** How many pool candidates the budget path may consider, and how many upgrade steps it walks.
   *  Both are cost knobs: the path is recomputed only when our roster or the board moves. */
  pathPool?: number;
  pathSteps?: number;
  /** Bidders assumed live when the state does not say (the live path passes one aggregate team). */
  defaultBidders?: number;
}

/** E[max of n independent standard normals], Blom's approximation. n <= 0 returns 0 -- there is no
 *  winner's curse when nobody else is bidding, which is the right answer rather than a degenerate
 *  one. */
export function expectedMaxNormal(n: number): number {
  if (n <= 0) return 0;
  return probit((n - 0.375) / (n + 0.25));
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * THE SHADING FACTOR, derived.
 *
 * Conditional on winning a common-value auction against `bidders - 1` rivals whose views are
 * dispersed, our own view was the highest of the room, and the expected size of that over-estimate
 * is the dispersion times the expected maximum of that many draws. In log dollars that is a
 * multiplicative discount, which is what this returns.
 *
 * `ourSd` is how wrong our projection can be for this man (the artifact's own interval); `marketSd`
 * is how far the room's views spread (the price model's measured residual dispersion by tier). They
 * combine in quadrature as independent sources of the same overpayment.
 *
 * With both at zero it returns EXACTLY 1 -- there is no curse when nobody can be wrong -- which is
 * the positive-and-negative control `scripts/v3-connected.mjs` runs.
 */
export function shadingFactor(ourSd: number, marketSd: number, bidders: number): number {
  const sd = Math.sqrt(Math.max(0, ourSd) ** 2 + Math.max(0, marketSd) ** 2);
  if (sd <= 0) return 1;
  return Math.exp(-sd * expectedMaxNormal(Math.max(0, bidders - 1)));
}

/** The open-slot template as an array, from the Engine's per-key counts. */
export function openSlotList(mySlots: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of Object.entries(mySlots)) for (let i = 0; i < Math.max(0, n); i++) out.push(k === "BENCH" ? "BE" : k);
  return out;
}

export function makeV3Strategy(cfg: V3Config): Strategy {
  const defaultBidders = cfg.defaultBidders ?? 8;
  const lm = (p: PlayerRef): LmPlayer => ({
    name: p.name, pos: p.pos, proj: cfg.proj(p.name, p.pos),
    bye: cfg.byeOf?.(p.name) ?? null, avail: cfg.availOf?.(p.name, p.pos),
  });

  // The shadow price is a property of the STATE, not of the man on the block, so it is recomputed
  // only when our roster changes or the board has moved materially. Pricing two dozen candidates on
  // every one of two hundred nominations is the difference between a backtest that runs and one that
  // does not.
  let pathKey = "";
  let path: PathPoint[] = [];
  const shadow = (state: DraftState, openSlots: string[]): PathPoint[] => {
    const key = `${state.myRoster.length}|${state.myBudget}|${Math.floor(state.board.length / 8)}`;
    if (key === pathKey) return path;
    const roster = state.myRoster.map(lm);
    path = budgetPath(
      roster, openSlots, state.board.map(lm),
      (x) => cfg.priceOf(x.name, x.pos), Math.max(0, state.myBudget),
      // THE LINEUP TEMPLATE IS THE LEAGUE'S, ALWAYS. It was briefly built as "a bench slot for each
      // man we hold, then the open slots", which is a different and catastrophic thing: once the
      // eight starting slots were won the template degenerated to twelve bench slots, nothing
      // started, every marginal became zero, and V3 declined every remaining player in the draft --
      // finishing with four empty roster spots and no bye cover. The roster OCCUPIES the template;
      // it does not define it.
      cfg.lineup,
      { poolSize: cfg.pathPool ?? 60, steps: cfg.pathSteps ?? 40 },
    );
    pathKey = key;
    return path;
  };

  /** The marginal in POINTS and the price in DOLLARS. Both, because they answer different
   *  questions: the dollars decide how high to go, and the points decide whether to bid AT ALL. A
   *  fourth receiver is worth a real fraction of a point a week and rounds to $0, and the first cut
   *  of this refused to bid on him -- so V3 filled its eight starting slots, declined every bench
   *  body in the draft, and went to war with four empty roster spots and no bye cover. */
  const detail = (p: PlayerRef, state: DraftState): { m: number; dollars: number; canFill: boolean } => {
    const openSlots = openSlotList(state.mySlots);
    if (!openSlots.length) return { m: 0, dollars: 0, canFill: false };
    const roster = state.myRoster.map(lm);
    const m = lineupMarginal(roster, lm(p), cfg.lineup);
    if (!(m > 0)) return { m: 0, dollars: 0, canFill: true };
    return { m, dollars: priceFromPath(shadow(state, openSlots), m, Math.max(0, state.myBudget)), canFill: true };
  };
  const value = (p: PlayerRef, state: DraftState): number => detail(p, state).dollars;

  return {
    value: (p, state) => Math.round(value(p, state)),
    maxBid(state) {
      const p = state.onBlock;
      if (!p) return { maxBid: 0, reason: "no player on block" };
      const { dollars: raw, canFill } = detail(p, state);
      // Live bidders: seats with money and a slot he could fill. Falls back to a stated constant
      // when the caller does not populate `teams` -- the live path passes one aggregate pseudo-team.
      const bidders = state.teams.length > 1
        ? state.teams.filter((t) => t.budgetLeft >= 1 && (t.openSlots ?? 1) > 0).length
        : defaultBidders;
      const shade = shadingFactor(cfg.ourSd?.(p.name, p.pos) ?? 0, cfg.marketSd?.(p.name, p.pos) ?? 0, bidders);
      // The ONLY clamp is legality -- keep a dollar for every slot that would remain open. There is
      // deliberately no soft reserve, no share cap and no positional cap: if the marginal is right,
      // a bid that would strand the roster cannot arise, because the men who would fill those slots
      // are in the denominator.
      const hardAffordable = state.myBudget - reserveForOthers(state, false, 1, 1);
      let maxBid = Math.round(raw * shade);
      // BID A DOLLAR FOR ANY SLOT WE CAN LEGALLY FILL, whatever the modelled marginal says.
      //
      // Two versions of this floor were wrong before this one, in the same direction and for the same
      // underlying reason: an empty roster spot scores nothing, so a $1 body is never worse than
      // leaving it open, and any rule that can decline one will eventually decline them all. Keying
      // the floor on the DOLLAR value declined every depth piece (they all round to $0); keying it on
      // the MARGINAL declined the ones whose marginal is a millionth of a point or, thanks to the
      // greedy queue approximation, a hair below zero. V3's first draft finished with eight men and
      // four empty spots. The slot is the thing that matters, so the slot is what the floor asks for.
      if (maxBid < 1 && hardAffordable >= 1 && canFill) maxBid = 1;
      maxBid = Math.max(0, Math.min(maxBid, hardAffordable));
      return { maxBid, reason: `v3 marginal->$${Math.round(raw)} x shade ${shade.toFixed(3)} (${bidders} live) -> ${maxBid}` };
    },
    // Nomination is unchanged in substance from V2's live policy: drain the room on a man we are not
    // targeting while budgets are fat, then self-win cheap keepers late. It is live-only -- the sim
    // has its own nomination paths -- so it moves no backtest number and is not part of what the
    // arbiter is being asked about here.
    nominate(state) {
      const rostered = new Set(state.myRoster.map((r) => r.name));
      const avail = state.board.filter((b) => !rostered.has(b.name));
      const byVal = avail.slice().sort((x, y) => value(y, state) - value(x, state));
      const targets = new Set(byVal.slice(0, 8).map((x) => x.name));
      const drain = byVal.find((x) => !targets.has(x.name) && value(x, state) >= 10);
      if (drain) return { player: drain, openingBid: 1, reason: "v3 drain non-target" };
      const keeper = byVal.find((x) => x.pos !== "K" && x.pos !== "DST") ?? byVal[0] ?? state.board[0];
      return { player: keeper, openingBid: 1, reason: "v3 late: best cheap keeper" };
    },
  };
}
