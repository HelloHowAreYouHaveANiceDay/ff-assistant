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
import { normalizeStatus } from "../../inseason/copilot.js";
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
       practice_status_wed, practice_status_fri, teammates_out, depth_rank, source, updated_at)
     VALUES (@sk,@season,@week,@asOf,@team,@pos,@opp,@home,@rest,@roof,@spread,@total,@implied,
       @temp,@wind,@snap,@route,@rsw,@rsf,@psw,@psf,@out,@depth,'archive',@now)
     ON CONFLICT(season, week, player_sk) DO UPDATE SET
       as_of=excluded.as_of, team=excluded.team, pos=excluded.pos, opponent=excluded.opponent,
       home=excluded.home, days_rest=excluded.days_rest, roof=excluded.roof,
       spread_line=excluded.spread_line, total_line=excluded.total_line,
       implied_team_total=excluded.implied_team_total, temp_observed=excluded.temp_observed,
       wind_observed=excluded.wind_observed, prior_snap_share=excluded.prior_snap_share,
       prior_route_share=excluded.prior_route_share, report_status_wed=excluded.report_status_wed,
       report_status_fri=excluded.report_status_fri, practice_status_wed=excluded.practice_status_wed,
       practice_status_fri=excluded.practice_status_fri, teammates_out=excluded.teammates_out,
       depth_rank=excluded.depth_rank, source=excluded.source, updated_at=excluded.updated_at`,
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
      // REPLACE THE SEASON. See the same note in seasonExt.ts: upserting on a key that CONTAINS the
      // surrogate key cannot remove a row whose surrogate key moved, so a rekey doubles the table
      // instead of rewriting it.
      db.prepare("DELETE FROM feat_player_week_context WHERE season = ?").run(season);
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

// ==================================================================================================
// THE LIVE SEASON.
//
// `buildWeekContext` above is a HISTORICAL builder. Its injury columns come from `raw_injury`, whose
// filings are dated -- and from 2025 the feed stopped publishing a report date, so every undated row
// is dropped and every 2025 injury column reads NULL. For 2026 the table holds nothing at all: the
// season has not been archived. The consequence is precise and it is the failure this section
// exists to remove: the two-part weekly model's first stage is availability, and in the one month
// availability decides anything it would serve the live season on its declared defaults -- a model
// that knows about injuries, blind, in September.
//
// So the live season's context is assembled from the sources this repo ALREADY refreshes for the
// copilot's OUT refusal: ESPN's structured `player_status` and high-severity injury rows in `news`.
// They are the same two the lineup optimizer reads, deliberately, so a man the lineup refuses to
// start and a man the model prices as unlikely to play cannot be different men.
//
// THREE THINGS THIS IS NOT, stated because each is a way the rows could look fine and be worthless:
//
//   1. It is NOT a practice report. `player_status` carries a designation, not Wednesday and Friday
//      participation, so `practice_status_*` stay NULL and `prac_dnp` / `prac_limited` read 0. The
//      model's largest first-stage coefficients are on `inj_out` and `inj_doubtful`, which this does
//      carry; `prac_dnp` is third and is simply absent rather than guessed.
//   2. It is NOT dated per filing. A live status feed publishes a CURRENT state and one timestamp,
//      so `as_of` is the SNAPSHOT time -- when we read it -- and not when the team filed it. That is
//      weaker than the historical builder's per-filing dates and it is why the point-in-time rule
//      below is enforced on the snapshot rather than inferred from the row.
//   3. It does NOT backfill. Only the target week is written. A status read today says nothing about
//      who was out three weeks ago, and writing today's designation into a past week would
//      manufacture exactly the leakage `weekly-leak-audit.mjs` exists to catch.
//
// THE POINT-IN-TIME RULE, and it is the whole reason this has a rule rather than a week argument:
// a snapshot taken AFTER a week's first kickoff belongs to the NEXT week. Once a game has been
// played, today's injury designations are contaminated by it -- a man carted off on Thursday is
// "Out" in a feed read on Friday, and writing that into Thursday's week would let the model know an
// outcome. So the target week is the earliest whose first kickoff is still ahead of the snapshot.
// ==================================================================================================

export interface LiveWeekContextResult {
  season: number;
  /** The week the snapshot was written to, or null when the season has no week still ahead. */
  week: number | null;
  /** The snapshot time the rows were stamped with. */
  asOf: string;
  rows: number;
  /** Players carrying a designation, of `rows`. */
  withStatus: number;
  withDepth: number;
  outs: number;
  /** From the news feed rather than the structured status -- an escalation the status had not caught. */
  fromNews: number;
  /** Designations that reached no surrogate key, so no row carries them. A coverage fact, reported
   *  rather than dropped: it is the difference between "nobody is out" and "we could not tell". */
  unresolved: number;
  /** Non-null means NOTHING was written, and says why. */
  skipped: string | null;
  /** Every week whose first kickoff is already behind the snapshot, i.e. what the rule excluded. */
  kickedOff: number[];
}

export interface LiveWeekContextOpts {
  dbPath?: string;
  season: number;
  /** The snapshot time. Injectable so a test can drive the point-in-time rule without waiting for
   *  Sunday. Defaults to now. */
  now?: string;
  /** Write the rows. False measures what WOULD be written and touches nothing. */
  write?: boolean;
}

/** ESPN's designation vocabulary, mapped onto the injury REPORT vocabulary the features speak.
 *
 *  IR / PUP / NFI / suspension all become "Out", which is a judgement and is recorded as one: for
 *  the purpose of "will he play this week" they are indistinguishable from Out, and the model has no
 *  separate coefficient that could tell them apart. "Doubtful" is kept separate because the model
 *  DOES have one for it (+2.7 to +4.0 in logit, against +3.4 to +5.2 for Out) and folding it into
 *  Out would overstate the certainty of a man who sometimes plays. */
export function espnStatusToReport(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.toUpperCase() === "DOUBTFUL") return "Doubtful";
  const n = normalizeStatus(s);
  if (n === "OUT") return "Out";
  if (n === "QUESTIONABLE") return "Questionable";
  return null;
}

/**
 * Build the CURRENT season's `feat_player_week_context` rows from the live status feeds.
 *
 * The universe is `feat_player_week_model` for the target week -- everyone the forward builder has a
 * row for -- rather than the status feed, because a player with no designation is information (he is
 * not on the report) and dropping him would leave the model reading NULL for a man who is fine.
 */
export function buildLiveWeekContext(opts: LiveWeekContextOpts): LiveWeekContextResult {
  const db = openDb(opts.dbPath);
  try { return buildLiveWeekContextInto(db, opts); } finally { db.close(); }
}

export function buildLiveWeekContextInto(db: DB, opts: LiveWeekContextOpts): LiveWeekContextResult {
  const season = opts.season;
  const asOf = opts.now ?? nowIso();
  const asOfDay = asOf.slice(0, 10);
  const res: LiveWeekContextResult = {
    season, week: null, asOf, rows: 0, withStatus: 0, withDepth: 0, outs: 0, fromNews: 0,
    unresolved: 0, skipped: null, kickedOff: [],
  };

  // ---- THE TARGET WEEK, from raw_nfl_game kickoffs. ----
  const firstKickoff = new Map<number, string>();
  for (const g of db.prepare(
    "SELECT week, MIN(gameday) AS d FROM raw_nfl_game WHERE season = ? AND game_type = 'REG' AND gameday IS NOT NULL GROUP BY week",
  ).all(season) as { week: number; d: string }[]) firstKickoff.set(Number(g.week), String(g.d));
  if (!firstKickoff.size) {
    res.skipped = `raw_nfl_game holds no dated ${season} regular-season games -- run \`ff ingest-raw\` first`;
    return res;
  }
  const ordered = [...firstKickoff.entries()].sort((a, b) => a[0] - b[0]);
  res.kickedOff = ordered.filter(([, d]) => d <= asOfDay).map(([w]) => w);
  const target = ordered.find(([, d]) => d > asOfDay);
  if (!target) {
    res.skipped = `every ${season} regular-season week has kicked off as of ${asOfDay} -- there is no week ahead to write context for`;
    return res;
  }
  res.week = target[0];
  const week = target[0];

  // ---- WHO IS DESIGNATED, from the two feeds the copilot's OUT refusal reads. ----
  // Keyed by name_key, which is what `player_status.player_id` and `news.player_id` both are, then
  // resolved to the surrogate key through stg_player. A designation that cannot be resolved to a
  // player_sk is COUNTED, not silently dropped: an unresolvable name is a coverage fact.
  const skOf = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT player_sk, name_key, position FROM stg_player WHERE name_key IS NOT NULL AND COALESCE(ambiguous, 0) = 0",
  ).all() as { player_sk: number; name_key: string; position: string | null }[]) {
    if (!skOf.has(r.name_key)) skOf.set(r.name_key, r.player_sk);
  }

  interface Live { report: string | null; depth: number | null; source: string }
  const live = new Map<number, Live>();
  let unresolved = 0;
  for (const r of db.prepare(
    "SELECT player_id, injury_status, depth_order FROM player_status",
  ).all() as { player_id: string; injury_status: string | null; depth_order: number | null }[]) {
    const sk = skOf.get(r.player_id);
    if (sk == null) { if (r.injury_status) unresolved++; continue; }
    live.set(sk, { report: espnStatusToReport(r.injury_status), depth: r.depth_order ?? null, source: "player_status" });
  }
  // News ESCALATES only, exactly as `loadAvailability` does -- a high-severity injury headline can
  // rule a man out whose structured status has not refreshed, and must never clear one who already
  // is. Anything else would make the two surfaces disagree about who can play.
  for (const r of db.prepare(
    "SELECT player_id, severity FROM news WHERE category = 'injury'",
  ).all() as { player_id: string | null; severity: string | null }[]) {
    if (String(r.severity ?? "").toLowerCase() !== "high" || !r.player_id) continue;
    const sk = skOf.get(r.player_id);
    if (sk == null) { unresolved++; continue; }
    const cur = live.get(sk);
    if (cur?.report === "Out") continue;
    live.set(sk, { report: "Out", depth: cur?.depth ?? null, source: "news(injury/high)" });
    res.fromNews++;
  }

  // ---- THE UNIVERSE: the forward feature rows for the target week. ----
  const universe = db.prepare(
    `SELECT player_sk, pos, team FROM feat_player_week_model
      WHERE season = ? AND week = ? AND player_sk IS NOT NULL AND COALESCE(is_bye, 0) = 0`,
  ).all(season, week) as { player_sk: string; pos: string; team: string | null }[];
  if (!universe.length) {
    res.skipped = `feat_player_week_model has no ${season} week ${week} rows -- run \`ff build-weekly-features --forward\` first`;
    return res;
  }

  // teammates_out: same team, same position, Out, excluding himself. Built from the SAME map the
  // per-player column comes from, so the count and the status cannot disagree.
  const outsBy = new Map<string, Set<number>>();
  for (const u of universe) {
    const sk = Number(u.player_sk);
    if (!Number.isInteger(sk) || !u.team) continue;
    if (live.get(sk)?.report !== "Out") continue;
    const k = `${u.team}|${normPos(u.pos ?? "")}`;
    (outsBy.get(k) ?? outsBy.set(k, new Set()).get(k)!).add(sk);
  }

  const sched = schedule(db, [season]);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO feat_player_week_context (player_sk, season, week, as_of, team, pos, opponent, home,
       days_rest, roof, spread_line, total_line, implied_team_total, temp_observed, wind_observed,
       prior_snap_share, prior_route_share, report_status_wed, report_status_fri,
       practice_status_wed, practice_status_fri, teammates_out, depth_rank, source, updated_at)
     VALUES (@sk,@season,@week,@asOf,@team,@pos,@opp,@home,@rest,@roof,@spread,@total,@implied,
       @temp,@wind,NULL,NULL,NULL,@rsf,NULL,NULL,@out,@depth,'live',@now)
     ON CONFLICT(season, week, player_sk) DO UPDATE SET
       as_of=excluded.as_of, team=excluded.team, pos=excluded.pos, opponent=excluded.opponent,
       home=excluded.home, days_rest=excluded.days_rest, roof=excluded.roof,
       spread_line=excluded.spread_line, total_line=excluded.total_line,
       implied_team_total=excluded.implied_team_total, temp_observed=excluded.temp_observed,
       wind_observed=excluded.wind_observed, report_status_fri=excluded.report_status_fri,
       teammates_out=excluded.teammates_out, depth_rank=excluded.depth_rank,
       source=excluded.source, updated_at=excluded.updated_at`,
  );

  const apply = () => {
    for (const u of universe) {
      const sk = Number(u.player_sk);
      if (!Number.isInteger(sk)) continue;              // synthetic DST keys are not people
      const pos = normPos(u.pos ?? "");
      const l = live.get(sk);
      const g = u.team ? sched.get(`${season}|${u.team}|${week}`) : undefined;
      const outSet = u.team ? outsBy.get(`${u.team}|${pos}`) : undefined;
      const mates = outSet ? outSet.size - (outSet.has(sk) ? 1 : 0) : 0;
      ins.run({
        sk, season, week, asOf, team: u.team, pos,
        opp: g?.opponent ?? null, home: g ? g.home : null, rest: g?.rest ?? null, roof: g?.roof ?? null,
        spread: g?.spread ?? null, total: g?.total ?? null, implied: g?.implied ?? null,
        temp: g?.temp ?? null, wind: g?.wind ?? null,
        rsf: l?.report ?? null, out: mates, depth: l?.depth ?? null, now,
      });
      res.rows++;
      if (l?.report) res.withStatus++;
      if (l?.report === "Out") res.outs++;
      if (l?.depth != null) res.withDepth++;
    }
  };

  if (opts.write === false) {
    // Count without writing. The same loop against a throwaway transaction would still hold a write
    // lock, so the counts are recomputed here instead of the insert being skipped inside `apply`.
    for (const u of universe) {
      const sk = Number(u.player_sk);
      if (!Number.isInteger(sk)) continue;
      const l = live.get(sk);
      res.rows++;
      if (l?.report) res.withStatus++;
      if (l?.report === "Out") res.outs++;
      if (l?.depth != null) res.withDepth++;
    }
  } else {
    db.transaction(() => {
      // ONLY the target week. Not the season: the historical builder owns the finished weeks and
      // deleting them here would drop every dated filing this store has for the year.
      db.prepare("DELETE FROM feat_player_week_context WHERE season = ? AND week = ?").run(season, week);
      apply();
    })();
  }

  res.unresolved = unresolved;
  return res;
}
