import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreWeek, scoreKickerWeek, scoreDefenseWeek, scoringFromEspn,
  DEFAULT_LEAGUE_SCORING, DEFAULT_SCORING, DEFAULT_KICKER, DEFAULT_DEFENSE,
} from "../src/draft/scoring.js";

// "League-driven" is a CLAIM until a different league's rules demonstrably produce different
// numbers. Each test below feeds the SAME raw stat line through two different models and asserts
// the output moves. If any of the three sub-models were ignored -- which is exactly what happened
// to kicker and defense, where history.ts called the scorers with no rules argument at all -- the
// corresponding test fails instead of the pipeline silently scoring by our own league's book.

const row = (o: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) as Record<string, string>;

test("OFFENCE responds to the league's rules: PPR changes a receiver's score", () => {
  const r = row({ receiving_yards: 100, receptions: 10, receiving_tds: 1 });
  const half = scoreWeek(r, DEFAULT_SCORING);
  const full = scoreWeek(r, { ...DEFAULT_SCORING, rec: 1 });
  const std = scoreWeek(r, { ...DEFAULT_SCORING, rec: 0 });
  assert.equal(half, 21);           // 10 yd-pts + 5 rec + 6 TD
  assert.equal(full, 26);
  assert.equal(std, 16);
  assert.ok(full > half && half > std, "PPR must be monotone");
});

test("2-point conversions are scored, and driven by the rules", () => {
  const r = row({ rushing_yards: 50, rushing_2pt_conversions: 1 });
  assert.equal(scoreWeek(r, DEFAULT_SCORING), 7);                       // 5 + 2
  assert.equal(scoreWeek(r, { ...DEFAULT_SCORING, twoPt: 0 }), 5);      // league that ignores 2pt
});

test("KICKER responds to the league's rules, per distance tier", () => {
  const r = row({ fg_made_0_39: 0, fg_made_30_39: 1, fg_made_50_59: 1, pat_made: 3 });
  const base = scoreKickerWeek(r, DEFAULT_KICKER);
  assert.equal(base, 3 + 5 + 3);
  // a league that pays 5 for ANY field goal and 2 per PAT must score differently
  const other = scoreKickerWeek(r, { ...DEFAULT_KICKER, fg0_39: 5, fg50_59: 5, pat: 2 });
  assert.equal(other, 5 + 5 + 6);
  assert.notEqual(base, other, "kicker scoring must depend on the rules passed in");
});

test("DEFENSE responds to the league's rules, including the points-allowed ladder", () => {
  const r = row({ def_sacks: 3, def_interceptions: 2, fumble_recovery_opp: 1, def_pass_defended: 4 });
  const base = scoreDefenseWeek(r, 10, DEFAULT_DEFENSE);
  //           3 sacks + 4 INT + 1 FR + 1 PD  - 1 (PA 10 -> -1)
  assert.equal(base, 3 + 4 + 1 + 1 - 1);
  const stingy = scoreDefenseWeek(r, 10, { ...DEFAULT_DEFENSE, sack: 2, interception: 3 });
  assert.ok(stingy > base, "richer event values must raise the score");
  // the LADDER must matter too: same stat line, more points allowed, lower score
  assert.ok(scoreDefenseWeek(r, 40, DEFAULT_DEFENSE) < base, "allowing more points must score lower");
});

test("FAULT INJECTION: a scorer that ignored its rules argument would pass none of the above", () => {
  // The concrete failure this guards: history.ts used to call scoreKickerWeek(r) / scoreDefenseWeek(r, pa)
  // with NO rules, so both silently used our own league's constants forever.
  const k = row({ fg_made_40_49: 1 });
  const d = row({ def_sacks: 1 });
  const zeroK = scoreKickerWeek(k, { ...DEFAULT_KICKER, fg40_49: 0 });
  const zeroD = scoreDefenseWeek(d, 10, { ...DEFAULT_DEFENSE, sack: 0, paLadder: [[Infinity, 0]] });
  assert.equal(zeroK, 0, "a zeroed kicker rule must produce 0 -- otherwise the argument is ignored");
  assert.equal(zeroD, 0, "a zeroed defense rule must produce 0 -- otherwise the argument is ignored");
});

test("scoringFromEspn maps OFFENCE, KICKING and DEFENSE, not just offence", () => {
  const model = scoringFromEspn([
    { statId: 53, points: 1 },                       // full PPR
    { statId: 4, points: 6 },                        // 6-pt passing TD
    { statId: 80, points: 4 },                       // FG 0-39 worth 4
    { statId: 86, points: 2 },                       // PAT worth 2
    { statId: 99, points: 0, pointsOverrides: { 16: 3 } },  // sack worth 3
    { statId: 95, points: 0, pointsOverrides: { 16: 5 } },  // INT worth 5
  ]);
  assert.equal(model.rules.rec, 1, "reception value must come from the league");
  assert.equal(model.rules.passTD, 6);
  assert.equal(model.kicker.fg0_39, 4, "kicking must come from the league");
  assert.equal(model.kicker.pat, 2);
  assert.equal(model.defense.sack, 3, "defense must come from the league (position-16 override)");
  assert.equal(model.defense.interception, 5);
  // untouched values fall back to defaults rather than to zero
  assert.equal(model.kicker.fg50_59, DEFAULT_KICKER.fg50_59);
  assert.equal(model.defense.safety, DEFAULT_DEFENSE.safety);
});

test("DEFAULT_LEAGUE_SCORING hands out an INDEPENDENT copy (no shared mutable ladder)", () => {
  const a = DEFAULT_LEAGUE_SCORING(), b = DEFAULT_LEAGUE_SCORING();
  a.rules.rec = 999;
  a.defense.sack = 999;
  a.defense.paLadder[0][1] = 999;
  assert.equal(b.rules.rec, DEFAULT_SCORING.rec, "mutating one model must not affect another");
  assert.equal(b.defense.sack, DEFAULT_DEFENSE.sack);
  assert.equal(b.defense.paLadder[0][1], DEFAULT_DEFENSE.paLadder[0][1], "the ladder must be deep-copied");
});
