import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSettingsRows } from "../src/league/settingsDom.js";

/**
 * VERBATIM ROWS captured from this league's rendered settings page on 2026-09-09, tabs and all.
 * They are the real strings rather than a tidied-up fixture, because the whole point of this parser
 * is that the DOM carries what the API does not -- a fixture written to suit the parser would prove
 * nothing about the page.
 */
const ROWS = [
  "League Name\n\t\nseacaptaindate.com",
  "Number of Teams\n\t\n16",
  "Roster Size\n\t\n12",
  "Total Starters\n\t\n8",
  "Total on Bench\n\t\n4",
  "POSITION\tSTARTERS\tMAXIMUMS",
  "Quarterback (QB)\n\t\n1\n\t\n4",
  "Team Quarterback (TQB)\n\t\n0\n\t\nNo Limit",
  "Running Back (RB)\n\t\n1\n\t\n8",
  "Running Back/Wide Receiver (RB/WR)\n\t\n0\n\t\nN/A",
  "Wide Receiver (WR)\n\t\n1\n\t\n8",
  "Tight End (TE)\n\t\n1\n\t\n3",
  "Flex (FLEX)\n\t\n2\n\t\nN/A",
  "Passing Yards (PY)\n0.04",
  "Each reception (REC)\n0.5",
  "FG Made (50-59 yards) (FG50)\n5",
  "7-13 points allowed (PA7)\n-1",
  "14-17 points allowed (PA14)\n-2",
  "18-21 points allowed (PA18)\n-3",
  "22-27 points allowed (PA22)\n-4",
  "28-34 points allowed (PA28)\n-5",
  "35-45 points allowed (PA35)\n-6",
  "46+ points allowed (PA46)\n-7",
];

test("position maximums are read, and 'No Limit'/'N/A' is not read as a number", () => {
  const s = parseSettingsRows(ROWS);
  assert.deepEqual(s.posMax, { QB: 4, RB: 8, WR: 8, TE: 3 });
  assert.equal(s.posMax.TQB, undefined, "'No Limit' must be absent, not 0 -- zero would forbid the slot");
  assert.equal(s.posMax.FLEX, undefined, "'N/A' must be absent, not 0");
  assert.equal(s.starters.FLEX, 2, "starters are still read for a slot with no maximum");
});

test("the points-allowed ladder is rebuilt, including the tier ESPN omits", () => {
  const s = parseSettingsRows(ROWS);
  // ESPN lists no 0 and no 1-6 row, because both score nothing. The lowest LISTED tier starts at 7,
  // so everything up to 6 scores zero and that has to be explicit or a shutout falls through to -1.
  assert.deepEqual(s.paLadder, [[6, 0], [13, -1], [17, -2], [21, -3], [27, -4], [34, -5], [45, -6], [null, -7]]);
});

test("the parsed ladder matches the derived default this repo has been using", async () => {
  const { DEFAULT_DEFENSE } = await import("../src/draft/scoring.js");
  const s = parseSettingsRows(ROWS);
  const normalise = (l: [number | null, number][]) => l.map(([a, b]) => [a === Infinity ? null : a, b]);
  assert.deepEqual(normalise(s.paLadder), normalise(DEFAULT_DEFENSE.paLadder as [number | null, number][]),
    "the default was derived from 175 scored DST weeks; the page is the primary source and they agree");
});

test("scoring values are picked up for cross-checking the API", () => {
  const s = parseSettingsRows(ROWS);
  assert.equal(s.scoring.PY, 0.04);
  assert.equal(s.scoring.REC, 0.5);
  assert.equal(s.scoring.FG50, 5);
});

test("flat settings are captured under the page's own labels", () => {
  const s = parseSettingsRows(ROWS);
  assert.equal(s.misc["Roster Size"], "12");
  assert.equal(s.misc["Total Starters"], "8");
  assert.equal(s.misc["Number of Teams"], "16");
});

// FAULT INJECTION. A parser that quietly returns empty on an unrecognised page is worse than one
// that returns nothing at all, because "no maximums" and "no limits in this league" look identical
// downstream. These assert the empty case is reachable and distinguishable.
test("FAULT INJECTION: a page with no settings rows yields empty, not invented, values", () => {
  const s = parseSettingsRows(["Some Heading", "", "unrelated\ttext\there"]);
  assert.deepEqual(s.posMax, {});
  assert.deepEqual(s.paLadder, [], "an empty ladder must stay empty rather than defaulting");
});

test("FAULT INJECTION: changing a maximum on the page changes the parse", () => {
  const altered = ROWS.map((r) => r.startsWith("Tight End") ? "Tight End (TE)\n\t\n1\n\t\n9" : r);
  assert.equal(parseSettingsRows(altered).posMax.TE, 9, "the parser is not returning a hardcoded table");
});
