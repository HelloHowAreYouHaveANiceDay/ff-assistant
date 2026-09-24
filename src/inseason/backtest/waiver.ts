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
import { loadWeekContext, loadModel, type ModelName, type WeekModel } from "./context.js";
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
  /** Best-K by REALISED ros ppg from the same pool -- the hindsight ceiling nobody could hit.
   *  NULL where no pool member has a realised line. POSITION-BLIND: see roomCeilAtMix. */
  ceilingPpg: number | null;
  /** The ceiling rebuilt to each side's OWN positional composition that week, so capture cannot
   *  be raised by drifting toward quarterbacks. The comparable one. */
  roomCeilAtMix: number | null;
  ourCeilAtMix: number | null;
  /** The positions that ceiling is made of, so a ceiling built entirely of quarterbacks is visible
   *  rather than inferred (see the mix decomposition -- raw ppg is position-blind). */
  ceilingByPos: string[];
  roomAdds: AddRow[];
  ourAdds: { playerSk: string; name: string; pos: string; proj: number; rosPpg: number | null; rosPts: number | null }[];
  dollars: number;
}

export interface WaiverSummary {
  model: ModelName;
  weeks: number; roomAdds: number; ourAdds: number; poolMatchRate: number;
  roomPpg: number; ourPpg: number;
  roomTotalRos: number; ourTotalRos: number; dollars: number;
  /**
   * THE HINDSIGHT CEILING and what each side left on the table against it. `ourPpg` and `roomPpg`
   * alone are a relative benchmark -- better or worse than the room -- which says nothing about how
   * much of the available value anybody captured. This is the waiver equivalent of the lineup
   * backtest's "hindsight optimum / bench left".
   */
  ceilingPpg: number;
  ourLeft: number;
  roomLeft: number;
  /** Share of the ceiling captured, 0-1. The comparable-across-seasons form of `left`. */
  ourCapture: number;
  roomCapture: number;
  /** Capture against each side's MIX-MATCHED ceiling. The plain capture above is position-blind
   *  and an arm can raise it by taking quarterbacks; these cannot be gamed that way. */
  ourCaptureAtMix: number;
  roomCaptureAtMix: number;
  /**
   * POSITIONAL MIX. `ourPpg` and `roomPpg` are position-BLIND, so an arm that takes more
   * quarterbacks scores higher without picking better. `mixOnly` is what this arm's positional
   * SHARES alone predict; `skill` is raw minus mix and is the only cross-arm comparable number
   * here. A 2026-09-23 result was retracted for missing exactly this.
   */
  mix: {
    ratePpg: { pos: string; ppg: number }[];
    ours: { byPos: { pos: string; n: number; share: number }[]; mixOnly: number; skill: number };
    room: { byPos: { pos: string; n: number; share: number }[]; mixOnly: number; skill: number };
  };
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
  db: DB, leagueId: string,
  opts: {
    seasons: number[]; model: ModelName; poolMinLine?: number;
    /** OPTIONAL EXPERIMENT SEAM: score the ranking on a pre-loaded artifact instead of the one
     *  `model` names on disk. `model` still labels the run. Used by the horizon experiment to feed a
     *  matchup-neutral (dvp-zeroed) copy of the challenger without adding a ModelName or a data file.
     *  Nothing in the shipped path passes it, so the default behaviour is byte-identical. */
    artifactOverride?: WeekModel;
    /**
     * OPTIONAL RANKING SEAM. Replaces the week-w projection as the sort key, and NOTHING else --
     * the pool, the choice set, the scoring window and the top-K size are untouched, so a difference
     * in the result is attributable to the ranking alone. Returning `null` falls back to the
     * projection for that player, which is what a model with a missing feature row must do rather
     * than rank him at zero.
     *
     * It exists because the waiver screens (docs/validation.md, 2026-09-23) admitted in-season USAGE
     * at WR and the expert consensus at WR/QB as better POOL RANKINGS than the season line, and a
     * ranking that never reaches a decision harness is a statistic, not an edge. Absent, this
     * function is byte-identical to the shipped behaviour.
     */
    ranker?: (p: { player_sk: string; pos: string }, season: number, week: number, proj: number) => number | null;
  },
): { weeks: WaiverWeek[]; summary: WaiverSummary } {
  const artifact = opts.artifactOverride ?? loadModel(opts.model);
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
        `SELECT player_sk, name, pos FROM fact_fa_pool_week WHERE league_id=? AND season=? AND week=?`,
      ).all(leagueId, season, Math.max(1, week - 1)) as { player_sk: string; name: string; pos: string }[];
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
          `SELECT player_sk, name, pos FROM fact_roster_week WHERE league_id=? AND season=? AND espn_player_id=? LIMIT 1`,
        ).get(leagueId, season, a.eid) as { player_sk: string; name: string; pos: string } | undefined;
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
        // The SORT KEY may be overridden; the projection itself is still what gets reported, so the
        // `proj` column keeps meaning the same thing across arms.
        .map((x) => ({ ...x, key: opts.ranker?.(x.p, season, week, x.proj as number) ?? (x.proj as number) }))
        .sort((a, b) => b.key - a.key)
        .slice(0, resolved.length);

      /**
       * THE HINDSIGHT CEILING -- the same thing `optimalLineup` is to the lineup backtest, and it
       * was missing here.
       *
       * Without it this harness can only say "better or worse than the room", which is a RELATIVE
       * benchmark: it flatters you when the opposition is bad and damns you when they are good, and
       * either way it never answers "how much of what was actually there did we get". The lineup
       * backtest has had the right shape all along -- manager, hindsight optimum, tool -- and reports
       * points LEFT ON THE BENCH. This is that denominator for waivers.
       *
       * It is the best K by REALISED rest-of-season points per game out of the SAME pool the room
       * and we both chose from, K being the number of adds the room actually made that week. Nobody
       * could have picked it: it uses the answer sheet. That is the point of a ceiling.
       *
       * Only pool members with a realised line are eligible -- a man with no remaining weekly rows
       * has no outcome to rank on, and scoring him as zero would let the ceiling be dragged down by
       * players the label cannot see rather than by anything about the decision.
       */
      const realisedPool = pool
        .map((p) => ({ p, f: rosFrom(p.player_sk) }))
        .filter((x) => x.f.ros_games > 0)
        .map((x) => ({ playerSk: x.p.player_sk, pos: x.p.pos, ppg: x.f.ros_pts / x.f.ros_games }))
        .sort((a, b) => b.ppg - a.ppg);
      const ceilingPicks = realisedPool.slice(0, resolved.length);

      /**
       * THE MIX-MATCHED CEILING, and the plain one above is NOT ENOUGH WITHOUT IT.
       *
       * The unconstrained ceiling takes the best K by realised points regardless of position, and
       * because quarterbacks realise far more than anyone else it comes out 48.3% QB. An arm that
       * also takes quarterbacks then "captures" more of it WITHOUT PICKING BETTER -- the identical
       * defect that got a result retracted on this harness, reappearing one level up in the
       * denominator instead of the numerator.
       *
       * So each side also gets a ceiling built to ITS OWN positional composition that week: if an
       * arm took 2 RB and 1 TE, its mix-matched ceiling is the best 2 RB and best 1 TE in the pool.
       * Capture against THAT asks the only fair question -- given the positions you chose to take,
       * how close to the best available did you get -- and a side cannot raise it by drifting
       * toward quarterbacks.
       */
      const ceilAtMix = (picks: { pos: string }[]): number | null => {
        const want = new Map<string, number>();
        for (const p of picks) want.set(p.pos, (want.get(p.pos) ?? 0) + 1);
        const got: number[] = [];
        for (const [pos, k] of want) {
          const best = realisedPool.filter((x) => x.pos === pos).slice(0, k);
          for (const b of best) got.push(b.ppg);
        }
        return got.length ? mean(got) : null;
      };

      out.push({
        season, week, dollars: resolved.reduce((s, a) => s + a.bid, 0),
        ceilingPpg: ceilingPicks.length ? r2(mean(ceilingPicks.map((c) => c.ppg))) : null,
        ceilingByPos: ceilingPicks.map((c) => c.pos),
        roomCeilAtMix: ceilAtMix(resolved),
        ourCeilAtMix: ceilAtMix(ranked.map((x) => ({ pos: x.p.pos }))),
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

  /**
   * THE POSITIONAL-MIX DECOMPOSITION, without which THIS HARNESS'S HEADLINE IS NOT READABLE.
   *
   * `roomPpg` and `ourPpg` are RAW realised points per game, and raw points are not comparable
   * across positions: over this league's history quarterbacks realise about 11.5 a game against
   * 6.6 for backs and 5.1 for tight ends. So an arm that simply takes more quarterbacks scores
   * higher here WITHOUT PICKING BETTER, and nothing in the old summary said so.
   *
   * That is not hypothetical. On 2026-09-23 a ranking experiment on this harness reported +1.24 ppg
   * over the room and was RETRACTED: the arm took 54% quarterbacks against the room's 13%, the mix
   * ALONE accounted for 9.16 of its 8.07, and WITHIN position it was a WORSE picker than the room
   * by 1.09. The retraction's instruction was that any future ranking experiment here must report
   * this decomposition -- so it is computed here rather than left to each caller to remember.
   *
   *   mixOnly = sum over positions of (this arm's SHARE of picks at that position)
   *                                 x (realised ppg at that position)
   *   skill   = raw ppg - mixOnly
   *
   * THE PER-POSITION RATES COME FROM THE UNION OF BOTH ARMS, deliberately. Scoring each arm against
   * its own realised rates would let an arm define the benchmark it is measured by, and a ranking
   * that picks one lucky quarterback would then be credited with a high "quarterback rate" rather
   * than with luck. One common reference, both arms.
   */
  const mixOf = (rows: { pos: string; rosPpg: number | null }[], ratePpg: Map<string, number>) => {
    const n = rows.length;
    if (!n) return { mixOnly: 0, byPos: [] as { pos: string; n: number; share: number }[] };
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.pos, (counts.get(r.pos) ?? 0) + 1);
    let mixOnly = 0;
    const byPos: { pos: string; n: number; share: number }[] = [];
    for (const [pos, c] of [...counts].sort((a, b) => b[1] - a[1])) {
      const share = c / n;
      byPos.push({ pos, n: c, share: r3(share) });
      mixOnly += share * (ratePpg.get(pos) ?? 0);
    }
    return { mixOnly, byPos };
  };
  const ratePpg = new Map<string, number>();
  for (const pos of new Set([...roomScored, ...ourScored].map((a) => a.pos))) {
    const rows = [...roomScored, ...ourScored].filter((a) => a.pos === pos).map((a) => a.rosPpg as number);
    if (rows.length) ratePpg.set(pos, mean(rows));
  }
  // The ceiling is averaged over the WEEKS that produced one, not over adds: it is one number per
  // week by construction, and weighting it by add count would let a heavy-claim week speak twice.
  const ceilingWeeks = out.map((w) => w.ceilingPpg).filter((v): v is number => v != null);
  const ceiling = ceilingWeeks.length ? mean(ceilingWeeks) : 0;
  const ourCeilMixW = out.map((w) => w.ourCeilAtMix).filter((v): v is number => v != null);
  const roomCeilMixW = out.map((w) => w.roomCeilAtMix).filter((v): v is number => v != null);
  const ourCeilMix = ourCeilMixW.length ? mean(ourCeilMixW) : 0;
  const roomCeilMix = roomCeilMixW.length ? mean(roomCeilMixW) : 0;
  const ourMix = mixOf(ourScored, ratePpg);
  const roomMix = mixOf(roomScored, ratePpg);
  const ourRaw = mean(ourScored.map((a) => a.rosPpg as number));
  const roomRaw = mean(roomScored.map((a) => a.rosPpg as number));

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
      ceilingPpg: r2(ceiling),
      ourLeft: r2(ceiling - ourRaw), roomLeft: r2(ceiling - roomRaw),
      ourCapture: r3(ceiling > 0 ? ourRaw / ceiling : 0),
      roomCapture: r3(ceiling > 0 ? roomRaw / ceiling : 0),
      ourCaptureAtMix: r3(ourCeilMix > 0 ? ourRaw / ourCeilMix : 0),
      roomCaptureAtMix: r3(roomCeilMix > 0 ? roomRaw / roomCeilMix : 0),
      roomPerDollar: r3(roomRos / Math.max(1, dollars)), ourPerDollar: r3(ourRos / Math.max(1, dollars)),
      weeksWon: r3(weeksWon / Math.max(1, weeksScored)),
      bidBuckets: buckets, seasons,
      // WITHOUT THIS BLOCK ourPpg/roomPpg CANNOT BE COMPARED. See mixOf above.
      mix: {
        ratePpg: [...ratePpg].sort((a, b) => b[1] - a[1]).map(([pos, ppg]) => ({ pos, ppg: r2(ppg) })),
        ours: { byPos: ourMix.byPos, mixOnly: r2(ourMix.mixOnly), skill: r2(ourRaw - ourMix.mixOnly) },
        room: { byPos: roomMix.byPos, mixOnly: r2(roomMix.mixOnly), skill: r2(roomRaw - roomMix.mixOnly) },
      },
    },
  };
}
