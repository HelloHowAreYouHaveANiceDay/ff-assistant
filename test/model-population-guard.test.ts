// A WEEKLY ARTIFACT MUST BE A MODEL OF THE POPULATION THE STORE HOLDS.
//
// Track F's finding was that the trainer and the harness selected different rows, and `in_population`
// made them equal BY CONSTRUCTION -- for one build. The next build is the gap: rebuild the flags
// (a different `ROSTER_DEPTH`, another season of roster feed, any re-run of `buildPopulation`) and an
// artifact fitted on the OLD set is still on disk, still declares `rowFilter: "in_population"`, and
// still loads. Every number it then produces is about players the store no longer selects, and the
// registry -- whose whole job is noticing that a model has stopped being trustworthy -- says `ok`.
//
// So `weeklyPopulationProblem` refuses two things, and this file injects both faults:
//   1. an artifact of the PREVIOUS population (rowFilter absent, or the old line cut);
//   2. an artifact whose declared `populationHash` is not the store's.
// and asserts the two cases that must NOT be refused, because a guard that refuses everything is a
// broken gate rather than a strict one: today's shipped artifacts (which carry no hash, having been
// fitted before the field existed) and a hash that matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { weeklyPopulationProblem, modelStatus } from "../src/draft/models.js";
import { dataPath } from "../src/data/paths.js";
import { populationSignature, POPULATION_COLUMN } from "../src/weekly/population.js";
import { SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT } from "../src/weekly/projector.js";
import { STREAMING_ARTIFACT } from "../src/weekly/streamingServe.js";

const shipped = (file: string) => JSON.parse(readFileSync(dataPath(file), "utf8")) as Record<string, unknown>;

/** The store's own signature, or null on a checkout with no store. Every assertion that depends on a
 *  store is skipped rather than asserted-through on null: a test that passes because it could not
 *  read anything is the failure mode this whole file is about. */
function storeSig() {
  try {
    const db = new Database(dataPath("ff.db"), { readonly: true, fileMustExist: true });
    try { return populationSignature(db); } finally { db.close(); }
  } catch { return null; }
}

test("the three weekly artifacts on disk declare the decision population and PASS", () => {
  for (const f of [SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT, STREAMING_ARTIFACT]) {
    const j = shipped(f);
    assert.equal(j.rowFilter, POPULATION_COLUMN, `${f} does not declare the decision population`);
    assert.equal(weeklyPopulationProblem(j), null, `${f} was refused and should not be`);
  }
});

test("FAULT INJECTION: an artifact of the PREVIOUS population is REFUSED, by name", () => {
  const j = shipped(SHIPPED_WEEKLY_ARTIFACT);

  // (a) the pre-Track-F shape: no rowFilter at all.
  const noFilter = { ...j };
  delete (noFilter as Record<string, unknown>).rowFilter;
  const p1 = weeklyPopulationProblem(noFilter);
  assert.ok(p1, "an artifact with NO rowFilter was accepted -- that is every pre-Track-F artifact");
  assert.match(p1!, /ABSENT/);
  assert.match(p1!, /PREVIOUS population/);

  // (b) the trainer's own line cut, which is the rule that actually differed from the harness's.
  const oldCut = { ...j, rowFilter: "season_line_pg >= 3" };
  const p2 = weeklyPopulationProblem(oldCut);
  assert.ok(p2, "an artifact declaring the old line cut was accepted");
  assert.match(p2!, /season_line_pg/);
});

test("FAULT INJECTION: a populationHash that is not the store's is REFUSED", (t) => {
  const sig = storeSig();
  if (!sig) return t.skip("no store on this checkout -- the hash arm cannot be exercised");

  // The POSITIVE half first, and it is the half that proves the guard can ever say yes: the store's
  // OWN hash must be accepted. Without it, a guard hardcoded to reject would pass the negative test.
  const good = { ...shipped(SHIPPED_WEEKLY_ARTIFACT), populationHash: sig.hash };
  assert.equal(weeklyPopulationProblem(good), null,
    "the store's own hash was refused -- this guard can only ever say no, which is not a guard");

  // Then the rebuild: one flipped character is a different population.
  const stale = { ...shipped(SHIPPED_WEEKLY_ARTIFACT), populationHash: "0000000000000000" };
  const p = weeklyPopulationProblem(stale);
  assert.ok(p, "an artifact fitted on a DIFFERENT population was accepted");
  assert.match(p!, /populationHash 0000000000000000/);
  assert.match(p!, new RegExp(sig.hash));
  assert.match(p!, /REBUILT/);
});

test("the store's signature is a function of the DEPTH as well as the counts", (t) => {
  const sig = storeSig();
  if (!sig) return t.skip("no store on this checkout");
  // The depth cuts are IN the hashed body, so a depth change that happened to leave the total row
  // count unchanged still moves the hash. Asserting the body's ingredients is the cheapest way to
  // keep that property from being refactored away.
  assert.ok(sig.rows > 0);
  assert.ok(sig.perSeason.length > 0);
  assert.deepEqual(Object.keys(sig.depth).sort(), ["DST", "K", "QB", "RB", "TE", "WR"]);
  assert.match(sig.hash, /^[0-9a-f]{16}$/);
});

test("the registry carries the streaming artifact -- the model that serves QB, K and DST", () => {
  const rows = modelStatus();
  const s = rows.find((r) => r.key === "streaming");
  assert.ok(s, "the streaming model is absent from the registry, so none of its checks run");
  assert.equal(s!.file, STREAMING_ARTIFACT);
  assert.equal(s!.problem, null, `streaming: ${s!.problem}`);
  // And the two Track-J/Track-I entries survived the integration merges.
  for (const key of ["injury-duration", "faab"]) {
    const r = rows.find((x) => x.key === key);
    assert.ok(r, `${key} is not in the registry`);
    assert.equal(r!.problem, null, `${key}: ${r!.problem}`);
  }
});
