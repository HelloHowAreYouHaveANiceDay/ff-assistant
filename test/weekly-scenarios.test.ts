// THE LINEUP-REGRET ROSTER TEMPLATE, AND THE PIN ON THE INCUMBENT'S (WP8).
//
// `lineupRegret` is the weekly track's DECISION metric, and until this pass the roster shapes it drew
// were one hand-written constant: the ESPN league's starting template, with a kicker, a defence, one
// FLEX and no SUPERFLEX. Measuring a superflex league through that template is not slightly off -- it
// scores a lineup decision nobody in that league ever makes and reports it under the same column
// heading. So the template is now derivable from a league's own slots.
//
// Two things need asserting, and they pull in opposite directions:
//   1. THE INCUMBENT'S SHAPES ARE PINNED. `SCENARIOS` is what every number in docs/validation.md and
//      docs/weekly.md was measured on. A derivation that "reproduces" it is not good enough -- and in
//      fact `scenariosForSlots` does NOT reproduce it (the stored ESPN config says RB1/WR1 where the
//      pinned template says RB2/WR2), which is exactly why the constant stays a constant.
//   2. THE DERIVATION ADMITS WHAT THE LEAGUE ADMITS. A superflex template has to carry the SUPERFLEX
//      slot and enough quarterbacks to fill it, or the decision it measures is vacuous.
// Plus the fault injection that separates "derived" from "hardcoded to something that looks derived":
// remove the superflex slot and the QB minimum must fall back to the dedicated-slot count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, scenariosForSlots } from "../src/weekly/evaluate.js";

const YAHOO_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
  "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"];

test("the incumbent's two roster shapes are PINNED, exactly as every published weekly number was measured", () => {
  assert.equal(SCENARIOS.length, 2);
  assert.deepEqual(SCENARIOS.map((s) => s.name), ["standard-15", "deep-18"]);
  assert.deepEqual(SCENARIOS[0].slots, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST"]);
  assert.deepEqual(SCENARIOS[1].slots, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST"]);
  assert.deepEqual(SCENARIOS[0].min, { QB: 2, RB: 4, WR: 4, TE: 2, K: 1, DST: 1 });
  assert.deepEqual(SCENARIOS[1].min, { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, DST: 1 });
  assert.deepEqual(SCENARIOS.map((s) => s.size), [15, 18]);
});

test("a superflex template carries the SUPERFLEX slot, no kicker, and enough quarterbacks to fill it", () => {
  const sc = scenariosForSlots(YAHOO_SLOTS, ["RB", "WR", "TE"]);
  assert.equal(sc.length, 2);
  // Bench-like slots (BE / IR) are not lineup slots and must not be drawn for.
  assert.deepEqual(sc[0].slots, ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX"]);
  assert.ok(sc[0].slots.includes("SUPERFLEX"), "the whole point of the format");
  assert.ok(!sc[0].slots.includes("K") && !sc[0].slots.includes("DST"),
    "this league rosters neither a kicker nor a defence; drawing for them would make every roster illegal");
  // Ten starters, plus the same two bench depths the pinned shapes use.
  assert.deepEqual(sc.map((s) => s.size), [15, 18]);
  assert.equal(sc[0].min.QB, 2, "one dedicated QB slot -> two quarterbacks, so the SUPERFLEX is a real choice");
  assert.equal(sc[0].min.RB, 4);
  assert.equal(sc[0].min.WR, 4);
  assert.equal(sc[0].min.TE, 2);
  assert.equal(sc[0].min.K, undefined);
  assert.equal(sc[0].min.DST, undefined);
});

test("FAULT INJECTION: the template really reads the slots -- drop the flexes and the shape follows", () => {
  const noFlex = scenariosForSlots(["QB", "WR", "WR", "RB", "RB", "TE", "BE", "BE"], ["RB", "WR", "TE"]);
  assert.deepEqual(noFlex[0].slots, ["QB", "WR", "WR", "RB", "RB", "TE"]);
  assert.equal(noFlex[0].size, 6 + 5);
  // A 1-QB league: the minimum is still twice the dedicated count (one real choice), and nothing in
  // the template admits a second quarterback to a starting slot.
  assert.equal(noFlex[0].min.QB, 2);
  assert.ok(!noFlex[0].slots.some((s) => s === "SUPERFLEX" || s === "FLEX"));
});

test("a slash-form superflex (Yahoo's own token) parses to the same thing as SUPERFLEX", () => {
  const a = scenariosForSlots(["QB", "RB", "WR", "TE", "Q/W/R/T", "BN"], ["RB", "WR", "TE"]);
  const b = scenariosForSlots(["QB", "RB", "WR", "TE", "SUPERFLEX", "BN"], ["RB", "WR", "TE"]);
  assert.deepEqual(a.map((s) => s.min), b.map((s) => s.min));
  assert.deepEqual(a.map((s) => s.size), b.map((s) => s.size));
});
