// PHASE 0 of the progressive-projection experiment -- the GUILLOTINE, unit half.
//
// Before any progressive model exists, prove the two contracts the whole experiment rests on, on a
// synthetic world where the answer is computed by hand (no store):
//   1. A better projection produces a better DECISION the realized scorer can SEE (positive control):
//      an oracle that knows rest-of-season actuals adds the breakout FA where the frozen line adds the
//      bust, and its roster scores strictly more.
//   2. The decision depends on the projector's RANKING only, and the projector is truly wired into the
//      policy -- an affine transform of the frozen line changes nothing; a constant collapses to
//      stand-pat; swapping projectors changes which player is added.
// The STATISTICAL controls (noise & shuffle must not beat frozen over real seasons) live in the
// integration runner scripts/inseason-backtest-projection.mjs, which needs the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realizedRestOfSeason, type DecisionState, type ScoreCtx, type SeasonFuture, type DecisionMember } from "../src/inseason/backtest/harness.js";
import { waiverByProjection } from "../src/inseason/backtest/policies.js";
import { frozenProjector, makeNoiseProjector, type Projector } from "../src/inseason/backtest/projectors.js";

const TEMPLATE = ["RB", "FLEX", "BE"];
const FLEX = new Set(["RB", "WR", "TE"]);

// Roster: a starter RB, a starter-ish WR, and a low bench WR (the frozen-lowest legal drop).
const ROSTER: DecisionMember[] = [
  { playerSk: "rb1", name: "RB1", pos: "RB", proj: 15 },
  { playerSk: "wr1", name: "WR1", pos: "WR", proj: 10 },
  { playerSk: "wr2", name: "WR2", pos: "WR", proj: 4 },
];
// Two free agents where the frozen line and the truth DISAGREE: faA looks best (proj 12) but busts
// (actual 3); faB looks worse (proj 8) but breaks out (actual 14).
const FREE_AGENTS: DecisionMember[] = [
  { playerSk: "faA", name: "FA-A", pos: "WR", proj: 12 },
  { playerSk: "faB", name: "FA-B", pos: "WR", proj: 8 },
];
const state: DecisionState = { season: 2025, week: 3, teamId: "t", roster: ROSTER, freeAgents: FREE_AGENTS, template: TEMPLATE, flexOk: FLEX };

// Truth: rest-of-season per-game actuals. faB is the breakout, faA the bust.
const ACTUAL: Record<string, number> = { rb1: 15, wr1: 10, wr2: 4, faA: 3, faB: 14 };
const fakeOracle: Projector = (m) => ACTUAL[m.playerSk] ?? 0;

// Future: every player scores his actual mean each week, weeks 3..4, all available.
function future(): SeasonFuture {
  const f: SeasonFuture = new Map();
  for (const sk of Object.keys(ACTUAL)) {
    const m = new Map<number, { pts: number; bye: boolean; out: boolean }>();
    for (let w = 3; w <= 4; w++) m.set(w, { pts: ACTUAL[sk], bye: false, out: false });
    f.set(sk, m);
  }
  return f;
}
const ctx: ScoreCtx = { season: 2025, fromWeek: 3, toWeek: 4, template: TEMPLATE, flexOk: FLEX, future: future() };

const skOf = (r: DecisionMember[]) => new Set(r.map((m) => m.playerSk));

test("POSITIVE CONTROL: the oracle adds the breakout, frozen adds the bust, and the harness sees it", () => {
  const frozen = waiverByProjection(frozenProjector).apply(state).roster;
  const oracle = waiverByProjection(fakeOracle).apply(state).roster;
  assert.ok(skOf(frozen).has("faA") && !skOf(frozen).has("faB"), "frozen ranks faA (proj 12) best and adds him");
  assert.ok(skOf(oracle).has("faB") && !skOf(oracle).has("faA"), "oracle knows faB breaks out and adds him instead");
  const frozenPts = realizedRestOfSeason(frozen, ctx); // RB1(15)+FLEX max(WR1 10, faA 3)=WR1 -> 25/wk -> 50
  const oraclePts = realizedRestOfSeason(oracle, ctx); // RB1(15)+FLEX max(WR1 10, faB 14)=faB -> 29/wk -> 58
  assert.equal(frozenPts, 50);
  assert.equal(oraclePts, 58);
  assert.ok(oraclePts - frozenPts === 8, "the better projection is worth exactly the +8 the breakout adds at FLEX");
});

test("WIRING: swapping the projector changes which player is added (projOf drives the add)", () => {
  const addedBy = (p: Projector) => [...skOf(waiverByProjection(p).apply(state).roster)].find((sk) => !skOf(ROSTER).has(sk));
  assert.equal(addedBy(frozenProjector), "faA");
  assert.equal(addedBy(fakeOracle), "faB");
  assert.notEqual(addedBy(frozenProjector), addedBy(fakeOracle), "if projOf were ignored these would match");
});

test("RANKING-INVARIANCE: an affine transform of the frozen line makes the identical decision", () => {
  const scaled: Projector = (m) => m.proj * 2.5 + 7; // order-preserving
  const a = skOf(waiverByProjection(frozenProjector).apply(state).roster);
  const b = skOf(waiverByProjection(scaled).apply(state).roster);
  assert.deepEqual([...a].sort(), [...b].sort(), "a positive affine transform preserves ranking -> same roster");
});

test("GUARD: a constant projection sees no improvement and stands pat", () => {
  const flat: Projector = () => 5;
  const r = waiverByProjection(flat).apply(state).roster;
  assert.deepEqual([...skOf(r)].sort(), [...skOf(ROSTER)].sort(), "p(best) <= p(worst) => no add, roster unchanged");
});

test("NOISE control is deterministic and in a plausible fantasy range", () => {
  const noise = makeNoiseProjector(1);
  const a = noise(FREE_AGENTS[0], 2025, 3), b = noise(FREE_AGENTS[0], 2025, 3);
  assert.equal(a, b, "same key -> same value (CRN-safe, no Math.random)");
  for (const m of [...ROSTER, ...FREE_AGENTS]) {
    const v = noise(m, 2025, 3);
    assert.ok(v >= 0 && v < 18, `noise projection ${v} must sit in ~0..18 ppg to compete on scale`);
  }
});
