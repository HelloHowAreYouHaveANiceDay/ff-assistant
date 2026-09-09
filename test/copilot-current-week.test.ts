/**
 * WHICH WEEK IS IT -- derived from the schedule, on the LOCAL calendar.
 *
 * `currentWeek` used to return week 1 with `source: "default"` on every call, because nothing in
 * the schema carried a kickoff date. The data track landed `raw_nfl_game`, which carries a
 * `gameday` per game for every season including the live one, so the week is now derived:
 *
 *   week w is current from the day AFTER week w-1's last kickoff through week w's last kickoff,
 *   and before week 1's first kickoff the current week is 1.
 *
 * Three things fail independently and each gets its own test:
 *   1. the rule itself, on fixed dates either side of two boundaries;
 *   2. the LOCAL-date requirement -- the fault injection below recomputes the same call from the
 *      UTC date and shows it returning the WRONG week, which is the only thing that distinguishes
 *      "we used local dates" from "the machine happened to be in Greenwich";
 *   3. the fallback -- a store with no schedule for the season must still say `default` out loud
 *      rather than inventing a week.
 *
 * The dates are literals, never `new Date()`, so this file cannot start passing or failing because
 * of when it is run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { currentWeek, localToday } from "../src/inseason/copilotStore.js";

const SEASON = 2026;

/** The real 2026 shape, trimmed to what the rule reads: each week's Thursday and its last kickoff. */
const WEEKS: [week: number, first: string, last: string][] = [
  [1, "2026-09-09", "2026-09-14"],
  [2, "2026-09-17", "2026-09-21"],
  [3, "2026-09-24", "2026-09-28"],
  [4, "2026-10-01", "2026-10-05"],
];

function tmpDb(withSchedule = true): string {
  const path = join(mkdtempSync(join(tmpdir(), "ff-week-")), "ff.db");
  const db = openDb(path);
  const cfg = JSON.parse((db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string }).value);
  cfg.season = SEASON;
  db.prepare("UPDATE settings SET value = ? WHERE key='config'").run(JSON.stringify(cfg));
  if (withSchedule) {
    const ins = db.prepare(
      `INSERT INTO raw_nfl_game (season, game_id, game_type, week, gameday, fetched_at)
         VALUES (?, ?, 'REG', ?, ?, '2026-09-01')`,
    );
    for (const [week, first, last] of WEEKS) {
      ins.run(SEASON, `${SEASON}_${week}_A`, week, first);
      ins.run(SEASON, `${SEASON}_${week}_B`, week, last);
    }
  }
  db.close();
  return path;
}

/** A local wall-clock instant. `new Date(y, m-1, d, h)` is local by construction. */
const at = (d: string, hour = 12) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day, hour);
};

test("the week is derived from the schedule, on fixed dates either side of two boundaries", () => {
  const dbPath = tmpDb();

  // The day BEFORE week 1's first kickoff: the season has not started, and the answer is week 1.
  assert.equal(currentWeek(dbPath, at("2026-09-08")).week, 1);
  // Week 1's own Thursday, and its last kickoff day -- still week 1 on both.
  assert.equal(currentWeek(dbPath, at("2026-09-09")).week, 1);
  assert.equal(currentWeek(dbPath, at("2026-09-14")).week, 1);
  // The day AFTER week 1's last kickoff: week 2.
  assert.equal(currentWeek(dbPath, at("2026-09-15")).week, 2);

  // A Thursday of week 3, and the Tuesday after week 3 finished.
  assert.equal(currentWeek(dbPath, at("2026-09-24")).week, 3);
  assert.equal(currentWeek(dbPath, at("2026-09-29")).week, 4);

  assert.match(currentWeek(dbPath, at("2026-09-24")).source, /^schedule/);
});

test("FAULT: computing the same call from the UTC date returns the WRONG week on a late evening", () => {
  const dbPath = tmpDb();

  // 9pm local on 2026-09-14 -- week 1's last kickoff day, i.e. Monday night football, exactly when
  // somebody asks for a lineup. West of Greenwich the UTC date is already 2026-09-15.
  const evening = at("2026-09-14", 21);
  assert.ok(
    evening.getTimezoneOffset() > 0,
    "this machine is at or east of UTC, so local and UTC cannot disagree here and the injection proves nothing",
  );
  assert.equal(localToday(evening), "2026-09-14");
  assert.equal(evening.toISOString().slice(0, 10), "2026-09-15", "the two dates agree -- there is no fault to inject");

  // The shipped, local-date answer.
  assert.equal(currentWeek(dbPath, evening).week, 1, "a Monday-night reader in week 1 was told a different week");

  // The broken answer, computed the way `toISOString().slice(0,10)` would: shift the instant so its
  // LOCAL date equals the UTC date the buggy code would have used, and run the same function.
  const asUtcWouldSee = at("2026-09-15", 12);
  assert.equal(
    currentWeek(dbPath, asUtcWouldSee).week, 2,
    "the UTC path did not produce a different week, so this test cannot tell the two apart",
  );
});

test("with no schedule for the season the old default is kept, and says so", () => {
  const dbPath = tmpDb(false);
  const got = currentWeek(dbPath, at("2026-09-24"));
  assert.equal(got.week, 1);
  assert.match(got.source, /^default/);
  assert.match(got.source, /raw_nfl_game/, "the fallback does not say WHY it does not know");
});

test("after the last REG week the answer stops at the last week rather than running off the end", () => {
  const dbPath = tmpDb();
  const got = currentWeek(dbPath, at("2027-02-01"));
  assert.equal(got.week, 4, "the fixture's last week is 4");
  assert.match(got.source, /last one/);
});
