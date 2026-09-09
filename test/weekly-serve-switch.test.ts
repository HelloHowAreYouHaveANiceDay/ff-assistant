// WHAT SERVES EACH POSITION, AND WHAT HAPPENS TO THE RECORD WHEN THAT CHANGES.
//
// The gate is applied per position, so "what ships" is six decisions rather than one. That makes two
// things dangerous and both are silent:
//
//   1. A CONSUMER THAT READS ONE ARTIFACT AND SERVES IT EVERYWHERE. The scorecard's `weekly` kind
//      used to do exactly that, correctly, while one artifact served all six. The moment the table
//      has more than one entry, a one-artifact snapshot freezes the floor's number for a position
//      the lineup is served from a different model at -- and the forward record then accrues for a
//      model nobody was served from, which is the one failure a scorecard cannot survive.
//   2. A SERIES THAT CHANGES MODEL WITH NOTHING IN THE RECORD SAYING SO. A step change in the
//      numbers, no explanation in a table whose whole point is that it cannot be edited.
//
// So: the snapshot is asserted to use the TABLE, each row carries the artifact that produced it and
// the date the mapping changed, and the write-once refusal is fault-injected against a week that has
// already been snapshotted -- because a switch must reach the NEXT unplayed week and never a frozen
// one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import {
  runScorecard, ensureScorecardMetaColumn, SCORECARD_META_COLUMN, CHALLENGER_FIRST_WEEK,
} from "../src/weekly/scorecard.js";
import { seasonLineOnlyArtifact } from "../src/weekly/projector.js";
import {
  WEEKLY_SERVE, STREAM_SERVE_POS, artifactForPos, serveTable, formatServeTable,
  SHIPPED_STREAMING_POSITIONS, STREAMING_ARTIFACT, SERVE_POSITIONS_FOR,
} from "../src/weekly/streamingServe.js";
import type { ScheduleInfo } from "../src/weekly/features.js";

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
      const pos = STREAM_SERVE_POS[i % STREAM_SERVE_POS.length];
      for (let w = 1; w <= WEEKS; w++) {
        ins.run({
          k: `P${i}`, s: SEASON, w, a: `${SEASON}-09-${String(w * 2).padStart(2, "0")}`,
          n: `Player ${i}`, p: pos, t: TEAMS[i % 2], o: TEAMS[(i + 1) % 2], line: 6 + (i % 11),
        });
      }
    }
  })();
}

function artifactAt(dir: string, scale: number): string {
  const a = seasonLineOnlyArtifact({ positions: STREAM_SERVE_POS, seasons: [SEASON - 1] });
  for (const pos of Object.keys(a.coef)) a.coef[pos].mean.intercept = scale;
  const p = join(dir, `art-${scale}.json`);
  writeFileSync(p, JSON.stringify(a), "utf8");
  return p;
}

test("the serve table is ONE table: every position resolves through it and the derived list agrees", () => {
  for (const pos of STREAM_SERVE_POS) {
    assert.ok(WEEKLY_SERVE[pos], `${pos} has no entry in WEEKLY_SERVE, so it would fall through to a default`);
    assert.equal(artifactForPos(pos), WEEKLY_SERVE[pos], `${pos} does not resolve through the table`);
  }
  // The derived list and the table cannot disagree, because one is computed from the other. This
  // asserts the derivation, which is the thing that replaced a hand-kept second list.
  assert.deepEqual(
    [...SHIPPED_STREAMING_POSITIONS].sort(),
    STREAM_SERVE_POS.filter((p) => WEEKLY_SERVE[p] === STREAMING_ARTIFACT).sort(),
    "SHIPPED_STREAMING_POSITIONS does not match the positions the table maps to the streaming artifact");
  assert.deepEqual(SERVE_POSITIONS_FOR(STREAMING_ARTIFACT).sort(), [...SHIPPED_STREAMING_POSITIONS].sort());
  // ...and the printed form names every position, so a report cannot omit one silently.
  const printed = formatServeTable();
  for (const pos of STREAM_SERVE_POS) assert.ok(printed.includes(pos), `${pos} is missing from the printed table`);
});

test("the snapshot serves the `weekly` model PER POSITION and records which artifact produced each row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-serve-"));
  const dbPath = join(dir, "t.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();

  const r = await runScorecard({
    dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(), score: false,
  });
  assert.ok(r.snapshot.taken > 0, "nothing was snapshotted, so this test measured nothing");
  assert.ok(r.servedBy, "the run did not report which artifact served each position");
  assert.deepEqual(r.servedBy, serveTable(),
    "the snapshot did not serve from the table -- it used some other mapping, which is exactly the " +
    "state where the record accrues for a model nobody was served from");

  const d = openDb(dbPath);
  try {
    ensureScorecardMetaColumn(d);
    const rows = d.prepare(
      `SELECT pos, ${SCORECARD_META_COLUMN} AS meta FROM scorecard_prediction
        WHERE kind = 'weekly' AND model = 'weekly' AND season = ?`,
    ).all(SEASON) as { pos: string; meta: string | null }[];
    assert.ok(rows.length > 0, "no `weekly` model rows were written");
    for (const row of rows) {
      assert.ok(row.meta, `${row.pos} row carries no metadata, so a later reader cannot tell which model said it`);
      const m = JSON.parse(row.meta) as { artifact: string | null; switchedOn: string };
      assert.equal(m.artifact, serveTable()[row.pos],
        `${row.pos}: the row says it came from ${m.artifact} but the table says ${serveTable()[row.pos]}`);
      assert.match(m.switchedOn, /^\d{4}-\d{2}-\d{2}$/, "the switch date is not a date");
    }
    // A BASELINE MUST NOT CLAIM AN ARTIFACT. `season_line`, `shipped_week` and `trailing4` have no
    // serving artifact behind them, and stamping the serve table on their rows would assert a
    // provenance they do not have.
    const base = d.prepare(
      `SELECT model, ${SCORECARD_META_COLUMN} AS meta FROM scorecard_prediction
        WHERE kind = 'weekly' AND model <> 'weekly' AND season = ?`,
    ).all(SEASON) as { model: string; meta: string | null }[];
    assert.ok(base.length > 0, "no baseline rows at all, so this half of the assertion is vacuous");
    for (const row of base) {
      assert.equal(row.meta, null, `${row.model} carries serve-table metadata it has no claim to`);
    }
  } finally { d.close(); }
});

test("FAULT INJECTION: re-snapshotting an already-frozen week REFUSES, so a serve switch reaches only the NEXT week", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-serve-frozen-"));
  const dbPath = join(dir, "t.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();

  const opts = { dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(), score: false };
  // Freeze week 2 with one artifact...
  const first = await runScorecard({ ...opts, artifactPath: artifactAt(dir, 1.0) });
  assert.ok(first.snapshot.taken > 0, "week 2 was never frozen, so the refusal below proves nothing");

  const d1 = openDb(dbPath);
  const before = d1.prepare(
    "SELECT subject, model, value FROM scorecard_prediction WHERE kind='weekly' AND season=? ORDER BY subject, model",
  ).all(SEASON) as { subject: string; model: string; value: number }[];
  d1.close();

  // ...then try to re-snapshot the SAME week with a model that would say something very different.
  // A scale of 2.5 doubles every projection, so if a single row were rewritten the values would move
  // visibly. Counting rows alone would pass against an implementation that overwrote every one.
  const second = await runScorecard({ ...opts, artifactPath: artifactAt(dir, 2.5) });
  assert.equal(second.snapshot.taken, 0,
    `re-snapshotting week 2 wrote ${second.snapshot.taken} rows -- a frozen week was rewritten`);
  assert.ok(second.notes.some((n) => /already snapshotted/.test(n)),
    "the run did not say the week was already snapshotted, so a reader cannot tell a no-op from a write");

  const d2 = openDb(dbPath);
  const after = d2.prepare(
    "SELECT subject, model, value FROM scorecard_prediction WHERE kind='weekly' AND season=? ORDER BY subject, model",
  ).all(SEASON) as { subject: string; model: string; value: number }[];
  d2.close();
  assert.deepEqual(after, before,
    "a stored prediction changed after a second snapshot with a different model -- the write-once " +
    "property is gone, and a model improved mid-season could retroactively improve its record");

  // POSITIVE CONTROL: the refusal is about week 2 being FROZEN, not about the code being unable to
  // write at all. Week 3 is untouched, and the same call writes it.
  const next = await runScorecard({ ...opts, week: 3, today: `${SEASON}-09-05`, artifactPath: artifactAt(dir, 2.5) });
  assert.ok(next.snapshot.taken > 0,
    "week 3 was not written either, so the guard refuses everything and this test cannot tell a " +
    "write-once refusal from a broken snapshot path");
  assert.ok(CHALLENGER_FIRST_WEEK >= 1);
});
