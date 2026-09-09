// THE CONSUMER SEAM: does `waiverTargets` actually read the fitted model, and does it SAY SO when
// it does not?
//
// The failure this file is aimed at is the one this repo keeps finding: a degraded path that prints
// a number indistinguishable from a measured one. `faabBasis` is the field that separates them, and
// a test that only ever sees the happy path cannot tell whether it is connected. So both branches
// are driven -- an artifact present and live state present, and each of them absent -- and the
// dollar figures are required to DIFFER between them, which a dead seam could not produce.
//
// The adjudication rule of the replay is tested here too, including the tie. A tie scored as a win
// would silently raise the headline win rate, and inline logic is logic nothing can reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { waiverTargets, FAAB_RULE, FAAB_MODEL_RULE, faabFor } from "../src/inseason/copilot.js";
import { loadFaabModel, FAAB_ARTIFACT_PATH, type FaabLiveState } from "../src/inseason/faab.js";
import { adjudicate } from "../src/inseason/backtest/faab.js";
import type { SimContext } from "../src/draft/simContext.js";
import type { SeasonTeamInput, SeasonOdds } from "../src/draft/season.js";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DST"];

/** A deterministic stand-in for the simulator: playoff odds rise with the roster's total projection,
 *  so an add that helps is an add the ranking prefers, and nothing here depends on Monte Carlo. */
function fixtureCtx(): SimContext {
  const mk = (id: string, names: [string, string, number][]): SeasonTeamInput => ({
    id, name: `T${id}`, roster: names.map(([name, pos, proj]) => ({ name, pos, proj })),
  } as SeasonTeamInput);
  const mine: [string, string, number][] = [
    ["Our QB", "QB", 300], ["Our RB1", "RB", 250], ["Our RB2", "RB", 180],
    ["Our WR1", "WR", 240], ["Our WR2", "WR", 200], ["Our TE", "TE", 150],
    ["Our K", "K", 120], ["Our DST", "DST", 110], ["Bench WR", "WR", 60],
  ];
  const teams = [mk("8", mine), mk("2", mine.map(([n, p, v]) => [`B ${n}`, p, v * 0.9] as [string, string, number]))];
  const board = new Map<string, { name: string; pos: string; proj: number; team: string }>();
  for (const [name, pos, proj] of [["Free RB", "RB", 210], ["Free WR", "WR", 190]] as [string, string, number][]) {
    board.set(name.toLowerCase().replace(/\s+/g, ""), { name, pos, proj, team: "FA" });
  }
  const total = (t: SeasonTeamInput): number => t.roster.reduce((s, p) => s + p.proj, 0);
  return {
    teams, weeks: [], meIdx: 0, season: 2099, syntheticSchedule: true,
    opts: () => ({}) as never,
    run: (t: SeasonTeamInput[]) => t.map((x) => ({
      playoffs: Math.min(0.95, total(x) / 2200), champion: Math.min(0.4, total(x) / 6000),
      playoffWeekPts: total(x) / 10,
    })) as unknown as SeasonOdds[],
    clone: (t?: SeasonTeamInput[]) => JSON.parse(JSON.stringify(t ?? teams)) as SeasonTeamInput[],
    board, ownedIds: new Set(teams.flatMap((t) => t.roster.map((p) => p.name.toLowerCase().replace(/\s+/g, "")))),
    slots: SLOTS, flexOk: ["RB", "WR", "TE"], replacement: {},
    format: { regWeeks: 14, playoffTeams: 4 } as SimContext["format"],
  } as unknown as SimContext;
}

/** A live state with no store behind it, so the seam can be driven without a database. */
function fixtureState(): FaabLiveState {
  return {
    season: 2099, week: 6, weekSource: "fixture", budget: 100, teamsCounted: 12,
    remaining: 60, leagueRemaining: 700,
    teamFaabShare: 0.6, leagueFaabShare: 700 / 1200,
    byPlayer: new Map([
      ["freerb", { playerSk: "1", pos: "RB", posLineRank: 25, seasonLinePg: 11, tdPpg: 13, priorPts: 21 }],
    ]),
    needByPos: new Map([["RB", 4], ["WR", 3]]),
    note: "fixture state",
  };
}

test("with the model in play the row is a MEASUREMENT and says so", (t) => {
  if (!existsSync(FAAB_ARTIFACT_PATH)) return t.skip("no FAAB artifact");
  const m = loadFaabModel();
  const r = waiverTargets(fixtureCtx(), { trials: 40, seeds: [1], faabModel: m, faabState: fixtureState() });
  assert.ok(r.targets.length, "the fixture produced no waiver targets at all");
  assert.equal(r.assumptions.faab.basis, "model");
  assert.equal(r.assumptions.faab.artifact, FAAB_ARTIFACT_PATH);
  assert.equal(r.assumptions.faab.targetWinPct, 70);
  assert.equal(r.assumptions.faab.remaining, 60);
  assert.equal(r.assumptions.faab.week, 6);
  // The caveat travels with the number rather than living in a comment.
  assert.equal(typeof r.assumptions.faab.bidEffectSignificant, "boolean");
  assert.match(r.assumptions.faab.note, /bid's effect/);
  for (const x of r.targets) {
    assert.equal(x.faabBasis, "model");
    assert.equal(x.faabRule, FAAB_MODEL_RULE);
    assert.ok(x.faabClearing != null && x.faabClearing >= 1);
    assert.ok(x.faabWinPct != null && x.faabWinPct > 0 && x.faabWinPct <= 100);
    assert.ok(x.faabCurve && x.faabCurve.length >= 2);
    assert.ok(x.faab >= 1);
  }
});

test("with NO artifact the row falls back to the rule of thumb and is LABELLED as a fallback", (t) => {
  const ctx = fixtureCtx();
  const r = waiverTargets(ctx, { trials: 40, seeds: [1], faabModel: null });
  assert.equal(r.assumptions.faab.basis, "rule");
  assert.match(r.assumptions.faab.note, /RULE OF THUMB/);
  for (const x of r.targets) {
    assert.equal(x.faabBasis, "rule");
    assert.equal(x.faabRule, FAAB_RULE);
    assert.equal(x.faabClearing, null);
    assert.equal(x.faab, faabFor(x.playoffsPp, 100));
  }
});

test("POSITIVE CONTROL: the two branches do not produce the same dollars", (t) => {
  if (!existsSync(FAAB_ARTIFACT_PATH)) return t.skip("no FAAB artifact");
  const ctx = fixtureCtx();
  const withModel = waiverTargets(ctx, { trials: 40, seeds: [1], faabModel: loadFaabModel(), faabState: fixtureState() });
  const withRule = waiverTargets(ctx, { trials: 40, seeds: [1], faabModel: null });
  const a = withModel.targets.map((x) => `${x.add}:${x.faab}`).join("|");
  const b = withRule.targets.map((x) => `${x.add}:${x.faab}`).join("|");
  // A seam that was never wired would give identical rows here, and every other assertion above
  // would still pass -- which is exactly how a dead lever reads like a working one.
  assert.notEqual(a, b, `both branches produced ${a} -- the model is not reaching the row`);
});

test("the target win probability is a KNOB, and moving it moves the bid", (t) => {
  if (!existsSync(FAAB_ARTIFACT_PATH)) return t.skip("no FAAB artifact");
  const ctx = fixtureCtx(), m = loadFaabModel(), st = fixtureState();
  const lo = waiverTargets(ctx, { trials: 40, seeds: [1], faabModel: m, faabState: st, faabTargetWinPct: 0.5 });
  const hi = waiverTargets(ctx, { trials: 40, seeds: [1], faabModel: m, faabState: st, faabTargetWinPct: 0.9 });
  assert.equal(lo.assumptions.faab.targetWinPct, 50);
  assert.equal(hi.assumptions.faab.targetWinPct, 90);
  const sum = (r: typeof lo) => r.targets.reduce((s, x) => s + x.faab, 0);
  assert.ok(sum(hi) >= sum(lo), "asking for a higher win probability did not cost more");
});

test("a bid above our remaining FAAB is FLAGGED, and the flag is reachable", (t) => {
  if (!existsSync(FAAB_ARTIFACT_PATH)) return t.skip("no FAAB artifact");
  const ctx = fixtureCtx();
  const broke: FaabLiveState = { ...fixtureState(), remaining: 2, teamFaabShare: 0.02 };
  const r = waiverTargets(ctx, { trials: 40, seeds: [1], faabModel: loadFaabModel(), faabState: broke, faabTargetWinPct: 0.99 });
  const flagged = r.targets.filter((x) => x.faabOverRemaining);
  assert.ok(flagged.length, "at a 99% target with $2 left, nothing was flagged as unaffordable");
  for (const x of flagged) {
    assert.ok(x.faab <= 2, `the bid ${x.faab} exceeds the $2 it was capped to`);
    assert.ok(x.faabWanted != null && x.faabWanted > 2, "the raw ask was not reported alongside the cap");
  }
});

test("the replay's adjudication: a tie is a LOSS, and an unclaimed man is an uncontested win", () => {
  assert.deepEqual(adjudicate(5, null), { won: true, tie: false, contested: false });
  assert.deepEqual(adjudicate(6, 5), { won: true, tie: false, contested: true });
  assert.deepEqual(adjudicate(5, 5), { won: false, tie: true, contested: true });
  assert.deepEqual(adjudicate(4, 5), { won: false, tie: false, contested: true });
  // FAULT INJECTION: the rule people reach for by reflex is `>=`, which scores every tie as a win.
  // Ten of the replay's contested rows are ties, so that one character moves the headline.
  const sloppy = (bid: number, room: number | null) => (room == null ? true : bid >= room);
  assert.notEqual(sloppy(5, 5), adjudicate(5, 5).won, "a `>=` adjudication is indistinguishable from this one");
});
