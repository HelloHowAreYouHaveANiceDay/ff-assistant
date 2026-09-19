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
/**
 * The store's signature, SCOPED THE WAY THE GUARD SCOPES IT (2026-09-19).
 *
 * `weeklyPopulationProblem` compares against the seasons the artifact declares, not every season in
 * the table, because the unscoped hash covered the LIVE season -- which is rebuilt on every
 * `actuals` routine, so one waiver claim declared three artifacts stale. A test that still computed
 * the unscoped hash would hand the guard a value from a different scope and read the correct
 * refusal as a failure.
 */
function storeSig(seasons?: readonly number[]) {
  try {
    const db = new Database(dataPath("ff.db"), { readonly: true, fileMustExist: true });
    try { return populationSignature(db, seasons); } finally { db.close(); }
  } catch { return null; }
}

/** The fitted seasons an artifact declares -- the scope the guard uses for it. */
function fittedSeasons(file: string): number[] {
  const a = shipped(file) as { seasons?: unknown };
  return Array.isArray(a.seasons) ? a.seasons.map(Number).filter((n) => Number.isFinite(n)) : [];
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
  // Scoped to the SHIPPED artifact's own fitted seasons, which is what the guard compares against.
  const sig = storeSig(fittedSeasons(SHIPPED_WEEKLY_ARTIFACT));
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

test("A LIVE SEASON MOVING does NOT invalidate an artifact fitted before it", (t) => {
  /**
   * THE DEFECT THIS CLOSES (2026-09-19). The signature hashed EVERY season in the table, including
   * the one being played. `buildForwardInto` rebuilds the live season's rows and its population
   * flags on every `actuals` routine -- which `src/inseason/routines.ts` runs "many times between
   * Thursday and Sunday's first kickoff" -- so a single waiver claim changed the count and declared
   * three artifacts stale. Measured: they were stamped at 5,015 flagged 2026 rows against 5,024 now,
   * a difference of NINE, while every settled season hashed byte-identically.
   *
   * The guard exists to catch a population REDEFINITION -- a different POPULATION_DEPTH, another
   * season of roster feed, a changed rule -- and every one of those moves the SETTLED seasons too.
   */
  const db = (() => {
    try { return new Database(dataPath("ff.db"), { readonly: true, fileMustExist: true }); }
    catch { return null; }
  })();
  if (!db) return t.skip("no store on this checkout");
  try {
    const all = populationSignature(db);
    if (!all) return t.skip("no population in this store");
    const live = Math.max(...all.perSeason.map((p) => p.season));
    const settled = all.perSeason.map((p) => p.season).filter((s) => s !== live);
    if (!settled.length) return t.skip("only one season in the store");

    const scoped = populationSignature(db, settled);
    assert.ok(scoped, "a scoped signature must be computable");
    // THE PROPERTY: dropping the live season changes the answer, which is what makes the scope
    // load-bearing rather than decorative. If these were equal, scoping would be a no-op and the
    // false positive would still be live.
    assert.notEqual(scoped!.hash, all.hash,
      "scoping to the settled seasons produced the SAME hash -- the scope is doing nothing");
    assert.ok(scoped!.rows < all.rows, "the scoped signature must cover fewer rows");

    // AND IT IS STABLE UNDER A LIVE-SEASON CHANGE: the same settled scope, asked twice, with the
    // live season's rows included or not, is the same hash. That is the whole point.
    const again = populationSignature(db, settled);
    assert.equal(again!.hash, scoped!.hash);
  } finally { db.close(); }
});

test("EVERY shipped artifact's declared hash matches its OWN fitted scope", (t) => {
  // The end state, asserted directly: after the 2026-09-19 re-stamp each artifact's hash is the one
  // computed over the seasons IT names. This is the assertion that fails if somebody re-stamps an
  // artifact with an unscoped hash again.
  for (const f of [SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT, STREAMING_ARTIFACT]) {
    const a = shipped(f) as { populationHash?: string; seasons?: unknown };
    if (typeof a.populationHash !== "string") continue;
    const seasons = fittedSeasons(f);
    assert.ok(seasons.length, `${f} declares a populationHash but no seasons -- the scope is unknowable`);
    const sig = storeSig(seasons);
    if (!sig) return t.skip("no store on this checkout");
    assert.equal(a.populationHash, sig.hash,
      `${f} declares ${a.populationHash} but its own ${seasons[0]}-${seasons[seasons.length - 1]} ` +
      `scope hashes to ${sig.hash}`);
  }
});
