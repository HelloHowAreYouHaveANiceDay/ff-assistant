/**
 * THE `odds` KIND: one playoff and one title probability per team, frozen once before kickoff and
 * scored by Brier at season end.
 *
 * It is the only prediction on the scorecard that is about the LEAGUE rather than about a player,
 * and it is the easiest one to get wrong in a way nothing notices, because a probability table is
 * plausible whatever is in it. Three properties, each of which fails on its own:
 *
 *   1. WRITE-ONCE, same as every other kind. Snapshot, hand the provider DIFFERENT probabilities,
 *      snapshot again, and assert the stored values are unchanged. A test that counted rows would
 *      pass against an implementation that overwrote all of them in place.
 *   2. NO PROVIDER, NO ROWS -- and the skip says why. The kind used to be permanently empty because
 *      `team_odds` holds a spread, not a probability; the refusal to manufacture one from the spread
 *      is deliberate and has to survive.
 *   3. POSITIVE CONTROL. A provider that returns teams writes two rows per team. Without it,
 *      "nothing was written" is the answer to every input including the honest one, and (2) would be
 *      proving nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { runScorecard, type OddsSnapshotRow } from "../src/weekly/scorecard.js";
import { seasonLineOnlyArtifact } from "../src/weekly/projector.js";
import type { ScheduleInfo } from "../src/weekly/features.js";

const SEASON = 2097;
const WEEKS = 3;

function sched(): ScheduleInfo {
  const weekAsOf = new Map<string, string>();
  for (let w = 1; w <= WEEKS; w++) weekAsOf.set(`${SEASON}|${w}`, `${SEASON}-09-${String(w * 2 + 6).padStart(2, "0")}`);
  return { weekAsOf, teamGameDay: new Map(), teamGames: new Map() };
}

function seed(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team,
        opponent, home, is_bye, season_line_pg, updated_at)
      VALUES (@k,@k,@s,@w,@a,@n,@p,'AAA','BBB',1,0,@line,'x')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 8; i++) {
      for (let w = 1; w <= WEEKS; w++) {
        ins.run({ k: `P${i}`, s: SEASON, w, a: `${SEASON}-09-${String(w * 2 + 6).padStart(2, "0")}`, n: `Player ${i}`, p: ["QB", "RB", "WR", "TE"][i % 4], line: 8 + i });
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

/** Sixteen teams, ours flagged by nothing here -- the scorecard stores every team, not just us. */
const teams = (shift = 0): OddsSnapshotRow[] =>
  Array.from({ length: 16 }, (_, i) => ({
    subject: String(i), name: `T${i}`,
    playoffPct: 43.75 + shift + i * 0.1, titlePct: 6.25 + shift + i * 0.05,
  }));

const oddsRows = (dbPath: string) => {
  const db = openDb(dbPath);
  const rows = db.prepare(
    "SELECT subject, model, name, value, as_of FROM scorecard_prediction WHERE kind='odds' ORDER BY CAST(subject AS INTEGER), model",
  ).all() as { subject: string; model: string; name: string; value: number; as_of: string }[];
  db.close();
  return rows;
};

const RUN = (dbPath: string, artifactPath: string, oddsProvider?: () => OddsSnapshotRow[]) => runScorecard({
  dbPath, season: SEASON, week: 1, today: `${SEASON}-09-07`, sched: sched(),
  artifactPath, score: false, oddsProvider,
});

test("a provider writes TWO rows per team -- playoff and title, as separate models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-odds-"));
  const { dbPath, artifactPath } = fixture(dir);

  const res = await RUN(dbPath, artifactPath, () => teams());
  assert.equal(res.oddsKind.taken, 32, "16 teams x {playoff, title} should be 32 rows");
  assert.equal(res.oddsKind.skipped, null);

  const rows = oddsRows(dbPath);
  assert.equal(rows.length, 32);
  assert.equal(new Set(rows.map((r) => r.subject)).size, 16);
  assert.deepEqual([...new Set(rows.map((r) => r.model))].sort(), ["playoff", "title"]);
  assert.equal(rows[0].as_of, `${SEASON}-09-07`, "the as_of is not the run's local date");
  // The two models are stored apart, not averaged into one number with no interpretation.
  const t0 = rows.filter((r) => r.subject === "0");
  assert.equal(t0.find((r) => r.model === "playoff")!.value, 43.75);
  assert.equal(t0.find((r) => r.model === "title")!.value, 6.25);
});

test("WRITE-ONCE: a second run with DIFFERENT probabilities does not change a stored value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-odds-once-"));
  const { dbPath, artifactPath } = fixture(dir);

  await RUN(dbPath, artifactPath, () => teams());
  const before = oddsRows(dbPath);

  // A model that now thinks something completely different. It must not be able to improve its own
  // record retroactively.
  const second = await RUN(dbPath, artifactPath, () => teams(20));
  assert.equal(second.oddsKind.taken, 0, "the second run wrote rows -- the odds kind is not write-once");
  assert.ok(second.notes.some((n) => /already snapshotted/.test(n)), JSON.stringify(second.notes));

  assert.deepEqual(oddsRows(dbPath), before, "a stored probability changed under a re-run");
});

test("FAULT: with NO provider nothing is written, and the skip says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-odds-none-"));
  const { dbPath, artifactPath } = fixture(dir);

  const res = await RUN(dbPath, artifactPath);
  assert.equal(res.oddsKind.taken, 0);
  assert.equal(oddsRows(dbPath).length, 0);
  assert.match(String(res.oddsKind.skipped), /--odds/);
  // The refusal to derive a probability from a spread is the point, and it is stated.
  assert.match(String(res.oddsKind.skipped), /team_odds/);
  assert.match(String(res.oddsKind.skipped), /our own arithmetic/);
});

test("a provider that returns NO teams is recorded as a skip, not as a snapshot of nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-odds-empty-"));
  const { dbPath, artifactPath } = fixture(dir);

  const res = await RUN(dbPath, artifactPath, () => []);
  assert.equal(res.oddsKind.taken, 0);
  assert.equal(oddsRows(dbPath).length, 0);
  assert.match(String(res.oddsKind.skipped), /no teams/);
});
