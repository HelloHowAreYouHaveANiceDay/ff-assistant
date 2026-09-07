import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchedule } from "../src/draft/schedule.js";

// A malformed schedule still RUNS -- the backtest would happily play it and report a championship
// rate. So these assert the invariants that distinguish a real schedule from a plausible-looking
// one: a perfect matching every week, a repeat cap, and the divisional structure actually present.

const TEAMS = 16, WEEKS = 14;

test("every week is a PERFECT MATCHING: all 16 teams play exactly once", () => {
  const { weeks } = buildSchedule(TEAMS, WEEKS, 4);
  assert.equal(weeks.length, WEEKS);
  for (const [i, wk] of weeks.entries()) {
    assert.equal(wk.length, TEAMS / 2, `week ${i + 1} has ${wk.length} games`);
    const seen = wk.flat();
    assert.equal(new Set(seen).size, TEAMS, `week ${i + 1} does not cover every team exactly once`);
  }
});

test("no team ever plays ITSELF", () => {
  const { weeks } = buildSchedule(TEAMS, WEEKS, 4);
  for (const wk of weeks) for (const [a, b] of wk) assert.notEqual(a, b);
});

test("every team plays exactly 14 games", () => {
  const { weeks } = buildSchedule(TEAMS, WEEKS, 4);
  const n = new Array(TEAMS).fill(0);
  for (const wk of weeks) for (const [a, b] of wk) { n[a]++; n[b]++; }
  for (const [t, c] of n.entries()) assert.equal(c, WEEKS, `team ${t} plays ${c}`);
});

test("standard divisional play: 6 in-division games, each rival exactly twice", () => {
  const { weeks, divisionOf, divisional } = buildSchedule(TEAMS, WEEKS, 4);
  assert.ok(divisional, "16/4 must produce a divisional schedule");
  const met: Record<number, Record<number, number>> = {};
  for (const wk of weeks) for (const [a, b] of wk) {
    (met[a] ??= {})[b] = ((met[a] ??= {})[b] ?? 0) + 1;
    (met[b] ??= {})[a] = ((met[b] ??= {})[a] ?? 0) + 1;
  }
  for (let t = 0; t < TEAMS; t++) {
    const rivals = [...Array(TEAMS).keys()].filter((x) => x !== t && divisionOf[x] === divisionOf[t]);
    assert.equal(rivals.length, 3, `team ${t} should have 3 division rivals`);
    for (const r of rivals) assert.equal(met[t][r], 2, `team ${t} plays rival ${r} ${met[t][r]}x, want 2`);
    const inDiv = rivals.reduce((s, r) => s + met[t][r], 0);
    assert.equal(inDiv, 6, `team ${t} has ${inDiv} in-division games`);
  }
});

test("REPEAT CAP: nobody is played more than twice -- the thing random pairing got wrong", () => {
  const { weeks } = buildSchedule(TEAMS, WEEKS, 4);
  const met: Record<string, number> = {};
  for (const wk of weeks) for (const [a, b] of wk) {
    const k = [a, b].sort((x, y) => x - y).join("-");
    met[k] = (met[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(met)) assert.ok(n <= 2, `pair ${k} meets ${n} times`);
});

test("cross-division: 8 games against exactly two other divisions, one unplayed", () => {
  const { weeks, divisionOf } = buildSchedule(TEAMS, WEEKS, 4);
  const byDiv: Record<number, Record<number, number>> = {};
  for (const wk of weeks) for (const [a, b] of wk) {
    if (divisionOf[a] === divisionOf[b]) continue;
    (byDiv[a] ??= {})[divisionOf[b]] = ((byDiv[a] ??= {})[divisionOf[b]] ?? 0) + 1;
    (byDiv[b] ??= {})[divisionOf[a]] = ((byDiv[b] ??= {})[divisionOf[a]] ?? 0) + 1;
  }
  for (let t = 0; t < TEAMS; t++) {
    const counts = byDiv[t] ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 8, `team ${t} has ${total} cross-division games`);
    const played = Object.entries(counts).filter(([, n]) => n > 0);
    assert.equal(played.length, 2, `team ${t} faces ${played.length} other divisions, want 2`);
    for (const [d, n] of played) assert.equal(n, 4, `team ${t} plays division ${d} ${n}x, want 4`);
  }
});

// POSITIVE CONTROL. Every assertion above passes on the real schedule; none of them means anything
// until the OLD behaviour is shown to fail them. This reproduces backtest.ts's former weekly
// Fisher-Yates reshuffle and asserts it violates exactly the invariants the new schedule holds --
// so these tests can tell a real schedule from a plausible-looking one, rather than passing on both.
test("CONTROL: the old random weekly pairing FAILS the repeat cap and divisional structure", () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const met: Record<string, number> = {};
  const inDiv = new Array(TEAMS).fill(0);
  const divisionOf = [...Array(TEAMS).keys()].map((t) => Math.floor(t / 4));
  for (let w = 0; w < WEEKS; w++) {
    const order = [...Array(TEAMS).keys()];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let i = 0; i < TEAMS; i += 2) {
      const a = order[i], b = order[i + 1];
      met[[a, b].sort((x, y) => x - y).join("-")] = (met[[a, b].sort((x, y) => x - y).join("-")] ?? 0) + 1;
      if (divisionOf[a] === divisionOf[b]) { inDiv[a]++; inDiv[b]++; }
    }
  }
  const worstRepeat = Math.max(...Object.values(met));
  assert.ok(worstRepeat > 2, `random pairing should exceed the 2-game repeat cap, saw max ${worstRepeat}`);
  assert.ok(new Set(inDiv).size > 1, "random pairing should give teams DIFFERENT in-division counts");
  assert.ok(!inDiv.every((n) => n === 6), "random pairing should not produce the standard 6 in-division games");
});

test("FALLBACK: a non-16/4 league still gets a valid schedule, flagged non-divisional", () => {
  for (const teams of [10, 12, 14]) {
    const { weeks, divisional } = buildSchedule(teams, 13, 0);
    assert.equal(divisional, false);
    assert.equal(weeks.length, 13);
    for (const wk of weeks) {
      const seen = wk.flat();
      assert.equal(new Set(seen).size, seen.length, `${teams}-team week repeats a team`);
      for (const [a, b] of wk) assert.notEqual(a, b);
    }
  }
});
