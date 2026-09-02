// Fault-injection for the Layer-2 news classifier: it maps a general feed item's (category,
// severity) to an actionable draft flag. Injury high -> AVOID, injury medium -> WATCH, a concerning
// role -> BURIED; headlines and low-severity role notes are informational (no flag).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNews } from "../src/news.ts";

test("classifyNews: injury severity maps to AVOID / WATCH", () => {
  assert.equal(classifyNews("injury", "high"), "AVOID");   // Out / Doubtful
  assert.equal(classifyNews("injury", "medium"), "WATCH"); // Questionable
});

test("classifyNews: a concerning role flags BURIED; a low-severity role does NOT", () => {
  assert.equal(classifyNews("role", "high"), "BURIED");
  assert.equal(classifyNews("role", "medium"), "BURIED");
  assert.equal(classifyNews("role", "low"), ""); // RB2/WR2 -- Layer 1 marked it low, not a flag
});

test("classifyNews FAULT: headlines and unknowns are informational, not flags", () => {
  assert.equal(classifyNews("headline", "low"), "");
  assert.equal(classifyNews("headline", "high"), "");   // even a 'high' headline is not an auto-flag
  assert.equal(classifyNews("transaction", "high"), ""); // an unmodelled category -> no flag
});
