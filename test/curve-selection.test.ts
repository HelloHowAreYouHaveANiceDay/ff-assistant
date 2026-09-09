/**
 * THE CURVE HYPERPARAMETERS ARE CONNECTED TO THE ARTIFACT.
 *
 * Phase 2b's whole claim is that the curve's construction -- window width, monotone repair, how far
 * it is rescaled toward the preseason-ECR level, and whether the linear stage multiplies or adds --
 * is now CHOSEN BY THE EVALUATION rather than compiled into the feature builder. A selection loop
 * that ran, printed a variant, and then emitted the same curve whatever it chose would look
 * identical from the outside: the log would name a winner, the artifact would load, the board would
 * render. This repo has paid for that shape before -- a dead lever and a real null draw the same
 * flat line.
 *
 * So the test drives the trainer at two ENDPOINTS of the search space and demands the outputs
 * differ. It is the positive control for the whole mechanism, and it is why `--fixed-variant`
 * exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArtifact, type ProjectionArtifact } from "../src/model/projector.js";

function train(variant: string, tag: string): ProjectionArtifact | null {
  const out = join(tmpdir(), `ff-curve-${process.pid}-${tag}.json`);
  try {
    execFileSync("uv", [
      "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_projection.py",
      "--db", "data/ff.db", "--seasons", "1999-2025", "--holdout-season", "none",
      "--fixed-variant", variant, "--out", out, "--quiet",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
  } catch { return null; }
  if (!existsSync(out)) return null;
  const a = loadArtifact(JSON.parse(readFileSync(out, "utf8")));
  rmSync(out, { force: true });
  return a;
}

test("two different curve variants produce two different artifacts", (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no store to train against");
  // Opposite corners: no smoothing at all, unrepaired, no level correction, ratio form -- against
  // a wide window, monotone-repaired, fully rescaled to the ECR level, offset form.
  const a = train("0,false,0,ratio", "a");
  if (!a) return t.skip("uv/scikit-learn unavailable, or the trainer could not run here");
  const b = train("3,true,1,offset", "b");
  assert.ok(b, "the second run must produce an artifact if the first did");

  assert.equal(a.form, "ratio");
  assert.equal(b!.form, "offset");
  assert.equal(a.curveVariant!.RB.window, 0);
  assert.equal(b!.curveVariant!.RB.window, 3);
  assert.equal(a.curveVariant!.RB.monotone, false);
  assert.equal(b!.curveVariant!.RB.monotone, true);

  // THE ASSERTION THAT MATTERS: the declared variant reached the CURVE, not just the metadata.
  // A trainer that recorded the hyperparameters on the artifact and then built the same curve
  // regardless would satisfy every assertion above.
  for (const pos of ["RB", "WR", "QB", "TE"]) {
    const ca = a.curve![pos], cb = b!.curve![pos];
    assert.ok(ca?.length && cb?.length, `${pos} must have a curve under both variants`);
    const n = Math.min(ca.length, cb.length);
    const differ = [...Array(n).keys()].filter((i) => Math.abs(ca[i] - cb[i]) > 1e-6).length;
    assert.ok(differ > n * 0.5,
      `${pos}: only ${differ}/${n} ranks differ between a window-0 unrepaired curve and a ` +
      `window-3 monotone one. The variant is being recorded but not applied.`);
  }

  // A window-0 curve is the raw per-rank mean and MUST be noisier than a window-3 one. Comparing
  // roughness rather than any single value keeps the check on the property the window controls.
  const rough = (v: number[]) => v.slice(1).reduce((s, x, i) => s + Math.abs(x - v[i]), 0) / (v.length - 1);
  assert.ok(rough(a.curve!.WR) > rough(b!.curve!.WR),
    `a window-0 WR curve (roughness ${rough(a.curve!.WR).toFixed(2)}) must be rougher than a ` +
    `window-3 monotone one (${rough(b!.curve!.WR).toFixed(2)})`);
});

test("the monotone repair actually forbids the curve to climb", (t) => {
  if (!existsSync("data/ff.db")) return t.skip("no store to train against");
  const mono = train("2,true,0,ratio", "m");
  if (!mono) return t.skip("uv/scikit-learn unavailable");
  const free = train("2,false,0,ratio", "f");
  assert.ok(free);
  for (const pos of ["RB", "WR", "TE"]) {
    const c = mono.curve![pos];
    for (let i = 1; i < c.length; i++) {
      assert.ok(c[i] <= c[i - 1] + 1e-9,
        `${pos} rank ${i + 1} (${c[i]}) is above rank ${i} (${c[i - 1]}) under a MONOTONE variant. ` +
        `A curve that climbs hands a worse-ranked player a higher VOR.`);
    }
  }
  // POSITIVE CONTROL for the assertion above: the unrepaired curve must actually climb somewhere,
  // or "monotone" is a property of the data and the repair is untested dead code.
  const climbs = ["RB", "WR", "TE", "QB"].map((pos) => {
    const c = free!.curve![pos];
    return c.slice(1).filter((x, i) => x > c[i] + 1e-9).length;
  }).reduce((a, b) => a + b, 0);
  assert.ok(climbs > 0,
    "no unrepaired curve climbs anywhere, so the monotone check cannot distinguish a working " +
    "repair from an absent one");
});
