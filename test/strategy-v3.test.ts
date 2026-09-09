/**
 * THE DERIVED BIDDER, term by term.
 *
 * V3 replaces five hand-tuned levers with three computed terms, and the failure mode of a computed
 * term is worse than that of a lever: nothing warns you when one is calculated and then not used, or
 * used with the wrong argument. Every defect this file's assertions were written against was real and
 * silent -- a lineup template that degenerated to twelve bench slots once the starters were won, a
 * positional availability averaged over four tiers so the starting quarterback "played eight games",
 * a $1 floor keyed on the DOLLAR value rather than the marginal so V3 declined every bench body in
 * the draft. None of them threw; all of them just made the bidder quietly worse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availForRank, availFromVarianceModel, budgetPath, calibrateSurrogateDollars, expectedSeasonPoints,
  expectedWeekPoints, lineupMarginal, priceFromPath, starterBaselines, SURROGATE_CALIBRATION,
  type LmOpts, type LmPlayer, type SurrogateFit,
} from "../src/draft/lineupMarginal.js";
import { baselines, resolveValueLeague } from "../src/draft/values.js";
import { ourSdFor, ourSdPrivateFor } from "../src/draft/sim.js";
import { expectedMaxNormal, makeV3Strategy, openSlotList, probit, shadingFactor } from "../src/draft/strategyV3.js";
import type { DraftState, PlayerRef } from "../src/draft/strategy.js";

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
const OPTS: LmOpts = {
  slots: SLOTS,
  flexOk: ["RB", "WR", "TE"],
  weeks: 17,
  avail: { QB: 0.91, RB: 0.87, WR: 0.89, TE: 0.85, K: 0.95, DST: 0.95 },
  replacement: { QB: 11, RB: 5, WR: 5, TE: 4, K: 7, DST: 6 },
};
const P = (name: string, pos: string, proj: number, bye: number | null = null): LmPlayer => ({ name, pos, proj, bye });
const ROSTER: LmPlayer[] = [
  P("Q1", "QB", 320), P("R1", "RB", 260), P("R2", "RB", 210), P("W1", "WR", 250),
  P("W2", "WR", 220), P("W3", "WR", 190), P("T1", "TE", 160, 7), P("K1", "K", 130), P("D1", "DST", 120),
];

// =============================================================================================
// THE VALUE TERM
// =============================================================================================

test("a backup QB is worth a fraction of what the first QB is worth", () => {
  const first = lineupMarginal(ROSTER.filter((p) => p.pos !== "QB"), P("Qx", "QB", 320), OPTS);
  const second = lineupMarginal(ROSTER, P("Qx", "QB", 320), OPTS);
  assert.ok(second < first / 3, `first QB ${first.toFixed(1)} pts, backup ${second.toFixed(1)} -- the backup is not being discounted`);
  assert.ok(second > 0, "the backup is worth exactly nothing, which cannot be right either -- he plays in the bye week");
});

test("a bench kicker is worth a rounding error next to a fourth receiver", () => {
  // NOT exactly zero, and the model is right about that: a second kicker covers the 5% of weeks the
  // first is out. What matters is the ORDER of magnitude against a real depth piece, which is what a
  // book keyed on raw points cannot see.
  const k = lineupMarginal(ROSTER, P("Kx", "K", 125), OPTS);
  const d = lineupMarginal(ROSTER, P("Dx", "DST", 115), OPTS);
  const wr = lineupMarginal(ROSTER, P("Wx", "WR", 200), OPTS);
  assert.ok(k < 1 && d < 1, `bench K ${k.toFixed(2)}, bench DST ${d.toFixed(2)} points a season`);
  assert.ok(wr > 3 * Math.max(k, d, 0.01), `a fourth receiver measured ${wr.toFixed(2)} against a bench kicker's ${k.toFixed(2)} and defence's ${d.toFixed(2)}`);
});

test("a bye that collides with our only tight end costs the candidate real points", () => {
  const clash = lineupMarginal(ROSTER, P("Tx", "TE", 150, 7), OPTS);
  const clear = lineupMarginal(ROSTER, P("Ty", "TE", 150, 11), OPTS);
  assert.ok(clear > clash, `clear bye ${clear.toFixed(2)}, colliding bye ${clash.toFixed(2)}`);
  // FAULT INJECTION: with our tight end NOT on a bye, the two candidates must converge -- the gap
  // above was the collision and nothing else.
  const noBye = ROSTER.map((p) => (p.pos === "TE" ? { ...p, bye: null } : p));
  const g1 = clear - clash;
  const g2 = lineupMarginal(noBye, P("Ty", "TE", 150, 11), OPTS) - lineupMarginal(noBye, P("Tx", "TE", 150, 7), OPTS);
  assert.ok(Math.abs(g2) < Math.abs(g1), `gap with the collision ${g1.toFixed(2)}, without it ${g2.toFixed(2)}`);
});

test("an empty slot scores the STREAMING FLOOR, not zero", () => {
  const noK = ROSTER.filter((p) => p.pos !== "K");
  const withFloor = expectedWeekPoints(noK, 0, OPTS);
  // Only the K floor is removed. Zeroing EVERY floor would also change the slots that are filled --
  // each carries a small probability that all its eligible men are out -- so the difference would no
  // longer isolate the empty slot, which is what the first version of this assertion measured.
  const noFloor = expectedWeekPoints(noK, 0, { ...OPTS, replacement: { ...OPTS.replacement, K: 0 } });
  assert.ok(withFloor > noFloor, "the streaming floor is not reaching the empty slot");
  assert.ok(Math.abs(withFloor - noFloor - (OPTS.replacement!.K)) < 1e-9, "the empty K slot should be worth exactly the K floor");
});

// =============================================================================================
// THE POSITIONAL REPLACEMENT BASELINE -- the defect P30 named
// =============================================================================================
//
// V3's marginal used to measure EVERY empty starting slot against the streaming floor, so the first
// quarterback was priced by how far he beats the waiver wire. In a one-QB, sixteen-team league that
// is a very long way and nobody ever faces the choice: the alternative to the best quarterback is the
// seventeenth. The tests below are the two directions that matter -- the baseline must actually bite
// on the first man at a position, and it must NOT resurrect the backup.

/** A full board with a realistic curve at every position, deep enough that a sixteen-team league's
 *  starting demand lands well inside it rather than off the end. */
const BOARD: LmPlayer[] = [
  ...Array.from({ length: 40 }, (_, i) => P(`BQB${i}`, "QB", 400 - 7 * i)),
  ...Array.from({ length: 80 }, (_, i) => P(`BRB${i}`, "RB", 320 - 3.4 * i)),
  ...Array.from({ length: 90 }, (_, i) => P(`BWR${i}`, "WR", 310 - 3.0 * i)),
  ...Array.from({ length: 40 }, (_, i) => P(`BTE${i}`, "TE", 230 - 4.5 * i)),
  ...Array.from({ length: 34 }, (_, i) => P(`BK${i}`, "K", 150 - 1.5 * i)),
  ...Array.from({ length: 34 }, (_, i) => P(`BD${i}`, "DST", 145 - 2.0 * i)),
];
const LG = { teams: 16, slots: SLOTS };

test("starterBaselines reproduces values.ts baselines() exactly -- the same quantity, recomputed live", () => {
  // POSITIVE CONTROL, and it is the load-bearing one: the claim being made is not "some baseline" but
  // "the SAME baseline the shipped VOR book uses", including the points-weighted FLEX allocation
  // that gives TE zero flex slots in this league. An even three-way split handed TE eleven phantom
  // starting slots and cost 8.6pp of championships when it was fixed in values.ts; reproducing the
  // wrong allocation inside V3 would reintroduce it where no existing test looks.
  const mine = starterBaselines(BOARD, LG, 1, 17);
  const theirs = baselines(BOARD.map((p) => ({ name: p.name, pos: p.pos, points: p.proj })),
    resolveValueLeague({ teams: 16, budget: 200, slots: SLOTS }));
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    assert.ok(Math.abs(mine[pos] * 17 - theirs[pos]) < 1e-9,
      `${pos}: starterBaselines says ${(mine[pos] * 17).toFixed(3)} season points, values.ts says ${theirs[pos].toFixed(3)}`);
  }
  // The FLEX cutoff is its OWN number and must sit between the flex-eligible positions' baselines --
  // it is neither their max nor their min, which is why it is returned separately.
  assert.ok(mine.FLEX > 0, "no FLEX cutoff was produced");
  // TE claims no flex slot in this league, which is exactly the case that says the cutoff is its own
  // number: the sixteenth tight end is WORSE than the man the flex slots stop at, so a flex floor
  // taken as the max of the positional baselines would price the flex against the wrong man in one
  // direction and one taken as the min would do it in the other.
  assert.ok(mine.FLEX > mine.TE, `FLEX cutoff ${mine.FLEX.toFixed(2)} not above the TE baseline ${mine.TE.toFixed(2)}`);
  assert.ok(mine.FLEX < mine.RB * 1.5 && mine.FLEX > 0.5 * mine.RB, `FLEX cutoff ${mine.FLEX.toFixed(2)} nowhere near the RB baseline ${mine.RB.toFixed(2)}`);
});

test("the baseline TIGHTENS as the room fills: half the slots open moves it", () => {
  const full = starterBaselines(BOARD, LG, 1, 17);
  const half = starterBaselines(BOARD, LG, 0.5, 17);
  // Half the demand into the same pool reaches a better man, so the baseline RISES.
  assert.ok(half.QB > full.QB, `full ${full.QB.toFixed(2)}, half ${half.QB.toFixed(2)} -- openFraction is not connected`);
  // FAULT INJECTION on the other end: with no demand left at all the baseline is the best man on the
  // board, not something that silently reads zero.
  const none = starterBaselines(BOARD, LG, 0, 17);
  assert.ok(Math.abs(none.QB - 400 / 17) < 1e-9, `an empty room should baseline at the best QB, got ${(none.QB * 17).toFixed(1)}`);
});

test("a QB priced against the WAIVER FLOOR exceeds the same QB priced against QB17, by exactly the gap between the two floors", () => {
  const base = starterBaselines(BOARD, LG, 1, 17);
  const withBaseline: LmOpts = { ...OPTS, baseline: base };
  // The test is vacuous unless the two floors genuinely differ, so that is asserted first rather
  // than assumed -- a baseline that happened to equal the streaming floor would pass every
  // inequality below while changing nothing.
  assert.ok(base.QB > OPTS.replacement!.QB + 1,
    `QB17 is ${base.QB.toFixed(2)} a week against a streaming floor of ${OPTS.replacement!.QB} -- there is nothing to measure`);
  const elite = P("Qelite", "QB", 400);
  const onFloor = lineupMarginal([], elite, OPTS);
  const onBaseline = lineupMarginal([], elite, withBaseline);
  assert.ok(onFloor > onBaseline, `floor-priced ${onFloor.toFixed(1)}, baseline-priced ${onBaseline.toFixed(1)}`);
  // And by exactly the right amount: the floor only scores in the weeks he does not, so the whole
  // difference is availability times the gap between the floors, times the season.
  const expectedGap = OPTS.avail.QB * (base.QB - OPTS.replacement!.QB) * OPTS.weeks;
  assert.ok(Math.abs((onFloor - onBaseline) - expectedGap) < 1e-6,
    `measured gap ${(onFloor - onBaseline).toFixed(3)}, arithmetic says ${expectedGap.toFixed(3)}`);
  // FAULT INJECTION: with the baseline REMOVED the two must be identical. This is the control that
  // separates "the baseline is doing the work" from "something else moved".
  assert.equal(lineupMarginal([], elite, { ...withBaseline, baseline: undefined }), onFloor);
  // K AND DST DELIBERATELY KEEP THE STREAMING FLOOR, so a kicker must be unmoved by all of this.
  const k = P("Kx", "K", 150);
  assert.equal(lineupMarginal([], k, withBaseline), lineupMarginal([], k, OPTS));
});

test("under the baseline a THIRD quarterback is worth ~0, and the first is not", () => {
  const withBaseline: LmOpts = { ...OPTS, baseline: starterBaselines(BOARD, LG, 1, 17) };
  const q = (n: string, pts: number) => P(n, "QB", pts);
  // The SAME man in both arms -- an elite quarterback, comfortably above the seventeenth -- so the
  // difference is the roster he is joining and nothing else.
  const first = lineupMarginal([], q("Q3", 360), withBaseline);
  const third = lineupMarginal([q("Q1", 400), q("Q2", 380)], q("Q3", 360), withBaseline);
  assert.ok(first > 10, `the FIRST quarterback measured ${first.toFixed(2)} points -- the baseline has eaten the position entirely`);
  assert.ok(third < first / 15, `third QB ${third.toFixed(2)} against a first QB's ${first.toFixed(2)}`);
  // He is not worth exactly nothing -- he plays in the weeks both men ahead of him are out -- and a
  // model that said zero would be wrong in the other direction.
  assert.ok(third > 0, "a third quarterback is worth exactly nothing, which cannot be right either");
});

test("per-player availability overrides the positional average, and the tier tables differ enormously", () => {
  const vm = { tiers: 4, pos: { QB: { avail: [0.91, 0.59, 0.24, 0.13] } } };
  assert.ok(Math.abs(availFromVarianceModel(vm)!.QB - 0.75) < 0.01, "the two-tier default moved");
  assert.equal(availForRank(vm, "QB", 0, 100), 0.91);
  assert.equal(availForRank(vm, "QB", 90, 100), 0.13);
  // The number the first version used, and why it was wrong: averaging all four tiers.
  assert.ok(Math.abs(availFromVarianceModel(vm, 4)!.QB - 0.4675) < 0.001);
  const fragile = expectedWeekPoints([{ ...ROSTER[0], avail: 0.2 }], 0, OPTS);
  const healthy = expectedWeekPoints([{ ...ROSTER[0], avail: 0.95 }], 0, OPTS);
  assert.ok(healthy > fragile, "per-player availability is not being read");
});

// =============================================================================================
// THE PRICE TERM
// =============================================================================================

const POOL: LmPlayer[] = [
  ...Array.from({ length: 6 }, (_, i) => P(`PoolQB${i}`, "QB", 300 - 30 * i)),
  ...Array.from({ length: 10 }, (_, i) => P(`PoolRB${i}`, "RB", 280 - 25 * i)),
  ...Array.from({ length: 10 }, (_, i) => P(`PoolWR${i}`, "WR", 270 - 24 * i)),
  ...Array.from({ length: 6 }, (_, i) => P(`PoolTE${i}`, "TE", 180 - 25 * i)),
  ...Array.from({ length: 4 }, (_, i) => P(`PoolK${i}`, "K", 140 - 20 * i)),
  ...Array.from({ length: 4 }, (_, i) => P(`PoolD${i}`, "DST", 130 - 20 * i)),
];
const price = (p: LmPlayer) => Math.max(1, Math.round((p.proj - 100) / 4));

test("the budget path fills every slot, spends the money and is monotone in value", () => {
  const path = budgetPath([], SLOTS, POOL, price, 200, OPTS);
  assert.ok(path.length > 3, `the path has ${path.length} points -- nothing was ever upgraded`);
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].spent >= path[i - 1].spent, "spend went backwards");
    assert.ok(path[i].value >= path[i - 1].value, "value went backwards after the monotone pass");
  }
  assert.ok(path[path.length - 1].spent <= 200, `the path spent ${path[path.length - 1].spent} of 200`);
  assert.ok(path[path.length - 1].value > path[0].value, "the whole budget bought nothing");
});

test("priceFromPath is bounded, monotone, and saturates rather than running away", () => {
  const path = budgetPath([], SLOTS, POOL, price, 200, OPTS);
  const span = path[path.length - 1].value - path[0].value;
  assert.equal(priceFromPath(path, 0, 200), 0);
  const small = priceFromPath(path, span * 0.2, 200), big = priceFromPath(path, span * 0.9, 200);
  assert.ok(big > small, `${big} not above ${small}`);
  assert.ok(big <= 200);
  assert.equal(priceFromPath(path, span * 50, 200), 200, "a marginal beyond the whole budget must saturate at the budget");
  // FAULT INJECTION: a path the money cannot improve at all means the money is worthless, so the man
  // is worth all of it. Returning 0 there -- which is what "no data" looks like -- would make us
  // refuse to bid exactly when the pool has run dry.
  assert.equal(priceFromPath([{ spent: 0, value: 10 }], 5, 200), 200);
});

// =============================================================================================
// THE SHADING TERM
// =============================================================================================

test("shading: zero dispersion is exactly no shading, and both inputs move it the right way", () => {
  assert.equal(shadingFactor(0, 0, 16), 1);
  assert.equal(shadingFactor(0.9, 0.9, 1), 1, "one bidder is not an auction and carries no curse");
  assert.ok(shadingFactor(0.5, 0.5, 16) < shadingFactor(0.5, 0.5, 3));
  assert.ok(shadingFactor(0.9, 0.9, 16) < shadingFactor(0.2, 0.2, 16));
  assert.ok(shadingFactor(0.5, 0.5, 16) > 0 && shadingFactor(0.5, 0.5, 16) < 1);
});

test("only the PRIVATE part of our uncertainty shades, and in this harness that part is zero", () => {
  // The claim is arithmetic, not a preference: `OUR_SD_BAND` was measured by
  // `scripts/market-noise.mjs` as the CONSENSUS dispersion, and `--market ecr` hands the room the
  // same table. Our spread minus the room's shared spread is therefore identically zero, and
  // combining the two in quadrature counted one quantity twice.
  for (const rank of [1, 6, 7, 12, 24, 40, 60, 200]) {
    assert.equal(ourSdPrivateFor(rank), 0, `rank ${rank} produced a private component of ${ourSdPrivateFor(rank)}`);
    assert.ok(ourSdFor(rank) > 0, `rank ${rank} has no measured uncertainty at all -- the subtraction is vacuous`);
  }
  assert.equal(ourSdPrivateFor(null), 0);
  // FAULT INJECTION, and it is the half that matters: a zero that cannot become non-zero is a dead
  // lever wearing a measured null's clothes. Diverge the two bands and the term must come alive.
  const priv = (ours: number, shared: number) => Math.max(0, ours - shared);
  assert.ok(priv(0.9, 0.5) > 0.39, "the private component cannot rise when our spread exceeds the room's");
  assert.equal(priv(0.4, 0.9), 0, "a view TIGHTER than the room's carries no curse of its own, and must floor at zero");
  // And it must reach the shading: a positive private component shades harder than none.
  assert.ok(shadingFactor(priv(0.9, 0.5), 0.5, 16) < shadingFactor(0, 0.5, 16));
});

test("probit and E[max] are the standard values, not something that merely increases", () => {
  assert.ok(Math.abs(probit(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(probit(0.5)) < 1e-9);
  assert.ok(Math.abs(probit(0.025) + 1.959964) < 1e-4);
  assert.equal(expectedMaxNormal(0), 0);
  assert.ok(expectedMaxNormal(15) > expectedMaxNormal(3));
});

// =============================================================================================
// THE STRATEGY, END TO END
// =============================================================================================

test("openSlotList expands the Engine's per-key counts, mapping BENCH onto the template's BE", () => {
  assert.deepEqual(openSlotList({ QB: 1, FLEX: 2, BENCH: 2, RB: 0 }).sort(), ["BE", "BE", "FLEX", "FLEX", "QB"]);
});

const ref = (p: LmPlayer): PlayerRef => ({ name: p.name, pos: p.pos as never, team: "", espnPreDraftVal: null });
const projOf = new Map([...POOL, ...ROSTER].map((p) => [p.name, p.proj]));
const mkStrategy = () => makeV3Strategy({
  proj: (n) => projOf.get(n) ?? 0,
  lineup: OPTS,
  priceOf: (n) => price({ name: n, pos: "RB", proj: projOf.get(n) ?? 0 }),
  marketSd: () => 0.5,
  defaultBidders: 8,
});
const mkState = (over: Partial<DraftState> = {}): DraftState => ({
  myBudget: 200, mySlots: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 2, DST: 1, K: 1, BENCH: 4 },
  myRoster: [], myPosCounts: {}, onBlock: ref(POOL[6]), currentOffer: null, secondsLeft: null,
  iAmHighBidder: false, board: POOL.map(ref), teams: Array.from({ length: 16 }, (_, i) => ({ name: String(i), budgetLeft: 200, openSlots: 12 })),
  ...over,
});

test("V3 bids a real number for a good player and never more than it can legally afford", () => {
  const d = mkStrategy().maxBid(mkState());
  assert.ok(d.maxBid > 0, `V3 declined the best back in the pool: ${d.reason}`);
  assert.ok(d.maxBid <= 200 - 11, "the bid does not keep $1 for the eleven slots that would remain open");
  assert.match(d.reason ?? "", /shade/);
});

test("V3 still bids a DOLLAR for a bench body whose dollar value rounds to zero", () => {
  // This is the defect that made V3 finish its first draft with eight men and four empty roster
  // spots: the $1 floor was keyed on the rounded dollar value, which is 0 for any depth piece, so it
  // never fired. A slot left open is a guaranteed zero every week; a $1 body is not.
  const state = mkState({
    myRoster: ROSTER.map(ref), mySlots: { BENCH: 3 }, myBudget: 40,
    onBlock: ref(P("PoolWR9", "WR", 54)),
  });
  const d = mkStrategy().maxBid(state);
  assert.ok(d.maxBid >= 1, `V3 refused a bench body it could afford: ${d.reason}`);
});

test("the baseline REACHES THE BIDDER: with league demand supplied, V3 pays less for the first QB", () => {
  // The half a derived term fails silently at. `starterBaselines` can be perfectly correct and never
  // be called, and a bidder that ignores it looks exactly like one that is using it -- there is no
  // flag anybody has to type. So the strategy is driven twice on the SAME state, differing only in
  // whether `teams` (the league-wide demand the baseline needs) is supplied.
  const eliteQb = P("BigQB", "QB", 400);
  const projs = new Map([...POOL, ...ROSTER, ...BOARD, eliteQb].map((p) => [p.name, p.proj]));
  const mk = (teams?: number) => makeV3Strategy({
    proj: (n) => projs.get(n) ?? 0,
    lineup: OPTS,
    priceOf: (n) => Math.max(1, Math.round(((projs.get(n) ?? 0) - 100) / 4)),
    marketSd: () => 0,
    defaultBidders: 8,
    teams,
  });
  const st: DraftState = {
    myBudget: 200, mySlots: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 2, DST: 1, K: 1, BENCH: 4 },
    myRoster: [], myPosCounts: {}, onBlock: ref(eliteQb), currentOffer: null, secondsLeft: null,
    iAmHighBidder: false, board: BOARD.map(ref),
    teams: Array.from({ length: 16 }, (_, i) => ({ name: String(i), budgetLeft: 200, openSlots: 12 })),
    leagueOpenSlots: 16 * 12,
  };
  const onFloor = mk(undefined).maxBid(st).maxBid;
  const onBaseline = mk(16).maxBid(st).maxBid;
  assert.ok(onFloor > 0, `V3 declined the best quarterback on the board even against the waiver floor: ${onFloor}`);
  assert.ok(onBaseline < onFloor,
    `waiver-floor bid $${onFloor}, positional-replacement bid $${onBaseline} -- the baseline is computed and then not used`);
  // It must not have collapsed the position to nothing either: the best quarterback in a one-QB
  // league is still worth real money, and a term that only ever says "no" is dead code.
  assert.ok(onBaseline > 0, "the baseline priced the best quarterback in the draft at zero");
});

test("V3 refuses a man who can fill no slot at all", () => {
  const d = mkStrategy().maxBid(mkState({ mySlots: { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DST: 0, K: 0, BENCH: 0 } }));
  assert.equal(d.maxBid, 0);
});

test("expectedSeasonPoints evaluates bye weeks individually and plain weeks in bulk -- same answer either way", () => {
  const fast = expectedSeasonPoints(ROSTER, OPTS);
  const slow = expectedSeasonPoints(ROSTER, OPTS, Array.from({ length: 17 }, (_, i) => i + 1));
  assert.ok(Math.abs(fast - slow) < 1e-6, `bulk ${fast} against week-by-week ${slow} -- the shortcut is not equivalent`);
});

// =============================================================================================
// THE CALIBRATED SURROGATE
// =============================================================================================

test("the greedy slot assignment DOUBLE-COUNTS a spare at a position that feeds several slots", () => {
  // The module header claimed this error was "slightly conservative" for two weeks. It is the
  // opposite, and the test is written as the comparison that shows which: a position feeding ONE
  // slot must be exact, and the same roster shape at a FLEX-eligible position must come out HIGH.
  //
  // The exact answer is computed by hand rather than by a second implementation of the greedy pass:
  // with a starter S and one spare B, both up with probability a, the optimal lineup scores
  //   QB (one slot):  a*S + (1-a)*a*B
  //   RB (RB + FLEX): a*S + a*B  when both are up they occupy two different slots
  const a = 0.85, S = 300 / 17, B = 200 / 17;
  const one: LmOpts = { ...OPTS, slots: ["QB"], replacement: { QB: 0 }, avail: { QB: a } };
  const two: LmOpts = { ...OPTS, slots: ["RB", "FLEX"], replacement: { RB: 0 }, avail: { RB: a } };
  const qb = expectedWeekPoints([P("Qa", "QB", 300), P("Qb", "QB", 200)], 0, one);
  const rb = expectedWeekPoints([P("Ra", "RB", 300), P("Rb", "RB", 200)], 0, two);
  const qbExact = a * S + (1 - a) * a * B;
  const rbExact = a * S + a * B;
  assert.ok(Math.abs(qb - qbExact) < 1e-9, `single-slot position is not exact: ${qb} against ${qbExact}`);
  assert.ok(rb > rbExact * 1.02,
    `the multi-slot position came out at ${rb.toFixed(3)} against an exact ${rbExact.toFixed(3)} -- if this ` +
    "assertion has started failing the greedy pass has been FIXED, and the calibration fitted around " +
    "it in docs/validation.md (Track G) must be refitted rather than merely re-run");
  // And the size of it, so a change in magnitude is visible rather than only a change in sign.
  assert.ok(rb / rbExact < 1.2, `the over-count has grown to ${(100 * (rb / rbExact - 1)).toFixed(1)}%`);
});

test("an EMPTY calibration table is exactly the identity, at every position and every price", () => {
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    for (const d of [0, 1, 7, 42, 199]) {
      assert.equal(calibrateSurrogateDollars(pos, d, {}), d, `${pos} $${d} was not passed through`);
    }
  }
});

test("a position with no fitted entry is passed through, never given another position's map", () => {
  const t: Record<string, SurrogateFit> = { RB: { a: Math.log(0.5), b: 1, n: 99 } };
  assert.equal(calibrateSurrogateDollars("WR", 80, t), 80);
  assert.equal(calibrateSurrogateDollars("RB", 80, t), 40);
});

test("the fitted map is monotone and can move a price in BOTH directions", () => {
  // A calibration that can only ever shrink a bid is indistinguishable from a bug that shrinks bids,
  // so the positive direction is asserted as well as the negative one.
  const down: Record<string, SurrogateFit> = { RB: { a: Math.log(0.4), b: 1, n: 99 } };
  const up: Record<string, SurrogateFit> = { RB: { a: Math.log(2.5), b: 1, n: 99 } };
  assert.ok(calibrateSurrogateDollars("RB", 60, down) < 60);
  assert.ok(calibrateSurrogateDollars("RB", 60, up) > 60);
  const curved: Record<string, SurrogateFit> = { RB: { a: Math.log(4), b: 0.6, n: 99 } };
  let prev = -1;
  for (const d of [1, 5, 20, 50, 100, 180]) {
    const v = calibrateSurrogateDollars("RB", d, curved);
    assert.ok(v > prev, `not monotone at $${d}: ${v} after ${prev}`);
    prev = v;
  }
  // b < 1 compresses: the multiplier at the top of the book is smaller than at the bottom, which is
  // the whole point of the second parameter and is what a pure level shift cannot do.
  assert.ok(calibrateSurrogateDollars("RB", 100, curved) / 100 < calibrateSurrogateDollars("RB", 10, curved) / 10);
});

test("a degenerate fit cannot invent a price out of nothing", () => {
  const bad: Record<string, SurrogateFit> = { RB: { a: 5, b: 0, n: 99 } };
  assert.equal(calibrateSurrogateDollars("RB", 0, bad), 0, "a $0 marginal was turned into money");
  assert.equal(calibrateSurrogateDollars("RB", 50, bad), 50, "a non-positive exponent was applied instead of refused");
});

test("V3 with a calibration bids differently, and with the identity map bids IDENTICALLY", () => {
  const base = makeV3Strategy({
    proj: (n) => projOf.get(n) ?? 0, lineup: OPTS,
    priceOf: (n) => price({ name: n, pos: "RB", proj: projOf.get(n) ?? 0 }),
    marketSd: () => 0.5, defaultBidders: 8,
  }).maxBid(mkState()).maxBid;
  const withCal = (calibrate: (pos: string, d: number) => number) => makeV3Strategy({
    proj: (n) => projOf.get(n) ?? 0, lineup: OPTS,
    priceOf: (n) => price({ name: n, pos: "RB", proj: projOf.get(n) ?? 0 }),
    marketSd: () => 0.5, defaultBidders: 8, calibrate,
  }).maxBid(mkState()).maxBid;
  assert.equal(withCal((_p, d) => d), base, "an identity calibration moved the bid");
  assert.ok(withCal((_p, d) => d * 0.4) < base, "halving the calibrated price did not lower the bid");
  assert.ok(withCal((_p, d) => d * 2.5) > base, "raising the calibrated price did not raise the bid");
  // FAULT INJECTION on the clamp the calibration adds: a runaway map must still be legal.
  const runaway = withCal(() => 1e9);
  assert.ok(runaway > 0 && runaway <= 200 - 11, `a runaway calibration bid $${runaway}`);
});

test("the SHIPPED calibration table, whatever it is, is well formed", () => {
  // Not a check that a fit exists -- it ships empty until one is pasted in, and an empty table is the
  // identity. A check that if one IS compiled in, it cannot silently reorder a book (b <= 0) or
  // multiply every price by a number nobody meant to write.
  for (const [pos, f] of Object.entries(SURROGATE_CALIBRATION)) {
    assert.ok(f.b > 0.2 && f.b < 3, `${pos}: exponent ${f.b} is outside anything a monotone level fit should produce`);
    assert.ok(Math.exp(f.a) > 0.05 && Math.exp(f.a) < 20, `${pos}: scale ${Math.exp(f.a)} is outside a plausible range`);
    assert.ok(f.n >= 20, `${pos}: fitted on only ${f.n} pairs`);
  }
});
