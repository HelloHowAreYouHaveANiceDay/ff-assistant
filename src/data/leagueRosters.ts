/**
 * EVERY WEEK'S ROSTER AND STARTING LINEUP FOR THIS LEAGUE, as a reproducible RAW asset.
 *
 * WHAT WAS MISSING. `raw_league_*` holds the auction, the finish and the schedule, plus per-team
 * activity COUNTS. It does not hold who was on which roster in which week, nor who was started --
 * which is every in-season decision this tool makes. Without those rows a lineup recommendation and
 * a waiver recommendation can be argued about but not scored.
 *
 * WHICH ESPN ENDPOINT, AND WHY NOT THE OBVIOUS ONE. Four shapes were probed against this league
 * (scripts/inseason-probe*.mjs, all read-only and cached):
 *
 *   leagueHistory + mRoster + scoringPeriodId   IGNORES scoringPeriodId. Weeks 1, 3, 8 and 14 of
 *                                               2020 return byte-identical rosters AND identical
 *                                               starters. It is the FINAL roster, wearing a week
 *                                               number. Using it would have produced a lineup
 *                                               backtest in which nobody ever changed their lineup.
 *   leagueHistory + mBoxscore                   `rosterForCurrentScoringPeriod` comes back EMPTY.
 *   /seasons/{Y}/ + mBoxscore + scoringPeriodId  WORKS, for past seasons as well as the current one.
 *                                               Real per-week lineup slots and the week's applied
 *                                               points, and the starters genuinely move week to week.
 *   /seasons/{Y}/ + mMatchup + mMatchupScore     Same rows, larger payload.
 *
 * So the loader reads the boxscore view on the `/seasons/` path. The lesson generalises: `leagueHistory`
 * is not simply "the same API for old seasons", and a view that answers with a plausible object is
 * not the same as a view that answers the question asked.
 *
 * RAW MEANS RAW. A row carries ESPN's player id, the name ESPN printed, the position id ESPN
 * assigned and the lineup slot id ESPN recorded. Nothing here joins to `stg_player`; identity is
 * resolved in `src/features/sources/rosterState.ts`, by ESPN id through `player_xref`.
 *
 * `as_of` IS THE SCORING PERIOD'S DATE RANGE, from `raw_nfl_game`. A week's lineup is settled at the
 * last kickoff of that week and is not knowable before the first one, so both ends are stored and
 * `as_of` is the LAST kickoff -- the point by which every fact in the row is true. A point-in-time
 * consumer for week w may read rows with `as_of` strictly before week w's FIRST kickoff and no other.
 * Where the schedule is unknown both are NULL, which says "we cannot date this" rather than guessing.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../db/db.js";
import { bridgeFetch } from "../browser/appBridge.js";
import { DATA_ROOT } from "./paths.js";
import { ESPN_READS_BASE as HOST } from "./espnApi.js";
import { round3 } from "../round3.js";


/** ESPN's defaultPositionId -> position. Same table the league adaptor uses; duplicated rather than
 *  imported because espn.ts is the adaptor for the LIVE league and this is a history ingester -- the
 *  two are allowed to diverge, and a shared constant would make that divergence silent. */
const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
/** Bench and injured reserve. Everything else on a roster row is a STARTING slot. 21 is IR, 23 is
 *  FLEX -- getting those two backwards would count every flex start as a bench week. */
export const BENCH_SLOT = 20;
export const IR_SLOT = 21;
export const isStarterSlot = (slotId: number): boolean => slotId !== BENCH_SLOT && slotId !== IR_SLOT;

export interface RosterWeekRow {
  season: number; week: number; teamId: string;
  espnPlayerId: string; name: string; position: string;
  lineupSlotId: number; isStarter: number; appliedPoints: number | null;
  acquisitionType: string | null; acquisitionDate: string | null;
  /** The NFL team he played for that week, where the platform publishes it. Identity, not display --
   *  see `raw_league_roster_week.pro_team`. ESPN's boxscore ingester leaves it null. */
  proTeam?: string | null;
}

export interface RosterWeekFetch {
  season: number; week: number;
  available: boolean;
  note: string | null;
  rows: RosterWeekRow[];
}

// -------------------------------------------------------------------------------------------
// FETCH + CACHE
// -------------------------------------------------------------------------------------------

/** Where a fetched ESPN payload is parked. Gzipped: a boxscore week is ~1.1MB of JSON and a full
 *  sweep is 140 of them, which is 150MB uncompressed and about a tenth of that on disk. */
export function espnCachePath(key: string): string {
  const dir = join(DATA_ROOT, "cache", "espn");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.json.gz`);
}

/**
 * A CACHED PAYLOAD IS ONLY AS GOOD AS THE MOMENT IT WAS CAPTURED, and for a boxscore that moment
 * has to be AFTER the week stopped changing.
 *
 * `espnGet` used to return any cache file that existed, forever. That is correct for a settled
 * week -- its rosters, slots and points are immutable -- and silently wrong for every week that had
 * not finished when the file was written. ESPN answers a FUTURE `scoringPeriodId` with the roster as
 * it stands RIGHT NOW, so `box-<lg>-<season>-w9` fetched in September is a September snapshot of a
 * November lineup, parked under a key that claims to be November's.
 *
 * MEASURED, and this is why the rule exists: every one of league 462233's eighteen 2026 boxscores
 * was captured 2026-09-09 22:52, before week 1 had been played. Nine days and several lineup
 * changes later, `ingest-raw league-rosters` still re-read those files, still reported
 * "26,863 rows", and still wrote a week-2 lineup starting a quarterback who had been benched --
 * a green run that changed nothing, which is this repo's most expensive bug shape.
 *
 * `freshAfter` is the fix and it is a DATE, not a TTL: a TTL expires a settled week forever (it is
 * immutable, so re-fetching it is pure cost) and keeps a live week for however long the TTL is. The
 * caller states the instant after which a capture is trustworthy, and only a file older than that is
 * refetched. Absent, behaviour is exactly as before, so every other caller is unchanged.
 */
export function cacheCapturedAt(key: string): Date | null {
  const f = espnCachePath(key);
  return existsSync(f) ? statSync(f).mtime : null;
}

/**
 * One cached GET through the app's logged-in ESPN session.
 *
 * A cache hit costs nothing and makes the whole sweep re-runnable offline, which is what lets the
 * tests below run against real payloads with no network and no session.
 */
export async function espnGet(
  key: string, url: string, headers?: Record<string, string>, opts?: { freshAfter?: Date | null },
): Promise<unknown> {
  const f = espnCachePath(key);
  const fresh = opts?.freshAfter ?? null;
  const captured = existsSync(f) ? statSync(f).mtime : null;
  if (captured && !(fresh && captured < fresh)) return JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
  const txt = await bridgeFetch(url, headers, 60000);
  let j: unknown;
  try { j = JSON.parse(txt); } catch { throw new Error(`ESPN returned non-JSON for ${key}: ${txt.slice(0, 160)}`); }
  writeFileSync(f, gzipSync(Buffer.from(JSON.stringify(j), "utf8")));
  return j;
}

/** ESPN answers some league endpoints with a one-element ARRAY and others with the object. */
export const espnRoot = (j: unknown): Record<string, unknown> =>
  (Array.isArray(j) ? (j[0] ?? {}) : (j ?? {})) as Record<string, unknown>;

interface BoxEntry { playerId?: number; lineupSlotId?: number; playerPoolEntry?: { appliedStatTotal?: number; player?: { fullName?: string; defaultPositionId?: number } } }
interface BoxSide { teamId?: number; rosterForCurrentScoringPeriod?: { entries?: BoxEntry[] } }
interface BoxMatchup { matchupPeriodId?: number; home?: BoxSide; away?: BoxSide }

/**
 * PURE: one week's boxscore payload -> roster rows.
 *
 * Exported so the tests parse real cached payloads through exactly the code the ingester uses. A
 * parser tested only against a fixture it also wrote proves nothing about ESPN.
 */
export function parseRosterWeek(payload: unknown, season: number, week: number): RosterWeekFetch {
  const j = espnRoot(payload);
  const schedule = (j.schedule ?? []) as BoxMatchup[];
  const sides: BoxSide[] = [];
  for (const m of schedule) {
    if (Number(m.matchupPeriodId) !== week) continue;
    for (const s of [m.home, m.away]) if (s && s.teamId != null) sides.push(s);
  }
  if (!sides.length) {
    return { season, week, available: false, rows: [],
      note: `no matchup for scoring period ${week} -- the season's games had ended, or ESPN served no schedule` };
  }
  const rows: RosterWeekRow[] = [];
  let empty = 0;
  for (const side of sides) {
    const entries = side.rosterForCurrentScoringPeriod?.entries ?? [];
    if (!entries.length) { empty++; continue; }
    for (const e of entries) {
      if (e.playerId == null) continue;
      const pl = e.playerPoolEntry?.player ?? {};
      const slot = Number(e.lineupSlotId ?? -1);
      rows.push({
        season, week, teamId: String(side.teamId),
        espnPlayerId: String(e.playerId),
        name: pl.fullName ?? "",
        position: ESPN_POS[pl.defaultPositionId ?? -1] ?? "?",
        lineupSlotId: slot,
        isStarter: isStarterSlot(slot) ? 1 : 0,
        appliedPoints: e.playerPoolEntry?.appliedStatTotal ?? null,
        // ESPN publishes these only for the CURRENT season and returns null for every history row.
        // Recorded as null rather than derived, because a derived acquisition date in a raw table is
        // indistinguishable from a published one.
        acquisitionType: null,
        acquisitionDate: null,
      });
    }
  }
  const note = empty ? `${empty} of ${sides.length} sides carried no roster for this week` : null;
  return { season, week, available: rows.length > 0, rows, note };
}

/** Fetch (or read from cache) one season-week. READ-ONLY: a GET through the app's session. */
export async function fetchRosterWeek(
  leagueId: string, season: number, week: number, opts?: { freshAfter?: Date | null },
): Promise<RosterWeekFetch> {
  const url = `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mBoxscore`;
  try {
    const payload = await espnGet(`box-${leagueId}-${season}-w${week}`, url, undefined, { freshAfter: opts?.freshAfter ?? null });
    return parseRosterWeek(payload, season, week);
  } catch (e) {
    return { season, week, available: false, rows: [], note: String((e as Error).message).slice(0, 160) };
  }
}

/**
 * THE INSTANT AFTER WHICH A CAPTURE OF THIS WEEK'S PAYLOAD CAN BE TRUSTED.
 *
 * Shared by the boxscore sweep and the transaction sweep: both ask ESPN for one scoring period, and
 * both get an answer that keeps changing until that period's last game has been played.
 *
 * A week stops changing once its last kickoff is behind us, so a capture is trustworthy only if it
 * was taken AFTER that -- and a day of slack is added because the last game of a week kicks off in
 * the evening US time and finishes in the NEXT UTC day, so a file stamped with the kickoff date
 * itself may well have been written while that game was still being played.
 *
 * A week whose last kickoff is today or later has not settled at all, so nothing cached for it is
 * trustworthy and the answer is "now" -- i.e. always refetch. Returning null means the store has no
 * schedule for that week and freshness cannot be judged; the caller then keeps the old
 * cache-forever behaviour rather than hammering ESPN on a guess.
 */
export function weekPayloadFreshAfter(kick: Map<string, { first: string; last: string }>, season: number, week: number, today = new Date()): Date | null {
  const k = kick.get(`${season}|${week}`);
  if (!k?.last) return null;
  const day = today.toISOString().slice(0, 10);
  if (k.last >= day) return today;                       // in progress or still to come: never cache
  const settled = new Date(`${k.last}T00:00:00.000Z`);
  settled.setUTCDate(settled.getUTCDate() + 1);          // one day of slack past the last kickoff
  return settled;
}

// -------------------------------------------------------------------------------------------
// LOAD
// -------------------------------------------------------------------------------------------

export interface RosterWeekCounts {
  weeks: number; available: number; rows: number; starters: number;
  /** Rows deleted because the man is no longer on that week's roster. See the DELETE in the writer. */
  removed: number;
}

/** The week's kickoff window, from `raw_nfl_game`. NULL where the schedule is not in the store. */
export function weekKickoffs(db: DB): Map<string, { first: string; last: string }> {
  const out = new Map<string, { first: string; last: string }>();
  for (const r of db.prepare(
    `SELECT season, week, MIN(gameday) AS first, MAX(gameday) AS last FROM raw_nfl_game
      WHERE gameday IS NOT NULL AND gameday <> '' AND game_type='REG' GROUP BY season, week`,
  ).all() as { season: number; week: number; first: string; last: string }[]) {
    out.set(`${r.season}|${r.week}`, { first: r.first, last: r.last });
  }
  return out;
}

/** Upsert already-fetched weeks. Pure with respect to the network, like `loadLeagueHistory`. */
export function loadLeagueRosterWeeks(db: DB, leagueId: string, weeks: RosterWeekFetch[], fetchedAt: string): RosterWeekCounts {
  const kick = weekKickoffs(db);
  // COLUMNS ARE NAMED, not positional. `pro_team` is added to an existing store by `addColumns`
  // (i.e. at the END) and declared in schema.sql for a fresh one; a positional VALUES list would
  // silently write different columns on the two if those orders ever parted company.
  const up = db.prepare(
    `INSERT INTO raw_league_roster_week
       (league_id, season, week, team_id, espn_player_id, name, position, lineup_slot_id, is_starter,
        applied_points, acquisition_type, acquisition_date, as_of, as_of_start, as_of_end, fetched_at, pro_team)
     VALUES (@l,@s,@w,@t,@p,@name,@pos,@slot,@st,@pts,@at,@ad,@aof,@a0,@a1,@now,@team)
     ON CONFLICT(league_id,season,week,team_id,espn_player_id) DO UPDATE SET
       name=excluded.name, position=excluded.position, lineup_slot_id=excluded.lineup_slot_id,
       is_starter=excluded.is_starter, applied_points=excluded.applied_points,
       acquisition_type=excluded.acquisition_type, acquisition_date=excluded.acquisition_date,
       as_of=excluded.as_of, as_of_start=excluded.as_of_start, as_of_end=excluded.as_of_end,
       fetched_at=excluded.fetched_at, pro_team=excluded.pro_team`);
  /**
   * A PLAYER WHO IS NO LONGER ON THE ROSTER MUST LEAVE IT, and an upsert alone cannot say so.
   *
   * `ON CONFLICT ... DO UPDATE` can only add or amend a row; nothing in it removes one. So every man
   * ever seen in a (league, season, week) stayed in that week forever, carrying whatever
   * `is_starter` and `lineup_slot_id` he had the last time he WAS there. Once the boxscore cache
   * began serving fresh payloads this surfaced immediately: league 462233's week 2 held 13 men and
   * NINE starters for a 12-man, 8-start roster -- a dropped receiver still seated in a FLEX slot he
   * had vacated days earlier. The store's own guard caught it (`roster size is not 12`,
   * `starter count is not 8`), which is the only reason it is a fixed bug and not a silent one.
   *
   * SCOPED, and deliberately narrowly: only a week the fetch actually RETURNED is reconciled. A week
   * that came back unavailable -- a network failure, an expired session, a season whose games have
   * ended -- deletes nothing, because "ESPN told us nobody is on this roster" and "we could not ask"
   * are the same empty list, and treating the second as the first would erase real history.
   *
   * THE KEY IS (TEAM, PLAYER), NOT PLAYER. Keying the keep-set on `espn_player_id` alone looks right
   * and quietly misses the commonest case there is: a man who CHANGED TEAMS inside the league. He is
   * still somewhere in the week's payload, so a player-keyed delete keeps BOTH his new row and the
   * stale one on his old roster, and the team he left keeps starting him. That is exactly how league
   * 462233's week 2 held a receiver in a FLEX slot on a team that had traded him away -- the first
   * version of this delete ran, reported 112 rows removed, and left him there.
   */
  const del = db.prepare(
    `DELETE FROM raw_league_roster_week
      WHERE league_id=@l AND season=@s AND week=@w
        AND (team_id || '|' || espn_player_id) NOT IN (SELECT value FROM json_each(@keep))`);
  const c: RosterWeekCounts = { weeks: 0, available: 0, rows: 0, starters: 0, removed: 0 };
  db.transaction(() => {
    for (const wk of weeks) {
      const k = kick.get(`${wk.season}|${wk.week}`) ?? null;
      c.weeks++;
      if (wk.available) c.available++;
      if (wk.available && wk.rows.length) {
        c.removed += del.run({
          l: leagueId, s: wk.season, w: wk.week,
          keep: JSON.stringify(wk.rows.map((r) => `${r.teamId}|${r.espnPlayerId}`)),
        }).changes;
      }
      for (const r of wk.rows) {
        up.run({
          l: leagueId, s: r.season, w: r.week, t: r.teamId, p: r.espnPlayerId, name: r.name, pos: r.position,
          slot: r.lineupSlotId, st: r.isStarter, pts: r.appliedPoints, at: r.acquisitionType, ad: r.acquisitionDate,
          aof: k?.last ?? null, a0: k?.first ?? null, a1: k?.last ?? null, now: fetchedAt, team: r.proTeam ?? null,
        });
        c.rows++;
        if (r.isStarter) c.starters++;
      }
    }
  })();
  return c;
}

// -------------------------------------------------------------------------------------------
// THE COMPLETENESS GUARD
// -------------------------------------------------------------------------------------------

export interface RosterWeekCheck {
  season: number; weeks: number; teamWeeks: number; rows: number;
  minRoster: number; maxRoster: number; modeRoster: number;
  offSize: number;                 // team-weeks whose roster size is not the season's mode
  minStarters: number; maxStarters: number; modeStarters: number;
  offStarters: number;
}

/**
 * Per-season roster completeness, read back from the store.
 *
 * WHAT THIS IS FOR. A silently truncated fetch -- a gated view, a session that lapsed mid-sweep, a
 * playoff week where half the league is absent -- produces rows that look exactly like real ones.
 * The roster SIZE is the signal that cannot be faked: this league starts 8 and rosters 13 (2018-2025)
 * or 12 (2026), every team, every week, and a team-week that disagrees is either a real ESPN quirk
 * worth naming or a broken fetch. `offSize` is the count of disagreements, and `checkRosterWeeks`
 * below turns it into a pass/fail with the tolerance stated.
 */
export function readBackRosterWeeks(db: DB, leagueId: string): RosterWeekCheck[] {
  const rows = db.prepare(
    `SELECT season, week, team_id, COUNT(*) AS n, SUM(is_starter) AS st
       FROM raw_league_roster_week WHERE league_id=? GROUP BY season, week, team_id ORDER BY season, week, team_id`,
  ).all(leagueId) as { season: number; week: number; team_id: string; n: number; st: number }[];
  const bySeason = new Map<number, { n: number[]; st: number[]; weeks: Set<number> }>();
  for (const r of rows) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, { n: [], st: [], weeks: new Set() });
    const b = bySeason.get(r.season)!;
    b.n.push(r.n); b.st.push(r.st); b.weeks.add(r.week);
  }
  const mode = (xs: number[]): number => {
    const c = new Map<number, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    let best = 0, bn = -1;
    for (const [v, n] of c) if (n > bn) { best = v; bn = n; }
    return best;
  };
  const out: RosterWeekCheck[] = [];
  for (const [season, b] of [...bySeason.entries()].sort((a, z) => a[0] - z[0])) {
    const mn = mode(b.n), ms = mode(b.st);
    out.push({
      season, weeks: b.weeks.size, teamWeeks: b.n.length, rows: b.n.reduce((s, x) => s + x, 0),
      minRoster: Math.min(...b.n), maxRoster: Math.max(...b.n), modeRoster: mn,
      offSize: b.n.filter((x) => x !== mn).length,
      minStarters: Math.min(...b.st), maxStarters: Math.max(...b.st), modeStarters: ms,
      offStarters: b.st.filter((x) => x !== ms).length,
    });
  }
  return out;
}

export interface GuardFinding { season: number; what: string; got: number; limit: number }

/**
 * THE GUARD. Fails when a season's roster sizes are not overwhelmingly one number.
 *
 * THE TWO TOLERANCES ARE DIFFERENT AND THAT IS THE POINT. Roster SIZE is a league rule: this league
 * rosters 13 (2018-2025) or 12 (2026), every team, every week, and a team-week that disagrees is
 * either an ESPN quirk worth naming or a truncated fetch. STARTER COUNT is a manager's choice --
 * leaving a slot empty on a bye week is a thing people really do -- so a single tolerance forces one
 * of the two checks to be wrong. Measured on the landed rows, 2019 has 18 of 224 team-weeks (8.0%)
 * with fewer than eight starters and its roster sizes are 13 in every single one; a shared 5%
 * tolerance failed that season for a reason that is not a data defect.
 *
 * The size tolerance is deliberately tight enough that a truncated fetch cannot pass: half a
 * league's rosters missing is 50% off, not 2%.
 */
export function checkRosterWeeks(checks: RosterWeekCheck[], tolerance = 0.05, starterTolerance = 0.15): GuardFinding[] {
  const bad: GuardFinding[] = [];
  for (const c of checks) {
    if (!c.teamWeeks) { bad.push({ season: c.season, what: "no team-weeks at all", got: 0, limit: 1 }); continue; }
    const fSize = c.offSize / c.teamWeeks;
    const fStart = c.offStarters / c.teamWeeks;
    if (fSize > tolerance) bad.push({ season: c.season, what: `roster size is not ${c.modeRoster} in too many team-weeks`, got: round3(fSize), limit: tolerance });
    if (fStart > starterTolerance) bad.push({ season: c.season, what: `starter count is not ${c.modeStarters} in too many team-weeks`, got: round3(fStart), limit: starterTolerance });
  }
  return bad;
}

// -------------------------------------------------------------------------------------------
// THE VERB
// -------------------------------------------------------------------------------------------

/** NFL scoring periods in a season. 17 games through 2020, 18 from 2021. Playoff weeks included:
 *  this league plays through week 16 and the rows are wanted for those weeks too. */
export const weeksInSeason = (season: number): number => (season >= 2021 ? 18 : 17);

/**
 * Fetch and load. READ-ONLY against ESPN, one request at a time, with a pause between them.
 *
 * A season that returns nothing keeps its status rows -- "we asked and ESPN had none" is a fact, and
 * a sweep that aborts on the first empty week can never establish where the coverage ends.
 */
/**
 * THE WEEKS OF `season` THAT ARE FULLY PLAYED as of `today` -- the only weeks a non-ESPN adaptor is
 * asked for (WP9).
 *
 * WHY THE CUT IS THE LAST KICKOFF AND NOT THE FIRST. Yahoo's team page for a week in progress renders
 * the locked lineup with PARTIAL points, and a partial total is indistinguishable in the store from a
 * final one -- the D18 seed would score the week and hand the simulator a set of standings built on
 * half a Sunday. Same definition of "settled" as `loadSimContext`'s, deliberately: a week whose last
 * NFL game day is strictly before today. (`feat_player_week` scoring is the seed's SECOND condition
 * and stays there; this one is about what is safe to WRITE.)
 */
export function settledWeeks(db: DB, season: number, today: string): number[] {
  const out: number[] = [];
  for (const r of db.prepare(
    "SELECT week, MAX(gameday) AS last FROM raw_nfl_game WHERE season=? AND game_type='REG' AND gameday IS NOT NULL AND gameday<>'' GROUP BY week ORDER BY week",
  ).all(season) as { week: number; last: string }[]) {
    if (!(r.last < today)) break;                 // contiguous from week 1
    out.push(r.week);
  }
  return out;
}

/**
 * INGEST THROUGH THE PLATFORM SEAM, for a platform whose adaptor implements `rosterWeek` (WP9).
 *
 * `loadLeagueRosterWeeks` is shared with the ESPN path on purpose: the columns, the `as_of` stamping
 * from `raw_nfl_game` and the conflict clause are one piece of code, so a Yahoo row cannot end up a
 * different SHAPE from an ESPN one. What differs is only where the rows came from.
 *
 * The rows a non-ESPN adaptor cannot supply are NULL and say so here rather than being invented:
 * `acquisition_type`/`acquisition_date` are ESPN-only (Yahoo publishes acquisitions on a separate
 * page under a different key, and deriving them here would put a join in the raw layer).
 */
export async function ingestPlatformRosterWeeks(opts: {
  dbPath?: string; leagueId?: string; season?: number; weeks?: number[]; pauseMs?: number; today?: string;
}): Promise<{ counts: RosterWeekCounts; checks: RosterWeekCheck[]; findings: GuardFinding[]; weeks: number[]; platform: string }> {
  const { resolveLeagueContext } = await import("./leagueContext.js");
  const { platformFor } = await import("../league/platform.js");
  const db = openDb(opts.dbPath);
  try {
    const ctx = resolveLeagueContext(db, opts.leagueId);
    const leagueId = ctx.leagueId;
    if (!leagueId) throw new Error("ingest platform roster-weeks: no league resolved.");
    const plat = await platformFor(ctx.platformRaw);
    if (!plat.rosterWeek) {
      throw new Error(`ingest roster-weeks: the "${plat.id}" adaptor has no rosterWeek capability. Nothing was written -- a league whose platform cannot supply a week's started lineup must be refused by name, never filled in from another source.`);
    }
    const season = opts.season ?? ctx.rowSeason ?? ctx.config.season;
    const weeks = opts.weeks ?? settledWeeks(db, season, opts.today ?? localDate());
    if (!weeks.length) return { counts: { weeks: 0, available: 0, rows: 0, starters: 0, removed: 0 }, checks: readBackRosterWeeks(db, leagueId), findings: [], weeks: [], platform: plat.id };
    const { resolveIOFor } = await import("../league/session.js");
    // Through the PLATFORM, so a sessionless one gets a plain fetch rather than the app bridge.
    const io = resolveIOFor(plat, { timeoutMs: 40000 });
    const pause = opts.pauseMs ?? 400;
    const fetched: RosterWeekFetch[] = [];
    for (const week of weeks) {
      const rows = await plat.rosterWeek(io, leagueId, season, week);
      fetched.push({
        season, week, available: rows.length > 0, note: null,
        rows: rows.map((r) => ({
          season, week, teamId: r.teamId, espnPlayerId: r.platformPlayerId, name: r.name, position: r.position,
          lineupSlotId: r.lineupSlotId, isStarter: r.isStarter ? 1 : 0, appliedPoints: r.appliedPoints,
          acquisitionType: null, acquisitionDate: null, proTeam: r.proTeam ?? null,
        })),
      });
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
    const counts = loadLeagueRosterWeeks(db, leagueId, fetched, nowIso());
    const checks = readBackRosterWeeks(db, leagueId);
    return { counts, checks, findings: checkRosterWeeks(checks), weeks, platform: plat.id };
  } finally { db.close(); }
}

/** LOCAL date, YYYY-MM-DD. Same spelling as `rosterState.localDate`; duplicated rather than imported
 *  because rosterState imports THIS module and a cycle here would be a startup failure. */
function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function ingestLeagueRosters(opts: { dbPath?: string; seasons: number[]; pauseMs?: number; leagueId?: string; refetch?: boolean })
  : Promise<{
    counts: RosterWeekCounts; checks: RosterWeekCheck[]; findings: GuardFinding[];
    /** Live weeks that actually came back from ESPN. NOT the number attempted -- see the loop. */
    refetched: number;
    /** Live weeks that were attempted and FAILED, and so were served from stale cache. */
    failed: number;
    /** The distinct reasons those fetches failed, for the caller to print. */
    failNotes: string[];
  }> {
  const { resolveLeagueContext, requirePlatform } = await import("./leagueContext.js");
  const db = openDb(opts.dbPath);
  try {
    // The id the ESPN URLs are built from IS the id every row is stamped with -- and a non-ESPN
    // league is refused here, before the first fetch.
    const leagueId = requirePlatform(resolveLeagueContext(db, opts.leagueId), "espn", "ingest league-rosters", "syncRosters");
    const pause = opts.pauseMs ?? 600;
    const fetched: RosterWeekFetch[] = [];
    // AN UNSETTLED WEEK IS REFETCHED, a settled one is served from cache -- see `weekPayloadFreshAfter`.
    // The count is reported rather than assumed: "0 refetched" on a live week is the signature of the
    // bug this replaced, and it is only visible if the number is printed.
    const kick = weekKickoffs(db);
    let refetched = 0;
    // ATTEMPTED IS NOT FETCHED, AND THE OLD COUNT CONFLATED THEM. `refetched` counted `willFetch`,
    // i.e. the INTENTION to go to the network, and `fetchRosterWeek` swallows every failure into
    // `{available:false, note}` so it can keep going. So on 2026-09-23, with the desktop app shut
    // down, all sixteen live weeks FAILED with "app bridge not available", every read silently fell
    // back to a four-hour-old cache, and the run cheerfully printed "16 week(s) refetched from
    // ESPN". The owner spotted the stale lineup; nothing in the pipeline did.
    //
    // A wrapper that reports success is indistinguishable from a command that succeeded. So count
    // what actually came back, and carry the failures' reasons out for the caller to print.
    let failed = 0;
    const failNotes = new Set<string>();
    for (const season of opts.seasons) {
      for (let w = 1; w <= weeksInSeason(season); w++) {
        const before = Date.now();
        const key = `box-${leagueId}-${season}-w${w}`;
        const freshAfter = opts.refetch ? new Date() : weekPayloadFreshAfter(kick, season, w);
        const captured = cacheCapturedAt(key);
        const willFetch = !captured || (freshAfter != null && captured < freshAfter);
        const got = await fetchRosterWeek(leagueId, season, w, { freshAfter });
        if (willFetch) {
          if (got.available) refetched++;
          else { failed++; if (got.note) failNotes.add(got.note); }
        }
        fetched.push(got);
        if (willFetch && Date.now() - before < pause) await new Promise((r) => setTimeout(r, pause));
      }
    }
    const counts = loadLeagueRosterWeeks(db, leagueId, fetched, nowIso());
    const checks = readBackRosterWeeks(db, leagueId);
    return { counts, checks, findings: checkRosterWeeks(checks), refetched, failed, failNotes: [...failNotes] };
  } finally { db.close(); }
}
