/**
 * ROOKIE PRODUCTION MODEL -- expected rookie-season fantasy points from DRAFT CAPITAL.
 *
 * Rookies have no prior-season NFL finish, so the projection's backtest pool (feat_player_season Y-1
 * finishers) drops them entirely -- the championship backtest never drafts a rookie and cannot price
 * rookie value (docs/edges.md #9). The rookie-holdout showed draft capital alone predicts rookie
 * production at r~0.52, and that college/athletic add nothing over it, so THIS is the whole rookie
 * signal: expected season points as a log-linear function of overall draft pick, per position.
 *
 *   E[rookie pts | pos, overall] = a_pos + b_pos * ln(overall)     (b < 0: later picks score less)
 *
 * It is a stable structural prior (the draft-capital->production relationship, like the age curve),
 * fit once over history; `beforeSeason` supports a leakage-clean per-season refit for validation.
 */
import type { DB } from "../db/db.js";

export type RookieCurve = Record<string, { a: number; b: number; n: number }>;
export const ROOKIE_POS = ["QB", "RB", "WR", "TE"];

export function fitRookieCurve(db: DB, opts: { beforeSeason?: number } = {}): RookieCurve {
  const rows = db.prepare(
    `SELECT d.position pos, d.pick ovr, s.pts
       FROM raw_nfl_draft_pick d
       JOIN player_xref x ON x.source='pfr' AND x.source_id=d.pfr_player_id
       JOIN feat_player_season s ON s.player_sk = CAST(x.player_sk AS TEXT) AND s.season = d.season
      WHERE d.position IN ('QB','RB','WR','TE') AND d.pick IS NOT NULL AND d.pick > 0 AND s.pts IS NOT NULL
      ${opts.beforeSeason ? "AND d.season < @before" : ""}`,
  ).all(opts.beforeSeason ? { before: opts.beforeSeason } : {}) as { pos: string; ovr: number; pts: number }[];
  const curve: RookieCurve = {};
  for (const pos of ROOKIE_POS) {
    const pr = rows.filter((r) => r.pos === pos);
    const n = pr.length;
    if (n < 8) { curve[pos] = { a: 0, b: 0, n }; continue; } // too few to fit -> flat 0 (no rookie priced)
    const xs = pr.map((r) => Math.log(r.ovr)), ys = pr.map((r) => r.pts);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const b = sxx ? sxy / sxx : 0;
    curve[pos] = { a: my - b * mx, b, n };
  }
  return curve;
}

/** Expected rookie season points for a position + overall pick, floored positive. */
export function rookiePoints(curve: RookieCurve, pos: string, overall: number): number | null {
  const c = curve[pos]; if (!c || c.n < 8 || !(overall > 0)) return null;
  return Math.max(5, c.a + c.b * Math.log(overall));
}

/** WEEKLY fallback: rookies drafted in `season` -> a per-game season line (season points / scheduled
 *  games), the `season_line_pg` the projection's backtest path leaves NULL for them. Keyed by player_sk
 *  (TEXT, as feat_player_week_model keys). */
export function rookieWeeklyLines(db: DB, season: number, curve: RookieCurve): Map<string, number> {
  const games = season >= 2021 ? 17 : 16; // scheduled games; the line is per-game like season_line_pg
  const out = new Map<string, number>();
  for (const r of rookieProjections(db, season, curve)) out.set(r.player_sk, r.points / games);
  return out;
}

/** Rookies drafted in `season` (skill positions) with their draft-capital projected season points. */
export function rookieProjections(db: DB, season: number, curve: RookieCurve): { player_sk: string; name: string; pos: string; overall: number; points: number }[] {
  const rows = db.prepare(
    `SELECT CAST(x.player_sk AS TEXT) sk, d.pfr_player_name name, d.position pos, d.pick ovr
       FROM raw_nfl_draft_pick d JOIN player_xref x ON x.source='pfr' AND x.source_id=d.pfr_player_id
      WHERE d.season = ? AND d.position IN ('QB','RB','WR','TE') AND d.pick IS NOT NULL AND d.pick > 0`,
  ).all(season) as { sk: string; name: string; pos: string; ovr: number }[];
  const out: { player_sk: string; name: string; pos: string; overall: number; points: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.sk)) continue; seen.add(r.sk);
    const p = rookiePoints(curve, r.pos, r.ovr);
    if (p != null) out.push({ player_sk: r.sk, name: r.name, pos: r.pos, overall: r.ovr, points: p });
  }
  return out;
}
