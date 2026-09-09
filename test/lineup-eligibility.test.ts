/**
 * The lineup optimiser once eligibility is a SET.
 *
 * Two claims, and they pull in opposite directions, so both need evidence:
 *
 *   1. For a roster where every player fits one position -- which is every player on the 2026 board,
 *      measured -- the answer must be what the old slot-order fill produced, slot label for slot
 *      label. That is checked against a REFERENCE IMPLEMENTATION of the old algorithm, on a thousand
 *      randomised rosters under this league's real template, rather than against a handful of
 *      hand-typed fixtures that would agree by accident.
 *   2. Where eligibility overlaps, the old algorithm is WRONG and the new one must differ. The
 *      fault injection is that same reference implementation: run it on the overlap fixture and
 *      watch it lose points.
 *
 * A test that only asserted (1) would pass just as well if the new code were the old code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalLineup, type RosterPlayer, type LineupResult } from "../src/inseason/lineup.js";

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
const FLEX_OK = ["RB", "WR", "TE"];

/**
 * THE OLD ALGORITHM, kept here verbatim in spirit: walk the slots in template order, and give each
 * one the best remaining player eligible for it. Eligibility-aware, so the comparison isolates the
 * ORDER of assignment and nothing else.
 */
function greedyBySlotOrder(players: RosterPlayer[], slots: string[], flexOk: string[]): LineupResult {
  const flex = new Set(flexOk);
  const startSlots = slots.filter((s) => s !== "BE" && s !== "BENCH");
  const eligOf = (p: RosterPlayer) => (p.eligible && p.eligible.length ? p.eligible : [p.pos]);
  const avail = players.filter((p) => p.available);
  const used = new Set<RosterPlayer>();
  const starters: LineupResult["starters"] = [];
  for (const slot of startSlots) {
    const ok = (p: RosterPlayer) => (slot === "FLEX" ? eligOf(p).some((e) => flex.has(e)) : eligOf(p).includes(slot));
    let pick: RosterPlayer | undefined;
    for (const p of avail) if (!used.has(p) && ok(p) && (!pick || p.proj > pick.proj)) pick = p;
    if (pick) { used.add(pick); starters.push({ slot, name: pick.name, pos: pick.pos, proj: pick.proj }); }
    else starters.push({ slot, name: "(empty)", pos: slot, proj: 0 });
  }
  const bench = players.filter((p) => !used.has(p)).sort((a, b) => b.proj - a.proj)
    .map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: p.available }));
  return { starters, bench, totalProj: Math.round(starters.reduce((s, x) => s + x.proj, 0) * 10) / 10, flags: [] };
}

/** A deterministic LCG -- a randomised test that cannot be re-run on the seed that failed is not a
 *  test, it is an anecdote. */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function randomRoster(r: () => number): RosterPlayer[] {
  const counts: Record<string, number> = { QB: 1 + Math.floor(r() * 3), RB: 2 + Math.floor(r() * 4), WR: 2 + Math.floor(r() * 4), TE: 1 + Math.floor(r() * 3), K: 1, DST: 1 };
  const out: RosterPlayer[] = [];
  for (const [pos, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      // Distinct projections to two decimals: the old FLEX fill broke exact ties by the position's
      // order in flex_ok, which is a property of that implementation and not of the lineup.
      out.push({ name: `${pos}${i}`, pos, proj: Math.round(r() * 3000) / 100 + out.length * 0.001, available: r() > 0.2 });
    }
  }
  return out;
}

test("SINGLE-ELIGIBLE: the new optimiser reproduces the old slot-order fill on 1000 random rosters", () => {
  const r = rng(20260909);
  let checked = 0, withEmpties = 0;
  for (let i = 0; i < 1000; i++) {
    const roster = randomRoster(r);
    const a = optimalLineup(roster, SLOTS, FLEX_OK);
    const b = greedyBySlotOrder(roster, SLOTS, FLEX_OK);
    assert.deepEqual(a.starters, b.starters, `roster ${i}: starters differ`);
    assert.equal(a.totalProj, b.totalProj, `roster ${i}: total differs`);
    assert.deepEqual(a.bench, b.bench, `roster ${i}: bench differs`);
    checked++;
    if (a.starters.some((s) => s.name === "(empty)")) withEmpties++;
  }
  assert.equal(checked, 1000);
  // The fixture must actually exercise the hard cases, or "identical" is a statement about easy ones.
  assert.ok(withEmpties > 50, `only ${withEmpties} rosters had an unfillable slot -- the fixture is too easy`);
});

// --- OVERLAP: where the two algorithms must disagree ----------------------------------------------

const SWISS = (proj: number): RosterPlayer => ({ name: "Swiss", pos: "RB", proj, available: true, eligible: ["RB", "WR"] });

test("a dual RB/WR fills whichever of RB and WR is OPEN, in both directions", () => {
  const withRunner = optimalLineup([SWISS(20), { name: "Runner", pos: "RB", proj: 18, available: true }], ["RB", "WR"], FLEX_OK);
  assert.deepEqual(withRunner.starters.map((s) => `${s.slot}:${s.name}`), ["RB:Runner", "WR:Swiss"]);
  assert.equal(withRunner.totalProj, 38);

  const withWideout = optimalLineup([SWISS(20), { name: "Wideout", pos: "WR", proj: 18, available: true }], ["RB", "WR"], FLEX_OK);
  assert.deepEqual(withWideout.starters.map((s) => `${s.slot}:${s.name}`), ["RB:Swiss", "WR:Wideout"]);
  assert.equal(withWideout.totalProj, 38);
});

test("FAULT INJECTION: the old slot-order fill strands the receiver slot and loses 18 points", () => {
  const roster = [SWISS(20), { name: "Runner", pos: "RB", proj: 18, available: true }];
  const greedy = greedyBySlotOrder(roster, ["RB", "WR"], FLEX_OK);
  // It takes the dual man for RB because he is the best RB-eligible body, and then has nobody left
  // who can play receiver at all.
  assert.deepEqual(greedy.starters.map((s) => `${s.slot}:${s.name}`), ["RB:Swiss", "WR:(empty)"]);
  assert.equal(greedy.totalProj, 20);
  assert.equal(optimalLineup(roster, ["RB", "WR"], FLEX_OK).totalProj, 38,
    "if these two ever agree, the augmenting path has stopped running and the optimiser is greedy again");
});

test("the assignment maximises the TOTAL, not merely the count of filled slots", () => {
  // Both algorithms fill every slot here; only one picks the right men for them.
  const roster: RosterPlayer[] = [
    { name: "Swiss", pos: "RB", proj: 25, available: true, eligible: ["RB", "TE"] },
    { name: "Runner", pos: "RB", proj: 24, available: true },
    { name: "TightEnd", pos: "TE", proj: 3, available: true },
  ];
  const best = optimalLineup(roster, ["RB", "TE"], FLEX_OK);
  assert.equal(best.totalProj, 49, "Swiss must take TE so the better back keeps RB");
  assert.deepEqual(best.starters.map((s) => `${s.slot}:${s.name}`), ["RB:Runner", "TE:Swiss"]);
  assert.ok(greedyBySlotOrder(roster, ["RB", "TE"], FLEX_OK).totalProj < best.totalProj);
});

test("an UNAVAILABLE dual-eligible player is still not startable anywhere", () => {
  const roster: RosterPlayer[] = [
    { name: "Swiss", pos: "RB", proj: 40, available: false, eligible: ["RB", "WR"] },
    { name: "Wideout", pos: "WR", proj: 9, available: true },
  ];
  const res = optimalLineup(roster, ["RB", "WR"], FLEX_OK);
  assert.deepEqual(res.starters.map((s) => `${s.slot}:${s.name}`), ["RB:(empty)", "WR:Wideout"]);
  assert.ok(res.flags.some((f) => /no available player to fill RB/.test(f)));
});
