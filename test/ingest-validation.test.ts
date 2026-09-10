// THE INGEST CONTRACT, PROVEN TO BOTH ADMIT AND REFUSE.
//
// A validator that can only ever say "ok" is indistinguishable from one that is genuinely passing --
// CLAUDE.md's recurring lesson. So every guard here is exercised twice: once with an input that MUST
// make it fail, once with an input that MUST make it pass, plus the audit row it leaves behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../src/db/db.js";
import { assertPulled, auditIngest, auditTable, countTable, lastAudits, refreshDecision } from "../src/data/validatedIngest.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  migrate(d);
  return d;
}

test("assertPulled: refuses an empty pull, admits a non-empty one", () => {
  assert.throws(() => assertPulled(0, "ownership"), /returned 0 rows/, "an empty pull must refuse the overwrite");
  assert.doesNotThrow(() => assertPulled(5, "ownership"), "a non-empty pull must be allowed through");
});

test("countTable: season-aware, and 0 for an absent table", () => {
  const d = db();
  d.exec(`CREATE TABLE t (season INTEGER, x TEXT)`);
  d.prepare(`INSERT INTO t VALUES (2025,'a'),(2025,'b'),(2026,'c')`).run();
  assert.equal(countTable(d, "t"), 3);
  assert.equal(countTable(d, "t", 2025), 2);
  assert.equal(countTable(d, "t", 2026), 1);
  assert.equal(countTable(d, "no_such_table"), 0, "an absent table means nothing landed, not a throw");
});

test("auditIngest: PASS on real rows, FAIL on an empty write -- and both leave an audit row", () => {
  const d = db();
  d.exec(`CREATE TABLE raw_x (season INTEGER, v TEXT)`);
  // PASS: rows present.
  d.prepare(`INSERT INTO raw_x VALUES (2026,'a'),(2026,'b')`).run();
  const good = auditIngest(d, { source: "raw_x", season: 2026, rowsWritten: 2, readback: () => countTable(d, "raw_x", 2026) });
  assert.equal(good.ok, true);
  assert.equal(good.rowsReadback, 2);
  // FAIL: a writer that CLAIMS it wrote 500 but the table is empty (the silent no-op).
  const bad = auditIngest(d, { source: "raw_empty", season: 2026, rowsWritten: 500, readback: () => 0 });
  assert.equal(bad.ok, false, "a claimed write of 500 with 0 rows present must fail");
  assert.match(bad.reason, /readback 0/);
  // Both are recorded, so a failure is never lost.
  const audits = lastAudits(d);
  assert.equal(audits.find((a) => a.source === "raw_x")?.ok, true);
  assert.equal(audits.find((a) => a.source === "raw_empty")?.ok, false);
});

test("auditIngest: an empty pull is caught even when STALE rows remain in the table", () => {
  const d = db();
  d.exec(`CREATE TABLE raw_stale (season INTEGER, v TEXT)`);
  d.prepare(`INSERT INTO raw_stale VALUES (2026,'old1'),(2026,'old2')`).run(); // last week's rows, still here
  // This week's pull returned nothing (rowsWritten 0), but the readback still finds the 2 stale rows.
  // The readback signal alone would say "2 rows, fine"; the writer-count signal catches the empty pull.
  const v = auditIngest(d, { source: "raw_stale", season: 2026, rowsWritten: 0, readback: () => countTable(d, "raw_stale", 2026) });
  assert.equal(v.ok, false, "an empty pull that leaves stale rows must still fail");
  assert.match(v.reason, /pull was empty/);
});

test("auditIngest: minFractionOfPrev catches a COLLAPSE against the last good sync", () => {
  const d = db();
  // First good sync: 200 rows.
  auditIngest(d, { source: "espn_proj", season: 2026, rowsWritten: 200, readback: () => 200, policy: { minFractionOfPrev: 0.5 } });
  // Next sync returns 3 -- above minRows(1) but a collapse vs 200.
  const collapse = auditIngest(d, { source: "espn_proj", season: 2026, rowsWritten: 3, readback: () => 3, policy: { minFractionOfPrev: 0.5 } });
  assert.equal(collapse.ok, false, "3 rows after 200 is a collapse and must fail");
  assert.match(collapse.reason, /collapsed/);
  // A healthy follow-up (150) passes the same policy.
  const healthy = auditIngest(d, { source: "espn_proj", season: 2026, rowsWritten: 150, readback: () => 150, policy: { minFractionOfPrev: 0.5 } });
  assert.equal(healthy.ok, true);
});

test("refreshDecision: an empty pull wipes nothing that exists, replaces when it has rows, no-ops when empty-on-empty", () => {
  // The ownership sync's core: full-refresh delete-then-insert must not lose data on an empty read.
  assert.equal(refreshDecision(150, 150), "replace", "a real pull does the normal wipe+replace");
  assert.equal(refreshDecision(0, 150), "refuse-empty-wipe", "an empty pull with 150 stored must NOT wipe them");
  assert.equal(refreshDecision(0, 0), "noop-empty", "empty pull on an empty table (pre-draft) is a harmless no-op, not a failure");
  assert.equal(refreshDecision(1, 0), "replace", "a first, non-empty pull replaces");
});

test("auditTable throwOnFail: a degenerate write is fatal for a sync verb, silent for a best-effort refresh", () => {
  const d = db();
  d.exec(`CREATE TABLE empty_sync_tbl (x TEXT)`); // left empty
  assert.throws(
    () => auditTable(d, { source: "ownership", table: "empty_sync_tbl", rowsWritten: 0, throwOnFail: true }),
    /validation FAILED/,
    "a sync verb must throw when its write left the table empty",
  );
  // Same degenerate write, best-effort: records the failure, does not throw.
  const v = auditTable(d, { source: "ownership", table: "empty_sync_tbl", rowsWritten: 0 });
  assert.equal(v.ok, false);
});
