/**
 * A fixture league as a real `SimContext`, shared by the copilot tests.
 *
 * Real `simulateSeasons`, real `buildSchedule`, real 16-team shape -- not a mock. A test that mocks
 * the simulator proves only that the arithmetic between the mock and the assertion is consistent,
 * which is the failure mode this repo has hit at three separate layers. Everything the copilot
 * functions read from a context is present here, so the whole decision surface runs with no store,
 * no app and no live league.
 *
 * FIXTURE NAMES ARE ALPHABETIC ON PURPOSE. `nameKey` strips every character that is not a letter, so
 * a fixture full of names like RB250-3 collapses to the single key "rb" and every player in the
 * league resolves to the same man. That is not a quirk to dodge -- it is the real key the store
 * uses, and the first draft of these tests used numeric tags and produced four green assertions that
 * were all resolving the wrong player.
 */
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "../../src/draft/season.js";
import { buildSchedule } from "../../src/draft/schedule.js";
import type { SimContext } from "../../src/draft/simContext.js";

export const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
export const FLEX_OK = ["RB", "WR", "TE"];

export const vm: VarianceModel = {
  tiers: 4,
  unfitted: ["K", "DST"],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, {
    cv: [0.6, 0.9, 1.2, 1.3], avail: [0.9, 0.75, 0.5, 0.3], skew: [0.5, 0.8, 1.0, 1.0], fitted: p !== "K" && p !== "DST",
  }])),
} as unknown as VarianceModel;

export const TIER = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
export const TEAM_TAG = "ABCDEFGHIJKLMNOP".split("");

/** The store's key, reproduced so the fixture's board and ownership are keyed the way
 *  `loadSimContext` keys them -- by player_id, which IS the name key. */
export const key = (s: string): string =>
  s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");

/** A 12-man roster in the league's own shape, with a bye on the QB so the availability path has
 *  something real to bite on. `mult` scales the whole roster, which is how a "strong" team is made. */
export function roster(tag: string, mult = 1, qbBye: number | null = 6): SeasonTeamInput["roster"] {
  const spec: [string, number, number | null][] = [
    ["QB", 300, qbBye], ["RB", 250, null], ["RB", 200, 9], ["WR", 240, null], ["WR", 210, null],
    ["WR", 180, 7], ["TE", 150, null], ["K", 120, null], ["DST", 110, null],
    ["RB", 90, null], ["WR", 85, null], ["TE", 80, null],
  ];
  return spec.map(([pos, pts, bye], i) => ({ name: `${pos} ${TIER[i]} ${tag}`, pos, proj: pts * mult, team: `NFL${tag}`, bye }));
}

export function fixtureCtx(opts: { strong?: number; mult?: number; meIdx?: number; synthetic?: boolean } = {}): SimContext {
  const meIdx = opts.meIdx ?? 0;
  const teams: SeasonTeamInput[] = Array.from({ length: 16 }, (_, i) => ({
    id: String(i), name: `T${TEAM_TAG[i]}`, roster: roster(TEAM_TAG[i], i === opts.strong ? (opts.mult ?? 2) : 1),
  }));
  const weeks = buildSchedule(16, 14, 4).weeks as [number, number][][];
  // A free-agent pool the waiver and depth-risk paths can actually reach: on the board, owned by
  // nobody. One at each position, plus a genuinely good running back.
  const board = new Map<string, { name: string; pos: string; proj: number; team: string }>();
  const ownedIds = new Set<string>();
  for (const t of teams) for (const p of t.roster) { board.set(key(p.name), { name: p.name, pos: p.pos, proj: p.proj, team: p.team ?? "" }); ownedIds.add(key(p.name)); }
  for (const [name, pos, proj] of [["Free Runner", "RB", 230], ["Free Receiver", "WR", 95], ["Free Passer", "QB", 140], ["Free Kicker", "K", 100], ["Free Defense", "DST", 95], ["Free Tight", "TE", 70]] as [string, string, number][]) {
    board.set(key(name), { name, pos, proj, team: "FA" });
  }
  const replacement = { QB: 8, RB: 5, WR: 5, TE: 4, K: 7, DST: 6 };
  const mkOpts = (trials: number, seed: number) => ({
    weeks: weeks.length, playoffTeams: 7, slots: SLOTS, flexOk: FLEX_OK, projSd: 0.30, replacement, trials, seed,
  });
  return {
    teams, weeks, meIdx, season: 2026, syntheticSchedule: opts.synthetic ?? true,
    board, ownedIds, slots: SLOTS, flexOk: FLEX_OK, replacement,
    opts: mkOpts,
    run: (t, trials, seed, extra) => simulateSeasons(t, weeks, vm, { ...mkOpts(trials, seed), ...extra }),
    clone: (t) => (t ?? teams).map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) })),
  };
}
