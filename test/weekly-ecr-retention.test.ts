// THE LIVE WEEKLY-CONSENSUS RETENTION (M2b, 2026-09-16).
//
// `weekly_rank` is truncated and rewritten on every ingest, so the weekly consensus -- the one feed
// on the weekly table that is a FORECAST -- retained nothing. `appendWeeklyRankSnapshot` is the fix:
// the same rows are ALSO appended into `ranking_history` as `ecr_type = 'wp'`, keyed by the feed's
// own `scrape_date`, so `ecrWeekTable` (which already reads that table) serves the live season with
// no change of its own.
//
// Everything below is a property the broken implementation is structurally incapable of satisfying:
//
//   - a SECOND append of the same scrape writes nothing (idempotence). An append that rewrites is
//     not an archive: it would silently re-date last week's opinion as this week's, and the
//     freshness bound cannot catch that because the date would look current.
//   - a NEW scrape date is a NEW row rather than an update, so the two coexist and the point-in-time
//     reader can choose between them. That is the whole difference from `weekly_rank`.
//   - a CHANGED value under an existing key does NOT overwrite the row already held. This is the
//     inverse fault injection: `INSERT OR IGNORE` must win over the new value, or the archive is a
//     cache with a date column.
//   - the feed's own date is used, not the ingest date, and a row whose date is unusable is DROPPED
//     rather than stamped with today. Stamping a stale scrape "today" is the only error that would
//     pass the freshness bound.
//   - the appended rows are readable through `ecrWeekTable` at the honest cutoff and refused past
//     the age bound -- the round trip, because "the row was written" and "the model can see it" are
//     two different facts and only the second one serves a lineup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { appendWeeklyRankSnapshot } from "../src/data/ecrHistory.js";
import { ecrWeekTable } from "../src/weekly/features.js";
import { SCORECARD_KINDS, ECR_CANDIDATE_WEEKLY_ARTIFACT } from "../src/weekly/scorecard.js";
import { WEEKLY_SERVE } from "../src/weekly/streamingServe.js";
import type { DB } from "../src/db/db.js";

function store(): DB {
  const dir = mkdtempSync(join(tmpdir(), "ff-ecr-keep-"));
  const db = new Database(join(dir, "t.db")) as unknown as DB;
  // The archive's real key, verbatim: the whole design is that the retained rows land in the SAME
  // table under the SAME primary key, so a fixture with a looser key would prove nothing.
  db.exec(`CREATE TABLE ranking_history (
    source TEXT, ecr_type TEXT, season INTEGER, scrape_date TEXT, player_id TEXT,
    name TEXT, pos TEXT, team TEXT, ecr REAL, sd REAL, best REAL, worst REAL, fetched_at TEXT,
    PRIMARY KEY (source, ecr_type, scrape_date, player_id, pos))`);
  return db;
}

const FRIDAY = [
  { name: "Steady Back", pos: "RB", team: "KC", ecr: 3, sd: 1.5, best: 1, worst: 6, scrapeDate: "2026-09-18" },
  { name: "Fresh Wideout", pos: "WR", team: "SF", ecr: 1, sd: 0.5, best: 1, worst: 2, scrapeDate: "2026-09-18" },
  { name: "Line Backer", pos: "LB", team: "NYJ", ecr: 1, sd: 0.2, best: 1, worst: 1, scrapeDate: "2026-09-18" },
];

test("a re-ingest of the SAME scrape writes nothing, and the check can fail", () => {
  const db = store();
  const first = appendWeeklyRankSnapshot(db, FRIDAY, "2026-09-18");
  assert.equal(first.inserted, 3, "the first append must land");
  assert.equal(first.ignored, 0);
  assert.deepEqual(first.dates, ["2026-09-18"]);

  const again = appendWeeklyRankSnapshot(db, FRIDAY, "2026-09-18");
  assert.equal(again.inserted, 0, "a second append of the same scrape must write nothing");
  // The positive half: it must have SEEN the rows. `inserted: 0, ignored: 0` would also satisfy the
  // line above and would mean the append never ran at all.
  assert.equal(again.ignored, 3, "and it must report that it saw them, or this check is vacuous");
  assert.equal((db.prepare("SELECT count(*) c FROM ranking_history").get() as { c: number }).c, 3);
  db.close();
});

test("a NEW scrape date is a NEW row, and a changed value never overwrites a held one", () => {
  const db = store();
  appendWeeklyRankSnapshot(db, FRIDAY, "2026-09-18");
  // Next week's list: same men, different ranks, different date.
  const next = FRIDAY.map((r) => ({ ...r, ecr: r.ecr + 10, scrapeDate: "2026-09-25" }));
  const r2 = appendWeeklyRankSnapshot(db, next, "2026-09-25");
  assert.equal(r2.inserted, 3, "a new scrape date must add rows rather than update them");
  assert.equal((db.prepare("SELECT count(*) c FROM ranking_history").get() as { c: number }).c, 6);

  // THE INVERSE FAULT INJECTION. Re-send the ORIGINAL date carrying a different number. An UPSERT
  // would move it; the archive must not. Without this assertion an `ON CONFLICT DO UPDATE` would
  // pass every other test in this file.
  appendWeeklyRankSnapshot(db, [{ ...FRIDAY[0], ecr: 999 }], "2026-09-18");
  const held = db.prepare(
    "SELECT ecr FROM ranking_history WHERE scrape_date = '2026-09-18' AND pos = 'RB'",
  ).get() as { ecr: number };
  assert.equal(held.ecr, 3, "the held row is the record of what was published that day -- it must not move");
  db.close();
});

test("the scrape's own date is used, and an undated row is dropped rather than stamped with today", () => {
  const db = store();
  const r = appendWeeklyRankSnapshot(db, [
    { name: "Dated Man", pos: "TE", ecr: 4, scrapeDate: "2026-09-18" },
    { name: "Undated Man", pos: "TE", ecr: 5 },                          // falls back to the ingest date
    { name: "Garbled Man", pos: "TE", ecr: 6, scrapeDate: "not-a-date" }, // DROPPED, see below
    { name: "Nameless", pos: "TE", ecr: 7, scrapeDate: "2026-09-18" },
  ].map((x, i) => (i === 3 ? { ...x, name: "" } : x)), "2026-09-20");
  // TWO drops, and they are different refusals. The nameless row has no key. The GARBLED-DATE row is
  // the one that matters: it is dropped rather than fallen back to the ingest date, because a feed
  // that publishes an unparseable date is a feed whose as-of we do not know, and stamping it "today"
  // would manufacture the one fact the whole point-in-time rule rests on. Only an ABSENT date falls
  // back, where "the ingest ran today" really is the best available statement.
  assert.equal(r.badRow, 2, "the nameless row and the garbled-date row are both refused");
  assert.deepEqual(r.dates, ["2026-09-18", "2026-09-20"], "the feed's date wins; the ingest date is only a fallback");
  const dated = db.prepare("SELECT scrape_date, season FROM ranking_history WHERE name = 'Dated Man'").get() as
    { scrape_date: string; season: number };
  assert.equal(dated.scrape_date, "2026-09-18");
  assert.equal(dated.season, 2026, "season is the scrape YEAR, exactly as the archive ingest stamps it");
  db.close();
});

test("a retained scrape is readable through ecrWeekTable at the honest cutoff and refused past the age bound", () => {
  const db = store();
  appendWeeklyRankSnapshot(db, FRIDAY, "2026-09-18");
  const t = ecrWeekTable(db, 2026);
  assert.deepEqual(t.dates, ["2026-09-18"], "the live season's archive is the scrape we just retained");
  // A Sunday team: kickoff 2026-09-20, cutoff 2026-09-18. The list published that day is in.
  assert.equal(t.get("2026-09-18", "Steady Back", "RB")!.ecr, 3);
  assert.equal(t.get("2026-09-18", "Steady Back", "RB")!.sd, 1.5);
  // A THURSDAY team: kickoff 2026-09-17, cutoff 2026-09-15 -- before the list existed. NULL, because
  // that is what was knowable, rather than the Friday list quietly advanced backwards.
  assert.equal(t.get("2026-09-15", "Steady Back", "RB"), null);
  // Past the age bound it is a refusal, not a carry-forward.
  assert.equal(t.get("2026-09-30", "Steady Back", "RB"), null);
  // IDP is dropped at READ time (the archive keeps it, one filter in the reader).
  assert.equal(t.get("2026-09-18", "Line Backer", "LB"), null);
  db.close();
});

test("the ECR candidate has its own scorecard kind and is not the served artifact", () => {
  // The kind must exist, or `ff scorecard` cannot score the frozen rows and the forward record is a
  // table nobody reads.
  assert.ok((SCORECARD_KINDS as readonly string[]).includes("weekly_ecr_candidate"), "the kind must be in the scored set");
  // And it must NOT be a served artifact name. A candidate that shares a filename with something in
  // WEEKLY_SERVE would be promoted by accident the first time anything wrote to that path.
  assert.ok(!Object.values(WEEKLY_SERVE).includes(ECR_CANDIDATE_WEEKLY_ARTIFACT),
    "the candidate must serve NOTHING until the owner promotes it");
});
