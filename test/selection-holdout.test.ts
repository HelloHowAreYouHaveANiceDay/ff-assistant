import { test } from "node:test";
import assert from "node:assert/strict";
// The selection-blind holdout split + guard (rigor program WS2). One definition, read by
// feature-sweep.mjs, admit-feature.mjs and cpcv.mjs. Fault injection is the whole point of this file:
// a guard that can only ever say "pass" is dead code.
import { HOLDOUT_SEASONS, parseHoldout, splitSeasons, assertSelectionBlind } from "../scripts/lib/holdout.mjs";

const ALL = Array.from({ length: 19 }, (_, i) => 2007 + i); // 2007-2025

test("clean split: selection and holdout are DISJOINT and the guard PASSES", () => {
  const { selection, holdout } = splitSeasons(ALL, HOLDOUT_SEASONS);
  const inter = selection.filter((y) => holdout.includes(y));
  assert.deepEqual(inter, [], `intersection must be empty, got ${inter.join(",")}`);
  assert.deepEqual(holdout, [2021, 2022, 2023, 2024, 2025]);
  assert.equal(assertSelectionBlind(selection, HOLDOUT_SEASONS), true);
});

test("FAULT: a holdout season fed into the selection set makes the guard THROW", () => {
  const poisoned = [2018, 2019, 2020, 2023]; // 2023 is in the holdout block
  assert.throws(
    () => assertSelectionBlind(poisoned, HOLDOUT_SEASONS),
    /selection-blind violated.*2023/,
  );
});

test("the split is EXHAUSTIVE: selection ∪ holdout == all (order-independent)", () => {
  const { selection, holdout } = splitSeasons(ALL, HOLDOUT_SEASONS);
  const union = [...selection, ...holdout].sort((a, b) => a - b);
  assert.deepEqual(union, [...ALL].sort((a, b) => a - b));
});

test("splitSeasons never invents a season absent from `all`", () => {
  // holdout block extends past the data (2025 present, 2026 not) -> only present seasons appear.
  const { selection, holdout } = splitSeasons([2019, 2020, 2021], [2021, 2026]);
  assert.deepEqual(selection, [2019, 2020]);
  assert.deepEqual(holdout, [2021]); // 2026 is not fabricated
});

test("parseHoldout: default, range, list, and mixed specs", () => {
  assert.deepEqual(parseHoldout(null), HOLDOUT_SEASONS);
  assert.deepEqual(parseHoldout(""), HOLDOUT_SEASONS);
  assert.deepEqual(parseHoldout("2021-2025"), [2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(parseHoldout("2020,2022"), [2020, 2022]);
  assert.deepEqual(parseHoldout("2019,2021-2023"), [2019, 2021, 2022, 2023]);
});

test("FAULT: a custom holdout override is still enforced by the guard", () => {
  const custom = parseHoldout("2015-2016");
  assert.doesNotThrow(() => assertSelectionBlind([2010, 2011, 2017], custom));
  assert.throws(() => assertSelectionBlind([2010, 2015], custom), /2015/);
});
