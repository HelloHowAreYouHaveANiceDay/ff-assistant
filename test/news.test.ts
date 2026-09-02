// Fault-injection for the news classifier: an injury status must flag, a healthy starter must NOT,
// and the depth-backup rule must be POS-aware (RB/WR need depth>=3, QB/TE/K flag at depth>=2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNews } from "../src/news.ts";

test("classifyNews: injury designations always flag, by severity", () => {
  assert.match(classifyNews("Out", "RB", 1), /AVOID \(OUT\)/);
  assert.match(classifyNews("Doubtful", "WR", 1), /RISK/);
  assert.match(classifyNews("Questionable", "RB", 1), /WATCH/);
});

test("classifyNews: a healthy starter (depth 1, no status) is NOT flagged", () => {
  assert.equal(classifyNews("", "RB", 1), "");
  assert.equal(classifyNews("", "QB", 1), "");
});

test("classifyNews FAULT: RB/WR depth 2 is NOT buried (RB2/WR2 still starts), but depth 3 is", () => {
  assert.equal(classifyNews("", "RB", 2), "");           // committee RB2 -> not flagged
  assert.equal(classifyNews("", "WR", 2), "");           // WR2 -> not flagged
  assert.match(classifyNews("", "RB", 3), /BURIED \(depth 3\)/); // clearly buried
});

test("classifyNews: QB/TE/K flag at depth 2 (a real backup)", () => {
  assert.match(classifyNews("", "QB", 2), /BURIED \(depth 2\)/);
  assert.match(classifyNews("", "TE", 2), /BURIED/);
  assert.match(classifyNews("", "K", 2), /BURIED/);
});

test("classifyNews: null/absent depth with no status -> no flag", () => {
  assert.equal(classifyNews("", "WR", null), "");
});
