import { test } from "node:test";
import assert from "node:assert/strict";
import { playoffWinner as btWinner, runBacktest } from "../src/draft/backtest.js";
import { playoffWinner as seasonWinner } from "../src/draft/season.js";

/**
 * RESEEDING IS A REAL FORK IN THE BRACKET, AND BOTH SIMULATORS MUST HONOUR IT.
 *
 * The repo reseeded for its whole life without ever having read the league's `playoffReseed`. That
 * is the same defect shape as `regWeeks ?? 14`: a behaviour that is right by coincidence and that no
 * test could distinguish from a behaviour that was chosen. So the discriminating test is not "the
 * bracket produces a champion" -- both rules do -- it is a fixture on which the two rules produce
 * DIFFERENT champions, run through both simulators.
 *
 * THE FIXTURE, AND WHY THE OBVIOUS ONE CANNOT WORK. Under any TRANSITIVE strength order -- every
 * team has a number, the bigger number wins -- the strongest team in the field wins the title under
 * BOTH bracket shapes, because it beats whoever it meets. So a fixture built from "seed 1 is best,
 * seed 7 is worst" is guaranteed to agree with itself and can never fail, whatever the bracket does.
 * That is the same trap as a guard keyed on a name: it passes for a reason unrelated to what it
 * claims to test.
 *
 * The separating fixture therefore needs a NON-TRANSITIVE tournament, where who you meet decides the
 * game. Seven seeds, 0..6 (0 = best), and a beats b iff (a - b) mod 7 is 1, 2 or 3 -- a
 * rock-paper-scissors cycle over the whole field. One bye (seed 0); the first round pairs 1-v-6,
 * 2-v-5, 3-v-4.
 *
 *   round 1  1v6 -> 1,  2v5 -> 5,  3v4 -> 4       (survivors, in game order: 1, 5, 4)
 *   reseed:  re-ordered by seed [0, 1, 4, 5] -> 0v5 and 1v4  ->  0, 4  ->  final 0v4  -> CHAMPION 0
 *   fixed:   tree order        [0, 1, 5, 4] -> 0v4 and 1v5  ->  0, 1  ->  final 0v1  -> CHAMPION 1
 */

/** Non-transitive: a beats b iff (a - b) mod 7 is in {1,2,3}. Deliberately not a strength order. */
const upsetRule = (a: number, b: number): number => (((a - b) % 7 + 7) % 7 <= 3 && ((a - b) % 7 + 7) % 7 >= 1 ? a : b);

test("RESEED vs FIXED bracket: the two rules crown DIFFERENT teams on the same fixture", () => {
  const seeds = [0, 1, 2, 3, 4, 5, 6];
  const reseeded = seasonWinner(seeds, upsetRule, true);
  const fixed = seasonWinner(seeds, upsetRule, false);
  assert.notEqual(reseeded, fixed,
    `the fixture must SEPARATE the two rules, otherwise the test cannot fail when reseeding is ignored (both gave ${reseeded})`);
  // And the values themselves, so a future change that swaps the two is caught rather than merely
  // "still different".
  assert.equal(reseeded, 0, "reseeded bracket");
  assert.equal(fixed, 1, "fixed bracket");
});

test("the BACKTEST bracket honours reseeding the same way the season simulator does", () => {
  const seeds = [0, 1, 2, 3, 4, 5, 6];
  const beat = (a: number, b: number, _wk: number) => upsetRule(a, b);
  assert.equal(btWinner(seeds, beat, 15, true), seasonWinner(seeds, upsetRule, true),
    "reseeding must agree between the two simulators");
  assert.equal(btWinner(seeds, beat, 15, false), seasonWinner(seeds, upsetRule, false),
    "the fixed bracket must agree between the two simulators");
  assert.notEqual(btWinner(seeds, beat, 15, true), btWinner(seeds, beat, 15, false));
});

test("FAULT INJECTION: a bracket that IGNORES the reseed flag fails the discriminating assertion", () => {
  // The defect being guarded is an implementation that always reseeds -- what the repo shipped.
  // Reproduce it here and assert the test above would have caught it.
  const alwaysReseed = (seeds: number[], beat: (a: number, b: number) => number): number => {
    let alive = seeds.map((team, seed) => ({ team, seed }));
    while (alive.length > 1) {
      const byes = 2 ** Math.ceil(Math.log2(alive.length)) - alive.length;
      const bye = alive.slice(0, byes), play = alive.slice(byes);
      const winners: { team: number; seed: number }[] = [];
      for (let i = 0; i < play.length / 2; i++) {
        const a = play[i], b = play[play.length - 1 - i];
        winners.push(beat(a.team, b.team) === a.team ? a : b);
      }
      alive = [...bye, ...winners].sort((x, y) => x.seed - y.seed);
    }
    return alive[0].team;
  };
  const seeds = [0, 1, 2, 3, 4, 5, 6];
  assert.equal(alwaysReseed(seeds, upsetRule), seasonWinner(seeds, upsetRule, true),
    "the broken version must match the reseeding branch -- that is why it was invisible");
  assert.notEqual(alwaysReseed(seeds, upsetRule), seasonWinner(seeds, upsetRule, false),
    "and it must DISAGREE with the fixed branch, which is what makes the fixture discriminating");
});

test("FAULT INJECTION: runBacktest refuses to invent a calendar, a field size or a bracket", () => {
  // The dead defaults were `playoffTeams = 6, regWeeks = 14`, both plausible and both wrong for this
  // league now. Omitting them must throw rather than silently simulate a league that does not exist.
  const args = [[], new Map(), new Map(), {} as never, 1] as const;
  assert.throws(() => (runBacktest as never as (...a: unknown[]) => unknown)(...args),
    /playoffTeams must be passed/, "an omitted playoffTeams must be loud");
  assert.throws(() => (runBacktest as never as (...a: unknown[]) => unknown)(
    ...args, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 7),
  /regWeeks must be passed/, "an omitted regWeeks must be loud");
});
