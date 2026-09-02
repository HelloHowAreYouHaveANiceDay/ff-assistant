// Fault-injection for draft-board tiering: a real value cliff must split a tier, and a cluster of
// near-equal values must NOT collapse into one giant blob (it gets force-split at maxTierSize).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tierize } from "../src/draft/cheatsheet.ts";

test("a value cliff starts a new tier", () => {
  const t = tierize([{ name: "A", value: 100 }, { name: "B", value: 98 }, { name: "C", value: 60 }, { name: "D", value: 58 }]);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0].map((p) => p.name), ["A", "B"]); // 100->98 no cliff
  assert.deepEqual(t[1].map((p) => p.name), ["C", "D"]); // 98->60 is a cliff
});

test("FAULT: a flat cluster is force-split at maxTierSize, not dumped in one blob", () => {
  const flat = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, value: 2 })); // all equal -> no cliff ever
  const t = tierize(flat, { maxTierSize: 5 });
  assert.ok(t.length >= 3, `12 equal values must split into >=3 tiers, got ${t.length}`);
  assert.ok(t.every((tier) => tier.length <= 5), "no tier exceeds maxTierSize");
});

test("input order does not matter (tierize sorts by value desc)", () => {
  const t = tierize([{ name: "C", value: 60 }, { name: "A", value: 100 }, { name: "B", value: 98 }]);
  assert.equal(t[0][0].name, "A");
});
