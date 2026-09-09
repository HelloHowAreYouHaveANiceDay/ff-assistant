/**
 * BACKTEST 2: WAIVER POLICY AGAINST THE ROOM'S ACTUAL CLAIMS.
 *
 * For every week with free-agent-pool state, the room made K adds. This ranks the same pool by what
 * our tool knew AS OF that week, takes ITS top K, and scores both sets on what the added players
 * actually went on to do -- realised rest-of-season points per game from the add week forward.
 *
 * WHAT IS SUBSTITUTED, AND IT IS A REAL LIMIT, NOT A DETAIL. `waiverTargets` scores a claim by the
 * change in our PLAYOFF PROBABILITY from a paired simulation, and it takes a `SimContext`. That
 * context is built entirely from the current season's board, ownership, projections and schedule;
 * there is no way to construct one for 2019 without inventing a 2019 board, and an invented board
 * would make the whole comparison a measurement of my own fabrication. So the objective is replaced
 * by the quantity the simulation is ultimately a function of -- expected points from the added
 * player -- and that substitution is stated on every number below. What is being backtested is the
 * RANKING, on point-in-time projections; what is NOT being backtested is the playoff-odds objective
 * or the FAAB rule.
 *
 * THE AS-OF-w ESTIMATE OF REST-OF-SEASON VALUE IS THE WEEK-w PROJECTION. It has to be. Running the
 * projector on week w+3's feature row would use a row built with an as-of AFTER week w, which is
 * the leak this whole track is guarded against. Under the floor artifact the week-w projection IS
 * the preseason season line per game, which is a perfectly reasonable rest-of-season rate; under
 * the challenger it is matchup-adjusted, which is a worse rest-of-season rate and a better one-week
 * rate. Both are reported.
 *
 * THE CHOICE SET IS THE PREVIOUS WEEK'S POOL, AND THAT WAS FOUND BY CHECKING RATHER THAN ASSUMED.
 * The first version used week w's own free-agent pool and matched only 3.9% of the room's adds --
 * an add executed inside scoring period w is already on week w's roster snapshot, so the man a
 * manager claimed is by construction not in the pool we computed for that week. Reading 3.9% as
 * "the room adds obscure players" would have been a conclusion about my own join. Against week w-1's
 * pool the match rate is 88.4% (1,665 of 1,883). Rest-of-season points are measured from week w
 * forward on BOTH sides, so the choice set moving back a week does not move the scoring window.
 *
 * PER FAAB DOLLAR, HONESTLY. The room's dollars are known; ours are not, because `faabFor` prices a
 * playoff-probability delta that cannot be computed for a past season. The comparison is therefore
 * DOLLAR-MATCHED: our policy is given the same claims and the same dollars the room actually spent
 * that week. That makes the per-dollar test and the per-add test the SAME TEST with a common
 * denominator, and saying so is better than presenting one number twice as though it were two
 * pieces of evidence. What IS a separate measurement, and is reported: whether the room's own bid
 * size predicted the player's realised production -- a question about the room that needs no model
 * of ours at all.
 */
import type { DB } from "../../db/db.js";
import { loadWeekContext, loadModel, type ModelName } from "./context.js";
import { mean, r2, r3 } from "./lineup.js";

export interface AddRow {
  season: number; week: number; teamId: string; playerSk: string; name: string; pos: string;
  bid: number; type: string;
  /** Realised points per game from this week to the end of the season. NULL where the player has no
   *  remaining weekly rows at all (a season-ending injury the same week, or a man the feature table
   *  stops carrying). Counted separately rather than scored as zero. */
  rosPpg: number | null;
  rosPts: number | null;
  /** Whether he was in the free-agent pool we computed for this week. Reported: an add whose player
   *  our pool did not contain is a disagreement between two of our own tables, not a manager error. */
  inPool: boolean;
}

export interface WaiverWeek {
  season: number; week: number;
  roomAdds: AddRow[];
  ourAdds: { playerSk: string; name: string; pos: string; proj: number; rosPpg: number | null; rosPts: number | null }[];
  dollars: number;
}

export interface WaiverSummary {
  model: ModelName;
  weeks: number; roomAdds: number; ourAdds: number; poolMatchRate: number;
  roomPpg: number; ourPpg: number;
  roomTotalRos: number; ourTotalRos: number; dollars: number;
  roomPerDollar: number; ourPerDollar: number;
  /** Share of weeks where our top-K beat the room's K on mean realised points per game. */
  weeksWon: number;
  /** Does paying more actually get more? The room's realised points per game by bid bucket. */
  bidBuckets: { bucket: string; n: number; meanBid: number; meanPpg: number }[];
  seasons: { season: number; weeks: number; room: number; ours: number }[];
}

/** The room's executed adds, by scoring period. DRAFT rows are excluded: an auction pick is not a
 *  waiver claim, and 182 of them a season would swamp the 30 that are. */
export function roomAdds(db: DB, leagueId: string, season: number): AddRow[] {
  return db.prepare(
    `SELECT t.season, t.week, t.team_id AS teamId, t.espn_player_id AS eid, t.type, COALESCE(t.bid_amount,0) AS bid
       FROM raw_league_transaction t
      WHERE t.league_id=? AND t.season=? AND t.item_type='ADD' AND t.status='EXECUTED'
        AND t.type IN ('WAIVER','FREEAGENT')
      ORDER BY t.week, t.team_id`,
  ).all(leagueId, season) as unknown as AddRow[];
}

export function backtestWaivers(
  db: DB, leagueId: string, opts: { seasons: number[]; model: ModelName; poolMinLine?: number },
): { weeks: WaiverWeek[]; summary: WaiverSummary } {
  const artifact = loadModel(opts.model);
  const out: WaiverWeek[] = [];
  let matched = 0, addsTotal = 0;

  for (const season of opts.seasons) {
    const raw = db.prepare(
      `SELECT t.week, t.team_id AS teamId, t.espn_player_id AS eid, t.type, COALESCE(t.bid_amount,0) AS bid
         FROM raw_league_transaction t
        WHERE t.league_id=? AND t.season=? AND t.item_type='ADD' AND t.status='EXECUTED'
          AND t.type IN ('WAIVER','FREEAGENT') ORDER BY t.week`,
    ).all(leagueId, season) as { week: number; teamId: string; eid: string; type: string; bid: number }[];
    if (!raw.length) continue;

    const byWeek = new Map<number, typeof raw>();
    for (const r of raw) {
      if (!byWeek.has(r.week)) byWeek.set(r.week, []);
      byWeek.get(r.week)!.push(r);
    }

    for (const [week, adds] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
      // THE CHOICE SET: who was on nobody's roster the week BEFORE. See the header.
      const pool = db.prepare(
        `SELECT player_sk, name, pos FROM fact_fa_pool_week WHERE season=? AND week=?`,
      ).all(season, Math.max(1, week - 1)) as { player_sk: string; name: string; pos: string }[];
      if (!pool.length) continue;
      const inPool = new Set(pool.map((p) => p.player_sk));
      const ctx = loadWeekContext(db, leagueId, season, week, artifact);
      // Realised points from THIS week forward, for whoever is asked about. One statement, used for
      // the room's adds and for ours, so the two sides cannot be scored over different windows.
      const rosStmt = db.prepare(
        `SELECT COALESCE(SUM(pts),0) AS ros_pts, COUNT(*) AS ros_games FROM feat_player_week_model
          WHERE season=? AND player_sk=? AND week>=?`);
      const rosFrom = (sk: string) => rosStmt.get(season, sk, week) as { ros_pts: number; ros_games: number };

      // The room's adds, resolved by ESPN id through the same resolver the feature build uses.
      const resolved: AddRow[] = [];
      for (const a of adds) {
        const meta = db.prepare(
          `SELECT player_sk, name, pos FROM fact_roster_week WHERE season=? AND espn_player_id=? LIMIT 1`,
        ).get(season, a.eid) as { player_sk: string; name: string; pos: string } | undefined;
        addsTotal++;
        if (!meta) continue;
        const hit = inPool.has(meta.player_sk);
        if (hit) matched++;
        const f = rosFrom(meta.player_sk);
        resolved.push({
          season, week, teamId: a.teamId, playerSk: meta.player_sk, name: meta.name, pos: meta.pos,
          bid: a.bid, type: a.type,
          rosPts: f.ros_games ? r2(f.ros_pts) : null,
          rosPpg: f.ros_games ? r2(f.ros_pts / f.ros_games) : null,
          inPool: hit,
        });
      }
      if (!resolved.length) continue;

      // OUR TOP-K, from the same pool, ranked by the week-w projection. Only players the projector
      // produced a row for: a pool member with no season line has no projection, and ranking him at
      // zero would put every unknown at the bottom for a reason that is not a measurement.
      const ranked = pool
        .map((p) => ({ p, proj: ctx.players.get(p.player_sk)?.proj ?? null }))
        .filter((x) => x.proj != null && x.proj >= (opts.poolMinLine ?? 0))
        .sort((a, b) => (b.proj as number) - (a.proj as number))
        .slice(0, resolved.length);

      out.push({
        season, week, dollars: resolved.reduce((s, a) => s + a.bid, 0),
        roomAdds: resolved,
        ourAdds: ranked.map((x) => {
          const f = rosFrom(x.p.player_sk);
          return {
            playerSk: x.p.player_sk, name: x.p.name, pos: x.p.pos, proj: r2(x.proj as number),
            rosPts: f.ros_games ? r2(f.ros_pts) : null,
            rosPpg: f.ros_games ? r2(f.ros_pts / f.ros_games) : null,
          };
        }),
      });
    }
  }

  // ----- SUMMARY -----
  const roomScored = out.flatMap((w) => w.roomAdds).filter((a) => a.rosPpg != null);
  const ourScored = out.flatMap((w) => w.ourAdds).filter((a) => a.rosPpg != null);
  const dollars = out.reduce((s, w) => s + w.dollars, 0);
  const roomRos = roomScored.reduce((s, a) => s + (a.rosPts ?? 0), 0);
  const ourRos = ourScored.reduce((s, a) => s + (a.rosPts ?? 0), 0);
  let weeksWon = 0, weeksScored = 0;
  for (const w of out) {
    const r = w.roomAdds.filter((a) => a.rosPpg != null).map((a) => a.rosPpg as number);
    const o = w.ourAdds.filter((a) => a.rosPpg != null).map((a) => a.rosPpg as number);
    if (!r.length || !o.length) continue;
    weeksScored++;
    if (mean(o) > mean(r)) weeksWon++;
  }

  const buckets = [
    { bucket: "$0 (free agent)", lo: 0, hi: 0 },
    { bucket: "$1-4", lo: 1, hi: 4 },
    { bucket: "$5-14", lo: 5, hi: 14 },
    { bucket: "$15-39", lo: 15, hi: 39 },
    { bucket: "$40+", lo: 40, hi: Infinity },
  ].map((b) => {
    const sub = roomScored.filter((a) => a.bid >= b.lo && a.bid <= b.hi);
    return { bucket: b.bucket, n: sub.length, meanBid: r2(mean(sub.map((a) => a.bid))), meanPpg: r2(mean(sub.map((a) => a.rosPpg as number))) };
  });

  const seasons = [...new Set(out.map((w) => w.season))].sort().map((s) => {
    const ws = out.filter((w) => w.season === s);
    return {
      season: s, weeks: ws.length,
      room: r2(mean(ws.flatMap((w) => w.roomAdds).filter((a) => a.rosPpg != null).map((a) => a.rosPpg as number))),
      ours: r2(mean(ws.flatMap((w) => w.ourAdds).filter((a) => a.rosPpg != null).map((a) => a.rosPpg as number))),
    };
  });

  return {
    weeks: out,
    summary: {
      model: opts.model, weeks: out.length,
      roomAdds: roomScored.length, ourAdds: ourScored.length,
      poolMatchRate: r3(matched / Math.max(1, addsTotal)),
      roomPpg: r2(mean(roomScored.map((a) => a.rosPpg as number))),
      ourPpg: r2(mean(ourScored.map((a) => a.rosPpg as number))),
      roomTotalRos: r2(roomRos), ourTotalRos: r2(ourRos), dollars: r2(dollars),
      roomPerDollar: r3(roomRos / Math.max(1, dollars)), ourPerDollar: r3(ourRos / Math.max(1, dollars)),
      weeksWon: r3(weeksWon / Math.max(1, weeksScored)),
      bidBuckets: buckets, seasons,
    },
  };
}
