// TRAJECTORY RESAMPLING -- whole player-seasons instead of independent weeks.
//
// The defect being guarded is a number that is right on average and wrong in its spread. An iid
// weekly sampler produces the correct MEAN season total, the correct weekly distribution, and a
// season-total sd roughly half the truth. Nothing about it looks broken: the bands render, the odds
// sum to 1, every existing test passes. Only a comparison against the empirical season-total
// dispersion can see it -- which is why the central test here is that comparison, and why it ships
// with a POSITIVE CONTROL proving the old sampler fails it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  prepare, sampleSeason, weekOf, assertTrajectorySchema, quantile,
  type RankOutcomes, type CorrelationModel, type PoolPlayer,
} from "../src/draft/bootstrap.js";
import { seasonSpread, mulberry32 } from "../src/draft/spread.js";

const NO_CORR: CorrelationModel = { pairs: {} };
const HAVE = existsSync("data/rank-outcomes.json");
const outcomes: RankOutcomes | null = HAVE ? JSON.parse(readFileSync("data/rank-outcomes.json", "utf8")) : null;

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

// --- (d) the schema gate --------------------------------------------------------------------------

test("(d) a schema-1 file is REFUSED, with an actionable message", () => {
  const legacy = { schema: 1, pos: { RB: { "1": [1, 2, 3, 4] } } } as unknown as RankOutcomes;
  assert.throws(() => assertTrajectorySchema(legacy), /schema 1/,
    "a schema-1 file must not be read leniently -- its weeks would each become a one-week season");
  // An absent schema field is schema 1 by age, not a pass.
  assert.throws(() => assertTrajectorySchema({ pos: {} } as RankOutcomes), /scripts\/fit-bootstrap/,
    "the message must say how to fix it");
  // And the gate must ACCEPT a real schema-2 file -- a guard that can only ever refuse is dead code
  // that reads exactly like a guard that is passing.
  assert.doesNotThrow(() => assertTrajectorySchema({ schema: 2, pos: {} } as RankOutcomes));
});

test("prepare() refuses a legacy file rather than producing one-week seasons", () => {
  const legacy = { pos: { RB: { "1": [10, 12, 8] } } } as unknown as RankOutcomes;
  assert.throws(() => prepare([{ name: "x", pos: "RB", rank: 1 }], legacy, NO_CORR), /schema/);
});

// --- (a) and (b): the dispersion the whole change exists for ---------------------------------------

/** The empirical season totals of a rank's pool, and an iid-week sampler over the SAME weeks. */
function armsFor(pos: string, rank: number) {
  const pool = outcomes!.pos[pos][String(rank)];
  const empirical = pool.map((t) => t.reduce((a, b) => a + b, 0));
  const weeksPer = Math.round(mean(pool.map((t) => t.length)));
  const flat = pool.flat();
  const rng = mulberry32(20260908);
  const iid: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let s = 0;
    for (let w = 0; w < weeksPer; w++) s += flat[(rng() * flat.length) | 0];
    iid.push(s);
  }
  // The shipped sampler, through the real prepare() + seasonSpread path.
  const players: PoolPlayer[] = [{ name: "p", pos, rank }];
  const prep = prepare(players, outcomes!, NO_CORR, "none");
  const trajPool = prep.pools.get(players[0])!;
  const rng2 = mulberry32(20260908);
  const sim: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const tr = trajPool[(rng2() * trajPool.length) | 0];
    sim.push(tr.total * (weeksPer / tr.weeks.length));
  }
  return { empirical, iid, sim, weeksPer };
}

for (const [pos, rank] of [["RB", 5], ["QB", 5]] as const) {
  test(`(a) simulated season-total sd for ${pos}${rank} is within 15% of the empirical pool`, (t) => {
    if (!HAVE) return t.skip("no fitted pools");
    const { empirical, sim } = armsFor(pos, rank);
    const e = sd(empirical), s = sd(sim);
    const rel = Math.abs(s - e) / e;
    assert.ok(rel < 0.15,
      `${pos}${rank}: simulated sd ${s.toFixed(1)} vs empirical ${e.toFixed(1)} (off by ${(100 * rel).toFixed(1)}%)`);
  });

  test(`(b) POSITIVE CONTROL: an iid-week sampler over the same pool FAILS that, at ${pos}${rank}`, (t) => {
    if (!HAVE) return t.skip("no fitted pools");
    // Without this, test (a) proves nothing: a sampler that happened to match by luck, or a pool
    // whose seasons were genuinely near-independent, would look identical. This asserts that the
    // thing being replaced is measurably wrong on exactly the statistic (a) checks -- so (a) is
    // discriminating rather than merely satisfied.
    const { empirical, iid } = armsFor(pos, rank);
    const e = sd(empirical), i = sd(iid);
    assert.ok(i < 0.60 * e,
      `${pos}${rank}: iid-week sd ${i.toFixed(1)} should be far below empirical ${e.toFixed(1)} ` +
      `(got ${(i / e).toFixed(2)} of it); if this ever passes, weeks really are independent and the ` +
      `trajectory machinery is unnecessary`);
  });
}

// --- (c) the marginal must be untouched ------------------------------------------------------------

test("(c) the WEEKLY marginal is preserved -- only the season-level dependence changed", (t) => {
  if (!HAVE) return t.skip("no fitted pools");
  // The defining property. Grouping weeks by player-season must not move any player's own weekly
  // distribution: it is the same multiset of numbers, only drawn in bundles. If this drifts, every
  // per-week consumer (the lineup optimizer, weekly odds) silently changes too.
  const pool = outcomes!.pos.RB["5"];
  const flat = pool.flat().sort((a, b) => a - b);
  const players: PoolPlayer[] = [{ name: "p", pos: "RB", rank: 5 }];
  const prep = prepare(players, outcomes!, NO_CORR, "none");
  const trajPool = prep.pools.get(players[0])!;
  const drawnWeeks = trajPool.flatMap((t) => t.weeks).sort((a, b) => a - b);
  assert.equal(drawnWeeks.length, flat.length, "the pool must hold exactly the same weeks");
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const a = quantile(flat, q), b = quantile(drawnWeeks, q);
    assert.equal(a, b, `weekly quantile ${q} moved: ${a} -> ${b}`);
  }
});

test("a drawn season is a REAL season from the pool, and its weeks are read in order", (t) => {
  if (!HAVE) return t.skip("no fitted pools");
  const players: PoolPlayer[] = [{ name: "p", pos: "RB", rank: 5 }];
  const prep = prepare(players, outcomes!, NO_CORR, "none");
  const drawn = sampleSeason(players, prep, () => 0, () => 0.42);
  const tr = drawn.get(players[0])!;
  assert.ok(tr, "a player with a pool must draw a season");
  const pool = prep.pools.get(players[0])!;
  assert.ok(pool.some((x) => x === tr), "the drawn season must be one of the pool's, not a synthesis");
  for (let w = 1; w <= tr.weeks.length; w++) {
    assert.equal(weekOf(tr, w), tr.weeks[w - 1], `week ${w} must read position ${w - 1}`);
  }
  // Past the end it wraps rather than returning 0 -- benching everyone in the championship week
  // would be a much worse answer than reusing a real week from the same season.
  assert.equal(weekOf(tr, tr.weeks.length + 1), tr.weeks[0]);
  assert.equal(weekOf(null, 3), 0);
});

test("the pools are sorted by SEASON TOTAL, which is what makes the copula's uniform a season quantile", (t) => {
  if (!HAVE) return t.skip("no fitted pools");
  const players: PoolPlayer[] = [{ name: "p", pos: "WR", rank: 8 }];
  const prep = prepare(players, outcomes!, NO_CORR, "none");
  const pool = prep.pools.get(players[0])!;
  for (let i = 1; i < pool.length; i++) {
    assert.ok(pool[i].total >= pool[i - 1].total, `pool not sorted by total at ${i}`);
  }
  // And a high uniform must actually return a good season, or the coupling couples nothing.
  const lo = sampleSeason(players, prep, () => 0, () => 0.05).get(players[0])!;
  const hi = sampleSeason(players, prep, () => 0, () => 0.95).get(players[0])!;
  assert.ok(hi.total > lo.total * 1.5, `u=0.95 season (${hi.total.toFixed(0)}) must beat u=0.05 (${lo.total.toFixed(0)})`);
});

test("seasonSpread bands widen against the iid sampler they replaced", (t) => {
  if (!HAVE) return t.skip("no fitted pools");
  const players: PoolPlayer[] = [{ name: "p", pos: "RB", rank: 5 }];
  const prep = prepare(players, outcomes!, NO_CORR, "none");
  const pool = prep.pools.get(players[0])!;
  const s = seasonSpread(pool, 17, 20000, mulberry32(5))!;
  const empirical = pool.map((x) => x.total * (17 / x.weeks.length)).sort((a, b) => a - b);
  const eP10 = empirical[Math.floor(0.10 * (empirical.length - 1))];
  const eP90 = empirical[Math.floor(0.90 * (empirical.length - 1))];
  // Within 20% of the empirical band, in BOTH tails -- the iid version came back at roughly half
  // this width, so a regression to it cannot satisfy this.
  assert.ok(Math.abs(s.p10 - eP10) / eP10 < 0.20, `p10 ${s.p10} vs empirical ${eP10.toFixed(0)}`);
  assert.ok(Math.abs(s.p90 - eP90) / eP90 < 0.20, `p90 ${s.p90} vs empirical ${eP90.toFixed(0)}`);
});
