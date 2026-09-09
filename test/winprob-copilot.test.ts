/**
 * `lineupRecommend(ctx, week, { objective })` -- the seam between the copilot's reporting envelope
 * and the head-to-head search.
 *
 * THE FIRST THING ASSERTED IS THAT NOTHING SHIPPED CHANGED. The default is `expected`, and a default
 * that has quietly moved is the most expensive kind of change there is: every existing caller, every
 * MCP consumer and the desktop Assistant would start receiving a different lineup with no flag, no
 * error and no way to tell. So the no-argument call and the explicit `expected` call are compared
 * player for player, not by total.
 *
 * After that, the wiring: does the opponent come from the REAL schedule, does the refusal fire when
 * it cannot, and do the availability guards that already exist still hold on the lineup the SEARCH
 * produced rather than only on the one the optimizer produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineupRecommend, lineupNameKey, type AvailabilityMap } from "../src/inseason/copilot.js";
import type { WeeklyBand } from "../src/inseason/winprob.js";
import { nameKey } from "../src/draft/values.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";

const WEEK = 1;

/** The opponent this league's real schedule actually gives us in `week`. */
function opponentIdx(ctx: ReturnType<typeof fixtureCtx>, week: number): number {
  const pair = ctx.weeks[week - 1].find(([a, b]) => a === ctx.meIdx || b === ctx.meIdx)!;
  return pair[0] === ctx.meIdx ? pair[1] : pair[0];
}

const steadyBand = (mean: number): WeeklyBand => ({ mean, p10: Math.max(0, mean - 4), p50: mean, p90: mean + 4 });
const boomBand = (mean: number): WeeklyBand => ({ mean, p10: 0, p50: mean * 0.45, p90: mean * 2.8, pZero: 0.3 });

/**
 * A week where we are a heavy underdog and exactly one bench receiver is the tail.
 *
 * Means are supplied through `weekly` and shapes through `bands`, which is how the fixture controls
 * the trade precisely: the boom man's MEAN sits just below the starter he would replace, so the
 * expected-points lineup must bench him, and only the shape can bring him back.
 */
function underdogInputs(ctx: ReturnType<typeof fixtureCtx>) {
  const weekly = new Map<string, number>();
  const bands = new Map<string, WeeklyBand>();
  const ours = ctx.teams[ctx.meIdx].roster;
  const oppIdx = opponentIdx(ctx, WEEK);
  for (const p of ours) {
    const k = lineupNameKey(p.name);
    const mean = Math.round((p.proj / 17) * 10) / 10;
    weekly.set(k, mean);
    bands.set(k, steadyBand(mean));
  }
  // The third receiver (proj 180 -> ~10.6) and the bench receiver (proj 85 -> ~5.0). Level them, and
  // give the bench man the tail.
  const wr3 = ours.filter((p) => p.pos === "WR")[2];
  const benchWr = ours.filter((p) => p.pos === "WR")[3] ?? ours.filter((p) => p.pos === "WR")[2];
  weekly.set(lineupNameKey(wr3.name), 12);
  bands.set(lineupNameKey(wr3.name), steadyBand(12));
  weekly.set(lineupNameKey(benchWr.name), 11.5);
  bands.set(lineupNameKey(benchWr.name), boomBand(11.5));
  // The opponent, projected far ahead of us so the posture is unambiguous.
  for (const p of ctx.teams[oppIdx].roster) {
    const k = lineupNameKey(p.name);
    weekly.set(k, 13.5);
    bands.set(k, steadyBand(13.5));
  }
  return { weekly, bands, wr3: wr3.name, benchWr: benchWr.name, oppIdx };
}

test("THE DEFAULT IS UNCHANGED: no argument and `expected` are the same lineup, player for player", () => {
  const ctx = fixtureCtx();
  const a = lineupRecommend(ctx, WEEK);
  const b = lineupRecommend(ctx, WEEK, { objective: "expected" });
  assert.equal(a.objective, "expected");
  assert.deepEqual(a.starters, b.starters);
  assert.deepEqual(a.bench, b.bench);
  assert.equal(a.totalProj, b.totalProj);
  assert.equal(a.winprob, undefined, "the expected-points path must not compute a win probability nobody asked for");
});

test("`winprob` REFUSES a generated schedule rather than inventing an opponent", () => {
  const ctx = fixtureCtx({ synthetic: true });
  const { weekly, bands } = underdogInputs(ctx);
  assert.throws(
    () => lineupRecommend(ctx, WEEK, { objective: "winprob", weekly, bands }),
    /REAL schedule/,
    "a win probability against a stand-in opponent looks exactly like a real one",
  );
});

test("`winprob` names the REAL opponent and returns BOTH lineups with the P(win) of each", () => {
  const ctx = fixtureCtx({ synthetic: false });
  const { weekly, bands, oppIdx } = underdogInputs(ctx);
  const r = lineupRecommend(ctx, WEEK, { objective: "winprob", weekly, bands, winprob: { sims: 8000, seed: 5 } });

  assert.equal(r.objective, "winprob");
  assert.equal(r.winprob!.opponent, ctx.teams[oppIdx].name);
  assert.equal(r.winprob!.opponentTeamId, ctx.teams[oppIdx].id);
  assert.equal(r.winprob!.epStarters.length, r.starters.length);
  assert.ok(r.winprob!.winPct >= r.winprob!.epWinPct);
  assert.equal(r.totalProj, r.winprob!.totalProj, "the reported total must be the total of the lineup that was returned");
  // The objective block that travels on every result names which question was answered.
  assert.match(r.assumptions.objective.note, /LINEUP OBJECTIVE: winprob/);
  assert.match(lineupRecommend(ctx, WEEK, { weekly, bands }).assumptions.objective.note, /LINEUP OBJECTIVE: expected/);
});

test("HEAVY UNDERDOG through the copilot: the tail receiver starts, and expected points does not start him", () => {
  const ctx = fixtureCtx({ synthetic: false });
  const { weekly, bands, wr3, benchWr } = underdogInputs(ctx);
  const r = lineupRecommend(ctx, WEEK, { objective: "winprob", weekly, bands, winprob: { sims: 20000, seed: 5 } });

  assert.equal(r.winprob!.posture, "underdog");
  assert.ok(r.winprob!.epStarters.some((s) => s.name === wr3), "the fixture is not testing a trade: expected points already benched the steady man");
  assert.ok(!r.winprob!.epStarters.some((s) => s.name === benchWr), "the fixture is not testing a trade: expected points already starts the tail man");
  assert.ok(r.starters.some((s) => s.name === benchWr), "the win-probability lineup did not reach for the tail while trailing badly on projection");
  assert.ok(r.winprob!.swaps.length >= 1);
  assert.ok(r.winprob!.epCostPts > 0);
  // And he is off the bench in the reported bench, not on both lists.
  assert.ok(!r.bench.some((b) => b.name === benchWr));
});

test("FAULT INJECTION: with the search disabled the copilot's underdog lineup is the expected-points one", () => {
  const ctx = fixtureCtx({ synthetic: false });
  const { weekly, bands, benchWr } = underdogInputs(ctx);
  const r = lineupRecommend(ctx, WEEK, { objective: "winprob", weekly, bands, winprob: { sims: 20000, seed: 5, noSearch: true } });
  assert.ok(!r.starters.some((s) => s.name === benchWr), "noSearch still produced the swap, so the search is not what produces it");
  assert.deepEqual(r.starters, r.winprob!.epStarters);
  assert.equal(r.winprob!.swaps.length, 0);
});

test("THE AVAILABILITY GUARD STILL HOLDS on the lineup the SEARCH produced", () => {
  // Week 6 is the fixture QB's bye, and the OUT list bites the same way. If the search could seat an
  // unavailable man, `assertStartersAvailable` -- which is checked against the ROSTER and the store,
  // not against the flags the search was handed -- would refuse the whole result.
  const ctx = fixtureCtx({ synthetic: false });
  const { weekly, bands } = underdogInputs(ctx);
  const ours = ctx.teams[ctx.meIdx].roster;
  const availability: AvailabilityMap = new Map();
  const hurt = ours.filter((p) => p.pos === "WR")[3] ?? ours.filter((p) => p.pos === "WR")[2];
  // Key the availability map the way `unavailableReason` reads it -- `nameKey`, from the board.
  availability.set(nameKey(hurt.name), { status: "OUT", source: "fixture", detail: "hamstring" });

  const r = lineupRecommend(ctx, 6, { objective: "winprob", weekly, bands, availability, winprob: { sims: 4000, seed: 5 } });
  assert.ok(!r.starters.some((s) => s.name === hurt.name), "an OUT man was started by the win-probability search");
  const qb = ours.find((p) => p.bye === 6)!;
  assert.ok(!r.starters.some((s) => s.name === qb.name), "a bye-week man was started by the win-probability search");
  assert.ok(r.unavailable.some((u) => u.name === qb.name));
});
