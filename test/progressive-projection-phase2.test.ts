// PHASE 2 -- the PROGRESSIVE PROJECTOR, proven on a synthetic store where the role trend is known.
//
// Endpoints that must hold by design (fault-injected):
//   - alpha = 0 collapses to the frozen line for EVERY player (knob-off identity).
//   - too few games -> frozen line (no trending on 1 game).
//   - flat role -> multiplier 1 -> frozen line.
//   - rising role -> projection ABOVE the frozen line; falling role -> BELOW.
//   - a non-skill position (K) is never adjusted.
//   - the caps bound the multiplier even on an explosive role emergence.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeProgressiveProjector } from "../src/inseason/backtest/progressive.js";
import type { DecisionMember } from "../src/inseason/backtest/harness.js";
import type { DB } from "../src/db/db.js";

const mem = (sk: string, pos: string): DecisionMember => ({ playerSk: sk, name: sk, pos, proj: 10 });

// weeks 1..5 snap shares for four backs: rising, flat, falling, emerging (0 -> huge).
function cleanDb(): DB {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE player_xref (player_sk INTEGER, source TEXT, source_id TEXT);
    CREATE TABLE raw_snap_count (season INTEGER, week INTEGER, game_type TEXT, pfr_player_id TEXT, offense_pct REAL);
    CREATE TABLE raw_participation (season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, pass_plays INTEGER, team_pass_plays INTEGER);
  `);
  const xref = d.prepare("INSERT INTO player_xref VALUES (?,'pfr',?)");
  const snap = d.prepare("INSERT INTO raw_snap_count VALUES (2023, ?, 'REG', ?, ?)");
  const series: [number, string, number[]][] = [
    [10, "RISE", [0.2, 0.2, 0.3, 0.7, 0.8]],
    [20, "FLAT", [0.6, 0.6, 0.6, 0.6, 0.6]],
    [30, "FALL", [0.8, 0.8, 0.5, 0.2, 0.1]],
    [40, "EMERGE", [0, 0, 0, 0, 0.9]],
  ];
  for (const [sk, id, roles] of series) { xref.run(sk, id); roles.forEach((r, i) => snap.run(i + 1, id, r)); }
  return d as unknown as DB;
}

test("alpha = 0 returns the frozen line for every player (knob-off identity)", () => {
  const proj = makeProgressiveProjector(cleanDb(), { alpha: 0 });
  for (const sk of ["10", "20", "30", "40"]) assert.equal(proj(mem(sk, "RB"), 2023, 6), 10);
});

test("too few games -> frozen line", () => {
  const proj = makeProgressiveProjector(cleanDb(), { alpha: 1, minGames: 2 });
  assert.equal(proj(mem("10", "RB"), 2023, 2), 10, "at week 2 only 1 prior game -> no trend");
});

test("flat role -> multiplier 1 -> frozen line", () => {
  const proj = makeProgressiveProjector(cleanDb(), { alpha: 1 });
  assert.ok(Math.abs(proj(mem("20", "RB"), 2023, 6) - 10) < 1e-9, "recent == to-date -> unchanged");
});

test("rising role lifts the projection above the frozen line; falling role sinks it", () => {
  const proj = makeProgressiveProjector(cleanDb(), { alpha: 1 });
  assert.ok(proj(mem("10", "RB"), 2023, 6) > 10.5, "RISE must project above the frozen 10");
  assert.ok(proj(mem("30", "RB"), 2023, 6) < 9.5, "FALL must project below the frozen 10");
});

test("alpha damps the move: half-alpha is between frozen and full-alpha", () => {
  const full = makeProgressiveProjector(cleanDb(), { alpha: 1 })(mem("10", "RB"), 2023, 6);
  const half = makeProgressiveProjector(cleanDb(), { alpha: 0.5 })(mem("10", "RB"), 2023, 6);
  assert.ok(half > 10 && half < full, "alpha=0.5 sits strictly between frozen (10) and alpha=1");
});

test("caps bound an explosive role emergence", () => {
  const proj = makeProgressiveProjector(cleanDb(), { alpha: 1, hi: 2.0 });
  assert.ok(proj(mem("40", "RB"), 2023, 6) <= 20 + 1e-9, "0 -> 0.9 role must be capped at hi*proj = 20");
});

test("a non-skill position is never adjusted", () => {
  const proj = makeProgressiveProjector(cleanDb(), { alpha: 1 });
  assert.equal(proj({ playerSk: "10", name: "K", pos: "K", proj: 10 }, 2023, 6), 10, "K is not role-driven");
});
