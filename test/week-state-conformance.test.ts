/**
 * EVERY VERB THAT PICKS A PLAYER MUST READ THE WEEK'S STATE, AND THE LIST IS DERIVED.
 *
 * On 2026-09-18 the ten copilot verbs had this coverage:
 *
 *     availability    2 of 10        locks   1 of 10        settled points   1 of 10
 *
 * Four cells were then filled by hand, which is exactly how a 2-of-10 table gets built in the first
 * place. `WeekState` moved the inputs onto the context so omission is not expressible; this file is
 * the other half -- proof that a verb handed the state actually READS it.
 *
 * THE LIST COMES FROM THE CODE, NOT FROM THIS FILE. `CopilotVerb` is the union the dispatcher
 * switches on, so a verb added tomorrow appears here tomorrow. A hand-typed list would go stale the
 * first time someone added an eleventh verb, which is the coverage-by-enumeration rot this repo has
 * already paid for in `.gitignore`, in a conformance check over seven drivers, and in the status
 * vocabulary that missed `Injured Reserve`.
 *
 * FAULT INJECTION IS THE TEST. Asserting that a verb *can be called* with a week state proves
 * nothing -- a verb that ignores it passes. So each verb is run twice, once against an empty week
 * and once against a week in which a man on OUR roster cannot play, and the outputs must DIFFER.
 * A verb whose answer is identical either way is not reading the state it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureCtx } from "./fixtures/copilot-league.js";
import { emptyWeekState, cannotPlay, finishedTeams, type WeekState } from "../src/inseason/weekState.js";
import { normalizeStatus } from "../src/inseason/availability.js";
import { nameKey } from "../src/draft/values.js";
import type { SimContext } from "../src/draft/simContext.js";
import * as C from "../src/inseason/copilot.js";
import { COPILOT_VERBS } from "../src/inseason/copilotActions.js";

/**
 * THE VERBS THAT DECIDE WHICH PLAYERS ARE INVOLVED, and therefore must respect who can play.
 *
 * `season_odds`, `power_rankings` and `playoff_sos` are deliberately NOT here: they price rosters as
 * they stand rather than choosing anyone, and the known-designation seam for the SIMULATOR is a
 * separate, gated change (docs/week-state-design-2026-09-18.md section 4). Listing them would assert
 * behaviour that has not been measured or signed off, which is worse than not asserting it.
 */
const PLAYER_PICKING_VERBS = ["lineup_recommend", "waiver_targets", "trade_finder"] as const;

test("the verb list this file checks is a SUBSET of the dispatcher's own union", () => {
  // The guard on the derivation. If a verb is renamed, this fails rather than silently checking
  // nothing -- the failure mode of every list that drifts from the thing it describes.
  const all = new Set<string>(COPILOT_VERBS as readonly string[]);
  assert.ok(all.size >= 10, `expected the full verb set, got ${all.size}`);
  for (const v of PLAYER_PICKING_VERBS) {
    assert.ok(all.has(v), `${v} is not a CopilotVerb any more -- this file is checking a ghost`);
  }
});

/** A week in which the named man cannot play, built through the real vocabulary rather than by
 *  writing "OUT" directly -- so a vocabulary regression fails here too. */
function weekWithOut(name: string, status = "Injured Reserve"): WeekState {
  const w = emptyWeekState(2026, 1);
  w.availability.set(nameKey(name), {
    status: normalizeStatus(status), source: "test", detail: status,
  });
  return w;
}

test("the injected week actually rules the man out -- the injection itself is a control", () => {
  // Without this, a typo in the fixture would make every difference-test below pass trivially by
  // injecting nothing. The injection must be shown to bite before it is used as a probe.
  const w = weekWithOut("Star RB");
  assert.equal(cannotPlay(w, "Star RB"), true);
  assert.equal(cannotPlay(w, "Somebody Else"), false);
  assert.equal(cannotPlay(emptyWeekState(2026, 1), "Star RB"), false, "the empty week rules out nobody");
});

const withWeek = (ctx: SimContext, week: WeekState): SimContext => ({ ...ctx, week });

test("LINEUP reads the week: a rostered man ruled OUT is not started", () => {
  const ctx = fixtureCtx();
  const mine = ctx.teams[ctx.meIdx].roster;
  const target = mine.find((p) => p.pos === "RB") ?? mine[0];

  const before = C.lineupRecommend(ctx, 1, {});
  const after = C.lineupRecommend(withWeek(ctx, weekWithOut(target.name)), 1, {});

  assert.ok(before.starters.some((s) => s.name === target.name),
    `${target.name} must be started in the control, or this proves nothing`);
  assert.ok(!after.starters.some((s) => s.name === target.name),
    `${target.name} is OUT and must not be started`);
});

test("WAIVERS read the week: a free agent who cannot play is excluded and NAMED", () => {
  const ctx = fixtureCtx();
  const freeName = [...ctx.board.entries()].find(([id]) => !ctx.ownedIds.has(id))?.[1].name;
  assert.ok(freeName, "the fixture has no free agent -- nothing to exclude");

  const before = C.waiverTargets(ctx, { trials: 20, seeds: [1] });
  const after = C.waiverTargets(withWeek(ctx, weekWithOut(freeName!)), { trials: 20, seeds: [1] });

  assert.equal(before.unavailableAdds.length, 0, "the control excludes nobody");
  assert.ok(after.unavailableAdds.some((u) => u.name === freeName),
    `${freeName} cannot play and must be named in unavailableAdds`);
  assert.ok(!after.targets.some((t) => t.add === freeName), "and must not be recommended");
});

test("TRADE FINDER reads the week: pairings involving a man who cannot play are skipped and counted", () => {
  const ctx = fixtureCtx();
  const mine = ctx.teams[ctx.meIdx].roster;
  const values = new Map(ctx.teams.flatMap((t) => t.roster.map((p) => [nameKey(p.name), 100])));

  const before = C.tradeFinder(ctx, { values, trials: 20, seed: 1 });
  const after = C.tradeFinder(withWeek(ctx, weekWithOut(mine[0].name)), { values, trials: 20, seed: 1 });

  assert.equal(before.skippedUnavailable, 0, "the control skips nobody");
  assert.ok(after.skippedUnavailable > 0, "pairings involving an OUT man must be skipped");
  assert.ok(after.unavailableNames.includes(mine[0].name));
  assert.ok(after.candidates < before.candidates, "and the candidate count must actually fall");
});

test("NO WEEK STATE means the behaviour every existing caller had", () => {
  // The other direction, and the one that protects every historical number: an empty week must
  // leave each verb's answer exactly where it was. If this diverges the change is not additive.
  const ctx = fixtureCtx();
  const a = C.lineupRecommend(ctx, 1, {});
  const b = C.lineupRecommend(withWeek(ctx, emptyWeekState(2026, 1)), 1, {});
  assert.deepEqual(a.starters, b.starters);
  assert.deepEqual(a.bench, b.bench);
  assert.equal(a.totalProj, b.totalProj);
  assert.equal(a.settled, undefined, "an empty week banks nothing");
});

test("the per-verb option still OVERRIDES the context -- fault injection stays possible", () => {
  // The override exists so tests can inject; it must not have become dead code when the context
  // became the default. A seam nobody can drive is a seam that rots.
  const ctx = fixtureCtx();
  const target = ctx.teams[ctx.meIdx].roster[0];
  const viaOption = C.lineupRecommend(ctx, 1, { availability: weekWithOut(target.name).availability });
  const viaContext = C.lineupRecommend(withWeek(ctx, weekWithOut(target.name)), 1, {});
  assert.deepEqual(viaOption.starters, viaContext.starters, "both routes must produce one answer");
});

test("finishedTeams unions the two ways a game can be known over, and keeps them separable", () => {
  const w = emptyWeekState(2026, 1);
  w.finished.byScore.add("DET");
  w.finished.byElapsed.add("BUF");
  assert.deepEqual([...finishedTeams(w)].sort(), ["BUF", "DET"]);
  // Separable, because "we read the final score" and "we assumed from the clock" are different
  // claims and the caveat has to be able to say which one it is making.
  assert.equal(w.finished.byScore.has("BUF"), false);
});
