// THE PRE-REGISTERED WEEKLY GATE, AND PROOF THAT EACH CLAUSE CAN BOTH REFUSE AND ADMIT.
//
// A gate is the most dangerous kind of code in this repo: it produces a verdict, and a verdict that
// is always "no" and a verdict that is always "yes" both read exactly like a gate that is working.
// So every clause is exercised TWICE here -- once with an input that MUST make it fail, once with an
// input that MUST make it pass -- and the whole gate is exercised with an input that must let a model
// through, because a gate nothing can ever pass would have kept the season-line floor shipping
// forever while looking rigorous.
//
// The three clauses:
//   (a) pooled CRPS beats the shipped baseline
//   (b) coverage conditional on pts > 0 in [0.75, 0.85] pooled and [0.70, 0.90] per position
//   (c) predicted zero-week share within 0.03 of actual, pooled and per position
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weeklyGate, predZeroProb, score, GATE_ZERO_TOL, type Scored, type Pred,
} from "../src/weekly/evaluate.js";

/** A Scored row built by hand, so a clause can be moved one at a time. */
function scored(o: Partial<Scored>): Scored {
  return {
    n: 1000, rmse: 6, crps: 2.5, coverage: 0.87, coverageNonZero: 0.80, bias: 0,
    zeroActual: 0.40, zeroPred: 0.40, ...o,
  };
}

/** A pooled/byPos pair that passes every clause. Each test breaks exactly one thing. */
function passing(): { pooled: Record<string, Scored>; byPos: Record<string, Record<string, Scored>> } {
  const good = scored({ crps: 2.30 });
  const base = scored({ crps: 2.67 });
  return {
    pooled: { weekly: good, shipped_week: base },
    byPos: Object.fromEntries(["QB", "RB", "WR", "TE"].map((p) => [p, { weekly: good, shipped_week: base }])),
  };
}

test("POSITIVE CONTROL: a model that satisfies every clause is ADMITTED", () => {
  const { pooled, byPos } = passing();
  const g = weeklyGate(pooled, byPos);
  assert.equal(g.passed, true,
    "a model constructed to satisfy all three clauses was refused -- a gate that cannot return its " +
    "positive value is dead code that reads exactly like a gate that is passing: " + g.reason);
  assert.equal(g.ships, "weekly");
  assert.deepEqual(g.clauses.map((c) => c.passed), [true, true, true]);
});

test("FAULT INJECTION (a): a model whose CRPS does not beat the baseline is refused, and (a) is the clause named", () => {
  const { pooled, byPos } = passing();
  pooled.weekly = scored({ crps: pooled.shipped_week.crps + 0.01 });
  const g = weeklyGate(pooled, byPos);
  assert.equal(g.passed, false);
  assert.deepEqual(g.clauses.filter((c) => !c.passed).map((c) => c.id), ["a"],
    "the CRPS clause was broken but a different clause (or none) reported the failure");
  assert.equal(g.ships, "season_line_only");
});

test("FAULT INJECTION (b): coverage outside the band fails, POOLED and PER POSITION independently", () => {
  {
    const { pooled, byPos } = passing();
    pooled.weekly = scored({ crps: 2.3, coverageNonZero: 0.876 });   // the number that failed before
    const g = weeklyGate(pooled, byPos);
    assert.deepEqual(g.clauses.filter((c) => !c.passed).map((c) => c.id), ["b"]);
    assert.match(g.clauses[1].evidence, /0\.876/);
  }
  {
    // POOLED inside the band, ONE POSITION outside it. A gate that only looked pooled would pass
    // this, and a model that is well calibrated on average and badly calibrated at tight end is
    // exactly the model this clause exists to catch.
    const { pooled, byPos } = passing();
    byPos.TE = { weekly: scored({ crps: 2.3, coverageNonZero: 0.62 }), shipped_week: scored({ crps: 2.67 }) };
    const g = weeklyGate(pooled, byPos);
    assert.equal(g.passed, false,
      "a position at 0.62 coverage passed a gate whose per-position band is [0.70, 0.90] -- the " +
      "per-position half of clause (b) is not connected");
    assert.deepEqual(g.clauses.filter((c) => !c.passed).map((c) => c.id), ["b"]);
    assert.match(g.clauses[1].evidence, /TE/);
  }
});

test("FAULT INJECTION (c): a zero-share that misses by more than the tolerance fails, pooled and per position", () => {
  {
    const { pooled, byPos } = passing();
    // What a quantile-head model actually claims: p10 on the atom, so P(zero) = 0.10 and no more.
    pooled.weekly = scored({ crps: 2.3, zeroPred: 0.10, zeroActual: 0.40 });
    const g = weeklyGate(pooled, byPos);
    assert.deepEqual(g.clauses.filter((c) => !c.passed).map((c) => c.id), ["c"]);
    assert.match(g.clauses[2].evidence, /0\.300/);
  }
  {
    const { pooled, byPos } = passing();
    byPos.QB = { weekly: scored({ crps: 2.3, zeroPred: 0.05, zeroActual: 0.30 }), shipped_week: scored({ crps: 2.67 }) };
    const g = weeklyGate(pooled, byPos);
    assert.equal(g.passed, false, "a position off by 0.25 on zero-share passed the gate");
    assert.match(g.clauses[2].evidence, /QB/);
  }
  {
    // And it must ADMIT a miss that is inside the tolerance -- a clause that refuses everything is
    // not measuring calibration, it is measuring nothing.
    const { pooled, byPos } = passing();
    pooled.weekly = scored({ crps: 2.3, zeroPred: 0.40 - GATE_ZERO_TOL + 0.001, zeroActual: 0.40 });
    assert.equal(weeklyGate(pooled, byPos).passed, true);
  }
});

test("predZeroProb: the ladder is inverted at zero, and a p10 on the atom claims exactly 0.10", () => {
  const p = (p10: number, p50: number, p90: number): Pred => ({ mean: p50, p10, p50, p90 });
  // p10 exactly on the atom: the model publishes no quantile below 0.10, so 0.10 is all it claims.
  assert.equal(predZeroProb(p(0, 5, 18)), 0.10);
  // A strictly positive p10 means the model says a zero week is below its lowest published quantile.
  assert.equal(predZeroProb(p(2, 8, 20)), 0);
  // p50 on the atom: half the mass is at or below zero.
  assert.equal(predZeroProb(p(0, 0, 12)), 0.50);
  // Everything at zero -- the ladder cannot see above 0.90 and must not round itself up to 1.
  assert.equal(predZeroProb(p(0, 0, 0)), 0.90);
  // An EXPLICIT zero head (what a two-part artifact carries) is used as given, not re-derived.
  assert.equal(predZeroProb({ mean: 5, p10: 0, p50: 5, p90: 18, pZero: 0.42 }), 0.42);
});

test("score(): zeroActual is a property of the data and zeroPred is a property of the model", () => {
  // 40 rows, 16 of them zero weeks. Two models over the SAME rows: one whose ladder claims 0.10,
  // one that publishes an explicit and correct 0.40.
  const rows = Array.from({ length: 40 }, (_, i) => ({ actual: i < 16 ? 0 : 12 }));
  const ladder = score(rows.map((r) => ({ actual: r.actual, p: { mean: 6, p10: 0, p50: 5, p90: 20 } })));
  const twoPart = score(rows.map((r) => ({ actual: r.actual, p: { mean: 6, p10: 0, p50: 5, p90: 20, pZero: 0.40 } })));
  assert.equal(ladder.zeroActual, 0.40);
  assert.equal(twoPart.zeroActual, 0.40, "the actual share must not depend on which model is scoring it");
  assert.equal(Number(ladder.zeroPred.toFixed(10)), 0.10);
  assert.equal(Number(twoPart.zeroPred.toFixed(10)), 0.40);
  // A negative week is a zero week: the manager who started him got nothing.
  assert.equal(score([{ actual: -2, p: { mean: 6, p10: 0, p50: 5, p90: 20 } }]).zeroActual, 1);
});
