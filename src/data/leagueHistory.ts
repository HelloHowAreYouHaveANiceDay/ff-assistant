/**
 * THIS LEAGUE'S OWN HISTORY, as a reproducible RAW asset.
 *
 * WHAT WAS WRONG. The fifteen seasons of this league -- every auction price anyone in this room has
 * ever paid, every final rank, every schedule -- reached the store exactly once, by a hand-run
 * script in a scratchpad directory. That is the definition of a table that is not reproducible by
 * re-fetching: delete `data/ff.db` and the single most league-specific dataset we own is gone, with
 * no verb that rebuilds it. docs/data-layers.md's first raw-layer rule ("a raw table must be
 * reproducible by re-fetching") was being broken by the most valuable rows in the store.
 *
 * So the loader lives here, the DDL lives in schema.sql, and `ff ingest-source league-history` is
 * the verb. The pure part -- `loadLeagueHistory` -- takes the snapshots as data, which is what lets
 * it be tested against a captured dump with no network and no ESPN session.
 *
 * RAW MEANS RAW. A pick row carries the display name ESPN printed, the position ESPN assigned and
 * the owner GUID ESPN used. Nothing here joins to `stg_player`; resolving identity in the raw layer
 * is precisely the move that put a father's birth year on his son. `fact_draft_pick` (features/) is
 * where that resolution belongs, and it can now be rebuilt from these rows.
 *
 * A 404 IS DATA. Seasons before 2018 return HTTP 404 from ESPN -- this league did not exist yet.
 * Those are written as `available = 0` with the note, never thrown. A sweep that aborts on the first
 * missing year can never establish where the history begins.
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import type { LeagueSchedule, SeasonSnapshot } from "../league/types.js";

export interface LeagueHistoryCounts {
  seasons: number; available: number; teams: number; picks: number; games: number; divisions: number;
}

export interface SeasonCheck {
  season: number; available: number; teams: number; picks: number; total: number; games: number; champion: string | null;
}

// `currentLeagueId` lived here and answered "which league" by LAST SYNC, disagreeing with
// `activeLeagueId` -- so these ingesters fetched one league's data over ESPN and stamped another
// league's id onto every row (S-2). Deleted 2026-09-16; `resolveLeagueContext` is the only resolver.

/**
 * Upsert the five raw tables from snapshots already in hand.
 *
 * Pure with respect to the network: everything it needs arrives as arguments, so the same code path
 * that runs against ESPN runs against a captured JSON dump in a test.
 */
export function loadLeagueHistory(
  db: DB,
  leagueId: string,
  seasons: SeasonSnapshot[],
  schedules: Record<string, LeagueSchedule>,
  fetchedAt: string,
): LeagueHistoryCounts {
  // NAMED COLUMNS, not `VALUES (...)`. The per-season format columns are added by db.ts's ALTER
  // path rather than by schema.sql (schema.sql only ever reaches a fresh store), so the column COUNT
  // differs between a fresh database and a migrated one -- and a positional INSERT is exactly the
  // statement that breaks silently in one of those two worlds.
  const upSeason = db.prepare(`INSERT INTO raw_league_season
      (league_id, season, available, size, auction_budget, ppr_points, slot_counts_json, note, fetched_at,
       reg_weeks, playoff_teams, playoff_round_weeks, playoff_reseed, seeding_rule, division_count)
    VALUES (@l,@s,@a,@size,@b,@ppr,@slots,@note,@now,@rw,@pt,@prw,@prs,@sr,@dc)
    ON CONFLICT(league_id,season) DO UPDATE SET available=excluded.available,size=excluded.size,auction_budget=excluded.auction_budget,
    ppr_points=excluded.ppr_points,slot_counts_json=excluded.slot_counts_json,note=excluded.note,fetched_at=excluded.fetched_at,
    reg_weeks=excluded.reg_weeks,playoff_teams=excluded.playoff_teams,playoff_round_weeks=excluded.playoff_round_weeks,
    playoff_reseed=excluded.playoff_reseed,seeding_rule=excluded.seeding_rule,division_count=excluded.division_count`);
  const upTeam = db.prepare(`INSERT INTO raw_league_team_season VALUES (@l,@s,@id,@name,@oid,@owner,@acq,@faab,@drops,@trades,@moves,@abw,@w,@lo,@pf,@fr,@ps,@now)
    ON CONFLICT(league_id,season,team_id) DO UPDATE SET name=excluded.name,owner_id=excluded.owner_id,owner=excluded.owner,
    acquisitions=excluded.acquisitions,faab_spent=excluded.faab_spent,drops=excluded.drops,trades=excluded.trades,lineup_moves=excluded.lineup_moves,
    acquisitions_by_week_json=excluded.acquisitions_by_week_json,wins=excluded.wins,losses=excluded.losses,points_for=excluded.points_for,
    final_rank=excluded.final_rank,playoff_seed=excluded.playoff_seed,fetched_at=excluded.fetched_at`);
  const upPick = db.prepare(`INSERT INTO raw_league_pick VALUES (@l,@s,@n,@tid,@name,@pos,@price,@oid,@owner,@now)
    ON CONFLICT(league_id,season,pick_no) DO UPDATE SET team_id=excluded.team_id,name=excluded.name,pos=excluded.pos,price=excluded.price,
    owner_id=excluded.owner_id,owner=excluded.owner,fetched_at=excluded.fetched_at`);
  // NAMED COLUMNS, for the same reason `upSeason` uses them and for one more. `home_score`/
  // `away_score` reach an EXISTING store through db.ts's ALTER path and a FRESH one through
  // schema.sql, and a positional `VALUES (...)` would (a) throw "6 values for an 8 column table" the
  // moment the columns exist and (b) before that, silently drop the scores off the end. Naming the
  // columns is what makes the score survive the write instead of being discarded by the statement.
  //
  // `@hs`/`@as` are NULL wherever the adaptor did not report a number. NULL is the honest value for
  // an unplayed week; writing 0 there would be a real, terrible score that nothing downstream could
  // distinguish from a genuine shutout.
  const upGame = db.prepare(`INSERT OR REPLACE INTO raw_league_matchup
      (league_id, season, week, home_id, away_id, fetched_at, home_score, away_score)
    VALUES (@l,@s,@w,@h,@a,@now,@hs,@as)`);
  const upDiv = db.prepare(`INSERT OR REPLACE INTO raw_league_division VALUES (@l,@s,@d,@name,@ids,@now)`);
  const delGames = db.prepare(`DELETE FROM raw_league_matchup WHERE league_id=@l AND season=@s`);
  const delDivs = db.prepare(`DELETE FROM raw_league_division WHERE league_id=@l AND season=@s`);

  const counts: LeagueHistoryCounts = { seasons: 0, available: 0, teams: 0, picks: 0, games: 0, divisions: 0 };
  db.transaction(() => {
    for (const s of seasons) {
      upSeason.run({
        l: leagueId, s: s.season, a: s.available ? 1 : 0, size: s.size ?? null, b: s.auctionBudget ?? null,
        ppr: s.pprPoints ?? null, slots: JSON.stringify(s.slotCounts ?? {}), note: s.note ?? null, now: fetchedAt,
        rw: s.format?.regWeeks ?? null, pt: s.format?.playoffTeams ?? null,
        prw: s.format?.playoffRoundWeeks ?? null,
        prs: s.format ? (s.format.playoffReseed ? 1 : 0) : null,
        sr: s.format?.seedingRule ?? null, dc: s.format?.divisionCount ?? null,
      });
      counts.seasons++;
      if (s.available) counts.available++;
      for (const t of s.teams ?? []) {
        upTeam.run({
          l: leagueId, s: s.season, id: String(t.id), name: t.name, oid: t.ownerId, owner: t.owner,
          acq: t.acquisitions, faab: t.faabSpent, drops: t.drops, trades: t.trades, moves: t.lineupMoves,
          abw: JSON.stringify(t.acquisitionsByWeek ?? {}), w: t.wins, lo: t.losses, pf: t.pointsFor,
          fr: t.finalRank, ps: t.playoffSeed, now: fetchedAt,
        });
        counts.teams++;
      }
      // pick_no IS the order the source returned. Not a rank, not a bid order -- ESPN's array index.
      (s.picks ?? []).forEach((p, i) => {
        upPick.run({
          l: leagueId, s: s.season, n: i + 1, tid: String(p.teamId), name: p.name, pos: p.pos, price: p.price,
          oid: p.ownerId ?? null, owner: p.owner ?? null, now: fetchedAt,
        });
        counts.picks++;
      });
      const sched = schedules?.[String(s.season)];
      if (sched) {
        // REPLACE the season's schedule, do not accumulate into it. `INSERT OR REPLACE` is keyed on
        // (league_id, season, week, home_id, away_id), so a schedule that CHANGES -- which is exactly
        // what happens when a commissioner shortens the regular season -- leaves every superseded
        // pairing behind as a ghost row. Re-ingesting 2026 after the 2026-09 change turned 104 games
        // into 166, with team 14 playing twice in week 1 and no error anywhere.
        delGames.run({ l: leagueId, s: s.season });
        delDivs.run({ l: leagueId, s: s.season });
        for (const g of sched.games) {
          upGame.run({
            l: leagueId, s: s.season, w: g.week, h: String(g.homeId), a: String(g.awayId), now: fetchedAt,
            // `?? null` and NOT `?? 0`: an absent score is an unplayed (or un-ingested) week, and
            // better-sqlite3 rejects `undefined` as a bound parameter outright, so the coalesce is
            // load-bearing as well as semantic.
            hs: g.homeScore ?? null, as: g.awayScore ?? null,
          });
          counts.games++;
        }
        for (const d of sched.divisions) { upDiv.run({ l: leagueId, s: s.season, d: String(d.id), name: d.name, ids: JSON.stringify(d.teamIds), now: fetchedAt }); counts.divisions++; }
      }
    }
  })();
  return counts;
}

/**
 * THE SAME THREE RAW TABLES, FOR A YAHOO SNAKE (M2e).
 *
 * WHY IT IS NOT `loadLeagueHistory`. That function's input is a `SeasonSnapshot`, which is ESPN's
 * season payload flattened: every behaviour and outcome field on `SeasonTeam` is a `number`, because
 * ESPN's `mTeam` view publishes all of them. Yahoo's draft page publishes a team NAME and nothing
 * else -- no wins, no points for, no acquisitions, no owner, no final rank -- so building a
 * `SeasonSnapshot` here would mean writing a plausible number (0 wins, $0 FAAB) into every one of
 * those columns, which is indistinguishable on the row from having read it. They are written NULL,
 * and this is the function that says so.
 *
 * WHAT IS AND IS NOT WRITTEN, column by column:
 *   raw_league_season       available=1, size=teams, note=the caller's provenance line.
 *                           auction_budget NULL and ppr_points NULL -- A SNAKE HAS NO BUDGET, and the
 *                           scoring rules live in `settings.config`, not here. The per-season format
 *                           columns (reg_weeks, playoff_teams, ...) are NULL: the draft page carries
 *                           no calendar, and this league's format is read from the settings page by
 *                           `yahooSettingsFromHtml`, which is the only thing that has seen it.
 *   raw_league_team_season  league_id/season/team_id/name only. Everything else NULL, per above.
 *   raw_league_pick         pick_no = the OVERALL pick number (which for a snake IS the array index,
 *                           exactly as for ESPN), team_id, name, pos. price NULL -- not 0: a snake
 *                           pick has no price, and a zero would be a real price that happens to be
 *                           free. owner_id/owner NULL -- Yahoo's draft page names the TEAM, not the
 *                           manager.
 *
 * It writes ONLY the seasons it is given, and only for `leagueId`; no other league's rows are read
 * or touched.
 */
export interface YahooDraftSeasonRows {
  season: number;
  teams: { teamId: string; name: string }[];
  /** slot -> count, for `slots_remaining` in fact_draft_pick. `{}` when the season's roster template
   *  is not known (a prior season whose settings page is no longer served), which leaves that column
   *  NULL rather than filled from this season's template. */
  slotCounts: Record<string, number>;
  picks: { pickNo: number; teamId: string; name: string; pos: string | null }[];
  note: string;
}

export function loadYahooDraftHistory(
  db: DB, leagueId: string, seasons: YahooDraftSeasonRows[], fetchedAt: string,
): LeagueHistoryCounts {
  const upSeason = db.prepare(`INSERT INTO raw_league_season
      (league_id, season, available, size, auction_budget, ppr_points, slot_counts_json, note, fetched_at)
    VALUES (@l,@s,1,@size,NULL,NULL,@slots,@note,@now)
    ON CONFLICT(league_id,season) DO UPDATE SET available=1,size=excluded.size,auction_budget=NULL,
    ppr_points=NULL,slot_counts_json=excluded.slot_counts_json,note=excluded.note,fetched_at=excluded.fetched_at`);
  const upTeam = db.prepare(`INSERT INTO raw_league_team_season
      (league_id, season, team_id, name, fetched_at)
    VALUES (@l,@s,@id,@name,@now)
    ON CONFLICT(league_id,season,team_id) DO UPDATE SET name=excluded.name,fetched_at=excluded.fetched_at`);
  const upPick = db.prepare(`INSERT INTO raw_league_pick
      (league_id, season, pick_no, team_id, name, pos, price, owner_id, owner, fetched_at)
    VALUES (@l,@s,@n,@tid,@name,@pos,NULL,NULL,NULL,@now)
    ON CONFLICT(league_id,season,pick_no) DO UPDATE SET team_id=excluded.team_id,name=excluded.name,
    pos=excluded.pos,price=NULL,fetched_at=excluded.fetched_at`);
  // REPLACE THE SEASON'S PICKS, do not accumulate into them. Same hazard as the schedule above: a
  // season re-read after the roster template changed (2025 had 15 rounds, 2026 has 17) would leave
  // rounds 16-17 behind as ghosts of the other year.
  const delPicks = db.prepare("DELETE FROM raw_league_pick WHERE league_id=@l AND season=@s");

  const counts: LeagueHistoryCounts = { seasons: 0, available: 0, teams: 0, picks: 0, games: 0, divisions: 0 };
  db.transaction(() => {
    for (const s of seasons) {
      upSeason.run({ l: leagueId, s: s.season, size: s.teams.length, slots: JSON.stringify(s.slotCounts), note: s.note, now: fetchedAt });
      counts.seasons++; counts.available++;
      for (const t of s.teams) { upTeam.run({ l: leagueId, s: s.season, id: t.teamId, name: t.name, now: fetchedAt }); counts.teams++; }
      delPicks.run({ l: leagueId, s: s.season });
      for (const p of s.picks) {
        upPick.run({ l: leagueId, s: s.season, n: p.pickNo, tid: p.teamId, name: p.name, pos: p.pos, now: fetchedAt });
        counts.picks++;
      }
    }
  })();
  return counts;
}

/** Read back what landed, per season. The cross-check the loader script did by hand, as a function
 *  so the ingest verb and the test assert on the same numbers. */
export function readBackLeagueHistory(db: DB, leagueId: string): SeasonCheck[] {
  return db.prepare(
    `SELECT s.season, s.available,
       (SELECT COUNT(*) FROM raw_league_team_season t WHERE t.league_id=s.league_id AND t.season=s.season) AS teams,
       (SELECT COUNT(*) FROM raw_league_pick p WHERE p.league_id=s.league_id AND p.season=s.season) AS picks,
       (SELECT COALESCE(SUM(price),0) FROM raw_league_pick p WHERE p.league_id=s.league_id AND p.season=s.season) AS total,
       (SELECT COUNT(*) FROM raw_league_matchup m WHERE m.league_id=s.league_id AND m.season=s.season) AS games,
       (SELECT owner FROM raw_league_team_season t WHERE t.league_id=s.league_id AND t.season=s.season AND t.final_rank=1) AS champion
     FROM raw_league_season s WHERE s.league_id=? ORDER BY s.season`,
  ).all(leagueId) as SeasonCheck[];
}

/**
 * Fetch through the adaptor and load. READ-ONLY against ESPN: `history()` and `matchups()` are GETs
 * through the app's logged-in session, and nothing here connects to a draft room.
 *
 * A season whose schedule read fails keeps its season/team/pick rows -- the schedule is a separate
 * ESPN view and one gated view must not discard the auction prices that came back fine.
 */
export async function ingestLeagueHistory(opts: { dbPath?: string; seasons: number[]; leagueId?: string }): Promise<{ counts: LeagueHistoryCounts; checks: SeasonCheck[] }> {
  const { openLeague } = await import("../league/index.js");
  const { resolveLeagueContext, requirePlatform } = await import("./leagueContext.js");
  // RESOLVE ONCE, AND REFUSE THE WRONG PLATFORM BEFORE ANY FETCH. The old code opened the league by
  // one rule and stamped rows with another; the id used for the fetch and the id used for the write
  // are now the same variable, and a non-ESPN league is refused by name rather than filled with ESPN
  // data under its own id.
  const leagueId = (() => {
    const db = openDb(opts.dbPath);
    try { return requirePlatform(resolveLeagueContext(db, opts.leagueId), "espn", "ingest league-history"); }
    finally { db.close(); }
  })();
  const lg = await openLeague({ dbPath: opts.dbPath, leagueId });
  try {
    if (!lg.provider.history) throw new Error(`the ${lg.provider.platform} adaptor exposes no history()`);
    const snaps = await lg.provider.history(opts.seasons);
    const schedules: Record<string, LeagueSchedule> = {};
    for (const s of snaps) {
      if (!s.available || !lg.provider.matchups) continue;
      // A missing schedule is recorded by its ABSENCE from raw_league_matchup, not by an exception:
      // ESPN gates the mMatchup view on some old seasons while still serving the draft.
      try { schedules[String(s.season)] = await lg.provider.matchups(s.season); } catch { /* season keeps its other rows */ }
    }
    const db = openDb(opts.dbPath);
    try {
      const counts = loadLeagueHistory(db, leagueId, snaps, schedules, nowIso());
      return { counts, checks: readBackLeagueHistory(db, leagueId) };
    } finally { db.close(); }
  } finally { await lg.close(); }
}
