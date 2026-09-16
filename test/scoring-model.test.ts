import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreWeek, scoreKickerWeek, scoreDefenseWeek, scoringFromEspn,
  DEFAULT_LEAGUE_SCORING, DEFAULT_SCORING, DEFAULT_KICKER, DEFAULT_DEFENSE,
  YAHOO_129048_SCORING,
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

// ==================================================================================================
// EXTENDED SCORING (multi-format design, Phase 3a). The load-bearing property is the POSITIVE CONTROL:
// a ruleset with none of the extended fields must score byte-for-byte as the old linear model, so that
// generalizing the scorer cannot silently move the shipped ESPN number. Then the Yahoo case proves the
// new terms actually fire and compose.
// ==================================================================================================

// The linear formula, written out independently of scoreWeek, so "byte-exact" is checked against a
// SECOND implementation rather than against scoreWeek comparing to itself.
const linearOnly = (r: Record<string, string>, s = DEFAULT_SCORING) =>
  (Number(r.passing_yards || 0)) * s.passYd + (Number(r.passing_tds || 0)) * s.passTD + (Number(r.passing_interceptions || 0)) * s.int
  + (Number(r.rushing_yards || 0)) * s.rushYd + (Number(r.rushing_tds || 0)) * s.rushTD
  + (Number(r.receiving_yards || 0)) * s.recYd + (Number(r.receiving_tds || 0)) * s.recTD + (Number(r.receptions || 0)) * s.rec
  + (Number(r.rushing_fumbles_lost || 0) + Number(r.receiving_fumbles_lost || 0) + Number(r.sack_fumbles_lost || 0)) * s.fumble
  + (Number(r.passing_2pt_conversions || 0) + Number(r.rushing_2pt_conversions || 0) + Number(r.receiving_2pt_conversions || 0)) * (s.twoPt ?? 2);

test("POSITIVE CONTROL: half-PPR is byte-exact even when the row carries extended-stat columns", () => {
  // The row deliberately populates first-down and 40+ columns Yahoo would score. Under DEFAULT_SCORING
  // (no extended fields) every one of them must contribute exactly zero -> identical to the linear model.
  const r = row({
    position: "TE", passing_yards: 410, passing_tds: 3, passing_interceptions: 1,
    rushing_yards: 120, rushing_tds: 1, receiving_yards: 115, receiving_tds: 1, receptions: 9,
    passing_first_downs: 15, rushing_first_downs: 6, receiving_first_downs: 5,
    passing_40: 1, rushing_40: 1, receiving_40: 1, receiving_2pt_conversions: 1,
  });
  assert.equal(scoreWeek(r, DEFAULT_SCORING), linearOnly(r), "extended columns must not change a linear ruleset");
  assert.equal(scoreWeek(r, DEFAULT_SCORING, "TE"), linearOnly(r), "an explicit position must not change it either");
});

test("YAHOO: a QB week scores 6-pt TDs, the 300-yd milestone, first downs and a 40+ completion", () => {
  const r = row({
    position: "QB", passing_yards: 305, passing_tds: 3, passing_interceptions: 1,
    passing_first_downs: 18, passing_40: 1, rushing_yards: 10,
  });
  // 12.2 pass yd + 18 TD - 2 int + 1.0 rush yd + 2 (>=300) + 3.6 (18*0.2 1D) + 2 (40+ cmp) = 36.8
  assert.equal(Math.round(scoreWeek(r, YAHOO_129048_SCORING) * 10) / 10, 36.8);
});

test("YAHOO: the 300 AND 400 milestones are cumulative", () => {
  const r = row({ position: "QB", passing_yards: 410 });
  // 410/25 = 16.4, plus +2 (>=300) +3 (>=400) = 21.4
  assert.equal(Math.round(scoreWeek(r, YAHOO_129048_SCORING) * 10) / 10, 21.4);
});

test("YAHOO: TE premium (1.5/rec) applies to TE only, not to a WR on the same line", () => {
  const line = { receptions: 8, receiving_yards: 110, receiving_tds: 1, receiving_first_downs: 5, receiving_40: 1 };
  const te = scoreWeek(row({ ...line, position: "TE" }), YAHOO_129048_SCORING);
  const wr = scoreWeek(row({ ...line, position: "WR" }), YAHOO_129048_SCORING);
  // TE: 11 recYd + 6 TD + 12 (8*1.5) + 2 (>=100) + 2.5 (5*0.5 1D) + 2 (40+) = 35.5
  assert.equal(Math.round(te * 10) / 10, 35.5);
  // WR is the same minus the 0.5/rec premium on 8 catches = 4 points
  assert.equal(Math.round((te - wr) * 10) / 10, 4);
});

test("FAULT INJECTION: zeroing a Yahoo extended term must change a score that depends on it", () => {
  const r = row({ position: "WR", receiving_yards: 115, receptions: 6, receiving_first_downs: 5, receiving_40: 1 });
  const full = scoreWeek(r, YAHOO_129048_SCORING);
  const noFd = scoreWeek(r, { ...YAHOO_129048_SCORING, recFirstDown: 0 });
  const no40 = scoreWeek(r, { ...YAHOO_129048_SCORING, rec40: 0 });
  const noMilestone = scoreWeek(r, { ...YAHOO_129048_SCORING, recYdBonus: [] });
  assert.equal(Math.round((full - noFd) * 10) / 10, 2.5, "5 first downs * 0.5 must be live");
  assert.equal(Math.round((full - no40) * 10) / 10, 2, "the 40+ reception bonus must be live");
  assert.equal(Math.round((full - noMilestone) * 10) / 10, 2, "the 100-yd milestone must be live");
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

// THE STORE ROUND-TRIP. `settings.config` holds this model as JSON, and `JSON.stringify(Infinity)`
// is `null` -- so the open-ended top tier arrives back as `[null, -7]`. `pointsAllowed <= null` is
// false for every real score, which deleted the worst tier and scored a 46-point blowout as 0.
//
// It is asserted through an ACTUAL round-trip rather than by handing the scorer a hand-written
// `null`, because the bug is a property of the storage path: a test that types the null itself
// would keep passing if someone changed how the model is serialised.
test("the points-allowed ladder survives a JSON round-trip through the store", () => {
  const inMemory = DEFAULT_LEAGUE_SCORING().defense;
  const stored = JSON.parse(JSON.stringify(inMemory));
  assert.equal(stored.paLadder.at(-1)[0], null, "precondition: Infinity serialises to null");

  const blowout = { def_sacks: "0", def_interceptions: "0", def_fumble_recovery_opp: "0" };
  const PA = 52; // past every finite tier, so only the open-ended one can fire
  const live = scoreDefenseWeek(blowout, PA, inMemory);
  const back = scoreDefenseWeek(blowout, PA, stored);
  assert.equal(back, live, "a stored ladder must score a blowout the same as the in-memory one");
  assert.equal(live, DEFAULT_DEFENSE.paLadder.at(-1)[1], "the worst tier is what should have fired");
});

// FAULT INJECTION for the tier itself: drop the open-ended tier and the same blowout must change.
// Without this, the test above would still pass if the ladder stopped being consulted at all.
test("FAULT INJECTION: removing the open-ended tier changes what a blowout scores", () => {
  const d = DEFAULT_LEAGUE_SCORING().defense;
  const blowout = { def_sacks: "0" };
  const withTail = scoreDefenseWeek(blowout, 52, d);
  const truncated = { ...d, paLadder: d.paLadder.slice(0, -1) };
  const without = scoreDefenseWeek(blowout, 52, truncated);
  assert.notEqual(without, withTail, "the ladder's last tier is not being read at all");
});
