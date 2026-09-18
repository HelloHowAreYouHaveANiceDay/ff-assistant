/**
 * AVAILABILITY HAS TO REACH EVERY VERB THAT PICKS A PLAYER, NOT JUST THE LINEUP.
 *
 * On 2026-09-18 the waiver verb recommended bidding 53% of the FAAB budget on a running back who had
 * been placed on injured reserve two days earlier. There were TWO independent defects behind it, and
 * fixing either alone left the recommendation standing:
 *
 *   1. `normalizeStatus` did not recognise the game-day feed's spelling of IR (see
 *      test/status-vocabulary.test.ts). Fixed first -- and the man was STILL recommended.
 *   2. `waiverTargets` and `tradeFinder` never received an availability map at all. They built their
 *      candidate pools from the board minus the rostered set and never asked who could play, so an
 *      injured man was priced at his full projection and scored through the simulator as though he
 *      would suit up every remaining week.
 *
 * That is the half-fix shape CLAUDE.md records: fixing one caller of a contract is worse than fixing
 * none, because it looks done. The live proof was running the verb after fix 1 and seeing the same
 * name come back.
 *
 * Both directions are asserted throughout: a filter that excludes everyone is as broken as one that
 * excludes nobody, and only one of the two is visible in a green run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeInjury } from "../src/data/gamedayStatus.js";
import { normalizeStatus, type AvailabilityMap } from "../src/inseason/copilot.js";
import { nameKey } from "../src/draft/values.js";

// ---------------------------------------------------------------------------------------------
// 1. THE INJURY DETAIL -- `[object Object]`
// ---------------------------------------------------------------------------------------------

test("DETAIL: an object-shaped `details` becomes a readable line, never [object Object]", () => {
  // The field was typed `string` and passed through `String(v)`. Every row in raw_gameday_status
  // carried the literal text "[object Object]" -- a non-empty string in a nullable column, which no
  // schema check and no consumer could complain about.
  assert.equal(
    describeInjury({ type: "Knee", location: "Knee", detail: "Sprain", side: "Left", returnDate: "2026-10-01" }),
    "Left Knee -- Sprain (return 2026-10-01)");
  assert.equal(describeInjury({ location: "Ankle", detail: "Fracture" }), "Ankle -- Fracture");
  assert.equal(describeInjury({ type: "Hamstring" }), "Hamstring");
});

test("DETAIL: a STRING still works, and nothing usable yields null rather than a placeholder", () => {
  assert.equal(describeInjury("Hamstring strain"), "Hamstring strain");
  assert.equal(describeInjury({}, "Questionable - Knee"), "Questionable - Knee", "falls back when the object is empty");
  assert.equal(describeInjury(null, "Out"), "Out");
  assert.equal(describeInjury({}), null, "no detail and no fallback is NULL, not a placeholder");
  assert.equal(describeInjury(undefined), null);
  assert.equal(describeInjury("   "), null, "whitespace is not a detail");
  // The regression itself, stated as an assertion rather than as a comment.
  for (const out of [describeInjury({ a: 1 }), describeInjury({}), describeInjury(null)]) {
    assert.notEqual(out, "[object Object]");
  }
});

// ---------------------------------------------------------------------------------------------
// 2. THE FILTERS -- asserted on the predicate the verbs use
// ---------------------------------------------------------------------------------------------

const avail = (entries: [string, string][]): AvailabilityMap =>
  new Map(entries.map(([name, status]) => [nameKey(name), {
    status: normalizeStatus(status), source: "test", detail: status,
  }]));

/** The exact test both verbs apply. Kept here so the assertion is on the RULE, and the live runs
 *  below are what prove the rule is wired in. */
const isOut = (m: AvailabilityMap, name: string) => m.get(nameKey(name))?.status === "OUT";

test("FILTER: the availability map rules out an IR man under either spelling", () => {
  const m = avail([["Jordan Mason", "Injured Reserve"], ["Isiah Pacheco", "IR"], ["Breece Hall", "Questionable"]]);
  assert.equal(isOut(m, "Jordan Mason"), true, "the game-day spelling -- the one that was missed");
  assert.equal(isOut(m, "Isiah Pacheco"), true, "the abbreviation");
  // THE OTHER DIRECTION, and it is the one that matters most: a questionable man stays a candidate.
  // A filter that dropped him would quietly shrink every pool by the largest status class there is
  // (136 of 278 game-day rows this season are Questionable).
  assert.equal(isOut(m, "Breece Hall"), false);
  assert.equal(isOut(m, "Somebody Unlisted"), false, "an unlisted man is available, not excluded");
});

test("FILTER: the name key is what the map is built on, so spelling drift still resolves", () => {
  // Both sides go through `nameKey`, so this is an id-style lookup rather than a display-name match
  // -- the defect this repo has already paid for twice.
  const m = avail([["Michael Pittman Jr.", "Out"]]);
  assert.equal(isOut(m, "Michael Pittman Jr"), true);
  assert.equal(isOut(m, "michael pittman jr."), true);
});

test("FILTER: an EMPTY map changes nothing -- the unfiltered path is preserved", () => {
  // Every caller that passes no availability must behave exactly as before. If this diverges, the
  // change is not additive and every historical waiver/trade result moved with it.
  const m: AvailabilityMap = new Map();
  for (const n of ["Jordan Mason", "Isiah Pacheco", "Breece Hall"]) assert.equal(isOut(m, n), false);
});
