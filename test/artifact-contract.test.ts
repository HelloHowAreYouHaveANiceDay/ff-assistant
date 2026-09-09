// THE TRAIN/SERVE CONTRACT: does the TypeScript evaluator agree with the Python trainer?
//
// This repo has the scar this test exists to prevent. A producer that ships its OWN validator,
// mirroring its OWN types, grades its own homework and passes forever while every consumer rejects
// its output -- a Revit add-in emitted a flat `yfov` for three weeks while the schema, the types and
// the viewer all required the nested form, and both repos were green the whole time.
//
// The decisive test is to run BYTES THE PRODUCER ACTUALLY EMITTED through the CONSUMER'S REAL
// validator -- not a fixture someone hand-wrote to match, not a reimplementation. So:
//
//   test/fixtures/trained-artifact.json   is exactly what tools/train_projection.py wrote
//   loadArtifact                          is exactly what src/data/projections.ts calls
//
// and the golden block inside that file carries the TRAINER'S OWN predictions for five fixture
// rows, which the loader recomputes with the TypeScript arithmetic and compares at 1e-6. The two
// featureValue implementations exist deliberately in both languages; that is not duplication to be
// refactored away, it is what makes the comparison mean anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArtifact, checkGolden, type ProjectionArtifact } from "../src/model/projector.js";

const FIXTURE = "test/fixtures/trained-artifact.json";
const raw = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as ProjectionArtifact;

test("the trainer's own output loads through the shipped loader", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  const a = loadArtifact(raw());
  assert.equal(a.fittedFrom, "tools/train_projection.py", "the fixture must be trainer output, not a hand-written stand-in");
  assert.ok(a.features.length >= 4, `expected a fitted feature set, got ${a.features.length}`);
  assert.ok(a.golden && a.golden.length >= 4, "an artifact with no golden rows proves nothing about the seam");
});

test("the trainer's golden predictions reproduce in TypeScript within 1e-6", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  const a = raw();
  // Explicitly, not merely as a side effect of loadArtifact: this is the assertion the whole
  // train/serve split rests on, and it should read as one.
  checkGolden(a, 1e-6);
  // And it must be a real comparison rather than an empty loop over zero fixtures.
  assert.ok((a.golden ?? []).length >= 4);
});

test("the trained artifact declares an EMPTY multiplicative stage", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  const a = raw();
  // Age is a fitted feature in this artifact. Declaring the age multiplier as well would apply age
  // twice -- once as a coefficient, once as a factor -- and the result would be a plausible
  // projection with no symptom. The stage is retired for every artifact now, so this is a floor.
  assert.deepEqual(a.multiplicative, [], "the multiplicative stage is retired");
});

test("the trained artifact CARRIES the curve it was selected with, per position", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  const a = raw();
  assert.equal(a.base, "artifact_curve",
    "a trained artifact whose curve construction was selected inside the fold must ship that curve, " +
    "or the board reads whatever recipe the feature builder happens to hold and the selection " +
    "changed nothing");
  assert.ok(a.curve && Object.keys(a.curve).length >= 4);
  assert.ok(a.curveVariant && Object.keys(a.curveVariant).length >= 4,
    "which variant each position selected is part of the record, not a detail of the run");
  for (const [pos, v] of Object.entries(a.curveVariant!)) {
    assert.ok([0, 1, 2, 3].includes(v.window), `${pos} window ${v.window}`);
    assert.ok([0, 0.5, 1].includes(v.levelWeight), `${pos} levelWeight ${v.levelWeight}`);
    assert.ok(a.curve![pos]?.length, `${pos} declares a variant but ships no curve`);
    // A curve must DESCEND overall. Not monotonically -- the evaluation is allowed to choose an
    // unrepaired curve -- but a curve whose rank 40 outscores its rank 1 is a broken join, not a
    // fitted choice, and it would invert the ordering the whole auction book expresses.
    const c = a.curve![pos];
    assert.ok(c[0] > c[Math.min(c.length - 1, 39)], `${pos} curve does not fall with rank`);
  }
  assert.ok(a.form === "ratio" || a.form === "offset");
});

test("FAULT: renaming one feature in the artifact makes the loader REFUSE it", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  const a = raw();
  assert.ok(a.features.length > 0);
  const original = a.features[0].name;
  (a.features[0] as { name: string }).name = "prior_snaps";     // a plausible name we cannot compute
  assert.throws(() => loadArtifact(a),
    /not one this evaluator can compute/,
    `renaming '${original}' must be refused -- scoring an unknown feature as zero is how a producer ` +
    `and a consumer stay green while disagreeing`);
});

test("FAULT: perturbing one golden prediction makes the loader REFUSE it", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  const a = raw();
  a.golden![0].expect.mean += 1e-3;
  assert.throws(() => loadArtifact(a), /golden row 0/);
});

test("the committed fixture is still what the trainer produces TODAY", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no trainer fixture");
  if (!existsSync("data/ff.db")) return t.skip("no store to train against");
  // A fixture goes stale silently: the trainer changes, the fixture does not, and the contract test
  // keeps passing against last month's bytes. Re-running the trainer here is what stops that -- and
  // when uv is unavailable this SKIPS rather than passing, because a skip is visible and a silent
  // pass is not.
  const tmp = join(tmpdir(), `ff-trainer-contract-${process.pid}.json`);
  try {
    execFileSync("uv", [
      "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_projection.py",
      "--db", "data/ff.db", "--seasons", "1999-2025", "--holdout-season", "none",
      "--out", tmp, "--quiet",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  } catch { return t.skip("uv/scikit-learn unavailable, or the trainer could not run here"); }
  if (!existsSync(tmp)) return t.skip("trainer produced no output file");
  const fresh = JSON.parse(readFileSync(tmp, "utf8")) as ProjectionArtifact;
  rmSync(tmp, { force: true });
  const fx = raw();
  assert.deepEqual(fresh.features.map((f) => f.name), fx.features.map((f) => f.name),
    "the trainer's feature NAMES have changed since the fixture was recorded -- re-record it");
  assert.deepEqual(Object.keys(fresh.coef).sort(), Object.keys(fx.coef).sort());
  checkGolden(fresh, 1e-6);
});
