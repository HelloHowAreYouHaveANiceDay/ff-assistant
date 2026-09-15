// aggregatePbp -- the PURE play-by-play -> player-week rollup. Tested on synthetic plays with known
// answers, no network and no db. The point of these assertions is fault injection: each situational
// bucket has at least one play that MUST be excluded from it (a non-red-zone carry, an incomplete
// target, a wrong-week row), so a rollup that over-counts fails rather than reads plausibly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregatePbp } from "../src/data/rawSources.js";

// One synthetic play. Absent columns default to "" -- exactly how a sparse pbp row looks.
type Play = Record<string, string>;
const play = (p: Partial<Record<string, string | number>>): Play => {
  const o: Play = {};
  for (const [k, v] of Object.entries(p)) o[k] = String(v);
  return o;
};

test("aggregatePbp rolls rushing opportunity with correct red-zone buckets", () => {
  const rows = [
    // R1: goal-line carry inside the 5, in the red zone, goal-to-go
    play({ week: 1, game_id: "G1", posteam: "KC", rush_attempt: 1, rusher_player_id: "R1", rusher_player_name: "Rusher One", yardline_100: 3, yards_gained: 2, epa: 0.5, goal_to_go: 1 }),
    // R1: midfield carry that converts a first down -- MUST NOT count in any red-zone bucket
    play({ week: 1, game_id: "G1", posteam: "KC", rush_attempt: 1, rusher_player_id: "R1", yardline_100: 50, yards_gained: 8, epa: 0.3, first_down_rush: 1 }),
    // R1: 4-yard TD run, goal-to-go, inside the 5
    play({ week: 1, game_id: "G1", posteam: "KC", rush_attempt: 1, rusher_player_id: "R1", yardline_100: 4, yards_gained: 4, rush_touchdown: 1, goal_to_go: 1 }),
  ];
  const a = aggregatePbp(rows).get("1|R1")!;
  assert.equal(a.carries, 3);
  assert.equal(a.rushYds, 14);
  assert.equal(a.rushTds, 1);
  assert.equal(a.rushFd, 1);
  assert.equal(a.rzCarries, 2, "only the yl<=20 carries");
  assert.equal(a.i10Carries, 2);
  assert.equal(a.i5Carries, 2);
  assert.equal(a.gtgCarries, 2);
  assert.ok(Math.abs(a.rushEpa - 0.8) < 1e-9);
  assert.equal(a.team, "KC");
  assert.equal(a.name, "Rusher One");
});

test("aggregatePbp rolls targets, receptions and passer, splitting complete vs incomplete", () => {
  const rows = [
    // W1 end-zone TD catch; Q1 throws it
    play({ week: 1, game_id: "G1", posteam: "KC", pass_attempt: 1, receiver_player_id: "W1", receiver_player_name: "Wideout One", passer_player_id: "Q1", passer_player_name: "Quarterback One", yardline_100: 8, air_yards: 8, complete_pass: 1, yards_gained: 8, pass_touchdown: 1, first_down_pass: 1 }),
    // W1 incomplete deep shot -- a target but NOT a reception, and not red-zone
    play({ week: 1, game_id: "G1", posteam: "KC", pass_attempt: 1, receiver_player_id: "W1", passer_player_id: "Q1", yardline_100: 30, air_yards: 12, complete_pass: 0 }),
  ];
  const agg = aggregatePbp(rows);
  const w = agg.get("1|W1")!;
  assert.equal(w.targets, 2);
  assert.equal(w.receptions, 1, "the incomplete is a target, not a reception");
  assert.equal(w.recYds, 8);
  assert.equal(w.recTds, 1);
  assert.equal(w.recFd, 1);
  assert.equal(w.airYards, 20, "air yards accrue on the target whether or not it is caught");
  assert.equal(w.rzTargets, 1, "yl=30 target excluded");
  assert.equal(w.i10Targets, 1);
  assert.equal(w.ezTargets, 1, "air_yards 8 >= yardline 8 reaches the goal line; the 12/30 shot does not");
  const q = agg.get("1|Q1")!;
  assert.equal(q.passAtt, 2);
  assert.equal(q.completions, 1);
  assert.equal(q.passYds, 8);
  assert.equal(q.passTds, 1);
  assert.equal(q.passAirYards, 20);
  assert.equal(q.rzPassAtt, 1);
});

test("aggregatePbp keeps weeks separate and drops rows with no week", () => {
  const rows = [
    play({ week: 1, game_id: "G1", posteam: "KC", rush_attempt: 1, rusher_player_id: "R1", yards_gained: 5 }),
    play({ week: 19, game_id: "GP", posteam: "KC", rush_attempt: 1, rusher_player_id: "R1", yards_gained: 3 }), // POST week -> its own key
    play({ week: "", game_id: "GX", posteam: "KC", rush_attempt: 1, rusher_player_id: "R1", yards_gained: 99 }), // no week -> dropped
  ];
  const agg = aggregatePbp(rows);
  assert.equal(agg.get("1|R1")!.rushYds, 5);
  assert.equal(agg.get("19|R1")!.rushYds, 3);
  assert.equal(agg.size, 2, "the weekless row must not create a phantom player-week");
});

test("aggregatePbp does not count a play that is neither a rush nor a pass attempt", () => {
  // A kneel / spike / penalty play: no rush_attempt, no pass_attempt. A dual-role RB id is present as a
  // rusher on ANOTHER play only. Here nothing should accrue.
  const rows = [
    play({ week: 1, game_id: "G1", posteam: "KC", rusher_player_id: "R1", yards_gained: -1 }), // rush_attempt absent
  ];
  assert.equal(aggregatePbp(rows).size, 0);
});
