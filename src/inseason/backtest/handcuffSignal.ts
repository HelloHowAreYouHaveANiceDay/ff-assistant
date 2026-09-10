/**
 * THE HANDCUFF SIGNAL for the decision harness -- each player's per-week conditional-role value, from
 * the SHIPPED handcuff model (src/inseason/handcuff.ts), point-in-time.
 *
 * This is the "upside that a mean projection cannot see": a buried backup RB projects ~0 now, but if
 * the workhorse ahead of him goes down his role -- and his points -- jump. The bench-use A/B measured
 * that BOOM-variance upside does not pay; this tests the other flavour, CONDITIONAL-role upside, which
 * is the one bench-value mechanism the repo has actually validated. `handcuffAwareDrop` (policies.ts)
 * keeps the high-handcuff body value-min would cut.
 *
 * Reuses the real `handcuffBoard`, not a reimplementation. The board ranks a team's backfield by
 * PROJECTION (not the depth chart, per its own header), so `feat_player_week_model` alone -- which
 * carries name/pos/team/season_line_pg -- reconstructs the DepthEntry set; no raw_depth_chart needed.
 * Built with weeks = 1 so the value is PER-WEEK (comparable to a per-game projection), and it excludes
 * the live injury outlook, so it is a pure tier-rate handcuff EV knowable before the games.
 */
import type { DB } from "../../db/db.js";
import { nameKey } from "../../draft/values.js";
import { handcuffBoard, type DepthEntry } from "../handcuff.js";
import { loadVarianceModel, poolRankFor } from "./scorers.js";
import type { DecisionMember } from "./harness.js";

export function makeHandcuffValueFn(db: DB, positions: string[] = ["RB"]): (m: DecisionMember, season: number) => number {
  const vm = loadVarianceModel();
  const bySeason = new Map<number, Map<string, number>>();

  const build = (season: number): Map<string, number> => {
    const pool = poolRankFor(db, season);
    const rows = db.prepare(
      `SELECT name, pos, team, MAX(season_line_pg) AS line, MIN(depth_rank) AS depth
         FROM feat_player_week_model
        WHERE season=? AND name IS NOT NULL AND team IS NOT NULL AND season_line_pg IS NOT NULL
        GROUP BY name, pos, team`,
    ).all(season) as { name: string; pos: string; team: string; line: number; depth: number | null }[];
    const depth: DepthEntry[] = rows.map((r) => ({
      name: r.name, pos: r.pos, team: r.team, depthOrder: r.depth, projPts: r.line,
      poolRank: pool.get(r.name)?.rank ?? null,
    }));
    // poolSize[pos] = the position's pool size (poolRankFor's `of`), the denominator for the lead's
    // rank fraction -> his tier miss rate.
    const poolSize: Record<string, number> = {};
    for (const r of rows) { const pr = pool.get(r.name); if (pr) poolSize[r.pos] = pr.of; }
    const m = new Map<string, number>();
    for (const row of handcuffBoard(depth, vm, { weeks: 1, positions, poolSize })) {
      m.set(nameKey(row.name), Math.max(0, row.expectedPts)); // per-week conditional EV
    }
    return m;
  };

  return (member, season) => {
    let m = bySeason.get(season); if (!m) { m = build(season); bySeason.set(season, m); }
    return m.get(nameKey(member.name)) ?? 0;
  };
}
