// THE SUNDAY RE-READ: the window rule and the write-once kind (src/weekly/scorecard.ts), M2c.
//
// Two properties carry the whole workflow, and both are REFUSALS, which is the hard thing to test:
// a refusal that never fires and a refusal that fires on everything look identical from the outside
// until you drive both sides. So every window test below asserts a PAIR -- the moment it must refuse
// and the moment it must accept -- and the write-once test asserts that the second call changes
// nothing WHILE the first changed something, because "0 rows written" is also what a broken writer
// returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { ensureContextColumns } from "../src/weekly/features.js";
import {
  resolveSundayWindow, sundayWindowsFor, freezeSundayKind, gamedayOutSubjects, etClock,
  SUNDAY_KIND, SUNDAY_MODEL, SUNDAY_LEAD_MINUTES, SCORECARD_KINDS, scorecardScope,
} from "../src/weekly/scorecard.js";

const SEASON = 2026, WEEK = 2, DAY = "2026-09-20";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ff-sunday-"));
  const db = openDb(join(dir, "t.db"));
  ensureContextColumns(db);
  // A week shaped like a real one: a Thursday game, an early Sunday wave at 13:00 ET, a late one at
  // 16:05, a Sunday night game and a Monday game. The two waves are what make two windows.
  const games: [string, string, string][] = [
    ["2026-09-17", "Thursday", "20:15"],
    [DAY, "Sunday", "13:00"], [DAY, "Sunday", "13:00"],
    [DAY, "Sunday", "16:05"], [DAY, "Sunday", "20:20"],
    ["2026-09-21", "Monday", "20:15"],
  ];
  const ins = db.prepare(
    "INSERT INTO raw_nfl_game (season, game_id, game_type, week, gameday, weekday, gametime, fetched_at) VALUES (?,?,'REG',?,?,?,?,'now')",
  );
  games.forEach((g, i) => ins.run(SEASON, `g${i}`, WEEK, g[0], g[1], g[2]));
  return db;
}

/** The frozen Friday rows the Sunday kind is a re-read OF, plus the actuals to score them against. */
function seedFrozen(db: ReturnType<typeof openDb>, formatKey: string) {
  db.exec(`
    INSERT INTO player_identity (player_sk, name_key) VALUES (100,'a'),(200,'b');
    INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, pts)
      VALUES ('a','100',${SEASON},${WEEK},'A','WR',0.0), ('b','200',${SEASON},${WEEK},'B','WR',11.0);
  `);
  const ins = db.prepare(
    `INSERT INTO scorecard_prediction (format_key, season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
     VALUES (?,?,?,'weekly','weekly',?,?,?,?,?,?,'2026-09-16','now')`,
  );
  ins.run(formatKey, SEASON, WEEK, "a", "A", "WR", 14.0, 4, 22);
  ins.run(formatKey, SEASON, WEEK, "b", "B", "WR", 9.0, 2, 17);
}

// Whatever `scorecardScope` will resolve for this store -- read back rather than retyped, because a
// hardcoded key silently stops matching the day the scoring config changes, and every freeze below
// would then refuse for the right-looking wrong reason.
const formatKeyOf = (db: ReturnType<typeof openDb>): string => scorecardScope(db).formatKey;

// ------------------------------------------------------------------------------------------------
// THE WINDOW
// ------------------------------------------------------------------------------------------------

test("a non-Sunday REFUSES, and says the day carries no Sunday game", () => {
  const db = freshDb();
  const v = resolveSundayWindow(db, SEASON, { now: "2026-09-16T11:45" });
  assert.equal(v.window, null);
  assert.match(v.refused ?? "", /not an NFL Sunday/);
  assert.equal(v.week, null);
  db.close();
});

test("a Sunday BEFORE the lead time refuses; the same Sunday inside it does NOT", () => {
  const db = freshDb();
  // The pair. A window rule that refused everything would pass the first line alone.
  const early = resolveSundayWindow(db, SEASON, { now: `${DAY}T09:00` });
  assert.equal(early.window, null, "09:00 is more than 90 minutes before the 13:00 wave");
  assert.match(early.refused ?? "", /outside every re-read window/);
  assert.match(early.refused ?? "", /early 11:30-13:00 ET/, "the refusal must name the windows it was outside of");

  const open = resolveSundayWindow(db, SEASON, { now: `${DAY}T11:45` });
  assert.equal(open.refused, null);
  assert.equal(open.window?.name, "early");
  assert.equal(open.week, WEEK);
  db.close();
});

test("the window CLOSES at kickoff -- a freeze at 13:00 is a prediction after the games", () => {
  const db = freshDb();
  assert.equal(resolveSundayWindow(db, SEASON, { now: `${DAY}T12:59` }).window?.name, "early");
  assert.equal(resolveSundayWindow(db, SEASON, { now: `${DAY}T13:00` }).window, null, "at kickoff it is too late");
  db.close();
});

test("the LATE wave is its own window, so a 16:05 man is still benchable at 15:00", () => {
  const db = freshDb();
  const { windows } = sundayWindowsFor(db, SEASON, DAY);
  assert.deepEqual(windows.map((w) => w.name), ["early", "late"]);
  assert.equal(windows[0].kickoff, "13:00");
  assert.equal(windows[0].opens, "11:30", `${SUNDAY_LEAD_MINUTES} minutes before 13:00`);
  assert.equal(windows[1].kickoff, "16:05");
  assert.equal(windows[1].opens, "14:35");
  // Between the waves there is no window: the early games have kicked off and the late lead has not
  // started. That gap is deliberate and is asserted so nobody "fixes" it into one long window.
  assert.equal(resolveSundayWindow(db, SEASON, { now: `${DAY}T13:30` }).window, null);
  assert.equal(resolveSundayWindow(db, SEASON, { now: `${DAY}T15:00` }).window?.name, "late");
  db.close();
});

test("the clock is AMERICA/NEW_YORK, not the machine's -- and not UTC", () => {
  // 2026-09-20 16:00Z is 12:00 ET, inside the early window. A UTC reading would call it 16:00 and
  // land between the waves; a machine-local reading would depend on where this runs.
  const db = freshDb();
  const c = etClock(new Date("2026-09-20T16:00:00Z"));
  assert.equal(c.day, "2026-09-20");
  assert.equal(c.hm, "12:00");
  assert.equal(resolveSundayWindow(db, SEASON, { nowDate: new Date("2026-09-20T16:00:00Z") }).window?.name, "early");
  db.close();
});

// ------------------------------------------------------------------------------------------------
// THE KIND
// ------------------------------------------------------------------------------------------------

test("`weekly_sunday` is a declared scorecard kind, so `ff scorecard` scores it", () => {
  assert.ok((SCORECARD_KINDS as readonly string[]).includes(SUNDAY_KIND));
});

test("with no frozen Friday rows the freeze REFUSES -- there is nothing to re-read against", () => {
  const db = freshDb();
  const r = freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45` });
  assert.equal(r.taken, 0);
  assert.match(r.skipped ?? "", /no frozen `weekly` rows/);
  db.close();
});

test("outside the window NOTHING is written, even with frozen rows present", () => {
  const db = freshDb();
  seedFrozen(db, formatKeyOf(db));
  const r = freezeSundayKind(db, { season: SEASON, now: `${DAY}T09:00` });
  assert.equal(r.taken, 0);
  assert.match(r.skipped ?? "", /outside every re-read window/);
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM scorecard_prediction WHERE kind = ?").get(SUNDAY_KIND) as { n: number }).n, 0,
    "a refused run must leave the table untouched",
  );
  db.close();
});

test("inside the window it freezes, and a second call in the SAME window is a no-op", () => {
  const db = freshDb();
  seedFrozen(db, formatKeyOf(db));
  const first = freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45` });
  assert.equal(first.taken, 2, "both frozen rows copied -- the positive half of the pair");
  assert.equal(first.window, "early");
  assert.equal(first.asOf, `${DAY}T11:45:00`, "as_of is the RE-READ moment, not the week's Friday anchor");

  const second = freezeSundayKind(db, { season: SEASON, now: `${DAY}T12:30` });
  assert.equal(second.taken, 0, "written once");
  assert.match(second.skipped ?? "", /already frozen/);
  const rows = db.prepare("SELECT as_of FROM scorecard_prediction WHERE kind = ? AND model = ?")
    .all(SUNDAY_KIND, SUNDAY_MODEL.early) as { as_of: string }[];
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.as_of, `${DAY}T11:45:00`, "the first as_of must survive the second call");
  db.close();
});

test("the LATE window writes a SECOND series rather than touching the first", () => {
  const db = freshDb();
  seedFrozen(db, formatKeyOf(db));
  freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45` });
  const late = freezeSundayKind(db, { season: SEASON, now: `${DAY}T15:00` });
  assert.equal(late.taken, 2);
  assert.equal(late.window, "late");
  const byModel = db.prepare("SELECT model, COUNT(*) n FROM scorecard_prediction WHERE kind = ? GROUP BY model ORDER BY model")
    .all(SUNDAY_KIND) as { model: string; n: number }[];
  assert.deepEqual(byModel, [{ model: SUNDAY_MODEL.early, n: 2 }, { model: SUNDAY_MODEL.late, n: 2 }]);
  db.close();
});

test("a game-day OUT ZEROES that man's row and leaves everyone else's value untouched", () => {
  const db = freshDb();
  const fk = formatKeyOf(db);
  seedFrozen(db, fk);
  db.prepare(
    "INSERT INTO raw_gameday_status (season, week, player_sk, name, status, fetched_at) VALUES (?,?,?,?,?,'now')",
  ).run(SEASON, WEEK, "100", "A", "Out");
  const r = freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45` });
  assert.equal(r.benched.length, 1);
  assert.equal(r.benched[0].name, "A");
  const rows = db.prepare("SELECT subject, value FROM scorecard_prediction WHERE kind = ? ORDER BY subject")
    .all(SUNDAY_KIND) as { subject: string; value: number }[];
  assert.deepEqual(rows, [{ subject: "a", value: 0 }, { subject: "b", value: 9 }],
    "A is benched to 0; B keeps the Friday value BYTE FOR BYTE -- the re-read changes availability, not the model");
  db.close();
});

test("QUESTIONABLE does NOT bench, and that is the rule the copilot uses, not a second copy of it", () => {
  const db = freshDb();
  seedFrozen(db, formatKeyOf(db));
  const ins = db.prepare(
    "INSERT INTO raw_gameday_status (season, week, player_sk, name, status, fetched_at) VALUES (?,?,?,?,?,'now')",
  );
  ins.run(SEASON, WEEK, "100", "A", "Questionable");
  ins.run(SEASON, WEEK, "200", "B", "Doubtful");
  const outs = gamedayOutSubjects(db, SEASON, WEEK);
  assert.ok(!outs.has("a"), "QUESTIONABLE stays startable -- he plays more often than not");
  assert.ok(outs.has("b"), "DOUBTFUL counts as OUT, matching OUT_STATUSES in copilot.ts");
  db.close();
});

test("FAULT INJECTION: a status the feed never sends must not bench anyone", () => {
  const db = freshDb();
  seedFrozen(db, formatKeyOf(db));
  db.prepare(
    "INSERT INTO raw_gameday_status (season, week, player_sk, name, status, fetched_at) VALUES (?,?,?,?,?,'now')",
  ).run(SEASON, WEEK, "100", "A", "Probable");
  assert.equal(gamedayOutSubjects(db, SEASON, WEEK).size, 0);
  db.close();
});

test("the freeze is scoped to a FORMAT -- another format's frozen rows are not re-read", () => {
  const db = freshDb();
  // Rows stamped with somebody else's scoring key must be invisible here, or one league's Sunday
  // read would copy another league's Friday numbers under its own name.
  seedFrozen(db, "sc-notourformat");
  const r = freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45` });
  assert.equal(r.taken, 0);
  assert.match(r.skipped ?? "", /no frozen `weekly` rows/);
  db.close();
});

test("--dry-run computes the verdict and writes nothing", () => {
  const db = freshDb();
  seedFrozen(db, formatKeyOf(db));
  const r = freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45`, dryRun: true });
  assert.equal(r.window, "early");
  assert.match(r.skipped ?? "", /--dry-run/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM scorecard_prediction WHERE kind = ?").get(SUNDAY_KIND) as { n: number }).n, 0);
  // ... and the same call WITHOUT the flag does write, so the dry-run is a flag rather than a break.
  assert.equal(freezeSundayKind(db, { season: SEASON, now: `${DAY}T11:45` }).taken, 2);
  db.close();
});
