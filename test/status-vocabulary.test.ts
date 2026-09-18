/**
 * THE AVAILABILITY VOCABULARY IS CHECKED AGAINST THE PRODUCERS, NOT AGAINST ITSELF.
 *
 * `normalizeStatus` used to hold a hand-typed set of seven upper-cased abbreviations and compare
 * literally. Two producers write into it and they do not share a spelling:
 *
 *   player_status.injury_status   ->  "IR"                 (matched)
 *   raw_gameday_status.status     ->  "Injured Reserve"    (matched NOTHING)
 *
 * So every man on injured reserve fell through to the function's `return "ACTIVE"` and read as fully
 * startable to the lineup serve, the waiver verb and everything downstream. Measured on 2026-09-18:
 * 30 of the 128 players in the latest game-day week, 89 rows across the season. The live cost was a
 * waiver recommendation to spend FAAB on a running back who was on IR, with a confident playoff
 * delta attached.
 *
 * It survived because the feed's OTHER four values -- Out, Doubtful, Suspension, Questionable -- all
 * happened to match, so the vocabulary looked handled. That is the failure this file exists to
 * prevent, and the only way to prevent it is to stop asking the list about itself: the store-backed
 * test below reads the DISTINCT values out of the real tables and requires every one to be
 * recognised. A new spelling from either feed fails here instead of going quietly startable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { canonStatus, isKnownStatus, normalizeStatus, unknownStatusesSeen } from "../src/inseason/copilot.js";

// --- the defect itself, pinned -------------------------------------------------------------------

test("REGRESSION: every spelling of injured reserve is OUT", () => {
  for (const s of ["IR", "Injured Reserve", "INJURED RESERVE", "injured-reserve", "INJURED_RESERVE", "Reserve/Injured"]) {
    assert.equal(normalizeStatus(s), "OUT", `${JSON.stringify(s)} must rule a man out`);
  }
});

test("the other game-day values keep the meaning they already had", () => {
  // The positive control against over-correction: a fix that ruled EVERYONE out would pass the test
  // above and destroy every lineup. QUESTIONABLE in particular must stay startable -- that is a
  // measured decision (he plays more often than not), not an oversight.
  assert.equal(normalizeStatus("Out"), "OUT");
  assert.equal(normalizeStatus("Doubtful"), "OUT");
  assert.equal(normalizeStatus("Suspension"), "OUT");
  assert.equal(normalizeStatus("Questionable"), "QUESTIONABLE");
  assert.equal(normalizeStatus("Probable"), "ACTIVE");
  assert.equal(normalizeStatus("Active"), "ACTIVE");
  assert.equal(normalizeStatus(null), "ACTIVE");
  assert.equal(normalizeStatus(""), "ACTIVE");
});

test("canonicalisation collapses case, punctuation and spacing -- and nothing else", () => {
  assert.equal(canonStatus("  injured-reserve  "), "INJURED RESERVE");
  assert.equal(canonStatus("Injured_Reserve"), "INJURED RESERVE");
  assert.equal(canonStatus("OUT"), "OUT");
  assert.equal(canonStatus(null), "");
  // It must NOT collapse two genuinely different statuses onto one token.
  assert.notEqual(canonStatus("Out"), canonStatus("Doubtful"));
});

test("an UNRECOGNISED status defaults to ACTIVE but is RECORDED", () => {
  // The default is deliberate -- benching a man on a string we failed to parse is worse than
  // starting him -- so the record is the whole safeguard. If this ever stops recording, the next
  // vocabulary drift is silent again.
  unknownStatusesSeen.clear();
  assert.equal(normalizeStatus("Frobnicated"), "ACTIVE");
  assert.equal(isKnownStatus("Frobnicated"), false);
  assert.equal(unknownStatusesSeen.get("FROBNICATED"), 1);
  normalizeStatus("frobnicated!");
  assert.equal(unknownStatusesSeen.get("FROBNICATED"), 2, "canonicalised, so one token counts twice");

  // And a KNOWN status must never be recorded as unknown -- otherwise the warning cries wolf every
  // run and stops being read, which is the same silence by another route.
  unknownStatusesSeen.clear();
  for (const s of ["Out", "IR", "Injured Reserve", "Questionable", "Probable", "Active", ""]) normalizeStatus(s);
  assert.equal(unknownStatusesSeen.size, 0, `known statuses were flagged: ${[...unknownStatusesSeen.keys()].join(", ")}`);
});

// --- against the producers ----------------------------------------------------------------------

const DB = "data/ff.db";

test("REAL STORE: every status value the feeds actually write is recognised", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  const db = new Database(DB, { readonly: true });
  try {
    // THE LIST IS DERIVED, NOT RETYPED. Each of these columns feeds `normalizeStatus` somewhere in
    // `loadAvailability`; asking the store what it holds is the only check that can notice a
    // producer inventing a spelling.
    const sources: { label: string; sql: string }[] = [
      { label: "raw_gameday_status.status", sql: "SELECT DISTINCT status AS v FROM raw_gameday_status WHERE status IS NOT NULL" },
      { label: "player_status.injury_status", sql: "SELECT DISTINCT injury_status AS v FROM player_status WHERE injury_status IS NOT NULL" },
      { label: "raw_injury.report_status", sql: "SELECT DISTINCT report_status AS v FROM raw_injury WHERE report_status IS NOT NULL" },
    ];
    const unknown: string[] = [];
    let checked = 0;
    for (const src of sources) {
      let rows: { v: string }[] = [];
      try { rows = db.prepare(src.sql).all() as { v: string }[]; } catch { continue; }
      for (const r of rows) {
        checked++;
        if (!isKnownStatus(r.v)) unknown.push(`${src.label}: ${JSON.stringify(r.v)}`);
      }
    }
    assert.ok(checked > 0, "no status values were read at all -- this test would pass vacuously");
    assert.deepEqual(unknown, [],
      "these status values are not in the vocabulary and are being defaulted to ACTIVE. Add them to " +
      "OUT_STATUSES or STARTABLE_STATUSES in src/inseason/copilot.ts.");
  } finally { db.close(); }
});

test("REAL STORE: an IR designation actually rules the man out end to end", { skip: !existsSync(DB) && "no data/ff.db" }, () => {
  // The composed assertion. The unit tests above prove the FUNCTION is right; this proves the
  // function is what the store's rows reach -- the distinction the repo keeps paying for.
  const db = new Database(DB, { readonly: true });
  try {
    const ir = db.prepare(
      "SELECT name, status FROM raw_gameday_status WHERE status LIKE '%Injured Reserve%' LIMIT 5",
    ).all() as { name: string; status: string }[];
    if (!ir.length) return; // nothing on IR in this store; the unit tests still stand
    for (const r of ir) assert.equal(normalizeStatus(r.status), "OUT", `${r.name} (${r.status}) must be OUT`);
  } finally { db.close(); }
});
