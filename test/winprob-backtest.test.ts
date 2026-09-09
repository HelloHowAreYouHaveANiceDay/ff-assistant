/**
 * THE REPLAY'S ARITHMETIC: the two pieces of `backtest/winprobLineup.ts` that decide what a number
 * means, tested where they can be tested hermetically.
 *
 * The replay itself runs against the real store (scripts/winprob-backtest.mjs, reported in
 * docs/validation.md). What is testable here is (a) that the fallback SHAPE is a measurement of the
 * data it is handed rather than a constant somebody typed, and (b) that the interval quoted beside
 * the headline is a SEASON-level one -- because a row-level interval over 1,876 correlated team-weeks
 * is roughly sqrt(1876/8) times too tight, and it would turn every result of this replay into a
 * significant finding whether or not it was one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { positionShapes, seasonBootstrapWins } from "../src/inseason/backtest/winprobLineup.js";

const projRow = (pos: string, mean: number, k: { p10: number; p50: number; p90: number; pZero?: number }) =>
  ({ pos, mean, p10: mean * k.p10, p50: mean * k.p50, p90: mean * k.p90, ...(k.pZero == null ? {} : { pZero: k.pZero }) });

test("positionShapes MEASURES the shape it is handed, position by position", () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => projRow("WR", 5 + i, { p10: 0.2, p50: 0.8, p90: 2.1, pZero: 0.12 })),
    ...Array.from({ length: 9 }, (_, i) => projRow("QB", 12 + i, { p10: 0.6, p50: 0.98, p90: 1.4, pZero: 0.03 })),
  ];
  const s = positionShapes(rows);
  assert.ok(Math.abs(s.get("WR")!.p10 - 0.2) < 1e-9);
  assert.ok(Math.abs(s.get("WR")!.p90 - 2.1) < 1e-9);
  assert.ok(Math.abs(s.get("QB")!.p10 - 0.6) < 1e-9, "the two positions were pooled, so a quarterback would be given a receiver's shape");
  assert.ok(Math.abs(s.get("QB")!.pZero - 0.03) < 1e-9);
});

test("a position with too few rows gets NO shape rather than a made-up one", () => {
  const s = positionShapes(Array.from({ length: 4 }, () => projRow("DST", 7, { p10: 0.1, p50: 0.9, p90: 2.0 })));
  assert.equal(s.get("DST"), undefined, "four rows are not a distribution, and a shape derived from them reads exactly like a measured one");
});

test("a zero or negative mean cannot enter the shape -- the ratio is undefined there", () => {
  const rows = [
    ...Array.from({ length: 8 }, () => projRow("TE", 6, { p10: 0.25, p50: 0.85, p90: 2.0 })),
    { pos: "TE", mean: 0, p10: 0, p50: 0, p90: 0 },
  ];
  const s = positionShapes(rows);
  assert.ok(Math.abs(s.get("TE")!.p50 - 0.85) < 1e-9);
});

test("the bootstrap recovers a known constant difference exactly, with a zero-width interval", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ season: 2018 + (i % 8), wpWin: 1, epWin: 0.98 }));
  const b = seasonBootstrapWins(rows);
  assert.equal(b.seasons, 8);
  assert.ok(Math.abs(b.meanPp - 2) < 1e-6, `mean ${b.meanPp}`);
  assert.ok(Math.abs(b.hiPp - b.loPp) < 1e-6, "a difference that is identical in every season cannot have a spread");
});

test("FAULT INJECTION: two identical lineups produce exactly zero, and an interval that says so", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ season: 2018 + (i % 8), wpWin: i % 3 === 0 ? 1 : 0, epWin: i % 3 === 0 ? 1 : 0 }));
  const b = seasonBootstrapWins(rows);
  assert.equal(b.meanPp, 0);
  assert.equal(b.loPp, 0);
  assert.equal(b.hiPp, 0);
});

test("THE INTERVAL IS SEASON-LEVEL: resampling seasons, not team-weeks", () => {
  // Eight seasons, each internally constant, but wildly different from one another: four at +10pp
  // and four at -10pp. The season-level interval must be WIDE, because the eight-season mean really
  // is uncertain. A team-week bootstrap over the same 1,600 rows would report an interval of about
  // +/-1pp -- it would see 1,600 independent draws where there are eight -- and would declare this
  // noise a finding.
  const rows: { season: number; wpWin: number; epWin: number }[] = [];
  for (let s = 0; s < 8; s++) {
    const up = s < 4;
    for (let i = 0; i < 200; i++) rows.push({ season: 2018 + s, wpWin: up ? 1 : 0, epWin: up ? 0.9 : 0.1 });
  }
  const b = seasonBootstrapWins(rows);
  assert.ok(Math.abs(b.meanPp - 0) < 1e-6, `mean ${b.meanPp}`);
  assert.ok(b.hiPp - b.loPp > 10, `the interval is ${b.hiPp - b.loPp}pp wide; a season-level bootstrap of four +10s and four -10s cannot be that tight, so it is resampling rows`);
  assert.ok(b.loPp < -3 && b.hiPp > 3);
});

test("P(>0) is read off the SAME draws as the interval, not computed separately", () => {
  const rows = Array.from({ length: 800 }, (_, i) => ({ season: 2018 + (i % 8), wpWin: 1, epWin: 0.95 }));
  const b = seasonBootstrapWins(rows);
  assert.equal(b.pGreaterZero, 1, "every draw of a uniformly positive difference must be positive");
  assert.ok(b.loPp > 0);
});
