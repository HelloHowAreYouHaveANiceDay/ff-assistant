// The in-season scheduler's config + routine registry (src/inseason/routines.ts). The app's timer and
// the copilot both read/write this one config, so its validation is the thing that stops a bad routine
// name or a silly cadence from reaching the timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
  // id outside RAW_ASSETS. THE LIST IS A MIRROR OF `HANDLERS` IN src/ff.ts AND ROTS IF THAT MAP
  // GROWS: it is kept because the map lives inside a function that cannot be imported without
  // running the CLI, so a derived check is not available. Adding a verb here without adding it there
  // reinstates exactly the silent skip this test exists to prevent.
  const known = new Set(["sync-actuals", "scorecard", "refresh-decisions", "sync-league", "ingest-source"]);
  for (const [name, r] of Object.entries(ROUTINES)) {
    for (const [verb] of r.steps) {
      assert.ok(known.has(verb), `routine ${name} names verb "${verb}" that inseason-tick has no handler for`);
    }
  }
});
