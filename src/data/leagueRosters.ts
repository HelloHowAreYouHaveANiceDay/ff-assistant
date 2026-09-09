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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../db/db.js";
import { bridgeFetch } from "../browser/appBridge.js";
import { DATA_ROOT } from "./paths.js";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

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
 * One cached GET through the app's logged-in ESPN session.
 *
 * A cache hit costs nothing and makes the whole sweep re-runnable offline, which is what lets the
 * tests below run against real payloads with no network and no session.
 */
export async function espnGet(key: string, url: string, headers?: Record<string, string>): Promise<unknown> {
  const f = espnCachePath(key);
  if (existsSync(f)) return JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
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
export async function fetchRosterWeek(leagueId: string, season: number, week: number): Promise<RosterWeekFetch> {
  const url = `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mBoxscore`;
  try {
    return parseRosterWeek(await espnGet(`box-${leagueId}-${season}-w${week}`, url), season, week);
  } catch (e) {
    return { season, week, available: false, rows: [], note: String((e as Error).message).slice(0, 160) };
  }
}

// -------------------------------------------------------------------------------------------
// LOAD
// -------------------------------------------------------------------------------------------

export interface RosterWeekCounts { weeks: number; available: number; rows: number; starters: number }

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
  const up = db.prepare(
    `INSERT INTO raw_league_roster_week VALUES (@l,@s,@w,@t,@p,@name,@pos,@slot,@st,@pts,@at,@ad,@aof,@a0,@a1,@now)
     ON CONFLICT(league_id,season,week,team_id,espn_player_id) DO UPDATE SET
       name=excluded.name, position=excluded.position, lineup_slot_id=excluded.lineup_slot_id,
       is_starter=excluded.is_starter, applied_points=excluded.applied_points,
       acquisition_type=excluded.acquisition_type, acquisition_date=excluded.acquisition_date,
       as_of=excluded.as_of, as_of_start=excluded.as_of_start, as_of_end=excluded.as_of_end,
       fetched_at=excluded.fetched_at`);
  const upWeek = db.prepare(
    `INSERT INTO raw_league_roster_week_status VALUES (@l,@s,@w,@a,@n,@note,@now)
     ON CONFLICT(league_id,season,week) DO UPDATE SET available=excluded.available, rows=excluded.rows,
       note=excluded.note, fetched_at=excluded.fetched_at`);
  const c: RosterWeekCounts = { weeks: 0, available: 0, rows: 0, starters: 0 };
  db.transaction(() => {
    for (const wk of weeks) {
      const k = kick.get(`${wk.season}|${wk.week}`) ?? null;
      c.weeks++;
      if (wk.available) c.available++;
      upWeek.run({ l: leagueId, s: wk.season, w: wk.week, a: wk.available ? 1 : 0, n: wk.rows.length, note: wk.note, now: fetchedAt });
      for (const r of wk.rows) {
        up.run({
          l: leagueId, s: r.season, w: r.week, t: r.teamId, p: r.espnPlayerId, name: r.name, pos: r.position,
          slot: r.lineupSlotId, st: r.isStarter, pts: r.appliedPoints, at: r.acquisitionType, ad: r.acquisitionDate,
          aof: k?.last ?? null, a0: k?.first ?? null, a1: k?.last ?? null, now: fetchedAt,
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
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

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
export async function ingestLeagueRosters(opts: { dbPath?: string; seasons: number[]; pauseMs?: number })
  : Promise<{ counts: RosterWeekCounts; checks: RosterWeekCheck[]; findings: GuardFinding[] }> {
  const { currentLeagueId } = await import("./leagueHistory.js");
  const db = openDb(opts.dbPath);
  try {
    const leagueId = currentLeagueId(db);
    const pause = opts.pauseMs ?? 600;
    const fetched: RosterWeekFetch[] = [];
    for (const season of opts.seasons) {
      for (let w = 1; w <= weeksInSeason(season); w++) {
        const before = Date.now();
        const hit = existsSync(espnCachePath(`box-${leagueId}-${season}-w${w}`));
        fetched.push(await fetchRosterWeek(leagueId, season, w));
        if (!hit && Date.now() - before < pause) await new Promise((r) => setTimeout(r, pause));
      }
    }
    const counts = loadLeagueRosterWeeks(db, leagueId, fetched, nowIso());
    const checks = readBackRosterWeeks(db, leagueId);
    return { counts, checks, findings: checkRosterWeeks(checks) };
  } finally { db.close(); }
}
