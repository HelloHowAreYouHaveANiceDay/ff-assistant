/**
 * THE SEAM ITSELF: does a known designation actually change a simulated season, and does its
 * absence leave the simulator exactly as it was?
 *
 * These are the two controls the design doc names, and they fail in opposite directions:
 *
 *   OFF  -> bit-identical. If this drifts, the change is not additive and every historical number
 *           -- every backtest, the golden master, D13's 96.0% -- moved silently with it.
 *   ON   -> the odds MUST fall for a team whose starter is out four weeks. A seam that can only
 *           ever return the unconditional rate is indistinguishable from a working one in every
 *           aggregate number, which is precisely the dead-lever shape this repo keeps recording.
 *
 * The second is the one that cannot be skipped. `scripts/lever-connected.mjs` exists because a
 * null and a disconnected lever produce identical flat lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HorizonCurve } from "../src/draft/knownInjury.js";
// THE REAL CONTEXT, not a hand-built options bag. The first version of this file assembled
// `SeasonOpts` by hand and crashed inside the simulator on a field the option BUILDER supplies --
// which is its own small lesson: a fixture that reconstructs a producer's arguments is the same
// drift shape as one that copies its schema. `fixtureCtx().run` is the path the copilot uses.
import { fixtureCtx } from "./fixtures/copilot-league.js";
import type { SeasonTeamInput } from "../src/draft/season.js";

const ctx = fixtureCtx();
/** Our team is the context's own `meIdx`, so "the injured team" is the one the fixture is about. */
const ME = ctx.teams[ctx.meIdx].id;
/** The first RB on our roster -- the man the designation is attached to. */
const TARGET = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "RB")!.name;

const run = (extra: Record<string, unknown> = {}) =>
  ctx.run(ctx.clone(), 600, 11, extra as Partial<Parameters<typeof ctx.run>[3]>);

const inj = (curve: HorizonCurve) => ({
  knownInjury: { curves: new Map([[TARGET, curve]]), tailHazard: 0.72, fromWeek: 1 },
});
const playoffsOf = (r: ReturnType<typeof run>, id: string) => r.find((t) => t.id === id)!.playoffs;

test("OFF: no knownInjury option means a BIT-IDENTICAL season", () => {
  // The property that protects every historical number. `undefined` and an EMPTY map must both
  // behave exactly as the simulator did before the seam existed.
  const a = run();
  const b = run({ knownInjury: undefined });
  const c = run({ knownInjury: { curves: new Map(), tailHazard: 0.72, fromWeek: 1 } });
  assert.deepEqual(a, b, "an omitted option changed the result");
  assert.deepEqual(a, c, "an EMPTY curve map changed the result -- the lookup itself is perturbing the draw");
});

test("ON: a starter out for four weeks COSTS his team playoff probability", () => {
  /**
   * The positive control, and the reason it is here rather than in the backtest: a seam that can
   * only ever fall through to the unconditional rate produces a perfectly plausible aggregate and
   * is indistinguishable from a working one. This manufactures the state that MUST move the number
   * and checks that it does.
   *
   * The curve is a near-certain four-week absence, which is what an IR designation looks like.
   */
  const out: HorizonCurve = [0.99, 0.98, 0.97, 0.95];
  const base = run();
  const hurt = run(inj(out));

  const before = playoffsOf(base, ME);
  const after = playoffsOf(hurt, ME);
  assert.ok(after < before,
    `${TARGET}'s team must LOSE playoff probability when he is out four weeks: ${before} -> ${after}`);
  assert.ok(before - after > 0.01,
    `the drop is only ${((before - after) * 100).toFixed(2)}pp -- too small to distinguish from sampler noise, which is what a disconnected lever looks like`);

  // AND NOBODY ELSE'S ROSTER CHANGED, so the difference cannot be a global perturbation of the
  // draw. A seam that shifted every team equally would pass the assertion above and be wrong.
  const others = hurt.filter((t) => t.id !== ME);
  const othersBase = base.filter((t) => t.id !== ME);
  const gained = others.filter((t, i) => t.playoffs >= othersBase[i].playoffs).length;
  assert.ok(gained >= others.length - 1,
    "the other teams should mostly GAIN from the injury, not move arbitrarily");
});

test("ON: a curve that never rules him out leaves the season alone", () => {
  // The other direction of the same lever. A curve of zeros is a man with a designation who is
  // expected to play; if that moved the number, the seam would be reacting to the PRESENCE of a
  // designation rather than to its content.
  const plays: HorizonCurve = [0, 0, 0, 0];
  const base = run();
  const flagged = run(inj(plays));
  assert.equal(playoffsOf(flagged, ME), playoffsOf(base, ME));
});

test("ON: a LONGER episode costs more than a shorter one -- the magnitude tracks the curve", () => {
  // Monotonicity in the thing that should drive it. Without this, "the number moved" is satisfied
  // by any perturbation, including a bug.
  const short: HorizonCurve = [0.99, 0.10, 0.02, 0.01];
  const long: HorizonCurve = [0.99, 0.98, 0.97, 0.95];
  const sh = run(inj(short));
  const lo = run(inj(long));
  assert.ok(playoffsOf(lo, ME) < playoffsOf(sh, ME),
    "a four-week absence must cost more than a one-week absence");
});
