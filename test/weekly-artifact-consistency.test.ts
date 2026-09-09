/**
 * ONE SHIPPED WEEKLY ARTIFACT, AND A CHALLENGER THAT IS ALLOWED TO BE DIFFERENT.
 *
 * Until the final integration `lineupRecommend` loaded `weekly-artifact-lineonly.json` and
 * `ff scorecard`'s `weekly` kind loaded `weekly-artifact.json`, each filename typed inline in its own
 * file. Nothing failed: both files load through the same loader, both validate, both produce
 * plausible per-player numbers. The season's forward record was simply accruing for a model nobody
 * was served from -- the one failure a scorecard cannot survive, because its whole claim is that it
 * measures the thing a decision was made on.
 *
 * Two properties, and the second is what makes the first mean anything:
 *
 *   1. THE SHIPPED PATH AGREES. The lineup surface and the scorecard's `weekly` kind produce the
 *      SAME projection for the same player, week and rows.
 *   2. THE CHALLENGER DISAGREES. `weekly_challenger` carries the two-part model's number and it is
 *      NOT the shipped one. Without this, (1) would also pass an implementation that read one file
 *      for everything -- which is the bug wearing the fix's costume.
 *
 * Plus the point-in-time rule the split inherits: the challenger series starts at week 2, because
 * 2026 week 1 was frozen before the split existed and a row written for it now would be a prediction
 * made after kickoff.
 *
 * And a source-level guard: the two artifact filenames must appear in `src/` in exactly one place --
 * the constants they are declared as. A consumer that types the filename again is how the two
 * surfaces drifted in the first place, and it is invisible at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { runScorecard, CHALLENGER_FIRST_WEEK } from "../src/weekly/scorecard.js";
import {
  seasonLineOnlyArtifact, loadWeeklyArtifact, projectWeekly,
  SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT,
} from "../src/weekly/projector.js";
import { loadWeeklyRows, type ScheduleInfo } from "../src/weekly/features.js";

const SEASON = 2097;
const WEEKS = 4;
const TEAMS = ["AAA", "BBB"];

function sched(): ScheduleInfo {
  const weekAsOf = new Map<string, string>();
  const teamGameDay = new Map<string, string>();
  const teamGames = new Map<string, number>();
  for (let w = 1; w <= WEEKS; w++) {
    weekAsOf.set(`${SEASON}|${w}`, `${SEASON}-09-${String(w * 2).padStart(2, "0")}`);
    for (const t of TEAMS) {
      teamGameDay.set(`${SEASON}|${t}|${w}`, `${SEASON}-09-${String(w * 2 + 1).padStart(2, "0")}`);
      teamGames.set(`${SEASON}|${t}`, w);
    }
  }
  return { weekAsOf, teamGameDay, teamGames };
}

function seed(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team,
        opponent, home, is_bye, season_line_pg, td_games, td_ppg, t4_mean, dvp_mult, pts, updated_at)
      VALUES (@k,@k,@s,@w,@a,@n,@p,@t,@o,1,0,@line,0,NULL,NULL,1.0,NULL,'x')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 24; i++) {
      const pos = ["QB", "RB", "WR", "TE"][i % 4];
      for (let w = 1; w <= WEEKS; w++) {
        ins.run({
          k: `P${i}`, s: SEASON, w, a: `${SEASON}-09-${String(w * 2).padStart(2, "0")}`,
          n: `Player ${i}`, p: pos, t: TEAMS[i % 2], o: TEAMS[(i + 1) % 2], line: 6 + (i % 11),
        });
      }
    }
  })();
}

/** A valid artifact whose mean intercept is `scale`, so two of them cannot agree. */
function artifactAt(dir: string, scale: number): string {
  const a = seasonLineOnlyArtifact({ positions: ["QB", "RB", "WR", "TE"], seasons: [SEASON - 1] });
  for (const pos of Object.keys(a.coef)) a.coef[pos].mean.intercept = scale;
  const p = join(dir, `art-${String(scale).replace(".", "_")}.json`);
  writeFileSync(p, JSON.stringify(a), "utf8");
  return p;
}

test("the shipped kind and the challenger kind carry DIFFERENT artifacts, each its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-artifact-consistency-"));
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();

  const shipped = artifactAt(dir, 1.0);      // the floor: projection IS the season line
  const challengerPath = artifactAt(dir, 1.5); // a model that says something else

  const week = CHALLENGER_FIRST_WEEK;
  const r = await runScorecard({
    dbPath, season: SEASON, week, today: `${SEASON}-09-${String(week * 2).padStart(2, "0")}`,
    sched: sched(), artifactPath: shipped, challengerArtifactPath: challengerPath,
    snapshot: true, score: false, espn: false, rosters: 20,
  });
  assert.equal(r.challenger.skipped, null, "the challenger was skipped: " + r.challenger.skipped);
  assert.ok(r.snapshot.taken > 0, "no shipped rows were written at all");
  assert.ok(r.challenger.taken > 0, "no challenger rows were written at all");

  // What the two artifacts SAY, computed independently of the scorecard.
  const db2 = openDb(dbPath);
  const rows = loadWeeklyRows(db2, SEASON, week).filter((x) => x.season_line_pg != null);
  const wantShipped = new Map(projectWeekly({
    artifact: loadWeeklyArtifact(JSON.parse(readFileSync(shipped, "utf8"))), rows,
  }).map((p) => [p.feat_key, p.mean]));
  const wantChal = new Map(projectWeekly({
    artifact: loadWeeklyArtifact(JSON.parse(readFileSync(challengerPath, "utf8"))), rows,
  }).map((p) => [p.feat_key, p.mean]));

  const got = (kind: string, model: string) => new Map((db2.prepare(
    "SELECT subject, value FROM scorecard_prediction WHERE season=? AND week=? AND kind=? AND model=?",
  ).all(SEASON, week, kind, model) as { subject: string; value: number }[]).map((x) => [x.subject, x.value]));
  const gotShipped = got("weekly", "weekly");
  const gotChal = got("weekly_challenger", "two_part");
  db2.close();

  assert.ok(gotShipped.size > 0 && gotChal.size > 0, "one of the two kinds stored nothing");
  for (const [k, v] of gotShipped) {
    assert.ok(Math.abs(v - wantShipped.get(k)!) < 1e-9,
      `the weekly kind's stored value for ${k} is not what the SHIPPED artifact projects`);
  }
  for (const [k, v] of gotChal) {
    assert.ok(Math.abs(v - wantChal.get(k)!) < 1e-9,
      `the challenger kind's stored value for ${k} is not what the CHALLENGER artifact projects`);
  }
  // FAULT INJECTION, in the only form that discriminates: if the scorecard read ONE file for both
  // kinds, every assertion above would still pass on the file it happened to read. The two must
  // actually differ.
  let differing = 0;
  for (const [k, v] of gotShipped) if (gotChal.has(k) && Math.abs(v - gotChal.get(k)!) > 1e-9) differing++;
  assert.ok(differing > 0,
    "every challenger value equals the shipped one -- the two kinds are being served from the same " +
    "artifact, which is exactly the defect this file exists to catch");
});

test("the challenger series starts at week 2, and week 1 is refused with the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-artifact-w1-"));
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  const r = await runScorecard({
    dbPath, season: SEASON, week: 1, today: `${SEASON}-09-02`, sched: sched(),
    artifactPath: artifactAt(dir, 1.0), challengerArtifactPath: artifactAt(dir, 1.5),
    snapshot: true, score: false, espn: false, rosters: 20,
  });
  // The SHIPPED kind is written -- week 1 is a legitimate prediction, it is only the challenger
  // series that cannot start there.
  assert.ok(r.snapshot.taken > 0, "week 1's shipped snapshot was refused, which is not the rule");
  assert.equal(r.challenger.taken, 0, "a week-1 challenger row was written");
  assert.match(String(r.challenger.skipped), /week 2/,
    "the refusal does not say where the series starts: " + r.challenger.skipped);
});

test("a MISSING challenger artifact is a skip that says so -- never a silent fall back to the shipped one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-artifact-missing-"));
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  const week = CHALLENGER_FIRST_WEEK;
  const r = await runScorecard({
    dbPath, season: SEASON, week, today: `${SEASON}-09-${String(week * 2).padStart(2, "0")}`,
    sched: sched(), artifactPath: artifactAt(dir, 1.0),
    challengerArtifactPath: join(dir, "no-such-artifact.json"),
    snapshot: true, score: false, espn: false, rosters: 20,
  });
  assert.equal(r.challenger.taken, 0);
  assert.match(String(r.challenger.skipped), /challenger artifact/i);
  const db2 = openDb(dbPath);
  const n = (db2.prepare(
    "SELECT count(*) c FROM scorecard_prediction WHERE kind='weekly_challenger'",
  ).get() as { c: number }).c;
  db2.close();
  assert.equal(n, 0, "challenger rows exist despite there being no challenger artifact to make them from");
});

/** Every src/*.ts file that writes `name` out as a literal string. */
function filesNaming(name: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      if (readFileSync(p, "utf8").includes(name)) hits.push(p.replace(/\\/g, "/"));
    }
  };
  walk("src");
  return hits.sort();
}

test("no file but projector.ts writes a weekly artifact FILENAME -- everyone else imports the constant", () => {
  for (const name of [SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT]) {
    assert.deepEqual(filesNaming(name), ["src/weekly/projector.ts"],
      `"${name}" is written literally outside src/weekly/projector.ts. A second place to type the ` +
      "filename is exactly how the lineup surface and the scorecard came to serve different models " +
      "without anything failing; import the constant instead.");
  }
  // FAULT INJECTION: the scan must be able to FIND a stray literal, or its clean verdict above is
  // the answer it gives to every input. A name that IS written outside projector.ts must come back
  // with more than the one allowed file.
  const decoy = "scorecard_prediction";
  const found = filesNaming(decoy);
  assert.ok(found.length > 1 && !found.every((f) => f.endsWith("projector.ts")),
    `the scan found ${decoy} in ${found.length} file(s) -- it cannot detect a literal outside ` +
    "projector.ts, so it cannot detect the drift it exists to detect");
});
