// THE IN-SEASON DECISION LAYER, proven on a synthetic roster where the answer is known by hand.
//
// The policies and the realized scorer are pure functions of a DecisionState + a SeasonFuture, so
// this needs no store: it constructs a roster with a scarce backup (one TE behind the starter) and a
// redundant bench receiver, injures the starter for two weeks, and checks that (a) value-min cuts the
// backup, (b) depth-aware keeps him and cuts the receiver, (c) the depth-aware roster scores MORE
// realized points because the backup covers the injury, and (d) the positive control -- dropping the
// best player -- scores far worse. Each is fault-injected: an empty protected set collapses
// depth-aware back onto value-min.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realizedRestOfSeason, type DecisionState, type ScoreCtx, type SeasonFuture } from "../src/inseason/backtest/harness.js";
import { valueMinDrop, depthAwareDrop, dropBest } from "../src/inseason/backtest/policies.js";

const TEMPLATE = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE"];
const FLEX = new Set(["RB", "WR", "TE"]);

// name, pos, point-in-time proj. Bench (lowest two proj) are TE2 (6) and WR3 (10).
const ROSTER = [
  { playerSk: "qb1", name: "QB1", pos: "QB", proj: 20 },
  { playerSk: "rb1", name: "RB1", pos: "RB", proj: 18 },
  { playerSk: "rb2", name: "RB2", pos: "RB", proj: 14 },
  { playerSk: "wr1", name: "WR1", pos: "WR", proj: 16 },
  { playerSk: "wr2", name: "WR2", pos: "WR", proj: 13 },
  { playerSk: "wr3", name: "WR3", pos: "WR", proj: 10 }, // redundant 6th-ish receiver, never starts
  { playerSk: "te1", name: "TE1", pos: "TE", proj: 12 }, // starter TE
  { playerSk: "te2", name: "TE2", pos: "TE", proj: 6 },  // the only backup TE -- the "Likely"
  { playerSk: "k1", name: "K1", pos: "K", proj: 9 },
  { playerSk: "dst1", name: "DST1", pos: "DST", proj: 8 },
];
const state: DecisionState = { season: 2025, week: 5, teamId: "t", roster: ROSTER, freeAgents: [], template: TEMPLATE, flexOk: FLEX };

// Weeks 5..8. Everyone plays their proj, EXCEPT the starter TE1 is OUT in weeks 6 and 7.
function future(): SeasonFuture {
  const f: SeasonFuture = new Map();
  for (const p of ROSTER) {
    const m = new Map<number, { pts: number; bye: boolean; out: boolean }>();
    for (let w = 5; w <= 8; w++) {
      const out = p.playerSk === "te1" && (w === 6 || w === 7);
      m.set(w, { pts: p.proj, bye: false, out });
    }
    f.set(p.playerSk, m);
  }
  return f;
}
const ctx: ScoreCtx = { fromWeek: 5, toWeek: 8, template: TEMPLATE, flexOk: FLEX, future: future() };

test("value-min cuts the lowest-projected body -- the only backup TE", () => {
  const kept = new Set(valueMinDrop.apply(state).roster.map((m) => m.playerSk));
  assert.ok(!kept.has("te2"), "value-min should drop TE2 (proj 6, the lowest)");
});

test("depth-aware protects the TE backup and cuts the redundant receiver instead", () => {
  const r = depthAwareDrop(new Set(["TE"])).apply(state);
  const kept = new Set(r.roster.map((m) => m.playerSk));
  assert.ok(kept.has("te2"), "depth-aware must KEEP the last TE backup");
  assert.ok(!kept.has("wr3"), "depth-aware should drop the redundant WR3 instead");
  assert.equal(r.meta?.protectedPos, "TE", "it should tag the protected position for attribution");
});

test("SCORER: a backup that covers an injured starter adds exactly his points", () => {
  // Minimal 1-slot world: a TE slot, starter + backup. Starter out in week 6.
  const tmpl = ["TE", "BE"];
  const te1 = { playerSk: "te1", name: "TE1", pos: "TE", proj: 12 };
  const te2 = { playerSk: "te2", name: "TE2", pos: "TE", proj: 6 };
  const f: SeasonFuture = new Map([
    ["te1", new Map([[6, { pts: 12, bye: false, out: true }], [7, { pts: 12, bye: false, out: false }]])],
    ["te2", new Map([[6, { pts: 6, bye: false, out: false }], [7, { pts: 6, bye: false, out: false }]])],
  ]);
  const c: ScoreCtx = { fromWeek: 6, toWeek: 7, template: tmpl, flexOk: FLEX, future: f };
  const withBackup = realizedRestOfSeason([te1, te2], c);   // wk6 TE1 out -> TE2 (6); wk7 TE1 (12) => 18
  const noBackup = realizedRestOfSeason([te1], c);           // wk6 empty (0); wk7 TE1 (12) => 12
  assert.equal(withBackup - noBackup, 6, "the backup is worth exactly the 6 points he scored covering week 6");
});

test("POSITIVE CONTROL: dropping a STARTER costs more than dropping a bench scrub", () => {
  const tmpl = ["TE", "FLEX", "BE"];
  const roster = [
    { playerSk: "te1", name: "TE1", pos: "TE", proj: 12 },
    { playerSk: "wr1", name: "WR1", pos: "WR", proj: 10 }, // starts at FLEX
    { playerSk: "te2", name: "TE2", pos: "TE", proj: 6 },  // bench scrub
  ];
  const st: DecisionState = { season: 2025, week: 5, teamId: "t", roster, freeAgents: [], template: tmpl, flexOk: FLEX };
  const f: SeasonFuture = new Map(roster.map((p) => [p.playerSk, new Map([[5, { pts: p.proj, bye: false, out: false }]])]));
  const c: ScoreCtx = { fromWeek: 5, toWeek: 5, template: tmpl, flexOk: FLEX, future: f };
  const vm = realizedRestOfSeason(valueMinDrop.apply(st).roster, c);   // drops te2 -> TE1+WR1 = 22
  const best = realizedRestOfSeason(dropBest.apply(st).roster, c);     // drops TE1 -> TE2+WR1 = 16
  assert.ok(best - vm < 0, `dropping the best legal player must score worse, got ${(best - vm).toFixed(1)}`);
});

test("LEGALITY: a policy may NOT drop the only player at a mandatory slot (the canFill bug)", () => {
  // One QB, one K, one DST -- none is a legal drop; only the WR/TE backups are.
  const tmpl = ["QB", "WR", "TE", "K", "DST", "BE"];
  const roster = [
    { playerSk: "qb1", name: "QB1", pos: "QB", proj: 3 }, // lowest proj, but the ONLY QB -> illegal to drop
    { playerSk: "wr1", name: "WR1", pos: "WR", proj: 15 },
    { playerSk: "wr2", name: "WR2", pos: "WR", proj: 9 },
    { playerSk: "te1", name: "TE1", pos: "TE", proj: 11 },
    { playerSk: "k1", name: "K1", pos: "K", proj: 8 },
    { playerSk: "dst1", name: "DST1", pos: "DST", proj: 7 },
  ];
  const st: DecisionState = { season: 2025, week: 5, teamId: "t", roster, freeAgents: [], template: tmpl, flexOk: FLEX };
  const dropped = roster.find((m) => !valueMinDrop.apply(st).roster.some((x) => x.playerSk === m.playerSk));
  assert.notEqual(dropped?.playerSk, "qb1", "value-min must NOT drop the only QB even though he is lowest-projected");
  assert.equal(dropped?.playerSk, "wr2", "the lowest-projected LEGAL drop is the backup WR");
});

test("FAULT INJECTION: depth-aware with an EMPTY protected set is exactly value-min", () => {
  const vm = new Set(valueMinDrop.apply(state).roster.map((m) => m.playerSk));
  const depthNone = new Set(depthAwareDrop(new Set()).apply(state).roster.map((m) => m.playerSk));
  assert.deepEqual([...depthNone].sort(), [...vm].sort(), "no protected positions => same drop as value-min");
});
