import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchedule, seedField } from "../src/draft/schedule.js";

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

// --- 13 WEEKS -------------------------------------------------------------------------------------
// The owner says the league plays 13 regular-season weeks with playoffs in 14/15/16. ESPN's stored
// settings for 2026 say 14 and 15/16/17. Until that is settled BOTH have to work, so the 13-week
// schedule gets the same invariants as the 14-week one -- and one extra, because the interesting
// question about 13 is where the odd cross-division game goes.

test("13 weeks: still a perfect matching, 13 games each, repeat cap held", () => {
  const { weeks, divisional } = buildSchedule(TEAMS, 13, 4);
  assert.ok(divisional, "16/4 must produce a divisional schedule at 13 weeks too");
  assert.equal(weeks.length, 13);
  const n = new Array(TEAMS).fill(0);
  const met: Record<string, number> = {};
  for (const [i, wk] of weeks.entries()) {
    assert.equal(wk.length, TEAMS / 2, `week ${i + 1} has ${wk.length} games`);
    assert.equal(new Set(wk.flat()).size, TEAMS, `week ${i + 1} does not cover every team once`);
    for (const [a, b] of wk) {
      assert.notEqual(a, b);
      n[a]++; n[b]++;
      const k = [a, b].sort((x, y) => x - y).join("-");
      met[k] = (met[k] ?? 0) + 1;
    }
  }
  for (const [t, c] of n.entries()) assert.equal(c, 13, `team ${t} plays ${c} games`);
  for (const [k, m] of Object.entries(met)) assert.ok(m <= 2, `pair ${k} meets ${m} times`);
});

test("13 weeks: the odd cross game is BALANCED -- 6 in-division, then 4 and 3 against two others", () => {
  const { weeks, divisionOf } = buildSchedule(TEAMS, 13, 4);
  const inDiv = new Array(TEAMS).fill(0);
  const byDiv: Record<number, Record<number, number>> = {};
  for (const wk of weeks) for (const [a, b] of wk) {
    if (divisionOf[a] === divisionOf[b]) { inDiv[a]++; inDiv[b]++; continue; }
    (byDiv[a] ??= {})[divisionOf[b]] = ((byDiv[a] ??= {})[divisionOf[b]] ?? 0) + 1;
    (byDiv[b] ??= {})[divisionOf[a]] = ((byDiv[b] ??= {})[divisionOf[a]] ?? 0) + 1;
  }
  for (let t = 0; t < TEAMS; t++) {
    assert.equal(inDiv[t], 6, `team ${t} has ${inDiv[t]} in-division games, want 6`);
    // Truncating to 13 drops one whole ROUND, and a round is a complete matching -- so every team
    // loses exactly one cross-division opponent, and the counts against the two divisions it does
    // face are 4 and 3 for EVERY team. If it dropped a game rather than a round, some team would
    // still be at 4/4 and another at 4/2, which is what this rules out.
    const counts = Object.values(byDiv[t] ?? {}).sort((a, b) => b - a);
    assert.deepEqual(counts, [4, 3], `team ${t} cross-division counts ${JSON.stringify(counts)}, want [4,3]`);
  }
});

// --- SEEDING ---------------------------------------------------------------------------------------

test("seedField record: wins, then points -- unchanged behaviour", () => {
  const order = [
    { wins: 9, pts: 100 }, { wins: 11, pts: 90 }, { wins: 9, pts: 120 }, { wins: 4, pts: 300 },
  ];
  assert.deepEqual(seedField(order, 3, "record"), [1, 2, 0]);
});

test("seedField division-winners-first: a division winner takes a seat off a better wildcard", () => {
  // Four divisions of one team each is degenerate; use 8 teams in 4 divisions of 2.
  //  t: 0    1    2    3    4    5    6    7
  //  d: 0    0    1    1    2    2    3    3
  const order = [
    { wins: 12, pts: 100 }, { wins: 11, pts: 100 },   // div 0: 0 wins the division, 1 is a strong wildcard
    { wins: 10, pts: 100 }, { wins: 9, pts: 100 },    // div 1
    { wins: 8, pts: 100 }, { wins: 7, pts: 100 },     // div 2
    { wins: 3, pts: 100 }, { wins: 2, pts: 100 },     // div 3: 6 wins it on 3-11 and is GUARANTEED a seed
  ];
  const divisionOf = [0, 0, 1, 1, 2, 2, 3, 3];
  // Record seeding takes the best four outright: 0,1,2,3 -- the 3-11 division winner misses.
  assert.deepEqual(seedField(order, 4, "record", divisionOf), [0, 1, 2, 3]);
  // Division-winners-first seats 0,2,4,6 first, so the 3-11 team is IN and the 11-win team is out.
  assert.deepEqual(seedField(order, 4, "division-winners-first", divisionOf), [0, 2, 4, 6]);
  // A wider field then fills by record behind the four winners.
  assert.deepEqual(seedField(order, 6, "division-winners-first", divisionOf), [0, 2, 4, 6, 1, 3]);
});

test("FAULT INJECTION: with one division the two rules cannot differ, and the code says so", () => {
  const order = [{ wins: 9, pts: 1 }, { wins: 11, pts: 1 }, { wins: 5, pts: 1 }, { wins: 7, pts: 1 }];
  const oneDiv = [0, 0, 0, 0];
  assert.deepEqual(
    seedField(order, 3, "division-winners-first", oneDiv),
    seedField(order, 3, "record", oneDiv),
    "with a single division the division rule must degrade to record, not invent a bracket",
  );
  // And the positive control: given TWO divisions on the same records it does something different,
  // so the equality above is a property of the input and not of a rule that never fires.
  assert.notDeepEqual(
    seedField(order, 2, "division-winners-first", [0, 0, 1, 1]),
    seedField(order, 2, "record", [0, 0, 1, 1]),
  );
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
