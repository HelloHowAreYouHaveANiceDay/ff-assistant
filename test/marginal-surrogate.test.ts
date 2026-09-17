// M2i -- the LEARNED marginal surrogate's walker, against its own producer.
//
// The point of every test here is the one this repo keeps relearning: a passing check proves nothing
// until you have seen it fail. So each contract is exercised in BOTH directions -- the good artifact
// loads, and a deliberately broken one is proved to be REFUSED. A golden check nobody has watched
// fail is a golden check nobody has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  SURROGATE_FEATURE_FIELDS, surrogateFeatures, predictSurrogate,
  loadMarginalSurrogate, checkSurrogateGolden,
  type MarginalSurrogateArtifact, type SurrogateState, type SurrogateCandidate, type SurrogateEnv,
} from "../src/draft/marginalSurrogate.ts";

const CANDIDATE_PATH = "data/marginal-surrogate.candidate.json";

const N = SURROGATE_FEATURE_FIELDS.length;

/** A hand-built two-layer artifact whose answer can be computed on paper. */
function toyArtifact(): MarginalSurrogateArtifact {
  // Identity standardiser, one hidden unit that sums the first two features, linear output x2 + 1.
  const w0 = Array.from({ length: N }, (_, i) => [i < 2 ? 1 : 0]);
  const a: MarginalSurrogateArtifact = {
    schema: 1, kind: "marginal-surrogate", createdAt: "2026-09-16T00:00:00Z",
    target: "playoffs_pp",
    features: [...SURROGATE_FEATURE_FIELDS],
    xMean: Array.from({ length: N }, () => 0),
    xScale: Array.from({ length: N }, () => 1),
    yMean: 0, yScale: 1,
    activation: "relu",
    layers: [{ w: w0, b: [0] }, { w: [[2]], b: [1] }],
    golden: [],
  };
  const x0 = Array.from({ length: N }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
  const x1 = Array.from({ length: N }, (_, i) => (i === 0 ? -9 : 0));   // relu must clamp this to 0
  a.golden = [{ x: x0, y: 15 }, { x: x1, y: 1 }];
  return a;
}

test("the walker reproduces a hand-computed MLP, relu included", () => {
  const a = toyArtifact();
  // relu(3 + 4) = 7; 7*2 + 1 = 15.
  assert.equal(predictSurrogate(a, a.golden[0].x), 15);
  // relu(-9) = 0; 0*2 + 1 = 1. A walker that forgot the activation would answer -17.
  assert.equal(predictSurrogate(a, a.golden[1].x), 1);
});

test("the standardiser and the target scale are BOTH applied (a half-shipped model reads as a working one)", () => {
  const a = toyArtifact();
  a.xMean = a.xMean.map((_v, i) => (i === 0 ? 1 : 0));
  a.xScale = a.xScale.map((_v, i) => (i === 0 ? 2 : 1));
  a.yMean = 5; a.yScale = 10;
  // (3-1)/2 = 1; relu(1 + 4) = 5; 5*2 + 1 = 11; 11*10 + 5 = 115.
  assert.equal(predictSurrogate(a, a.golden[0].x), 115);
});

test("FAULT: a perturbed weight makes the golden check FAIL", () => {
  const a = toyArtifact();
  checkSurrogateGolden(a);                       // it passes before the injection
  a.layers[1].b[0] += 1e-4;
  assert.throws(() => checkSurrogateGolden(a), /golden row 0/);
});

test("FAULT: a PERMUTED feature list is refused (the defect nothing else would notice)", () => {
  const a = toyArtifact();
  const swapped = [...a.features];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  a.features = swapped;
  assert.throws(() => loadMarginalSurrogate(a), /permuted design matrix/);
});

test("FAULT: a truncated feature list, a missing golden block and a multi-unit output are all refused", () => {
  const trunc = toyArtifact(); trunc.features = trunc.features.slice(0, N - 1);
  assert.throws(() => loadMarginalSurrogate(trunc), /features/);
  const nogold = toyArtifact(); nogold.golden = [];
  assert.throws(() => loadMarginalSurrogate(nogold), /no golden rows/);
  const wide = toyArtifact(); wide.layers[1] = { w: [[2, 3]], b: [1, 1] };
  assert.throws(() => loadMarginalSurrogate(wide), /output layer/);
  const untargeted = toyArtifact() as unknown as { target: string };
  untargeted.target = "dollars";
  assert.throws(() => loadMarginalSurrogate(untargeted), /unknown target/);
});

test("the feature builder emits exactly the published list, in order, all finite", () => {
  const st: SurrogateState = {
    budget: 137, leagueBudget: 200,
    openSlots: ["RB", "WR", "FLEX", "FLEX", "DST", "K", "BE", "BE", "BE"],
    roster: [{ name: "a", pos: "QB", proj: 310 }, { name: "b", pos: "RB", proj: 240 }, { name: "c", pos: "TE", proj: 150 }],
    poolSize: 402, leagueDollars: 2100, leagueOpenSlots: 140, oppRosterProjMean: 640, slotsPerTeam: 12,
  };
  const c: SurrogateCandidate = {
    name: "x", pos: "WR", proj: 221, posRank: 5, vorRank: 9, vor: 61, price: 44,
    sd: 0.448, avail: 0.86, anaPoints: 3.2, anaDollars: 37,
  };
  const env: SurrogateEnv = { replacement: { QB: 11.2, RB: 4.2, WR: 5.7, TE: 5.2, K: 6.6, DST: 5.9 }, nflWeeks: 17, flexOk: ["RB", "WR", "TE"] };
  const x = surrogateFeatures(st, c, env);
  assert.equal(x.length, N);
  assert.ok(x.every(Number.isFinite), "a non-finite feature would become a NaN bid, read as no bid");
  const at = (n: string) => x[SURROGATE_FEATURE_FIELDS.indexOf(n as never)];
  assert.equal(at("open_flex"), 2);
  assert.equal(at("open_be"), 3);
  assert.equal(at("open_qb"), 0);
  assert.equal(at("held_rb"), 1);
  assert.equal(at("is_wr"), 1);
  assert.equal(at("is_rb"), 0);
  // A receiver can start at his own open slot plus both FLEXes.
  assert.equal(at("cand_open_at_pos"), 3);
  // No receiver held yet, so the "upgrade" is his whole projection.
  assert.equal(at("cand_upgrade"), 2.21);
  assert.equal(at("cand_held_at_pos"), 0);
});

test("FAULT: a non-finite feature is refused rather than silently becoming a NaN bid", () => {
  const st: SurrogateState = {
    budget: 100, leagueBudget: 200, openSlots: ["RB"], roster: [],
    poolSize: 10, leagueDollars: 100, leagueOpenSlots: 10, oppRosterProjMean: 0, slotsPerTeam: 12,
  };
  const c = { name: "x", pos: "RB", proj: NaN, posRank: 1, vorRank: 1, vor: 1, price: 1, sd: 0.5, avail: 0.8, anaPoints: 0, anaDollars: 0 };
  const env: SurrogateEnv = { replacement: { RB: 4 }, nflWeeks: 17, flexOk: ["RB", "WR", "TE"] };
  assert.throws(() => surrogateFeatures(st, c, env), /not finite/);
});

// THE REAL ARTIFACT, when one has been fitted. The candidate file is tracked, so this is a live
// check on the shipped bytes rather than on a fixture -- the golden rows in it are scikit-learn's
// own predictions, so a walker that disagrees with the trainer fails HERE.
test("the M2i candidate artifact loads and its golden block agrees with this walker to 1e-6", (t) => {
  if (!existsSync(CANDIDATE_PATH)) {
    t.skip(`${CANDIDATE_PATH} not present -- run tools/train_marginal_surrogate.py`);
    return;
  }
  const a = loadMarginalSurrogate(JSON.parse(readFileSync(CANDIDATE_PATH, "utf8")));
  assert.equal(a.target, "playoffs_pp");
  assert.ok(a.golden.length >= 5, "fewer than five golden rows");
  // And the check can FAIL on this artifact too, not merely on the toy: a golden test that only ever
  // fires against a fixture has never been exercised against the shape it exists to protect.
  const broken = JSON.parse(JSON.stringify(a)) as MarginalSurrogateArtifact;
  broken.xScale[0] *= 1.01;
  assert.throws(() => checkSurrogateGolden(broken), /golden row/);
});
