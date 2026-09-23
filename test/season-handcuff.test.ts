/**
 * THE HANDCUFF COUPLING (season.ts): does a backup's output actually land on the weeks his lead is
 * out, and does it do so WITHOUT inventing points?
 *
 * The teammate copula is keyed by position pair and every same-position entry in
 * `data/correlation-model.json` is exactly zero, so "lead out, backup elevated" had no
 * representation in the simulator at all. `handcuffCoupling` adds it as a RE-TIMING: mass moves
 * between weeks, each drawn season total is preserved exactly.
 *
 * THE CENTRAL TEST IS THE CONSERVATION ONE. A re-timing and an inflation look identical on "did the
 * number move" -- both move it, both in the same direction -- and an inflation is the wrong model,
 * because the bootstrap's trajectories already carry a backup's elevated weeks in their marginal.
 * So the discriminating assertion is the one where every rostered man starts every week: there is no
 * bench, WHEN a player's points land cannot matter, and a re-timing must therefore move the season
 * total by EXACTLY ZERO while an inflation could not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel } from "../src/draft/season.js";

const vm: VarianceModel = {
  tiers: 1, unfitted: [],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, { cv: [0.5], avail: [0.95], skew: [0], fitted: true }])),
};

/**
 * A POOL WITH REAL MISSED WEEKS. Half the trajectories carry zeros in weeks 3-5 (an injury the
 * bootstrap's whole-season draw is designed to keep persistent) and the rest are healthy but
 * lumpy. Without zeros in the pool a lead never misses a week, the coupling has nothing to act on,
 * and every assertion below would pass on a dead lever.
 */
const L = 7;
const mkPool = (m: number) => [
  [m, m, 0, 0, 0, m, m],
  [0, 0, 0, m * 2, m * 2, m * 2, m * 2],
  [m * 0.2, m * 1.8, m * 0.2, m * 1.8, m * 0.2, m * 1.8, m * 0.2],
  [m, m, m, m, m, m, m],
];
const outcomes = {
  schema: 2,
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) =>
    [p, Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((r) => [String(r), mkPool(10)]))])),
};
const corr = { pairs: {} };

const weeks: [number, number][][] = [];
for (let w = 0; w < L; w++) {
  const rot = [1, 2, 3, 4, 5, 6, 7].map((_, i, a) => a[(i + w) % 7]);
  weeks.push([[0, rot[0]], [rot[1], rot[6]], [rot[2], rot[5]], [rot[3], rot[4]]]);
}

/** `NYJ` puts the two backs on ONE NFL team, which is what makes them a handcuff pair. */
const rosterFor = (id: string, withBench: boolean) => {
  const men = [
    { name: `QB${id}`, pos: "QB", proj: 17 * 20, team: "AAA" },
    { name: `RB${id}`, pos: "RB", proj: 17 * 12, team: "NYJ" },
    { name: `WR${id}`, pos: "WR", proj: 17 * 10, team: "BBB" },
    { name: `TE${id}`, pos: "TE", proj: 17 * 10, team: "CCC" },
    { name: `K${id}`, pos: "K", proj: 17 * 10, team: "DDD" },
    { name: `DST${id}`, pos: "DST", proj: 17 * 10, team: "EEE" },
  ];
  // The BACKUP: same NFL team, same position, strictly below the lead. Only present when the roster
  // has a bench slot for him to sit on.
  if (withBench) men.push({ name: `RB${id}b`, pos: "RB", proj: 17 * 4, team: "NYJ" });
  return men;
};
const slots = ["QB", "RB", "WR", "TE", "K", "DST"];
const mk = (id: string, withBench: boolean): SeasonTeamInput => ({ id, name: `T${id}`, roster: rosterFor(id, withBench) });

const poolRankOf = (ts: SeasonTeamInput[]) =>
  new Map(ts.flatMap((t) => t.roster.map((p) => [p.name, { rank: 0, of: 1 }] as [string, { rank: number; of: number }])));

const RATIOS = { QB: 2.129, RB: 1.659, WR: 1.214, TE: 1.359 };

const baseFor = (ts: SeasonTeamInput[]) => ({
  weeks: L, playoffTeams: 4, slots, projSd: 0, trials: 300, seed: 11, allowIncompleteRosters: true,
  poolRank: poolRankOf(ts),
  bootstrap: { outcomes: outcomes as never, corr, calibration: "none" as const },
});

test("handcuff coupling: omitting it is byte-identical to the behaviour before it existed", () => {
  const ts = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), true));
  const b = baseFor(ts);
  const off = simulateSeasons(ts, weeks, vm, b);
  const explicitNull = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: null });
  const allOnes = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: { QB: 1, RB: 1, WR: 1, TE: 1 } });
  assert.deepEqual(explicitNull, off, "an explicit null is not the same as omitting the field");
  assert.deepEqual(allOnes, off, "a ratio of 1.0 must be a no-op -- it is the null this models against");
});

/**
 * CONSERVATION -- the assertion that separates a re-timing from an inflation.
 *
 * Here the roster IS the starting lineup: six men, six slots, no bench, so every man's points count
 * every week whenever they land. Re-timing therefore cannot change a single season total, and the
 * odds must be EQUAL to the last bit. An implementation that scaled the backup up in the lead's
 * missed weeks -- the obvious and wrong fix -- would fail this outright.
 */
test("FAULT: when every man STARTS, the coupling moves the season total by EXACTLY zero -- it re-times, it does not inflate", () => {
  // The pair is PRESENT (withBench) but there are seven slots for seven men, so both backs start
  // every week and WHEN a point lands cannot matter. An earlier version of this test used a roster
  // with no backup at all: it passed because there was no pair to couple, which is a dead-lever
  // pass and proves nothing. The pair must exist AND be fully started.
  const ts = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), true));
  const allStart = [...slots, "RB"];
  // benchDrawnZeros is held CONSTANT across both arms. It is a real points change on its own -- a
  // benched DNP leaves an empty slot that scores the replacement level instead of his zero -- so
  // varying it here alongside the coupling would move two things at once and prove neither.
  const b = { ...baseFor(ts), slots: allStart, benchDrawnZeros: true };
  const off = simulateSeasons(ts, weeks, vm, b);
  const on = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: RATIOS });

  // POINTS are conserved EXACTLY. This is the assertion that separates a re-timing from an
  // inflation: an implementation that scaled the backup up in the lead's missed weeks would raise
  // this number, and by percent, not by float noise.
  assert.deepEqual(on.map((o) => o.meanPoints), off.map((o) => o.meanPoints),
    "the coupling changed a season total when every man was started, so it is creating points rather than moving them");

  // WINS ARE NOT CONSERVED, AND MUST NOT BE. Re-timing changes WHICH WEEKS the points land in, so
  // the same season total wins different head-to-head matchups -- that is the entire mechanism, not
  // a leak. Asserting deepEqual on the whole odds object here would be asserting the feature does
  // nothing. Measured on this fixture: meanPoints identical to the cent, meanWins 3.72 -> 3.67.
  assert.notDeepEqual(on.map((o) => o.meanWins), off.map((o) => o.meanWins),
    "re-timing moved no matchup at all -- then it moved no points between weeks either and the lever is dead");
});

/**
 * CONNECTED -- and it takes BOTH halves, which is the finding this test exists to pin down.
 *
 * The simulator sets its lineup on the season-long true mean and marked every man available,
 * because `weekOf` hands back a DNP as the NUMBER 0 rather than null -- so the lead STARTED in the
 * weeks he was injured, scored his zero, and the backup sat. Re-timing the backup's points onto
 * those weeks buys nothing while he is never in the lineup to collect them.
 *
 * IN THIS FIXTURE the coupling alone is EXACTLY inert, because the backup (proj 4) never out-ranks
 * the lead (proj 12) for the single RB slot and so never starts at all. That is a property of this
 * roster, NOT a general law, and the distinction is worth stating because the real league disproves
 * the general version: on 2018-2025 the coupling alone moved the playoff Brier by ~0.0002, since
 * real backups do sometimes start (a FLEX, a bye, a better backup). The assertion below is scoped
 * to this fixture deliberately -- it is what makes the "both halves" claim measurable here.
 */
test("handcuff coupling is CONNECTED, and only together with benching the DNP -- each half alone is inert", () => {
  const ts = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), true));
  const b = baseFor(ts);
  const off = simulateSeasons(ts, weeks, vm, b);
  const couplingOnly = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: RATIOS });
  const both = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: RATIOS, benchDrawnZeros: true });
  assert.deepEqual(couplingOnly, off,
    "the coupling alone moved the number IN THIS FIXTURE, where the backup can never out-rank the lead for the one RB slot -- so either he started after all or the re-timing leaked into a week he did not play");
  assert.ok(both[0].meanPoints > off[0].meanPoints,
    `both halves did not raise the handcuffed roster's points: ${both[0].meanPoints} vs ${off[0].meanPoints}`);
});

/**
 * ATTRIBUTION. Benching the DNP raises points on its OWN (any replacement beats a zero), so the
 * test above cannot tell whose gain it is. This isolates the coupling's marginal contribution on top
 * of benching -- the part that is about dependence rather than about not starting a dead man.
 */
test("the coupling adds value ON TOP of benching the DNP -- the dependence is doing work, not just the availability fix", () => {
  const ts = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), true));
  const b = { ...baseFor(ts), benchDrawnZeros: true };
  const benchOnly = simulateSeasons(ts, weeks, vm, b);
  const both = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: RATIOS });
  assert.ok(both[0].meanPoints > benchOnly[0].meanPoints,
    `the coupling added nothing once the DNP was benched: ${both[0].meanPoints} vs ${benchOnly[0].meanPoints}`);
});

/**
 * SCOPE. The predicate has to be able to say NO, or "it fired" proves nothing: a coupling that
 * elevated every same-position backup regardless of NFL team would pass the connectedness test above
 * while modelling something that does not exist.
 */
test("FAULT: a same-position backup on a DIFFERENT NFL team is not coupled", () => {
  const ts = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), true));
  // Move every backup off his lead's NFL team. Nothing else about the roster changes.
  const stranger = ts.map((t) => ({ ...t, roster: t.roster.map((p) => (p.name.endsWith("b") ? { ...p, team: "ZZZ" } : p)) }));
  // benchDrawnZeros ON in BOTH arms: with it off the coupling is inert for everyone and this test
  // would pass whether or not the NFL-team scoping works.
  const b = { ...baseFor(stranger), benchDrawnZeros: true };
  const off = simulateSeasons(stranger, weeks, vm, b);
  const on = simulateSeasons(stranger, weeks, vm, { ...b, handcuffCoupling: RATIOS });
  assert.deepEqual(on, off, "a backup on an unrelated NFL team was coupled to our starter");
});

/**
 * DIRECTION. A ratio BELOW 1 means "the backup does worse when the lead is out", which is the
 * opposite of a handcuff. It is not a supported setting, and the guard is `R > 1` -- so it must be
 * inert rather than quietly applying a backwards coupling.
 */
test("FAULT: a ratio below 1.0 is inert, not a backwards coupling", () => {
  const ts = Array.from({ length: 8 }, (_, i) => mk(String(i + 1), true));
  const b = { ...baseFor(ts), benchDrawnZeros: true };
  const off = simulateSeasons(ts, weeks, vm, b);
  const backwards = simulateSeasons(ts, weeks, vm, { ...b, handcuffCoupling: { QB: 0.5, RB: 0.5, WR: 0.5, TE: 0.5 } });
  assert.deepEqual(backwards, off, "a sub-1 ratio was applied instead of being refused");
});
