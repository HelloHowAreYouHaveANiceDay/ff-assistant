/**
 * WHICH ARTIFACT SERVES WHICH POSITION, and the one function that turns a store into projections.
 *
 * The streaming gate is applied PER POSITION -- see `streamingGate` in streamingEvaluate.ts -- so
 * unlike every other model in this repo the answer to "what ships" is not one artifact, it is six
 * decisions. That makes exactly one thing dangerous: a consumer that reads "the streaming model" and
 * serves it everywhere, including at the positions where it FAILED its gate. So the mapping lives
 * here, in one constant, and `loadStreamingProjection` is the only path to a projection -- there is
 * no way to reach a number without the mapping having been consulted, and every result carries the
 * name of the artifact that produced it, per position.
 *
 * `WEEKLY_SERVE` IS THAT TABLE, AND IT IS A MEASUREMENT, NOT A PREFERENCE. It is set from the runs
 * recorded in docs/validation.md and must not be widened without re-running `ff evaluate-weekly` /
 * `ff evaluate-streaming` and re-recording the verdict. A position whose candidates all failed maps
 * to `SHIPPED_WEEKLY_ARTIFACT` -- the season-line floor -- which is the honest degradation: a failed
 * model falls back to something STATED rather than to something silently worse.
 *
 * `SHIPPED_STREAMING_POSITIONS` is DERIVED from the table rather than maintained beside it. It used
 * to be the primary constant, which was fine while the streaming model was the only candidate and
 * becomes a trap the moment there are two: two hand-kept lists overlap, and a position in both is
 * served by whichever list the caller happened to consult. One table cannot express that state.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { dataPath } from "../data/paths.js";
import { loadWeeklyRows } from "./features.js";
import {
  loadWeeklyArtifact, projectWeekly, SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT,
  type WeeklyArtifact,
} from "./projector.js";

/** The full-data streaming artifact, from tools/train_streaming.py. */
export const STREAMING_ARTIFACT = "streaming-artifact.json";
/** The full-data two-part weekly artifact, from tools/train_weekly.py --zero-model two-part. Named
 *  by the same constant the challenger scorecard series uses, so one file has one name. */
export const TWO_PART_ARTIFACT = CHALLENGER_WEEKLY_ARTIFACT;

/**
 * WHAT SHIPS, PER POSITION. THE SINGLE TABLE, and every consumer reads it.
 *
 * Three artifacts can serve a position and the choice is a MEASUREMENT per position, never a
 * preference. `SHIPPED_WEEKLY_ARTIFACT` is the season-line floor -- every coefficient zero, mean
 * intercept 1.0 -- and is what a position falls back to when nothing beat it. `STREAMING_ARTIFACT`
 * is the two-part model plus the twelve point-in-time opponent columns, with K and DST fitted rather
 * than intercepts. `TWO_PART_ARTIFACT` is the same two-part structure without those columns.
 *
 * The mapping below is set from the gate recorded in docs/validation.md and MUST NOT be widened
 * without re-running `ff evaluate-weekly` / `ff evaluate-streaming` and re-recording the verdict.
 * There is no other honest way to add a position.
 *
 * WHY THIS IS A TABLE AND NOT A LIST OF "POSITIONS WHERE X SHIPS": with two candidate models the
 * list form needs two lists whose overlap nobody checks, and a position in both is served by
 * whichever list is consulted first. The table cannot express that state.
 */
export const WEEKLY_SERVE: Record<string, string> = {
  QB: STREAMING_ARTIFACT,
  RB: SHIPPED_WEEKLY_ARTIFACT,
  WR: SHIPPED_WEEKLY_ARTIFACT,
  TE: SHIPPED_WEEKLY_ARTIFACT,
  K: STREAMING_ARTIFACT,
  DST: STREAMING_ARTIFACT,
};

/**
 * THE DATE THE TABLE ABOVE WAS LAST CHANGED, LOCAL. It is written into the scorecard snapshot's
 * metadata so a series that changes model mid-season says WHEN and to WHAT, rather than leaving a
 * later reader to explain a step change in the numbers.
 */
export const WEEKLY_SERVE_SWITCHED_ON = "2026-09-09";

/** Positions the given artifact file serves. Derived from the table so the two can never disagree;
 *  a hand-maintained second list is the enumeration that rots. */
export function SERVE_POSITIONS_FOR(file: string): string[] {
  return Object.entries(WEEKLY_SERVE).filter(([, f]) => f === file).map(([p]) => p);
}

/**
 * THE POSITIONS AT WHICH THE STREAMING MODEL PASSED ITS PRE-REGISTERED GATE and therefore ships.
 *
 * Measured by `ff evaluate-streaming --seasons 2012-2025 --train-seasons 2010-2025`, 14 held-out
 * seasons, 112,782 player-weeks, on 2026-09-09. QB, K and DST passed all three clauses. RB, WR and
 * TE passed (a) and (b) and FAILED (c) -- the predicted zero-week share, off by 0.031, 0.039 and
 * 0.074 against a tolerance of 0.030. Those are the SAME three positions and very nearly the same
 * three numbers the weekly two-part model failed on (docs/weekly.md section 3, W5), which is the
 * expected result: the streaming columns are about the matchup and clause (c) is about availability.
 *
 * The list is a MEASUREMENT, not a preference. Widening it means re-running the harness and
 * re-recording the verdict; there is no other honest way to add a position.
 *
 * READ THE GAIN WITH ITS SOURCE ATTACHED. At QB, K and DST the streaming model beats the shipped
 * baseline comfortably -- but the CONTROL (the same trainer with the twelve opponent columns
 * removed) is within 0.004 CRPS of it at every position. What the gate is passing on is the
 * two-part structure and the fact that K and DST are FITTED AT ALL rather than two intercepts. The
 * opponent block's own contribution measured ~0, P42 failed saying so, and docs/validation.md
 * records it as a null rather than as a gain.
 */
export const SHIPPED_STREAMING_POSITIONS: string[] = SERVE_POSITIONS_FOR(STREAMING_ARTIFACT);

/** The six positions a streaming decision can be about. */
export const STREAM_SERVE_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Which artifact FILE serves one position. Named so a report can print it beside every number. */
export function artifactForPos(pos: string): string {
  return WEEKLY_SERVE[pos] ?? SHIPPED_WEEKLY_ARTIFACT;
}

/** The serve table as a plain object, for a report or a snapshot row's metadata. A copy, so a
 *  consumer cannot mutate the decision. */
export function serveTable(): Record<string, string> {
  return Object.fromEntries(STREAM_SERVE_POS.map((p) => [p, artifactForPos(p)]));
}

/** One line per position, for `ff scorecard` and for the `assumptions` block of every result. */
export function formatServeTable(): string {
  const t = serveTable();
  return ["what serves each position (src/weekly/streamingServe.ts WEEKLY_SERVE):",
    ...STREAM_SERVE_POS.map((p) => `  ${p.padEnd(4)} ${t[p]}`),
    `  switched to this mapping on ${WEEKLY_SERVE_SWITCHED_ON}`].join("\n");
}

/** One player's weekly distribution, plus which artifact produced it. */
export interface StreamProj {
  feat_key: string;
  name: string;
  pos: string;
  team: string | null;
  mean: number;
  p10: number;
  p90: number;
  /** P(zero week). Only a two-part artifact publishes one; the floor does not, and a fabricated
   *  value here would let the floor claim a calibration it does not have. */
  pZero: number | null;
  /** Preseason line rank within the position, 1 = best. Used to approximate a free-agent pool where
   *  the real one is not known. */
  rank: number;
  artifact: string;
}

export interface StreamProjections {
  season: number;
  week: number;
  rows: StreamProj[];
  /** pos -> artifact filename. On every result, because "which model said this" is the one thing a
   *  per-position ship decision makes impossible to infer. */
  artifactByPos: Record<string, string>;
  /** Positions whose artifact could not be read at all, named rather than silently empty. */
  missing: string[];
}

const open = (dbPath?: string) => new Database(dbPath ?? dataPath("ff.db"), { readonly: true });

function tryLoad(file: string): WeeklyArtifact | null {
  try { return loadWeeklyArtifact(JSON.parse(readFileSync(dataPath(file), "utf8"))); } catch { return null; }
}

/**
 * PROJECT ONE WEEK, each position through the artifact that serves it.
 *
 * Rows are read through `loadWeeklyRows`, which joins the streaming columns -- that join is the
 * difference between serving the model that was measured and serving it on its missing-value
 * defaults, and it is asserted in test/streaming-features.test.ts because nothing else would notice.
 */
export function loadStreamingProjection(season: number, week: number, dbPath?: string): StreamProjections | null {
  const db = open(dbPath);
  try { return projectStreamingWith(db as unknown as StreamDb, season, week); } finally { db.close(); }
}

/** The narrow slice of a database handle this module needs. Taking a HANDLE rather than a path is
 *  what lets `ff scorecard` -- which already holds an open read-write handle -- reach the same
 *  projections without opening a second connection to the same file mid-transaction. */
export type StreamDb = Parameters<typeof loadWeeklyRows>[0];

export function projectStreamingWith(db: StreamDb, season: number, week: number): StreamProjections | null {
  const files = [...new Set(STREAM_SERVE_POS.map(artifactForPos))];
  const arts = new Map<string, WeeklyArtifact>();
  const missing: string[] = [];
  for (const f of files) {
    const a = tryLoad(f);
    if (a) arts.set(f, a);
  }
  const artifactByPos: Record<string, string> = {};
  for (const p of STREAM_SERVE_POS) {
    const f = artifactForPos(p);
    if (arts.has(f)) artifactByPos[p] = f;
    else missing.push(p);
  }
  if (!arts.size) return null;

  {
    const rows = loadWeeklyRows(db, season, week);
    if (!rows.length) return null;
    // The preseason-line rank, within position, for THIS season. Point-in-time by construction: the
    // line is frozen at Y-09-01, so a rank computed from it says nothing about how the season went.
    const lineOf = db.prepare(
      `SELECT feat_key, pos, MAX(season_line_pg) AS line FROM feat_player_week_model
        WHERE season = ? AND season_line_pg IS NOT NULL GROUP BY feat_key`,
    ).all(season) as { feat_key: string; pos: string; line: number }[];
    const byPos = new Map<string, { key: string; line: number }[]>();
    for (const r of lineOf) (byPos.get(r.pos) ?? byPos.set(r.pos, []).get(r.pos)!).push({ key: r.feat_key, line: r.line });
    const rank = new Map<string, number>();
    for (const list of byPos.values()) {
      list.sort((a, b) => b.line - a.line);
      list.forEach((p, i) => rank.set(p.key, i + 1));
    }
    const teamOf = new Map(rows.map((r) => [r.feat_key, r.team]));

    const out: StreamProj[] = [];
    for (const [file, art] of arts) {
      const serves = new Set(STREAM_SERVE_POS.filter((p) => artifactForPos(p) === file));
      const subset = rows.filter((r) => serves.has(r.pos));
      if (!subset.length) continue;
      for (const p of projectWeekly({ artifact: art, rows: subset })) {
        out.push({
          feat_key: p.feat_key, name: p.name, pos: p.pos, team: teamOf.get(p.feat_key) ?? null,
          mean: p.mean, p10: p.p10, p90: p.p90,
          pZero: p.pZero ?? null,
          rank: rank.get(p.feat_key) ?? 9999,
          artifact: file,
        });
      }
    }
    return { season, week, rows: out, artifactByPos, missing };
  }
}

/**
 * THE ONE PICK per position, out of the pool, for a week -- the thing the scorecard freezes.
 *
 * `poolDepth` is the rank past which a man is treated as available. The scorecard has no league
 * context (it is a record of predictions, not of a roster), so it cannot know the REAL pool; the
 * preseason-line rank is the same stand-in `streamingEvaluate.ts` uses, and it is point-in-time
 * because the line is frozen in August.
 */
export function topStreamPick(
  rows: StreamProj[], poolDepth: Record<string, number>,
): Record<string, { model: StreamProj | null; line: StreamProj | null }> {
  const out: Record<string, { model: StreamProj | null; line: StreamProj | null }> = {};
  for (const pos of STREAM_SERVE_POS) {
    const depth = poolDepth[pos] ?? 0;
    const pool = rows.filter((r) => r.pos === pos && r.rank > depth);
    if (!pool.length) continue;
    // Two picks, frozen side by side: OURS (the serving model's) and the one a manager makes by
    // reading the preseason board. A frozen pick with nothing to be regret AGAINST is a number with
    // no referent, and adding the comparison later would be adding it after the games.
    const best = (f: (r: StreamProj) => number) =>
      pool.reduce((a, b) => (a == null || f(b) > f(a) ? b : a), null as StreamProj | null);
    out[pos] = { model: best((r) => r.mean), line: best((r) => -r.rank) };
  }
  return out;
}
