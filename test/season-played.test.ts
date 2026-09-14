// THE SEASON SO FAR (D18): does the simulator actually start from the seeded standings, and does the
// rest-of-season line actually replace the preseason one? Three fault injections, because a seed
// that is accepted and ignored looks exactly like one that works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "../src/draft/season.js";
import { rosPerGame, loadRosBlend } from "../src/draft/rosBlend.js";

const vm: VarianceModel = {
  tiers: 1, unfitted: [],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, { cv: [0.5], avail: [0.95], skew: [0], fitted: true }])),
};
const slots = ["QB", "RB", "WR", "TE", "K", "DST"];
const mk = (id: string, strength: number): SeasonTeamInput => ({
  id, name: `T${id}`,
  roster: slots.map((pos) => ({ name: `${pos}${id}`, pos, proj: 17 * strength * (pos === "QB" ? 2 : 1) })),
});
// Eight identical teams, a proper round robin over 7 weeks (circle method: every team exactly once a
// week), 4-team field.
const teams = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), 10));
const weeks: [number, number][][] = [];
for (let w = 0; w < 7; w++) {
  const rot = [1, 2, 3, 4, 5, 6, 7].map((_, i, a) => a[(i + w) % 7]);
  weeks.push([[0, rot[0]], [rot[1], rot[6]], [rot[2], rot[5]], [rot[3], rot[4]]]);
}
const base = { weeks: 7, playoffTeams: 4, slots, projSd: 0, trials: 400, seed: 11, allowIncompleteRosters: true };

test("played.weeks = 0 (or absent) reproduces the from-scratch odds exactly", () => {
  const a = simulateSeasons(teams, weeks, vm, base);
  const b = simulateSeasons(teams, weeks, vm, { ...base, played: { weeks: 0, wins: new Array(8).fill(0), pts: new Array(8).fill(0) } });
  assert.deepEqual(a, b);
});

test("FAULT: a team seeded 6-0 after six of seven weeks makes the playoffs in every trial; an 0-6 team in none", () => {
  const wins = [6, 0, 3, 3, 3, 3, 3, 3];
  const pts = wins.map((w) => 100 * w + 300);
  const odds = simulateSeasons(teams, weeks, vm, { ...base, played: { weeks: 6, wins, pts } });
  assert.equal(odds[0].playoffs, 1, "a 6-0 team with one week left cannot miss a 4-team field");
  assert.equal(odds[1].playoffs, 0, "an 0-6 team with one week left cannot make it");
  // The seeded record is carried into meanWins: at least the seed, at most the seed plus one.
  assert.ok(odds[0].meanWins >= 6 && odds[0].meanWins <= 7, `meanWins ${odds[0].meanWins}`);
  assert.ok(odds[1].meanWins >= 0 && odds[1].meanWins <= 1, `meanWins ${odds[1].meanWins}`);
});

test("FAULT: every week settled -> the field is exactly the seeded standings, no sampling left to do", () => {
  const wins = [7, 6, 5, 4, 3, 2, 1, 0];
  const pts = wins.map((w) => 100 * w);
  const odds = simulateSeasons(teams, weeks, vm, { ...base, played: { weeks: 7, wins, pts } });
  assert.deepEqual(odds.map((o) => o.playoffs), [1, 1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(odds.map((o) => o.meanWins), wins);
});

test("a seed for the wrong number of teams, or more weeks than the season, is refused", () => {
  assert.throws(() => simulateSeasons(teams, weeks, vm, { ...base, played: { weeks: 2, wins: [1, 1], pts: [1, 1] } }), /teams/);
  assert.throws(() => simulateSeasons(teams, weeks, vm, { ...base, played: { weeks: 9, wins: new Array(8).fill(0), pts: new Array(8).fill(0) } }), /exceeds/);
});

test("rosPerGame replaces proj/17 as the per-game strength (positive control: a roster of ROS zeros scores like nothing)", () => {
  const strong = teams.map((t) => ({ ...t, roster: t.roster.map((p) => ({ ...p })) }));
  // Team 1's men are told their rest of season is ZERO per game; their preseason proj is untouched.
  for (const p of strong[0].roster) p.rosPerGame = 0;
  const odds = simulateSeasons(strong, weeks, vm, base);
  const ref = simulateSeasons(teams, weeks, vm, base);
  assert.ok(odds[0].meanPoints < 0.05 * ref[0].meanPoints, `team 1 still scored ${odds[0].meanPoints} vs ${ref[0].meanPoints} -- rosPerGame is not connected`);
  assert.ok(odds[0].playoffs < ref[0].playoffs);
});

test("rosPerGame blend arithmetic: line only at K=Infinity, actual only at K=0, games-weighted between", () => {
  assert.equal(rosPerGame(10, 4, 80, Infinity), 10);
  assert.equal(rosPerGame(10, 4, 80, 0), 20);
  assert.equal(rosPerGame(10, 4, 80, 4), (4 * 10 + 4 * 20) / 8);
  assert.equal(rosPerGame(10, 0, null, 4), 10, "no games played -> the line");
  assert.equal(rosPerGame(null, 4, 80, 4), 20, "no line -> the actual, not an invented number");
  assert.equal(rosPerGame(null, 0, null, 4), null);
  const { blend, source } = loadRosBlend("/definitely/not/a/file.json");
  assert.equal(source, "absent");
  assert.equal(blend.K, Infinity, "an absent fit is the OLD behaviour, never an invented K");
});
