/**
 * WP14 (2026-09-16), defect 4a. THE SCHEDULER'S SCORECARD ROUTINE WAS FAILING INVISIBLY.
 *
 * The in-app scheduler runs `ff inseason-tick` every 15 minutes, and its last tick read
 * `FAIL scorecard --no-forward --no-odds 0.5s -- RangeError: Missing named parameter "fk"`
 * (docs/ui-audit-2026-09-16.md 3.7). Nothing in the UI could show that, so it ran red for days.
 *
 * The cause is the shape this repo already has a name for: WP2's `format_key` migration added
 * `@fk` to every `scorecard_prediction` INSERT, and FIVE of the six `.run()` call sites were given
 * the bound parameter. The `stream` kind's was not -- two of three callers fixed, which looks done.
 *
 * THE TEST DRIVES THE REAL PATH, not a reimplementation: `runScorecard` against a temp store with
 * the real PK shape, through the same `stream` block the routine hits. It fails with the exact
 * RangeError above when `fk` is unbound, so it is structurally incapable of passing against the
 * broken code -- and it asserts the POSITIVE direction too (rows actually land, carrying the
 * format key), because a stream kind that merely stops throwing by never running would look
 * identical to a fixed one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { runScorecard } from "../src/weekly/scorecard.js";
import { seasonLineOnlyArtifact } from "../src/weekly/projector.js";
import type { ScheduleInfo } from "../src/weekly/features.js";

const SEASON = 2098;
const WEEKS = 3;

function sched(): ScheduleInfo {
  const weekAsOf = new Map<string, string>();
  for (let w = 1; w <= WEEKS; w++) weekAsOf.set(`${SEASON}|${w}`, `${SEASON}-09-${String(w * 2 + 6).padStart(2, "0")}`);
  return { weekAsOf, teamGameDay: new Map(), teamGames: new Map() };
}

/** Enough weekly feature rows that the streaming projector has a pool to pick from. */
function seed(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team,
        opponent, home, is_bye, season_line_pg, updated_at)
      VALUES (@k,@k,@s,@w,@a,@n,@p,'AAA','BBB',1,0,@line,'x')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 12; i++) {
      for (let w = 1; w <= WEEKS; w++) {
        ins.run({
          k: `P${i}`, s: SEASON, w,
          a: `${SEASON}-09-${String(w * 2 + 6).padStart(2, "0")}`,
          n: `Player ${i}`, p: ["QB", "RB", "WR", "TE"][i % 4], line: 8 + i,
        });
      }
    }
  })();
}

function fixture(dir: string): { dbPath: string; artifactPath: string } {
  const dbPath = join(dir, "sc.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  const artifactPath = join(dir, "art.json");
  writeFileSync(artifactPath, JSON.stringify(seasonLineOnlyArtifact({ positions: ["QB", "RB", "WR", "TE"], seasons: [SEASON - 1] })), "utf8");
  return { dbPath, artifactPath };
}

function streamRows(dbPath: string): { format_key: string; model: string; subject: string }[] {
  const db = openDb(dbPath);
  const rows = db.prepare(
    "SELECT format_key, model, subject FROM scorecard_prediction WHERE kind='stream' ORDER BY model, subject",
  ).all() as { format_key: string; model: string; subject: string }[];
  db.close();
  return rows;
}

test("the stream kind writes its rows instead of throwing Missing named parameter \"fk\"", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-sc-stream-"));
  const { dbPath, artifactPath } = fixture(dir);

  // `score:false`, no odds provider, no forward board -- exactly what the scheduler's
  // `scorecard --no-forward --no-odds` routine runs.
  const res = await runScorecard({
    dbPath, season: SEASON, week: 1, today: `${SEASON}-09-07`, sched: sched(),
    artifactPath, score: false,
    // The real POOL_DEPTH (QB 24 / RB 80 / ...) is deeper than any fixture, which would leave the
    // pick pool empty and the insert never reached -- i.e. a green test that proves nothing.
    poolDepth: { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DST: 1 },
  });

  // The failure mode being locked out: the RangeError escaped runScorecard entirely, so the routine
  // reported FAIL and nothing was written. If it is ever reintroduced this test throws here.
  assert.ok(res.stream.week === 1, `stream kind did not run: ${JSON.stringify(res.stream)}`);
  assert.equal(res.stream.skipped, null, `stream kind skipped: ${res.stream.skipped}`);

  // POSITIVE DIRECTION. A stream block that silently picked nobody would also not throw, and would
  // read exactly like a fixed one -- so prove rows landed AND that each carries a format key.
  assert.ok(res.stream.taken > 0, "no streaming picks were frozen -- the path ran but wrote nothing");
  const rows = streamRows(dbPath);
  assert.equal(rows.length, res.stream.taken);
  for (const r of rows) {
    assert.ok(r.format_key && r.format_key.length > 0,
      `a stream row landed with no format_key (${JSON.stringify(r)}) -- the WP2 key is what makes it per-format`);
  }
});
