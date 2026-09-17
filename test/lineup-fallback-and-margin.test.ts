/**
 * D33 (the fallback) and WP19's margin, on `lineupRecommend`.
 *
 * D33 -- ONE PER-WEEK STRENGTH. The lineup priced a man the weekly projector had no row for at the
 * PRESEASON line spread flat (`proj / 17`) while `src/draft/season.ts` priced the same man on the
 * same context at `rosPerGame` -- the D18 blend. Two surfaces, one context, two numbers. Both now
 * read `perGameStrength`.
 *
 * WHY THE HISTORICAL HARNESS CANNOT TEST THIS, stated because a green test on a dead lever is the
 * failure this repo keeps finding. `scripts/inseason-backtest-lineup.mjs` uses NEITHER quantity --
 * its fallback is `td_ppg` and its own header says so -- and `scripts/lineup-stress.mjs`'s D33 arms
 * report their positive control returning ZERO, because the men the projector has no row for are
 * exactly the men with no `season_line_pg` in the weekly feature table, so both fallbacks are
 * undefined for them there. In production the number comes from the BOARD, which is a different
 * table and does carry them. So the connection is proved HERE, on a context that has both.
 *
 * The margin -- see `LineupContest`. No number moves; it is what the recommendation already was,
 * said out loud, because the summary carried neither the band nor the gap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineupRecommend, lineupNameKey, NFL_WEEKS } from "../src/inseason/copilot.js";
import { perGameStrength } from "../src/draft/rosBlend.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";
import type { SimContext } from "../src/draft/simContext.js";
import type { WeeklyBand } from "../src/inseason/winprob.js";

const WEEK = 3;
const clone = (c: SimContext): SimContext =>
  ({ ...c, teams: c.teams.map((t, i) => (i === c.meIdx ? { ...t, roster: t.roster.map((p) => ({ ...p })) } : t)) });
const mine = (c: SimContext) => c.teams[c.meIdx].roster;
const projOf = (r: { starters: { name: string; proj: number }[]; bench: { name: string; proj: number }[] }, n: string) =>
  [...r.starters, ...r.bench].find((x) => x.name === n)?.proj;

// ---------------------------------------------------------------------------------------------
// perGameStrength itself -- the one function both surfaces read.
// ---------------------------------------------------------------------------------------------

test("perGameStrength returns the BLEND when the context carries one and the flat line when it does not", () => {
  assert.equal(perGameStrength({ proj: 170 }, 17), 10);
  assert.equal(perGameStrength({ proj: 170, rosPerGame: 14.5 }, 17), 14.5);
  // A non-finite blend is not a blend: fall through rather than poison the lineup with NaN.
  assert.equal(perGameStrength({ proj: 170, rosPerGame: NaN }, 17), 10);
});

// ---------------------------------------------------------------------------------------------
// D33 on the verb. NO weekly projector at all, so EVERY man is on the fallback path and the effect
// is unmissable rather than hidden in one of twelve.
// ---------------------------------------------------------------------------------------------

test("D33 CONTROL: with no rosPerGame anywhere, the lineup is exactly the pre-D33 one", () => {
  const c = clone(fixtureCtx());
  const r = lineupRecommend(c, WEEK, {});
  for (const p of mine(c)) {
    const got = projOf(r, p.name);
    if (got != null) assert.equal(got, Math.round((p.proj / NFL_WEEKS) * 100) / 100);
  }
});

test("D33 POSITIVE CONTROL: a rostered man carrying rosPerGame is priced at it, not at proj/17", () => {
  const c = clone(fixtureCtx());
  const man = mine(c)[0];                              // the QB, 300 season points -> 17.65/wk flat
  man.bye = null;
  man.rosPerGame = 25.5;                               // he has been playing well above his line
  const r = lineupRecommend(c, WEEK, {});
  assert.equal(projOf(r, man.name), 25.5);
  // ...and it is NOT what the old rule would have said, which is the half of the assertion that
  // makes it a measurement rather than a tautology.
  assert.notEqual(25.5, Math.round((man.proj / NFL_WEEKS) * 100) / 100);
});

test("D33: the blend also reaches the winprob path's fallback, not just the expected-points one", () => {
  const c = clone(fixtureCtx({ synthetic: false }));
  const man = mine(c)[0];
  man.bye = null;
  man.rosPerGame = 25.5;
  const r = lineupRecommend(c, WEEK, { objective: "winprob", winprob: { sims: 200 }, seed: 7 });
  assert.equal(projOf(r, man.name), 25.5);
});

test("D33: basisNote NAMES the men priced at the blend rather than claiming a flat season line", () => {
  const c = clone(fixtureCtx());
  const man = mine(c)[1];
  man.rosPerGame = 9.9;
  // A weekly map covering everyone EXCEPT him, so exactly one man falls back.
  const weekly = new Map(mine(c).filter((p) => p !== man).map((p) => [lineupNameKey(p.name), 11]));
  const r = lineupRecommend(c, WEEK, { weekly });
  assert.match(r.assumptions.basisNote ?? "", /REST-OF-SEASON blend/);
  assert.match(r.assumptions.basisNote ?? "", new RegExp(man.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // And the CONTROL: with no blend on the context the sentence says the other thing.
  const c2 = clone(fixtureCtx());
  const man2 = mine(c2)[1];
  const weekly2 = new Map(mine(c2).filter((p) => p !== man2).map((p) => [lineupNameKey(p.name), 11]));
  const r2 = lineupRecommend(c2, WEEK, { weekly: weekly2 });
  assert.match(r2.assumptions.basisNote ?? "", /preseason projection divided by 17/);
  assert.doesNotMatch(r2.assumptions.basisNote ?? "", /REST-OF-SEASON blend/);
});

// ---------------------------------------------------------------------------------------------
// THE MARGIN.
// ---------------------------------------------------------------------------------------------

test("every contested slot carries the margin to the best legal alternative", () => {
  const c = clone(fixtureCtx());
  const r = lineupRecommend(c, WEEK, {});
  assert.ok(r.contested.length > 0, "a 12-man roster on an 8-slot template must have contested slots");
  for (const k of r.contested) {
    // The margin is the stated arithmetic, not a number with a story attached.
    assert.ok(Math.abs(k.margin - (k.starter.proj - k.alternative.proj)) < 0.011);
    // The alternative is genuinely SITTING and the starter genuinely started.
    assert.ok(r.starters.some((s) => s.slot === k.slot && s.name === k.starter.name));
    assert.ok(r.bench.some((b) => b.name === k.alternative.name));
    // A negative margin would mean the optimizer left points on the table at that slot.
    assert.ok(k.margin >= -0.011, `${k.slot}: seated man is ${k.margin} behind the bench`);
  }
});

test("with NO band the margin is still reported and the caveat SAYS the band is missing", () => {
  const c = clone(fixtureCtx());
  const r = lineupRecommend(c, WEEK, {});
  assert.ok(r.contested.every((k) => k.marginBandFrac === null));
  assert.match(r.assumptions.basisNote ?? "", /TIGHTEST CALL/);
  assert.match(r.assumptions.basisNote ?? "", /no served band for either man/);
});

test("with a band, the caveat states the tightest margin AS A FRACTION OF IT", () => {
  const c = clone(fixtureCtx());
  const weekly = new Map(mine(c).map((p) => [lineupNameKey(p.name), p.proj / NFL_WEEKS]));
  // A deliberately huge band: the point of the sentence is that a 0.7-point call inside a 22-point
  // band is a coin toss, so the fixture makes the ratio unmistakable.
  const bands = new Map<string, WeeklyBand>(mine(c).map((p) => {
    const m = p.proj / NFL_WEEKS;
    return [lineupNameKey(p.name), { mean: m, p10: Math.max(0, m - 11), p50: m, p90: m + 11 }];
  }));
  const r = lineupRecommend(c, WEEK, { weekly, bands });
  const tight = [...r.contested].sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin))[0];
  assert.ok(tight.marginBandFrac != null && tight.marginBandFrac > 0);
  assert.ok(tight.starter.p10 != null && tight.starter.p90 != null);
  assert.match(r.assumptions.basisNote ?? "", /% of the band/);
  assert.match(r.assumptions.basisNote ?? "", /close to a coin toss/);
});

test("THE MARGIN CHANGES NO NUMBER: starters, bench and totalProj are identical with and without bands", () => {
  const c = clone(fixtureCtx());
  const weekly = new Map(mine(c).map((p) => [lineupNameKey(p.name), p.proj / NFL_WEEKS]));
  const bands = new Map<string, WeeklyBand>(mine(c).map((p) => {
    const m = p.proj / NFL_WEEKS;
    return [lineupNameKey(p.name), { mean: m, p10: Math.max(0, m - 5), p50: m, p90: m + 5 }];
  }));
  const a = lineupRecommend(c, WEEK, { weekly });
  const b = lineupRecommend(c, WEEK, { weekly, bands });
  assert.deepEqual(a.starters, b.starters);
  assert.deepEqual(a.bench, b.bench);
  assert.equal(a.totalProj, b.totalProj);
});

test("a slot with NO legal alternative produces no contest rather than a fabricated one", () => {
  const c = clone(fixtureCtx());
  // Strip the roster to exactly the starting eight: nothing is left sitting.
  const keep = ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DST"];
  const roster = mine(c);
  const picked: typeof roster = [];
  for (const pos of keep) {
    const i = roster.findIndex((p) => p.pos === pos && !picked.includes(p));
    if (i >= 0) picked.push(roster[i]);
  }
  for (const p of picked) p.bye = null;
  c.teams[c.meIdx] = { ...c.teams[c.meIdx], roster: picked };
  const r = lineupRecommend(c, WEEK, {});
  assert.equal(r.contested.length, 0);
  assert.doesNotMatch(r.assumptions.basisNote ?? "", /TIGHTEST CALL/);
});
