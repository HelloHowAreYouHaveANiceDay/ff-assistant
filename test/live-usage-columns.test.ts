/**
 * THE LIVE WEEK'S USAGE COLUMNS (WP17) -- the regression the M2h serve-time ablation found.
 *
 * Seven of the twenty-five served weekly features were 100% NULL at the 2026 week-2 serve while the
 * same week of 2023, 2024 and 2025 carried 78-93%. Masking exactly that set costs +0.0647 CRPS in
 * 14 of 14 held-out seasons and -0.71 points per standard lineup EVERY week
 * (docs/weekly-missingness-ablation-2026-09-16.md). Nothing warned, because a NULL is a legal serve
 * value under D19: a dark feed and a healthy one produce the same shaped output.
 *
 * Three things are pinned here, and the third is the one the ablation showed was missing:
 *
 *   1. THE LIVE CONTEXT BUILDER CARRIES THE USAGE PAIR. It used to write `prior_snap_share` and
 *      `prior_route_share` as a literal NULL while DELETING the archive rows for the same week, so
 *      the live week -- the only week a lineup is set from -- was the one week guaranteed not to
 *      have them. Fault-injected in both directions: with the raw feed present the column must land
 *      with the value the feed published, and with the feed emptied it must read NULL and the feed
 *      must be NAMED in `missingFeeds` rather than passing quietly.
 *   2. THE REFUSAL. A builder that produces a silently empty usage column while the raw feed has
 *      rows for that week is broken, not unpublished, and must fail loudly. The guard is exercised
 *      in BOTH directions, because a guard that can only ever refuse is dead code that reads
 *      exactly like a guard that is passing.
 *   3. THE TRIPWIRE. `liveWeekCoverage` compares the live week against the SAME week in prior
 *      seasons -- the only comparison in which "100% NULL" is distinguishable from "not published
 *      yet at this point in the year". The per-season table cannot see it: a live season is mostly
 *      future weeks that legitimately carry nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { buildLiveWeekContext } from "../src/features/sources/weekContext.js";
import { contextFor, liveWeekCoverage, ensureContextColumns } from "../src/weekly/features.js";
import { assertUsageWired } from "../src/weekly/forwardBoard.js";

const SEASON = 2094;
/** Week w's first kickoff: week 1 on the 10th, week 2 on the 17th, week 3 on the 24th. */
const KICK = (w: number) => `${SEASON}-09-${String(3 + 7 * w).padStart(2, "0")}`;

const PLAYERS = [
  { sk: 201, key: "aaron-alpha", name: "Aaron Alpha", pos: "WR", team: "AAA", pfr: "AlpAa00", gsis: "00-0000201", snap: 0.91 },
  { sk: 202, key: "brett-bravo", name: "Brett Bravo", pos: "WR", team: "AAA", pfr: "BraBr00", gsis: "00-0000202", snap: 0.42 },
  { sk: 203, key: "carl-charlie", name: "Carl Charlie", pos: "RB", team: "BBB", pfr: "ChaCa00", gsis: "00-0000203", snap: 0.65 },
];

function seed(db: DB): void {
  db.transaction(() => {
    for (const p of PLAYERS) {
      db.prepare("INSERT INTO player_identity (player_sk) VALUES (?)").run(p.sk);
      db.prepare("INSERT INTO player (player_id, name, position, nfl_team) VALUES (?,?,?,?)")
        .run(p.key, p.name, p.pos, p.team);
      db.prepare(
        `INSERT INTO stg_player (player_sk, name_key, name, position, team, pfr_id, gsis_id, ambiguous, source, updated_at)
         VALUES (?,?,?,?,?,?,?,0,'test','x')`,
      ).run(p.sk, p.key, p.name, p.pos, p.team, p.pfr, p.gsis);
    }
    for (let w = 1; w <= 3; w++) {
      db.prepare(
        `INSERT INTO raw_nfl_game (game_id, season, week, game_type, home_team, away_team, gameday,
            spread_line, total_line, home_rest, away_rest, fetched_at)
         VALUES (?,?,?,'REG','AAA','BBB',?, -3.0, 45.0, 7, 7, 'x')`,
      ).run(`${SEASON}_${w}_AAA_BBB`, SEASON, w, KICK(w));
      for (const p of PLAYERS) {
        db.prepare(
          `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos,
              team, opponent, home, is_bye, season_line_pg, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,0,10.0,'x')`,
        ).run(`K${p.sk}`, String(p.sk), SEASON, w, KICK(w), p.name, p.pos, p.team,
          p.team === "AAA" ? "BBB" : "AAA");
      }
    }
    // WEEK 1 WAS PLAYED, and the snap feed published it. This is the state the live week-2 serve is
    // supposed to be able to read: one settled week, one file, a carried-forward share.
    for (const p of PLAYERS) {
      db.prepare(
        `INSERT INTO raw_snap_count (season, week, game_id, player_key, as_of, pfr_player_id,
            player, position, team, opponent, game_type, offense_snaps, offense_pct, fetched_at)
         VALUES (?,1,?,?,?,?,?,?,?,?,'REG',50,?, 'x')`,
      ).run(SEASON, `${SEASON}_1_AAA_BBB`, p.pfr, KICK(1), p.pfr, p.name, p.pos, p.team,
        p.team === "AAA" ? "BBB" : "AAA", p.snap);
    }
  })();
}

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "ff-live-usage-"));
  const dbPath = join(dir, "live.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  return dbPath;
}

test("the LIVE week carries the carried-forward snap share, read back through the feature path", () => {
  const dbPath = fresh();
  // A snapshot after week 1's kickoff and before week 2's: the live week is 2.
  const r = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-09-13` });
  assert.equal(r.skipped, null, String(r.skipped));
  assert.equal(r.week, 2);
  assert.equal(r.withSnap, PLAYERS.length, "no live row carried a prior snap share");

  // THE ASSERTION THAT MATTERS is through `contextFor`, which is what the weekly feature builder
  // calls -- a row in the table the feature path does not pick up is worth nothing.
  const db = openDb(dbPath);
  const ctx = contextFor(db, SEASON);
  db.close();
  for (const p of PLAYERS) {
    assert.equal(ctx.get(`2|${p.sk}`)!.prior_snap_share, p.snap,
      `${p.name}'s week-2 prior_snap_share is not the week-1 value the feed published`);
  }
  // And it must be the LAST PLAYED week's value, not a future one: week 1 has no prior week at all.
  assert.equal(ctx.get(`1|201`)?.prior_snap_share ?? null, null,
    "week 1 carries a prior snap share, which would mean the carry-forward reached forward");
});

test("FAULT INJECTION: with the snap feed emptied the column is NULL and the feed is NAMED", () => {
  const dbPath = fresh();
  const db = openDb(dbPath);
  db.prepare("DELETE FROM raw_snap_count WHERE season = ?").run(SEASON);
  db.close();

  const r = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-09-13` });
  assert.equal(r.week, 2);
  assert.equal(r.withSnap, 0, "a snap share appeared from a feed with no rows");
  assert.ok(r.missingFeeds.some((m) => m.includes("raw_snap_count")),
    `the dark feed was not named: ${JSON.stringify(r.missingFeeds)}`);
  // The participation feed has no rows in this fixture either, and stops publishing upstream after
  // 2025 in reality -- so it must be named too rather than reading as an ordinary empty column.
  assert.ok(r.missingFeeds.some((m) => m.includes("raw_participation")));
});

test("the usage-column refusal fires on an empty column with a live feed, and ONLY then", () => {
  const live = { what: "test", season: SEASON, feedRows: 900, feedWeeks: [1], rowsWithGames: 300 };
  // (a) THE REFUSAL. The feed has rows, the board has rows that could carry the column, nothing does.
  assert.throws(() => assertUsageWired({ ...live, rowsWithColumn: 0 }), /silently empty usage column/);
  // (b) THE POSITIVE CONTROL. The same call with the column populated must PASS -- a guard that can
  // only refuse is indistinguishable from one that is wired.
  assert.doesNotThrow(() => assertUsageWired({ ...live, rowsWithColumn: 271 }));
  // (c) AN UNPUBLISHED FEED IS NOT A BUG. Week 1 of a season, or a season the commons has not filed:
  // every column empty is the honest state and must not fail the build.
  assert.doesNotThrow(() => assertUsageWired({ ...live, feedRows: 0, feedWeeks: [], rowsWithColumn: 0 }));
  assert.doesNotThrow(() => assertUsageWired({ ...live, rowsWithGames: 0, rowsWithColumn: 0 }));
});

test("the live-week tripwire calls a dark column DARK, and a populated one OK", () => {
  const dbPath = fresh();
  const db = openDb(dbPath);
  // schema.sql is CREATE TABLE IF NOT EXISTS, so a fresh store has the table WITHOUT the
  // availability columns until the builder adds them -- the same ALTER every real build runs.
  ensureContextColumns(db);
  // Three PRIOR seasons carrying the column at week 2, and the live season carrying nothing. That
  // is the exact shape of the 2026 regression, and the per-season table cannot see it.
  db.transaction(() => {
    for (const s of [SEASON - 3, SEASON - 2, SEASON - 1]) {
      for (const p of PLAYERS) {
        db.prepare(
          `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos,
              team, opponent, home, is_bye, season_line_pg, prior_snap_share, updated_at)
           VALUES (?,?,?,2,?,?,?,?,?,1,0,10.0,0.8,'x')`,
        ).run(`K${p.sk}`, String(p.sk), s, KICK(2), p.name, p.pos, p.team, p.team === "AAA" ? "BBB" : "AAA");
      }
    }
  })();
  const dark = liveWeekCoverage(db, SEASON, 2).find((c) => c.column === "prior_snap_share")!;
  assert.equal(dark.status, "dark", `a 100% NULL column with a healthy band read ${dark.status}`);
  assert.ok(dark.bandLo > 0.9 && dark.live === 0);

  // NOW FILL IT, and the same call must report OK. Without this the test would pass just as well
  // against a function that returns "dark" for everything.
  db.prepare("UPDATE feat_player_week_model SET prior_snap_share = 0.8 WHERE season = ? AND week = 2").run(SEASON);
  const ok = liveWeekCoverage(db, SEASON, 2).find((c) => c.column === "prior_snap_share")!;
  assert.equal(ok.status, "ok");

  // A column no season carries is `none`, not a pass: silence from a feed that has never spoken is
  // not evidence that anything is healthy.
  const never = liveWeekCoverage(db, SEASON, 2).find((c) => c.column === "prior_route_share")!;
  assert.equal(never.status, "none");
  db.close();
});
