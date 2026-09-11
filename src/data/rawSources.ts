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
  fetchCsvCached, cacheTag, rawTag, URLS, NFLVERSE, canonTeam, pick,
  injuriesUrl, depthChartsUrl, snapCountsUrl, draftPicksUrl, participationUrl, contractsUrl,
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

// ==================================================================================================
// raw_depth_chart -- two schemas, normalised, with the source schema recorded.
// ==================================================================================================

export async function ingestRawDepthCharts(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_depth_chart (season, week, as_of_key, team, player_key, formation, position,
       depth_position, as_of, depth_rank, gsis_id, espn_id, full_name, game_type, jersey_number,
       source_schema, fetched_at)
     VALUES (@season,@week,@asOfKey,@team,@pk,@formation,@position,@depthPos,@asOf,@rank,
       @gsis,@espn,@name,@gameType,@jersey,@schema,@now)
     ON CONFLICT(season, week, as_of_key, team, player_key, formation, position, depth_position)
     DO UPDATE SET as_of=excluded.as_of, depth_rank=excluded.depth_rank, gsis_id=excluded.gsis_id,
       espn_id=excluded.espn_id, full_name=excluded.full_name, game_type=excluded.game_type,
       jersey_number=excluded.jersey_number, source_schema=excluded.source_schema,
       fetched_at=excluded.fetched_at`,
  );

  const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 1999), depthChartsUrl, rawTag.depthCharts, opts.refresh ?? false, (season, rows) => {
    // The shape is read from the FILE, not from the year. `pos_rank` and `dt` only exist in the
    // daily feed; `depth_team` only in the weekly one.
    const daily = Object.prototype.hasOwnProperty.call(rows[0], "pos_rank");
    let n = 0;
    for (const r of rows) {
      if (daily) {
        const dt = str(pick(r, "dt"));
        const asOf = dt ? dt.slice(0, 10) : null;
        const team = canonTeam(pick(r, "team"));
        const gsis = str(pick(r, "gsis_id"));
        const name = str(pick(r, "player_name"));
        const pk = gsis ?? name;
        const position = str(pick(r, "pos_abb")) ?? "";
        if (!team || !pk || !asOf) continue;
        ins.run({
          // The KEY carries the full `dt` TIMESTAMP, not the date. Measured: keying on the date
          // collapsed 4,811 rows of the 2026 file, and NONE of the collapsed pairs were byte
          // identical -- the feed publishes MORE THAN ONE SNAPSHOT A DAY and truncating dt threw
          // the later ones away silently. `as_of` stays the date, which is the resolution a
          // point-in-time feature actually joins at.
          season, week: 0, asOfKey: dt, team, pk,
          // The daily feed has no formation. `pos_grp` (the position GROUP) goes in that key slot
          // and `pos_slot` in the depth_position one, because both are real source fields and both
          // are needed to make a row unique: a player can appear twice on the same date under
          // different slots, and collapsing those silently loses rows. Measured before and after.
          formation: str(pick(r, "pos_grp")) ?? "", position,
          depthPos: `${str(pick(r, "pos_name")) ?? ""}|${str(pick(r, "pos_slot")) ?? ""}`,
          asOf, rank: int(pick(r, "pos_rank")),
          gsis, espn: str(pick(r, "espn_id")), name, gameType: null, jersey: null,
          schema: "daily", now,
        });
      } else {
        const week = int(pick(r, "week"));
        const team = canonTeam(pick(r, "club_code", "team"));
        const gsis = str(pick(r, "gsis_id"));
        const name = str(pick(r, "full_name"));
        const pk = gsis ?? name;
        const position = str(pick(r, "position")) ?? "";
        if (week == null || !team || !pk) continue;
        ins.run({
          season, week, asOfKey: "", team, pk,
          formation: str(pick(r, "formation")) ?? "", position,
          depthPos: str(pick(r, "depth_position")) ?? "",
          // The weekly feed publishes NO date. as_of stays NULL rather than being filled with a
          // week anchor derived from the schedule -- that derivation belongs to the feature layer.
          asOf: null, rank: int(pick(r, "depth_team")),
          gsis, espn: null, name, gameType: str(pick(r, "game_type")),
          jersey: str(pick(r, "jersey_number")),
          schema: "weekly", now,
        });
      }
      n++;
    }
    return n;
  });
  db.close();
  return { table: "raw_depth_chart", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_snap_count -- PFR snap counts, keyed by the PFR id the feed actually carries.
// ==================================================================================================

/**
 * 2012 onward. The 2012 ASSET IS A HEADER AND NOTHING ELSE -- `perSeasonFeed` reports that as a
 * zero-row season with a note rather than as a fetch failure, because the two are different facts
 * and only one of them is about us.
 *
 * `as_of` is the game day, looked up from `raw_nfl_game` by `game_id`. That is a join, and it is the
 * one exception this file makes to "no joins in raw": the snap feed carries no date at all, and a
 * date that comes from another RAW table is still exactly what a source said. It falls back to NULL
 * rather than to a guess when the game is not in raw_nfl_game.
 */
export async function ingestRawSnapCounts(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const gameday = new Map<string, string>();
  for (const g of db.prepare("SELECT game_id, gameday FROM raw_nfl_game WHERE gameday IS NOT NULL").all() as { game_id: string; gameday: string }[]) {
    gameday.set(g.game_id, g.gameday);
  }
  const ins = db.prepare(
    `INSERT INTO raw_snap_count (season, week, game_id, player_key, as_of, pfr_player_id, pfr_game_id,
       player, position, team, opponent, game_type, offense_snaps, offense_pct, defense_snaps,
       defense_pct, st_snaps, st_pct, fetched_at)
     VALUES (@season,@week,@gameId,@pk,@asOf,@pfrId,@pfrGame,@player,@pos,@team,@opp,@gameType,
       @offSnaps,@offPct,@defSnaps,@defPct,@stSnaps,@stPct,@now)
     ON CONFLICT(season, week, game_id, player_key) DO UPDATE SET
       as_of=excluded.as_of, pfr_player_id=excluded.pfr_player_id, pfr_game_id=excluded.pfr_game_id,
       player=excluded.player, position=excluded.position, team=excluded.team, opponent=excluded.opponent,
       game_type=excluded.game_type, offense_snaps=excluded.offense_snaps, offense_pct=excluded.offense_pct,
       defense_snaps=excluded.defense_snaps, defense_pct=excluded.defense_pct, st_snaps=excluded.st_snaps,
       st_pct=excluded.st_pct, fetched_at=excluded.fetched_at`,
  );

  const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 2012), snapCountsUrl, rawTag.snapCounts, opts.refresh ?? false, (season, rows) => {
    let n = 0;
    for (const r of rows) {
      const week = int(pick(r, "week"));
      const gameId = str(pick(r, "game_id"));
      const pfrId = str(pick(r, "pfr_player_id"));
      const player = str(pick(r, "player"));
      const pk = pfrId ?? player;
      if (week == null || !gameId || !pk) continue;
      ins.run({
        season, week, gameId, pk, asOf: gameday.get(gameId) ?? null,
        pfrId, pfrGame: str(pick(r, "pfr_game_id")), player,
        pos: str(pick(r, "position")), team: canonTeam(pick(r, "team")) || null,
        opp: canonTeam(pick(r, "opponent")) || null, gameType: str(pick(r, "game_type")),
        offSnaps: num(pick(r, "offense_snaps")), offPct: num(pick(r, "offense_pct")),
        defSnaps: num(pick(r, "defense_snaps")), defPct: num(pick(r, "defense_pct")),
        stSnaps: num(pick(r, "st_snaps")), stPct: num(pick(r, "st_pct")),
        now,
      });
      n++;
    }
    return n;
  });
  db.close();
  return { table: "raw_snap_count", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_nfl_draft_pick -- the NFL draft, one file, all years.
// ==================================================================================================

/** `as_of = <season>-05-01`: the NFL draft finishes in late April, so a pick is knowable by the
 *  first of May of its own year and for every September anchor after it. */
export async function ingestRawDraftPicks(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const rows = await fetchCsvCached(draftPicksUrl, cacheTag.draftPicks, opts.refresh ?? false);
  const want = opts.seasons?.length ? new Set(opts.seasons) : null;
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_nfl_draft_pick (season, round, pick, as_of, team, gsis_id, pfr_player_id,
       cfb_player_id, pfr_player_name, position, category, side, college, age, hof, w_av, car_av,
       dr_av, games, seasons_started, allpro, probowls, to_season, fetched_at)
     VALUES (@season,@round,@pick,@asOf,@team,@gsis,@pfr,@cfb,@name,@pos,@category,@side,@college,
       @age,@hof,@wav,@carav,@drav,@games,@started,@allpro,@probowls,@to,@now)
     ON CONFLICT(season, round, pick) DO UPDATE SET
       as_of=excluded.as_of, team=excluded.team, gsis_id=excluded.gsis_id,
       pfr_player_id=excluded.pfr_player_id, cfb_player_id=excluded.cfb_player_id,
       pfr_player_name=excluded.pfr_player_name, position=excluded.position, category=excluded.category,
       side=excluded.side, college=excluded.college, age=excluded.age, hof=excluded.hof,
       w_av=excluded.w_av, car_av=excluded.car_av, dr_av=excluded.dr_av, games=excluded.games,
       seasons_started=excluded.seasons_started, allpro=excluded.allpro, probowls=excluded.probowls,
       to_season=excluded.to_season, fetched_at=excluded.fetched_at`,
  );
  const perSeason = new Map<number, number>();
  db.transaction(() => {
    for (const r of rows) {
      const season = int(pick(r, "season"));
      const round = int(pick(r, "round"));
      const pk = int(pick(r, "pick"));
      if (season == null || round == null || pk == null) continue;
      if (want && !want.has(season)) continue;
      ins.run({
        season, round, pick: pk, asOf: `${season}-05-01`,
        team: canonTeam(pick(r, "team")) || null, gsis: str(pick(r, "gsis_id")),
        pfr: str(pick(r, "pfr_player_id")), cfb: str(pick(r, "cfb_player_id")),
        name: str(pick(r, "pfr_player_name")), pos: str(pick(r, "position")),
        category: str(pick(r, "category")), side: str(pick(r, "side")),
        college: str(pick(r, "college")), age: num(pick(r, "age")),
        hof: int(pick(r, "hof")), wav: num(pick(r, "w_av")), carav: num(pick(r, "car_av")),
        drav: num(pick(r, "dr_av")), games: num(pick(r, "games")),
        started: num(pick(r, "seasons_started")), allpro: num(pick(r, "allpro")),
        probowls: num(pick(r, "probowls")), to: num(pick(r, "to")),
        now,
      });
      perSeason.set(season, (perSeason.get(season) ?? 0) + 1);
    }
  })();
  db.close();
  const seasons: SeasonResult[] = [...perSeason.keys()].sort((a, b) => a - b)
    .map((s) => ({ season: s, ok: true, rows: perSeason.get(s)! }));
  return { table: "raw_nfl_draft_pick", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_combine -- the NFL combine: physicals + athletic testing. One file, all years.
// ==================================================================================================

/** `as_of = <draft_year>-03-01`: the combine runs in late February, so a result is knowable by the
 *  first of March of the draft year and for every September anchor after it. The full athletic
 *  profile (the RAS inputs) plus the pfr and college crosswalk ids -- only the 40 was read before. */
export async function ingestRawCombine(opts: { dbPath?: string; refresh?: boolean } = {}): Promise<IngestReport> {
  const rows = await fetchCsvCached(URLS.combine, cacheTag.combine, opts.refresh ?? false);
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_combine (draft_year, player_name, pos, as_of, pfr_player_id, cfb_player_id, school,
       draft_team, draft_round, draft_ovr, ht, wt, forty, bench, vertical, broad_jump, cone, shuttle, fetched_at)
     VALUES (@draftYear,@name,@pos,@asOf,@pfr,@cfb,@school,@team,@round,@ovr,@ht,@wt,@forty,@bench,@vert,@broad,@cone,@shuttle,@now)
     ON CONFLICT(draft_year, player_name, pos) DO UPDATE SET
       as_of=excluded.as_of, pfr_player_id=excluded.pfr_player_id, cfb_player_id=excluded.cfb_player_id,
       school=excluded.school, draft_team=excluded.draft_team, draft_round=excluded.draft_round,
       draft_ovr=excluded.draft_ovr, ht=excluded.ht, wt=excluded.wt, forty=excluded.forty, bench=excluded.bench,
       vertical=excluded.vertical, broad_jump=excluded.broad_jump, cone=excluded.cone, shuttle=excluded.shuttle,
       fetched_at=excluded.fetched_at`,
  );
  const perSeason = new Map<number, number>();
  db.transaction(() => {
    for (const r of rows) {
      const draftYear = int(pick(r, "draft_year", "season"));
      const name = str(pick(r, "player_name"));
      const pos = str(pick(r, "pos"));
      if (draftYear == null || !name || !pos) continue;
      ins.run({
        draftYear, name, pos, asOf: `${draftYear}-03-01`,
        pfr: str(pick(r, "pfr_id")), cfb: str(pick(r, "cfb_id")), school: str(pick(r, "school")),
        team: str(pick(r, "draft_team")), round: int(pick(r, "draft_round")), ovr: int(pick(r, "draft_ovr")),
        ht: str(pick(r, "ht")), wt: num(pick(r, "wt")), forty: num(pick(r, "forty")), bench: num(pick(r, "bench")),
        vert: num(pick(r, "vertical")), broad: num(pick(r, "broad_jump")), cone: num(pick(r, "cone")), shuttle: num(pick(r, "shuttle")),
        now,
      });
      perSeason.set(draftYear, (perSeason.get(draftYear) ?? 0) + 1);
    }
  })();
  db.close();
  const seasons: SeasonResult[] = [...perSeason.keys()].sort((a, b) => a - b)
    .map((s) => ({ season: s, ok: true, rows: perSeason.get(s)! }));
  return { table: "raw_combine", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_ngs -- Next Gen Stats player-tracking advanced metrics. Three combined files, one table.
// ==================================================================================================

/** Receiving/rushing/passing NGS into one `raw_ngs` keyed by (season, season_type, week, stat_type,
 *  gsis). Every column is read for every file; `pick` returns "" for a column a file does not have,
 *  so the irrelevant metrics land null without per-type branching. week=0 season aggregates are kept
 *  as the source ships them (a weekly consumer must filter them). */
export async function ingestRawNgs(opts: { dbPath?: string; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_ngs (season, season_type, week, stat_type, player_gsis_id, player_display_name,
       player_position, team_abbr, avg_cushion, avg_separation, avg_intended_air_yards,
       pct_share_intended_air_yards, catch_pct, avg_yac_above_expectation, receptions, targets, rec_yards,
       rec_tds, efficiency, pct_attempts_gte_eight, ryoe_per_att, rush_pct_over_expected, rush_attempts,
       rush_yards, rush_tds, avg_time_to_throw, aggressiveness, cpoe, avg_air_yards_to_sticks,
       pass_attempts, pass_yards, pass_tds, fetched_at)
     VALUES (@season,@seasonType,@week,@statType,@gsis,@name,@pos,@team,@avgCushion,@avgSep,@avgIay,
       @pctShare,@catchPct,@yacAe,@rec,@tgt,@recYds,@recTds,@eff,@pctEight,@ryoeAtt,@rushPctOe,@rushAtt,
       @rushYds,@rushTds,@timeThrow,@aggr,@cpoe,@aySticks,@passAtt,@passYds,@passTds,@now)
     ON CONFLICT(season, season_type, week, stat_type, player_gsis_id) DO UPDATE SET
       player_display_name=excluded.player_display_name, player_position=excluded.player_position,
       team_abbr=excluded.team_abbr, avg_cushion=excluded.avg_cushion, avg_separation=excluded.avg_separation,
       avg_intended_air_yards=excluded.avg_intended_air_yards, pct_share_intended_air_yards=excluded.pct_share_intended_air_yards,
       catch_pct=excluded.catch_pct, avg_yac_above_expectation=excluded.avg_yac_above_expectation,
       receptions=excluded.receptions, targets=excluded.targets, rec_yards=excluded.rec_yards, rec_tds=excluded.rec_tds,
       efficiency=excluded.efficiency, pct_attempts_gte_eight=excluded.pct_attempts_gte_eight,
       ryoe_per_att=excluded.ryoe_per_att, rush_pct_over_expected=excluded.rush_pct_over_expected,
       rush_attempts=excluded.rush_attempts, rush_yards=excluded.rush_yards, rush_tds=excluded.rush_tds,
       avg_time_to_throw=excluded.avg_time_to_throw, aggressiveness=excluded.aggressiveness, cpoe=excluded.cpoe,
       avg_air_yards_to_sticks=excluded.avg_air_yards_to_sticks, pass_attempts=excluded.pass_attempts,
       pass_yards=excluded.pass_yards, pass_tds=excluded.pass_tds, fetched_at=excluded.fetched_at`,
  );
  const perSeason = new Map<number, number>();
  for (const [statType, file] of [["rec", "receiving"], ["rush", "rushing"], ["pass", "passing"]] as const) {
    const rows = await fetchCsvCached(`${NFLVERSE}/nextgen_stats/ngs_${file}.csv.gz`, rawTag.ngs(statType), opts.refresh ?? false);
    db.transaction(() => {
      for (const r of rows) {
        const season = int(pick(r, "season")), week = int(pick(r, "week")), gsis = str(pick(r, "player_gsis_id"));
        if (season == null || week == null || !gsis) continue;
        ins.run({
          season, seasonType: str(pick(r, "season_type")) ?? "REG", week, statType, gsis,
          name: str(pick(r, "player_display_name")), pos: str(pick(r, "player_position")), team: canonTeam(pick(r, "team_abbr")) || null,
          avgCushion: num(pick(r, "avg_cushion")), avgSep: num(pick(r, "avg_separation")), avgIay: num(pick(r, "avg_intended_air_yards")),
          pctShare: num(pick(r, "percent_share_of_intended_air_yards")), catchPct: num(pick(r, "catch_percentage")),
          yacAe: num(pick(r, "avg_yac_above_expectation")), rec: num(pick(r, "receptions")), tgt: num(pick(r, "targets")),
          recYds: num(pick(r, "yards")), recTds: num(pick(r, "rec_touchdowns")),
          eff: num(pick(r, "efficiency")), pctEight: num(pick(r, "percent_attempts_gte_eight_defenders")),
          ryoeAtt: num(pick(r, "rush_yards_over_expected_per_att")), rushPctOe: num(pick(r, "rush_pct_over_expected")),
          rushAtt: num(pick(r, "rush_attempts")), rushYds: num(pick(r, "rush_yards")), rushTds: num(pick(r, "rush_touchdowns")),
          timeThrow: num(pick(r, "avg_time_to_throw")), aggr: num(pick(r, "aggressiveness")), cpoe: num(pick(r, "completion_percentage_above_expectation")),
          aySticks: num(pick(r, "avg_air_yards_to_sticks")), passAtt: num(pick(r, "attempts")), passYds: num(pick(r, "pass_yards")), passTds: num(pick(r, "pass_touchdowns")),
          now,
        });
        perSeason.set(season, (perSeason.get(season) ?? 0) + 1);
      }
    })();
  }
  db.close();
  const seasons: SeasonResult[] = [...perSeason.keys()].sort((a, b) => a - b).map((s) => ({ season: s, ok: true, rows: perSeason.get(s)! }));
  return { table: "raw_ngs", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_college_player_season (+ raw_college_team_season) -- the COLLEGE PRODUCTION pillar.
// Aggregated at ingest from cfbfastR play-by-play (2014+) into player-season and team-season totals,
// the ingredients of Dominator Rating and Breakout Age.
// ==================================================================================================

const CFB_PBP = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv";

export async function ingestRawCollege(opts: { dbPath?: string; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const insP = db.prepare(
    `INSERT INTO raw_college_player_season (season, cfb_athlete_id, as_of, player_name, team, games,
       receptions, targets, rec_yards, rec_tds, rush_attempts, rush_yards, rush_tds, fetched_at)
     VALUES (@season,@id,@asOf,@name,@team,@games,@rec,@tgt,@recYds,@recTds,@rushAtt,@rushYds,@rushTds,@now)
     ON CONFLICT(season, cfb_athlete_id) DO UPDATE SET as_of=excluded.as_of, player_name=excluded.player_name,
       team=excluded.team, games=excluded.games, receptions=excluded.receptions, targets=excluded.targets,
       rec_yards=excluded.rec_yards, rec_tds=excluded.rec_tds, rush_attempts=excluded.rush_attempts,
       rush_yards=excluded.rush_yards, rush_tds=excluded.rush_tds, fetched_at=excluded.fetched_at`,
  );
  const insT = db.prepare(
    `INSERT INTO raw_college_team_season (season, team, team_rec_yards, team_rush_yards, team_rec_tds, team_rush_tds, fetched_at)
     VALUES (@season,@team,@recYds,@rushYds,@recTds,@rushTds,@now)
     ON CONFLICT(season, team) DO UPDATE SET team_rec_yards=excluded.team_rec_yards,
       team_rush_yards=excluded.team_rush_yards, team_rec_tds=excluded.team_rec_tds, team_rush_tds=excluded.team_rush_tds, fetched_at=excluded.fetched_at`,
  );

  type P = { name: string; team: string; games: Set<string>; rec: number; tgt: number; recYds: number; recTds: number; rushAtt: number; rushYds: number; rushTds: number };
  type T = { recYds: number; rushYds: number; recTds: number; rushTds: number };
  const perSeason = new Map<number, number>();
  const thisYear = new Date().getFullYear();

  for (let season = 2014; season <= thisYear; season++) {
    let rows: Record<string, string>[];
    try { rows = await fetchCsvCached(`${CFB_PBP}/player_stats_${season}.csv`, `cfb-pbp-${season}`, opts.refresh ?? false); }
    catch { continue; } // a season the feed has not published yet
    const players = new Map<string, P>();
    const teams = new Map<string, T>();
    const getP = (id: string, name: string, team: string): P => {
      let p = players.get(id);
      if (!p) { p = { name, team, games: new Set(), rec: 0, tgt: 0, recYds: 0, recTds: 0, rushAtt: 0, rushYds: 0, rushTds: 0 }; players.set(id, p); }
      if (!p.name && name) p.name = name;
      if (team) p.team = team; // last team seen on an offensive play (handles mid-season attribution)
      return p;
    };
    for (const r of rows) {
      const team = str(pick(r, "team"));
      const gameId = pick(r, "game_id");
      const recId = str(pick(r, "reception_player_id")), rushId = str(pick(r, "rush_player_id")), tgtId = str(pick(r, "target_player_id")), tdId = str(pick(r, "touchdown_player_id"));
      const recYds = num(pick(r, "reception_yds")) ?? 0, rushYds = num(pick(r, "rush_yds")) ?? 0;
      if (team) { const t = teams.get(team) ?? { recYds: 0, rushYds: 0, recTds: 0, rushTds: 0 }; t.recYds += recYds; t.rushYds += rushYds; teams.set(team, t); }
      if (recId) { const p = getP(recId, str(pick(r, "reception_player")) ?? "", team ?? ""); p.recYds += recYds; p.rec++; if (gameId) p.games.add(gameId); }
      if (tgtId) { const p = getP(tgtId, str(pick(r, "target_player")) ?? "", team ?? ""); p.tgt++; if (gameId) p.games.add(gameId); }
      if (rushId) { const p = getP(rushId, str(pick(r, "rush_player")) ?? "", team ?? ""); p.rushYds += rushYds; p.rushAtt++; if (gameId) p.games.add(gameId); }
      if (tdId) {
        const p = getP(tdId, str(pick(r, "touchdown_player")) ?? "", team ?? "");
        if (tdId === recId) { p.recTds++; if (team) teams.get(team)!.recTds++; }
        else if (tdId === rushId) { p.rushTds++; if (team) teams.get(team)!.rushTds++; }
      }
    }
    const asOf = `${season + 1}-02-01`;
    db.transaction(() => {
      for (const [id, p] of players) {
        if (p.rec + p.rushAtt + p.tgt === 0) continue; // no offensive touches -> not a skill contributor
        insP.run({ season, id, asOf, name: p.name || null, team: p.team || null, games: p.games.size, rec: p.rec, tgt: p.tgt, recYds: p.recYds, recTds: p.recTds, rushAtt: p.rushAtt, rushYds: p.rushYds, rushTds: p.rushTds, now });
      }
      for (const [team, t] of teams) insT.run({ season, team, recYds: t.recYds, rushYds: t.rushYds, recTds: t.recTds, rushTds: t.rushTds, now });
    })();
    perSeason.set(season, players.size);
  }
  db.close();
  const seasons: SeasonResult[] = [...perSeason.keys()].sort((a, b) => a - b).map((s) => ({ season: s, ok: true, rows: perSeason.get(s)! }));
  return { table: "raw_college_player_season", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_contract -- OverTheCap contracts. One file, every contract.
// ==================================================================================================

/** `as_of = <year_signed>-03-01`: the NFL league year opens in mid-March and that is when a signing
 *  becomes public, so a contract is knowable for every September anchor from its own year on. */
export async function ingestRawContracts(opts: { dbPath?: string; refresh?: boolean } = {}): Promise<IngestReport> {
  const rows = await fetchCsvCached(contractsUrl, rawTag.contracts, opts.refresh ?? false);
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_contract (player_key, contract_no, as_of, otc_id, player, position, team,
       is_active, year_signed, years, value, apy, guaranteed, apy_cap_pct, inflated_value,
       inflated_apy, inflated_guaranteed, date_of_birth, height, weight, college, draft_year,
       draft_round, draft_overall, draft_team, fetched_at)
     VALUES (@pk,@no,@asOf,@otc,@player,@pos,@team,@active,@signed,@years,@value,@apy,@guar,@pct,
       @iv,@ia,@ig,@dob,@ht,@wt,@college,@dy,@dr,@do,@dt,@now)
     ON CONFLICT(player_key, contract_no) DO UPDATE SET
       as_of=excluded.as_of, otc_id=excluded.otc_id, player=excluded.player, position=excluded.position,
       team=excluded.team, is_active=excluded.is_active, year_signed=excluded.year_signed,
       years=excluded.years, value=excluded.value, apy=excluded.apy, guaranteed=excluded.guaranteed,
       apy_cap_pct=excluded.apy_cap_pct, inflated_value=excluded.inflated_value,
       inflated_apy=excluded.inflated_apy, inflated_guaranteed=excluded.inflated_guaranteed,
       date_of_birth=excluded.date_of_birth, height=excluded.height, weight=excluded.weight,
       college=excluded.college, draft_year=excluded.draft_year, draft_round=excluded.draft_round,
       draft_overall=excluded.draft_overall, draft_team=excluded.draft_team, fetched_at=excluded.fetched_at`,
  );
  const seen = new Map<string, number>();
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const otc = str(pick(r, "otc_id"));
      const player = str(pick(r, "player"));
      const pk = otc ?? player;
      if (!pk) continue;
      const no = (seen.get(pk) ?? 0) + 1;
      seen.set(pk, no);
      const signed = int(pick(r, "year_signed"));
      ins.run({
        pk, no, asOf: signed == null ? null : `${signed}-03-01`,
        otc, player, pos: str(pick(r, "position")), team: canonTeam(pick(r, "team")) || null,
        active: pick(r, "is_active") === "TRUE" ? 1 : (pick(r, "is_active") === "FALSE" ? 0 : null),
        signed, years: num(pick(r, "years")), value: num(pick(r, "value")), apy: num(pick(r, "apy")),
        guar: num(pick(r, "guaranteed")), pct: num(pick(r, "apy_cap_pct")),
        iv: num(pick(r, "inflated_value")), ia: num(pick(r, "inflated_apy")), ig: num(pick(r, "inflated_guaranteed")),
        dob: str(pick(r, "date_of_birth")), ht: str(pick(r, "height")), wt: num(pick(r, "weight")),
        college: str(pick(r, "college")), dy: int(pick(r, "draft_year")), dr: int(pick(r, "draft_round")),
        do: int(pick(r, "draft_overall")), dt: str(pick(r, "draft_team")),
        now,
      });
      n++;
    }
  })();
  db.close();
  return { table: "raw_contract", seasons: [{ season: 0, ok: true, rows: n }], total: n };
}

// ==================================================================================================
// raw_participation -- play-level participation, aggregated to player-week.
// ==================================================================================================

/**
 * 2016-2025. THE MOST EXPENSIVE FEED IN THIS FILE by a wide margin: 21-50MB and ~46,000 plays a
 * season, roughly 400MB and 460,000 plays over the range.
 *
 * The aggregation is the point. We want one number per player-week -- how often he was on the field
 * for a pass -- and the feed answers it only by counting the plays his gsis id appears in the
 * semicolon-joined `offense_players` string. The team totals are carried on the same row so a share
 * can be computed without a second pass over 460,000 plays, and so that the DENOMINATOR is visible:
 * a share whose denominator lives somewhere else is a share nobody can check.
 */
export async function ingestRawParticipation(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const meta = new Map<string, { week: number; gameday: string | null }>();
  for (const g of db.prepare("SELECT game_id, week, gameday FROM raw_nfl_game").all() as { game_id: string; week: number; gameday: string | null }[]) {
    meta.set(g.game_id, { week: g.week, gameday: g.gameday });
  }
  const ins = db.prepare(
    `INSERT INTO raw_participation (season, week, gsis_id, team, as_of, off_plays, pass_plays, games,
       team_off_plays, team_pass_plays, fetched_at)
     VALUES (@season,@week,@gsis,@team,@asOf,@off,@pass,@games,@teamOff,@teamPass,@now)
     ON CONFLICT(season, week, gsis_id, team) DO UPDATE SET
       as_of=excluded.as_of, off_plays=excluded.off_plays, pass_plays=excluded.pass_plays,
       games=excluded.games, team_off_plays=excluded.team_off_plays,
       team_pass_plays=excluded.team_pass_plays, fetched_at=excluded.fetched_at`,
  );

  const seasons = await perSeasonFeed(db, seasonRange(opts.seasons, 2016), participationUrl, rawTag.participation, opts.refresh ?? false, (season, rows) => {
    interface Agg { off: number; pass: number; games: Set<string> }
    const byPlayer = new Map<string, Agg>();
    const byTeam = new Map<string, { off: number; pass: number }>();
    const asOfOf = new Map<string, string | null>();
    for (const r of rows) {
      const gameId = pick(r, "nflverse_game_id");
      const m = meta.get(gameId);
      if (!m || m.week == null) continue;             // a game raw_nfl_game does not know
      const team = canonTeam(pick(r, "possession_team"));
      if (!team) continue;
      // A CHARTED ROUTE marks a pass play. See the schema comment for what this is and is not.
      const isPass = pick(r, "route") !== "";
      const tk = `${m.week}|${team}`;
      const t = byTeam.get(tk) ?? { off: 0, pass: 0 };
      t.off++; if (isPass) t.pass++;
      byTeam.set(tk, t);
      asOfOf.set(tk, m.gameday);
      for (const id of pick(r, "offense_players").split(";")) {
        if (!id) continue;
        const k = `${m.week}|${team}|${id}`;
        const a = byPlayer.get(k) ?? { off: 0, pass: 0, games: new Set<string>() };
        a.off++; if (isPass) a.pass++; a.games.add(gameId);
        byPlayer.set(k, a);
      }
    }
    let n = 0;
    for (const [k, a] of byPlayer) {
      const [wk, team, gsis] = k.split("|");
      const t = byTeam.get(`${wk}|${team}`)!;
      ins.run({
        season, week: Number(wk), gsis, team, asOf: asOfOf.get(`${wk}|${team}`) ?? null,
        off: a.off, pass: a.pass, games: a.games.size, teamOff: t.off, teamPass: t.pass, now,
      });
      n++;
    }
    return n;
  });
  db.close();
  return { table: "raw_participation", seasons, total: totalOf(seasons) };
}

// ==================================================================================================
// raw_adp_history -- the FantasyFootballCalculator ADP archive.
// ==================================================================================================

/** JSON on disk, gzipped, beside the CSV cache. The FFC archive for a completed season never
 *  changes, so re-fetching 60 season/format pairs on every rebuild would be pure waste. */
async function fetchJsonCached(url: string, tag: string, refresh: boolean): Promise<unknown> {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { gzipSync, gunzipSync } = await import("node:zlib");
  const { dataPath } = await import("./paths.js");
  const dir = dataPath("cache");
  const p = `${dir}/${tag}.json.gz`;
  if (!refresh && existsSync(p)) return JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const text = await res.text();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, gzipSync(Buffer.from(text)));
  return JSON.parse(text);
}

interface FfcResponse {
  status?: string;
  meta?: { type?: string; teams?: number; rounds?: number; total_drafts?: number; start_date?: string; end_date?: string };
  players?: { player_id?: number; name?: string; position?: string; team?: string; adp?: number;
    adp_formatted?: string; times_drafted?: number; high?: number; low?: number; stdev?: number; bye?: number }[];
}

/**
 * The formats worth keeping, with the first season each actually returns players for. MEASURED by
 * sweeping 2007-2026 for each: `standard` starts in 2008, `ppr` in 2010, `half-ppr` only in 2018.
 * Our league is half-PPR, so the format that matches it has the shortest archive of the three --
 * which is exactly the kind of fact that has to be known before a feature is built on it rather
 * than discovered as a run of nulls afterwards.
 */
export const FFC_FORMATS: { format: string; from: number }[] = [
  { format: "standard", from: 2008 },
  { format: "ppr", from: 2010 },
  { format: "half-ppr", from: 2018 },
];

/**
 * ONE team count, 12, and the reason is a measurement rather than a preference: the API accepts
 * `teams` and ignores it. See the schema comment. Fetching 8/10/12/14 would store four copies of
 * one row and would make `teams` look like a dimension it is not.
 */
export const FFC_TEAMS = 12;

export async function ingestRawAdpHistory(opts: { dbPath?: string; seasons?: number[]; refresh?: boolean } = {}): Promise<IngestReport> {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_adp_history (format, season, teams, ffc_player_id, as_of, window_start, window_end,
       total_drafts, rounds, meta_teams, name, position, team, adp, adp_formatted, times_drafted,
       high, low, stdev, bye, fetched_at)
     VALUES (@format,@season,@teams,@pid,@asOf,@start,@end,@drafts,@rounds,@metaTeams,@name,@pos,@team,
       @adp,@adpF,@td,@high,@low,@sd,@bye,@now)
     ON CONFLICT(format, season, teams, ffc_player_id) DO UPDATE SET
       as_of=excluded.as_of, window_start=excluded.window_start, window_end=excluded.window_end,
       total_drafts=excluded.total_drafts, rounds=excluded.rounds, meta_teams=excluded.meta_teams,
       name=excluded.name, position=excluded.position, team=excluded.team, adp=excluded.adp,
       adp_formatted=excluded.adp_formatted, times_drafted=excluded.times_drafted, high=excluded.high,
       low=excluded.low, stdev=excluded.stdev, bye=excluded.bye, fetched_at=excluded.fetched_at`,
  );

  const years = seasonRange(opts.seasons, 2008);
  const perSeason = new Map<number, number>();
  const notes: string[] = [];
  for (const { format, from } of FFC_FORMATS) {
    for (const season of years) {
      if (season < from) continue;                     // measured, not guessed -- see FFC_FORMATS
      const url = `https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${FFC_TEAMS}&year=${season}&position=all`;
      let j: FfcResponse;
      try { j = await fetchJsonCached(url, `ffc-adp-${format}-${season}`, opts.refresh ?? false) as FfcResponse; }
      catch (e) { notes.push(`${format} ${season}: ${(e as Error).message}`); continue; }
      const players = j.players ?? [];
      if (!players.length) { notes.push(`${format} ${season}: 0 players`); continue; }
      const m = j.meta ?? {};
      const n = db.transaction(() => {
        let k = 0;
        for (const p of players) {
          const pid = p.player_id != null ? String(p.player_id) : (p.name ?? "");
          if (!pid) continue;
          ins.run({
            format, season, teams: FFC_TEAMS, pid,
            asOf: m.end_date ?? null, start: m.start_date ?? null, end: m.end_date ?? null,
            drafts: m.total_drafts ?? null, rounds: m.rounds ?? null, metaTeams: m.teams ?? null,
            name: p.name ?? null, pos: p.position ?? null, team: p.team ?? null,
            adp: p.adp ?? null, adpF: p.adp_formatted ?? null, td: p.times_drafted ?? null,
            high: p.high ?? null, low: p.low ?? null, sd: p.stdev ?? null, bye: p.bye ?? null,
            now,
          });
          k++;
        }
        return k;
      })();
      perSeason.set(season, (perSeason.get(season) ?? 0) + n);
    }
  }
  db.close();
  const seasons: SeasonResult[] = [...perSeason.keys()].sort((a, b) => a - b)
    .map((s) => ({ season: s, ok: true, rows: perSeason.get(s)! }));
  if (notes.length) seasons.push({ season: 0, ok: true, rows: 0, note: notes.join("; ").slice(0, 400) });
  return { table: "raw_adp_history", seasons, total: totalOf(seasons) };
}
