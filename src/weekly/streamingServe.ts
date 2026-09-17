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
import { resolveFormat, INCUMBENT_MODEL, type ModelHandle, type ArtifactName } from "../data/formatResolve.js";
import { resolveLeagueContext } from "../data/leagueContext.js";
import { loadWeeklyRows } from "./features.js";
import {
  loadWeeklyArtifact, projectWeekly, SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT,
  type WeeklyArtifact,
} from "./projector.js";

/** The full-data streaming artifact, from tools/train_streaming.py. */
export const STREAMING_ARTIFACT = "streaming-artifact.json";

/**
 * THE DST MATCHUP MODEL, from tools/train_dst_stream.py (docs/decisions.md D20).
 *
 * A WeeklyArtifact like any other -- schema 2, linear, ratio_to_season_line -- carrying a mean head
 * and three quantile heads for DST only, fitted on the twelve `feat_player_week_stream` matchup
 * columns (opponent implied total dominant). It serves through `projectWeekly` unchanged, so nothing
 * new runs at the serve boundary; the only change is that `WEEKLY_SERVE["DST"]` names this file
 * instead of the floor. A missing matchup column imputes to its centred mean, so an unknown-matchup
 * DST degrades to line * intercept ~= the season-line floor -- honest, linear, no tree cliff. The
 * blind-LOSO gate (tools/train_dst_stream.py --gate) beats the floor on accuracy (MAE holdout +0.126,
 * 5/5) and, the edge that matters, on the STREAMABLE pick (+2.66 realized pts/wk holdout, 5/5); the
 * served OOS corr(pred, actual) is 0.25 against the floor's 0.04. K stays on the floor (a NULL).
 */
export const DST_STREAM_ARTIFACT = "dst-stream-artifact.json";

/**
 * WHAT SHIPS, PER POSITION. THE SINGLE TABLE, and every consumer reads it.
 *
 * Three artifacts can serve a position. `SHIPPED_WEEKLY_ARTIFACT` is the season-line floor -- every
 * coefficient zero, mean intercept 1.0 -- and is what a position falls back to when nothing beat it.
 * `STREAMING_ARTIFACT` is the two-part model plus the twelve point-in-time opponent columns.
 * `CHALLENGER_WEEKLY_ARTIFACT` is the two-part model over the full weekly feature set INCLUDING the
 * player's own trailing form (`t4_mean`) and matchup (`dvp_mult`) -- the model that only became
 * meaningful once `ff sync-actuals` began feeding real current-season results into `feat_player_week`,
 * from which the forward board derives that form.
 *
 * 2026-09-12 -- OWNER OVERRIDE, RECORDED AS ONE (docs/decisions.md D11, docs/validation.md). This
 * table ordinarily is a MEASUREMENT: a model ships only where it passes the pre-registered gate. The
 * mapping below breaks that rule DELIBERATELY and it must be read as an override, not a passed gate:
 *
 *   `ff evaluate-weekly --rosters 200` (holdout 2012-2025) found the form model MORE ACCURATE than
 *   the shipped streaming serve at every position -- pooled CRPS 2.82 vs 3.34, RMSE 6.45 vs 7.02,
 *   bias -0.03 -- but it FAILS gate clause (b), coverage-given-positive, at 0.851 pooled against the
 *   [0.75, 0.85] band (its intervals are ~0.001 too wide). Streaming passes (b) at 0.827 and is the
 *   less accurate model. The owner chose to ship the more-accurate model and accept the hair's-breadth
 *   calibration miss, rather than fit the gate by shrinking the sd to squeak under 0.85 (which the
 *   repo's discipline forbids). The live `ff scorecard` scores this exact model against 2026 actuals
 *   each week, so the override is under continuous out-of-sample audit, not a one-time bet.
 *
 * Reverting is a one-line change back to STREAMING_ARTIFACT; do that if the live scorecard turns
 * against it, or if a calibrated refit makes the override unnecessary.
 *
 * 2026-09-14 -- THE OVERRIDE IS RETIRED; THE TABLE IS A MEASUREMENT AGAIN (docs/decisions.md D17,
 * docs/weekly.md section 7). The season lines the D11 numbers were measured on had seen their own
 * seasons (the all-history projection artifact projected every historical season). Rebuilt on lines
 * blind to each season and retrained, the same two-part form model PASSES every gate clause on its
 * own merit -- (a) CRPS 2.9036 vs 3.4182, (b) coverage 0.848 in [0.75, 0.85] with every position
 * inside, (c) zero share 0.249 vs 0.246 -- and the per-position gate says: QB/RB/WR/TE ship the form
 * model (each beats the floor by 0.35-1.1 CRPS); K and DST TIE the floor to the third decimal
 * (2.4747 vs 2.4725, 3.1334 vs 3.1328) and fail clause (a) by that hair. So K and DST serve the
 * floor, which is what the measurement says and costs nothing either way.
 *
 * 2026-09-14 -- DST NOW SHIPS THE MATCHUP MODEL (docs/decisions.md D20, docs/validation.md). The
 * WEEKLY feature set that tied the floor above did not include the point-in-time OPPONENT columns
 * (`feat_player_week_stream`: what the opponent allows, the stadium, the Vegas implied total). A DST
 * model fitted on those (`DST_STREAM_ARTIFACT`, tools/train_dst_stream.py) beats the floor MATERIALLY
 * -- on the blind 2021-2025 holdout, accuracy MAE +0.126 (5/5) and the STREAMABLE pick +2.66 realized
 * pts/wk (5/5), with served OOS corr(pred, actual) 0.25 vs the floor's 0.04. It is still a
 * WeeklyArtifact served by `projectWeekly` unchanged, so this is a one-line table move, and reverting
 * DST to the floor is the one-line move back to `SHIPPED_WEEKLY_ARTIFACT`. K stays on the floor: on
 * the same features its streamable pick is a NULL and loses the full-pool pick, so there is nothing
 * to ship.
 *
 * WHY THIS IS A TABLE AND NOT A LIST OF "POSITIONS WHERE X SHIPS": with candidate models the list
 * form needs lists whose overlap nobody checks, and a position in both is served by whichever list is
 * consulted first. The table cannot express that state.
 */
export const WEEKLY_SERVE: Record<string, string> = {
  QB: CHALLENGER_WEEKLY_ARTIFACT,
  RB: CHALLENGER_WEEKLY_ARTIFACT,
  WR: CHALLENGER_WEEKLY_ARTIFACT,
  TE: CHALLENGER_WEEKLY_ARTIFACT,
  K: SHIPPED_WEEKLY_ARTIFACT,
  DST: DST_STREAM_ARTIFACT,
};

/**
 * THE DATE THE SERVE LAST CHANGED, LOCAL. It is written into the scorecard snapshot's metadata so a
 * series that changes model mid-season says WHEN and to WHAT, rather than leaving a later reader to
 * explain a step change in the numbers.
 *
 * IT IS NOT ONLY THE MAPPING'S DATE, AND WP16b IS WHY. D27 promoted a NEW MODEL INTO THE SAME FILE:
 * `CHALLENGER_WEEKLY_ARTIFACT` went from the 25-feature design to the 27-feature one carrying the
 * expert consensus, and `WEEKLY_SERVE` did not move a character -- it already named that file at
 * QB/RB/WR/TE. A stamp that only tracked the table would have recorded 2026-09-14 for both models and
 * left the step change in the series with no explanation in a table nobody may edit. So this date
 * moves whenever the SERVE changes: the mapping, or the artifact behind it.
 *
 * A date is the weak half of the stamp and is not relied on alone: each `weekly` scorecard row also
 * carries the serving artifact's own `fittedAt` and feature count (src/weekly/scorecard.ts), which a
 * promotion cannot leave stale because it is read off the file that produced the row.
 *
 * 2026-09-14 mapping (D17/D20) -> 2026-09-17 artifact promotion (D27) -> 2026-09-18 artifact
 * promotion (D30, the 27-feature design minus the dead `inj_feed` column).
 *
 * WHY D30's DATE IS TOMORROW'S AND NOT TODAY'S, which is the only thing about it that looks odd.
 * D27 took this value on 2026-09-17 and 2026 week 3's `weekly` rows were frozen that morning under
 * it. Those rows are write-once and are NOT rewritten, so the first snapshot the D30 design can
 * appear in is week 4 -- and re-using 2026-09-17 would make two different models carry one date,
 * which is the exact failure this constant was widened to prevent. The date names the week the
 * switch REACHES, not the minute the file moved.
 */
export const WEEKLY_SERVE_SWITCHED_ON = "2026-09-18";

/** Positions the given artifact file serves. Derived from the table so the two can never disagree;
 *  a hand-maintained second list is the enumeration that rots. */
export function SERVE_POSITIONS_FOR(file: string): string[] {
  return Object.entries(WEEKLY_SERVE).filter(([, f]) => f === file).map(([p]) => p);
}

/**
 * THE POSITIONS AT WHICH THE STREAMING MODEL SERVES. Derived from `WEEKLY_SERVE`, so it moves with it.
 *
 * History: `ff evaluate-streaming` (14 held-out seasons, 112,782 player-weeks) then the 2026-09-09
 * re-run on the decision population (docs/validation.md) found the streaming artifact passed all three
 * gate clauses at all six positions, and the owner shipped it at all six.
 *
 * 2026-09-12: the owner OVERRODE that (see the `WEEKLY_SERVE` header) to ship the more-accurate form
 * model despite its 0.001 coverage miss, so `WEEKLY_SERVE` now names `CHALLENGER_WEEKLY_ARTIFACT` at
 * every position and this DERIVED list is consequently EMPTY -- the streaming artifact ships nowhere.
 * That is correct, not a bug: it is a measurement of the table, and the table changed. The lineage
 * page reads it to mark which positions streaming serves, which is now none.
 *
 * READ THE GAIN WITH ITS SOURCE ATTACHED. At every position the streaming model beats the shipped
 * baseline -- but the CONTROL (the same trainer with the twelve opponent columns removed) is within
 * 0.004 CRPS of it at every position. What the gate is passing on is the two-part structure and,
 * at K and DST, the fact that they are FITTED AT ALL rather than two intercepts. The opponent
 * block's own contribution measured ~0, P42 failed saying so, and docs/validation.md records it as
 * a null rather than as a gain.
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
  /** The store's surrogate key, carried through so a consumer that joins on player_sk -- the
   *  in-season replay does -- does not have to re-derive it from feat_key. */
  player_sk: string | null;
  name: string;
  pos: string;
  team: string | null;
  mean: number;
  p10: number;
  /** The median head. Carried because a WEEKLY BAND is p10/p50/p90 and a consumer that has to
   *  re-project to recover one head is a second path to the same number. */
  p50: number;
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

/**
 * THE SERVE RULE, PER FORMAT (F-4, WP3).
 *
 * `WEEKLY_SERVE` names FILES, and those files were resolved through `dataPath` -- the incumbent ESPN
 * root -- whatever league was being served. A superflex full-PPR league would have been handed
 * half-PPR weekly means at every position with nothing anywhere saying so.
 *
 * Now the four weekly artifacts are resolved through the FORMAT's `ModelHandle`. A format that has no
 * weekly artifact yet gets `null` from every load, `projectStreamingWith` returns null, and the
 * consumer's existing named fallback fires (copilot.ts: `basis: "projection"`, the season projection
 * divided by the week count, with `assumptions.basisNote` saying how many players fell back) -- off
 * the FORMAT's own season line, because the board and `points.csv` behind it are the format's too.
 * Null here means "fall back to the season line and SAY SO", never "read the root's copy".
 */
const ARTIFACT_OF: Record<string, ArtifactName> = {
  [CHALLENGER_WEEKLY_ARTIFACT]: "weekly",
  [SHIPPED_WEEKLY_ARTIFACT]: "weekly-lineonly",
  [STREAMING_ARTIFACT]: "streaming",
  [DST_STREAM_ARTIFACT]: "dst-stream",
};

/** Where ONE weekly artifact FILE lives for a given format. The single translation from the
 *  `WEEKLY_SERVE` table's filenames to a format's directory, so the scorecard and the serve path
 *  cannot resolve the same file to two different places. */
export function weeklyArtifactPath(model: ModelHandle, file: string): string {
  const name = ARTIFACT_OF[file];
  // A file the table names but the artifact registry does not know is a programming error, not a
  // missing model -- say so rather than silently returning "unavailable".
  if (!name) throw new Error(`streamingServe: "${file}" is not in the format artifact table (${Object.keys(ARTIFACT_OF).join(", ")})`);
  return model.path(name);
}

function tryLoad(file: string, model: ModelHandle): WeeklyArtifact | null {
  try { return loadWeeklyArtifact(JSON.parse(readFileSync(weeklyArtifactPath(model, file), "utf8"))); } catch { return null; }
}

/**
 * PROJECT ONE WEEK, each position through the artifact that serves it.
 *
 * Rows are read through `loadWeeklyRows`, which joins the streaming columns -- that join is the
 * difference between serving the model that was measured and serving it on its missing-value
 * defaults, and it is asserted in test/streaming-features.test.ts because nothing else would notice.
 */
export function loadStreamingProjection(season: number, week: number, dbPath?: string, model?: ModelHandle): StreamProjections | null {
  const db = open(dbPath);
  try { return projectStreamingWith(db as unknown as StreamDb, season, week, model); } finally { db.close(); }
}

/**
 * The format whose weekly artifacts serve a store, when the caller did not name one: the store's
 * ACTIVE league's format.
 *
 * A store with NO league at all (a fixture, a bare temp DB) gets the incumbent -- that is what such a
 * caller has always been served and there is no league whose format could disagree. A store that DOES
 * name a league gets that league's format and any refusal it carries: swallowing a "format sc-xxxx is
 * not built" here and quietly handing back the root's artifacts is precisely the failure this seam
 * exists to remove.
 */
function modelFor(db: StreamDb, model?: ModelHandle): ModelHandle {
  if (model) return model;
  const handle = db as unknown as import("../db/db.js").DB;
  let ctxLeague: string | null;
  try { ctxLeague = resolveLeagueContext(handle).leagueId; } catch { return INCUMBENT_MODEL; }
  if (ctxLeague == null) return INCUMBENT_MODEL;
  return resolveFormat(handle, ctxLeague).model;
}

/** The narrow slice of a database handle this module needs. Taking a HANDLE rather than a path is
 *  what lets `ff scorecard` -- which already holds an open read-write handle -- reach the same
 *  projections without opening a second connection to the same file mid-transaction. */
export type StreamDb = Parameters<typeof loadWeeklyRows>[0];

/**
 * WHERE THE FEATURE ROWS COME FROM (WP8), which is the other half of the serve rule above.
 *
 * Resolving the ARTIFACTS per format and then reading the ROWS from whatever handle the caller
 * happened to open is a half-fix, and the half that is missing is the one that decides the number.
 * The weekly model's target is `pts / season_line_pg`, so its mean is (ratio) x (that row's season
 * line): serving a Yahoo artifact on the incumbent store's rows multiplies a full-PPR superflex ratio
 * by a half-PPR line, at every position, with full coverage and no error anywhere -- the same shape
 * as F-4, one table further down.
 *
 * A format's rows live in ITS features.db (the incumbent's live in the store itself), so a
 * non-incumbent model reads there. The incumbent keeps the caller's handle untouched, which is what
 * makes `ff scorecard` -- holding an open read-write transaction on the store -- still work, and what
 * makes the ESPN path byte-identical by construction rather than by agreement.
 *
 * A format whose features.db has no rows for the week returns null, i.e. the named fallback: the
 * format's own season line divided by the week count, with the consumer saying so. That is the
 * honest answer when a format's live weekly table has not been rebuilt, and it is strictly better
 * than a confident number computed off another ruleset's line.
 */
function rowsDbFor(db: StreamDb, mh: ModelHandle): { rdb: StreamDb; close: () => void } {
  if (mh.provenance === "incumbent-root" || !mh.has("features-db")) return { rdb: db, close: () => {} };
  const h = open(mh.path("features-db"));
  return { rdb: h as unknown as StreamDb, close: () => h.close() };
}

export function projectStreamingWith(db: StreamDb, season: number, week: number, model?: ModelHandle): StreamProjections | null {
  const mh = modelFor(db, model);
  const files = [...new Set(STREAM_SERVE_POS.map(artifactForPos))];
  const arts = new Map<string, WeeklyArtifact>();
  const missing: string[] = [];
  for (const f of files) {
    const a = tryLoad(f, mh);
    if (a) arts.set(f, a);
  }
  const artifactByPos: Record<string, string> = {};
  for (const p of STREAM_SERVE_POS) {
    const f = artifactForPos(p);
    if (arts.has(f)) artifactByPos[p] = f;
    else missing.push(p);
  }
  if (!arts.size) return null;

  const { rdb, close } = rowsDbFor(db, mh);
  try {
    const rows = loadWeeklyRows(rdb, season, week);
    if (!rows.length) return null;
    // The preseason-line rank, within position, for THIS season. Point-in-time by construction: the
    // line is frozen at Y-09-01, so a rank computed from it says nothing about how the season went.
    const lineOf = rdb.prepare(
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
          feat_key: p.feat_key, player_sk: p.player_sk ?? null, name: p.name, pos: p.pos, team: teamOf.get(p.feat_key) ?? null,
          mean: p.mean, p10: p.p10, p50: p.p50, p90: p.p90,
          pZero: p.pZero ?? null,
          rank: rank.get(p.feat_key) ?? 9999,
          artifact: file,
        });
      }
    }
    return { season, week, rows: out, artifactByPos, missing };
  } finally { close(); }
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
