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
import { seasonLineOnlyArtifact, CHALLENGER_WEEKLY_ARTIFACT, SHIPPED_WEEKLY_ARTIFACT } from "../src/weekly/projector.js";
import {
  WEEKLY_SERVE, STREAM_SERVE_POS, artifactForPos, serveTable, formatServeTable,
  SHIPPED_STREAMING_POSITIONS, STREAMING_ARTIFACT, SERVE_POSITIONS_FOR, DST_STREAM_ARTIFACT,
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

/**
 * WRITE AN ARTIFACT AT A FIXED PATH, with its own `fittedAt` and feature count -- the shape of a
 * PROMOTION, where a different model arrives in the SAME file. That is what D27 did on 2026-09-17
 * (`weekly-artifact.json`, 25 features -> 27), and the filename is the one thing that does NOT
 * change across it. The declared feature carries no coefficient, so the projections are identical
 * either way and the test cannot pass by accident on a value difference.
 */
function artifactAtPath(path: string, opts: { fittedAt: string; extraFeature?: boolean; names?: string[] }): void {
  const a = seasonLineOnlyArtifact({ positions: STREAM_SERVE_POS, seasons: [SEASON - 1] }) as Record<string, unknown>;
  a.fittedAt = opts.fittedAt;
  if (opts.extraFeature || opts.names) {
    const names = opts.names ?? ["season_line_pg"];
    a.features = names.map((name) => ({ name, transform: "center", center: 6, scale: 1, missing: 0 }));
    // The loader requires every declared feature to carry a coefficient in every head (an undeclared
    // one is how a producer and a consumer disagree silently). ZERO everywhere, so the projections
    // are identical to the artifact this replaces and only the STAMP can differ.
    for (const heads of Object.values(a.coef as Record<string, Record<string, Record<string, number>>>)) {
      for (const h of Object.values(heads)) for (const name of names) h[name] = 0;
    }
  }
  writeFileSync(path, JSON.stringify(a), "utf8");
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

test("2026-09-14 D20: the FORM model serves QB/RB/WR/TE, the DST MATCHUP model serves DST, the FLOOR serves K, streaming ships nowhere", () => {
  // docs/decisions.md D17 shipped the form model at QB/RB/WR/TE and left K and DST on the floor
  // because on the WEEKLY feature set they tied it. D20 supersedes the DST half: fitted on the
  // point-in-time OPPONENT columns (feat_player_week_stream, absent from the weekly set), a DST
  // matchup model beats the floor materially on the blind 2021-2025 holdout -- accuracy MAE +0.126
  // (5/5) and the STREAMABLE pick +2.66 realized pts/wk (5/5), served OOS corr 0.25 vs the floor's
  // 0.04 (tools/train_dst_stream.py --gate). So DST now serves DST_STREAM_ARTIFACT. K stays on the
  // floor (its streamable pick is a NULL). The streaming artifact still serves NONE. This asserts the
  // DECISION itself, by name -- the generic "table agrees with its own derivation" check above would
  // still pass if a position were quietly left on the wrong artifact.
  const want: Record<string, string> = {
    QB: CHALLENGER_WEEKLY_ARTIFACT, RB: CHALLENGER_WEEKLY_ARTIFACT, WR: CHALLENGER_WEEKLY_ARTIFACT,
    TE: CHALLENGER_WEEKLY_ARTIFACT, K: SHIPPED_WEEKLY_ARTIFACT, DST: DST_STREAM_ARTIFACT,
  };
  for (const pos of STREAM_SERVE_POS) {
    assert.equal(WEEKLY_SERVE[pos], want[pos],
      `${pos} is served by ${WEEKLY_SERVE[pos]}, not ${want[pos]} -- the D20 per-position measurement is not in effect`);
  }
  // DST is NOT on the floor any more; K is.
  assert.equal(WEEKLY_SERVE.DST, DST_STREAM_ARTIFACT, "DST must serve the matchup model after D20");
  assert.equal(WEEKLY_SERVE.K, SHIPPED_WEEKLY_ARTIFACT, "K must stay on the floor after D20");
  assert.deepEqual([...SHIPPED_STREAMING_POSITIONS].sort(), [],
    "SHIPPED_STREAMING_POSITIONS is not empty -- the streaming artifact should ship nowhere after D11/D17/D20");
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

test("a PROMOTION INTO THE SAME FILENAME is legible in the record: the stamp carries the artifact's own identity", async () => {
  // D27/WP16b: `data/weekly-artifact.json` went from 25 features to 27 and `WEEKLY_SERVE` did not
  // move a character, because it already named that file. A stamp of the FILENAME alone reads
  // identically on both sides of that change, so a step in a write-once series would have no
  // explanation anywhere. The row must therefore carry something the new model cannot share with the
  // old one: the serving artifact's own `fittedAt` and feature count, read off the file that
  // produced the row.
  const dir = mkdtempSync(join(tmpdir(), "ff-promote-"));
  const dbPath = join(dir, "t.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  const path = join(dir, "served.json");
  const opts = { dbPath, season: SEASON, sched: sched(), score: false } as const;

  artifactAtPath(path, { fittedAt: `${SEASON}-01-01` });
  const w2 = await runScorecard({ ...opts, week: 2, today: `${SEASON}-09-04`, artifactPath: path });
  assert.ok(w2.snapshot.taken > 0, "week 2 froze nothing, so nothing below is measured");

  // THE PROMOTION: a different model, same path.
  artifactAtPath(path, { fittedAt: `${SEASON}-02-02`, extraFeature: true });
  const w3 = await runScorecard({ ...opts, week: 3, today: `${SEASON}-09-06`, artifactPath: path });
  assert.ok(w3.snapshot.taken > 0, "week 3 froze nothing after the promotion");

  const d = openDb(dbPath);
  try {
    ensureScorecardMetaColumn(d);
    const metaOf = (week: number) => {
      const rows = d.prepare(
        `SELECT DISTINCT ${SCORECARD_META_COLUMN} AS meta FROM scorecard_prediction
          WHERE kind='weekly' AND model='weekly' AND season=? AND week=? AND ${SCORECARD_META_COLUMN} IS NOT NULL`,
      ).all(SEASON, week) as { meta: string }[];
      assert.equal(rows.length, 1, `week ${week} carries ${rows.length} distinct stamps`);
      return JSON.parse(rows[0].meta) as { artifact: string | null; fittedAt: string | null; features: number | null };
    };
    const a = metaOf(2), b = metaOf(3);

    // The filename is the SAME on both sides -- which is precisely why it cannot be the identity.
    assert.equal(a.artifact, b.artifact, "the fixture did not reproduce a same-filename promotion");
    assert.equal(a.fittedAt, `${SEASON}-01-01`, "week 2's row does not carry the model that produced it");
    assert.equal(b.fittedAt, `${SEASON}-02-02`, "week 3's row does not carry the PROMOTED model");
    assert.equal(a.features, 0);
    assert.equal(b.features, 1);
    // FAULT INJECTION, in the only form that discriminates: if the stamp were the filename (and the
    // hand-bumped switch date, which is a constant in this process and so identical in both runs),
    // these two rows would be byte-identical and a reader could not tell the models apart.
    assert.notDeepEqual(a, b,
      "the two weeks' stamps are identical across a change of model -- the record cannot distinguish " +
      "the promoted artifact from the one it replaced, which is the whole failure D27 exposed");

    // AND THE FROZEN WEEK IS UNTOUCHED: the promotion reaches week 3 and never rewrites week 2.
    const w2rows = d.prepare(
      "SELECT COUNT(*) c FROM scorecard_prediction WHERE kind='weekly' AND season=? AND week=2",
    ).get(SEASON) as { c: number };
    assert.ok(w2rows.c > 0);
  } finally { d.close(); }
});

test("the scorecard SAYS SO when the served `weekly` kind has become the consensus model -- and stays silent when it has not", async () => {
  // D27/WP16b. `weekly_ecr_candidate` was frozen for weeks BEFORE the promotion as an out-of-sample
  // record of a model nobody served. After it, the two series are the SAME MODEL and will converge.
  // A reader comparing them later cannot be expected to reconstruct that from a date, so the run
  // says it at snapshot time -- and says it from the SERVED ARTIFACT'S OWN FEATURE LIST, never from a
  // version number somebody must remember to bump.
  //
  // BOTH DIRECTIONS ARE ASSERTED, because a note that can only ever be silent and a note that fires
  // unconditionally look identical in a green run. The two cases differ ONLY in which columns the
  // served artifact declares.
  const run = async (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "ff-consensus-"));
    const dbPath = join(dir, "t.db");
    const db = openDb(dbPath);
    seed(db);
    db.close();
    const servedPath = join(dir, "served.json");
    const candPath = join(dir, "cand.json");
    artifactAtPath(servedPath, { fittedAt: `${SEASON}-03-03`, names });
    artifactAtPath(candPath, { fittedAt: `${SEASON}-03-03`, names: ["ecr_wk_rank", "ecr_wk_sd"] });
    const r = await runScorecard({
      dbPath, season: SEASON, week: 2, today: `${SEASON}-09-04`, sched: sched(), score: false,
      artifactPath: servedPath, ecrCandidateArtifactPath: candPath,
    });
    assert.ok(r.ecrCandidate.taken > 0,
      `the candidate kind froze nothing (${r.ecrCandidate.skipped ?? "no reason given"}), so the note ` +
      "below is being read off a branch that never ran");
    return r.notes.some((n) => /IS the consensus model/.test(n));
  };

  // POSITIVE: the served artifact carries both consensus columns.
  assert.equal(await run(["ecr_wk_rank", "ecr_wk_sd"]), true,
    "the served artifact carries both consensus columns and the run did not say so -- the note cannot " +
    "fire at all, which reads exactly like a correct silence");
  // NEGATIVE / FAULT INJECTION: one column short is NOT the consensus model, and a note keyed on
  // anything looser (a date, the file's name, either column alone) would fire here anyway.
  assert.equal(await run(["ecr_wk_rank", "season_line_pg"]), false,
    "the run claimed the consensus model is served by an artifact carrying only one of its two columns");
});
