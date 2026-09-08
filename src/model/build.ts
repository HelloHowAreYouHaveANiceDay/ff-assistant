/**
 * Produce the CURVE-ONLY artifact.
 *
 * This is the floor the projector stands on. `project()` refuses to run without an artifact rather
 * than falling back to anything -- a silent fallback is how a degraded model ships looking normal --
 * so there has to be an artifact that is honestly just the curve, and it has to be producible on
 * demand rather than hand-written once and left to rot.
 *
 * It reproduces the pre-Phase-2a board exactly: the point-in-time conditional curve, times the two
 * shipped multipliers, declared in the artifact's multiplicative stage instead of applied by the
 * consumer. Its quantile heads are the empirical quantiles of actual/curve per position, measured
 * over completed seasons, so even the floor emits a real spread rather than three copies of the mean.
 *
 * A NOTE ON ITS GOLDEN BLOCK. The golden rows on a TypeScript-produced artifact are evaluated by the
 * same code that produced them, so they are a SHAPE check and nothing more. The golden block earns
 * its keep on the Python-produced artifact, where the two sides are genuinely independent
 * implementations of the same transforms -- which is the only place a producer shipping its own
 * validator can be caught grading its own homework.
 */
import { openDb, type DB } from "../db/db.js";
import { curveOnlyArtifact, projectSeason, type ProjectionArtifact, type GoldenRow } from "./projector.js";

const QUANT_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 1;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Empirical quantiles of actual / curve value, per position, over the seasons given. */
/** Beyond this rank the curve has flattened onto its last fitted value, so `actual / curve` stops
 *  measuring dispersion and starts measuring how far past the end of the curve we are. Left
 *  uncapped, QB p90 came out at 2.24 and the shipped board printed a 731-point p90 on a quarterback
 *  -- a number that is not wrong so much as answering a different question. 36 is three deep at
 *  every position in a 16-team league, i.e. the region the board actually prices. */
export const QUANTILE_MAX_RANK = 36;

export function ratioQuantiles(db: DB, from: number, to: number, holdout?: number | null): Record<string, { p10: number; p50: number; p90: number; n: number }> {
  const rows = (db.prepare(
    `SELECT season, pos, pts, curve_value_prior FROM feat_player_season
      WHERE season BETWEEN ? AND ? AND pts IS NOT NULL AND curve_value_prior > 20
        AND prior_pos_rank IS NOT NULL AND prior_pos_rank <= ?`,
  ).all(from, to, QUANTILE_MAX_RANK) as { season: number; pos: string; pts: number; curve_value_prior: number }[])
    .filter((r) => holdout == null || r.season !== holdout);
  const by: Record<string, number[]> = {};
  for (const r of rows) (by[r.pos] ??= []).push(r.pts / r.curve_value_prior);
  const out: Record<string, { p10: number; p50: number; p90: number; n: number }> = {};
  for (const [pos, v] of Object.entries(by)) {
    if (v.length < 50) continue;                 // below this a quantile is a coin flip, not a number
    v.sort((a, b) => a - b);
    out[pos] = { p10: quantile(v, 0.10), p50: quantile(v, 0.50), p90: quantile(v, 0.90), n: v.length };
  }
  return out;
}

export function buildCurveOnlyArtifact(opts: {
  dbPath?: string; from?: number; to?: number;
  base?: ProjectionArtifact["base"];
  holdoutSeason?: number | null;
}): { artifact: ProjectionArtifact; quantiles: Record<string, { p10: number; p50: number; p90: number; n: number }> } {
  const db = openDb(opts.dbPath);
  const from = opts.from ?? 1999, to = opts.to ?? 2025;
  // The holdout season is EXCLUDED from the quantile fit as well as from any coefficient fit. A
  // quantile is a fitted quantity; leaving it in would leak the held-out season into the baseline
  // the trained model is scored against, which flatters exactly the wrong side.
  const seasons: number[] = [];
  for (let y = from; y <= to; y++) if (y !== opts.holdoutSeason) seasons.push(y);
  const qh = ratioQuantiles(db, from, to, opts.holdoutSeason);
  db.close();
  const artifact = curveOnlyArtifact({
    positions: QUANT_POS.filter((p) => qh[p]), seasons,
    base: opts.base,
    quantiles: Object.fromEntries(Object.entries(qh).map(([p, v]) => [p, { p10: v.p10, p50: v.p50, p90: v.p90 }])),
  });
  artifact.holdoutSeason = opts.holdoutSeason ?? null;
  artifact.fittedAt = new Date().toISOString().slice(0, 10);
  artifact.golden = goldenFor(artifact);
  return { artifact, quantiles: qh };
}

/** Five fixture rows evaluated through the shipped evaluator, stored on the artifact. */
export function goldenFor(a: ProjectionArtifact): GoldenRow[] {
  const fixtures: Omit<GoldenRow, "expect">[] = [
    { pos: "RB", base: 250, rank: 1, f: { age: 24, prior_pts: 300, prior_games: 17, prior_pos_rank: 1 }, factors: { age_factor: 1, opp_factor: 1 } },
    { pos: "WR", base: 175, rank: 12, f: { age: 29.5, prior_pts: 180, prior_games: 15, prior_pos_rank: 12 }, factors: { age_factor: 0.95, opp_factor: 1.05 } },
    { pos: "QB", base: 246, rank: 12, f: { age: 33, prior_pts: 240, prior_games: 16, prior_pos_rank: 12 }, factors: { age_factor: 0.9, opp_factor: 1 } },
    { pos: "TE", base: 101, rank: 24, f: { age: 26, prior_pts: 95, prior_games: 12, prior_pos_rank: 24 }, factors: { age_factor: 1, opp_factor: 0.9 } },
    // A row with EVERY optional input missing. It is the fixture most likely to expose a
    // disagreement, because it is the one where the two sides fall back on their own defaults.
    { pos: "RB", base: 120, rank: 30, f: {}, factors: {} },
  ];
  const out: GoldenRow[] = [];
  for (const [i, g] of fixtures.entries()) {
    if (!a.coef[g.pos]) continue;
    const r = projectSeason({
      season: 0, asOf: "", artifact: { ...a, golden: [] },
      features: [{
        player_sk: null, name: `golden-${i}`, pos: g.pos, base: g.base, rank: g.rank ?? null,
        f: g.f, factors: { age_factor: g.factors?.age_factor ?? 1, opp_factor: g.factors?.opp_factor ?? 1 },
      }],
    })[0];
    if (!r) continue;
    out.push({ ...g, expect: { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 } });
  }
  return out;
}
