// The in-season scheduler's config + routine registry (src/inseason/routines.ts). The app's timer and
// the copilot both read/write this one config, so its validation is the thing that stops a bad routine
// name or a silly cadence from reaching the timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import {
  ROUTINES, DEFAULT_ROUTINES, DEFAULT_SCHEDULE, getSchedule, setSchedule, stepsFor, clampMinutes,
} from "../src/inseason/routines.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ff-routines-"));
  return openDb(join(dir, "t.db"));
}

test("an absent config reads the default; the default routines are all real", () => {
  const db = freshDb();
  const cfg = getSchedule(db);
  assert.deepEqual(cfg, DEFAULT_SCHEDULE);
  for (const r of DEFAULT_ROUTINES) assert.ok(r in ROUTINES, `${r} is a default but not in the registry`);
  db.close();
});

test("setSchedule persists a partial patch over the current config", () => {
  const db = freshDb();
  setSchedule(db, { enabled: true, everyMinutes: 20 });
  let cfg = getSchedule(db);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.everyMinutes, 20);
  assert.deepEqual(cfg.routines, DEFAULT_SCHEDULE.routines, "routines untouched by a patch that omits them");
  // A second partial patch changes only what it names.
  setSchedule(db, { routines: ["actuals"] });
  cfg = getSchedule(db);
  assert.equal(cfg.enabled, true, "enabled survived a routines-only patch");
  assert.deepEqual(cfg.routines, ["actuals"]);
  db.close();
});

test("FAULT INJECTION: an unknown routine name is DROPPED, never stored, and reported", () => {
  const db = freshDb();
  const { config, droppedRoutines } = setSchedule(db, { routines: ["actuals", "not_a_routine", "scorecard"] });
  assert.deepEqual(droppedRoutines, ["not_a_routine"]);
  assert.deepEqual(config.routines, ["actuals", "scorecard"], "the bad name must not survive into the stored config");
  // And it is really gone from what a later read (the app's timer) sees.
  assert.deepEqual(getSchedule(db).routines, ["actuals", "scorecard"]);
  db.close();
});

test("clampMinutes bounds the cadence to [5, 720]; a nonsense value falls to the default", () => {
  assert.equal(clampMinutes(1), 5);
  assert.equal(clampMinutes(99999), 720);
  assert.equal(clampMinutes(15), 15);
  assert.equal(clampMinutes(NaN), DEFAULT_SCHEDULE.everyMinutes);
  // setSchedule applies it.
  const db = freshDb();
  assert.equal(setSchedule(db, { everyMinutes: 1 }).config.everyMinutes, 5);
  db.close();
});

test("stepsFor resolves in REGISTRY order and de-dupes, skipping unknowns", () => {
  // Names given out of order and with a repeat + an unknown.
  const { steps, ran, unknown } = stepsFor(["scorecard", "actuals", "actuals", "bogus"]);
  assert.deepEqual(unknown, ["bogus"]);
  // registry order is actuals, scorecard, decisions, roster -> so actuals precedes scorecard here.
  assert.deepEqual(ran, ["actuals", "scorecard"]);
  const verbs = steps.map((s) => s[0]);
  assert.deepEqual(verbs, ["sync-actuals", "scorecard"]);
});

test("every registry routine names verbs that the tick's handler map can run", () => {
  // The tick maps these verbs to handlers; a routine that named anything else would SKIP silently.
  // `ingest-source` joined the map with the M2b `rankings` routine -- and this assertion is what
  // caught that the routine had originally named `ingest-raw`, which `cmdIngestRaw` refuses for any
  // id outside RAW_ASSETS.
  //
  // THE LIST IS NOW DERIVED FROM src/ff.ts, NOT RETYPED (M2c, 2026-09-16). It used to be a hand-kept
  // mirror of `HANDLERS`, which is coverage-by-enumeration: it is a snapshot of the day it was
  // written, and the failure mode is not that it breaks but that somebody keeps it in step with the
  // registry and NOT with the map -- adding a verb here without adding it there reinstates exactly
  // the silent skip this test exists to prevent. The map lives inside a function that cannot be
  // imported without running the CLI, so it is read out of the SOURCE instead.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "ff.ts"), "utf8");
  // NOT `Record<[^>]*>`: the value type is itself generic (`=> Promise<void>>`), so a lazy
  // angle-bracket match stops early and finds nothing. The control below is what caught that.
  const block = /const HANDLERS:[\s\S]*?=\s*\{([\s\S]*?)\n {2}\};/.exec(src);
  assert.ok(block, "could not find the HANDLERS map in src/ff.ts -- this check parses it, so a miss is a BROKEN check, not a pass");
  const known = new Set([...block![1].matchAll(/"([a-z-]+)":/g)].map((m) => m[1]));
  // THE POSITIVE CONTROL. A regex that matched nothing would leave an empty set, every routine would
  // fail loudly -- but a regex that matched the WRONG block would leave a set that passes for the
  // wrong reason. So assert the extraction really found the map.
  assert.ok(known.size >= 5, `parsed only ${known.size} handler verbs -- the extraction is wrong`);
  assert.ok(known.has("sync-actuals") && known.has("scorecard"), "the parsed set must contain the verbs the map demonstrably has");
  for (const [name, r] of Object.entries(ROUTINES)) {
    for (const [verb] of r.steps) {
      assert.ok(known.has(verb), `routine ${name} names verb "${verb}" that inseason-tick has no handler for`);
    }
  }
});
