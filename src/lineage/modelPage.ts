// THE MODEL PAGE'S JSON, ASSEMBLED FROM THE REGISTRIES -- not retyped as page prose. Written 2026-09-08
// as a static description of "a curve times two multipliers", which has been stale since: the
// projection is now a TRAINED artifact, there are five more artifacts (weekly, weekly-challenger,
// streaming, price, plus the retired age/opportunity pair), a serve table saying which artifact
// answers per position, a calibration against real outcomes, and a scorecard of frozen predictions.
// None of that was ever added to the page, because none of it had anywhere to come FROM -- this
// module is that place. `app/renderer/app.js` renders this JSON; it contains no numbers of its own
// (see test/model-page.test.ts).
import { readFileSync, existsSync } from "node:fs";
import { MODELS, EVALUATED_NOT_SHIPPED, modelStatus, type ModelStatus } from "../draft/models.js";
import { SHIPPED_STREAMING_POSITIONS, STREAM_SERVE_POS, artifactForPos, STREAMING_ARTIFACT } from "../weekly/streamingServe.js";
import { SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT } from "../weekly/projector.js";
import { SCORECARD_KINDS, CHALLENGER_FIRST_WEEK } from "../weekly/scorecard.js";
import { dataPath } from "../data/paths.js";
import { ledgerSummary, type PredictionRow } from "./ledger.js";
import type { DB } from "../db/db.js";

export interface ModelPageArtifactMeta {
  key: string;
  fittedFrom: string | null;
  fittedAt: string | null;
  seasons: unknown;
  holdoutSeason: unknown;
  features: string[] | null;
  gate: unknown;
}

/** Whatever generic provenance fields an artifact JSON happens to carry. Read directly from the file
 *  (not through modelStatus, which only surfaces the subset a check function needs) so a field this
 *  page wants but no check reads -- holdoutSeason, feature names, a trainer-written gate result --
 *  still reaches the page without a second parser having to agree with the first one's schema. */
function artifactMeta(key: string, file: string): ModelPageArtifactMeta | null {
  const p = dataPath(file);
  if (!existsSync(p)) return null;
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  const features = Array.isArray(j.features)
    ? (j.features as unknown[]).map(String)
    : (j.features && typeof j.features === "object"
      ? Object.keys(j.features as object)
      : null);
  return {
    key,
    fittedFrom: typeof j.fittedFrom === "string" ? j.fittedFrom : null,
    fittedAt: typeof j.fittedAt === "string" ? j.fittedAt : null,
    seasons: j.seasons ?? null,
    holdoutSeason: j.holdoutSeason ?? null,
    features,
    gate: j.gate ?? null,
  };
}

export interface WeeklyServeRow { pos: string; artifact: string; shipped: boolean }

/** WEEKLY_SERVE, as this page names it: which artifact answers each of the six streaming positions,
 *  from `SHIPPED_STREAMING_POSITIONS` / `artifactForPos` (src/weekly/streamingServe.ts) -- the one
 *  constant that decides this, per that module's own header comment. */
function weeklyServeTable(): WeeklyServeRow[] {
  return STREAM_SERVE_POS.map((pos) => ({
    pos,
    artifact: artifactForPos(pos),
    shipped: SHIPPED_STREAMING_POSITIONS.includes(pos),
  }));
}

export interface ScorecardStateRow {
  kind: string;
  weeksFrozen: number;
  weeksScored: number;
  models: string[];
}

function scorecardState(db: DB): ScorecardStateRow[] {
  return SCORECARD_KINDS.map((kind) => {
    const frozen = db.prepare(
      `SELECT COUNT(DISTINCT week) n FROM scorecard_prediction WHERE kind = ?`,
    ).get(kind) as { n: number };
    const scored = db.prepare(
      `SELECT COUNT(DISTINCT week) n FROM scorecard_result WHERE kind = ?`,
    ).get(kind) as { n: number };
    const models = (db.prepare(
      `SELECT DISTINCT model FROM scorecard_prediction WHERE kind = ? ORDER BY model`,
    ).all(kind) as { model: string }[]).map((r) => r.model);
    return { kind, weeksFrozen: frozen.n, weeksScored: scored.n, models };
  });
}

/** Per-model scored metrics that already exist in `scorecard_result`, grouped so the page can show
 *  "what has this model actually scored, live" beside its registry entry. */
function scorecardScores(db: DB): Record<string, { kind: string; metric: string; value: number; n: number }[]> {
  const rows = db.prepare(
    `SELECT kind, model, metric, AVG(value) AS value, SUM(n) AS n FROM scorecard_result GROUP BY kind, model, metric`,
  ).all() as { kind: string; model: string; metric: string; value: number; n: number }[];
  const out: Record<string, { kind: string; metric: string; value: number; n: number }[]> = {};
  for (const r of rows) (out[r.model] ??= []).push({ kind: r.kind, metric: r.metric, value: r.value, n: r.n });
  return out;
}

export interface ModelPage {
  models: (ModelStatus & { meta: ModelPageArtifactMeta | null })[];
  rejected: typeof EVALUATED_NOT_SHIPPED;
  weeklyServe: WeeklyServeRow[];
  challengerFirstWeek: number;
  scorecard: ScorecardStateRow[];
  scorecardScores: Record<string, { kind: string; metric: string; value: number; n: number }[]>;
  ledger: { rows: PredictionRow[]; counts: Record<string, number> };
}

/** THE ASSEMBLY. Every field is read from a registry, an artifact file, or the store -- nothing here
 *  is a number typed for this page. Served as `modelPage` over `ff serve` and by `ff models --json`. */
export function buildModelPage(db: DB): ModelPage {
  const status = modelStatus();
  const models = status.map((m) => ({ ...m, meta: artifactMeta(m.key, m.file) }));
  return {
    models,
    rejected: EVALUATED_NOT_SHIPPED,
    weeklyServe: weeklyServeTable(),
    challengerFirstWeek: CHALLENGER_FIRST_WEEK,
    scorecard: scorecardState(db),
    scorecardScores: scorecardScores(db),
    ledger: ledgerSummary(db),
  };
}

// re-exported so a caller of this module does not also need to import streamingServe/scorecard
// constants directly just to label the weeklyServe/scorecard sections.
export { SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT, STREAMING_ARTIFACT, MODELS };
