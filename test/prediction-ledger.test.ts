// THE PREDICTION LEDGER MUST STAY COMPLETE AGAINST THE DOC: every P<n>/W<n> id docs/redesign-2026-09.md
// records in its two prediction tables has a row in data/predictions.json, and vice versa. A ledger
// that silently drops or invents an id is worse than no ledger, because it LOOKS authoritative.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { loadPredictionsJson, syncLedger, ledgerSummary, docPredictionIds } from "../src/lineage/ledger.js";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/db/schema.sql", "utf8"));
  return db;
}

test("every id in the doc's prediction tables has a ledger row, and vice versa", () => {
  const docIds = docPredictionIds();
  const rows = loadPredictionsJson();
  const rowIds = new Set(rows.map((r) => r.id));
  const missingFromLedger = [...docIds].filter((id) => !rowIds.has(id)).sort();
  const extraInLedger = [...rowIds].filter((id) => !docIds.has(id)).sort();
  assert.deepEqual(missingFromLedger, [], `doc names these ids with no ledger row: ${missingFromLedger.join(", ")}`);
  assert.deepEqual(extraInLedger, [], `ledger has ids the doc's tables do not: ${extraInLedger.join(", ")}`);
  // P21-P24 are explicitly "never issued" -- the doc says so in prose, not in a table row, so they
  // must NOT be demanded by the table-row scan (that would be requiring a row for a prediction that,
  // by the doc's own account, was never made).
  assert.ok(!docIds.has("P21") && !docIds.has("P24"), "P21/P24 leaked in from prose, not a table row");
});

test("outcome is mechanically one of held/failed/split/pending for every row", () => {
  for (const r of loadPredictionsJson()) {
    assert.ok(["held", "failed", "split", "pending"].includes(r.outcome), `${r.id}: bad outcome ${r.outcome}`);
  }
});

test("syncLedger rebuilds fact_prediction from the checked-in file, and drops a stale id", () => {
  const db = freshDb();
  const rows = loadPredictionsJson();
  syncLedger(db, rows);
  const { rows: got, counts } = ledgerSummary(db);
  assert.equal(got.length, rows.length);
  assert.ok(counts.held > 0 && counts.failed > 0);
  // now sync with one row removed -- the ledger must shrink, not keep a stale row around
  syncLedger(db, rows.filter((r) => r.id !== "P16"));
  const after = ledgerSummary(db).rows;
  assert.ok(!after.some((r) => r.id === "P16"), "P16 was removed from the source but is still in the ledger");
  assert.equal(after.length, rows.length - 1);
});

test("FAULT INJECTION: delete a ledger row and the completeness test names it", () => {
  const rows = loadPredictionsJson().filter((r) => r.id !== "P5");
  const rowIds = new Set(rows.map((r) => r.id));
  const missing = [...docPredictionIds()].filter((id) => !rowIds.has(id));
  assert.deepEqual(missing, ["P5"], "removing P5 from the ledger did not get named by the completeness check");
});
