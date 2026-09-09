/**
 * WHAT A PLAYER ADDS TO *THIS* ROSTER, under an objective the model can actually see.
 *
 * THE OBJECTIVE, first, because it is what makes this file different from `values.ts`.
 * P(title) = P(playoffs) x P(title | playoffs). Phase 2c scored the season simulator against 114
 * real team-seasons and found measurable skill on the FIRST factor (Brier 0.2370 against a uniform
 * 0.2451) and NONE on the second (0.0659 against 0.0652 -- worse than knowing nothing). Single
 * elimination among seven makes P(title | playoffs) very nearly uniform, and a quantity the model
 * cannot predict is a quantity that, optimised, optimises noise.
 *
 * So the PRIMARY number here is the change in P(playoffs). The SECONDARY is expected optimal-lineup
 * points in the three fantasy playoff weeks (`playoffWeekPts` from season.ts), which is the thing
 * left worth improving once a seed is secure. The change in P(title) is COMPUTED AND REPORTED
 * alongside, because refusing to show it would be its own kind of dishonesty, and it is never the
 * quantity that decides.
 *
 * WHY A MARGINAL AND NOT A VALUE. `computeValues` prices a player against a REPLACEMENT LEVEL
 * computed from the league's aggregate starting demand -- a property of the format, not of our
 * roster. It cannot see that our second quarterback only plays in one bye week, that our fourth
 * receiver is behind three better ones every Sunday, or that a man whose bye lands on the same week
 * as our only tight end's is worth less than an otherwise identical man. Everything the shipped
 * bidder does to patch that -- `benchDiscount`, `maxAtPos`, the bench K/DST refusal, the positional
 * multipliers -- is a hand-tuned correction for a quantity that can simply be measured instead.
 *
 * THE DOLLAR CONVERSION IS A SHADOW PRICE, and it is what makes this book comparable with the VOR
 * book rather than merely correlated with it. A marginal is in probability; a bid is in dollars. The
 * exchange rate is the marginal P(playoffs) per dollar of the BEST ALTERNATIVE USE of that dollar --
 * measured, not assumed, by filling the remaining slots from the remaining pool at the remaining
 * budget and asking what a dollar less would have bought. Then
 *
 *     dollars(player) = deltaP(player, at no cost) / (dP/d$ of the best alternative)
 *
 * which is exactly the price at which we are indifferent between having him and spending the money
 * elsewhere. Live inflation, budget pressure and the starter reserve are all consequences of that
 * one term rather than three separate levers: when the room is cheap the pool is fat and a dollar
 * buys more, so the denominator rises and our bids fall, with nothing to tune.
 *
 * COMMON RANDOM NUMBERS. Every candidate is evaluated against the SAME baseline under the SAME seed,
 * and `simulateSeasons` is identity-keyed (draft/rng.ts), so a player who appears in both arms lives
 * through the same season in both. Without that the differences between candidates are swamped by
 * which arm happened to draw a worse year, and at the trial counts an auction tick can afford the
 * noise is several times the effect.
 */
import { simulateSeasons, type SeasonOpts, type SeasonPlayer, type SeasonTeamInput, type VarianceModel } from "./season.js";

export type MarginalPlayer = SeasonPlayer;

/** Where the draft (or the season) currently stands, from our seat. */
export interface MarginalState {
  /** Players we have already won. */
  roster: MarginalPlayer[];
  /** Remaining OPEN slot keys, in the league's own vocabulary ("RB", "FLEX", "BE", ...). */
  openSlots: string[];
  /** Dollars we still have. */
  budget: number;
  /** Players still available to anybody. */
  pool: MarginalPlayer[];
  /** The other teams, as they stand. Their rosters are an input, not something this file invents. */
  opponents: SeasonTeamInput[];
  /** Our team's id/name in the simulated league. */
  meId?: string;
  meName?: string;
}

/** Everything about the LEAGUE that does not change between candidates. */
export interface MarginalEnv {
  weeks: [number, number][][];
  vm: VarianceModel;
  /** The shared season options, exactly as `SimContext.opts` builds them. */
  opts: (trials: number, seed: number) => SeasonOpts;
  slots: string[];
  flexOk?: string[];
  /** What the market would charge for a pool player. Used ONLY by the fill step. */
  priceOf: (p: MarginalPlayer) => number;
}

export interface MarginalOpts {
  trials?: number;
  seed?: number;
  /**
   * How many points on the BUDGET CURVE, the measured relationship between the money left for the
   * fill and the P(playoffs) it buys.
   *
   * A SINGLE FINITE DIFFERENCE IS NOT ENOUGH, and both ways of getting it wrong were measured before
   * this replaced them. A small step ($20 of $200) changes at most one pick by one tier, so the
   * effect sits at the noise floor and the price comes back pinned to whatever floor you gave it --
   * the dollar column is then a constant times the marginal, a ranking wearing a dollar sign. A large
   * step ($100) measures cleanly and then LINEARISES a curve that is violently convex: the last $100
   * of a $200 budget buys the difference between two backups, while the first $100 buys a stud, so
   * dividing a stud's marginal by the slope down there priced Ja'Marr Chase at $406 in a $200
   * auction. The curve is measured at several points and INVERTED instead, which is bounded by the
   * budget by construction because it is the same money on both sides.
   */
  shadowSteps?: number;
  /** Trials for the budget-curve arms. Paid ONCE per state, and every dollar figure is read off it,
   *  so it is worth more trials than any single candidate is. */
  shadowTrials?: number;
  /**
   * NAMES THE FILL MAY NOT USE -- normally every candidate being priced in this pass.
   *
   * WITHOUT IT THE BASELINE CONTAINS THE CANDIDATE and the marginal collapses to zero, silently. The
   * fill is greedy over the same pool the candidates come from, so the best candidate is exactly the
   * man it reaches for; both arms then hold him and the measured difference is Monte Carlo noise
   * around nothing. The first cut of this priced the best quarterback in the pool at 0.00pp filling
   * an EMPTY quarterback slot while pricing him at +7.33pp as a backup, which is the signature.
   *
   * Excluding the whole candidate set rather than the one player keeps a SINGLE shared baseline (and
   * therefore one budget curve and one set of random numbers) across the pass, and it is the honest
   * premise for a nomination anyway: we will win at most one of the men we are pricing, and the fill
   * is what the rest of the market leaves us.
   */
  fillExclude?: Iterable<string>;
}

export interface MarginalResult {
  name: string;
  pos: string;
  /** PRIMARY -- percentage points of P(playoffs). */
  playoffsPp: number;
  /** REPORTED ALONGSIDE, never used alone: percentage points of P(title). */
  titlePp: number;
  /** SECONDARY -- expected optimal-lineup points over the three playoff weeks. */
  playoffWeekPts: number;
  /** The primary marginal converted to dollars through the shadow price. */
  dollars: number;
  /** Which objective the `dollars` figure was derived from. Stated on every row. */
  objective: "playoffs";
}

const FLEX_KEYS = new Set(["FLEX", "OP", "RB/WR", "WR/TE"]);
const isBenchSlot = (s: string) => /^(BE|BENCH|IR|ER)$/i.test(s);

/** Can `pos` legally occupy slot `slot`? */
export function slotAccepts(slot: string, pos: string, flexOk?: readonly string[]): boolean {
  if (isBenchSlot(slot)) return true;
  if (FLEX_KEYS.has(slot)) return (flexOk ?? ["RB", "WR", "TE"]).includes(pos);
  return slot === pos;
}

/**
 * FILL THE REMAINING SLOTS AT THE BEST THE REMAINING MONEY CAN BUY.
 *
 * This is the "alternative use of the money" the shadow price is measured against, so it must be a
 * real plan rather than a placeholder: filling with $1 scrubs would make every candidate look like a
 * bargain, and filling with the pool's best would make every candidate look worthless.
 *
 * The rule is the one a manager actually follows: walk the open slots STARTING-SLOTS FIRST (a
 * starter scores every week; a bench body scores only when someone ahead of him does not play), and
 * for each take the highest-projected eligible player still affordable while keeping $1 for every
 * slot that would remain open after him. Deterministic, so two calls on the same state fill the same
 * way and the difference between two arms is the change and nothing else.
 */
export function fillRoster(state: MarginalState, env: MarginalEnv, budget: number, exclude: Set<string> = new Set()): MarginalPlayer[] {
  const taken = new Set(exclude);
  const out: MarginalPlayer[] = [];
  const slots = [...state.openSlots];
  let money = budget;
  const pool = [...state.pool].sort((a, b) => b.proj - a.proj);
  const price = (p: MarginalPlayer) => Math.max(1, Math.round(env.priceOf(p)));

  // A BENCH SLOT IS NOT A STARTING SLOT and pricing it as one is how the first version of this
  // filled four bench slots with quarterbacks: raw season points put every QB above every WR, and
  // "the highest projection that fits" is then a quarterback every time. A bench body only scores in
  // the weeks the man ahead of him does not, so his points are discounted here to roughly the share
  // of weeks that happens in. It is a stated weight on a PLAN, not a valuation -- the valuation is
  // the simulation, which sees the bench correctly all on its own.
  // A bench QUARTERBACK is worth less again than a bench receiver, and the first version of this
  // bought four of them: raw season points put every QB above every WR, so "the best bench body
  // available" was a quarterback four times over. QB, K and DST are the three positions this league
  // streams -- `SeasonOpts.replacement` is the measured model of exactly that -- so a second one on
  // the bench buys almost nothing, while a fourth back or receiver is real depth for two FLEX slots.
  const BENCH_WEIGHT: Record<string, number> = { QB: 0.05, K: 0.02, DST: 0.02, RB: 0.25, WR: 0.25, TE: 0.15 };
  const weight = (slot: string, pos: string) => (isBenchSlot(slot) ? (BENCH_WEIGHT[pos] ?? 0.2) : 1);

  // The replacement each slot is measured against: the best body that costs a dollar. Without it the
  // ratio below rewards buying an expensive player over a nearly-as-good free one.
  // Weighted projection: what a body in THIS slot is worth to the plan. Used by the cheap pass and
  // the upgrade comparison alike, which matters -- comparing a bench candidate against the bench
  // incumbent on RAW points let a $1 quarterback sit in a bench slot permanently, because no back or
  // receiver out-scores a quarterback on the raw curve and every upgrade therefore read as negative.
  const wproj = (slot: string, p: MarginalPlayer) => weight(slot, p.pos) * p.proj;

  // FILL CHEAP, THEN UPGRADE -- which is what a manager with a fixed number of slots and a fixed
  // budget actually does, and the only one of the three rules tried here that both fills every slot
  // and spends the money.
  //
  //   "best affordable, slot by slot" put $190 on one man and $1 bodies everywhere else, so the
  //   budget curve it produced was nearly flat, and a flat curve prices every candidate at the whole
  //   budget regardless of who he is.
  //   "greedy on points per dollar" never spends the budget at all: cheap men always win a ratio
  //   contest, the slots run out first, and $150 is left on the table.
  //
  // Upgrading spends until no upgrade is affordable, which is the actual constraint.
  const filled: (MarginalPlayer | null)[] = slots.map(() => null);
  // Scarcest slot first for the cheap pass, so a dedicated RB slot is not left empty because FLEX
  // took the last $1 back.
  const order = slots.map((_s, i) => i).sort((a, b) => {
    const rank = (s: string) => (isBenchSlot(s) ? 2 : FLEX_KEYS.has(s) ? 1 : 0);
    return rank(slots[a]) - rank(slots[b]);
  });
  for (const i of order) {
    let hit: MarginalPlayer | null = null;
    for (const p of pool) {
      if (taken.has(p.name) || !slotAccepts(slots[i], p.pos, env.flexOk) || price(p) > 1) continue;
      if (!hit || wproj(slots[i], p) > wproj(slots[i], hit)) hit = p;
    }
    if (!hit) continue;
    taken.add(hit.name);
    filled[i] = hit;
    money -= price(hit);
  }
  for (let guard = 0; guard < 400; guard++) {
    let best: { i: number; p: MarginalPlayer; gain: number; cost: number } | null = null;
    for (let i = 0; i < slots.length; i++) {
      const cur = filled[i];
      const curCost = cur ? price(cur) : 0;
      const rep = cur ? wproj(slots[i], cur) : 0;
      for (const p of pool) {
        if (taken.has(p.name) || !slotAccepts(slots[i], p.pos, env.flexOk)) continue;
        const extra = price(p) - curCost;
        if (extra <= 0 || extra > money) continue;
        const gain = wproj(slots[i], p) - rep;
        if (gain <= 0) continue;
        if (!best || gain / extra > best.gain / best.cost) best = { i, p, gain, cost: extra };
      }
    }
    if (!best) break;
    const old = filled[best.i];
    if (old) taken.delete(old.name);
    taken.add(best.p.name);
    filled[best.i] = best.p;
    money -= best.cost;
  }
  for (const p of filled) if (p) out.push(p);
  return out;
}

/** A stable key for a roster state, so the cache cannot serve one state's answer for another's. */
export function stateHash(state: MarginalState, budget: number): string {
  return [
    state.roster.map((p) => p.name).sort().join("|"),
    [...state.openSlots].sort().join(","),
    budget,
    state.pool.length,
  ].join("#");
}

/**
 * A cached evaluator. One instance per decision point; candidates share the baseline, the shadow
 * price and the random numbers, which is where all the speed comes from.
 */
export class MarginalBook {
  private cache = new Map<string, { playoffs: number; title: number; poPts: number }>();
  private curve: { dollars: number; playoffs: number }[] | null = null;
  readonly trials: number;
  readonly seed: number;
  readonly shadowSteps: number;
  readonly shadowTrials: number;
  readonly fillExclude: Set<string>;
  /** How many times `simulateSeasons` was actually called. Reported by the harness, so a claim about
   *  cost is a count rather than an estimate. */
  runs = 0;

  constructor(private state: MarginalState, private env: MarginalEnv, o: MarginalOpts = {}) {
    this.trials = o.trials ?? 200;
    this.seed = o.seed ?? 7;
    this.shadowSteps = o.shadowSteps ?? 6;
    this.shadowTrials = o.shadowTrials ?? this.trials * 2;
    this.fillExclude = new Set(o.fillExclude ?? []);
  }

  /** Simulate one hypothetical of OUR roster against the standing field. */
  private run(mine: MarginalPlayer[], tag: string, trials = this.trials): { playoffs: number; title: number; poPts: number } {
    const hit = this.cache.get(tag);
    if (hit) return hit;
    const teams: SeasonTeamInput[] = [
      { id: this.state.meId ?? "us", name: this.state.meName ?? "us", roster: mine.map((p) => ({ ...p })) },
      ...this.state.opponents.map((t) => ({ ...t, roster: t.roster.map((p) => ({ ...p })) })),
    ];
    const opts = { ...this.env.opts(trials, this.seed), playoffWeekStrength: true, allowIncompleteRosters: true };
    this.runs++;
    const r = simulateSeasons(teams, this.env.weeks, this.env.vm, opts)[0];
    const v = { playoffs: r.playoffs, title: r.champion, poPts: r.playoffWeekPts };
    this.cache.set(tag, v);
    return v;
  }

  /**
   * Our roster with every open slot filled from the pool at `budget`, BARRED from using anyone in
   * `exclude`.
   *
   * The exclusion is part of the cache key, which is the whole reason this is one function rather
   * than two: called from `rank`, every candidate is already barred and the key is identical for all
   * of them, so one baseline is simulated. Called on a single player, the key differs and he gets his
   * own correct baseline. A cache keyed on the state alone would serve the first candidate's
   * baseline -- which contains the SECOND candidate -- to the second.
   */
  baselineAt(budget: number, trials = this.trials, exclude: Set<string> = this.fillExclude): { playoffs: number; title: number; poPts: number } {
    const fill = fillRoster(this.state, this.env, budget, new Set(exclude));
    return this.run([...this.state.roster, ...fill], `base@${stateHash(this.state, budget)}@${trials}@${excludeKey(exclude)}`, trials);
  }

  /**
   * THE BUDGET CURVE: what P(playoffs) the FILL buys at each level of remaining money.
   *
   * This is the "best alternative use of the money", measured rather than assumed, and it is the
   * only place inflation, budget pressure and the starter reserve enter the system. Every arm runs
   * under the same seed, so the curve is a curve and not a walk.
   *
   * It is forced MONOTONE after measurement. More money cannot buy a worse fill -- the fill rule is
   * greedy and its choice set only grows -- so a decreasing pair is Monte Carlo error, and leaving it
   * in would make the inversion below multi-valued and hand one candidate a dollar figure from the
   * wrong branch.
   */
  budgetCurve(): { dollars: number; playoffs: number }[] {
    if (this.curve) return this.curve;
    const pts: { dollars: number; playoffs: number }[] = [];
    for (let k = 0; k <= this.shadowSteps; k++) {
      const b = Math.round((this.state.budget * k) / this.shadowSteps);
      pts.push({ dollars: b, playoffs: 100 * this.baselineAt(Math.max(1, b), this.shadowTrials).playoffs });
    }
    for (let i = 1; i < pts.length; i++) pts[i].playoffs = Math.max(pts[i].playoffs, pts[i - 1].playoffs);
    this.curve = pts;
    return pts;
  }

  /**
   * The local slope at the TOP of the budget: percentage points of P(playoffs) per dollar of the
   * best alternative use, at the money we actually hold. Reported because it is the number a reader
   * wants ("what is a dollar worth to us right now"); the dollar column does NOT divide by it, for
   * the convexity reason recorded on `shadowSteps`.
   */
  shadowPricePpPerDollar(): number {
    const c = this.budgetCurve();
    const a = c[c.length - 2], b = c[c.length - 1];
    return (b.playoffs - a.playoffs) / Math.max(1, b.dollars - a.dollars);
  }

  /**
   * INVERT THE CURVE: the price at which giving up that much fill money costs exactly `dPp`.
   *
   * That is the indifference price -- pay more and the money would have bought more elsewhere -- and
   * it is bounded by the budget by construction, because both sides of the comparison are the same
   * money. A marginal larger than the whole curve's range means the player is worth more than
   * everything the budget can buy, and the honest answer there is the budget itself.
   */
  dollarsFor(dPp: number): number {
    if (!(dPp > 0)) return 0;
    const c = this.budgetCurve();
    const top = c[c.length - 1].playoffs;
    for (let i = c.length - 2; i >= 0; i--) {
      const loss = top - c[i].playoffs;                       // what giving up down to this level costs
      if (loss >= dPp) {
        const prev = c[i + 1], lossPrev = top - prev.playoffs;
        const span = loss - lossPrev;
        const frac = span > 0 ? (dPp - lossPrev) / span : 0;
        // The curve is indexed by MONEY REMAINING; the answer is the money GIVEN UP.
        const level = prev.dollars - frac * (prev.dollars - c[i].dollars);
        return Math.max(0, Math.round(this.state.budget - level));
      }
    }
    return this.state.budget;
  }

  /**
   * What `player` adds to THIS roster, at no cost, with the rest of the slots filled the same way.
   *
   * AT NO COST is deliberate and is what makes the dollar conversion a shadow price rather than a
   * circular one: the money is held constant between the arms, the player takes a SLOT, and the
   * price falls out of dividing the gain by what that money buys elsewhere.
   */
  marginal(player: MarginalPlayer, excludeOverride?: Set<string>): MarginalResult {
    const budget = this.state.budget;
    // HE IS BARRED FROM HIS OWN BASELINE. The fill is greedy over the same pool he came from, so
    // without this the baseline reaches for exactly him and the marginal is zero by construction.
    //
    // `excludeOverride` LETS ONE BOOK ANSWER BOTH FRAMINGS FROM ONE SET OF RANDOM NUMBERS, which is
    // what `scripts/marginal-agreement.mjs` needs and is not a convenience: the SHARED exclusion (the
    // whole candidate set barred, the nomination-pass premise) and the PER-CANDIDATE one (only this
    // man barred, the honest single-player question) give materially different levels, and measuring
    // them in two separate runs of a stochastic simulator would attribute the difference between two
    // samples to the difference between two framings.
    const exclude = excludeOverride
      ?? (this.fillExclude.has(player.name) ? this.fillExclude : new Set([...this.fillExclude, player.name]));
    const base = this.baselineAt(budget, this.trials, exclude);
    // He occupies the best slot he is eligible for; the fill then has one fewer slot to cover.
    const slots = [...this.state.openSlots];
    let idx = slots.findIndex((s) => !isBenchSlot(s) && !FLEX_KEYS.has(s) && slotAccepts(s, player.pos, this.env.flexOk));
    if (idx < 0) idx = slots.findIndex((s) => FLEX_KEYS.has(s) && slotAccepts(s, player.pos, this.env.flexOk));
    if (idx < 0) idx = slots.findIndex((s) => isBenchSlot(s));
    if (idx < 0) {
      // No slot he can fill: he is worth exactly nothing to this roster, and that is an answer.
      return { name: player.name, pos: player.pos, playoffsPp: 0, titlePp: 0, playoffWeekPts: 0, dollars: 0, objective: "playoffs" };
    }
    const rest: MarginalState = { ...this.state, openSlots: slots.filter((_, i) => i !== idx) };
    const fill = fillRoster(rest, this.env, budget, new Set(exclude));
    // THE EXCLUSION IS PART OF THE TAG. The `after` arm's FILL is drawn under the same exclusion as
    // the baseline, so two framings of the same player are two different rosters; a tag that named
    // only the player would have served the first framing's answer to the second, silently, the
    // moment anything asked for both.
    const after = this.run([...this.state.roster, { ...player }, ...fill], `add:${player.name}@${stateHash(this.state, budget)}@${excludeKey(exclude)}`);
    const playoffsPp = 100 * (after.playoffs - base.playoffs);
    return {
      name: player.name,
      pos: player.pos,
      playoffsPp: round2(playoffsPp),
      titlePp: round2(100 * (after.title - base.title)),
      playoffWeekPts: round2(after.poPts - base.poPts),
      dollars: this.dollarsFor(playoffsPp),
      objective: "playoffs",
    };
  }

  /**
   * Every candidate, COARSE-TO-FINE.
   *
   * A full nomination evaluation is dozens of candidates and only the top handful will ever be bid
   * on, so spending the same trial budget on the 40th-best player as on the best is waste. The
   * coarse pass ranks everybody at `trials`; the fine pass re-measures the top `refineTop` at
   * `refineTrials` under the SAME seed, so the refinement is a longer look at the same seasons
   * rather than a different experiment.
   */
  rank(candidates: MarginalPlayer[], o: { refineTop?: number; refineTrials?: number } = {}): MarginalResult[] {
    // The whole candidate set is barred from the fill (see `fillExclude`), so a book built here is
    // built against ONE baseline rather than one per player.
    for (const c of candidates) this.fillExclude.add(c.name);
    const coarse = candidates.map((c) => this.marginal(c)).sort((a, b) => b.playoffsPp - a.playoffsPp);
    const top = o.refineTop ?? 0;
    if (!top || !o.refineTrials) return coarse;
    const fine = new MarginalBook(this.state, this.env, { trials: o.refineTrials, seed: this.seed, shadowSteps: this.shadowSteps, shadowTrials: this.shadowTrials, fillExclude: this.fillExclude });
    const refined = coarse.slice(0, top).map((r) => fine.marginal(candidates.find((c) => c.name === r.name)!));
    this.runs += fine.runs;
    return [...refined.sort((a, b) => b.playoffsPp - a.playoffsPp), ...coarse.slice(top)];
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A short, order-independent key for an exclusion set. */
function excludeKey(ex: Set<string>): string {
  let h = 0;
  for (const n of ex) { let k = 0; for (let i = 0; i < n.length; i++) k = (k * 31 + n.charCodeAt(i)) | 0; h = (h + k) | 0; }
  return `${ex.size}:${h}`;
}
