// Fault-injection tests for the two load-bearing pure functions that make the MVP done-bar
// (full legal in-budget roster) structurally safe. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { affordableMax, makeV1Strategy, makeV2Strategy, reserveForOthers, type DraftState } from "../src/draft/strategy.ts";
import { hasOpenSlotFor, type Roster } from "../src/draft/espnAuction.ts";

const baseState = (over: Partial<DraftState> = {}): DraftState => ({
  myBudget: 200,
  mySlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 3 },
  myRoster: [],
  onBlock: null,
  currentOffer: null,
  secondsLeft: null,
  iAmHighBidder: false,
  board: [],
  teams: [],
  ...over,
});

test("affordableMax reserves $1 per still-open slot (never strands a legal roster)", () => {
  // 10 open slots, $69 left -> keep $9 for the other 9 slots -> max $60.
  // (Matches ESPN's observed 'max $60' at $69 left / 10 open -- validates the reserve model.)
  const s = baseState({ myBudget: 69, mySlots: { RB: 3, WR: 3, BENCH: 4 } });
  assert.equal(affordableMax(s), 60);
});

test("affordableMax FAULT: tiny budget still cannot strand (keeps $1/slot)", () => {
  const s = baseState({ myBudget: 5, mySlots: { RB: 2, WR: 2, K: 1 } }); // 5 open, $5
  assert.equal(affordableMax(s), 1); // 5 - (5-1) = 1; can still fill all 5 at $1
});

test("affordableMax: last open slot may use the whole budget", () => {
  const s = baseState({ myBudget: 200, mySlots: { QB: 1 } });
  assert.equal(affordableMax(s), 200);
});

const roster = (over: Partial<Roster> = {}): Roster => ({
  slots: [],
  filled: 0,
  open: 0,
  spent: 0,
  openByBase: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 },
  flexOpen: 0,
  benchOpen: 0,
  ...over,
});

test("hasOpenSlotFor: dedicated slot open", () => {
  assert.equal(hasOpenSlotFor(roster({ openByBase: { QB: 1, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 } }), "QB"), true);
});

test("hasOpenSlotFor: RB fits FLEX when dedicated RB full", () => {
  assert.equal(hasOpenSlotFor(roster({ flexOpen: 1 }), "RB"), true);
});

test("hasOpenSlotFor: K does NOT fit FLEX (only bench/dedicated)", () => {
  assert.equal(hasOpenSlotFor(roster({ flexOpen: 2 }), "K"), false);
  assert.equal(hasOpenSlotFor(roster({ benchOpen: 1 }), "K"), true);
});

test("hasOpenSlotFor FAULT: a full roster refuses every position", () => {
  const full = roster(); // all zeros
  for (const p of ["QB", "RB", "WR", "TE", "K", "DST"]) assert.equal(hasOpenSlotFor(full, p), false);
});

test("SEAM: swapping the value table changes maxBid with no engine change", () => {
  const onBlock = { name: "Star Player", pos: "RB" as const, team: "SF", espnPreDraftVal: 40 };
  const st = baseState({ onBlock });
  const cheap = makeV1Strategy({ values: { "Star Player": 10 } });
  const rich = makeV1Strategy({ values: { "Star Player": 55 } });
  assert.equal(cheap.maxBid(st).maxBid, 10);
  assert.equal(rich.maxBid(st).maxBid, 55);
  // targets premium also flows through the same seam
  const tgt = makeV1Strategy({ values: { "Star Player": 40 }, targets: { "Star Player": 1.25 } });
  assert.equal(tgt.maxBid(st).maxBid, 50);
});

test("projections: season/week/ros + matchup multiplier", async () => {
  const { makeProjections } = await import("../src/projections.ts");
  const proj = makeProjections({
    seasonPoints: [{ name: "RB A", pos: "RB", season: 340 }],
    defRatings: new Map([["MIA|RB", 1.25], ["SF|RB", 0.8]]),
    gamesPerSeason: 17,
  });
  assert.equal(proj.season("RB A"), 340);
  assert.equal(proj.week("RB A", "RB"), 20); // per-game 340/17, no opponent
  assert.equal(proj.week("RB A", "RB", "MIA"), 25); // x1.25 soft matchup
  assert.equal(proj.week("RB A", "RB", "SF"), 16); // x0.8 tough matchup
  assert.equal(proj.ros("RB A", 10), 200); // 20/gm x 10
  assert.equal(proj.season("Unknown"), 0);
});

test("SEAM: avoid list zeroes a player's max", () => {
  const onBlock = { name: "Bust", pos: "WR" as const, team: "NYJ", espnPreDraftVal: 20 };
  const s = makeV1Strategy({ values: { Bust: 20 }, avoids: new Set(["Bust"]) });
  assert.equal(s.maxBid(baseState({ onBlock })).maxBid, 0);
});

// --- v2 budget-aware, balanced strategy (Phase 2.5 quality) ------------------------------

test("reserveForOthers: starters reserved higher than bench; excludes the filled slot", () => {
  const s = baseState({ mySlots: { QB: 1, RB: 1, WR: 1, BENCH: 2 } });
  assert.equal(reserveForOthers(s, false, 4, 1), 2 * 4 + 2 * 1); // fill a starter -> 2 other starters
  assert.equal(reserveForOthers(s, true, 4, 1), 3 * 4 + 1 * 1); // fill bench -> all 3 starters kept
});

test("v2 EARLY: can pay up to a stud's value (wins studs, unlike v1 flat cap)", () => {
  const onBlock = { name: "Stud RB", pos: "RB" as const, team: "SF", espnPreDraftVal: 80 };
  const s = makeV2Strategy({ starterReserve: 4, benchReserve: 1, premium: 1 });
  // $200, 12 open; reserve 8 other starters*4 + 3 bench*1 = 35 -> afford 165 >> 81 -> maxBid 81.
  assert.equal(s.maxBid(baseState({ onBlock })).maxBid, 81);
});

test("v2 FAULT: tight budget never strands -- keeps $1 for every other slot", () => {
  const onBlock = { name: "X", pos: "RB" as const, team: "SF", espnPreDraftVal: 40 };
  const s = makeV2Strategy({ starterReserve: 4 });
  // $3, slots RB/WR/K all open -> may spend at most $1 here, keeping $1+$1 for WR+K.
  const st = baseState({ myBudget: 3, mySlots: { RB: 1, WR: 1, K: 1 }, onBlock });
  const bid = s.maxBid(st).maxBid;
  assert.ok(bid >= 1 && bid <= 1, `expected fill-floor $1, got ${bid}`);
});

test("v2 fill-floor: soft reserve never BLOCKS a needed slot we can afford", () => {
  const onBlock = { name: "Y", pos: "RB" as const, team: "SF", espnPreDraftVal: 40 };
  const s = makeV2Strategy({ starterReserve: 4 });
  // $5, 3 open starters -> soft reserve would zero it, but fill-floor keeps it biddable ($1).
  const st = baseState({ myBudget: 5, mySlots: { RB: 1, WR: 1, K: 1 }, onBlock });
  assert.ok(s.maxBid(st).maxBid >= 1);
});
