// ARE V3'S TWO TERMS CONNECTED? The same question `scripts/lever-connected.mjs` asks of a lever.
//
//   node --import tsx scripts/v3-connected.mjs
//
// A derived bidder is worse than a tuned one in exactly one way: nothing warns you when a term is
// computed and then not used. `aggr` at least has a flag somebody has to type. So both of V3's terms
// are exercised here in both directions -- fault-injected to prove the guard can fire, and driven to
// its POSITIVE value to prove it can do anything at all, which is the half that a "guard that only
// ever says no" passes silently.
//
//   SHADING     zero the uncertainty and it must return exactly 1; give it real dispersion and more
//               rivals and it must fall monotonically.
//   SHADOW      the same player, the same roster, twice the budget: the bid must move. And the same
//               player against a RICH pool versus a THIN one: the bid must be lower against the rich
//               pool, because our dollars buy more elsewhere.
import { readFileSync } from "node:fs";
import { makeV3Strategy, shadingFactor, expectedMaxNormal } from "../src/draft/strategyV3.ts";
import { buildV3Config, SIM_LEAGUE } from "../src/draft/sim.ts";
import { calibrateSurrogateDollars, SURROGATE_CALIBRATION } from "../src/draft/lineupMarginal.ts";

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv")
  .map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) }))
  .filter((p) => p.name && p.points);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------------------------
console.log("SHADING");
check("zero uncertainty gives EXACTLY no shading", shadingFactor(0, 0, 16) === 1, `got ${shadingFactor(0, 0, 16)}`);
const s2 = shadingFactor(0.5, 0.5, 2), s16 = shadingFactor(0.5, 0.5, 16);
check("more live bidders shades harder", s16 < s2, `2 bidders ${s2.toFixed(3)} vs 16 bidders ${s16.toFixed(3)}`);
const lo = shadingFactor(0.2, 0.2, 16), hi = shadingFactor(0.9, 0.9, 16);
check("more uncertainty shades harder", hi < lo, `sd 0.2 -> ${lo.toFixed(3)}, sd 0.9 -> ${hi.toFixed(3)}`);
check("one bidder is no auction and carries no curse", shadingFactor(0.8, 0.8, 1) === 1, `got ${shadingFactor(0.8, 0.8, 1)}`);
check("E[max] rises with the field", expectedMaxNormal(15) > expectedMaxNormal(3), `${expectedMaxNormal(3).toFixed(3)} -> ${expectedMaxNormal(15).toFixed(3)}`);

// ---------------------------------------------------------------------------------------------
console.log("\nSHADOW PRICE");
const cfg = buildV3Config(points, SIM_LEAGUE);
const byPoints = [...points].sort((a, b) => b.points - a.points);
const ref = (p) => ({ name: p.name, pos: p.pos, team: "", espnPreDraftVal: null });
const SLOTS = { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 2, DST: 1, K: 1, BENCH: 4 };
const teams = Array.from({ length: 16 }, (_, i) => ({ name: String(i), budgetLeft: 200, openSlots: 12 }));
const state = (board, budget) => ({
  myBudget: budget, mySlots: { ...SLOTS }, myRoster: [], myPosCounts: {},
  onBlock: ref(byPoints[0]), currentOffer: null, secondsLeft: null, iAmHighBidder: false,
  board: board.map(ref), teams,
});

// A fresh strategy per probe: the shadow price is cached per state inside one instance, which is the
// point of it, and reusing an instance would measure the cache rather than the term.
const bid = (board, budget) => makeV3Strategy(cfg).maxBid(state(board, budget)).maxBid;
const pool = byPoints.slice(1, 121);
const b200 = bid(pool, 200), b100 = bid(pool, 100);
check("the bid moves with our budget", b200 !== b100, `$200 -> ${b200}, $100 -> ${b100}`);
// NOT "more money bids more". The indifference price is not monotone in the budget and asserting
// that it is would be encoding an intuition rather than the economics: as the budget shrinks toward
// zero the price rises to meet it (there is nothing else to buy), and as it grows the alternatives
// get richer. What must hold is that a bid never exceeds the money.
check("a bid never exceeds the budget", b200 <= 200 && b100 <= 100, `$200 -> ${b200}, $100 -> ${b100}`);

// A RICH pool (the whole top 120 available) against a THIN one (our man plus the dregs). Same man,
// same budget: against the rich pool our dollars have somewhere else to go.
// The man on the block is deliberately NOT in either board: the budget path is the alternative use
// of the money, and a path that can buy the very man being priced is the "baseline contains the
// candidate" defect that made every Step-1 marginal read zero.
const thin = byPoints.slice(300, 420);
const bRich = bid(pool, 200), bThin = bid(thin, 200);
check("a thin pool bids MORE for the same man than a rich one", bThin > bRich, `rich ${bRich}, thin ${bThin}`);

// ---------------------------------------------------------------------------------------------
console.log("\nTHE VALUE TERM IS ROSTER-AWARE");
const withQb = { ...state(pool, 200), myRoster: [ref(byPoints.find((p) => p.pos === "QB"))], mySlots: { ...SLOTS, QB: 0, BENCH: 3 } };
const bestQb = byPoints.filter((p) => p.pos === "QB")[1];
const openQb = { ...state(pool, 200), onBlock: ref(bestQb) };
const backup = makeV3Strategy(cfg).maxBid({ ...withQb, onBlock: ref(bestQb) }).maxBid;
const starter = makeV3Strategy(cfg).maxBid(openQb).maxBid;
check("the same QB is bid far less as a backup than into an open QB slot", starter > backup, `open slot $${starter}, backup $${backup}`);

// ---------------------------------------------------------------------------------------------
// THE CALIBRATED SURROGATE. Three things have to be true and the third is the one that gets skipped:
// the flag must CHANGE a bid (it is connected), the flag OFF must leave the bid EXACTLY where it was
// (it is reversible), and the map must be able to move a price in BOTH directions -- a calibration
// that can only ever shrink a bid is indistinguishable from a bug that shrinks bids.
//
// The map is exercised directly as well as through the flag, because `SURROGATE_CALIBRATION` can be
// empty (it ships empty until a fit is pasted in) and an empty table is the identity: without the
// direct arm, "the flag does nothing" and "the table is empty" print the same green line.
console.log("\nCALIBRATED SURROGATE");
check("an EMPTY table is exactly the identity", calibrateSurrogateDollars("RB", 57, {}) === 57,
  `got ${calibrateSurrogateDollars("RB", 57, {})}`);
check("a position with no entry passes through untouched",
  calibrateSurrogateDollars("TE", 40, { RB: { a: 0, b: 0.5, n: 99 } }) === 40);
const shrink = { RB: { a: Math.log(0.5), b: 1, n: 99 } }, grow = { RB: { a: Math.log(2), b: 1, n: 99 } };
check("the map can move a price DOWN", calibrateSurrogateDollars("RB", 80, shrink) === 40, `got ${calibrateSurrogateDollars("RB", 80, shrink)}`);
check("the map can move a price UP", calibrateSurrogateDollars("RB", 80, grow) === 160, `got ${calibrateSurrogateDollars("RB", 80, grow)}`);
const curved = { RB: { a: Math.log(3), b: 0.7, n: 99 } };
const c10 = calibrateSurrogateDollars("RB", 10, curved), c100 = calibrateSurrogateDollars("RB", 100, curved);
check("the map is MONOTONE (b > 0 cannot reorder a position's book)", c100 > c10, `$10 -> ${c10.toFixed(1)}, $100 -> ${c100.toFixed(1)}`);
check("b < 1 COMPRESSES: the top of the book moves proportionally less than the bottom",
  c100 / 100 < c10 / 10, `x${(c10 / 10).toFixed(2)} at $10 vs x${(c100 / 100).toFixed(2)} at $100`);
check("a non-positive price is left alone rather than turned into one", calibrateSurrogateDollars("RB", 0, grow) === 0);

// Through the strategy, which is the seam that actually decides a bid.
const board = byPoints.slice(1, 121);
const bidWith = (calibrate) => makeV3Strategy({ ...cfg, calibrate }).maxBid(state(board, 200)).maxBid;
const plain = bidWith(undefined);
const halved = bidWith((_pos, d) => d * 0.5);
const doubled = bidWith((_pos, d) => d * 2);
check("the calibration CHANGES the bid", halved !== plain && doubled !== plain, `off ${plain}, x0.5 ${halved}, x2 ${doubled}`);
check("and it changes it in the RIGHT DIRECTION", halved < plain && doubled > plain, `x0.5 ${halved} < ${plain} < ${doubled} x2`);
check("an identity calibration is byte-identical to no calibration", bidWith((_pos, d) => d) === plain,
  `identity ${bidWith((_pos, d) => d)}, off ${plain}`);
// FAULT INJECTION on the clamp: a map that returns more than the whole budget must still be legal.
const absurd = bidWith(() => 1e9);
check("a runaway calibration cannot bid past the budget", absurd <= 200 && absurd >= 1, `got ${absurd}`);

// The SHIPPED table, whatever it currently is, reported rather than asserted -- so a run of this
// script says whether V3 has a fit compiled in at all.
const shipped = Object.keys(SURROGATE_CALIBRATION);
console.log(`  INFO  shipped SURROGATE_CALIBRATION: ${shipped.length ? shipped.map((p) => `${p} b=${SURROGATE_CALIBRATION[p].b.toFixed(3)}`).join(", ") : "EMPTY (identity; FF_V3_SURROGATE=calibrated is a no-op)"}`);

console.log(`\n${failures ? `${failures} FAILED` : "all connected"}`);
process.exit(failures ? 1 : 0);
