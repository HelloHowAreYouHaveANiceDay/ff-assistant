// The FORWARD in-season board. The historical weekly builder (src/features/build.ts) is driven by
// ACTUALS: it emits feat_player_week rows only for weeks that were played, for players who appear in
// history-weekly.csv, capping at the last played week. That is correct for a backtest -- there is no
// future to project. But the LIVE season needs the opposite: a row for every projectable player in
// every REMAINING week, so the weekly projector and every in-season decision can look ahead to the
// playoff weeks. This builder writes that skeleton from the BOARD population x the schedule, and
// merges the settled actuals (a SEPARATE current-season file, so the backtest's history-weekly.csv --
// which is in the draft deps fingerprint -- is never touched) into it as `pts` for weeks already
// played. `pts` is NULL for unplayed weeks, which is exactly what a target-not-yet-known should be;
// buildInto then derives the trailing form from whatever `pts` are present.
//
// Population and identity come from feat_player_season (the board, already resolved), so this builder
// reproduces the SAME (season, week, feat_key) universe feat_player_week_stream carries -- the two
// stay join-compatible one-to-one, which is the invariant streamingFeatures.ts relies on.
import { openDb, getConfig, nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { nameKey } from "../draft/values.js";
import { fetchCsvCached, canonTeam, pick, URLS, cacheTag } from "../data/nflverse.js";
import { loadSchedule, buildForwardInto, WEEKLY_POS } from "./features.js";
import { readFileSync, existsSync } from "node:fs";

const featKey = (sk: string | null, nk: string, pos: string) => sk ?? `NK:${nk}|${pos}`;

interface SchedCell { opp: string | null; home: number; spread: number | null; total: number | null; implied: number | null; day: string | null }

/** (team|week) -> the fixture, plus the season's REG max week, from the schedules feed. */
async function scheduleCells(season: number): Promise<{ cell: Map<string, SchedCell>; maxWeek: number }> {
  const rows = await fetchCsvCached(URLS.schedules, cacheTag.schedules);
  const cell = new Map<string, SchedCell>();
  let maxWeek = 0;
  for (const g of rows) {
    if (Number(pick(g, "season")) !== season || pick(g, "game_type") !== "REG") continue;
    const wk = Number(pick(g, "week")); if (!wk) continue;
    if (wk > maxWeek) maxWeek = wk;
    const home = canonTeam(pick(g, "home_team")), away = canonTeam(pick(g, "away_team"));
    const day = pick(g, "gameday") || null;
    const sp = g.spread_line === "" || g.spread_line == null ? null : Number(g.spread_line);
    const tl = g.total_line === "" || g.total_line == null ? null : Number(g.total_line);
    const half = tl != null ? tl / 2 : null;
    // nflverse publishes spread_line from the HOME team's perspective (positive = home favoured) --
    // identical convention to src/features/build.ts, deliberately, so the two builders agree.
    cell.set(`${home}|${wk}`, { opp: away, home: 1, spread: sp, total: tl, implied: half != null && sp != null ? half + sp / 2 : null, day });
    cell.set(`${away}|${wk}`, { opp: home, home: 0, spread: sp != null ? -sp : null, total: tl, implied: half != null && sp != null ? half - sp / 2 : null, day });
  }
  return { cell, maxWeek };
}

/** feat_key -> (week -> pts), from the SEPARATE current-season actuals file (history-weekly columns). */
function loadCurrentActuals(path: string): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    // season,name,pos,week,points,team,player_sk
    const name = (f[1] ?? "").trim(), pos = (f[2] ?? "").toUpperCase();
    const week = Number(f[3]), pts = Number(f[4]);
    const sk = (f[6] ?? "").trim() || null;
    if (!name || !week || !Number.isFinite(pts)) continue;
    const key = featKey(sk, nameKey(name), pos);
    (out.get(key) ?? out.set(key, new Map()).get(key)!).set(week, pts);
  }
  return out;
}

const dayBefore = (iso: string): string => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 864e5).toISOString().slice(0, 10) : iso;
};

/**
 * Build feat_player_week for the CURRENT season across all REG weeks (board population x schedule),
 * merge the settled actuals as `pts`, then rebuild feat_player_week_model from it. Returns the row
 * counts and the universe size so a caller can assert it matches the stream table.
 */
export async function buildForwardBoard(opts: {
  dbPath?: string; season?: number; actualsPath?: string;
}): Promise<{ season: number; weekRows: number; modelRows: number; keys: number; maxWeek: number; withPts: number }> {
  const db = openDb(opts.dbPath);
  try {
    return await buildForwardBoardInto(db, opts);
  } finally { db.close(); }
}

export async function buildForwardBoardInto(db: DB, opts: {
  season?: number; actualsPath?: string;
}): Promise<{ season: number; weekRows: number; modelRows: number; keys: number; maxWeek: number; withPts: number }> {
  const season = opts.season ?? getConfig(db).season;
  // JUSTIFIED dataPath (WP3 grep): the INCUMBENT default of `opts.actualsPath`. `ff sync-actuals`
  // now writes the FORMAT's current-actuals and hands this function that exact path, so the live
  // board is rebuilt from the same file the same format just scored.
  const actualsPath = opts.actualsPath ?? dataPath("current-actuals.csv");
  const now = nowIso();

  const sched = await loadSchedule([season]);
  const { cell, maxWeek } = await scheduleCells(season);
  const actuals = loadCurrentActuals(actualsPath);

  const pop = (db.prepare(
    "SELECT feat_key, player_sk, name, pos, team FROM feat_player_season WHERE season = ?",
  ).all(season) as { feat_key: string; player_sk: string | null; name: string; pos: string; team: string | null }[])
    .filter((p) => WEEKLY_POS.includes(p.pos));

  const ins = db.prepare(
    `INSERT INTO feat_player_week (feat_key, player_sk, season, week, as_of, name, pos, team, opponent,
       home, spread_line, total_line, implied_team_total, is_bye, td_games, td_fd, td_ts, td_attempts,
       td_rush_yards, td_pts, pts, updated_at)
     VALUES (@key,@sk,@season,@week,@asOf,@name,@pos,@team,@opp,@home,@spread,@total,@implied,@bye,
             @tg,@tfd,@tts,@tatt,@try,@tpts,@pts,@now)
     ON CONFLICT(season, week, feat_key) DO UPDATE SET
       player_sk=excluded.player_sk, as_of=excluded.as_of, team=excluded.team, opponent=excluded.opponent,
       home=excluded.home, spread_line=excluded.spread_line, total_line=excluded.total_line,
       implied_team_total=excluded.implied_team_total, is_bye=excluded.is_bye, td_games=excluded.td_games,
       td_fd=excluded.td_fd, td_ts=excluded.td_ts, td_attempts=excluded.td_attempts,
       td_rush_yards=excluded.td_rush_yards, td_pts=excluded.td_pts, pts=excluded.pts,
       updated_at=excluded.updated_at`,
  );

  let weekRows = 0, withPts = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM feat_player_week WHERE season = ?").run(season);
    for (const p of pop) {
      const played = actuals.get(p.feat_key);
      const acc = { pts: 0, g: 0 };   // to-date sum, accumulated AFTER each row (no lookahead)
      for (let wk = 1; wk <= maxWeek; wk++) {
        const s = cell.get(`${p.team}|${wk}`);
        const anchor = s?.day ?? sched.weekAsOf.get(`${season}|${wk}`) ?? null;
        const pts = played?.get(wk) ?? null;
        ins.run({
          key: p.feat_key, sk: p.player_sk, season, week: wk,
          asOf: anchor ? dayBefore(anchor) : `${season}-09-01`,
          name: p.name, pos: p.pos, team: p.team,
          opp: s?.opp ?? null, home: s ? s.home : null,
          spread: s?.spread ?? null, total: s?.total ?? null, implied: s?.implied ?? null,
          bye: s ? 0 : 1,
          tg: acc.g, tpts: acc.g ? acc.pts / acc.g : null,
          // usage-to-date (first downs / target share / attempts / rush yards) is not threaded here;
          // it feeds only zero-coefficient columns under the shipped season-line-only artifact and is
          // left NULL rather than faked. buildInto derives the trailing-form MEAN it needs from `pts`.
          tfd: null, tts: null, tatt: null, try: null,
          pts, now,
        });
        weekRows++;
        if (pts != null) { withPts++; acc.g++; acc.pts += pts; }
      }
    }
  })();

  // Rebuild feat_player_week_model through the CANONICAL live-season builder (the one `ff scorecard`
  // and the serve path use), so sync-actuals and the scorecard can never diverge on the board. It
  // reads the played `pts` this function just wrote into feat_player_week to derive the trailing form
  // -- the whole point of ingesting actuals -- and projects the board population forward from there.
  const wr = await buildForwardInto(db, { season });
  return { season, weekRows, modelRows: wr.rows, keys: pop.length, maxWeek, withPts };
}
