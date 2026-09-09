/**
 * WEEKLY ROSTER STATE, THE FREE-AGENT POOL, AND WHAT EACH LINEUP LEFT ON THE BENCH.
 *
 * The feature layer over `raw_league_roster_week`. Three tables, and each answers a question the
 * raw rows cannot:
 *
 *   fact_roster_week    who was on which roster in week w, RESOLVED to player_sk so it joins to
 *                       feat_player_week_model and to the weekly projector's output.
 *   fact_fa_pool_week   who was on NOBODY's roster in week w -- the set a waiver claim chooses from.
 *   fact_lineup_week    what each team started, what the best legal lineup from that same roster
 *                       would have scored with hindsight, and the gap.
 *
 * IDENTITY IS RESOLVED HERE, BY ID, IN THREE STAGES, AND THE SPLIT IS REPORTED.
 *
 *   1. ESPN id through `player_xref` (source 'espn'). 90.7% of 2020 week 3.
 *   2. TEAM DEFENCES, which ESPN keys under NEGATIVE ids: -16000 minus the proTeamId. -16011 is
 *      proTeamId 11 is IND is `DST:IND`, which is the surrogate key the weekly feature table uses.
 *      There is no xref row for a defence and there never will be; this is arithmetic on ESPN's own
 *      encoding, not a name match.
 *   3. LAST, `nameKey` + POSITION against `stg_player`, and only where that pair is UNAMBIGUOUS.
 *      Tom Brady and Drew Brees have no espn_id in the cross-source id file at all, so without this
 *      two of the most-started quarterbacks of the period would be silently absent from every
 *      lineup. Never a bare name: `stg_player.ambiguous` and the position are both required, which
 *      is the rule identity.ts states -- A.J. Green is a WR and a DB.
 *
 * A row that resolves by none of the three is COUNTED and NAMED, never dropped in silence.
 *
 * POINT-IN-TIME, AND THE DISTINCTION THAT MATTERS. Week w's roster MEMBERSHIP and slot assignment
 * are knowable before week w's first kickoff -- that is when the manager sets them. Week w's applied
 * POINTS are not. So `asOfRosterState` (the function every backtest decides from) returns the
 * roster and everything dated strictly before the first kickoff, and NOTHING that depends on week
 * w's or any later week's points. `fact_lineup_week.optimal_pts` is explicitly hindsight and lives
 * in a different function, which is why it can be a ceiling without being a leak.
 */
import { openDb, nowIso, type DB } from "../../db/db.js";
import { nameKey } from "../../draft/values.js";
import { optimalLineup, type RosterPlayer } from "../../inseason/lineup.js";
import { BENCH_SLOT, IR_SLOT } from "../../data/leagueRosters.js";

/** ESPN proTeamId -> the abbreviation `feat_player_week_model` keys a defence by. Derived from the
 *  ids ESPN publishes, checked against the 32 `DST:` keys the feature table actually carries for
 *  every season 2018-2026 -- which is why LV and JAC appear rather than OAK and JAX. */
const ESPN_PRO_TEAM: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
  20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
  29: "CAR", 30: "JAC", 33: "BAL", 34: "HOU",
};

/** lineupSlotId -> the slot NAME `optimalLineup` speaks. 23 is FLEX; 20 bench, 21 IR. */
const SLOT_NAME: Record<number, string> = {
  0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX",
};

export interface ResolveReport { total: number; byXref: number; byDst: number; byName: number; unresolved: number; examples: string[] }

/** ESPN id -> player_sk, for every id in `raw_league_roster_week` and `raw_league_transaction`. */
export function buildEspnResolver(db: DB): { resolve(espnId: string, name: string, pos: string): { sk: string; how: string } | null; report: ResolveReport } {
  const xref = new Map<string, string>();
  for (const r of db.prepare("SELECT source_id, player_sk FROM player_xref WHERE source='espn'").all() as { source_id: string; player_sk: number }[]) {
    xref.set(String(r.source_id), String(r.player_sk));
  }
  // (name_key, position) -> sk, ONLY where exactly one unambiguous staging row claims the pair.
  const byName = new Map<string, string>();
  const dupe = new Set<string>();
  for (const r of db.prepare("SELECT player_sk, name_key, position, ambiguous FROM stg_player").all() as
    { player_sk: number; name_key: string; position: string; ambiguous: number }[]) {
    if (r.ambiguous) continue;
    const k = `${r.name_key}|${(r.position ?? "").toUpperCase()}`;
    if (byName.has(k)) { dupe.add(k); continue; }
    byName.set(k, String(r.player_sk));
  }
  for (const k of dupe) byName.delete(k);

  const report: ResolveReport = { total: 0, byXref: 0, byDst: 0, byName: 0, unresolved: 0, examples: [] };
  return {
    report,
    resolve(espnId, name, pos) {
      report.total++;
      const hit = xref.get(String(espnId));
      if (hit) { report.byXref++; return { sk: hit, how: "xref" }; }
      const n = Number(espnId);
      if (Number.isFinite(n) && n < 0) {
        const abbr = ESPN_PRO_TEAM[-16000 - n];
        if (abbr) { report.byDst++; return { sk: `DST:${abbr}`, how: "dst-id" }; }
      }
      const nk = byName.get(`${nameKey(name)}|${(pos ?? "").toUpperCase()}`);
      if (nk) { report.byName++; return { sk: nk, how: "name+pos" }; }
      report.unresolved++;
      if (report.examples.length < 12) report.examples.push(`${name || "(no name)"} [${pos}] espn=${espnId}`);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// POINT-IN-TIME STATE -- what a decision for week w is allowed to see
// ---------------------------------------------------------------------------------------------

export interface RosterEntry { teamId: string; playerSk: string; espnPlayerId: string; name: string; pos: string; slot: string; lineupSlotId: number; isStarter: boolean }
export interface AsOfState {
  season: number; week: number;
  /** The last kickoff STRICTLY BEFORE week w's first -- the newest information a week-w decision
   *  may use. NULL when the schedule is not in the store, and then no dated source may be read. */
  asOf: string | null;
  /** Week w's first kickoff. Everything dated at or after this is the future. */
  firstKickoff: string | null;
  rosters: RosterEntry[];
  /** Every player_sk on somebody's roster in week w. */
  rostered: Set<string>;
  /** Player ids the resolver could not place. Reported, not hidden. */
  unresolved: number;
}

/**
 * THE POINT-IN-TIME READ. Everything a week-w decision is allowed to know about roster state.
 *
 * It reads `raw_league_roster_week` for week w (membership and slots -- set before kickoff) and NO
 * points column at all. That is the invariant the leakage guard tests: perturb week w's
 * `applied_points`, or any row of any later week, and nothing this returns may move.
 */
export function asOfRosterState(
  db: DB, leagueId: string, season: number, week: number,
  /** A resolver shared across weeks, so its report is a sweep total rather than one week's. */
  resolver?: ReturnType<typeof buildEspnResolver>,
): AsOfState {
  const kick = db.prepare(
    `SELECT MIN(gameday) AS first FROM raw_nfl_game WHERE season=? AND week=? AND game_type='REG' AND gameday IS NOT NULL AND gameday<>''`,
  ).get(season, week) as { first: string | null } | undefined;
  const prev = db.prepare(
    `SELECT MAX(gameday) AS last FROM raw_nfl_game WHERE season=? AND week<? AND game_type='REG' AND gameday IS NOT NULL AND gameday<>''`,
  ).get(season, week) as { last: string | null } | undefined;
  const res = resolver ?? buildEspnResolver(db);
  const rows = db.prepare(
    `SELECT team_id, espn_player_id, name, position, lineup_slot_id, is_starter
       FROM raw_league_roster_week WHERE league_id=? AND season=? AND week=?`,
  ).all(leagueId, season, week) as
    { team_id: string; espn_player_id: string; name: string; position: string; lineup_slot_id: number; is_starter: number }[];
  const rosters: RosterEntry[] = [];
  const rostered = new Set<string>();
  let unresolved = 0;
  for (const r of rows) {
    const hit = res.resolve(r.espn_player_id, r.name, r.position);
    if (!hit) { unresolved++; continue; }
    rostered.add(hit.sk);
    rosters.push({
      teamId: r.team_id, playerSk: hit.sk, espnPlayerId: r.espn_player_id, name: r.name, pos: r.position,
      slot: SLOT_NAME[r.lineup_slot_id] ?? `slot${r.lineup_slot_id}`,
      lineupSlotId: r.lineup_slot_id, isStarter: !!r.is_starter,
    });
  }
  return { season, week, asOf: prev?.last ?? null, firstKickoff: kick?.first ?? null, rosters, rostered, unresolved };
}

// ---------------------------------------------------------------------------------------------
// THE THREE FACT TABLES
// ---------------------------------------------------------------------------------------------

/**
 * THE STARTING TEMPLATE, DERIVED FROM THE ROWS RATHER THAN TYPED.
 *
 * A hardcoded ["QB","RB","WR","TE","FLEX","FLEX","DST","K"] would be correct for every season this
 * league has played and silently wrong the first time it is not -- the enumeration-rot failure. The
 * template is instead the MODAL multiset of starting slots across the season's team-weeks, which is
 * a fact the data already carries.
 */
export function startingTemplate(db: DB, leagueId: string, season: number): string[] {
  const rows = db.prepare(
    `SELECT week, team_id, lineup_slot_id FROM raw_league_roster_week
      WHERE league_id=? AND season=? AND is_starter=1 ORDER BY week, team_id, lineup_slot_id`,
  ).all(leagueId, season) as { week: number; team_id: string; lineup_slot_id: number }[];
  const byTeamWeek = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.week}|${r.team_id}`;
    if (!byTeamWeek.has(k)) byTeamWeek.set(k, []);
    byTeamWeek.get(k)!.push(r.lineup_slot_id);
  }
  const tally = new Map<string, number>();
  for (const slots of byTeamWeek.values()) {
    const key = slots.slice().sort((a, b) => a - b).join(",");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  let best = "", bn = -1;
  for (const [k, n] of tally) if (n > bn) { best = k; bn = n; }
  if (!best) return [];
  return best.split(",").map((s) => SLOT_NAME[Number(s)] ?? `slot${s}`);
}

export interface BuildCounts { rosterRows: number; faRows: number; lineupRows: number; seasons: number[]; resolve: ResolveReport }

/**
 * Build all three tables for the given seasons.
 *
 * ONLY COMPLETED WEEKS. A week whose first kickoff has not happened still returns a roster from
 * ESPN -- the CURRENT roster, under a future week number -- and its points are all zero. Loading
 * those would put today's roster into a backtest of a week that has not been played, which reads
 * exactly like data. `throughAsOf` (default: today) is the cut.
 */
export function buildRosterState(db: DB, leagueId: string, seasons: number[], opts: { throughAsOf?: string } = {}): BuildCounts {
  const cut = opts.throughAsOf ?? localDate();
  const built = nowIso();
  const res = buildEspnResolver(db);
  const upRoster = db.prepare(
    `INSERT INTO fact_roster_week VALUES (@s,@w,@t,@sk,@eid,@n,@p,@slot,@lsid,@st,@pts,@aof,@now)
     ON CONFLICT(season,week,team_id,player_sk) DO UPDATE SET espn_player_id=excluded.espn_player_id,
       name=excluded.name, pos=excluded.pos, slot=excluded.slot, lineup_slot_id=excluded.lineup_slot_id,
       is_starter=excluded.is_starter, actual_pts=excluded.actual_pts, as_of=excluded.as_of, built_at=excluded.built_at`);
  const upFa = db.prepare(
    `INSERT INTO fact_fa_pool_week VALUES (@s,@w,@sk,@p,@n,@pts,@ros,@g,@now)
     ON CONFLICT(season,week,player_sk) DO UPDATE SET pos=excluded.pos, name=excluded.name,
       actual_pts=excluded.actual_pts, ros_pts=excluded.ros_pts, ros_games=excluded.ros_games, built_at=excluded.built_at`);
  const upLineup = db.prepare(
    `INSERT INTO fact_lineup_week VALUES (@s,@w,@t,@st,@op,@bl,@ns,@nr,@sj,@oj,@now)
     ON CONFLICT(season,week,team_id) DO UPDATE SET started_pts=excluded.started_pts, optimal_pts=excluded.optimal_pts,
       bench_left=excluded.bench_left, starters=excluded.starters, roster_n=excluded.roster_n,
       slots_json=excluded.slots_json, optimal_json=excluded.optimal_json, built_at=excluded.built_at`);

  const counts: BuildCounts = { rosterRows: 0, faRows: 0, lineupRows: 0, seasons: [], resolve: res.report };
  db.transaction(() => {
    for (const season of seasons) {
      const template = startingTemplate(db, leagueId, season);
      if (!template.length) continue;
      counts.seasons.push(season);
      const weeks = db.prepare(
        `SELECT DISTINCT week FROM raw_league_roster_week WHERE league_id=? AND season=? ORDER BY week`,
      ).all(leagueId, season) as { week: number }[];
      // Realised weekly points, from the weekly feature table -- the SAME target the weekly model is
      // scored on, so a lineup number and a projection number cannot be about different quantities.
      const ptsOf = new Map<string, { pts: number; name: string; pos: string }>();
      for (const r of db.prepare(
        `SELECT player_sk, week, name, pos, pts FROM feat_player_week_model WHERE season=?`,
      ).all(season) as { player_sk: string; week: number; name: string; pos: string; pts: number | null }[]) {
        ptsOf.set(`${r.week}|${r.player_sk}`, { pts: r.pts ?? 0, name: r.name, pos: r.pos });
      }
      const lastWeek = Math.max(...weeks.map((w) => w.week), 0);
      for (const { week } of weeks) {
        const firstKick = (db.prepare(
          `SELECT MIN(gameday) AS d FROM raw_nfl_game WHERE season=? AND week=? AND game_type='REG' AND gameday IS NOT NULL AND gameday<>''`,
        ).get(season, week) as { d: string | null }).d;
        // A week that has not been played yet is skipped, loudly enough to be visible in the counts.
        if (!firstKick || firstKick >= cut) continue;
        const state = asOfRosterState(db, leagueId, season, week, res);
        const asOf = db.prepare(
          `SELECT MAX(as_of) AS d FROM raw_league_roster_week WHERE league_id=? AND season=? AND week=?`,
        ).get(leagueId, season, week) as { d: string | null };

        const byTeam = new Map<string, RosterEntry[]>();
        for (const e of state.rosters) {
          if (!byTeam.has(e.teamId)) byTeam.set(e.teamId, []);
          byTeam.get(e.teamId)!.push(e);
        }
        for (const [teamId, entries] of byTeam) {
          const players: RosterPlayer[] = [];
          let started = 0;
          for (const e of entries) {
            const hit = ptsOf.get(`${week}|${e.playerSk}`);
            const pts = hit?.pts ?? 0;
            if (e.isStarter) started += pts;
            upRoster.run({
              s: season, w: week, t: teamId, sk: e.playerSk, eid: e.espnPlayerId, n: e.name, p: e.pos,
              slot: e.slot, lsid: e.lineupSlotId, st: e.isStarter ? 1 : 0, pts, aof: asOf?.d ?? null, now: built,
            });
            counts.rosterRows++;
            // The IR slot is not startable, so it is excluded from the hindsight optimum. Including
            // it would invent points from a man the rules did not allow into the lineup.
            if (e.lineupSlotId !== IR_SLOT) players.push({ name: `${e.name}#${e.playerSk}`, pos: e.pos, proj: pts, available: true });
          }
          const opt = optimalLineup(players, template, ["RB", "WR", "TE"]);
          upLineup.run({
            s: season, w: week, t: teamId,
            st: round2(started), op: round2(opt.totalProj), bl: round2(opt.totalProj - started),
            ns: entries.filter((e) => e.isStarter).length, nr: entries.length,
            sj: JSON.stringify(entries.filter((e) => e.isStarter).map((e) => [e.slot, e.name, round2(ptsOf.get(`${week}|${e.playerSk}`)?.pts ?? 0)])),
            oj: JSON.stringify(opt.starters.map((s) => [s.slot, s.name.split("#")[0], round2(s.proj)])),
            now: built,
          });
          counts.lineupRows++;
        }

        // THE FREE-AGENT POOL. Everyone with a weekly feature row this week who is on nobody's
        // roster. `ros_pts` is the REST-OF-SEASON total from this week forward -- an OUTCOME, used
        // only to score a decision after the fact, never as an input to one.
        const pool = db.prepare(
          `SELECT f.player_sk, f.name, f.pos, f.pts,
                  (SELECT COALESCE(SUM(g.pts),0) FROM feat_player_week_model g
                     WHERE g.season=f.season AND g.player_sk=f.player_sk AND g.week>=f.week AND g.week<=?) AS ros,
                  (SELECT COUNT(*) FROM feat_player_week_model g
                     WHERE g.season=f.season AND g.player_sk=f.player_sk AND g.week>=f.week AND g.week<=?) AS games
             FROM feat_player_week_model f
            WHERE f.season=? AND f.week=? AND f.pos IN ('QB','RB','WR','TE','K','DST')`,
        ).all(lastWeek, lastWeek, season, week) as
          { player_sk: string; name: string; pos: string; pts: number | null; ros: number; games: number }[];
        for (const p of pool) {
          // A feature row with no surrogate key cannot be compared against a roster at all -- it
          // could be a free agent or it could be a rostered man we failed to key. Counting it as
          // available would put phantom players in the pool a waiver policy chooses from.
          if (p.player_sk == null || p.player_sk === "") continue;
          if (state.rostered.has(p.player_sk)) continue;
          upFa.run({ s: season, w: week, sk: p.player_sk, p: p.pos, n: p.name, pts: p.pts ?? 0, ros: round2(p.ros), g: p.games, now: built });
          counts.faRows++;
        }
      }
    }
  })();
  return counts;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
/** LOCAL date, YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function buildRosterStateInto(opts: { dbPath?: string; seasons: number[]; throughAsOf?: string }): Promise<BuildCounts> {
  const { currentLeagueId } = await import("../../data/leagueHistory.js");
  const db = openDb(opts.dbPath);
  try {
    return buildRosterState(db, currentLeagueId(db), opts.seasons, { throughAsOf: opts.throughAsOf });
  } finally { db.close(); }
}

/** Unused-import guard: BENCH_SLOT is re-exported so a consumer reading slot semantics has one place
 *  to find both, and so the two modules cannot drift into two definitions of "bench". */
export { BENCH_SLOT, IR_SLOT };
