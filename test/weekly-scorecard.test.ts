// THE ONE PROPERTY THE SCORECARD HAS TO HAVE: a prediction is written once, before kickoff, and
// never updated. Everything else in it is arithmetic that a backtest could also do.
//
// Both halves are fault-injected, because both fail SILENTLY. A prediction snapshotted after the
// games looks identical to an honest one in the table -- same columns, same as_of, nothing to
// notice -- and a prediction quietly overwritten by a better model looks like a model that was
// always right. So:
//
//   1. LATE SNAPSHOT. Run with `today` past the week's as-of and assert that ZERO rows are written
//      and the refusal says why. POSITIVE CONTROL: the same call with `today` on the as-of writes
//      rows -- otherwise "nothing was written" would be the answer to every input, including the
//      honest one, and the guard would be a function that always refuses.
//   2. WRITE-ONCE. Snapshot, change the model so it would predict something different, snapshot
//      again, and assert the stored VALUES are byte-identical. A test that only counted rows would
//      pass against an implementation that overwrote every one of them in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { runScorecard, imminentWeek } from "../src/weekly/scorecard.js";
import { seasonLineOnlyArtifact } from "../src/weekly/projector.js";
import type { ScheduleInfo } from "../src/weekly/features.js";

const SEASON = 2098;
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
    for (let i = 0; i < 30; i++) {
      const pos = ["QB", "RB", "WR", "TE"][i % 4];
      for (let w = 1; w <= WEEKS; w++) {
        ins.run({
          k: `P${i}`, s: SEASON, w, a: `${SEASON}-09-${String(w * 2).padStart(2, "0")}`,
          n: `Player ${i}`, p: pos, t: TEAMS[i % 2], o: TEAMS[(i + 1) % 2],
          line: 6 + (i % 11),
        });
      }
    }
  })();
}

/** A minimal, valid weekly artifact on disk, so the scorecard has something to serve with. */
function artifactAt(dir: string, scale: number): string {
  const a = seasonLineOnlyArtifact({ positions: ["QB", "RB", "WR", "TE"], seasons: [SEASON - 1] });
  for (const pos of Object.keys(a.coef)) a.coef[pos].mean.intercept = scale;
  const p = join(dir, `art-${scale}.json`);
  writeFileSync(p, JSON.stringify(a), "utf8");
  return p;
}

function stored(db: DB): { subject: string; model: string; value: number }[] {
  return db.prepare(
    "SELECT subject, model, value FROM scorecard_prediction WHERE kind='weekly' ORDER BY subject, model",
  ).all() as { subject: string; model: string; value: number }[];
}

test("POSITIVE CONTROL ON THE SCORER: a settled week is scored, and a better model scores better", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-scorecard-score-"));
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  // Settle week 2 with actuals that are NOT the season line, so the models genuinely differ.
  db.prepare("UPDATE feat_player_week_model SET pts = season_line_pg * 1.6 WHERE season = ? AND week = 2")
    .run(SEASON);
  db.close();
  try {
    // Snapshot on time...
    const snap = await runScorecard({
      dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(),
      artifactPath: artifactAt(dir, 1.6), score: false,
    });
    assert.ok(snap.snapshot.taken > 0);
    // ...then score it after the fact. Scoring after the games is the CORRECT order; only the
    // prediction has to be frozen first.
    const scored = await runScorecard({
      dbPath, season: SEASON, today: `${SEASON}-09-09`, sched: sched(),
      artifactPath: artifactAt(dir, 1.6), snapshot: false,
    });
    const rows = scored.scored.filter((r) => r.week === 2);
    assert.ok(rows.length > 0,
      "a settled, snapshotted week produced no scored rows -- the scorer is not connected, and an " +
      "empty scorecard looks exactly like a season nobody has played yet");
    const weekly = rows.find((r) => r.model === "weekly");
    const line = rows.find((r) => r.model === "season_line");
    assert.ok(weekly && line);
    // The artifact multiplies the line by exactly 1.6 and the actuals ARE the line times 1.6, so the
    // weekly model is exact and the plain season line is not. Any scorer that cannot see that gap is
    // reading the wrong column.
    assert.ok(weekly!.rmse < 1e-9,
      `a model that predicts the actual exactly scored RMSE ${weekly!.rmse} -- the scorer is comparing ` +
      "the wrong two numbers");
    assert.ok(line!.rmse > 1,
      `the plain season line scored RMSE ${line!.rmse} against actuals 1.6x its size -- the scorer ` +
      "cannot distinguish a wrong model from a right one");
    // And it must persist, because a scorecard nobody can read back is a print statement.
    const d = openDb(dbPath);
    const persisted = d.prepare(
      "SELECT COUNT(*) c FROM scorecard_result WHERE season = ? AND week = 2 AND metric = 'rmse'",
    ).get(SEASON) as { c: number };
    d.close();
    assert.ok(persisted.c >= 2, "scored metrics were not written to scorecard_result");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("imminentWeek is the earliest week whose first kickoff is still ahead", () => {
  const s = sched();
  assert.equal(imminentWeek(s, SEASON, `${SEASON}-09-01`), 1);
  assert.equal(imminentWeek(s, SEASON, `${SEASON}-09-02`), 1, "the as-of day itself is still before kickoff");
  assert.equal(imminentWeek(s, SEASON, `${SEASON}-09-03`), 2);
  assert.equal(imminentWeek(s, SEASON, `${SEASON}-12-01`), null);
});

test("FAULT INJECTION: a snapshot taken after kickoff writes NOTHING, and one taken before writes rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-scorecard-"));
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  const art = artifactAt(dir, 1.0);
  try {
    const late = await runScorecard({
      dbPath, season: SEASON, week: 2, today: `${SEASON}-09-05`, sched: sched(),
      artifactPath: art, score: false,
    });
    assert.equal(late.snapshot.taken, 0, "rows were written for a week that had already kicked off");
    assert.match(String(late.snapshot.skipped), /refusing to write a 'prediction' after the games/,
      "the refusal did not say why, so a reader cannot tell it from an empty week");
    const d1 = openDb(dbPath);
    assert.equal(stored(d1).length, 0, "the table is not empty after a refused snapshot");
    d1.close();

    // POSITIVE CONTROL: the same call, one week's as-of ahead. Without this, "wrote nothing" is the
    // answer to every input and the refusal proves nothing.
    const ok = await runScorecard({
      dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(),
      artifactPath: art, score: false,
    });
    assert.ok(ok.snapshot.taken > 0,
      "an on-time snapshot wrote nothing either -- the guard refuses everything and measures nothing");
    assert.equal(ok.snapshot.skipped, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FAULT INJECTION: a second snapshot with a DIFFERENT model cannot change a frozen prediction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-scorecard-wo-"));
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  try {
    const first = await runScorecard({
      dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(),
      artifactPath: artifactAt(dir, 1.0), score: false,
    });
    assert.ok(first.snapshot.taken > 0);
    const d1 = openDb(dbPath); const before = stored(d1); d1.close();

    // The model is now twice as bullish. If predictions were updatable, every `weekly` value would
    // double and the season's record would silently become the new model's record.
    const second = await runScorecard({
      dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(),
      artifactPath: artifactAt(dir, 2.0), score: false,
    });
    assert.equal(second.snapshot.taken, 0, "a re-run wrote new rows -- the snapshot is not idempotent");
    const d2 = openDb(dbPath); const after = stored(d2); d2.close();
    assert.deepEqual(after, before,
      "a frozen prediction changed when the model changed. A record that can be improved after the " +
      "fact is not a record.");

    // POSITIVE CONTROL ON THE PERTURBATION: the second artifact really does predict differently, so
    // "nothing changed" is a statement about the store rather than about two identical models.
    const w = before.filter((r) => r.model === "weekly");
    assert.ok(w.length > 0, "no weekly predictions were stored, so the comparison is vacuous");
    const third = await runScorecard({
      dbPath, season: SEASON, week: 3, today: `${SEASON}-09-05`, sched: sched(),
      artifactPath: artifactAt(dir, 2.0), score: false,
    });
    assert.ok(third.snapshot.taken > 0, "week 3 could not be snapshotted, so the control is vacuous");
    const d3 = openDb(dbPath);
    const wk3 = d3.prepare("SELECT subject, value FROM scorecard_prediction WHERE week=3 AND model='weekly' ORDER BY subject").all() as { subject: string; value: number }[];
    const wk2 = new Map(w.map((r) => [r.subject, r.value]));
    d3.close();
    assert.ok(wk3.some((r) => wk2.has(r.subject) && Math.abs(r.value - wk2.get(r.subject)! * 2) < 1e-9),
      "the doubled artifact did not produce doubled predictions anywhere -- the perturbation is not " +
      "connected, so the write-once assertion above was comparing a model to itself");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
