/**
 * RAW INGESTERS for the point-in-time public feeds.
 *
 * One function per source feed, each writing exactly one `raw_*` table and nothing else. The rules
 * from docs/data-layers.md, restated because every one of them has a failure mode this file is the
 * natural place to commit:
 *
 *   - EXACTLY WHAT THE SOURCE GAVE. A column is renamed only where the feed itself changed the name
 *     between seasons (see the depth-chart and injury schema drifts below), and the schema it came
 *     from is recorded on the row so the rename is auditable rather than invisible.
 *   - NO IDENTITY RESOLUTION. The snap-count feed carries a PFR id and no gsis id. That is written
 *     down as a PFR id. Resolving it here would be the name-keyed join that this layer exists to
 *     keep out of the raw tables, moved one file earlier.
 *   - `as_of` IS WHEN THE INFORMATION WAS KNOWABLE. `fetched_at` is when we downloaded it. They are
 *     separate columns because for a 2014 row they differ by twelve years, and a feature stamped
 *     with the fetch date is lookahead wearing a timestamp.
 *   - A SEASON THAT 404s IS RECORDED, NOT THROWN. Every feed here starts at a different year and
 *     several end before the current one. The per-season result carries `ok: false` with the reason,
 *     so a coverage table can distinguish "the feed has no 2008" from "our fetch broke".
 *
 * THE FAILURE MODE THIS FILE IS MOST EXPOSED TO. Every fetch below is wrapped so a missing season
 * does not abort a sweep -- which is correct, and which makes a MISTYPED URL indistinguishable from
 * a season that does not exist. Both produce an empty table and a clean exit. So the season ranges
 * in docs/data-sources.md were measured by probing the GitHub releases API for the real asset names,
 * and `ingestReport` returns the per-season row counts so a zero is visible as a number rather than
 * inferred from silence.
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import {
  fetchCsvCached, cacheTag, rawTag, URLS, canonTeam, pick,
  injuriesUrl,
} from "./nflverse.js";

/** One season's outcome. `rows` is what LANDED, not what was parsed -- the two differ when a feed
 *  carries rows we cannot key, and only the first number means anything to a coverage check. */
export interface SeasonResult { season: number; ok: boolean; rows: number; note?: string }
export interface IngestReport { table: string; seasons: SeasonResult[]; total: number }

export const num = (s: string): number | null => {
  if (s == null || s === "" || s === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
export const int = (s: string): number | null => { const n = num(s); return n == null ? null : Math.round(n); };
export const str = (s: string): string | null => (s == null || s === "" || s === "NA" ? null : s);

/** Sum the report, so a caller never re-adds the seasons and gets a different total. */
export function totalOf(seasons: SeasonResult[]): number {
  return seasons.reduce((a, s) => a + s.rows, 0);
}

// ==================================================================================================
// raw_nfl_game -- the full nflverse schedules feed.
// ==================================================================================================

/**
 * All seasons in ONE fetch: the schedules feed is a single 2.2MB file covering 1999-2026, so a
 * per-season loop here would re-read the same file 27 times.
 *
 * `as_of = gameday`. See the schema comment: this row is a mixture of as-ofs (the opponent is known
 * in the spring, the closing line the day of the game, the temperature only after kickoff), and
 * gameday is the one date by which every column except the result is settled. A consumer wanting a
 * column earlier than gameday has to justify that column specifically.
 */
export async function ingestRawGames(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const rows = await fetchCsvCached(URLS.schedules, cacheTag.schedules, opts.refresh ?? false);
  const want = opts.seasons?.length ? new Set(opts.seasons) : null;
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_nfl_game (season, game_id, as_of, game_type, week, gameday, weekday, gametime,
       away_team, home_team, away_score, home_score, location, result, total, overtime,
       away_rest, home_rest, away_moneyline, home_moneyline, spread_line, total_line,
       away_spread_odds, home_spread_odds, under_odds, over_odds, div_game, roof, surface, temp, wind,
       stadium_id, stadium, referee, away_qb_id, home_qb_id, away_qb_name, home_qb_name,
       gsis, pfr, espn, fetched_at)
     VALUES (@season,@gameId,@asOf,@gameType,@week,@gameday,@weekday,@gametime,
       @away,@home,@awayScore,@homeScore,@location,@result,@total,@overtime,
       @awayRest,@homeRest,@awayMl,@homeMl,@spread,@totalLine,
       @awaySpreadOdds,@homeSpreadOdds,@under,@over,@divGame,@roof,@surface,@temp,@wind,
       @stadiumId,@stadium,@referee,@awayQbId,@homeQbId,@awayQbName,@homeQbName,
       @gsis,@pfr,@espn,@now)
     ON CONFLICT(season, game_id) DO UPDATE SET
       as_of=excluded.as_of, game_type=excluded.game_type, week=excluded.week, gameday=excluded.gameday,
       weekday=excluded.weekday, gametime=excluded.gametime, away_team=excluded.away_team,
       home_team=excluded.home_team, away_score=excluded.away_score, home_score=excluded.home_score,
       location=excluded.location, result=excluded.result, total=excluded.total, overtime=excluded.overtime,
       away_rest=excluded.away_rest, home_rest=excluded.home_rest, away_moneyline=excluded.away_moneyline,
       home_moneyline=excluded.home_moneyline, spread_line=excluded.spread_line, total_line=excluded.total_line,
       away_spread_odds=excluded.away_spread_odds, home_spread_odds=excluded.home_spread_odds,
       under_odds=excluded.under_odds, over_odds=excluded.over_odds, div_game=excluded.div_game,
       roof=excluded.roof, surface=excluded.surface, temp=excluded.temp, wind=excluded.wind,
       stadium_id=excluded.stadium_id, stadium=excluded.stadium, referee=excluded.referee,
       away_qb_id=excluded.away_qb_id, home_qb_id=excluded.home_qb_id, away_qb_name=excluded.away_qb_name,
       home_qb_name=excluded.home_qb_name, gsis=excluded.gsis, pfr=excluded.pfr, espn=excluded.espn,
       fetched_at=excluded.fetched_at`,
  );

  const perSeason = new Map<number, number>();
  db.transaction(() => {
    for (const r of rows) {
      const season = int(pick(r, "season"));
      const gameId = str(pick(r, "game_id"));
      if (season == null || !gameId) continue;
      if (want && !want.has(season)) continue;
      const gameday = str(r.gameday);
      ins.run({
        season, gameId, asOf: gameday, gameType: str(r.game_type), week: int(r.week),
        gameday, weekday: str(r.weekday), gametime: str(r.gametime),
        // Team abbreviations are CANONICALISED here and nowhere else in this row. That is a rename,
        // not a resolution: nflverse's LA/JAX/OAK/SD/STL are the same franchises our other tables
        // call LAR/JAC/LV/LAC/LAR, and a raw table whose team column cannot join the rest of the
        // store is a table nothing can use. TEAM_ALIAS lives in nflverse.ts, one copy.
        away: canonTeam(pick(r, "away_team")) || null, home: canonTeam(pick(r, "home_team")) || null,
        awayScore: num(r.away_score), homeScore: num(r.home_score),
        location: str(r.location), result: num(r.result), total: num(r.total),
        overtime: int(r.overtime), awayRest: int(r.away_rest), homeRest: int(r.home_rest),
        awayMl: num(r.away_moneyline), homeMl: num(r.home_moneyline),
        spread: num(r.spread_line), totalLine: num(r.total_line),
        awaySpreadOdds: num(r.away_spread_odds), homeSpreadOdds: num(r.home_spread_odds),
        under: num(r.under_odds), over: num(r.over_odds), divGame: int(r.div_game),
        roof: str(r.roof), surface: str(r.surface), temp: num(r.temp), wind: num(r.wind),
        stadiumId: str(r.stadium_id), stadium: str(r.stadium), referee: str(r.referee),
        awayQbId: str(r.away_qb_id), homeQbId: str(r.home_qb_id),
        awayQbName: str(r.away_qb_name), homeQbName: str(r.home_qb_name),
        gsis: str(r.gsis), pfr: str(r.pfr), espn: str(r.espn),
        now,
      });
      perSeason.set(season, (perSeason.get(season) ?? 0) + 1);
    }
  })();
  db.close();

  const seasons: SeasonResult[] = [...perSeason.keys()].sort((a, b) => a - b)
    .map((s) => ({ season: s, ok: true, rows: perSeason.get(s)! }));
  return { table: "raw_nfl_game", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// Per-season fetch with a recorded failure. Shared by every feed below.
// ==================================================================================================

/**
 * Fetch one season's file and hand its rows to `load`. A 404 (or any fetch error) becomes an
 * `ok: false` season with the reason, never an exception -- the point of a sweep over 27 seasons is
 * to find out where a feed starts, and a throw makes that impossible to discover in one run.
 */
export async function perSeasonFeed(
  db: DB,
  seasons: number[],
  url: (s: number) => string,
  tag: (s: number) => string,
  refresh: boolean,
  load: (season: number, rows: Record<string, string>[]) => number,
): Promise<SeasonResult[]> {
  const out: SeasonResult[] = [];
  for (const season of seasons) {
    let rows: Record<string, string>[];
    try {
      rows = await fetchCsvCached(url(season), tag(season), refresh);
    } catch (e) {
      out.push({ season, ok: false, rows: 0, note: String((e as Error).message).slice(0, 120) });
      continue;
    }
    // A file that parses to a HEADER AND NOTHING ELSE is a real and separate state, and it is the
    // one that reads as a fact about football rather than about the feed: the 2012 snap-count asset
    // is exactly this, and a builder that divides by its count concludes nobody played that year.
    if (!rows.length) { out.push({ season, ok: true, rows: 0, note: "feed returned a header and no rows" }); continue; }
    const n = db.transaction(() => load(season, rows))();
    out.push({ season, ok: true, rows: n });
  }
  return out;
}

/** The default sweep for a per-season feed: every season the caller asked for, or 1999-now. */
export function seasonRange(seasons: number[] | undefined, lo = 1999): number[] {
  if (seasons?.length) return seasons.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (let y = lo; y <= new Date().getFullYear(); y++) out.push(y);
  return out;
}

// ==================================================================================================
// raw_injury -- the official weekly injury and practice report.
// ==================================================================================================

/**
 * 2009 onward. 1999-2008 return HTTP 404 and are recorded as such: injury reports do not exist in
 * this commons before 2009, so any injury feature is structurally null for ten of our twenty-seven
 * backtest seasons and a model must be told that rather than fed zeros.
 *
 * SCHEMA DRIFT IS DETECTED FROM THE HEADER, NOT ASSUMED FROM THE YEAR. The 2026 file dropped
 * `date_modified` and three of the four injury-description fields and added `season_type`. Keying
 * the branch on the season number would be a guard keyed on a NAME -- it keeps passing when the feed
 * changes again in a different year. `pick()` already falls through missing columns, so the only
 * thing that must be decided per file is whether a report date exists at all, and that is read from
 * the parsed row.
 */
export async function ingestRawInjuries(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_injury (season, week, team, player_key, report_date, as_of, gsis_id, full_name,
       position, game_type, season_type, report_primary_injury, report_secondary_injury, report_status,
       practice_primary_injury, practice_secondary_injury, practice_status, date_modified,
       source_schema, fetched_at)
     VALUES (@season,@week,@team,@pk,@reportDate,@asOf,@gsis,@name,@pos,@gameType,@seasonType,
       @rp,@rs,@status,@pp,@ps,@practice,@modified,@schema,@now)
     ON CONFLICT(season, week, team, player_key, report_date) DO UPDATE SET
       as_of=excluded.as_of, gsis_id=excluded.gsis_id, full_name=excluded.full_name,
       position=excluded.position, game_type=excluded.game_type, season_type=excluded.season_type,
       report_primary_injury=excluded.report_primary_injury,
       report_secondary_injury=excluded.report_secondary_injury, report_status=excluded.report_status,
       practice_primary_injury=excluded.practice_primary_injury,
       practice_secondary_injury=excluded.practice_secondary_injury,
       practice_status=excluded.practice_status, date_modified=excluded.date_modified,
       source_schema=excluded.source_schema, fetched_at=excluded.fetched_at`,
  );

  const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 1999), injuriesUrl, rawTag.injuries, opts.refresh ?? false, (season, rows) => {
    let n = 0;
    // Read the SHAPE from the file, per file, rather than from the season number.
    const hasModified = Object.prototype.hasOwnProperty.call(rows[0], "date_modified");
    const schema = hasModified ? "classic" : "no-date-modified";
    for (const r of rows) {
      const week = int(pick(r, "week"));
      const team = canonTeam(pick(r, "team"));
      const gsis = str(pick(r, "gsis_id"));
      const name = str(pick(r, "full_name"));
      const pk = gsis ?? name;
      if (week == null || !team || !pk) continue;
      // date_modified is an ISO timestamp; the DATE is the as-of. Keeping the timestamp too, in
      // date_modified, because the raw rule is "what the source gave" and the time of day is what
      // separates a Wednesday practice report from a Friday status update on the same feed.
      const modified = str(pick(r, "date_modified"));
      const asOf = modified ? modified.slice(0, 10) : null;
      ins.run({
        season, week, team, pk, reportDate: asOf ?? "", asOf,
        gsis, name, pos: str(pick(r, "position")),
        gameType: str(pick(r, "game_type")), seasonType: str(pick(r, "season_type")),
        rp: str(pick(r, "report_primary_injury")), rs: str(pick(r, "report_secondary_injury")),
        status: str(pick(r, "report_status")),
        pp: str(pick(r, "practice_primary_injury")), ps: str(pick(r, "practice_secondary_injury")),
        practice: str(pick(r, "practice_status")), modified,
        schema, now,
      });
      n++;
    }
    return n;
  });
  db.close();
  return { table: "raw_injury", seasons, total: totalOf(seasons) };
}
