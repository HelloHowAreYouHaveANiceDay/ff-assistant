// STREAMING OVER A STARTER (2026-10-02). With a replacement level, a slot used to take the streamed free
// agent only when nobody could fill it -- so a roster forced to start a sub-replacement man scored his
// points, and DROPPING him "gained" the whole floor (league 462233 wk4: "+7.06 for a second kicker",
// 6.34 of it the RB slot in the NYJ bye week). Now the lineup streams whenever the floor beats a starter,
// in BOTH the waiver arithmetic (expectedLineup.ts) and the season sim (season.ts, opt-in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, streamCandidates } from "../src/draft/season.js";
import { expectedLineupPoints } from "../src/inseason/expectedLineup.js";
import { buildSchedule } from "../src/draft/schedule.js";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DST", "K", "BE", "BE"];

test("streamCandidates: one virtual man per slot admitting each position, none for bench or a zero floor", () => {
  const c = streamCandidates(SLOTS, ["RB", "WR", "TE"], { QB: 12, RB: 5, WR: 6, TE: 4, K: 7, DST: 0 });
  const n = (p: string) => c.filter((x) => x.pos === p).length;
  assert.deepEqual([n("QB"), n("RB"), n("WR"), n("TE"), n("K"), n("DST")], [1, 3, 3, 2, 1, 0]);
  for (const x of c) assert.ok(x.name.startsWith("(stream "));
});

const roster = (rbRate: number) => [
  { name: "Q", pos: "QB", rate: 15 }, { name: "R1", pos: "RB", rate: 12 }, { name: "R2", pos: "RB", rate: rbRate },
  { name: "W1", pos: "WR", rate: 11 }, { name: "W2", pos: "WR", rate: 10 }, { name: "W3", pos: "WR", rate: 8 },
  { name: "T", pos: "TE", rate: 7 }, { name: "D", pos: "DST", rate: 7 }, { name: "K", pos: "K", rate: 8 },
];
const REP = { QB: 12, RB: 5, WR: 6, TE: 4, K: 7, DST: 6 };
// `optimalLineup` reports totalProj to 0.1, hence the 0.11 tolerances below.
const eo = { slots: SLOTS, flexOk: ["RB", "WR", "TE"], from: 5, to: 5, firstWk: 5, replacement: REP };

test("expected lineup: a starter below the floor is streamed over; dropping him gains nothing", () => {
  // R2 at 1.75 starts at RB (no other RB) -- the Braelon/Wright shape. The floor (5) should take his slot.
  const withScrub = expectedLineupPoints(roster(1.75), eo);
  const without = expectedLineupPoints(roster(1.75).filter((p) => p.name !== "R2"), eo);
  assert.ok(Math.abs(withScrub - without) < 0.11, `dropping a sub-floor starter moved the lineup by ${without - withScrub}`);
  assert.ok(Math.abs(withScrub - expectedLineupPoints(roster(5), eo)) < 0.11, "the scrub should score exactly the floor");
  // ...and a starter ABOVE the floor is kept: no stream beats him.
  assert.ok(expectedLineupPoints(roster(9), eo) > withScrub + 3.99);
});

test("expected lineup, FAULT INJECTION: FF_STREAM_OVER_STARTERS=off restores the old asymmetry (dropping the scrub gains floor - scrub)", () => {
  process.env.FF_STREAM_OVER_STARTERS = "off";
  try {
    const withScrub = expectedLineupPoints(roster(1.75), eo);
    const without = expectedLineupPoints(roster(1.75).filter((p) => p.name !== "R2"), eo);
    assert.ok(Math.abs(without - withScrub - (5 - 1.75)) < 0.11, `old rule: drop gained ${without - withScrub}`);
  } finally { delete process.env.FF_STREAM_OVER_STARTERS; }
});

// ---- the season sim ----
const vm = {
  tiers: 4,
  unfitted: ["K", "DST"],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, {
    cv: [0.6, 0.9, 1.2, 1.3], avail: [0.9, 0.75, 0.5, 0.3], skew: [0.5, 0.8, 1.0, 1.0], fitted: p !== "K" && p !== "DST",
  }])),
};
const SEASON_SLOTS = ["QB", "RB", "RB", "WR", "TE", "FLEX", "DST", "K", "BE", "BE"];   // two RB slots: the scrub MUST start
function teams(scrubTeam: number) {
  return Array.from({ length: 12 }, (_, i) => ({
    id: String(i), name: `T${i}`,
    roster: ([["QB", 280], ["RB", 220], ["WR", 230], ["WR", 200], ["TE", 140], ["K", 120], ["DST", 110], ["WR", 90]] as [string, number][])
      .concat([["RB", i === scrubTeam ? 15 : 180]])
      .map(([pos, pts]) => ({ name: `${pos}${pts}-t${i}`, pos, proj: pts, bye: null })),
  }));
}
const sched = buildSchedule(12, 13, 4).weeks;
const base = { weeks: 13, playoffTeams: 6, slots: SEASON_SLOTS, projSd: 0.30, trials: 400, seed: 5, replacement: { QB: 12, RB: 6, WR: 6, TE: 4, K: 6, DST: 6 } };

test("season sim: off/absent is the old behaviour exactly; on, a team starting a scrub streams over him", () => {
  const off = simulateSeasons(teams(3), sched, vm, base);
  const explicitOff = simulateSeasons(teams(3), sched, vm, { ...base, streamOverStarters: false });
  assert.deepEqual(explicitOff, off, "streamOverStarters:false is not byte-identical to absent");
  const noRep = simulateSeasons(teams(3), sched, vm, { ...base, replacement: undefined });
  const noRepOn = simulateSeasons(teams(3), sched, vm, { ...base, replacement: undefined, streamOverStarters: true });
  assert.deepEqual(noRepOn, noRep, "streamOverStarters without a replacement level must do nothing");
  // POSITIVE CONTROL: team 3's FLEX/RB2 is a 15-point RB (0.9/wk) against a 6/wk floor; streaming lifts it.
  const on = simulateSeasons(teams(3), sched, vm, { ...base, streamOverStarters: true });
  const t3 = (o: typeof on) => o.find((r) => r.id === "3")!;
  assert.ok(t3(on).playoffs > t3(off).playoffs + 0.05, `scrub team playoffs ${t3(off).playoffs} -> ${t3(on).playoffs}`);
  // ...and the env switch forces it off.
  process.env.FF_STREAM_OVER_STARTERS = "off";
  try { assert.deepEqual(simulateSeasons(teams(3), sched, vm, { ...base, streamOverStarters: true }), off); }
  finally { delete process.env.FF_STREAM_OVER_STARTERS; }
});
