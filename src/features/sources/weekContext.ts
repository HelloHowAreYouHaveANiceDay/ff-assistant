/**
 * feat_player_week_context -- what was knowable about a player's week before it was played.
 *
 * THE INVARIANT, and it is the only thing that makes this table worth having: every column comes
 * from information dated strictly before this team's kickoff that week. `as_of` is the day before
 * that kickoff, and the two columns that CANNOT satisfy the rule -- the observed temperature and
 * wind -- carry `_observed` in their names so that a model using them as a predictor is visible in
 * the query rather than hidden behind a column called `temp`.
 *
 * The injury report is read at TWO points, Wednesday and Friday, because they are different
 * information: a player limited on Wednesday and full on Friday is a different bet from one who
 * never practised, and a single "status" column collapses that. Both are `<= that day`, so a
 * Saturday downgrade is correctly absent from the Friday column.
 *
 * `teammates_out` is the column this table exists for more than any other: a receiver whose two
 * team-mates are Out has a workload nothing in a season-long projection can see. It counts the
 * SAME TEAM, SAME POSITION players listed Out on the Friday report, excluding himself.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything derived from the week's own result. `pts` lives in
 * feat_player_week, which this table joins onto by (season, week, player_sk).
 */
import { openDb, nowIso, type DB } from "../../db/db.js";
import { normPos } from "../../data/stgPlayer.js";
import { buildSourceResolver, type SourceResolver } from "./resolve.js";

export interface WeekContextResult {
  seasons: number[]; rows: number;
  perSeason: { season: number; rows: number; withSnap: number; withRoute: number; withReport: number; withDepth: number }[];
  resolution: { source: string; rows: number; resolved: number; byRule: Record<string, number> }[];
}

const shiftDays = (iso: string, days: number): string => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + days * 864e5).toISOString().slice(0, 10) : iso;
};

interface Game { opponent: string; home: number; spread: number | null; total: number | null; implied: number | null; temp: number | null; wind: number | null; roof: string | null; rest: number | null; gameday: string | null }

/** (season|team|week) -> that team's game, from ITS side. Read from raw_nfl_game so the sign
 *  convention and the rest-days column live in one place. */
function schedule(db: DB, seasons: number[]): Map<string, Game> {
  const out = new Map<string, Game>();
  const qs = seasons.map(() => "?").join(",");
  for (const g of db.prepare(
    `SELECT season, week, home_team, away_team, spread_line, total_line, temp, wind, roof,
            home_rest, away_rest, gameday
     FROM raw_nfl_game WHERE game_type = 'REG' AND season IN (${qs})`,
  ).all(...seasons) as Record<string, string | number | null>[]) {
    const season = Number(g.season), week = Number(g.week);
    const home = String(g.home_team ?? ""), away = String(g.away_team ?? "");
    if (!home || !away || !week) continue;
    const sp = g.spread_line == null ? null : Number(g.spread_line);
    const tl = g.total_line == null ? null : Number(g.total_line);
    const half = tl == null ? null : tl / 2;
    const temp = g.temp == null ? null : Number(g.temp);
    const wind = g.wind == null ? null : Number(g.wind);
    const roof = g.roof == null ? null : String(g.roof);
    const day = g.gameday == null ? null : String(g.gameday);
    // nflverse publishes spread_line from the HOME team's point of view (positive = home favoured).
    out.set(`${season}|${home}|${week}`, {
      opponent: away, home: 1, spread: sp, total: tl,
      implied: half != null && sp != null ? half + sp / 2 : null,
      temp, wind, roof, rest: g.home_rest == null ? null : Number(g.home_rest), gameday: day,
    });
    out.set(`${season}|${away}|${week}`, {
      opponent: home, home: 0, spread: sp == null ? null : -sp, total: tl,
      implied: half != null && sp != null ? half - sp / 2 : null,
      temp, wind, roof, rest: g.away_rest == null ? null : Number(g.away_rest), gameday: day,
    });
  }
  return out;
}

/** (week|player_sk) -> the most recent PRIOR week's offensive snap share. */
function priorWeekSnap(db: DB, season: number, resolver: SourceResolver, maxWeek: number): Map<string, number> {
  const bySkWeek = new Map<number, Map<number, number>>();
  for (const r of db.prepare(
    `SELECT week, pfr_player_id, player, position, team, offense_pct FROM raw_snap_count
     WHERE season = ? AND game_type = 'REG' AND offense_pct IS NOT NULL`,
  ).all(season) as { week: number; pfr_player_id: string; player: string; position: string; team: string; offense_pct: number }[]) {
    const res = resolver.resolve({ pfr: r.pfr_player_id, name: r.player, pos: r.position, team: r.team });
    resolver.count("nflverse snap counts", res);
    if (res.sk == null) continue;
    (bySkWeek.get(res.sk) ?? bySkWeek.set(res.sk, new Map()).get(res.sk)!).set(r.week, r.offense_pct);
  }
  // Carry forward: week W's feature is the last week the player actually played BEFORE W.
  const out = new Map<string, number>();
  for (const [sk, weeks] of bySkWeek) {
    let last: number | null = null;
    for (let w = 1; w <= maxWeek; w++) {
      if (last != null) out.set(`${w}|${sk}`, last);
      const v = weeks.get(w);
      if (v != null) last = v;
    }
  }
  return out;
}

/** (week|player_sk) -> the most recent PRIOR week's charted route share. Same carry-forward rule. */
function priorWeekRoute(db: DB, season: number, resolver: SourceResolver, maxWeek: number): Map<string, number> {
  const bySkWeek = new Map<number, Map<number, number>>();
  for (const r of db.prepare(
    "SELECT week, gsis_id, pass_plays, team_pass_plays FROM raw_participation WHERE season = ? AND team_pass_plays > 0",
  ).all(season) as { week: number; gsis_id: string; pass_plays: number; team_pass_plays: number }[]) {
    const res = resolver.resolve({ gsis: r.gsis_id });
    resolver.count("nflverse participation", res);
    if (res.sk == null) continue;
    (bySkWeek.get(res.sk) ?? bySkWeek.set(res.sk, new Map()).get(res.sk)!).set(r.week, r.pass_plays / r.team_pass_plays);
  }
  const out = new Map<string, number>();
  for (const [sk, weeks] of bySkWeek) {
    let last: number | null = null;
    for (let w = 1; w <= maxWeek; w++) {
      if (last != null) out.set(`${w}|${sk}`, last);
      const v = weeks.get(w);
      if (v != null) last = v;
    }
  }
  return out;
}

interface Report { status: string | null; practice: string | null; team: string; pos: string; asOf: string }

/** All injury rows for the season that carry a date, by (week, player_sk). A week can hold several
 *  -- Wednesday and Friday filings -- and the caller picks the latest one at or before each cutoff.
 *  Rows WITHOUT a date are excluded entirely: from 2025 the feed stopped publishing one, and an
 *  undated report cannot be placed on either side of a cutoff. */
function reports(db: DB, season: number, resolver: SourceResolver): Map<string, Report[]> {
  const out = new Map<string, Report[]>();
  for (const r of db.prepare(
    `SELECT week, gsis_id, full_name, position, team, report_status, practice_status, as_of
     FROM raw_injury WHERE season = ? AND as_of IS NOT NULL ORDER BY as_of`,
  ).all(season) as { week: number; gsis_id: string | null; full_name: string | null; position: string; team: string; report_status: string | null; practice_status: string | null; as_of: string }[]) {
    const res = resolver.resolve({ gsis: r.gsis_id, name: r.full_name, pos: r.position, team: r.team });
    resolver.count("nflverse injuries", res);
    if (res.sk == null) continue;
    const k = `${r.week}|${res.sk}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push({
      status: r.report_status, practice: r.practice_status, team: r.team,
      pos: normPos(r.position ?? ""), asOf: r.as_of,
    });
  }
  return out;
}

/** The latest report at or before `cutoff`, or null. */
function at(list: Report[] | undefined, cutoff: string): Report | null {
  if (!list) return null;
  let best: Report | null = null;
  for (const r of list) if (r.asOf <= cutoff && (!best || r.asOf > best.asOf)) best = r;
  return best;
}

/** (week|team|pos) -> how many players were listed Out on the Friday report. Built from the same
 *  rows the per-player columns come from, so the count and the status can never disagree. */
function outCounts(reps: Map<string, Report[]>, cutoffOf: (week: number, team: string) => string | null): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [k, list] of reps) {
    const [wk, skStr] = k.split("|");
    const week = Number(wk), sk = Number(skStr);
    const team = list[0].team;
    const cutoff = cutoffOf(week, team);
    if (!cutoff) continue;
    const r = at(list, cutoff);
    if (!r || r.status !== "Out") continue;
    const key = `${week}|${r.team}|${r.pos}`;
    (out.get(key) ?? out.set(key, new Set()).get(key)!).add(sk);
  }
  return out;
}

/** (week|player_sk) -> depth rank knowable that week. Weekly feed: that week's row. Daily feed: the
 *  latest snapshot at or before the week's as_of. */
function depthByWeek(db: DB, season: number, resolver: SourceResolver, asOfOf: (week: number, team: string) => string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare(
    `SELECT week, as_of, source_schema, gsis_id, espn_id, full_name, position, team, depth_rank
     FROM raw_depth_chart WHERE season = ? AND depth_rank IS NOT NULL ORDER BY as_of`,
  ).all(season) as { week: number; as_of: string | null; source_schema: string; gsis_id: string | null; espn_id: string | null; full_name: string | null; position: string; team: string; depth_rank: number }[]) {
    const res = resolver.resolve({ gsis: r.gsis_id, espn: r.espn_id, name: r.full_name, pos: r.position, team: r.team });
    resolver.count("nflverse depth charts", res);
    if (res.sk == null) continue;
    if (r.source_schema === "weekly") {
      const k = `${r.week}|${res.sk}`;
      const prev = out.get(k);
      out.set(k, prev == null ? r.depth_rank : Math.min(prev, r.depth_rank));
    } else {
      // A dated snapshot belongs to every week whose as_of it precedes; the ORDER BY makes the
      // latest qualifying snapshot the last write. Weeks are bounded by the schedule, so this walks
      // only the weeks the team actually has.
      for (let w = 1; w <= 22; w++) {
        const cut = asOfOf(w, r.team);
        if (!cut || !r.as_of || r.as_of > cut) continue;
        out.set(`${w}|${res.sk}`, r.depth_rank);
      }
    }
  }
  return out;
}

export function buildWeekContext(opts: { dbPath?: string; seasons: number[] }): WeekContextResult {
  const db = openDb(opts.dbPath);
  const resolver = buildSourceResolver(db);
  const now = nowIso();
  const seasons = opts.seasons.slice().sort((a, b) => a - b);
  const sched = schedule(db, seasons);

  const ins = db.prepare(
    `INSERT INTO feat_player_week_context (player_sk, season, week, as_of, team, pos, opponent, home,
       days_rest, roof, spread_line, total_line, implied_team_total, temp_observed, wind_observed,
       prior_snap_share, prior_route_share, report_status_wed, report_status_fri,
       practice_status_wed, practice_status_fri, teammates_out, depth_rank, updated_at)
     VALUES (@sk,@season,@week,@asOf,@team,@pos,@opp,@home,@rest,@roof,@spread,@total,@implied,
       @temp,@wind,@snap,@route,@rsw,@rsf,@psw,@psf,@out,@depth,@now)
     ON CONFLICT(season, week, player_sk) DO UPDATE SET
       as_of=excluded.as_of, team=excluded.team, pos=excluded.pos, opponent=excluded.opponent,
       home=excluded.home, days_rest=excluded.days_rest, roof=excluded.roof,
       spread_line=excluded.spread_line, total_line=excluded.total_line,
       implied_team_total=excluded.implied_team_total, temp_observed=excluded.temp_observed,
       wind_observed=excluded.wind_observed, prior_snap_share=excluded.prior_snap_share,
       prior_route_share=excluded.prior_route_share, report_status_wed=excluded.report_status_wed,
       report_status_fri=excluded.report_status_fri, practice_status_wed=excluded.practice_status_wed,
       practice_status_fri=excluded.practice_status_fri, teammates_out=excluded.teammates_out,
       depth_rank=excluded.depth_rank, updated_at=excluded.updated_at`,
  );

  const res: WeekContextResult = { seasons: [], rows: 0, perSeason: [], resolution: [] };

  for (const season of seasons) {
    const universe = db.prepare(
      `SELECT week, player_sk, pos, team FROM feat_player_week
       WHERE season = ? AND player_sk IS NOT NULL AND is_bye = 0`,
    ).all(season) as { week: number; player_sk: string; pos: string; team: string }[];
    if (!universe.length) continue;
    const maxWeek = Math.max(...universe.map((u) => u.week));

    const gamedayOf = (week: number, team: string): string | null => sched.get(`${season}|${team}|${week}`)?.gameday ?? null;
    // The week's anchors, all relative to THIS TEAM's own kickoff: as_of the day before, the Friday
    // report two days before, the Wednesday report four days before. Anchoring on the team's game
    // rather than on the week's first game is what makes a Thursday-night player's Friday report
    // correctly unavailable.
    const asOfOf = (week: number, team: string) => { const d = gamedayOf(week, team); return d ? shiftDays(d, -1) : null; };
    const friOf = (week: number, team: string) => { const d = gamedayOf(week, team); return d ? shiftDays(d, -2) : null; };
    const wedOf = (week: number, team: string) => { const d = gamedayOf(week, team); return d ? shiftDays(d, -4) : null; };

    const snap = priorWeekSnap(db, season, resolver, maxWeek);
    const route = priorWeekRoute(db, season, resolver, maxWeek);
    const reps = reports(db, season, resolver);
    const outs = outCounts(reps, friOf);
    const depth = depthByWeek(db, season, resolver, asOfOf);

    let n = 0, withSnap = 0, withRoute = 0, withReport = 0, withDepth = 0;
    db.transaction(() => {
      for (const u of universe) {
        const sk = Number(u.player_sk);
        if (!Number.isInteger(sk)) continue;          // synthetic DST keys are not people
        const team = u.team;
        const g = sched.get(`${season}|${team}|${u.week}`);
        const asOf = asOfOf(u.week, team);
        const fri = friOf(u.week, team);
        const wed = wedOf(u.week, team);
        const list = reps.get(`${u.week}|${sk}`);
        const rFri = fri ? at(list, fri) : null;
        const rWed = wed ? at(list, wed) : null;
        const pos = normPos(u.pos ?? "");
        // Same team, same position, listed Out on Friday -- excluding himself, which is why the
        // count is over a SET of surrogate keys rather than an integer accumulated as we go.
        const outSet = outs.get(`${u.week}|${team}|${pos}`);
        const mates = outSet ? outSet.size - (outSet.has(sk) ? 1 : 0) : 0;
        const sSnap = snap.get(`${u.week}|${sk}`) ?? null;
        const sRoute = route.get(`${u.week}|${sk}`) ?? null;
        const sDepth = depth.get(`${u.week}|${sk}`) ?? null;
        ins.run({
          sk, season, week: u.week, asOf, team, pos,
          opp: g?.opponent ?? null, home: g ? g.home : null, rest: g?.rest ?? null, roof: g?.roof ?? null,
          spread: g?.spread ?? null, total: g?.total ?? null, implied: g?.implied ?? null,
          temp: g?.temp ?? null, wind: g?.wind ?? null,
          snap: sSnap, route: sRoute,
          rsw: rWed?.status ?? null, rsf: rFri?.status ?? null,
          psw: rWed?.practice ?? null, psf: rFri?.practice ?? null,
          out: mates, depth: sDepth, now,
        });
        n++;
        if (sSnap != null) withSnap++;
        if (sRoute != null) withRoute++;
        if (rFri?.status) withReport++;
        if (sDepth != null) withDepth++;
      }
    })();
    res.seasons.push(season); res.rows += n;
    res.perSeason.push({ season, rows: n, withSnap, withRoute, withReport, withDepth });
  }
  res.resolution = resolver.stats();
  db.close();
  return res;
}
