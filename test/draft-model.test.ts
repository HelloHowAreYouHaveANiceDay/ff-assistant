// THE DRAFT SEAM (WP11). Two properties, and they are the two that make the seam safe:
//   1. `AuctionModel` is the incumbent, wrapped -- the same picks, in the same order, in the same
//      seats, for the same seed. (The other half of that proof is the golden line itself, which
//      docs/validation.md records before and after.)
//   2. A draft type with no model is a NAMED refusal, never a silent auction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuctionModel, SnakeModel, draftModelFor, draftRounds, serpentineOrder, SNAKE_IGNORED_LEVERS } from "../src/draft/draftModel.ts";
import { draftField, SIM_LEAGUE } from "../src/draft/sim.ts";
import { computeValues, resolveValueLeague, type PointsRow } from "../src/draft/values.ts";

function pool(): PointsRow[] {
  const rows: PointsRow[] = [];
  const shape: [string, number, number, number][] = [
    ["QB", 26, 380, 9], ["RB", 60, 300, 4], ["WR", 70, 295, 3.5], ["TE", 26, 210, 5],
    ["K", 20, 130, 2], ["DST", 20, 120, 2],
  ];
  for (const [pos, n, top, step] of shape) {
    for (let i = 0; i < n; i++) rows.push({ name: `${pos}${i + 1}`, pos, points: top - i * step });
  }
  return rows;
}

test("AuctionModel is `draftField`, wrapped: identical seats and pick order", () => {
  const pts = pool();
  const ours = new Map(computeValues(pts, resolveValueLeague(SIM_LEAGUE), 2).map((v) => [v.name, v.value]));
  const cfg = { starterReserve: 4, benchDiscount: 0.25, aggr: 0.7, maxShare: 0.25 };
  for (const seed of [1, 7, 12345]) {
    const picks = draftField(pts, ours, cfg, seed, SIM_LEAGUE, {});
    const direct: string[][] = Array.from({ length: SIM_LEAGUE.teams }, () => []);
    for (const p of picks) direct[p.team].push(p.name);
    const viaModel = AuctionModel.runDraft(pts, SIM_LEAGUE, {}, { values: ours, cfg }, seed)
      .map((t) => t.map((p) => p.name));
    assert.deepEqual(viaModel, direct, `seed ${seed}: the wrapper must not move a single pick`);
  }
});

test("a draft type with no model is a named refusal", () => {
  assert.equal(draftModelFor("auction"), AuctionModel);
  assert.equal(draftModelFor("snake"), SnakeModel);
  assert.throws(() => draftModelFor("linear"), /no DraftModel for draft type "linear"/);
});

test("rounds exclude IR but include the bench; the order serpentines", () => {
  // Yahoo 129048: 19 slots, two of them IR -> 17 rounds.
  const yahoo = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX",
    "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"];
  assert.equal(draftRounds(yahoo), 17);
  assert.equal(draftRounds(SIM_LEAGUE.slots), 12);      // ESPN: no IR slot, so every slot is a round
  const o = serpentineOrder(4, 3);
  assert.deepEqual(o, [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]);
  // every seat picks exactly once per round
  for (let r = 0; r < 3; r++) assert.equal(new Set(o.slice(r * 4, r * 4 + 4)).size, 4);
});

test("the levers a snake ignores are NAMED, so a sweep cannot quietly measure a dead one", () => {
  for (const k of ["aggr", "maxShare", "starterReserve", "inflation"]) {
    assert.ok((SNAKE_IGNORED_LEVERS as readonly string[]).includes(k), `${k} must be declared snake-inert`);
  }
});
