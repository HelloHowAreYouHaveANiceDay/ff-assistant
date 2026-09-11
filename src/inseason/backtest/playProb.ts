/**
 * PLAY-PROBABILITY MODEL (B1) -- P(active | injury designation + practice status), the prior-art
 * approach to the lineup information gap (#11). Our lineup benches OUT/DOUBTFUL (~0% active) but STARTS
 * every QUESTIONABLE (59% active) flat -- so it eats the ~40% of questionables who sit. This gives each
 * player a point-in-time play probability from the Friday report + practice participation, so the
 * lineup can down-weight a likely scratch (Q + Did-Not-Practice) and start a healthy alternative.
 *
 * It is an EMPIRICAL rate table by (report_status, practice_status), the studied form -- fit leave-one-
 * season-out for a clean backtest. Data: feat_player_week_context (Friday report/practice) x the outcome
 * feat_player_week_model.pts (NULL = the player did not play). A player NOT on the report plays ~always.
 */
import type { DB } from "../../db/db.js";

const practiceBucket = (p: string | null): string => {
  if (!p) return "NA";
  if (p.startsWith("Full")) return "Full";
  if (p.startsWith("Limited")) return "Limited";
  if (p.startsWith("Did Not")) return "DNP";
  return "NA";
};

export interface PlayProb { p(report: string | null, practice: string | null): number; table: Record<string, { p: number; n: number }>; }

export function fitPlayProb(db: DB, opts: { excludeSeason?: number; seasons?: [number, number] } = {}): PlayProb {
  const [lo, hi] = opts.seasons ?? [2016, 2024];
  const rows = db.prepare(
    `SELECT c.report_status_fri report, c.practice_status_fri practice,
            CASE WHEN m.pts IS NOT NULL AND (m.is_bye=0 OR m.is_bye IS NULL) THEN 1 ELSE 0 END active
       FROM feat_player_week_context c
       JOIN feat_player_week_model m ON m.season=c.season AND m.week=c.week AND m.player_sk=c.player_sk
      WHERE c.report_status_fri IS NOT NULL AND c.season BETWEEN ? AND ?
        ${opts.excludeSeason ? "AND c.season != @ex" : ""}`,
  ).all(...(opts.excludeSeason ? [lo, hi, { ex: opts.excludeSeason }] : [lo, hi])) as { report: string; practice: string | null; active: number }[];

  const cell = new Map<string, { a: number; t: number }>();      // (report|practice)
  const byReport = new Map<string, { a: number; t: number }>();  // report-only fallback
  for (const r of rows) {
    const k = `${r.report}|${practiceBucket(r.practice)}`;
    const c = cell.get(k) ?? { a: 0, t: 0 }; c.a += r.active; c.t++; cell.set(k, c);
    const b = byReport.get(r.report) ?? { a: 0, t: 0 }; b.a += r.active; b.t++; byReport.set(r.report, b);
  }
  const table: Record<string, { p: number; n: number }> = {};
  for (const [k, c] of cell) table[k] = { p: c.a / c.t, n: c.t };

  return {
    table,
    p(report, practice) {
      if (report == null) return 0.99;                              // not on the injury report -> plays
      const c = cell.get(`${report}|${practiceBucket(practice)}`);
      if (c && c.t >= 25) return c.a / c.t;                         // enough samples for the refined cell
      const b = byReport.get(report);                               // fall back to report-only rate
      return b && b.t > 0 ? b.a / b.t : 0.5;
    },
  };
}
