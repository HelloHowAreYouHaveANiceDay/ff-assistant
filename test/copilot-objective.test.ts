/**
 * THE OBJECTIVE, AND THE STATE-DEPENDENT SWITCH.
 *
 * The whole point of Phase 3 is that the in-season tools stopped ranking on championship probability,
 * which the simulator was measured to have NO skill on (title Brier 0.0659 against a uniform 0.0652
 * over 114 real team-seasons), and started ranking on playoff probability, which it does have skill
 * on (0.2370 against 0.2451). Once a seed is secure that number saturates and stops separating
 * anything, so the objective switches to expected optimal-lineup points in weeks 15-17.
 *
 * A switch is exactly the kind of thing that reads as working when it is not wired: both branches
 * produce a plausible ranking. So it is tested in both regimes AND fault-injected -- with the
 * threshold raised out of reach, the secure fixture must rank the way the insecure one does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { objectiveFor, PLAYOFF_SECURE_THRESHOLD_PCT, seasonOdds, waiverTargets } from "../src/inseason/copilot.js";
import { fixtureCtx, key } from "./fixtures/copilot-league.js";
import type { SimContext } from "../src/draft/simContext.js";

/**
 * A fixture with two free agents whose value sits in different places, which is what makes the
 * switch observable at all:
 *
 *   FREE RUNNER   a good back. On a roster that is already deep at back he is a bench body in any
 *                 single week, but over fourteen regular-season weeks of byes and injuries he is the
 *                 cover that keeps the lineup full -- so he moves P(PLAYOFFS).
 *   BYE COVER     a tight end at a slot that has exactly one body. He is the alternative at a
 *                 position where the roster has no alternative, so he is worth real points in ANY
 *                 given week, weeks 15-17 included.
 *
 * `mult` scales our roster (and both candidates with it), which is how the fixture crosses the
 * threshold: at 1.0 we are exactly league-average and the playoff race is live; at 2.2 the seed is
 * mathematically settled.
 */
function ctxWith(mult: number): SimContext {
  const ctx = fixtureCtx({ strong: 0, mult });
  const mine = ctx.teams[0].roster;
  mine[6] = { ...mine[6], bye: 6 };   // the tight end, off in week 6
  mine.splice(11, 1);                 // remove the depth TE so that slot really is one-deep
  ctx.board.set(key("Bye Cover"), { name: "Bye Cover", pos: "TE", proj: 150 * mult, team: "FA" });
  ctx.board.set(key("Weekly Upgrade"), { name: "Weekly Upgrade", pos: "WR", proj: 235 * mult, team: "FA" });
  return ctx;
}
// Small and shared. Every one of these runs the REAL simulator, so the three waiver passes are
// computed once at module scope rather than once per assertion -- the first version of this file
// took two and a half minutes to say the same things.
const WAIVER = { trials: 300, seeds: [3], adds: 4, dropsPerAdd: 2 };
const INSECURE = waiverTargets(ctxWith(1), WAIVER);
const SECURE = waiverTargets(ctxWith(2.2), WAIVER);
const FORCED_INSECURE = waiverTargets(ctxWith(2.2), { ...WAIVER, secureThresholdPct: 101 });

test("objectiveFor: the regime, the primary quantity and the threshold all move together", () => {
  const low = objectiveFor(40);
  assert.equal(low.regime, "insecure");
  assert.equal(low.primary, "playoffs");
  assert.equal(low.alongside, "title");
  const high = objectiveFor(95);
  assert.equal(high.regime, "secure");
  assert.equal(high.primary, "playoff-week strength");
  assert.equal(high.secondary, "playoffs");
  // The boundary is inclusive at the derived threshold, and the threshold is the one derived from
  // the calibration table rather than a number typed into two places.
  assert.equal(objectiveFor(PLAYOFF_SECURE_THRESHOLD_PCT).regime, "secure");
  assert.equal(objectiveFor(PLAYOFF_SECURE_THRESHOLD_PCT - 0.01).regime, "insecure");
  // Unknown is not "secure". A tool that never computed the number must not claim the seed is safe.
  assert.equal(objectiveFor(null).regime, "insecure");
});

test("seasonOdds exposes the regime and the threshold, and the two fixtures really are on opposite sides", () => {
  const weak = seasonOdds(ctxWith(1), { trials: 400, seed: 3 });
  const strong = seasonOdds(ctxWith(2.2), { trials: 400, seed: 3 });
  assert.equal(weak.objective.regime, "insecure", `weak fixture playoff ${(100 * weak.us.playoffs).toFixed(1)}%`);
  assert.equal(strong.objective.regime, "secure", `strong fixture playoff ${(100 * strong.us.playoffs).toFixed(1)}%`);
  assert.equal(weak.objective.thresholdPct, PLAYOFF_SECURE_THRESHOLD_PCT);
  assert.equal(weak.assumptions.objective.regime, "insecure", "the objective is not travelling in the assumptions block");
});

test("D42: every regime RANKS ON EXPECTED LINEUP POINTS, and the WINDOW is the calendar, not the regime", () => {
  // Since D42 (2026-09-25) the ranking is the expected rest-of-season STARTING-LINEUP points a claim
  // adds -- the objective the waiver decision replay admitted -- not the simulated delta. The regime
  // still switches, but what it switches is the window: the rest of the regular season while the seed
  // is in doubt, the playoff weeks once it is secure. (This test used to pin the OLD mechanism: that a
  // deep-roster back ranked first on simulated playoff odds. By expected lineup points he adds nothing
  // -- he would not start -- and he no longer reaches the shortlist, which is the change.)
  assert.equal(INSECURE.objective.regime, "insecure");
  assert.equal(SECURE.objective.regime, "secure");
  for (const r of [INSECURE, SECURE, FORCED_INSECURE]) {
    const g = r.targets.map((t) => t.expGainPts);
    for (let i = 1; i < g.length; i++) assert.ok(g[i - 1] >= g[i], `not ranked on expected lineup points: ${g.join(", ")}`);
  }
  // SAME ROSTER, ONLY THE REGIME DIFFERS (2026-09-25, owner): the window no longer follows the
  // regime, because P(playoffs) crossing 70% on noise flipped a live league onto the unvalidated
  // playoff-weeks window, where every claim read ~0. Bye Cover covers our one-deep TE's week-6 bye --
  // inside the regular season -- so he must be priced IDENTICALLY, and positively, in both regimes.
  const sec = SECURE.targets.find((t) => t.add === "Bye Cover");
  const ins = FORCED_INSECURE.targets.find((t) => t.add === "Bye Cover");
  assert.ok(sec && ins, "Bye Cover was not scored in one of the regimes");
  assert.equal(sec!.expGainPts, ins!.expGainPts, "the regime moved the expected-points window");
  assert.ok(sec!.expGainPts > 0, "the bye week is not inside the window");
  assert.match(SECURE.objective.primary, /rest of regular season/);
});

test("D42: once the regular season is OVER the window is the remaining playoff weeks", () => {
  // The calendar half of the rule: past the last regular-season week, only playoff weeks remain. A
  // week-6 bye is then in the past and Bye Cover is worth nothing for it.
  const ctx = ctxWith(1);
  ctx.played = { ...(ctx.played ?? {}), weeks: ctx.weeks.length, nextWeek: ctx.weeks.length + 1 } as typeof ctx.played;
  const r = waiverTargets(ctx, { ...WAIVER, adds: 2 });
  assert.match(r.objective.primary, /playoff weeks/);
  const bc = r.targets.find((t) => t.add === "Bye Cover");
  assert.ok(bc, "Bye Cover was not scored past the regular season");
  assert.ok(bc!.expGainPts < (INSECURE.targets.find((t) => t.add === "Bye Cover")?.expGainPts ?? 0), "the past bye is still being credited");
});

test("SECURE: ranking on P(playoffs) would be a coin toss, which is why the switch exists", () => {
  // The positive case for the switch rather than an argument for it: with the seed settled, EVERY
  // candidate's playoff delta is zero, so a tool still ranking on that quantity is ordering eight
  // identical numbers. The playoff-week column separates them by more than thirty points.
  const secure = SECURE;
  const pps = secure.targets.map((t) => t.playoffsPp);
  assert.ok(Math.max(...pps) - Math.min(...pps) < 0.5, `playoff deltas spread ${Math.max(...pps) - Math.min(...pps)}pp -- the seed is not actually settled`);
  const po = secure.targets.map((t) => t.playoffWeekPts);
  assert.ok(Math.max(...po) - Math.min(...po) > 5, "playoff-week strength does not separate them either -- the switch buys nothing here");
});

test("FAULT INJECTION: with the threshold out of reach the switch does not fire, and the ranking column reverts", () => {
  // WHAT THIS ISOLATES, and why the previous test cannot: the regime is a FUNCTION of the roster, so
  // the two fixtures above differ in two ways at once and their reversal is only evidence that the
  // pair of them behave differently. Here the roster is held FIXED and only the threshold moves, so
  // anything that changes is the switch and nothing else.
  const secure = SECURE, forcedInsecure = FORCED_INSECURE;
  assert.equal(secure.objective.regime, "secure");
  assert.equal(forcedInsecure.objective.regime, "insecure", "a threshold of 101% is unreachable and the regime must fall back");

  // The ranking column itself. This is the assertion an unwired switch cannot satisfy: it would
  // rank on the same quantity in both, whatever the regime block said about itself.
  for (const t of secure.targets) assert.equal(t.rankValue, t.playoffWeekPts, "the secure regime is not ranking on playoff-week strength");
  for (const t of forcedInsecure.targets) assert.equal(t.rankValue, t.playoffsPp, "the forced-insecure regime is not ranking on the playoff delta");

  // AND THE CONSEQUENCE, which is the whole argument for the switch existing. With the seed settled,
  // the playoff column has no spread at all -- a tool still ranking on it is ordering a list of
  // zeroes -- while the playoff-week column separates the same four candidates by tens of points.
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  assert.ok(spread(forcedInsecure.targets.map((t) => t.rankValue)) < 0.5,
    "the forced-insecure ranking column has real spread here, so this fixture does not demonstrate the saturation the switch exists for");
  assert.ok(spread(secure.targets.map((t) => t.rankValue)) > 5,
    "the secure ranking column does not separate the candidates either -- the switch buys nothing");
});

test("every scored row carries all three numbers, and the FAAB rule names the quantity it prices", () => {
  const r = INSECURE;
  for (const t of r.targets) {
    assert.equal(typeof t.playoffsPp, "number");
    assert.equal(typeof t.playoffWeekPts, "number");
    assert.equal(typeof t.titlePp, "number");
    assert.equal(t.rankValue, t.playoffsPp, "in the insecure regime the ranking column must be the playoff delta");
  }
  assert.match(r.targets[0].faabRule, /PLAYOFF probability/);
  assert.ok(r.basePlayoffPct > 0 && r.baseTitlePct > 0, "the base rates are not both reported");
});
