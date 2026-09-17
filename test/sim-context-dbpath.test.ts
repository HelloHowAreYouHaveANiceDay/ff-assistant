import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSimContext } from "../src/draft/simContext.js";
import { copilotContext } from "../src/inseason/copilotActions.js";

// `ff copilot --db <path>` exists so a COUNTERFACTUAL copy of the store (a trade reversed, a roster
// edited) can be simulated. Until 2026-09-17 the path reached the provenance loaders but the
// simulation context always opened the live data/ff.db, so a --db run reported the live rosters
// while saying nothing -- a pre-trade world and the live world came back IDENTICAL to the trial.
// The cheapest signal the broken case cannot satisfy: a path that does not exist must make the
// context loader fail on THAT path. If the loader ignores dbPath it opens the live store and
// succeeds (or fails for some unrelated reason that does not name the path).
const bogus = join(tmpdir(), "ff-sim-context-does-not-exist-" + process.pid + ".db");

test("loadSimContext opens the store it is given, not data/ff.db", async () => {
  await assert.rejects(
    loadSimContext({ schedule: "generated", dbPath: bogus }),
    (e: unknown) => /unable to open|cannot open|SQLITE_CANTOPEN|no such file/i.test(String((e as Error)?.message ?? e)),
  );
});

test("copilotContext threads dbPath through to the simulation context", async () => {
  await assert.rejects(
    copilotContext("generated", null, bogus),
    (e: unknown) => /unable to open|cannot open|SQLITE_CANTOPEN|no such file/i.test(String((e as Error)?.message ?? e)),
  );
});
