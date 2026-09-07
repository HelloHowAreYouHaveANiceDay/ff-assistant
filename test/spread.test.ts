// The projection band. The failure mode to guard against is not a crash -- it is a band that renders
// beautifully and means nothing: one that is the same width for everybody, or is not centred on the
// number it annotates, or is quietly fabricated for players the calibration guard refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { seasonSpread, boardSpreads, mulberry32 } from "../src/draft/spread.js";
import type { RankOutcomes, CorrelationModel } from "../src/draft/bootstrap.js";

const NO_CORR: CorrelationModel = { pairs: {} };

test("quantiles come back ordered", () => {
  const s = seasonSpread([0, 5, 10, 15, 20], 17, 5000, mulberry32(1))!;
  assert.ok(s.p10 < s.p50 && s.p50 < s.p90, `expected p10<p50<p90, got ${JSON.stringify(s)}`);
});

// THE POSITIVE DIRECTION. Every test below could pass against a function that returns a constant
// band, so first prove the band actually tracks the data it is drawn from.
test("a wider pool produces a wider band", () => {
  const tight = seasonSpread([9, 10, 10, 10, 11], 17, 20000, mulberry32(7))!;
  const wide = seasonSpread([0, 0, 10, 20, 40], 17, 20000, mulberry32(7))!;
  const wTight = tight.p90 - tight.p10, wWide = wide.p90 - wide.p10;
  assert.ok(wWide > wTight * 3, `wide pool must widen the band: tight ${wTight.toFixed(1)} vs wide ${wWide.toFixed(1)}`);
});

test("the band narrows RELATIVE to the total as weeks accumulate (it is a sum, not a scaling)", () => {
  const pool = [0, 4, 8, 12, 30];
  const one = seasonSpread(pool, 1, 40000, mulberry32(3))!;
  const many = seasonSpread(pool, 17, 40000, mulberry32(3))!;
  const rel = (s: { p10: number; p50: number; p90: number }) => (s.p90 - s.p10) / s.p50;
  assert.ok(rel(many) < rel(one) / 2,
    `17 independent weeks must average out: relative width ${rel(one).toFixed(2)} -> ${rel(many).toFixed(2)}`);
});

test("the same seed gives the same band", () => {
  const a = seasonSpread([0, 5, 12, 30], 17, 5000, mulberry32(42));
  const b = seasonSpread([0, 5, 12, 30], 17, 5000, mulberry32(42));
  assert.deepEqual(a, b, "a band that moves between builds of identical data is unreadable as a signal");
});

test("degenerate inputs return null rather than a fake band", () => {
  assert.equal(seasonSpread([], 17, 100, mulberry32(1)), null);
  assert.equal(seasonSpread([1, 2], 0, 100, mulberry32(1)), null);
  assert.equal(seasonSpread([1, 2], 17, 0, mulberry32(1)), null);
});

// --- against the REAL fitted models, because a synthetic pool cannot catch a join defect ----------
const HAVE_MODELS = existsSync("data/rank-outcomes.json") && existsSync("data/correlation-model.json");
const outcomes: RankOutcomes | null = HAVE_MODELS ? JSON.parse(readFileSync("data/rank-outcomes.json", "utf8")) : null;

test("the band is CENTRED on the projection it annotates", (t) => {
  if (!HAVE_MODELS) return t.skip("no fitted models");
  const players = [
    { name: "A", pos: "RB", team: "AAA", posRank: 3, projPts: 300 },
    { name: "B", pos: "WR", team: "BBB", posRank: 10, projPts: 200 },
  ];
  const { spreads } = boardSpreads(players, outcomes!, NO_CORR);
  for (const p of players) {
    const s = spreads.get(p.name);
    assert.ok(s, `${p.name} must get a band`);
    // Median sits slightly BELOW the mean for a right-skewed season total; 15% is generous headroom
    // around that while still failing an uncentred band, which is the defect being caught.
    const rel = Math.abs(s!.p50 - p.projPts) / p.projPts;
    assert.ok(rel < 0.15, `${p.name}: median ${s!.p50} should sit near ProjPts ${p.projPts} (off by ${(100 * rel).toFixed(1)}%)`);
    assert.ok(s!.p10 < p.projPts && s!.p90 > p.projPts, `${p.name}: projection must fall inside its own band`);
  }
});

test("the band differs BY RANK -- proof the pools are actually joined on rank", (t) => {
  if (!HAVE_MODELS) return t.skip("no fitted models");
  // Same position, different preseason rank, calibration OFF. Turning it off is what isolates the
  // thing under test: with scaling on, the widths would differ partly because the projections differ,
  // and a broken rank join could still pass. Off, the only thing that can separate these two is the
  // pool each rank is joined to. If the join were broken (rank 0 for everyone, say) both would come
  // back identical -- a uniform band down the whole board, which renders perfectly and says nothing.
  const { spreads } = boardSpreads([
    { name: "elite", pos: "RB", posRank: 2, projPts: 250 },
    { name: "deep", pos: "RB", posRank: 45, projPts: 90 },
  ], outcomes!, NO_CORR, { calibration: "none" });
  const a = spreads.get("elite")!, b = spreads.get("deep")!;
  assert.ok(a && b, "both must get bands");
  // ASSERT A LARGE SEPARATION, NOT MERE INEQUALITY. The first version of this test asserted only
  // that the two widths differed, and it PASSED with the join deliberately broken (rank forced to 0)
  // -- because prepare() falls back to the nearest rank it has, handing both players the identical
  // pool, whose two Monte-Carlo samples still differ in the last decimal. The test was keyed on
  // something the broken case satisfies for free.
  //
  // Measured separation on the real fitted pools: median ratio 2.87, width ratio 1.74. A collapsed
  // join produces ~1.0 for both, which sampling noise cannot fake in either direction.
  const medRatio = a.p50 / b.p50;
  assert.ok(medRatio > 2, `RB2 must project far above RB45; median ratio was ${medRatio.toFixed(2)} (~1.0 means the rank join collapsed)`);
  const wRatio = (a.p90 - a.p10) / (b.p90 - b.p10);
  assert.ok(wRatio > 1.3, `RB2's band must be materially wider; width ratio was ${wRatio.toFixed(2)}`);
});

test("a player the calibration guard refused gets NO band, not a wrong one", (t) => {
  if (!HAVE_MODELS) return t.skip("no fitted models");
  // A backup QB: joined to pools posted by players who really were QB28 and really played, while we
  // project him for 40 points. Ratio lands far below the [0.5, 2.0] guard, so the raw pool would
  // describe a different player entirely.
  const { spreads, uncalibrated } = boardSpreads(
    [{ name: "backup", pos: "QB", posRank: 28, projPts: 40 }], outcomes!, NO_CORR);
  assert.ok(uncalibrated.some((u) => u.name === "backup"), "the guard must flag him");
  assert.equal(spreads.get("backup"), undefined, "and he must get no band at all");
});
