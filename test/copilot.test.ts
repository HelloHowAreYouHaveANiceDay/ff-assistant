/**
 * THE IN-SEASON DECISION SURFACE, tested on a fixture league.
 *
 * The functions in src/inseason/copilot.ts take a `SimContext` and nothing else, which is what makes
 * this file possible: the whole surface runs here with no store, no app and no live league. The
 * fixture below is a real 16-team league driven by the real `simulateSeasons`, not a mock -- a test
 * that mocks the simulator would prove only that the arithmetic between the mock and the assertion
 * is consistent, which is the failure mode this repo has hit at three different layers.
 *
 * EVERY GUARD IS FAULT-INJECTED. A guard that has never been seen to fail is indistinguishable from
 * a guard that cannot fire, and the second kind reads exactly like a passing test. So for each one
 * there is a paired case that MUST fail, and for each predicate a case that must return its POSITIVE
 * value against something real -- a guard that can only ever say "no" is dead code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateSeasons, type SeasonTeamInput, type VarianceModel, type SeasonOdds } from "../src/draft/season.js";
import { buildSchedule } from "../src/draft/schedule.js";
import type { SimContext } from "../src/draft/simContext.js";
import {
  seasonOdds, oddsInvariants, lineupRecommend, assertStartersAvailable, unavailableReason,
  waiverTargets, tradeCheck, tradeFinder, handcuffs, depthRisk, powerRankings, playoffSos,
  marketRatings, faabFor, noiseFloorPp, normalizeStatus, defaultProvenance,
  type AvailabilityMap, type GameRow,
} from "../src/inseason/copilot.js";

const SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE", "BE"];
const FLEX_OK = ["RB", "WR", "TE"];
const vm: VarianceModel = {
  tiers: 4,
  unfitted: ["K", "DST"],
  pos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, {
    cv: [0.6, 0.9, 1.2, 1.3], avail: [0.9, 0.75, 0.5, 0.3], skew: [0.5, 0.8, 1.0, 1.0], fitted: p !== "K" && p !== "DST",
  }])),
} as unknown as VarianceModel;

/**
 * FIXTURE NAMES ARE ALPHABETIC ON PURPOSE.
 *
 * `nameKey` strips every character that is not a letter, so a fixture full of names like RB250-3
 * collapses to the single key "rb" and every player in the league resolves to the same man. Not a quirk
 * to work around -- it is the real key the store uses, and a fixture that dodges it would be testing
 * a lookup the product does not have. The first draft of this file used numeric tags and produced
 * four green tests that were all resolving the wrong player.
 */
const TIER = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
const TEAM_TAG = "ABCDEFGHIJKLMNOP".split("");

/** A 12-man roster in the league's own shape, with a bye on the QB so the availability path has
 *  something real to bite on. `mult` scales the whole roster, which is how a "strong" team is made. */
function roster(tag: string, mult = 1, qbBye: number | null = 6): SeasonTeamInput["roster"] {
  const spec: [string, number, number | null][] = [
    ["QB", 300, qbBye], ["RB", 250, null], ["RB", 200, 9], ["WR", 240, null], ["WR", 210, null],
    ["WR", 180, 7], ["TE", 150, null], ["K", 120, null], ["DST", 110, null],
    ["RB", 90, null], ["WR", 85, null], ["TE", 80, null],
  ];
  return spec.map(([pos, pts, bye], i) => ({ name: `${pos} ${TIER[i]} ${tag}`, pos, proj: pts * mult, team: `NFL${tag}`, bye }));
}
/** The store's key, reproduced here so the fixture's board and ownership are keyed the way
 *  `loadSimContext` keys them -- by player_id, which IS the name key. */
const key = (s: string): string => s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");

/** A whole fixture league as a SimContext -- the same object `loadSimContext` hands the real callers,
 *  built from the real simulator so nothing here is testing a stand-in. */
function fixtureCtx(opts: { strong?: number; mult?: number; meIdx?: number; synthetic?: boolean } = {}): SimContext {
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
  const mkOpts = (trials: number, seed: number) => ({
    weeks: weeks.length, playoffTeams: 7, slots: SLOTS, flexOk: FLEX_OK, projSd: 0.30,
    replacement: { QB: 8, RB: 5, WR: 5, TE: 4, K: 7, DST: 6 }, trials, seed,
  });
  return {
    teams, weeks, meIdx, season: 2026, syntheticSchedule: opts.synthetic ?? true,
    board, ownedIds, slots: SLOTS, flexOk: FLEX_OK,
    replacement: { QB: 8, RB: 5, WR: 5, TE: 4, K: 7, DST: 6 },
    opts: mkOpts,
    run: (t, trials, seed) => simulateSeasons(t, weeks, vm, mkOpts(trials, seed)),
    clone: (t) => (t ?? teams).map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) })),
  };
}

// =============================================================================================
// SEASON ODDS
// =============================================================================================

test("season odds: every team is returned, ours is flagged, and the conservation laws hold", () => {
  const ctx = fixtureCtx();
  const r = seasonOdds(ctx, { trials: 400, seed: 11 });
  assert.equal(r.teams.length, 16);
  assert.equal(r.teams.filter((t) => t.us).length, 1, "exactly one team is ours");
  assert.equal(r.us.id, ctx.teams[ctx.meIdx].id);
  assert.ok(r.invariants.every((c) => c.ok), JSON.stringify(r.invariants));
  assert.equal(r.playoffTeams, 7);
});

test("season odds: title shares sum to 1.0 and playoff shares to the playoff field", () => {
  const ctx = fixtureCtx();
  const r = seasonOdds(ctx, { trials: 400, seed: 11 });
  const titles = r.teams.reduce((a, t) => a + t.champion, 0);
  const playoffs = r.teams.reduce((a, t) => a + t.playoffs, 0);
  assert.ok(Math.abs(titles - 1) < 0.02, `titles sum ${titles}`);
  assert.ok(Math.abs(playoffs - r.playoffTeams) < 0.05, `playoff shares sum ${playoffs}, want ${r.playoffTeams}`);
});

test("FAULT: the conservation check FAILS on a table where two champions are crowned per season", () => {
  const doctored: SeasonOdds[] = Array.from({ length: 16 }, (_, i) => ({
    id: String(i), name: `T${i}`, playoffs: 7 / 16, champion: 2 / 16, meanWins: 7, meanPoints: 1000,
  }));
  const checks = oddsInvariants(doctored, 7, 112);
  const titles = checks.find((c) => c.name.includes("champion"))!;
  assert.equal(titles.ok, false, "two champions per season compared equal to one -- the guard cannot fire");
  assert.equal(checks.find((c) => c.name.includes("playoff"))!.ok, true, "the playoff law should still pass -- this is a per-law check, not a per-table mute");
});

test("FAULT: seasonOdds REFUSES to return a table that violates a conservation law", () => {
  const ctx = fixtureCtx();
  // A simulator that returns a plausible-looking but impossible table. Nothing else about the
  // context changes, so this isolates the refusal from every other failure mode.
  const broken: SimContext = { ...ctx, run: () => ctx.teams.map((t) => ({ id: t.id, name: t.name, playoffs: 0.44, champion: 0.5, meanWins: 7, meanPoints: 1000 })) };
  assert.throws(() => seasonOdds(broken, { trials: 10 }), /conservation law/i);
});

test("season odds: assumptions travel with the number, and say which schedule produced it", () => {
  const gen = seasonOdds(fixtureCtx({ synthetic: true }), { trials: 200, seed: 3 });
  const real = seasonOdds(fixtureCtx({ synthetic: false }), { trials: 200, seed: 3 });
  assert.equal(gen.assumptions.schedule, "generated");
  assert.equal(real.assumptions.schedule, "real");
  assert.equal(gen.assumptions.basis, "simulation");
  assert.equal(gen.assumptions.trials, 200);
  assert.deepEqual(gen.assumptions.seeds, [3]);
  assert.ok(Date.parse(gen.assumptions.asOf) > 0, "asOf is not a parseable timestamp");
});

test("provenance passed in is the provenance returned -- the stamp is not regenerated or dropped", () => {
  const ctx = fixtureCtx();
  const prov = { season: 1999, boardRows: 7, varianceSeasons: 3, sampler: "fixture", projectionArtifact: "test@now" };
  const r = seasonOdds(ctx, { trials: 200, provenance: prov });
  assert.deepEqual(r.assumptions.artifact, prov);
  assert.deepEqual(defaultProvenance(ctx).season, 2026);
});

// =============================================================================================
// LINEUP
// =============================================================================================

const noAvail: AvailabilityMap = new Map();

test("lineup: a player on bye THIS WEEK is benched with the reason named", () => {
  const ctx = fixtureCtx();
  const r = lineupRecommend(ctx, 6, { availability: noAvail });
  const qb = ctx.teams[0].roster.find((p) => p.pos === "QB")!;
  assert.ok(!r.starters.some((s) => s.name === qb.name), "the bye QB was started");
  assert.ok(r.unavailable.some((u) => u.name === qb.name && /bye week 6/.test(u.reason)), JSON.stringify(r.unavailable));
});

test("POSITIVE CONTROL: the same QB IS started in a week he is not on bye -- the bye lever is connected", () => {
  const ctx = fixtureCtx();
  const qb = ctx.teams[0].roster.find((p) => p.pos === "QB")!;
  const r = lineupRecommend(ctx, 5, { availability: noAvail });
  assert.ok(r.starters.some((s) => s.name === qb.name), "the QB is not on bye in week 5 and should start");
  assert.equal(r.unavailable.length, 0);
});

test("lineup: a player the store rules OUT is benched; QUESTIONABLE is still startable", () => {
  const ctx = fixtureCtx();
  const rb = ctx.teams[0].roster.find((p) => p.pos === "RB" && p.proj === 250)!;
  const wr = ctx.teams[0].roster.find((p) => p.pos === "WR" && p.proj === 240)!;
  const avail: AvailabilityMap = new Map([
    [rb.name.toLowerCase().replace(/[^a-z]/g, ""), { status: "OUT" as const, source: "player_status", detail: "Knee" }],
    [wr.name.toLowerCase().replace(/[^a-z]/g, ""), { status: "QUESTIONABLE" as const, source: "player_status", detail: "Foot" }],
  ]);
  const r = lineupRecommend(ctx, 5, { availability: avail });
  assert.ok(!r.starters.some((s) => s.name === rb.name), "an OUT player was started");
  assert.ok(r.starters.some((s) => s.name === wr.name), "a QUESTIONABLE player was benched -- he plays more often than not");
});

test("FAULT: a lineup that starts a player on bye is REFUSED", () => {
  const ctx = fixtureCtx();
  const rosterOf = ctx.teams[0].roster;
  const qb = rosterOf.find((p) => p.pos === "QB")!;   // bye 6
  assert.throws(
    () => assertStartersAvailable([{ name: qb.name }], rosterOf, 6, noAvail),
    /cannot play in week 6/,
    "a starter on bye compared equal to a legal lineup -- the guard cannot fire",
  );
  // ... and the same lineup in a week he is NOT on bye must pass, or the guard is just always-throw.
  assert.doesNotThrow(() => assertStartersAvailable([{ name: qb.name }], rosterOf, 5, noAvail));
});

test("FAULT: a lineup that starts a player the store rules OUT is REFUSED", () => {
  const ctx = fixtureCtx();
  const rosterOf = ctx.teams[0].roster;
  const rb = rosterOf.find((p) => p.pos === "RB" && p.proj === 250)!;
  const key = rb.name.toLowerCase().replace(/[^a-z]/g, "");
  const avail: AvailabilityMap = new Map([[key, { status: "OUT" as const, source: "player_status", detail: "Achilles" }]]);
  assert.throws(() => assertStartersAvailable([{ name: rb.name }], rosterOf, 5, avail), /cannot play in week 5/);
  assert.doesNotThrow(() => assertStartersAvailable([{ name: rb.name }], rosterOf, 5, noAvail));
});

test("unavailableReason is null for a healthy man in a week he plays -- the predicate can say YES", () => {
  const ctx = fixtureCtx();
  const rb = ctx.teams[0].roster.find((p) => p.pos === "RB" && p.proj === 250)!;
  assert.equal(unavailableReason(rb, 5, noAvail), null);
});

test("status normalization: OUT/IR/PUP are unstartable, QUESTIONABLE and ACTIVE are not", () => {
  for (const s of ["Out", "IR", "PUP", "Suspension", "Doubtful", "dnr"]) assert.equal(normalizeStatus(s), "OUT", s);
  assert.equal(normalizeStatus("Questionable"), "QUESTIONABLE");
  assert.equal(normalizeStatus("Active"), "ACTIVE");
  assert.equal(normalizeStatus(null), "ACTIVE");
});

test("lineup: assumptions say the basis is a PROJECTION, not a simulated probability", () => {
  const r = lineupRecommend(fixtureCtx(), 5, {});
  assert.equal(r.assumptions.basis, "projection");
  assert.equal(r.assumptions.trials, null);
  assert.equal(r.assumptions.seeds, null);
});

// =============================================================================================
// WAIVERS
// =============================================================================================

test("waivers: a strong free-agent add scores a POSITIVE title delta -- the lever is connected", () => {
  // Our roster is weakened at RB so a 230-point back is a real upgrade rather than a bench body.
  const ctx = fixtureCtx();
  ctx.teams[0].roster = ctx.teams[0].roster.map((p) => p.pos === "RB" ? { ...p, proj: 60 } : p);
  const r = waiverTargets(ctx, { trials: 400, seeds: [7, 101], adds: 1, dropsPerAdd: 3, positions: ["RB"] });
  assert.equal(r.targets.length, 1, JSON.stringify(r));
  assert.equal(r.targets[0].add, "Free Runner");
  assert.ok(r.targets[0].deltaPp > 0, `a 230-pt back added to a roster of 60-pt backs measured ${r.targets[0].deltaPp}pp`);
});

test("FAULT: waivers REFUSE a drop that leaves the roster unable to fill a mandatory slot", () => {
  const ctx = fixtureCtx();
  const r = waiverTargets(ctx, { trials: 200, seeds: [7], adds: 1, dropsPerAdd: 12, positions: ["RB"] });
  const k = ctx.teams[0].roster.find((p) => p.pos === "K")!;
  const refusedK = r.refused.find((x) => x.drop === k.name);
  assert.ok(refusedK, `dropping the only kicker was scored rather than refused: ${JSON.stringify(r.refused)}`);
  assert.match(refusedK.why, /K/, refusedK.why);
  // And it is a PER-DROP refusal, not a per-add mute: other drops on the same add were still scored.
  assert.ok((r.targets[0]?.drops.length ?? 0) > 0, "refusing one drop silenced every drop for that add");
  assert.ok(!r.targets[0].drops.some((d) => d.name === k.name), "the refused drop still appears as a scored option");
});

test("FAAB guidance is zero for a non-positive delta and scales with it, capped at half the budget", () => {
  assert.equal(faabFor(0, 100), 0);
  assert.equal(faabFor(-2, 100), 0);
  assert.equal(faabFor(1, 100), 10);
  assert.equal(faabFor(50, 100), 50, "the cap did not bind");
  assert.ok(faabFor(2, 100) > faabFor(1, 100), "FAAB does not respond to the size of the edge");
});

test("the noise floor is positive, shrinks with trials, and is returned beside the ranking", () => {
  assert.ok(noiseFloorPp(6, 400) > noiseFloorPp(6, 4000), "more trials did not narrow the floor");
  assert.ok(noiseFloorPp(6, 400) > 0);
  const r = waiverTargets(fixtureCtx(), { trials: 200, seeds: [7], adds: 1, dropsPerAdd: 2, positions: ["WR"] });
  assert.ok(r.noiseFloorPp > 0);
  assert.equal(typeof r.targets[0]?.clearsNoise, "boolean");
});

// =============================================================================================
// TRADES
// =============================================================================================

test("trade check: a lopsided deal helps us and hurts them, and both sides are reported", () => {
  const ctx = fixtureCtx();
  // Team 1 is given a monster back; we ask for him and offer our worst receiver.
  ctx.teams[1].roster = ctx.teams[1].roster.map((p) => p.name === "RB Bravo B" ? { ...p, proj: 600 } : p);
  const r = tradeCheck(ctx, { give: ["WR Kilo A"], get: ["RB Bravo B"] }, { trials: 600, seeds: [7, 101] });
  assert.equal(r.them.teamId, "1");
  assert.ok(r.us.deltaPp > 0, `robbing team 1 measured ${r.us.deltaPp}pp for us`);
  assert.ok(r.them.deltaPp < 0, `the victim gained ${r.them.deltaPp}pp`);
  assert.equal(r.mutual, false);
  assert.ok(r.us.legal && r.them.legal);
});

test("FAULT: the title delta FLIPS SIGN when the same offer is scored from the other seat", () => {
  // The decisive test that the delta is measuring the trade and not the seat. Same league, same
  // players, same seeds -- only which team is "us" changes, and the answer must invert.
  const mk = (meIdx: number) => {
    const c = fixtureCtx({ meIdx });
    c.teams[1].roster = c.teams[1].roster.map((p) => p.name === "RB Bravo B" ? { ...p, proj: 600 } : p);
    return c;
  };
  const ours = tradeCheck(mk(0), { give: ["WR Kilo A"], get: ["RB Bravo B"] }, { trials: 600, seeds: [7, 101] });
  const theirs = tradeCheck(mk(1), { give: ["RB Bravo B"], get: ["WR Kilo A"] }, { trials: 600, seeds: [7, 101] });
  assert.ok(ours.us.deltaPp > 0, `expected a gain, got ${ours.us.deltaPp}`);
  assert.ok(theirs.us.deltaPp < 0, `the same deal from the other seat also gained (${theirs.us.deltaPp}) -- the delta is not measuring the trade`);
  assert.ok(Math.sign(ours.us.deltaPp) !== Math.sign(theirs.us.deltaPp), "the sign did not flip");
});

test("trade check refuses an offer whose sides are not one roster each, or are ours on both sides", () => {
  const ctx = fixtureCtx();
  assert.throws(() => tradeCheck(ctx, { give: ["WR Kilo A"], get: ["RB Bravo B", "RB Bravo C"] }, { trials: 50 }), /one counterparty/);
  assert.throws(() => tradeCheck(ctx, { give: ["RB Bravo B"], get: ["RB Bravo C"] }, { trials: 50 }), /not on OUR roster/);
  assert.throws(() => tradeCheck(ctx, { give: [], get: ["RB Bravo B"] }, { trials: 50 }), /at least one player/);
  assert.throws(() => tradeCheck(ctx, { give: ["WR Kilo A"], get: ["Nobody At All"] }, { trials: 50 }), /nobody's roster/);
});

test("trade finder: gates on CONSENSUS VALUE first -- a lopsided pair never reaches the simulator", () => {
  const ctx = fixtureCtx();
  const values = new Map<string, number>();
  const k = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const t of ctx.teams) for (const p of t.roster) values.set(k(p.name), Math.round(p.proj * 10));
  // Balanced band: our WR85 (850) can only be paired with players within 15%.
  const r = tradeFinder(ctx, { values, trials: 200, seed: 7, limit: 6, maxGap: 0.15 });
  assert.ok(r.candidates > 0, "no balanced pair at all -- the fixture cannot exercise this");
  for (const idea of r.ideas) {
    assert.ok(idea.valueGap <= 0.15 + 1e-9, `${idea.give} -> ${idea.get} gap ${idea.valueGap} passed a 0.15 band`);
  }
  assert.ok(!r.ideas.some((i) => i.give === "WR Kilo A" && i.get === "QB Alpha B"), "a 850-vs-3000 pair was proposed");
});

test("FAULT: widening the value band ADMITS pairs the narrow band refused -- the gate is connected", () => {
  const ctx = fixtureCtx();
  const values = new Map<string, number>();
  const k = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const t of ctx.teams) for (const p of t.roster) values.set(k(p.name), Math.round(p.proj * 10));
  const tight = tradeFinder(ctx, { values, trials: 100, limit: 1, maxGap: 0.02 });
  const wide = tradeFinder(ctx, { values, trials: 100, limit: 1, maxGap: 0.90 });
  assert.ok(wide.candidates > tight.candidates, `wide ${wide.candidates} did not exceed tight ${tight.candidates} -- maxGap does nothing`);
});

test("trade finder reports players it has no consensus value for rather than valuing them at zero", () => {
  const ctx = fixtureCtx();
  const r = tradeFinder(ctx, { values: new Map(), trials: 50, limit: 1 });
  assert.equal(r.candidates, 0);
  assert.equal(r.skippedNoValue, ctx.teams[0].roster.length, "unvalued players were silently priced, not skipped");
});

// =============================================================================================
// DEPTH RISK / HANDCUFFS / POWER RANKINGS
// =============================================================================================

test("depth risk: losing a star costs more than losing a bench body, and cost is POSITIVE", () => {
  const ctx = fixtureCtx();
  const star = depthRisk(ctx, "RB Bravo A", { trials: 500, seeds: [7, 101], insurers: 2 });
  const scrub = depthRisk(ctx, "TE Lima A", { trials: 500, seeds: [7, 101], insurers: 2 });
  assert.ok(star.costPp > 0, `losing our best back measured a cost of ${star.costPp}pp`);
  assert.ok(star.costPp > scrub.costPp, `star ${star.costPp}pp vs bench TE ${scrub.costPp}pp -- the metric cannot tell them apart`);
  assert.equal(star.player.name, "RB Bravo A");
});

test("depth risk: insurance candidates include free agents, and each recovers a measurable amount", () => {
  const ctx = fixtureCtx();
  const r = depthRisk(ctx, "RB Bravo A", { trials: 400, seeds: [7], insurers: 4 });
  assert.ok(r.insurance.length > 0);
  assert.ok(r.insurance.some((i) => i.free), `no free agent among ${JSON.stringify(r.insurance.map((i) => i.name))}`);
  assert.ok(r.insurance[0].recoversPp >= r.insurance[r.insurance.length - 1].recoversPp, "insurance is not ranked by what it recovers");
});

test("depth risk refuses a player who is not ours", () => {
  assert.throws(() => depthRisk(fixtureCtx(), "RB Bravo D", { trials: 50 }), /not on our roster/);
});

test("handcuffs: rows carry whether the man is already OURS and whether anyone rosters him", () => {
  const ctx = fixtureCtx();
  const depth = [
    { name: "RB Bravo A", pos: "RB", team: "NFLA", depthOrder: 1, projPts: 250, rosteredPct: 99, poolRank: 0 },
    { name: "RB Charlie A", pos: "RB", team: "NFLA", depthOrder: 2, projPts: 200, rosteredPct: 40, poolRank: 5 },
    { name: "Free Runner", pos: "RB", team: "NFLA", depthOrder: 3, projPts: 230, rosteredPct: 2, poolRank: 2 },
  ];
  const r = handcuffs(ctx, { depth, vm, weeks: 12, positions: ["RB"], poolSize: { RB: 40 } });
  assert.ok(r.rows.length > 0);
  const ours = r.rows.find((x) => x.name === "RB Charlie A");
  assert.ok(ours?.ours, "a player on our own roster was not flagged as ours");
  const free = r.rows.find((x) => x.name === "Free Runner");
  assert.equal(free?.rostered, false, "an unrostered free agent was flagged as rostered");
  // FAULT for the freeOnly filter: it must actually remove the rostered rows, not just reorder them.
  const freeOnly = handcuffs(ctx, { depth, vm, weeks: 12, positions: ["RB"], poolSize: { RB: 40 }, freeOnly: true });
  assert.ok(freeOnly.rows.length < r.rows.length, "freeOnly removed nothing");
  assert.ok(freeOnly.rows.every((x) => !x.rostered));
});

test("power rankings: a doubled roster ranks first and carries the highest title odds", () => {
  const ctx = fixtureCtx({ strong: 3, mult: 2 });
  const r = powerRankings(ctx, { trials: 400, seed: 11 });
  assert.equal(r.rows[0].teamId, "3", JSON.stringify(r.rows.slice(0, 3)));
  assert.equal(r.rows[0].titlePct, Math.max(...r.rows.map((x) => x.titlePct)));
  assert.equal(r.rows.filter((x) => x.us).length, 1);
  assert.equal(r.ourRank, r.rows.findIndex((x) => x.us) + 1);
  assert.ok(r.leagueMeanStartPts > 0);
});

// =============================================================================================
// PLAYOFF SOS
// =============================================================================================

/**
 * A four-team league with KNOWN true ratings, whose posted lines are generated from them.
 *
 * The rotation matters and the first version of this fixture got it wrong: with GOOD playing WEAK
 * and nobody else, every week, the solver's update is a two-cycle -- each team's estimate is exactly
 * the negative of the other's previous one -- so it oscillates forever and lands on zero for
 * everybody after an even number of iterations. That produced a "ratings are all zero" failure that
 * looked like a bug in the solver and was a bug in the fixture. Rotating the pairings gives every
 * team three different opponents, which is what makes the averaging converge -- and is what a real
 * NFL schedule looks like.
 *
 * Weeks 15-17 are then pinned deliberately: GOOD faces WEAK (an easy playoff run) and WEAK faces
 * GOOD (a hard one), which is the thing playoff SOS exists to detect.
 */
const TRUE_RATING: Record<string, number> = { GOOD: 6, MID: 2, OTH: -2, WEAK: -6 };
const ROTATION: [string, string][][] = [
  [["GOOD", "MID"], ["OTH", "WEAK"]],
  [["GOOD", "OTH"], ["MID", "WEAK"]],
  [["GOOD", "WEAK"], ["MID", "OTH"]],
];
const sosGames = (): GameRow[] => {
  const g: GameRow[] = [];
  const push = (week: number, home: string, away: string) => {
    // The market's expected margin for a team is -spread_line, and equals its rating edge plus the
    // 1.0-point home field the solver assumes.
    const edge = TRUE_RATING[home] - TRUE_RATING[away] + 1;
    g.push({ week, team: home, opponent: away, home: 1, spread_line: -edge });
    g.push({ week, team: away, opponent: home, home: 0, spread_line: edge });
  };
  for (let w = 1; w <= 14; w++) for (const [h, a] of ROTATION[w % 3]) push(w, h, a);
  for (let w = 15; w <= 17; w++) { push(w, "GOOD", "WEAK"); push(w, "MID", "OTH"); }
  return g;
};

test("market ratings: the solver recovers the ordering the posted lines were generated from", () => {
  const r = marketRatings(sosGames());
  const got = ["GOOD", "MID", "OTH", "WEAK"].map((t) => r.get(t) ?? 0);
  assert.deepEqual([...got].sort((a, b) => b - a), got, `ratings out of order: ${JSON.stringify([...r])}`);
  assert.ok((r.get("GOOD") ?? 0) - (r.get("WEAK") ?? 0) > 8,
    `GOOD-WEAK gap ${((r.get("GOOD") ?? 0) - (r.get("WEAK") ?? 0)).toFixed(2)}, true gap is 12`);
  assert.ok(Math.abs(got.reduce((a, b) => a + b, 0)) < 1e-6, "ratings are not centred on league average");
});

test("FAULT: with no posted lines every rating is zero -- the solver reads the lines, not the names", () => {
  const flat = sosGames().map((g) => ({ ...g, spread_line: null }));
  const r = marketRatings(flat);
  for (const [t, v] of r) assert.ok(Math.abs(v) < 1e-9, `${t} rated ${v} with nothing priced`);
});

test("playoff SOS: a player on the team facing GOOD in weeks 15-17 has a harder schedule than one facing WEAK", () => {
  const ctx = fixtureCtx();
  const players = [
    { name: "A", pos: "WR", proj: 200, team: "WEAK" },   // faces GOOD -- hard
    { name: "B", pos: "WR", proj: 200, team: "GOOD" },   // faces WEAK -- easy
  ] as unknown as { name: string; pos: string; proj: number }[];
  const r = playoffSos(ctx, { games: sosGames(), regWeeks: 14, players });
  const a = r.players.find((p) => p.name === "A")!;
  const b = r.players.find((p) => p.name === "B")!;
  assert.deepEqual(r.playoffWeeks, [15, 16, 17]);
  assert.ok((a.sos ?? 0) > (b.sos ?? 0), `A ${a.sos} should face tougher opponents than B ${b.sos}`);
  assert.ok((a.costPerWeek ?? 0) > 0 && (b.costPerWeek ?? 0) < 0, "the measured cost does not follow the SOS sign");
  assert.equal(r.assumptions.basis, "market");
});

test("playoff SOS reports how many playoff-week games are actually priced", () => {
  const games = sosGames().map((g) => (g.week >= 15 ? { ...g, spread_line: null } : g));
  const r = playoffSos(fixtureCtx(), { games, regWeeks: 14 });
  assert.equal(r.pricedPlayoffGames, 0, "unpriced playoff weeks were counted as priced");
  assert.ok(r.playoffGames > 0);
});
