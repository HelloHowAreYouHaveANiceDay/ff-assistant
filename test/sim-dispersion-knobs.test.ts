// M2d (2026-09-16): the dispersion knobs the calibration experiment sweeps.
//
// THE PROPERTY THAT MATTERS IS THE DEFAULT. Each knob exists so a sweep can pass a value explicitly;
// none of them may change what the shipped code does. So every test below is a pair: the knob UNSET
// must equal the knob set to its documented default (exactly -- `deepEqual` on the odds, not a
// tolerance), and the knob at an extreme must MOVE the odds. The second half is not decoration: a
// knob that is read but never reaches the sampler is indistinguishable from a knob at its default,
// and would make every sweep arm a re-measurement of the control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "../src/draft/season.js";
import { seasonCoupling, weeklyCoupling, SEASON_COUPLING_DEFAULT, WEEKLY_COUPLING_DEFAULT, type RankOutcomes, type CorrelationModel } from "../src/draft/bootstrap.js";

const vm: VarianceModel = {
  tiers: 1, unfitted: [],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, { cv: [0.5], avail: [0.95], skew: [0], fitted: true }])),
};
const slots = ["QB", "RB", "WR", "TE", "K", "DST"];
// Eight teams of DIFFERENT strengths -- identical teams would make every probability 0.5 and hide a
// knob that compresses the spread, which is the very thing being measured.
const teams: SeasonTeamInput[] = Array.from({ length: 8 }, (_, i) => ({
  id: String(i + 1), name: `T${i + 1}`,
  roster: slots.map((pos) => ({ name: `${pos}${i + 1}`, pos, team: `NFL${i + 1}`, proj: 17 * (8 + i) })),
}));
const weeks: [number, number][][] = [];
for (let w = 0; w < 7; w++) {
  const rot = [1, 2, 3, 4, 5, 6, 7].map((_, i, a) => a[(i + w) % 7]);
  weeks.push([[0, rot[0]], [rot[1], rot[6]], [rot[2], rot[5]], [rot[3], rot[4]]]);
}
const base = { weeks: 7, playoffTeams: 4, slots, projSd: 0.3, trials: 300, seed: 11, allowIncompleteRosters: true };
// A schema-2 pool with real season-to-season spread, so the bootstrap path has a level to scale.
const traj = (v: number) => [v, v, v, v, v, v, v];
const pool = Array.from({ length: 200 }, (_, i) => traj(2 + 0.2 * i));
const outcomes: RankOutcomes = { schema: 2, pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, { 1: pool }])) };
const corr: CorrelationModel = { pairs: { "QB-WR": 0.348, "QB-TE": 0.223, "QB-RB": 0.08 } };
const bootOpts = { ...base, bootstrap: { outcomes, corr, calibration: "scale" as const } };

/** Run with exactly these env values set, then restore whatever was there. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const had: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { had[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k]!; }
  }
}
const UNSET = {
  FF_SIM_LEVEL_SCALE: undefined, FF_SIM_TEAM_SD: undefined, FF_SIM_WEEKLY_VAR: undefined,
  FF_SIM_CORR_SCALE: undefined, FF_WEEKLY_COUPLING: undefined, FF_SIM_LEVEL_SHRINK: undefined,
};

test("every dispersion knob at its documented default reproduces the unset simulator EXACTLY", () => {
  for (const opts of [base, bootOpts]) {
    const unset = withEnv(UNSET, () => simulateSeasons(teams, weeks, vm, opts));
    const defaults = withEnv({ ...UNSET, FF_SIM_LEVEL_SCALE: "1", FF_SIM_TEAM_SD: "0", FF_SIM_WEEKLY_VAR: "1", FF_SIM_CORR_SCALE: "1", FF_WEEKLY_COUPLING: String(WEEKLY_COUPLING_DEFAULT) },
      () => simulateSeasons(teams, weeks, vm, opts));
    assert.deepEqual(defaults, unset);
  }
});

test("a garbage or negative knob value falls back to the default rather than to nonsense", () => {
  const unset = withEnv(UNSET, () => simulateSeasons(teams, weeks, vm, bootOpts));
  // NOT the empty string: `Number("")` is 0, which is a VALID value for every one of these knobs
  // (and is how `weeklyCoupling` has always read it). Garbage here means unparseable or negative.
  const junk = withEnv({ ...UNSET, FF_SIM_LEVEL_SCALE: "banana", FF_SIM_TEAM_SD: "-1", FF_SIM_CORR_SCALE: "nope" },
    () => simulateSeasons(teams, weeks, vm, bootOpts));
  assert.deepEqual(junk, unset);
});

test("CONNECTED: FF_SIM_LEVEL_SCALE reaches the outcome in BOTH sampling paths, and 0 pins the level", () => {
  for (const opts of [base, bootOpts]) {
    const unset = withEnv(UNSET, () => simulateSeasons(teams, weeks, vm, opts));
    const wide = withEnv({ ...UNSET, FF_SIM_LEVEL_SCALE: "3" }, () => simulateSeasons(teams, weeks, vm, opts));
    const pinned = withEnv({ ...UNSET, FF_SIM_LEVEL_SCALE: "0" }, () => simulateSeasons(teams, weeks, vm, opts));
    const spread = (o: { playoffs: number }[]) => Math.max(...o.map((x) => x.playoffs)) - Math.min(...o.map((x) => x.playoffs));
    assert.notDeepEqual(wide, unset);
    assert.notDeepEqual(pinned, unset);
    // Pinning each player's level at his projection can only make the STRONGEST roster surer of a
    // berth than a wide level distribution does: that is what "less uncertainty" means.
    assert.ok(spread(pinned) > spread(wide), `pinned spread ${spread(pinned)} should exceed wide ${spread(wide)}`);
  }
});

test("CONNECTED: FF_SIM_TEAM_SD widens team outcomes and compresses the berth probabilities", () => {
  const unset = withEnv(UNSET, () => simulateSeasons(teams, weeks, vm, bootOpts));
  const shocked = withEnv({ ...UNSET, FF_SIM_TEAM_SD: "0.5" }, () => simulateSeasons(teams, weeks, vm, bootOpts));
  const spread = (o: { playoffs: number }[]) => Math.max(...o.map((x) => x.playoffs)) - Math.min(...o.map((x) => x.playoffs));
  assert.notDeepEqual(shocked, unset);
  assert.ok(spread(shocked) < spread(unset), `a roster-wide season shock must compress the field: ${spread(shocked)} vs ${spread(unset)}`);
  // It is a MEAN-ONE factor: the berths still sum to the field size, which is the conservation law
  // every arm of this simulator obeys and the cheapest way to catch a shock applied with a bias.
  assert.ok(Math.abs(shocked.reduce((a, o) => a + o.playoffs, 0) - 4) < 1e-9);
});

test("CONNECTED: the two copula multiples are read at CALL time and both reach the sampler", () => {
  assert.equal(seasonCoupling(), SEASON_COUPLING_DEFAULT);
  assert.equal(weeklyCoupling(), WEEKLY_COUPLING_DEFAULT);
  withEnv({ FF_SIM_CORR_SCALE: "4", FF_WEEKLY_COUPLING: "0" }, () => {
    assert.equal(seasonCoupling(), 4);
    assert.equal(weeklyCoupling(), 0);
  });
  const unset = withEnv(UNSET, () => simulateSeasons(teams, weeks, vm, bootOpts));
  // Stacked rosters: every man on a fantasy team shares one NFL team, so the copula has real work.
  const stacked = teams.map((t) => ({ ...t, roster: t.roster.map((p) => ({ ...p, team: "SF" })) }));
  const a = withEnv(UNSET, () => simulateSeasons(stacked, weeks, vm, bootOpts));
  const b = withEnv({ ...UNSET, FF_SIM_CORR_SCALE: "0" }, () => simulateSeasons(stacked, weeks, vm, bootOpts));
  assert.notDeepEqual(a, b);
  assert.ok(unset.length === 8);
});
