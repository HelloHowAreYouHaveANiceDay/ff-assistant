/**
 * PHASE 1 of the progressive-projection experiment -- the OPPORTUNITY (role) feature.
 *
 * The one in-season signal that is stable, predictive, and leads fantasy points is a player's ROLE:
 * his share of his team's offensive snaps (RB/QB) or pass routes (WR/TE). A backfield takeover or a
 * target-share breakout shows up here WEEKS before it converts to points -- and unlike trailing
 * points (which failed as a projection signal), role does not swing on a lucky touchdown. This module
 * exposes the point-in-time role series so a projector (Phase 2) can re-scale the frozen season line
 * by how much a player's role has grown or shrunk.
 *
 * GENUINE PER-WEEK data: per-week targets/carries are never persisted, but per-game snap share
 * (raw_snap_count.offense_pct, via player_xref 'pfr') and route share (raw_participation, via 'gsis')
 * ARE. We read those series directly -- no lossy differencing of the to-date cumulatives.
 *
 * POINT-IN-TIME IS ENFORCED: the aggregates at decision week W use ONLY games with week < W. A game in
 * week >= W cannot move the week-W features -- asserted by the Phase-1 leakage test.
 */
import type { DB } from "../../db/db.js";

export interface RoleAggregate {
  /** mean role over the last `window` games PLAYED strictly before week W */
  roleRecent: number;
  /** mean role over ALL games played strictly before week W */
  roleToDate: number;
  /** mean role over games BEFORE the recent window (the pre-change baseline a change-point compares
   *  against). null when there are not more than `window` prior games. Phase 3 divides roleRecent by
   *  THIS, not by roleToDate, so a real step is not diluted by its own recent games. */
  rolePrior: number | null;
  /** number of games played strictly before week W (the sample size behind the aggregates) */
  games: number;
}

/** The point-in-time ordered role series (games strictly before week W). One loader, shared by the
 *  aggregate view (makeRoleAggregates) and the raw-series view (makeRolePriorSeries). */
function makeRoleLoader(db: DB): (playerSk: string, pos: string, season: number, week: number) => number[] | null {
  const cache = new Map<number, { snap: Map<string, { week: number; role: number }[]>; route: Map<string, { week: number; role: number }[]> }>();
  const load = (season: number) => {
    const snap = new Map<string, { week: number; role: number }[]>();
    for (const r of db.prepare(
      `SELECT CAST(x.player_sk AS TEXT) sk, s.week, s.offense_pct role
         FROM raw_snap_count s
         JOIN player_xref x ON x.source='pfr' AND x.source_id=s.pfr_player_id
        WHERE s.season=? AND s.game_type='REG' AND s.offense_pct IS NOT NULL`,
    ).all(season) as { sk: string; week: number; role: number }[]) {
      (snap.get(r.sk) ?? snap.set(r.sk, []).get(r.sk)!).push({ week: r.week, role: r.role });
    }
    const route = new Map<string, { week: number; role: number }[]>();
    for (const r of db.prepare(
      `SELECT CAST(x.player_sk AS TEXT) sk, p.week, CAST(p.pass_plays AS REAL)/p.team_pass_plays role
         FROM raw_participation p
         JOIN player_xref x ON x.source='gsis' AND x.source_id=p.gsis_id
        WHERE p.season=? AND p.team_pass_plays>0`,
    ).all(season) as { sk: string; week: number; role: number }[]) {
      (route.get(r.sk) ?? route.set(r.sk, []).get(r.sk)!).push({ week: r.week, role: r.role });
    }
    for (const m of [snap, route]) for (const arr of m.values()) arr.sort((a, b) => a.week - b.week);
    const entry = { snap, route }; cache.set(season, entry); return entry;
  };
  return (playerSk, pos, season, week) => {
    const e = cache.get(season) ?? load(season);
    // WR/TE ride on routes; fall back to snaps (pre-2016 has no participation feed). RB/QB use snaps.
    const primary = pos === "WR" || pos === "TE" ? e.route : e.snap;
    let series = primary.get(playerSk);
    if ((!series || !series.length) && (pos === "WR" || pos === "TE")) series = e.snap.get(playerSk);
    if (!series || !series.length) return null;
    const prior = series.filter((r) => r.week < week);   // POINT-IN-TIME: strictly before decision week
    return prior.length ? prior.map((r) => r.role) : null;
  };
}

/** (playerSk, pos, season, week) -> point-in-time role aggregates, or null when the player has no
 *  observed role yet (rookie week 1, or a position/season without a snap/route feed). */
export function makeRoleAggregates(db: DB, opts: { window?: number } = {}): (
  playerSk: string, pos: string, season: number, week: number,
) => RoleAggregate | null {
  const window = opts.window ?? 3;
  const priorRoles = makeRoleLoader(db);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return (playerSk, pos, season, week) => {
    const prior = priorRoles(playerSk, pos, season, week);
    if (!prior) return null;
    const recent = prior.slice(-window);
    const preWindow = prior.slice(0, -window);   // games BEFORE the recent window
    return {
      roleRecent: mean(recent), roleToDate: mean(prior),
      rolePrior: preWindow.length ? mean(preWindow) : null, games: prior.length,
    };
  };
}

/** The point-in-time ordered role series (games strictly before week W), for a change metric to
 *  encode however it likes -- SMA, EWMA, crossover, slope. Same source and firewall as the aggregates. */
export function makeRolePriorSeries(db: DB): (playerSk: string, pos: string, season: number, week: number) => number[] | null {
  return makeRoleLoader(db);
}
