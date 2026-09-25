/**
 * `uncapBands` -- the clamped-ratio band rebuilt from peers (src/weekly/projector.ts, 2026-09-25).
 * Contracts: a row whose p90 is pinned at line x clampHi gets a WIDER band shaped like its uncapped
 * trained-range peers; an uncapped row is returned untouched; mean and p50 never move; knots are
 * dropped only on rebuilt rows; too few peers leaves the row as served.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { uncapBands, type WeeklyProjRow } from "../src/weekly/projector.js";

const row = (k: string, mean: number, p10: number, p50: number, p90: number): WeeklyProjRow =>
  ({ feat_key: k, player_sk: k, name: k, pos: "RB", season: 2026, week: 3, mean, p10, p50, p90, pZero: 0.05, knots: { u: [0.5], v: [p50] } });

function batch() {
  const rows: WeeklyProjRow[] = [], lineOf = new Map<string, number>();
  // 30 trained-range peers (line 5), band shape p10 = 0.2 x mean, p90 = 2.0 x mean
  for (let i = 0; i < 30; i++) { const m = 3 + i * 0.1; rows.push(row(`peer${i}`, m, 0.2 * m, 0.9 * m, 2.0 * m)); lineOf.set(`peer${i}`, 5); }
  // a capped fringe back: line 0.9, ratio pinned at 4 -> p90 = 3.6, mean 3.4 (the Jonah Coleman shape)
  rows.push(row("capped", 3.4, 2.1, 3.3, 3.6)); lineOf.set("capped", 0.9);
  return { rows, lineOf };
}

test("a capped row is rebuilt from its peers' shape; mean and p50 are untouched; knots dropped", () => {
  const { rows, lineOf } = batch();
  const out = uncapBands(rows, lineOf, 4);
  const c = out.find((r) => r.feat_key === "capped")!;
  assert.equal(c.mean, 3.4); assert.equal(c.p50, 3.3);
  assert.ok(Math.abs(c.p90 - 3.4 * 2.0) < 1e-9, `p90 ${c.p90}`);
  assert.ok(Math.abs(c.p10 - 3.4 * 0.2) < 1e-9, `p10 ${c.p10}`);
  assert.equal(c.bandUncapped, true);
  assert.equal(c.knots, undefined);
});

test("uncapped rows are returned byte-identical, and a thin peer set leaves a capped row as served", () => {
  const { rows, lineOf } = batch();
  const out = uncapBands(rows, lineOf, 4);
  for (let i = 0; i < 30; i++) assert.strictEqual(out[i], rows[i]);
  const thin = uncapBands(rows.slice(25), lineOf, 4);   // 5 peers + the capped row
  assert.strictEqual(thin.find((r) => r.feat_key === "capped"), rows[30]);
});

test("the rebuild never NARROWS a band the model served", () => {
  const { rows, lineOf } = batch();
  rows[30] = row("capped", 3.4, 0.1, 3.3, 3.6 * 10);     // already wider than the peers' shape, but pinned
  lineOf.set("capped", 0.9);
  const c = uncapBands(rows, lineOf, 10).find((r) => r.feat_key === "capped")!;
  assert.ok(c.p90 >= 36 - 1e-9 && c.p10 <= 0.1 + 1e-9);
});
