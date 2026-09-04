// Fault-injection tests for the two load-bearing pure functions that make the MVP done-bar
// (full legal in-budget roster) structurally safe. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { affordableMax, jumpTarget, legalCap, makeV1Strategy, makeV2Strategy, reserveForOthers, type DraftState } from "../src/draft/strategy.ts";
import { hasOpenSlotFor, type Roster } from "../src/draft/espnAuction.ts";
import { SIM_LEAGUE } from "../src/draft/sim.ts";
import { DEFAULT_VALUE_LEAGUE, nameKey, resolveValueLeague } from "../src/draft/values.ts";
import { DEFAULT_CONFIG } from "../src/db/db.ts";

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
  // the three sources of the roster shape must agree (they silently diverged before -- finding #2)
  assert.deepEqual(SIM_LEAGUE.slots, DEFAULT_CONFIG.slots);
});

// resolveValueLeague turns the configured slots into starters -- the wiring that makes config drive
// the $ values. Fault check: 2 FLEX must produce starters.FLEX===2 (the real league), and changing
// slots must change the value league.
test("CONFIG->VALUES: resolveValueLeague derives starters from configured slots", () => {
  const vl = resolveValueLeague(DEFAULT_CONFIG);
  assert.equal(vl.starters.FLEX, 2);
  assert.equal(vl.starters.RB, 1);
  assert.equal(vl.rosterSpots, 12);
  const oneFlex = resolveValueLeague({ ...DEFAULT_CONFIG, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DST", "K", "BE", "BE", "BE"] });
  assert.equal(oneFlex.starters.FLEX, 1);
  assert.equal(oneFlex.starters.RB, 2);
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
  // maxShare pinned high so this isolates the RESERVE mechanic, not the share cap (default is 0.35).
  const s = makeV2Strategy({ starterReserve: 4, benchReserve: 1, premium: 1, maxShare: 0.6 });
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

test("legalCap: unreadable myMax falls back to affordableMax, NOT 0 (finding #9)", () => {
  // 10 open slots, $69 left -> affordableMax 60. A high desired bid + null myMax must cap at 60,
  // never 0 (which would silently pass on everything). And a readable myMax still wins when tighter.
  const s = baseState({ myBudget: 69, mySlots: { RB: 3, WR: 3, BENCH: 4 } });
  assert.equal(legalCap(80, null, s), 60);       // null myMax -> affordableMax(60)
  assert.equal(legalCap(80, undefined, s), 60);   // undefined too
  assert.equal(legalCap(80, 45, s), 45);          // readable, tighter myMax binds
  assert.equal(legalCap(30, null, s), 30);        // our own bid is the binder
});

test("jumpTarget: fixed step above the offer, clamped to cap (Step 8)", () => {
  assert.equal(jumpTarget(10, 50, 5), 15);   // offer 10 + jump 5
  assert.equal(jumpTarget(48, 50, 5), 50);   // would be 53 -> clamped to cap 50
  assert.equal(jumpTarget(30, 30, 5), 30);   // already at cap -> stays
  assert.equal(jumpTarget(10, 50, 8), 18);   // larger jump for a fast timer
});

test("v2 premium: no $premium on the $1 tail; full premium on a real value (Step 6)", () => {
  const cheap = { name: "Filler", pos: "RB" as const, team: "X", espnPreDraftVal: 1 };
  const real = { name: "Starter", pos: "RB" as const, team: "Y", espnPreDraftVal: 30 };
  const s = makeV2Strategy({ starterReserve: 4, premium: 2, maxShare: 0.6 });
  assert.equal(s.maxBid(baseState({ onBlock: cheap })).maxBid, 1);   // $1 value -> stays $1
  assert.equal(s.maxBid(baseState({ onBlock: real })).maxBid, 32);   // $30 value -> 30 + premium 2
});

test("v2 fill-floor: soft reserve never BLOCKS a needed slot we can afford", () => {
  const onBlock = { name: "Y", pos: "RB" as const, team: "SF", espnPreDraftVal: 40 };
  const s = makeV2Strategy({ starterReserve: 4 });
  // $5, 3 open starters -> soft reserve would zero it, but fill-floor keeps it biddable ($1).
  const st = baseState({ myBudget: 5, mySlots: { RB: 1, WR: 1, K: 1 }, onBlock });
  assert.ok(s.maxBid(st).maxBid >= 1);
});

// F3: live ESPN shows "Texans D/ST" where our table stores "HOU D/ST", so the value lookup MISSES
// and falls back to ESPN's on-screen value -- which the table's own $2 clamp never sees. The cap
// has to live in maxBid, on the final number.
test("v2 K/DST cap: an unmatched DST falls back to ESPN's value but still caps at $2", () => {
  const dst = { name: "Texans D/ST", pos: "DST" as const, team: "HOU", espnPreDraftVal: 8 };
  const s = makeV2Strategy({ values: { "HOU D/ST": 2 }, premium: 2 }); // our table keyed the OTHER way
  const st = baseState({ mySlots: { DST: 1, BENCH: 3 }, onBlock: dst });
  const bid = s.maxBid(st);
  assert.match(bid.reason ?? "", /src=espn/, "the lookup must genuinely miss (that is the bug)");
  assert.ok(bid.maxBid <= 2, `DST bid must cap at $2, got ${bid.maxBid}`);
});

// FI for the cap above: raise the dial and the SAME state must bid high. Proves the $2 came from
// maxKDst and not from some unrelated reserve/share cap that happened to bind.
test("v2 K/DST cap FAULT: maxKDst=99 lets the same DST bid rise to its ESPN value", () => {
  const dst = { name: "Texans D/ST", pos: "DST" as const, team: "HOU", espnPreDraftVal: 8 };
  const s = makeV2Strategy({ values: { "HOU D/ST": 2 }, premium: 2, maxKDst: 99 });
  const st = baseState({ mySlots: { DST: 1, BENCH: 3 }, onBlock: dst });
  assert.ok(s.maxBid(st).maxBid >= 8, `uncapped DST should reach ~10, got ${s.maxBid(st).maxBid}`);
});

// F4: live nomination. Early, ESPN's board virtualizes to ~18 rows -- all valuable -- so the old
// "lowest visible" policy put up a mid-tier player, sometimes one of ours. New policy: drain the
// most expensive player we are NOT targeting.
const richBoard = () => [
  { name: "Stud A", pos: "RB" as const, team: "A", espnPreDraftVal: 60 },
  { name: "Stud B", pos: "WR" as const, team: "B", espnPreDraftVal: 55 },
  { name: "Stud C", pos: "RB" as const, team: "C", espnPreDraftVal: 50 },
  { name: "Stud D", pos: "WR" as const, team: "D", espnPreDraftVal: 45 },
  { name: "Mid E", pos: "TE" as const, team: "E", espnPreDraftVal: 40 },
  { name: "Mid F", pos: "QB" as const, team: "F", espnPreDraftVal: 35 },
  { name: "Mid G", pos: "RB" as const, team: "G", espnPreDraftVal: 30 },
  { name: "Mid H", pos: "WR" as const, team: "H", espnPreDraftVal: 25 },
  { name: "Mid I", pos: "TE" as const, team: "I", espnPreDraftVal: 20 },
  { name: "Mid J", pos: "WR" as const, team: "J", espnPreDraftVal: 15 },
];

test("v2 nominate EARLY: puts up an expensive NON-target, never our #1 value", () => {
  const s = makeV2Strategy({});
  const board = richBoard();
  const st = baseState({ board, onBlock: null });
  const n = s.nominate!(st);
  assert.notEqual(n.player.name, "Stud A", "must never nominate our own top target");
  assert.ok((n.player.espnPreDraftVal ?? 0) >= 10, "early nomination must drain real money");
  assert.match(n.reason ?? "", /drain non-target/);
});

test("v2 nominate LATE: everything cheap -> the best fillable non-K/DST keeper", () => {
  const s = makeV2Strategy({});
  const board = [
    { name: "Some K", pos: "K" as const, team: "K", espnPreDraftVal: 3 },
    { name: "Some DST", pos: "DST" as const, team: "D", espnPreDraftVal: 3 },
    { name: "Sleeper WR", pos: "WR" as const, team: "W", espnPreDraftVal: 3 },
    { name: "Scrub RB", pos: "RB" as const, team: "R", espnPreDraftVal: 1 },
  ];
  const st = baseState({ board, onBlock: null, mySlots: { WR: 1, BENCH: 2 } });
  const n = s.nominate!(st);
  assert.equal(n.player.name, "Sleeper WR", "late, self-winning our best cheap keeper is a feature");
  assert.match(n.reason ?? "", /late: best cheap keeper/);
});

// FI for target protection: with the roster already full of everyone EXCEPT the studs, `fills`
// still holds (bench open), so the top-8 target set covers Stud A. Shrink the protected set by
// filling every slot -- nothing "fills", targets goes empty -- and the #1 value gets nominated.
test("v2 nominate FAULT: with no target protection the #1-value player is what goes up", () => {
  const s = makeV2Strategy({});
  const board = richBoard();
  // Every slot closed -> fills() is false for all -> targets is EMPTY -> drain picks byVal[0].
  const st = baseState({ board, onBlock: null, mySlots: { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0, BENCH: 0 } });
  assert.equal(s.nominate!(st).player.name, "Stud A",
    "unprotected, the policy nominates our own best player -- this is what targets prevents");
});

// Step 9a end-to-end: the alias must fire in the LIVE value lookup, not just in the map. Same state
// as the K/DST cap test above, which asserts src=espn -- here our table is keyed the way it really
// is ("HOU D/ST") and the ESPN spelling must now resolve to it.
test("v2 DST alias: ESPN's 'Texans D/ST' resolves our 'HOU D/ST' value (src=ours(dst-alias))", () => {
  const dst = { name: "Texans D/ST", pos: "DST" as const, team: "HOU", espnPreDraftVal: 8 };
  const s = makeV2Strategy({ values: { "hou": 2 }, nameKey, premium: 2 });
  const st = baseState({ mySlots: { DST: 1, BENCH: 3 }, onBlock: dst });
  const bid = s.maxBid(st);
  assert.match(bid.reason ?? "", /src=ours\(dst-alias\)/, "the alias join must resolve the name");
  assert.ok(bid.maxBid <= 2, `still capped at $2, got ${bid.maxBid}`);
});

// benchDiscount: a player who can ONLY fill a bench slot is worth less to this roster than his
// standalone value, because he never enters the lineup. Off by default (1 = no change).
test("v2 benchDiscount: a bench-only player's ceiling drops; a STARTER's does not", () => {
  const qb = { name: "Backup QB", pos: "QB" as const, team: "X", espnPreDraftVal: 40 };
  const vals = { "Backup QB": 40 };
  const full = makeV2Strategy({ values: vals, premium: 0, benchDiscount: 0.5, maxShare: 1 });
  const off  = makeV2Strategy({ values: vals, premium: 0, benchDiscount: 1,   maxShare: 1 });
  // QB slot FILLED -> he can only go to the bench.
  const benchState = baseState({ mySlots: { QB: 0, BENCH: 3 }, onBlock: qb });
  const a = off.maxBid(benchState).maxBid, b = full.maxBid(benchState).maxBid;
  assert.ok(b < a, `discounted bench bid ${b} must be below undiscounted ${a}`);
  assert.equal(b, Math.round(a * 0.5));
  // QB slot OPEN -> he is a starter; the discount must NOT apply.
  const startState = baseState({ mySlots: { QB: 1, BENCH: 3 }, onBlock: qb });
  assert.equal(full.maxBid(startState).maxBid, off.maxBid(startState).maxBid,
    "a starter must be priced identically whether or not benchDiscount is set");
});

// Live mock 3 (r1530) read "Steelers D/ST" with pos=K, so a position-gated alias lookup missed and
// the value fell through to ESPN's. The alias must key off the NAME.
test("v2 DST alias: resolves even when ESPN reports the wrong position for a defense", () => {
  const dst = { name: "Steelers D/ST", pos: "K" as const, team: "PIT", espnPreDraftVal: 7 };
  const s = makeV2Strategy({ values: { "pit": 2 }, nameKey, premium: 2 });
  const st = baseState({ mySlots: { DST: 1, K: 1, BENCH: 3 }, onBlock: dst });
  assert.match(s.maxBid(st).reason ?? "", /src=ours\(dst-alias\)/);
});

// Per-position value multipliers. VOR prices a position in isolation; the ROSTER decides how many
// startable weeks a dollar there buys (1 QB slot vs 4 RB/WR/TE-eligible starting slots).
test("v2 posMult: scales OUR value for the named position only", () => {
  const qb = { name: "Big Arm", pos: "QB" as const, team: "X", espnPreDraftVal: 50 };
  const rb = { name: "Big Legs", pos: "RB" as const, team: "Y", espnPreDraftVal: 50 };
  const vals = { "Big Arm": 50, "Big Legs": 50 };
  const flat = makeV2Strategy({ values: vals, premium: 0, maxShare: 1 });
  const cut  = makeV2Strategy({ values: vals, premium: 0, maxShare: 1, posMult: { QB: 0.7 } });
  const st = (onBlock: typeof qb) => baseState({ mySlots: { QB: 1, RB: 1, BENCH: 3 }, onBlock });
  assert.equal(cut.maxBid(st(qb)).maxBid, Math.round(flat.maxBid(st(qb)).maxBid * 0.7));
  assert.equal(cut.maxBid(st(rb)).maxBid, flat.maxBid(st(rb)).maxBid, "RB must be untouched by a QB multiplier");
});

// FI: an absent position key must mean 1x, not 0 -- a lookup miss that silently zeroed a value would
// make us refuse every player at that position.
test("v2 posMult FAULT: a position with no entry is unchanged, never zeroed", () => {
  const te = { name: "Tight End", pos: "TE" as const, team: "Z", espnPreDraftVal: 30 };
  const vals = { "Tight End": 30 };
  const a = makeV2Strategy({ values: vals, premium: 0, maxShare: 1 });
  const b = makeV2Strategy({ values: vals, premium: 0, maxShare: 1, posMult: { QB: 0.5 } });
  const st = baseState({ mySlots: { TE: 1, BENCH: 3 }, onBlock: te });
  assert.equal(b.maxBid(st).maxBid, a.maxBid(st).maxBid);
  assert.ok(b.maxBid(st).maxBid > 0);
});
