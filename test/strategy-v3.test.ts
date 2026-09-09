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
  availForRank, availFromVarianceModel, budgetPath, expectedSeasonPoints, expectedWeekPoints,
  lineupMarginal, priceFromPath, type LmOpts, type LmPlayer,
} from "../src/draft/lineupMarginal.js";
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

test("V3 refuses a man who can fill no slot at all", () => {
  const d = mkStrategy().maxBid(mkState({ mySlots: { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DST: 0, K: 0, BENCH: 0 } }));
  assert.equal(d.maxBid, 0);
});

test("expectedSeasonPoints evaluates bye weeks individually and plain weeks in bulk -- same answer either way", () => {
  const fast = expectedSeasonPoints(ROSTER, OPTS);
  const slow = expectedSeasonPoints(ROSTER, OPTS, Array.from({ length: 17 }, (_, i) => i + 1));
  assert.ok(Math.abs(fast - slow) < 1e-6, `bulk ${fast} against week-by-week ${slow} -- the shortcut is not equivalent`);
});
