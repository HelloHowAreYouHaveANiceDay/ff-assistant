/**
 * feat_player_season_ext -- the preseason extension, anchored at <season>-09-01.
 *
 * WHAT IT ADDS to feat_player_season, and why each column is safe at that anchor:
 *
 *   draft_year / draft_round / draft_pick  the NFL draft finishes in April
 *   contract_year                          derived from (year_signed, years) at THIS season
 *   prior_snap_share                       last season's offensive snap share
 *   prior_route_share                      last season's charted pass plays / team's
 *   prior_carries_per_game, prior_carry_share, prior_air_yards_share, prior_wopr
 *   depth_rank_sep1                        the depth chart as it stood on September 1
 *   injury_status_sep1                     the last report filed on or before September 1
 *   adp / adp_as_of                        the FFC archive's preseason average
 *
 * The one column that needs care is `adp_as_of`, and the table stores it rather than assuming it:
 * two FFC archives (standard 2008 and 2009) are stamped 2010-06-20, AFTER their own seasons. A
 * consumer that wants a strictly-preseason ADP must filter on `adp_as_of <= as_of`; storing the date
 * makes that possible, and dropping it would make the leak invisible.
 *
 * THE UNIVERSE is feat_player_season's resolved rows for the season. This table extends those rows
 * sideways; inventing a different population would produce two feature tables that cannot be joined
 * without deciding which one is right.
 */
import { openDb, nowIso, type DB } from "../../db/db.js";
import { fetchCsvCached, playerWeekUrl, cacheTag, canonTeam, pick } from "../../data/nflverse.js";
import { normPos } from "../../data/stgPlayer.js";
import { buildSourceResolver, type SourceResolver } from "./resolve.js";

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const orNull = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : x);

export interface SeasonExtResult {
  seasons: number[]; rows: number; perSeason: { season: number; rows: number }[];
  /** Per-source resolution, REPORTED rather than assumed. A feed resolving at 4% and a feed with no
   *  signal produce the same column of nulls; only this number tells them apart. */
  resolution: { source: string; rows: number; resolved: number; byRule: Record<string, number> }[];
}

interface PriorUsage {
  games: number; carries: number; ays: number; wopr: number; team: string | null;
  /** His team's carries in the weeks HE played. The denominator of prior_carry_share, carried on the
   *  same object as the numerator so the two can never be computed over different weeks. */
  teamCarriesInHisWeeks: number;
}

/** Prior-season usage per player_sk, plus the TEAM carry totals the share needs. Both come from one
 *  pass over the cached player-week feed, so the numerator and the denominator can never be computed
 *  from different filters -- which is how a share ends up over 1. */
async function priorUsage(yr: number, resolver: SourceResolver): Promise<Map<number, PriorUsage>> {
  const byPlayer = new Map<number, PriorUsage>();
  let rows: Record<string, string>[];
  try { rows = await fetchCsvCached(playerWeekUrl(yr), cacheTag.playerWeek(yr)); } catch { return byPlayer; }
  // PASS ONE: the team's carries per (team, week). Per WEEK, not per season, because the denominator
  // has to be restricted to the weeks the player was actually there -- a back traded in November
  // divided by a full season of his new team's carries is not a share of anything.
  const teamWeek = new Map<string, number>();
  for (const r of rows) {
    if (pick(r, "season_type") !== "REG") continue;
    const team = canonTeam(pick(r, "team"));
    const wk = pick(r, "week");
    if (!team || !wk) continue;
    const k = `${team}|${wk}`;
    teamWeek.set(k, (teamWeek.get(k) ?? 0) + num(r.carries));
  }
  for (const r of rows) {
    if (pick(r, "season_type") !== "REG") continue;
    const team = canonTeam(pick(r, "team"));
    const name = pick(r, "player_display_name");
    if (!name) continue;
    const res = resolver.resolve({ gsis: pick(r, "player_id"), name, pos: pick(r, "position"), team });
    resolver.count("nflverse player-week", res);
    if (res.sk == null) continue;
    const u = byPlayer.get(res.sk) ?? { games: 0, carries: 0, ays: 0, wopr: 0, team: null, teamCarriesInHisWeeks: 0 };
    u.games++;
    u.carries += num(r.carries);
    u.ays += num(r.air_yards_share);
    u.wopr += num(r.wopr);
    u.teamCarriesInHisWeeks += teamWeek.get(`${team}|${pick(r, "week")}`) ?? 0;
    u.team = team || u.team;
    byPlayer.set(res.sk, u);
  }
  return byPlayer;
}

/**
 * Prior-season offensive snap share per player_sk: his offensive snaps over his team's offensive
 * PLAYS.
 *
 * THE DENOMINATOR IS THE TRAP AND IT WAS GOT WRONG ONCE HERE. Summing every player's snaps gives
 * roughly ELEVEN TIMES the team's play count -- eleven men are on the field for each one -- so the
 * share comes out an order of magnitude too small while still looking like a plausible number:
 * Christian McCaffrey's 2023 read 0.069, which is a bench player. Nothing about that is an error.
 *
 * The team's play count comes from the feed's own arithmetic instead: `offense_pct` IS
 * snaps / team plays, so `snaps / offense_pct` recovers the denominator exactly, per game. The MAX
 * over a game's rows is used because the ratio is published rounded and the largest snap count
 * carries the least rounding error.
 */
function priorSnapShare(db: DB, yr: number, resolver: SourceResolver): Map<number, number> {
  const out = new Map<number, number>();
  // The denominator is summed over THE GAMES HE APPEARED IN, not over the whole season. A player
  // traded in week 10 must not be divided by a full season of his new team's plays, and the
  // per-team-shares-added version of this is what put a share of 1.3 on a traded receiver.
  const rows = db.prepare(
    `SELECT sc.pfr_player_id, sc.player, sc.position, sc.team,
            SUM(sc.offense_snaps) snaps, SUM(tp.plays) plays
     FROM raw_snap_count sc
     JOIN (SELECT season, game_id, team, MAX(offense_snaps / offense_pct) plays
             FROM raw_snap_count
             WHERE season = ? AND game_type = 'REG' AND offense_pct > 0 AND offense_snaps > 0
             GROUP BY season, game_id, team) tp
       ON tp.season = sc.season AND tp.game_id = sc.game_id AND tp.team = sc.team
     WHERE sc.season = ? AND sc.game_type = 'REG'
     GROUP BY sc.pfr_player_id`,
  ).all(yr, yr) as { pfr_player_id: string; player: string; position: string; team: string; snaps: number; plays: number }[];
  for (const r of rows) {
    const res = resolver.resolve({ pfr: r.pfr_player_id, name: r.player, pos: r.position, team: r.team });
    resolver.count("nflverse snap counts", res);
    if (res.sk == null || !r.plays) continue;
    out.set(res.sk, (r.snaps ?? 0) / r.plays);
  }
  return out;
}

/**
 * Prior-season route share: his charted pass plays over his teams', SUMMED SEPARATELY and divided
 * once.
 *
 * The obvious version -- group by (player, team) and add the per-team shares -- is wrong for a
 * traded player and produced 26 rows above 1.0 (one man with 0.7 of one offence and 0.6 of another
 * reads as 1.3 of a passing game). Summing the numerators and the denominators over the SAME set of
 * weeks he actually appeared in is bounded by construction.
 */
function priorRouteShare(db: DB, yr: number, resolver: SourceResolver): Map<number, number> {
  const out = new Map<number, number>();
  const rows = db.prepare(
    `SELECT gsis_id, SUM(pass_plays) p, SUM(team_pass_plays) t
     FROM raw_participation WHERE season = ? GROUP BY gsis_id`,
  ).all(yr) as { gsis_id: string; p: number; t: number }[];
  for (const r of rows) {
    if (!r.t) continue;
    const res = resolver.resolve({ gsis: r.gsis_id });
    resolver.count("nflverse participation", res);
    if (res.sk == null) continue;
    out.set(res.sk, r.p / r.t);
  }
  return out;
}

/** The contract in force during `yr`, and whether `yr` is its last season. NULL where we have no
 *  contract at all, which is not the same as a zero. */
function contracts(db: DB, yr: number, resolver: SourceResolver): Map<number, { flag: number; signed: number; years: number; apy: number | null }> {
  const out = new Map<number, { flag: number; signed: number; years: number; apy: number | null }>();
  const rows = db.prepare(
    `SELECT player, position, team, year_signed, years, apy FROM raw_contract
     WHERE year_signed IS NOT NULL AND years IS NOT NULL AND years > 0
       AND year_signed <= ? AND year_signed + years > ?`,
  ).all(yr, yr) as { player: string; position: string; team: string | null; year_signed: number; years: number; apy: number | null }[];
  for (const r of rows) {
    // No gsis in this feed. (name, position, team) is the strongest thing it offers the resolver.
    const res = resolver.resolve({ name: r.player, pos: r.position, team: r.team });
    resolver.count("otc contracts", res);
    if (res.sk == null) continue;
    const last = Math.floor(r.year_signed + r.years - 1);
    const cur = { flag: yr >= last ? 1 : 0, signed: r.year_signed, years: r.years, apy: r.apy };
    const prev = out.get(res.sk);
    // Where two deals overlap (an extension signed over a running contract), the LATER signing is
    // the one in force. Picking either arbitrarily would make the flag depend on row order.
    if (!prev || r.year_signed > prev.signed) out.set(res.sk, cur);
  }
  return out;
}

/** The depth chart as it stood on September 1: the weekly feed's week 1 row, or the latest daily
 *  snapshot dated on or before September 1. Never a later one -- that is the whole anchor. */
function depthAtSep1(db: DB, yr: number, resolver: SourceResolver): Map<number, number> {
  const out = new Map<number, number>();
  const asOf = `${yr}-09-01`;
  const rows = db.prepare(
    `SELECT gsis_id, espn_id, full_name, position, team, depth_rank, as_of, source_schema
     FROM raw_depth_chart
     WHERE season = ? AND depth_rank IS NOT NULL
       AND ((source_schema = 'weekly' AND week = 1) OR (source_schema = 'daily' AND as_of <= ?))
     ORDER BY as_of`,
  ).all(yr, asOf) as { gsis_id: string | null; espn_id: string | null; full_name: string | null; position: string; team: string; depth_rank: number; as_of: string | null; source_schema: string }[];
  for (const r of rows) {
    const res = resolver.resolve({ gsis: r.gsis_id, espn: r.espn_id, name: r.full_name, pos: r.position, team: r.team });
    resolver.count("nflverse depth charts", res);
    if (res.sk == null) continue;
    // ORDER BY as_of means the LAST write wins, i.e. the most recent snapshot at or before the
    // anchor. For the weekly feed every row is week 1 and the minimum rank is the meaningful one.
    const prev = out.get(res.sk);
    out.set(res.sk, r.source_schema === "weekly" && prev != null ? Math.min(prev, r.depth_rank) : r.depth_rank);
  }
  return out;
}

/** The last injury report filed ON OR BEFORE September 1. Where the feed publishes no report date
 *  (2025+) there is nothing that can be dated to the anchor, so the column stays NULL rather than
 *  borrowing week 1's report -- which would be a week of the future. */
function injuryAtSep1(db: DB, yr: number, resolver: SourceResolver): Map<number, string> {
  const out = new Map<number, string>();
  const rows = db.prepare(
    `SELECT gsis_id, full_name, position, team, report_status, as_of FROM raw_injury
     WHERE season = ? AND as_of IS NOT NULL AND as_of <= ? AND report_status IS NOT NULL
     ORDER BY as_of`,
  ).all(yr, `${yr}-09-01`) as { gsis_id: string | null; full_name: string | null; position: string; team: string; report_status: string; as_of: string }[];
  for (const r of rows) {
    const res = resolver.resolve({ gsis: r.gsis_id, name: r.full_name, pos: r.position, team: r.team });
    resolver.count("nflverse injuries", res);
    if (res.sk == null) continue;
    out.set(res.sk, r.report_status);            // ordered by date: the last one on or before wins
  }
  return out;
}

/** Preseason ADP from the FFC archive, preferring the format closest to this league. */
function adpFor(db: DB, yr: number, formats: string[], resolver: SourceResolver): Map<number, { adp: number; format: string; asOf: string | null; sd: number | null }> {
  const out = new Map<number, { adp: number; format: string; asOf: string | null; sd: number | null }>();
  // Reverse preference order so the most-preferred format is written LAST and wins.
  for (const format of formats.slice().reverse()) {
    const rows = db.prepare(
      "SELECT name, position, team, adp, stdev, as_of FROM raw_adp_history WHERE season = ? AND format = ?",
    ).all(yr, format) as { name: string; position: string; team: string; adp: number; stdev: number | null; as_of: string | null }[];
    for (const r of rows) {
      const res = resolver.resolve({ name: r.name, pos: r.position, team: canonTeam(r.team ?? "") });
      resolver.count("ffc adp", res);
      if (res.sk == null || r.adp == null) continue;
      out.set(res.sk, { adp: r.adp, format, asOf: r.as_of, sd: r.stdev });
    }
  }
  return out;
}

export async function buildSeasonExt(opts: { dbPath?: string; seasons: number[]; adpFormats?: string[] }): Promise<SeasonExtResult> {
  const db = openDb(opts.dbPath);
  const resolver = buildSourceResolver(db);
  const now = nowIso();
  const formats = opts.adpFormats ?? ["half-ppr", "ppr", "standard"];

  const ins = db.prepare(
    `INSERT INTO feat_player_season_ext (player_sk, season, as_of, team, pos, draft_year, draft_round,
       draft_pick, contract_year, contract_year_signed, contract_years, contract_apy,
       prior_snap_share, prior_route_share, prior_carries_per_game, prior_carry_share,
       prior_air_yards_share, prior_wopr, depth_rank_sep1, injury_status_sep1, adp, adp_format,
       adp_as_of, adp_stdev, resolved_by, updated_at)
     VALUES (@sk,@season,@asOf,@team,@pos,@dy,@dr,@dp,@cy,@cys,@cyy,@capy,@snap,@route,@cpg,@cshare,
       @ays,@wopr,@depth,@inj,@adp,@adpFmt,@adpAsOf,@adpSd,@by,@now)
     ON CONFLICT(season, player_sk) DO UPDATE SET
       as_of=excluded.as_of, team=excluded.team, pos=excluded.pos, draft_year=excluded.draft_year,
       draft_round=excluded.draft_round, draft_pick=excluded.draft_pick,
       contract_year=excluded.contract_year, contract_year_signed=excluded.contract_year_signed,
       contract_years=excluded.contract_years, contract_apy=excluded.contract_apy,
       prior_snap_share=excluded.prior_snap_share, prior_route_share=excluded.prior_route_share,
       prior_carries_per_game=excluded.prior_carries_per_game, prior_carry_share=excluded.prior_carry_share,
       prior_air_yards_share=excluded.prior_air_yards_share, prior_wopr=excluded.prior_wopr,
       depth_rank_sep1=excluded.depth_rank_sep1, injury_status_sep1=excluded.injury_status_sep1,
       adp=excluded.adp, adp_format=excluded.adp_format, adp_as_of=excluded.adp_as_of,
       adp_stdev=excluded.adp_stdev, resolved_by=excluded.resolved_by, updated_at=excluded.updated_at`,
  );

  // The NFL draft, by surrogate key, from raw rather than re-fetched.
  const draft = new Map<number, { year: number; round: number; pick: number }>();
  for (const r of db.prepare(
    "SELECT season, round, pick, gsis_id, pfr_player_name, position, team FROM raw_nfl_draft_pick ORDER BY season, round, pick",
  ).all() as { season: number; round: number; pick: number; gsis_id: string | null; pfr_player_name: string | null; position: string; team: string }[]) {
    const res = resolver.resolve({
      // The feed's gsis is a legacy PFR-style token for old drafts and a real gsis for modern ones.
      gsis: /^\d\d-\d+$/.test(r.gsis_id ?? "") ? r.gsis_id : null,
      name: r.pfr_player_name, pos: r.position, team: r.team,
    });
    resolver.count("nflverse draft picks", res);
    if (res.sk == null || draft.has(res.sk)) continue;   // earliest draft row wins; nobody is drafted twice
    draft.set(res.sk, { year: r.season, round: r.round, pick: r.pick });
  }

  const res: SeasonExtResult = { seasons: [], rows: 0, perSeason: [], resolution: [] };
  for (const yr of opts.seasons.slice().sort((a, b) => a - b)) {
    const universe = db.prepare(
      "SELECT player_sk, pos, team FROM feat_player_season WHERE season = ? AND player_sk IS NOT NULL",
    ).all(yr) as { player_sk: string; pos: string; team: string | null }[];
    if (!universe.length) continue;

    const usage = await priorUsage(yr - 1, resolver);
    const snap = priorSnapShare(db, yr - 1, resolver);
    const route = priorRouteShare(db, yr - 1, resolver);
    const contract = contracts(db, yr, resolver);
    const depth = depthAtSep1(db, yr, resolver);
    const injury = injuryAtSep1(db, yr, resolver);
    const adp = adpFor(db, yr, formats, resolver);
    const asOf = `${yr}-09-01`;

    let n = 0;
    db.transaction(() => {
      for (const u of universe) {
        // feat_player_season stores player_sk as TEXT (it also holds synthetic DST keys). Only the
        // numeric ones are people, and only people have draft picks, contracts and snap counts.
        const sk = Number(u.player_sk);
        if (!Number.isInteger(sk)) continue;
        const pu = usage.get(sk);
        const g = pu?.games ?? 0;
        const tc = pu?.teamCarriesInHisWeeks ?? 0;
        const d = draft.get(sk);
        const c = contract.get(sk);
        const a = adp.get(sk);
        ins.run({
          sk, season: yr, asOf, team: u.team ?? pu?.team ?? null, pos: normPos(u.pos ?? ""),
          dy: d?.year ?? null, dr: d?.round ?? null, dp: d?.pick ?? null,
          cy: c ? c.flag : null, cys: c?.signed ?? null, cyy: c?.years ?? null, capy: c?.apy ?? null,
          snap: orNull(snap.get(sk) ?? null), route: orNull(route.get(sk) ?? null),
          cpg: g ? pu!.carries / g : null,
          cshare: tc ? (pu!.carries) / tc : null,
          ays: g ? pu!.ays / g : null, wopr: g ? pu!.wopr / g : null,
          depth: depth.get(sk) ?? null, inj: injury.get(sk) ?? null,
          adp: a?.adp ?? null, adpFmt: a?.format ?? null, adpAsOf: a?.asOf ?? null, adpSd: a?.sd ?? null,
          by: "player_sk from feat_player_season", now,
        });
        n++;
      }
    })();
    res.seasons.push(yr); res.rows += n; res.perSeason.push({ season: yr, rows: n });
  }
  res.resolution = resolver.stats();
  db.close();
  return res;
}
