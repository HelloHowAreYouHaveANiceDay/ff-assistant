// THE RAW FEEDS, asserted against arithmetic rather than against themselves.
//
// A raw ingester is the easiest thing in this repo to have silently broken: every fetch is wrapped
// so a missing season does not abort a sweep, which makes a mistyped URL and a season that does not
// exist produce the same clean exit and the same empty table. So these tests do two things a
// re-fetch cannot: they check counts against a number derived from the SPORT (32 teams x 17 games
// / 2 = 272 regular-season games), and they check that the columns the feed exists FOR are actually
// populated, per season, rather than present and null.
//
// They run against the local store when it has been built, and skip with a message otherwise. A
// skipped test that claims to have passed is worse than no test, which is why the guard is on
// `HAVE` and not on a try/catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const DB = "data/ff.db";
const HAVE = existsSync(DB);
const open = () => new Database(DB, { readonly: true });

function tableHasRows(t: string): boolean {
  if (!HAVE) return false;
  const db = open();
  try {
    const r = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
    return r.c > 0;
  } catch { return false; } finally { db.close(); }
}

// ==================================================================================================
// raw_nfl_game
// ==================================================================================================

test("raw_nfl_game: regular-season counts equal 32 teams x 17 games / 2, and 31 x 16 / 2 before 2002", { skip: !tableHasRows("raw_nfl_game") ? "raw_nfl_game not built" : false }, () => {
  const db = open();
  const rows = db.prepare(
    "SELECT season, SUM(game_type='REG') reg, COUNT(*) n FROM raw_nfl_game GROUP BY season ORDER BY season",
  ).all() as { season: number; reg: number; n: number }[];
  db.close();
  const byYear = new Map(rows.map((r) => [r.season, r]));

  // Hand-checked, from the league's own structure rather than from the file:
  //   1999-2001: 31 teams (Houston joined in 2002), 16 games -> 31*16/2 = 248
  //   2002-2020: 32 teams, 16 games                        -> 32*16/2 = 256
  //   2021-:     32 teams, 17 games                        -> 32*17/2 = 272
  const expect: [number, number][] = [[1999, 248], [2001, 248], [2002, 256], [2015, 256], [2020, 256], [2021, 272], [2023, 272], [2025, 272]];
  for (const [yr, reg] of expect) {
    const r = byYear.get(yr);
    assert.ok(r, `season ${yr} missing from raw_nfl_game`);
    assert.equal(r!.reg, reg, `${yr} regular-season games`);
  }
  // 2023 in full: 272 regular season + 6 wild card + 4 divisional + 2 conference + 1 Super Bowl.
  assert.equal(byYear.get(2023)!.n, 285, "2023 total games including the playoffs");
});

test("raw_nfl_game: the columns this table exists for are POPULATED, not merely present", { skip: !tableHasRows("raw_nfl_game") ? "raw_nfl_game not built" : false }, () => {
  const db = open();
  // Completed seasons only. The live season legitimately has no closing line for games not yet
  // played and no observed temperature at all, and asserting on it would make the test fail every
  // September for a correct reason.
  const rows = db.prepare(
    `SELECT season, COUNT(*) n, SUM(spread_line IS NOT NULL) sp, SUM(total_line IS NOT NULL) tl,
            SUM(roof IS NOT NULL) rf, SUM(home_rest IS NOT NULL) rs, SUM(surface IS NOT NULL) sf
     FROM raw_nfl_game WHERE season BETWEEN 1999 AND 2025 GROUP BY season ORDER BY season`,
  ).all() as { season: number; n: number; sp: number; tl: number; rf: number; rs: number; sf: number }[];
  db.close();
  assert.ok(rows.length >= 27, `expected 27 completed seasons, got ${rows.length}`);
  for (const r of rows) {
    // A Vegas line for every completed game, every season back to 1999. This is the column the
    // whole table is worth having for, and "the feed has it from 1999" is a claim worth a guard.
    assert.equal(r.sp, r.n, `${r.season}: spread_line missing on ${r.n - r.sp} games`);
    assert.equal(r.tl, r.n, `${r.season}: total_line missing on ${r.n - r.tl} games`);
    assert.equal(r.rf, r.n, `${r.season}: roof missing on ${r.n - r.rf} games`);
    // `surface` is NOT complete, and the test says so with the measured number rather than being
    // relaxed to nothing. Measured 2026-09-08: complete 1999-2021, then 278/284 in 2022, 250/285 in
    // 2023 (87.7%, the worst), 283/285 in 2024, 284/285 in 2025. The guard is set below that worst
    // case, so it still catches the failure that matters -- a season silently losing the column
    // entirely, which is what a renamed source field would look like.
    assert.ok(r.sf / r.n >= 0.85, `${r.season}: surface on only ${r.sf}/${r.n} games`);
    assert.equal(r.rs, r.n, `${r.season}: home_rest missing on ${r.n - r.rs} games`);
  }
});

test("raw_nfl_game: as_of is the gameday, never the fetch date", { skip: !tableHasRows("raw_nfl_game") ? "raw_nfl_game not built" : false }, () => {
  const db = open();
  const bad = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_game WHERE gameday IS NOT NULL AND (as_of IS NULL OR as_of != gameday)",
  ).get() as { c: number };
  // The point-in-time invariant, stated as a query: a 1999 row must be stamped 1999, and the one way
  // it silently would not be is if `as_of` had been filled from nowIso() like `fetched_at`.
  const late = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_game WHERE as_of IS NOT NULL AND CAST(substr(as_of,1,4) AS INTEGER) < season",
  ).get() as { c: number };
  const fetchDated = db.prepare(
    "SELECT COUNT(*) c FROM raw_nfl_game WHERE season < 2020 AND substr(as_of,1,4) = substr(fetched_at,1,4)",
  ).get() as { c: number };
  db.close();
  assert.equal(bad.c, 0, "as_of must equal gameday wherever the feed publishes one");
  assert.equal(late.c, 0, "as_of must not predate its own season");
  assert.equal(fetchDated.c, 0, "a pre-2020 row stamped with this year is as_of taken from the fetch clock");
});
