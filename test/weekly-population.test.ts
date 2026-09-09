// ONE POPULATION, AND THE PROOF THAT BOTH SIDES SEE IT.
//
// The weekly two-part model failed clause (c) of its gate at RB 0.031, WR 0.039 and TE 0.074 against
// a 0.030 tolerance, and integration pass 3 measured the cause: the Python trainer fitted rows with
// `season_line_pg >= 3` while the TypeScript harness scored every non-bye rostered row. Both sides
// were internally consistent; they were answering the question about different players, and the zero
// rate between the two sets differs by 0.11 to 0.21.
//
// A test that only asserted "the harness filters by in_population" would be a tautology -- it would
// re-state the TypeScript half against itself and pass regardless of what the trainer does. So the
// tests below assert across the language boundary: they read tools/train_weekly.py's own SOURCE and
// check that the predicate it selects on is the one this store was built with, and that the old line
// cut is gone from its row selection. That is the same discipline as checking an emitted name
// against the consumer's published dictionary rather than trusting the producer's own validator.
//
// And each assertion is FAULT-INJECTED once: reintroduce the `>= 3` cut on one side and watch the
// equality fail, because a check nobody has seen fail is not a check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  buildPopulation, populationKeys, populationZeroRates, populationSource, hasRosterFeed,
  POPULATION_COLUMN, POPULATION_PREDICATE, POPULATION_DEPTH, ROSTER_DEPTH, FA_MARGIN, LEAGUE_TEAMS,
} from "../src/weekly/population.js";

/**
 * A fixture store. `n` men per position with descending season lines, six weeks, and a scoring rule
 * that makes the DEEP ones mostly zero -- which is the whole reason the population matters: the tail
 * of the board is where the zeros live, and including or excluding it moves the zero rate by more
 * than the gate's entire tolerance.
 */
function fixture(opts: { season?: number; n?: number; weeks?: number; roster?: boolean } = {}) {
  const season = opts.season ?? 2020;
  const n = opts.n ?? 120;
  const weeks = opts.weeks ?? 6;
  const dir = mkdtempSync(join(tmpdir(), "ff-pop-"));
  const db = new Database(join(dir, "t.db"));
  db.exec(`CREATE TABLE feat_player_week_model (
    feat_key TEXT, player_sk TEXT, season INTEGER, week INTEGER, pos TEXT,
    season_line_pg REAL, pts REAL, is_bye INTEGER, PRIMARY KEY (season, week, feat_key))`);
  if (opts.roster) {
    db.exec(`CREATE TABLE fact_roster_week (
      season INTEGER, week INTEGER, team_id TEXT, player_sk TEXT, pos TEXT)`);
  }
  const ins = db.prepare(
    "INSERT INTO feat_player_week_model VALUES (@k, @sk, @season, @week, @pos, @line, @pts, 0)");
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    for (let i = 0; i < n; i++) {
      // Line falls away down the board GEOMETRICALLY, the way a real positional board does, so that
      // sub-3.0 lines exist INSIDE the population as well as outside it. A linear decay put every
      // small line beyond the rank cut, which made the `>= 3` fault injection below a no-op -- the
      // injected filter removed nothing and the test could not fail. See that test's own guard.
      const line = Math.max(0.4, 20 * Math.exp(-i / 25));
      for (let w = 1; w <= weeks; w++) {
        const deep = i > 40;
        const pts = deep ? ((i + w) % 4 === 0 ? 6 : 0) : ((i + w) % 7 === 0 ? 0 : line * 1.1);
        ins.run({ k: `${pos}:${i}`, sk: `${pos}-${i}`, season, week: w, pos, line, pts });
      }
    }
  }
  return { db, season, n, weeks };
}

test("the trainer's rows and the harness's rows are the SAME rows, and the zero rate is identical by construction", () => {
  const { db, season } = fixture();
  buildPopulation(db as never, [season]);

  // THE TRAINER'S SIDE, expressed as the SQL tools/train_weekly.py builds. Not a paraphrase: the
  // next test asserts this predicate appears in that file verbatim.
  const trainerRows = db.prepare(
    `SELECT feat_key, week, pos, COALESCE(pts, 0.0) AS pts FROM feat_player_week_model
      WHERE season = ? AND COALESCE(is_bye, 0) = 0 AND season_line_pg IS NOT NULL
        AND ${POPULATION_COLUMN} = 1`,
  ).all(season) as { feat_key: string; week: number; pos: string; pts: number }[];

  // THE HARNESS'S SIDE, through the function evaluate.ts and streamingEvaluate.ts actually call.
  const harness = populationKeys(db as never, season);
  assert.ok(harness, "populationKeys returned null on a store the population WAS built for");

  assert.ok(trainerRows.length > 0, "the trainer selected nothing -- this fixture measures nothing");
  assert.equal(trainerRows.length, harness.size,
    `the trainer selected ${trainerRows.length} rows and the harness ${harness.size} -- ` +
    "two populations, which is the defect this module exists to remove");
  for (const r of trainerRows) {
    assert.ok(harness.has(`${r.feat_key}|${r.week}`),
      `${r.feat_key} week ${r.week} is in the trainer's set and not the harness's`);
  }

  // ...and therefore the zero rate, which is what gate clause (c) grades, is the same number.
  const trainerZero: Record<string, { n: number; z: number }> = {};
  for (const r of trainerRows) {
    const a = (trainerZero[r.pos] ??= { n: 0, z: 0 });
    a.n++; if (r.pts <= 0) a.z++;
  }
  const harnessZero = populationZeroRates(db as never, [season]);
  for (const [pos, a] of Object.entries(trainerZero)) {
    assert.equal(a.n, harnessZero[pos].n, `${pos}: row counts differ`);
    assert.equal(a.z / a.n, harnessZero[pos].zero,
      `${pos}: the trainer's zero rate ${(a.z / a.n).toFixed(4)} and the harness's ` +
      `${harnessZero[pos].zero.toFixed(4)} are not the same number`);
  }
});

test("FAULT INJECTION: put the old `season_line_pg >= 3` cut back on ONE side and the equality fails", () => {
  const { db, season } = fixture();
  buildPopulation(db as never, [season]);

  // The trainer's side, with the OLD filter reintroduced -- exactly the line that was deleted from
  // tools/train_weekly.py. Everything else is unchanged.
  const injected = db.prepare(
    `SELECT feat_key, week, pos, COALESCE(pts, 0.0) AS pts FROM feat_player_week_model
      WHERE season = ? AND COALESCE(is_bye, 0) = 0 AND season_line_pg >= 3.0
        AND ${POPULATION_COLUMN} = 1`,
  ).all(season) as { feat_key: string; week: number; pos: string; pts: number }[];
  const harness = populationKeys(db as never, season)!;

  assert.notEqual(injected.length, harness.size,
    "reintroducing the line cut did NOT change the trainer's row count, so this test cannot " +
    "detect the very mismatch it exists to detect -- the fixture has no rows under a 3.0 line");

  // And the zero rate moves, which is the number the gate reads. If this were equal, the equality
  // assertion above would be measuring nothing.
  const zeroOf = (rows: { pos: string; pts: number }[], pos: string) => {
    const s = rows.filter((r) => r.pos === pos);
    return s.length ? s.filter((r) => r.pts <= 0).length / s.length : NaN;
  };
  const harnessZero = populationZeroRates(db as never, [season]);
  const moved = ["QB", "RB", "WR", "TE"].filter((p) => zeroOf(injected, p) !== harnessZero[p].zero);
  assert.ok(moved.length > 0,
    "the injected filter changed the row set but not any position's zero rate -- the two sides " +
    "would report the same calibration from different populations, which is undetectable");
});

test("FAULT INJECTION: drop the population filter from the HARNESS -- the historical defect -- and the zero rates diverge", () => {
  const { db, season } = fixture();
  buildPopulation(db as never, [season]);

  // This is the defect exactly as it shipped: the trainer selects the narrower set, the harness
  // scores EVERY non-bye row with a line. Both sides are internally consistent and the gap between
  // them lands on clause (c) as if it were a model defect.
  const trained = populationZeroRates(db as never, [season]);
  const scoredAll = populationZeroRates(db as never, [season], {
    predicate: "COALESCE(is_bye, 0) = 0 AND season_line_pg IS NOT NULL",
  });
  const gaps = ["QB", "RB", "WR", "TE"].map((p) => [p, scoredAll[p].zero - trained[p].zero] as const);
  const worst = Math.max(...gaps.map(([, g]) => Math.abs(g)));
  // 0.030 is GATE_ZERO_TOL. The point of the number is that the population gap alone is bigger than
  // the entire tolerance, so no model fitted on one set can pass the clause measured on the other.
  assert.ok(worst > 0.03,
    `the widest population gap this fixture produces is ${worst.toFixed(3)}, inside the gate's 0.030 ` +
    "tolerance -- so the fixture cannot reproduce the defect and the assertion above proves nothing");
});

test("populationKeys returns NULL on an unbuilt store, so the harness refuses instead of scoring everything", () => {
  const { db, season } = fixture();
  // Column absent entirely.
  assert.equal(populationKeys(db as never, season), null,
    "a store with no in_population column must report null, not an empty set: an empty set would " +
    "score nothing and read as a small measurement");
  // Column present but NULL everywhere -- built for a different season, say.
  db.exec(`ALTER TABLE feat_player_week_model ADD COLUMN ${POPULATION_COLUMN} INTEGER`);
  assert.equal(populationKeys(db as never, season), null, "an unbuilt season must also report null");
  // The positive control: once built it returns a non-empty set. A predicate that can only ever
  // return null is dead code that reads exactly like a working guard.
  buildPopulation(db as never, [season]);
  const built = populationKeys(db as never, season);
  assert.ok(built && built.size > 0, "populationKeys never returned a population -- it cannot say yes");
});

test("the rule is the DECISION: a rostered man is in however deep he sits, and an unrostered deep man is out", () => {
  const { db, season, weeks } = fixture({ roster: true });
  // One man at rank 110 of 120 at WR -- far past POPULATION_DEPTH.WR -- ROSTERED every week.
  const ins = db.prepare("INSERT INTO fact_roster_week VALUES (?, ?, 'T1', ?, 'WR')");
  for (let w = 1; w <= weeks; w++) ins.run(season, w, "WR-110");
  assert.equal(populationSource(db as never, season), "roster_feed",
    "the fixture has a roster feed and the source must say so");
  assert.ok(hasRosterFeed(db as never, season));

  buildPopulation(db as never, [season]);
  const keys = populationKeys(db as never, season)!;

  assert.ok(keys.has(`WR:110|1`),
    "a ROSTERED man at rank 110 is out of the population -- but somebody had to decide whether to " +
    "start him, which is the whole definition");
  assert.ok(!keys.has(`WR:111|1`),
    "an UNROSTERED man at rank 111 is IN the population -- nobody claims the 111th receiver, and " +
    "including him is exactly the deep bench that sank the gate");
  // The rank cut still admits the top of the board whether or not anyone rostered him.
  assert.ok(keys.has(`WR:0|1`), "the best receiver alive is not in the population");
});

test("a bye week and a line-less row are NEVER in the population, because there is no decision to make", () => {
  const { db, season } = fixture({ n: 20 });
  db.prepare("UPDATE feat_player_week_model SET is_bye = 1 WHERE feat_key = 'RB:0' AND week = 3").run();
  db.prepare("UPDATE feat_player_week_model SET season_line_pg = NULL WHERE feat_key = 'RB:1' AND week = 4").run();
  buildPopulation(db as never, [season]);
  const keys = populationKeys(db as never, season)!;
  assert.ok(!keys.has("RB:0|3"), "a bye week is in the population -- every model knows about a bye equally");
  assert.ok(keys.has("RB:0|2"), "the same man's non-bye week fell out too, so the flag is not about the bye");
  assert.ok(!keys.has("RB:1|4"), "a row with no season line is in the population, but the target is a ratio to it");
  assert.ok(keys.has("RB:1|5"), "the same man's other weeks fell out too");
});

test("the trainer selects on the population column and NO LONGER on the line cut -- read from its source", () => {
  const py = readFileSync("tools/train_weekly.py", "utf8");
  // The producing half of the contract, asserted against the consumer's published constant rather
  // than against a second copy of the string.
  assert.ok(py.includes(`POPULATION_COLUMN = "${POPULATION_COLUMN}"`),
    `tools/train_weekly.py does not name the population column as "${POPULATION_COLUMN}"`);
  assert.ok(/AND \" \+ POPULATION_COLUMN \+ \" = 1/.test(py) || py.includes('POPULATION_COLUMN + " = 1"'),
    "tools/train_weekly.py does not select on the population column -- it would fit a wider set " +
    "than the harness scores, which is the defect this whole module removes");
  assert.ok(!py.includes('r["season_line_pg"] >= TRAIN_MIN_LINE'),
    "tools/train_weekly.py still applies the old `season_line_pg >= TRAIN_MIN_LINE` row filter. " +
    "With it, the trainer's rows are a SUBSET of the harness's and the zero rates diverge again.");

  const st = readFileSync("tools/train_streaming.py", "utf8");
  assert.ok(st.includes("tw.POPULATION_COLUMN"),
    "tools/train_streaming.py does not select on the population column, so the streaming positions " +
    "would not be comparable to the weekly ones or to the floor");
  assert.ok(!st.includes('r["season_line_pg"] >= tw.TRAIN_MIN_LINE'),
    "tools/train_streaming.py still applies the old line cut");
});

test("the cut is the depth plus the STATED margin, and nothing else", () => {
  for (const [pos, d] of Object.entries(ROSTER_DEPTH)) {
    assert.equal(POPULATION_DEPTH[pos], d + FA_MARGIN,
      `${pos}: the cut is not the depth plus the stated margin`);
  }
  assert.equal(FA_MARGIN, LEAGUE_TEAMS, "the margin is one extra man per team; it is not a free parameter");
  assert.equal(POPULATION_PREDICATE, `${POPULATION_COLUMN} = 1`);
});

// ROSTER_DEPTH IS RE-MEASURED FROM THE TABLE, NOT TRUSTED.
//
// A hand-typed depth is a snapshot of the day it was typed, and coverage by enumeration rots
// silently. So where this machine has the real store, the constants are re-derived from
// `fact_roster_week` and compared. Where it does not -- a clean clone, CI -- the test says out loud
// that it skipped rather than passing on nothing, because a conditional test that can never run is
// indistinguishable from one that always passes.
test("ROSTER_DEPTH re-measured from fact_roster_week agrees with the constant", (t) => {
  let db: InstanceType<typeof Database>;
  try {
    db = new Database("data/ff.db", { readonly: true, fileMustExist: true });
  } catch {
    t.diagnostic("SKIPPED: no data/ff.db on this machine, so the depths could not be re-measured. " +
      "The constants are unverified here and are verified wherever the store exists.");
    return;
  }
  try {
    const tbl = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_roster_week'").get();
    if (!tbl) {
      t.diagnostic("SKIPPED: this store has no fact_roster_week (Track B has not been built here).");
      return;
    }
    const teams = (db.prepare(
      "SELECT COUNT(*) * 1.0 / COUNT(DISTINCT season) AS t FROM (SELECT DISTINCT season, team_id FROM fact_roster_week)",
    ).get() as { t: number }).t;
    assert.ok(teams > 0, "the roster feed names no teams -- nothing can be measured from it");
    const rows = db.prepare(
      `SELECT pos, COUNT(*) * 1.0 / (SELECT COUNT(DISTINCT season || '|' || week) FROM fact_roster_week) AS per
         FROM fact_roster_week WHERE pos IN ('QB','RB','WR','TE','K','DST') GROUP BY pos`,
    ).all() as { pos: string; per: number }[];
    assert.equal(rows.length, 6, "the roster feed does not cover all six positions");
    for (const r of rows) {
      const scaled = Math.ceil((r.per / teams) * LEAGUE_TEAMS);
      assert.equal(ROSTER_DEPTH[r.pos], scaled,
        `${r.pos}: ROSTER_DEPTH says ${ROSTER_DEPTH[r.pos]} but the feed measures ${r.per.toFixed(2)} ` +
        `per league-week over ${teams.toFixed(2)} teams, which is ${scaled} at ${LEAGUE_TEAMS} teams. ` +
        "The constant has drifted from the league it claims to describe.");
    }
  } finally { db.close(); }
});
