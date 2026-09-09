/**
 * THE REGISTRY KNOWS ABOUT THE WEEKLY PAIR, AND ITS CHECKS CAN ACTUALLY FIRE.
 *
 * `src/draft/models.ts` records what has been fitted, what it measured, and whether it is still
 * trustworthy -- and until the final integration it knew nothing at all about the weekly track. Two
 * artifacts drive every in-season number this repo produces and neither was in the registry, so
 * `validateModels()` would happily pass a store whose shipped weekly artifact was of the OLD SCHEMA,
 * which stores a different coefficient shape: every unknown head degrades to "contributes 0", the
 * projection comes out slightly different, and nothing errors.
 *
 * Three assertions, and the first is the one most such tests omit:
 *
 *   1. POSITIVE CONTROL. Against the REAL artifacts on disk, `validateModels()` returns. A checker
 *      that can only ever throw reads exactly like a checker that is passing, and the negative cases
 *      below would prove nothing about it.
 *   2. FAULT INJECTION on the required slot: a schema-1 shipped weekly artifact must make
 *      `validateModels()` THROW, naming the model and the schema.
 *   3. FAULT INJECTION on the OPTIONAL slot: a challenger that is secretly the floor (a quantile
 *      artifact under the challenger's filename) must be REPORTED as a problem without throwing.
 *      That distinction is load-bearing -- the challenger is evidence, not a dependency -- and if it
 *      were silent, every `weekly_challenger` scorecard row would duplicate the shipped one while
 *      looking like independent evidence.
 *
 * FF_DATA is read once at module load, so the registry is imported dynamically AFTER it is pointed
 * at the fixture directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every file a REQUIRED registry entry names, plus the challenger. Copied so the injections below
 *  cannot touch the real ones. */
const FILES = [
  "projection-artifact.json", "weekly-artifact-lineonly.json", "weekly-artifact.json",
  "rank-outcomes.json", "variance-model.json", "correlation-model.json",
  "price-model.json", "age-curve.json", "opportunity-model.json", "opponent-correlation.json",
];

const dir = mkdtempSync(join(tmpdir(), "ff-model-registry-"));
for (const f of FILES) {
  try { copyFileSync(join("data", f), join(dir, f)); } catch { /* optional slots may be absent */ }
}
process.env.FF_DATA = dir;
const { validateModels, modelStatus, MODELS } = await import("../src/draft/models.js");

const statusOf = (key: string) => modelStatus().find((s) => s.key === key)!;
const restore = (f: string) => copyFileSync(join("data", f), join(dir, f));

test("the weekly pair is IN the registry, one required and one not", () => {
  const shipped = MODELS.find((m) => m.key === "weekly");
  const chal = MODELS.find((m) => m.key === "weekly-challenger");
  assert.ok(shipped, "the shipped weekly artifact has no registry entry");
  assert.ok(chal, "the weekly challenger has no registry entry");
  assert.equal(shipped!.file, "weekly-artifact-lineonly.json");
  assert.equal(chal!.file, "weekly-artifact.json");
  assert.equal(shipped!.required, true, "the model the lineup is served from must be required");
  assert.equal(chal!.required, false, "the challenger is evidence, not a dependency");
  // The measured numbers are ON the entry, not only in a doc nobody re-reads.
  assert.match(shipped!.what, /5\.928/);
  assert.match(chal!.what, /5\.268/);
  assert.match(chal!.what, /0\.035/, "the clause the challenger failed is not quoted with its margin");
});

test("POSITIVE CONTROL: against the real artifacts, validateModels returns and both weekly slots are clean", () => {
  validateModels();
  assert.equal(statusOf("weekly").problem, null, "the shipped weekly artifact reports a problem: " + statusOf("weekly").problem);
  assert.equal(statusOf("weekly-challenger").problem, null,
    "the challenger reports a problem: " + statusOf("weekly-challenger").problem);
});

test("FAULT INJECTION: a shipped weekly artifact of the OLD SCHEMA is refused by validateModels", () => {
  const p = join(dir, "weekly-artifact-lineonly.json");
  const a = JSON.parse(readFileSync(p, "utf8"));
  a.schema = 1;
  writeFileSync(p, JSON.stringify(a), "utf8");
  try {
    assert.match(String(statusOf("weekly").problem), /schema 1/);
    assert.throws(() => validateModels(), /weekly.*schema 1/s,
      "a schema-1 shipped weekly artifact did not stop validateModels -- an old-schema artifact " +
      "scores every unknown head as zero and produces a slightly different projection with no error");
  } finally { restore("weekly-artifact-lineonly.json"); }
  validateModels();   // and it must go quiet again once the file is restored
});

test("FAULT INJECTION: a challenger that is secretly the floor is REPORTED, and does not throw", () => {
  const p = join(dir, "weekly-artifact.json");
  // The floor, under the challenger's filename: same schema, same loader, valid in every way except
  // that it is not a different model.
  copyFileSync(join("data", "weekly-artifact-lineonly.json"), p);
  try {
    const s = statusOf("weekly-challenger");
    assert.match(String(s.problem), /zeroModel/,
      "a quantile artifact in the challenger slot was accepted -- every weekly_challenger row it " +
      "produced would duplicate the shipped one while looking like independent evidence");
    // ...and it must NOT take the whole system down, because the challenger is not required.
    validateModels();
  } finally { restore("weekly-artifact.json"); }
  assert.equal(statusOf("weekly-challenger").problem, null);
});
