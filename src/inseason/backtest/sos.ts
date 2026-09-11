/**
 * STRENGTH OF SCHEDULE for the projection/decision experiment.
 *
 * Two flavours, both from ONE point-in-time opponent-ease rating (how many fantasy points a defense
 * has allowed to a position, through the decision week only -- no forward leakage):
 *   - Layer 1: re-scale the frozen line by the player's REST-OF-SEASON schedule ease (favour players
 *     with soft remaining matchups) -- a projection/waiver signal.
 *   - Layer 2: re-scale by the PLAYOFF-week (15-17) schedule ease -- the schedule that decides titles.
 *
 * Forward opponents are rated using data through the DECISION week, so a week-w>W game is judged by the
 * defense's form as of W, never by what it did later. `beta` = 0 collapses to the frozen line.
 */
import type { DB } from "../../db/db.js";
import type { Projector } from "./projectors.js";

const MAXW = 19; // weeks 1..18; prefix index w holds the aggregate of games with week < w

/** Week-indexed prefix sums: prefix[w] = {sum,count} of games in weeks 1..w-1. mean-before-W = prefix[W]. */
function prefixMean(games: { week: number; pts: number }[]): (W: number) => number | null {
  const sum = new Float64Array(MAXW + 1), cnt = new Int32Array(MAXW + 1);
  for (const g of games) { const w = Math.min(g.week, MAXW); sum[w] += g.pts; cnt[w] += 1; }
  for (let w = 1; w <= MAXW; w++) { sum[w] += sum[w - 1]; cnt[w] += cnt[w - 1]; } // cumulative through week w
  return (W) => { const i = Math.max(0, Math.min(W - 1, MAXW)); return cnt[i] ? sum[i] / cnt[i] : null; };
}

export function makeOppEase(db: DB) {
  const cache = new Map<number, {
    allowed: Map<string, (W: number) => number | null>;   // `${opponent}|${pos}` -> mean-before-W
    league: Map<string, (W: number) => number | null>;    // pos -> league mean-before-W
    sched: Map<string, { week: number; opp: string }[]>;  // player_sk -> future opponents
  }>();
  const load = (season: number) => {
    const rawA = new Map<string, { week: number; pts: number }[]>();
    const rawL = new Map<string, { week: number; pts: number }[]>();
    const sched = new Map<string, { week: number; opp: string }[]>();
    for (const r of db.prepare(
      `SELECT CAST(player_sk AS TEXT) sk, pos, week, opponent, pts FROM feat_player_week_model
        WHERE season=? AND pos IN ('RB','WR','TE','QB') AND opponent IS NOT NULL AND pts IS NOT NULL AND player_sk IS NOT NULL`,
    ).all(season) as { sk: string; pos: string; week: number; opponent: string; pts: number }[]) {
      (rawA.get(`${r.opponent}|${r.pos}`) ?? rawA.set(`${r.opponent}|${r.pos}`, []).get(`${r.opponent}|${r.pos}`)!).push({ week: r.week, pts: r.pts });
      (rawL.get(r.pos) ?? rawL.set(r.pos, []).get(r.pos)!).push({ week: r.week, pts: r.pts });
      (sched.get(r.sk) ?? sched.set(r.sk, []).get(r.sk)!).push({ week: r.week, opp: r.opponent });
    }
    const allowed = new Map([...rawA].map(([k, v]) => [k, prefixMean(v)]));
    const league = new Map([...rawL].map(([k, v]) => [k, prefixMean(v)]));
    const e = { allowed, league, sched }; cache.set(season, e); return e;
  };
  return {
    /** ease of facing defense `opp` for `pos`, using games through W-1. >1 = generous (easy matchup). */
    ease: (season: number, opp: string, pos: string, W: number): number => {
      const e = cache.get(season) ?? load(season);
      const a = e.allowed.get(`${opp}|${pos}`)?.(W) ?? null;
      const l = e.league.get(pos)?.(W) ?? null;
      return a != null && l && l > 0 ? a / l : 1;
    },
    schedule: (season: number) => (cache.get(season) ?? load(season)).sched,
  };
}

/** SOS projector: frozen line x (mean schedule ease over the window)^beta, clamped. Window = the
 *  player's remaining games (Layer 1) or playoff weeks 15-17 (Layer 2, `playoff:true`). */
export function makeSosProjector(db: DB, opts: { beta?: number; playoff?: boolean; lo?: number; hi?: number } = {}): Projector {
  const beta = opts.beta ?? 1, lo = opts.lo ?? 0.6, hi = opts.hi ?? 1.6;
  const positions = new Set(["RB", "WR", "TE", "QB"]);
  const oe = makeOppEase(db);
  return (m, season, week) => {
    if (beta === 0 || !positions.has(m.pos)) return m.proj;
    const sched = oe.schedule(season).get(m.playerSk);
    if (!sched) return m.proj;
    const loW = opts.playoff ? Math.max(15, week) : week, hiW = opts.playoff ? 17 : 99;
    const games = sched.filter((g) => g.week >= loW && g.week <= hiW);
    if (!games.length) return m.proj;
    const avgEase = games.reduce((s, g) => s + oe.ease(season, g.opp, m.pos, week), 0) / games.length; // rated as-of decision week
    return m.proj * Math.min(hi, Math.max(lo, Math.pow(avgEase, beta)));
  };
}
