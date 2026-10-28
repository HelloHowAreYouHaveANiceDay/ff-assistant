/**
 * "bench X out-projects a starter -- roster-slot constrained" must compare X only with starters in
 * slots X could fill. It once compared with the weakest starter at ANY slot, so a bench WR beating
 * the D/ST or kicker was flagged (week 8 2026: Bo Nix, Garrett Wilson, Jonah Coleman all flagged
 * against a 6.4-point D/ST), and the news-watch agent read it as "Wilson is on our bench".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalLineup, type RosterPlayer } from "../src/inseason/lineup.js";

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
const p = (name: string, pos: string, proj: number, extra: Partial<RosterPlayer> = {}): RosterPlayer =>
  ({ name, pos, proj, available: true, ...extra } as RosterPlayer);

const WEEK8 = [
  p("Goff", "QB", 18.2), p("Nix", "QB", 15.51),
  p("Allen", "RB", 12.71), p("Coleman", "RB", 7.08), p("Hall", "RB", 5),
  p("St. Brown", "WR", 15.56), p("J. Williams", "WR", 12.5), p("Bernard", "WR", 11.52), p("Wilson", "WR", 11.04),
  p("Loveland", "TE", 11.65), p("TEN D/ST", "DST", 6.36), p("Shrader", "K", 6.49),
];

test("a bench man who beats only the K/D/ST is not flagged as slot-constrained", () => {
  const r = optimalLineup(WEEK8, SLOTS, ["RB", "WR", "TE"]);
  assert.ok(r.bench.some((b) => b.name === "Wilson"));
  const bad = r.flags.filter((f) => /out-projects a starter/.test(f));
  assert.deepEqual(bad, [], `flags: ${r.flags.join(" | ")}`);
});

test("a bench man blocked by a locked starter at his own position IS flagged", () => {
  const roster = WEEK8.map((x) => x.name === "Bernard" ? { ...x, proj: 3, locked: true, lockedSlot: "FLEX" } as RosterPlayer : x);
  const r = optimalLineup(roster, SLOTS, ["RB", "WR", "TE"]);
  assert.ok(r.flags.some((f) => /bench Wilson .*out-projects a starter/.test(f)), `flags: ${r.flags.join(" | ")}`);
});
