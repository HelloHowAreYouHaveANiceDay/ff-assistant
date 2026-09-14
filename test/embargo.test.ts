import { test } from "node:test";
import assert from "node:assert/strict";
import { embargoedSeasons, embargoTrainingSeasons } from "../src/model/embargo.js";

// WS3 ADJACENT-SEASON EMBARGO. The load-bearing decision is "which seasons does a fold train on",
// and it must be provable in isolation. These tests fault-inject it: the embargoed set for a fold at
// Y with embargo 1 must EXCLUDE {Y-1, Y} and INCLUDE Y-2; embargo 0 must reproduce the pre-embargo
// set; and an embargo wide enough to empty the training set must THROW rather than fit on nothing.
// This is the same season arithmetic the Python trainer applies (train_projection.embargo_seasons)
// and that evaluate.ts's runtime guard re-checks against the artifact the trainer actually emits, so
// a green test here plus a passing one-fold artifact run pins both ends of the contract.

const ALL = Array.from({ length: 27 }, (_, i) => 1999 + i); // 1999..2025

test("embargoedSeasons: embargo 1 at Y removes exactly {Y-1}", () => {
  assert.deepEqual(embargoedSeasons(2018, 1), [2017]);
});

test("embargoedSeasons: embargo 2 at Y removes {Y-2, Y-1}", () => {
  assert.deepEqual(embargoedSeasons(2018, 2), [2016, 2017]);
});

test("embargoedSeasons: embargo 0 removes nothing", () => {
  assert.deepEqual(embargoedSeasons(2018, 0), []);
});

test("FAULT: for a fold at 2015 with embargo 1, training EXCLUDES {2014,2015} and INCLUDES 2013", () => {
  const kept = embargoTrainingSeasons(ALL, 2015, 1);
  assert.equal(kept.includes(2015), false, "held-out season 2015 must be absent (walk-forward)");
  assert.equal(kept.includes(2014), false, "adjacent season 2014 must be embargoed");
  assert.equal(kept.includes(2013), true, "2013 (Y-2) must remain in training");
  assert.equal(kept.includes(2016), false, "future season 2016 must be absent (walk-forward)");
});

test("embargo 0 reproduces the pre-embargo walk-forward training set (all seasons < Y)", () => {
  const kept = embargoTrainingSeasons(ALL, 2015, 0);
  assert.deepEqual(kept, ALL.filter((s) => s < 2015));
});

test("embargo 1 is exactly the embargo-0 set minus Y-1", () => {
  const base = embargoTrainingSeasons(ALL, 2015, 1);
  const zero = embargoTrainingSeasons(ALL, 2015, 0);
  assert.deepEqual(base, zero.filter((s) => s !== 2014));
});

test("FAULT: an embargo that would empty the training set THROWS", () => {
  // Only one candidate training season (2014) below Y=2015; embargo 1 removes it -> empty.
  assert.throws(() => embargoTrainingSeasons([2014, 2015], 2015, 1), /empty the training set/);
});

test("FAULT: a negative embargo is rejected", () => {
  assert.throws(() => embargoedSeasons(2015, -1), /non-negative/);
  assert.throws(() => embargoedSeasons(2015, 1.5), /non-negative integer/);
});
