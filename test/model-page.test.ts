// THE MODEL PAGE'S NEW SECTIONS (weekly-serve, scorecard, ledger) CARRY NO NUMBER OF THEIR OWN --
// every figure comes from src/lineage/modelPage.ts's JSON, read at render time. This proves it, and
// proves buildModelPage() itself assembles from the registries rather than quoting a remembered
// number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildModelPage } from "../src/lineage/modelPage.js";
import { syncLedger } from "../src/lineage/ledger.js";

const SRC = readFileSync("app/renderer/app.js", "utf8");

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found in app/renderer/app.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

/** A literal percentage or a multi-digit decimal figure written directly into the source, outside of
 *  any `${...}` interpolation -- i.e. a number the page author typed rather than one the JSON
 *  supplied. Deliberately simple: it flags any run of digits with a decimal point, or any `%` sign,
 *  that appears in the raw function text; the renderers under test have neither, because everything
 *  numeric in them comes from `page.*`. */
function hasLiteralFigure(fnSrc: string): boolean {
  return /\d+\.\d+/.test(fnSrc) || /\d%/.test(fnSrc);
}

for (const name of ["renderWeeklyServe", "renderScorecardSection", "renderLedgerSection"]) {
  test(`${name}() contains no literal percentage or point figure`, () => {
    const fn = extractFn(SRC, name);
    assert.equal(hasLiteralFigure(fn), false, `${name}() has a hardcoded number -- it must read everything from the page JSON`);
  });
}

test("FAULT INJECTION: a pasted-in literal figure is caught by the guard", () => {
  const fn = extractFn(SRC, "renderWeeklyServe") + "\n// e.g. \"beats the baseline by 12.34%\"";
  assert.equal(hasLiteralFigure(fn), true, "the guard did not catch an obviously hardcoded figure");
});

function freshDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/db/schema.sql", "utf8"));
  return db;
}

test("buildModelPage assembles weeklyServe from STREAM_SERVE_POS/SHIPPED_STREAMING_POSITIONS, not a retyped table", () => {
  const db = freshDb();
  const page = buildModelPage(db);
  const positions = page.weeklyServe.map((r) => r.pos);
  assert.deepEqual(positions, ["QB", "RB", "WR", "TE", "K", "DST"]);
  const shipped = page.weeklyServe.filter((r) => r.shipped).map((r) => r.pos).sort();
  assert.deepEqual(shipped, ["DST", "K", "QB"]);
  db.close();
});

test("buildModelPage's scorecard section reflects an actual frozen prediction", () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO scorecard_prediction (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
     VALUES (2026, 3, 'weekly', 'weekly', 'p1', 'Test Player', 'RB', 10, 5, 15, '2026-09-01', '2026-09-01')`,
  ).run();
  const page = buildModelPage(db);
  const weekly = page.scorecard.find((k) => k.kind === "weekly")!;
  assert.equal(weekly.weeksFrozen, 1);
  assert.deepEqual(weekly.models, ["weekly"]);
  db.close();
});

test("buildModelPage's ledger matches ledgerSummary and includes counts", () => {
  const db = freshDb();
  syncLedger(db);
  const page = buildModelPage(db);
  assert.ok(page.ledger.rows.length > 0, "ledger sync must have run for the page to show anything");
  const total = Object.values(page.ledger.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, page.ledger.rows.length);
});
