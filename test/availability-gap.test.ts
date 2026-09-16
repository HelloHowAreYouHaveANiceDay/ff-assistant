// THE ZERO-SCORER CLASSIFIER (src/inseason/availabilityGap.ts), M2c.
//
// The classifier decides how big the recoverable gap is, so every branch is driven from a fixture
// here rather than from the store -- a test that reads `data/ff.db` measures whatever that store
// happens to hold today, which is the opposite of a regression test.
//
// THE BRANCH THAT MATTERS IS `inactive`, and it is defined by an ABSENCE (no snap row). An absence is
// also what a broken crosswalk looks like, so the tests below drive BOTH directions explicitly: a man
// with a snap row must NOT be called inactive, and a man without one must be. A classifier that only
// ever returned `played` would pass a test that checked only the first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { ensureContextColumns } from "../src/weekly/features.js";
import {
  classifyZero, gapKey, snapPlayedIndex, snapControlRate, fridayIndex,
  ZERO_CLASSES, type FridayIndex, type PlayedIndex,
} from "../src/inseason/availabilityGap.js";

const played: PlayedIndex = new Set([gapKey(5, "100"), gapKey(5, "400")]);
const friday: FridayIndex = new Map([
  [gapKey(5, "200"), { report: null, injOut: true, injDoubtful: false }],
  [gapKey(5, "201"), { report: "Doubtful", injOut: false, injDoubtful: false }],
  [gapKey(5, "202"), { report: "Questionable", injOut: false, injDoubtful: false }],
  [gapKey(5, "100"), { report: null, injOut: false, injDoubtful: false }],
]);
const cls = (sk: string, pos = "WR", blockSaysOut = false) =>
  classifyZero({ week: 5, sk, pos, played, friday, blockSaysOut }).cls;

test("a man who took snaps and scored zero is `played` -- the irreducible floor", () => {
  assert.equal(cls("100"), "played");
});

test("a man with NO snap row and no designation is `inactive` -- the recoverable class", () => {
  assert.equal(cls("300"), "inactive");
});

test("FAULT INJECTION: give the same man a snap row and he must stop being `inactive`", () => {
  // The positive/negative pair. Without this, a classifier hardwired to return `inactive` for
  // everyone unknown would pass the test above and be wrong about every week.
  assert.equal(cls("300"), "inactive");
  const withSnap: PlayedIndex = new Set([...played, gapKey(5, "300")]);
  assert.equal(classifyZero({ week: 5, sk: "300", pos: "WR", played: withSnap, friday, blockSaysOut: false }).cls, "played");
});

test("the index is keyed by WEEK: the same man in another week is not `played` by inheritance", () => {
  // `100` took snaps in week 5 and nothing is known about him in week 6. Reading the season-level
  // presence instead of the week's would silently absolve every inactive of every other week.
  assert.equal(classifyZero({ week: 6, sk: "100", pos: "WR", played, friday, blockSaysOut: false }).cls, "inactive");
});

test("a pre-kickoff designation wins over the snap test, from EITHER column", () => {
  assert.equal(cls("200"), "friday", "inj_out, the column the optimiser reads");
  assert.equal(cls("201"), "friday", "report_status_fri=Doubtful, which never reached inj_doubtful");
});

test("QUESTIONABLE is NOT a Friday out -- he is startable, so his zero is a game-day fact", () => {
  assert.equal(cls("202"), "inactive");
});

test("the `friday` verdict says WHICH side knew, because that is the difference between two bugs", () => {
  const seen = classifyZero({ week: 5, sk: "200", pos: "WR", played, friday, blockSaysOut: true });
  const unseen = classifyZero({ week: 5, sk: "201", pos: "WR", played, friday, blockSaysOut: false });
  assert.match(seen.why, /the block DID say so/);
  assert.match(unseen.why, /never reached the optimiser/);
});

test("a DST is its own class -- never `inactive`, because it has no snap row BY CONSTRUCTION", () => {
  assert.equal(cls("DST:MIN", "DST"), "dst");
  // And the point of the class: a naive run would have called it inactive and inflated the bound.
  assert.notEqual(cls("DST:MIN", "DST"), "inactive");
});

test("every verdict is one of the declared classes", () => {
  for (const sk of ["100", "200", "201", "202", "300", "DST:MIN"]) {
    assert.ok((ZERO_CLASSES as readonly string[]).includes(cls(sk, sk.startsWith("DST") ? "DST" : "WR")));
  }
});

// ------------------------------------------------------------------------------------------------
// THE INDEX BUILDERS, against a real (tiny) store -- the SQL is the part a fixture cannot check.
// ------------------------------------------------------------------------------------------------

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ff-avgap-"));
  return openDb(join(dir, "t.db"));
}

function seed(db: ReturnType<typeof openDb>) {
  // `inj_out`/`inj_doubtful` reach an existing store by ALTER, not by schema.sql (see
  // ensureContextColumns). A fresh test store is an existing store from that function's point of
  // view, so it needs the same call every builder makes.
  ensureContextColumns(db);
  db.exec(`
    INSERT INTO player_identity (player_sk, name_key) VALUES (100,'a'),(300,'b'),(400,'c'),(500,'d');
    INSERT INTO player_xref (player_sk, source, source_id) VALUES (100,'pfr','PfrA'),(300,'pfr','PfrB');
    INSERT INTO raw_snap_count (season, week, game_id, player_key, pfr_player_id, offense_snaps, st_snaps, defense_snaps, fetched_at)
      VALUES (2024,5,'g1','PfrA','PfrA',40,0,0,'now'),
             (2024,5,'g1','PfrB','PfrB',0,0,0,'now');
    INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, pts, inj_out, inj_doubtful)
      VALUES ('a','100',2024,5,'A','WR',12.0,0,0),
             ('b','300',2024,5,'B','WR',0.0,0,0),
             ('c','400',2024,5,'C','RB',8.0,1,0),
             ('d','500',2024,5,'D','DST',6.0,0,0);
    INSERT INTO feat_player_week_context (player_sk, season, week, report_status_fri)
      VALUES (300,2024,5,'Doubtful');
  `);
}

test("snapPlayedIndex counts a man with snaps and NOT a man with a row of zeros", () => {
  const db = freshDb();
  seed(db);
  const idx = snapPlayedIndex(db, 2024);
  assert.ok(idx.has(gapKey(5, "100")), "40 offensive snaps must register");
  assert.ok(!idx.has(gapKey(5, "300")), "an all-zero row is not playing");
  db.close();
});

test("the snap CONTROL is a rate over scorers, and DST is excluded from it", () => {
  const db = freshDb();
  seed(db);
  const c = snapControlRate(db, 2024, snapPlayedIndex(db, 2024));
  // Scorers: A (12, has a snap row), C (8, no snap row), D (6, DST -- excluded).
  assert.equal(c.withPts, 2, "B scored 0 so he is not in the control; D is a DST so he is excluded");
  assert.equal(c.withSnap, 1);
  assert.equal(c.rate, 0.5);
  db.close();
});

test("FAULT INJECTION: break the crosswalk and the control rate must COLLAPSE", () => {
  // The control exists to catch a broken join. If it cannot fall, it cannot catch one -- and a
  // control that only ever returns a high number is indistinguishable from no control at all.
  const db = freshDb();
  seed(db);
  db.exec("UPDATE player_xref SET source_id = 'NOPE' || rowid WHERE source='pfr'");
  const c = snapControlRate(db, 2024, snapPlayedIndex(db, 2024));
  assert.equal(c.rate, 0, "with no resolvable pfr id, nothing joins and the rate must read 0");
  db.close();
});

test("fridayIndex carries BOTH columns, so a report the model column missed is still visible", () => {
  const db = freshDb();
  seed(db);
  const f = fridayIndex(db, 2024);
  assert.equal(f.get(gapKey(5, "400"))?.injOut, true);
  const b = f.get(gapKey(5, "300"));
  assert.equal(b?.injOut, false, "the model column never got it");
  assert.equal(b?.report, "Doubtful", "but the Friday report did -- this gap is the plumbing defect");
  db.close();
});
