/**
 * A WEEKLY ARTIFACT THAT DID NOT LOAD SAYS WHY (architecture review 2026-09-24, W1).
 *
 * `tryLoad` caught everything and returned null, so an artifact REFUSED by its golden check read
 * exactly like one that was never built -- and the lineup note still named the file as the model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLoadWeeklyArtifact } from "../src/weekly/streamingServe.js";
import { CHALLENGER_WEEKLY_ARTIFACT } from "../src/weekly/projector.js";
import type { ModelHandle } from "../src/data/formatResolve.js";

const handleAt = (dir: string): ModelHandle => ({
  dir, scoringKey: "sc-test", provenance: "incumbent-root",
  path: (name: string) => join(dir, `${name}.json`),
  require: (name: string) => join(dir, `${name}.json`),
} as unknown as ModelHandle);

test("an ABSENT artifact is reported as not built", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-w1-"));
  const r = tryLoadWeeklyArtifact(CHALLENGER_WEEKLY_ARTIFACT, handleAt(dir));
  assert.equal(r.art, null);
  assert.match(String(r.why), /not built/);
});

test("a REFUSED artifact (golden check fails) is reported as refused, with the loader's reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-w1-"));
  const h = handleAt(dir);
  const real = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8"));
  const target = h.path("weekly" as never);
  // Positive control first: the real served artifact, copied in, must LOAD through the same path.
  writeFileSync(target, JSON.stringify(real));
  const ok = tryLoadWeeklyArtifact(CHALLENGER_WEEKLY_ARTIFACT, h);
  assert.ok(ok.art, `the real artifact did not load through tryLoad: ${ok.why}`);
  assert.equal(ok.why, null);
  // Now corrupt one golden expectation: the loader must refuse, and the reason must survive.
  const bad = structuredClone(real);
  const g = bad.golden[0];
  const k = Object.keys(g.expect)[0];
  g.expect[k] = g.expect[k] + 1000;
  writeFileSync(target, JSON.stringify(bad));
  const r = tryLoadWeeklyArtifact(CHALLENGER_WEEKLY_ARTIFACT, h);
  assert.equal(r.art, null);
  assert.match(String(r.why), /REFUSED/);
});
