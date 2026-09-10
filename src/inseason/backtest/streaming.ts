/**
 * DOES STREAMING A SINGLE POSITION BEAT HOLDING YOUR GUY? -- the churn question, scoped so it is
 * actually decidable.
 *
 * Frozen-forward cannot measure churn (it holds a pickup all season). Streaming is the opposite: a
 * WEEKLY decision at ONE position, re-made every week. So this re-decides each week, and because it
 * is one position and our-points-only it dodges the confounds that sink a general roster-churn
 * backtest -- no FAAB budget, no waiver priority, no contested multi-position pool, no need for the
 * field or the H2H schedule. Streaming positions (DST, K, and the waiver-wire QB/TE) are deep, cheap
 * and effectively uncontested, so "start the best available" is a realistic policy.
 *
 * THE COMPARISON, per (season, team, position), summed over the weeks:
 *   HOLD   -- start the best-PROJECTED AVAILABLE player at P ON OUR ROSTER; score his ACTUAL points.
 *   STREAM -- start the best-PROJECTED AVAILABLE player at P among OUR ROSTER + the free-agent pool;
 *             score his ACTUAL points. (Its choice set is a superset of HOLD's.)
 *   diff = STREAM - HOLD.   + => streaming the position pays.
 *
 * POINT-IN-TIME: the CHOICE (whom to start) reads only week-w projections; the SCORE reads that
 * week's actual points, never before the choice is made. CEILING is the best-ACTUAL available player
 * (perfect-hindsight streaming) -- not a policy, just the headroom, so a small realized gain can be
 * read against how much was there to capture. UNIT = the SEASON.
 */
import { loadWeekContext, loadModel, type ModelName } from "./context.js";
import type { DB } from "../../db/db.js";

export interface StreamPosResult {
  pos: string;
  teamWeeks: number;
  holdPtsPerWeek: number;
  streamPtsPerWeek: number;
  ceilingPtsPerWeek: number;
  diffPerWeek: number;              // stream - hold, mean over team-weeks
  bootstrap: { lo: number; hi: number; pStreamBetter: number }; // season-level 90% CI on diff
}

export interface StreamingResult { seasons: number[]; model: ModelName; positions: StreamPosResult[] }

interface Cand { proj: number; actual: number; available: boolean }

function bestBy<T>(xs: T[], key: (x: T) => number): T | null {
  let best: T | null = null;
  for (const x of xs) if (best == null || key(x) > key(best)) best = x;
  return best;
}

export function backtestStreaming(
  db: DB, opts: { leagueId: string; seasons: number[]; model?: ModelName; positions?: string[] },
): StreamingResult {
  const model = opts.model ?? "served";
  const wm = loadModel(model);
  const positions = opts.positions ?? ["QB", "TE", "K", "DST"];
  // pos -> season -> {holdSum, streamSum, ceilSum, n}
  const acc = new Map<string, Map<number, { hold: number; stream: number; ceil: number; n: number }>>();
  for (const p of positions) acc.set(p, new Map(opts.seasons.map((s) => [s, { hold: 0, stream: 0, ceil: 0, n: 0 }])));

  for (const season of opts.seasons) {
    const faByWeek = new Map<number, { playerSk: string; pos: string }[]>();
    for (const r of db.prepare(
      `SELECT week, player_sk, pos FROM fact_fa_pool_week WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { week: number; player_sk: string; pos: string }[]) {
      let l = faByWeek.get(r.week); if (!l) { l = []; faByWeek.set(r.week, l); } l.push({ playerSk: r.player_sk, pos: r.pos });
    }
    const regWeeks = (db.prepare(`SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?`).get(season) as { rw: number | null }).rw
      ?? (db.prepare(`SELECT MAX(week) w FROM feat_player_week_model WHERE season=? AND pts IS NOT NULL`).get(season) as { w: number | null }).w ?? 14;

    for (let w = 1; w <= regWeeks; w++) {
      const wc = loadWeekContext(db, opts.leagueId, season, w, wm);
      const cand = (playerSk: string): Cand | null => {
        const p = wc.players.get(playerSk);
        if (!p || p.proj == null) return null;
        return { proj: p.proj, actual: p.actual, available: p.available };
      };
      const faAt = new Map<string, Cand[]>();
      for (const fa of faByWeek.get(w) ?? []) { const c = cand(fa.playerSk); if (c?.available) { let l = faAt.get(fa.pos); if (!l) { l = []; faAt.set(fa.pos, l); } l.push(c); } }

      for (const [, entries] of wc.rosters) {
        for (const pos of positions) {
          const ours: Cand[] = [];
          for (const e of entries) { const p = wc.players.get(e.playerSk); if (p?.pos === pos && p.available && p.proj != null) ours.push({ proj: p.proj, actual: p.actual, available: true }); }
          const pool = faAt.get(pos) ?? [];
          if (!ours.length && !pool.length) continue; // no data for this pos-week
          const a = acc.get(pos)!.get(season)!;
          const hold = bestBy(ours, (c) => c.proj);
          const stream = bestBy([...ours, ...pool], (c) => c.proj);
          const ceil = bestBy([...ours, ...pool], (c) => c.actual);
          a.hold += hold?.actual ?? 0;
          a.stream += stream?.actual ?? 0;
          a.ceil += ceil?.actual ?? 0;
          a.n++;
        }
      }
    }
  }

  const results: StreamPosResult[] = [];
  for (const pos of positions) {
    const perSeason = opts.seasons.map((s) => { const a = acc.get(pos)!.get(s)!; return a.n ? { hold: a.hold / a.n, stream: a.stream / a.n, ceil: a.ceil / a.n, diff: (a.stream - a.hold) / a.n } : null; }).filter(Boolean) as { hold: number; stream: number; ceil: number; diff: number }[];
    const tw = opts.seasons.reduce((s, y) => s + acc.get(pos)!.get(y)!.n, 0);
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const seasonDiffs = perSeason.map((x) => x.diff);
    let rng = 424242;
    const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const boot: number[] = [];
    for (let i = 0; i < 2000; i++) { let acc2 = 0; for (let k = 0; k < seasonDiffs.length; k++) acc2 += seasonDiffs[Math.floor(rand() * seasonDiffs.length)]; boot.push(acc2 / Math.max(1, seasonDiffs.length)); }
    boot.sort((a, b) => a - b);
    results.push({
      pos, teamWeeks: tw,
      holdPtsPerWeek: mean(perSeason.map((x) => x.hold)),
      streamPtsPerWeek: mean(perSeason.map((x) => x.stream)),
      ceilingPtsPerWeek: mean(perSeason.map((x) => x.ceil)),
      diffPerWeek: mean(seasonDiffs),
      bootstrap: { lo: boot[Math.floor(0.05 * boot.length)], hi: boot[Math.floor(0.95 * boot.length)], pStreamBetter: boot.filter((x) => x > 0).length / boot.length },
    });
  }
  return { seasons: opts.seasons, model, positions: results };
}
