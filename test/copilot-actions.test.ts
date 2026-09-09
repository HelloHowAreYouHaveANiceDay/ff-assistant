/**
 * THE D3 INVARIANT FOR ADVICE: every recommendation is written to the action log BEFORE it is
 * returned.
 *
 * The instinct in a read-only phase is that there is nothing to log -- no ESPN write happens, so
 * what is there to record? That is exactly backwards. What the Assistant does in this phase IS give
 * advice, and advice a human acts on is still the agent driving the team. The black-box recorder has
 * to see it, or the first thing the log will contain when the write tools arrive is a roster move
 * with no trace of the reasoning that produced it.
 *
 * The tests below assert three separate properties, because they fail independently:
 *   1. a row appears at all, carrying the verb, the arguments and the summary;
 *   2. it is written BEFORE the work, proved by a verb that FAILS -- a log written after the result
 *      would have nothing to write when the dispatch throws, and the row would be absent;
 *   3. the summary carries the caveat, so the log records what the number was conditioned on.
 *
 * And the fault injection the whole file rests on: a call that skips the log must leave the count
 * unchanged. Without that, every assertion here could be comparing a row the fixture put there
 * itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { runCopilot, COPILOT_VERBS, caveat } from "../src/inseason/copilotActions.js";
import { seasonOdds } from "../src/inseason/copilot.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";

/** A throwaway store. `openDb` applies the schema and seeds a default config, which is all the
 *  provenance loader and the action log need -- no board, no league, no app. */
function tmpDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "ff-copilot-")), "ff.db");
  openDb(path).close();
  return path;
}
const rows = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  const out = db.prepare("SELECT id, run_type, action, detail_json, status, reason FROM action_log ORDER BY id").all() as
    { id: number; run_type: string; action: string; detail_json: string; status: string; reason: string }[];
  db.close();
  return out;
};

test("every recommendation lands in the action log with its verb, arguments and summary", async () => {
  const dbPath = tmpDb();
  assert.equal(rows(dbPath).length, 0, "the fixture store is not empty -- nothing below would prove anything");

  const run = await runCopilot("season_odds", { trials: 200, seed: 11 }, { dbPath, ctx: fixtureCtx() });
  const logged = rows(dbPath);
  assert.equal(logged.length, 1, JSON.stringify(logged));
  assert.equal(logged[0].id, run.logId, "the returned log id does not name the row that was written");
  assert.equal(logged[0].action, "season_odds");
  assert.equal(logged[0].run_type, "copilot");
  assert.equal(logged[0].status, "recommended", "advice was logged as though a roster move had happened");
  assert.equal(logged[0].reason, run.summary, "the log records a different summary from the one returned");
  assert.deepEqual(JSON.parse(logged[0].detail_json).args, { trials: 200, seed: 11 });
});

test("FAULT: a call that does NOT log leaves the action log empty -- the assertion above can fail", async () => {
  // The same work, reached directly instead of through the dispatcher. If this still produced a row
  // the test above would be measuring something the fixture did, not something runCopilot did.
  const dbPath = tmpDb();
  const r = seasonOdds(fixtureCtx(), { trials: 200, seed: 11 });
  assert.ok(r.us.champion >= 0, "the work really did run");
  assert.equal(rows(dbPath).length, 0, "a row appeared without anything logging it");
});

test("the log is written BEFORE the work: a verb that THROWS still leaves a row, marked failed", async () => {
  const dbPath = tmpDb();
  await assert.rejects(
    () => runCopilot("depth_risk", {}, { dbPath, ctx: fixtureCtx() }),
    /needs a player name/,
  );
  const logged = rows(dbPath);
  assert.equal(logged.length, 1, "a recommendation that failed left no trace -- the log is written after the work");
  assert.equal(logged[0].action, "depth_risk");
  assert.equal(logged[0].status, "failed");
  assert.match(logged[0].reason, /needs a player name/);
});

test("the summary carries the caveat, so the log records what the number was conditioned on", async () => {
  const dbPath = tmpDb();
  const run = await runCopilot("season_odds", { trials: 200 }, { dbPath, ctx: fixtureCtx({ synthetic: true }) });
  assert.match(run.summary, /GENERATED schedule/, run.summary);
  assert.match(run.summary, /200 trials/, run.summary);
  // ... and a REAL schedule must say so instead, or the caveat is a constant rather than a report.
  const real = await runCopilot("season_odds", { trials: 200 }, { dbPath, ctx: fixtureCtx({ synthetic: false }) });
  assert.match(real.summary, /REAL schedule/, real.summary);
  assert.ok(!/GENERATED/.test(real.summary), "a real schedule was still described as generated");
});

test("caveat() names the basis: a projection is not described as a simulation", () => {
  const sim = caveat({ schedule: "real", basis: "simulation", trials: 100, seeds: [7], artifact: { season: 2026, boardRows: 1, varianceSeasons: null, sampler: "x", projectionArtifact: null }, asOf: "" });
  const proj = caveat({ schedule: "real", basis: "projection", trials: null, seeds: null, artifact: { season: 2026, boardRows: 1, varianceSeasons: null, sampler: "x", projectionArtifact: null }, asOf: "" });
  assert.match(sim, /100 trials/);
  assert.match(proj, /no simulation/);
  assert.notEqual(sim, proj, "the caveat is the same string regardless of basis -- it reports nothing");
});

test("an unknown verb is refused rather than silently doing nothing", async () => {
  const dbPath = tmpDb();
  await assert.rejects(() => runCopilot("set_lineup" as never, {}, { dbPath, ctx: fixtureCtx() }), /unknown copilot verb/);
  assert.equal(rows(dbPath).length, 0, "an unknown verb still wrote a log row");
});

test("the dispatcher's verb list is the nine in-season verbs, in MCP tool-name form", () => {
  assert.deepEqual([...COPILOT_VERBS].sort(), [
    "depth_risk", "handcuffs", "lineup_recommend", "playoff_sos", "power_rankings",
    "season_odds", "trade_check", "trade_finder", "waiver_targets",
  ]);
  for (const v of COPILOT_VERBS) assert.match(v, /^[a-z][a-z0-9_]*$/, `${v} is not a valid MCP identifier`);
});
