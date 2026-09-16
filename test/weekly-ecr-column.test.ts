// THE WEEKLY EXPERT-CONSENSUS COLUMN'S AS-OF RULE (M2a candidate, 2026-09-16).
//
// `scripts/ecr-week-leak-guard.mjs` audits the table that actually shipped; this file audits the
// RULE, on a fixture it controls completely, so the two failure modes are separated: a builder that
// cannot leak, and a table that does not. Every assertion below is stated as a behaviour the broken
// implementation is structurally incapable of satisfying:
//
//   - a scrape dated AFTER the cutoff is never read, even by one day (the leak itself);
//   - the LATEST qualifying scrape wins, not the first or the nearest;
//   - a scrape older than ECR_WEEK_MAX_AGE_DAYS is a REFUSAL, not a carry-forward -- a bye-week gap
//     must not hand the model a three-week-old opinion wearing this week's name;
//   - a player absent from the qualifying scrape is NULL, not backfilled from an older list;
//   - the feed's kicker alias (PK) resolves to our K, and its IDP lists are dropped entirely.
//
// And the cross-language half, which no assertion about TypeScript alone can make: the two column
// names are in the published dictionary AND in tools/train_weekly.py's own source. A feature the
// trainer emits under a name the loader does not know is refused at load; a feature the loader knows
// and the trainer never selects is a column that silently reads as missing on every row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  ecrWeekTable, ecrWeekCutoff, ECR_WEEK_MAX_AGE_DAYS, WEEKLY_FEATURE_FIELDS,
  type ScheduleInfo,
} from "../src/weekly/features.js";
import type { DB } from "../src/db/db.js";

const SCRAPES: [string, string, string, number, number][] = [
  // date, name_key, pos, ecr, sd
  ["2023-10-06", "oldnews", "RB", 9, 1],
  ["2023-10-06", "steady", "RB", 5, 2],
  ["2023-10-13", "steady", "RB", 3, 1.5],
  ["2023-10-13", "fresh", "WR", 1, 0.5],
  ["2023-10-13", "kicker", "PK", 2, 1],
  ["2023-10-13", "linebacker", "LB", 1, 0.2],
  // The trap: a list published the DAY AFTER the Sunday slate. Reading it would be the leak.
  ["2023-10-16", "steady", "RB", 99, 9],
];

function fixture(): DB {
  const dir = mkdtempSync(join(tmpdir(), "ff-ecr-"));
  const db = new Database(join(dir, "t.db")) as unknown as DB;
  db.exec(`CREATE TABLE ranking_history (
    source TEXT, ecr_type TEXT, season INTEGER, scrape_date TEXT, player_id TEXT,
    name TEXT, pos TEXT, team TEXT, ecr REAL, sd REAL, best REAL, worst REAL, fetched_at TEXT)`);
  const ins = db.prepare(
    "INSERT INTO ranking_history (source, ecr_type, season, scrape_date, player_id, pos, ecr, sd)" +
    " VALUES ('fantasypros', 'wp', 2023, ?, ?, ?, ?, ?)");
  for (const [d, id, pos, ecr, sd] of SCRAPES) ins.run(d, id, pos, ecr, sd);
  // An OVERALL weekly list for the same man on the same day, at a different rank. `wp` is positional
  // and `wo` is the overall board; reading the wrong one is a silent 30x scale error, so the fixture
  // makes the two disagree and the assertions below would catch a reader that took either.
  db.prepare("INSERT INTO ranking_history (source, ecr_type, season, scrape_date, player_id, pos, ecr, sd)" +
    " VALUES ('fantasypros', 'wo', 2023, '2023-10-13', 'steady', 'RB', 42, 8)").run();
  return db;
}

test("the weekly consensus is read from the latest scrape at or before this team's Friday cutoff", () => {
  const db = fixture();
  const t = ecrWeekTable(db, 2023);
  // A Sunday team: kickoff 2023-10-15, cutoff 2023-10-13. The Friday list is in; Monday's is not.
  assert.equal(t.get("2023-10-13", "Steady", "RB")!.ecr, 3, "the Friday list must win over the week before");
  assert.equal(t.get("2023-10-13", "Steady", "RB")!.sd, 1.5);
  // FAULT INJECTION, the leak in its natural habitat: move the cutoff one day past the slate and the
  // post-game list appears. That it CAN appear is what makes the assertion above mean something.
  assert.equal(t.get("2023-10-16", "Steady", "RB")!.ecr, 99, "the leaked cutoff must reach the post-game list");
  // A Thursday team: kickoff 2023-10-12, cutoff 2023-10-10 -- the Friday list does not exist yet, so
  // it gets the PREVIOUS week's, stale and honest rather than quietly advanced.
  assert.equal(t.get("2023-10-10", "Steady", "RB")!.ecr, 5);
  db.close();
});

test("staleness is a refusal, and an unranked man is NULL rather than backfilled", () => {
  const db = fixture();
  const t = ecrWeekTable(db, 2023);
  // The last list in the fixture is 2023-10-16. Five days later it is still in bounds...
  assert.equal(t.get("2023-10-21", "Steady", "RB")!.ecr, 99, "inside the age bound the value is read");
  assert.equal(t.get("2023-10-24", "Steady", "RB")!.ecr, 99, `exactly ${ECR_WEEK_MAX_AGE_DAYS} days is the bound`);
  // ...one day past it, nothing. A carry-forward implementation answers 99 here and passes every
  // other assertion in this file, which is why this one exists.
  assert.equal(t.get("2023-10-25", "Steady", "RB"), null,
    `a scrape more than ${ECR_WEEK_MAX_AGE_DAYS} days old must not be carried forward`);
  // `oldnews` is on the 2023-10-06 list only. At a cutoff that selects the 10-13 list he is NULL --
  // not reached back for in an earlier one. That is the "no backfill from an older scrape" rule, and
  // the pair of assertions is what separates it from the age bound above.
  assert.equal(t.get("2023-10-12", "Oldnews", "RB")!.ecr, 9);
  assert.equal(t.get("2023-10-14", "Oldnews", "RB"), null);
  // `fresh` is on the 2023-10-13 list only, the mirror image in time.
  assert.equal(t.get("2023-10-10", "Fresh", "WR"), null);
  assert.equal(t.get("2023-10-13", "Fresh", "WR")!.ecr, 1);
  db.close();
});

test("the feed's position vocabulary is mapped, and its IDP lists are dropped", () => {
  const db = fixture();
  const t = ecrWeekTable(db, 2023);
  assert.equal(t.get("2023-10-13", "Kicker", "K")!.ecr, 2, "PK is the feed's spelling of our K");
  assert.equal(t.get("2023-10-13", "Linebacker", "LB"), null, "we field no IDP; an LB row must not be stored");
  // The overall (`wo`) list must not be reachable at all: it is a different quantity on a different
  // scale, and a reader that took it would produce 42 here.
  assert.notEqual(t.get("2023-10-13", "Steady", "RB")!.ecr, 42);
  db.close();
});

test("the cutoff is this team's kickoff minus two days, and a bye has none", () => {
  const sched: ScheduleInfo = {
    weekAsOf: new Map([["2023|6", "2023-10-11"]]),
    teamGameDay: new Map([["2023|KC|6", "2023-10-12"], ["2023|SF|6", "2023-10-15"]]),
    teamGames: new Map(),
  };
  assert.equal(ecrWeekCutoff(sched, 2023, "KC", 6), "2023-10-10");
  assert.equal(ecrWeekCutoff(sched, 2023, "SF", 6), "2023-10-13");
  assert.equal(ecrWeekCutoff(sched, 2023, "BUF", 6), null, "a team with no scheduled game gets no cutoff");
  assert.equal(ecrWeekCutoff(sched, 2023, null, 6), null);
});

test("both column names are in the published dictionary AND in the trainer's own source", () => {
  const src = readFileSync("tools/train_weekly.py", "utf8");
  for (const name of ["ecr_wk_rank", "ecr_wk_sd"]) {
    assert.ok((WEEKLY_FEATURE_FIELDS as readonly string[]).includes(name),
      `${name} must be in WEEKLY_FEATURE_FIELDS or src/weekly/projector.ts refuses any artifact that fits it`);
    // SELECT_COLS is what the trainer actually reads out of the store. A name declared in the
    // transform lists but absent from the SELECT reads as missing on every row and fits an intercept.
    assert.ok(new RegExp(`SELECT_COLS = \\[[\\s\\S]*?"${name}"[\\s\\S]*?\\]`).test(src),
      `${name} must be in tools/train_weekly.py SELECT_COLS`);
    assert.ok(new RegExp(`CENTER = \\[[\\s\\S]*?"${name}"[\\s\\S]*?\\]`).test(src),
      `${name} must be declared with a transform family`);
    assert.ok(new RegExp(`"ecr":\\s*\\[[^\\]]*"${name}"`).test(src),
      `${name} must sit in a MASKABLE_GROUPS group -- it is absent at serve, and a boosted head that ` +
      "never saw it absent routes a live lineup into an out-of-distribution leaf (D19, gate 7)");
  }
});
