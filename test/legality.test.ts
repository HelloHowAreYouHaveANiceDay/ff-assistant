// Fault-injection tests for the two load-bearing pure functions that make the MVP done-bar
// (full legal in-budget roster) structurally safe. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { affordableMax, makeV1Strategy, makeV2Strategy, reserveForOthers, type DraftState } from "../src/draft/strategy.ts";
import { hasOpenSlotFor, type Roster } from "../src/draft/espnAuction.ts";
import { SIM_LEAGUE } from "../src/draft/sim.ts";
import { DEFAULT_VALUE_LEAGUE, nameKey } from "../src/draft/values.ts";

const identity = (s: string) => s;

test("nameKey: normalizes suffixes and a d/st token to a shared key", () => {
  assert.equal(nameKey("Patrick Mahomes II"), nameKey("Patrick Mahomes"));
  assert.equal(nameKey("Broncos D/ST"), nameKey("Broncos"));
  assert.equal(nameKey("Travis Etienne Jr."), "travisetienne");
});

test("v2 nameKey lookup: ESPN 'Patrick Mahomes II' resolves our 'Patrick Mahomes' value (src=ours)", () => {
  const onBlock = { name: "Patrick Mahomes II", pos: "QB" as const, team: "KC", espnPreDraftVal: 5 };
  const s = makeV2Strategy({ values: { [nameKey("Patrick Mahomes")]: 40 }, nameKey, starterReserve: 5, premium: 2 });
  const d = s.maxBid(baseState({ onBlock }));
  assert.match(d.reason ?? "", /src=ours/);
  assert.ok(d.maxBid >= 40, `our value 40 must drive the bid, not the espn 5; got ${d.maxBid}`);
});

test("v2 nameKey lookup FAULT: identity normalizer misses the suffix -> falls to espn value", () => {
  const onBlock = { name: "Patrick Mahomes II", pos: "QB" as const, team: "KC", espnPreDraftVal: 5 };
  const s = makeV2Strategy({ values: { [nameKey("Patrick Mahomes")]: 40 }, nameKey: identity, starterReserve: 5, premium: 2 });
  const d = s.maxBid(baseState({ onBlock }));
  assert.match(d.reason ?? "", /src=espn/); // proves the normalizer is load-bearing
  assert.ok(d.maxBid < 40);
});

test("v2 nameKey lookup: ESPN 'Broncos D/ST' resolves our 'Broncos' $2 (not espn 8)", () => {
  const onBlock = { name: "Broncos D/ST", pos: "DST" as const, team: "DEN", espnPreDraftVal: 8 };
  const s = makeV2Strategy({ values: { [nameKey("Broncos")]: 2 }, nameKey, starterReserve: 5, premium: 2 });
  const st = baseState({ onBlock, mySlots: { DST: 1, BENCH: 3 } });
  const d = s.maxBid(st);
  assert.match(d.reason ?? "", /src=ours/);
  assert.ok(d.maxBid <= 4, `our $2 value must bind (wantVal ~4), got ${d.maxBid}`);
});

test("v2 nameKey lookup: an absent name falls back to ESPN value (src=espn)", () => {
  const onBlock = { name: "Unknown Rookie", pos: "RB" as const, team: "NYG", espnPreDraftVal: 15 };
  const s = makeV2Strategy({ values: { [nameKey("Some Other Guy")]: 40 }, nameKey, starterReserve: 5, premium: 2 });
  assert.match(s.maxBid(baseState({ onBlock })).reason ?? "", /src=espn/);
});

// Roster shape: the real league (462233) is 16 teams x 12 slots. sim.ts and values.ts must agree,
// or the backtest drafts a bench depth that does not exist (finding #2). rosterSpots can't import
// SIM_LEAGUE (that would be circular), so this test is the binding that keeps the literal honest.
test("ROSTER SHAPE: SIM_LEAGUE is 12 slots and values.rosterSpots is bound to it", () => {
  assert.equal(SIM_LEAGUE.slots.length, 12);
  assert.equal(DEFAULT_VALUE_LEAGUE.rosterSpots, SIM_LEAGUE.slots.length);
});

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

test("lineup optimizer: starts best-by-proj, benches a bye, fills FLEX", async () => {
  const { optimalLineup } = await import("../src/inseason/lineup.ts");
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE"];
  const r = optimalLineup([
    { name: "QB1", pos: "QB", proj: 22, available: true },
    { name: "RB1", pos: "RB", proj: 20, available: true },
    { name: "RB2", pos: "RB", proj: 15, available: false }, // BYE -> must bench
    { name: "RB3", pos: "RB", proj: 12, available: true },
    { name: "RB4", pos: "RB", proj: 11, available: true }, // FLEX candidate
    { name: "WR1", pos: "WR", proj: 18, available: true },
    { name: "WR2", pos: "WR", proj: 14, available: true },
    { name: "TE1", pos: "TE", proj: 9, available: true },
    { name: "K1", pos: "K", proj: 8, available: true },
    { name: "D1", pos: "DST", proj: 7, available: true },
  ], slots);
  const started = new Set(r.starters.map((s) => s.name));
  assert.ok(!started.has("RB2"), "a bye player must not be started");
  assert.ok(started.has("RB1") && started.has("RB3"), "best available RBs start");
  const flex = r.starters.find((s) => s.slot === "FLEX");
  assert.equal(flex?.name, "RB4", "FLEX = best remaining eligible (RB4 at 11)");
  assert.ok(r.bench.some((b) => b.name === "RB2" && !b.available), "the bye RB is on the bench");
  assert.equal(r.starters.length, 9);
});

test("lineup optimizer: flags an unfillable slot when a whole position is out", async () => {
  const { optimalLineup } = await import("../src/inseason/lineup.ts");
  const r = optimalLineup([{ name: "QB1", pos: "QB", proj: 20, available: true }], ["QB", "RB"]);
  assert.ok(r.flags.some((f) => /no available player to fill RB/.test(f)));
});

test("waiver copilot: recommends a clear same-position ROS upgrade, ignores small gains", async () => {
  const { waiverTargets } = await import("../src/inseason/waivers.ts");
  const roster = [{ name: "WR weak", pos: "WR", ros: 6 }, { name: "RB1", pos: "RB", ros: 18 }];
  const fas = [
    { name: "WR hot", pos: "WR", ros: 13, gp: 4 }, // +7 over WR weak -> recommend
    { name: "WR meh", pos: "WR", ros: 7, gp: 4 },   // +1 -> ignore
    { name: "WR smallsample", pos: "WR", ros: 20, gp: 1 }, // gp<3 -> ignore (noise)
  ];
  const recs = waiverTargets(roster, fas);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].add, "WR hot");
  assert.equal(recs[0].drop, "WR weak");
  assert.ok(recs[0].faab > 0);
});

test("waiver copilot: nothing worth it -> empty (don't churn)", async () => {
  const { waiverTargets } = await import("../src/inseason/waivers.ts");
  const recs = waiverTargets([{ name: "WR1", pos: "WR", ros: 15 }], [{ name: "FA", pos: "WR", ros: 16, gp: 5 }]);
  assert.equal(recs.length, 0); // +1 gain < minGain -> no churn (matches the backtest lesson)
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

test("v2 bench K/DST: refuses a K onto the bench, still bids one for the K STARTER slot", () => {
  const kicker = { name: "Top Kicker", pos: "K" as const, team: "BAL", espnPreDraftVal: 13 };
  const s = makeV2Strategy({ values: { "Top Kicker": 13 }, starterReserve: 5, premium: 2 });
  // K slot FILLED (0 open) + bench open -> the only fit is bench -> maxBid 0, even at value 13.
  const bench = baseState({ mySlots: { RB: 1, WR: 1, K: 0, BENCH: 3 }, onBlock: kicker });
  const bBid = s.maxBid(bench);
  assert.equal(bBid.maxBid, 0);
  assert.match(bBid.reason ?? "", /bench K\/DST/);
  // K slot OPEN (starter) -> we DO bid (positive case).
  const starter = baseState({ mySlots: { RB: 1, WR: 1, K: 1, BENCH: 3 }, onBlock: kicker });
  assert.ok(s.maxBid(starter).maxBid >= 1, "a K for the dedicated K slot is biddable");
});

test("v2 bench K/DST: refuses a DST onto the bench", () => {
  const dst = { name: "Ravens D/ST", pos: "DST" as const, team: "BAL", espnPreDraftVal: 10 };
  const s = makeV2Strategy({ values: { "Ravens D/ST": 10 }, starterReserve: 5, premium: 2 });
  const bench = baseState({ mySlots: { RB: 1, DST: 0, BENCH: 3 }, onBlock: dst });
  assert.equal(s.maxBid(bench).maxBid, 0);
});

test("v2 fill-floor: soft reserve never BLOCKS a needed slot we can afford", () => {
  const onBlock = { name: "Y", pos: "RB" as const, team: "SF", espnPreDraftVal: 40 };
  const s = makeV2Strategy({ starterReserve: 4 });
  // $5, 3 open starters -> soft reserve would zero it, but fill-floor keeps it biddable ($1).
  const st = baseState({ myBudget: 5, mySlots: { RB: 1, WR: 1, K: 1 }, onBlock });
  assert.ok(s.maxBid(st).maxBid >= 1);
});
