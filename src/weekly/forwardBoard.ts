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
import { fetchCsvCached, canonTeam, pick, URLS, cacheTag, playerWeekUrl } from "../data/nflverse.js";
import { normPos } from "../data/stgPlayer.js";
import { buildSkResolver } from "../data/skResolve.js";
import { loadSchedule, buildForwardInto, WEEKLY_POS } from "./features.js";
import { readFileSync, existsSync } from "node:fs";

const featKey = (sk: string | null, nk: string, pos: string) => sk ?? `NK:${nk}|${pos}`;

/** One player-week of raw usage, exactly the four quantities the to-date ratios average. */
interface Usage { fd: number; ts: number; att: number; ry: number }

const numOf = (s: string | undefined): number => { const n = Number(s); return Number.isFinite(n) ? n : 0; };

/**
 * PER-WEEK USAGE FOR THE LIVE SEASON, keyed the way feat_player_week is keyed (WP17).
 *
 * `td_fd` / `td_ts` / `td_attempts` / `td_rush_yards` are the to-date MEANS of these four, and this
 * builder used to write all four as a literal NULL with a comment saying they "feed only
 * zero-coefficient columns under the shipped season-line-only artifact". That stopped being true
 * when the weekly model started carrying them: all four are in the SHIPPED weekly artifact's feature
 * list (`SHIPPED_WEEKLY_ARTIFACT`, named only in src/weekly/projector.ts), and the M2h serve-time
 * ablation measured the live cost of the hole.
 *
 * It is the SAME feed and the SAME arithmetic as the historical builder (src/features/build.ts,
 * `buildWeekFeatures`), deliberately -- the live week and a backtested week must not mean different
 * things by the same column. `refresh` bypasses the disk cache, because the live season's file gains
 * a week every Tuesday and a cached copy is last week's answer wearing this week's name.
 */
async function liveUsageByWeek(db: DB, season: number): Promise<{ byKey: Map<string, Map<number, Usage>>; feedRows: number; feedWeeks: number[] }> {
  const resolver = buildSkResolver(db);
  let rows: Record<string, string>[];
  try { rows = await fetchCsvCached(playerWeekUrl(season), cacheTag.playerWeek(season), true); }
  catch { return { byKey: new Map(), feedRows: 0, feedWeeks: [] }; }
  const byKey = new Map<string, Map<number, Usage>>();
  const weeks = new Set<number>();
  let feedRows = 0;
  for (const r of rows) {
    if (pick(r, "season_type") !== "REG") continue;
    const name = pick(r, "player_display_name"); if (!name) continue;
    const pos = normPos(pick(r, "position").toUpperCase());
    if (!WEEKLY_POS.includes(pos)) continue;
    const wk = Number(pick(r, "week")); if (!wk) continue;
    feedRows++; weeks.add(wk);
    const sk = resolver.resolve({ gsis: pick(r, "player_id"), name, pos, team: canonTeam(pick(r, "team")) });
    const key = featKey(sk, nameKey(name), pos);
    (byKey.get(key) ?? byKey.set(key, new Map()).get(key)!).set(wk, {
      fd: numOf(r.receiving_first_downs) + numOf(r.rushing_first_downs),
      ts: numOf(r.target_share), att: numOf(r.attempts), ry: numOf(r.rushing_yards),
    });
  }
  return { byKey, feedRows, feedWeeks: [...weeks].sort((a, b) => a - b) };
}

/**
 * THE POSITIVE CONTROL THE ABLATION SHOWED WAS MISSING (WP17).
 *
 * A usage column that is 100% NULL for the live week reads exactly like a feed that has not
 * published yet -- both are a legal serve value under D19, and nothing warned for the whole of the
 * 2026 season so far. The one state that is NOT legal is the feed having rows for a settled week
 * while the column derived from it is empty: that is a broken join, a renamed CSV header, or an
 * accumulator that never ran, and it must fail loudly rather than serve a hole.
 *
 * It is a pure function of counts so that BOTH directions can be driven in a test: injected empty
 * columns against a live feed MUST throw, and the real numbers MUST pass. A guard that can only ever
 * refuse is dead code that reads exactly like a guard that is passing.
 */
export function assertUsageWired(x: {
  what: string; season: number; feedRows: number; feedWeeks: number[];
  /** Rows that have at least one game to date, i.e. rows the column CAN be non-null on. */
  rowsWithGames: number;
  /** Of those, how many carry the derived column. */
  rowsWithColumn: number;
}): void {
  if (x.feedRows === 0 || x.rowsWithGames === 0) return;   // nothing published yet: NULL is honest
  if (x.rowsWithColumn > 0) return;
  throw new Error(
    `${x.what}: the ${x.season} feed has ${x.feedRows} rows over week(s) ${x.feedWeeks.join(",")} and ` +
    `${x.rowsWithGames} board rows have a game to date, yet NONE carries the derived column. ` +
    "That is a broken join or a renamed source column, not an unpublished feed -- refusing to serve " +
    "a silently empty usage column (WP17; see docs/weekly-missingness-ablation-2026-09-16.md).");
}

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

/** What a forward board rebuild did, including the live-week availability refresh (WP17). `live`
 *  carries a `note` rather than throwing: a skip must be VISIBLE, not silent. */
export interface ForwardBoardResult {
  season: number; weekRows: number; modelRows: number; keys: number; maxWeek: number; withPts: number;
  live: { snapRows: number; contextRows: number; withSnap: number; withRoute: number; note: string | null };
}

/**
 * Build feat_player_week for the CURRENT season across all REG weeks (board population x schedule),
 * merge the settled actuals as `pts`, then rebuild feat_player_week_model from it. Returns the row
 * counts and the universe size so a caller can assert it matches the stream table.
 */
export async function buildForwardBoard(opts: {
  dbPath?: string; season?: number; actualsPath?: string;
}): Promise<ForwardBoardResult> {
  const db = openDb(opts.dbPath);
  try {
    return await buildForwardBoardInto(db, opts);
  } finally { db.close(); }
}

export async function buildForwardBoardInto(db: DB, opts: {
  season?: number; actualsPath?: string;
}): Promise<ForwardBoardResult> {
  const season = opts.season ?? getConfig(db).season;
  // JUSTIFIED dataPath (WP3 grep): the INCUMBENT default of `opts.actualsPath`. `ff sync-actuals`
  // now writes the FORMAT's current-actuals and hands this function that exact path, so the live
  // board is rebuilt from the same file the same format just scored.
  const actualsPath = opts.actualsPath ?? dataPath("current-actuals.csv");
  const now = nowIso();

  const sched = await loadSchedule([season]);
  const { cell, maxWeek } = await scheduleCells(season);
  const actuals = loadCurrentActuals(actualsPath);
  const usage = await liveUsageByWeek(db, season);

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

  let weekRows = 0, withPts = 0, rowsWithGames = 0, rowsWithUsage = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM feat_player_week WHERE season = ?").run(season);
    for (const p of pop) {
      const played = actuals.get(p.feat_key);
      const use = usage.byKey.get(p.feat_key);
      // to-date sums, accumulated AFTER each row is written (no lookahead). `u` counts the games
      // the USAGE feed has for him, which can lag `g` by a week when the box score is in and the
      // player-week file has not rebuilt -- so the four ratios divide by their OWN denominator
      // rather than by the points denominator, which would silently shrink them.
      const acc = { pts: 0, g: 0, fd: 0, ts: 0, att: 0, ry: 0, u: 0 };
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
          // USAGE TO DATE (WP17): the same four ratios the historical builder writes, from the same
          // nflverse player-week feed, over the weeks already played. NULL before his first game --
          // an average over no games is not zero.
          tfd: acc.u ? acc.fd / acc.u : null, tts: acc.u ? acc.ts / acc.u : null,
          tatt: acc.u ? acc.att / acc.u : null, try: acc.u ? acc.ry / acc.u : null,
          pts, now,
        });
        weekRows++;
        if (acc.g) rowsWithGames++;
        if (acc.u) rowsWithUsage++;
        if (pts != null) { withPts++; acc.g++; acc.pts += pts; }
        const u = use?.get(wk);
        if (u) { acc.u++; acc.fd += u.fd; acc.ts += u.ts; acc.att += u.att; acc.ry += u.ry; }
      }
    }
  })();
  // The guard runs on what was WRITTEN, not on what was intended. See `assertUsageWired`.
  assertUsageWired({
    what: "forward board usage-to-date (td_fd/td_ts/td_attempts/td_rush_yards)",
    season, feedRows: usage.feedRows, feedWeeks: usage.feedWeeks,
    rowsWithGames, rowsWithColumn: rowsWithUsage,
  });

  // Rebuild feat_player_week_model through the CANONICAL live-season builder (the one `ff scorecard`
  // and the serve path use), so sync-actuals and the scorecard can never diverge on the board. It
  // reads the played `pts` this function just wrote into feat_player_week to derive the trailing form
  // -- the whole point of ingesting actuals -- and projects the board population forward from there.
  const wr = await buildForwardInto(db, { season });

  // ---- THE LIVE WEEK'S AVAILABILITY BLOCK (WP17). ----
  //
  // WHY IT IS HERE AND NOT IN A ROUTINE OF ITS OWN. The in-season scheduler can only run verbs the
  // tick has a handler for, and `build-live-context` is not one -- a routine naming it would sit in
  // the schedule looking enabled and be SKIPPED SILENTLY. The board rebuild is the one thing that
  // already runs every tick (`actuals` -> `ff sync-actuals`), and it is also the step that has just
  // created the universe the live context builder needs, so this is the seam where the two can
  // actually meet. `scripts/build-format-features.mjs --forward-only` calls the same function, so
  // the Yahoo store gets the identical treatment without a second spelling.
  //
  // THE ORDER IS LOAD-BEARING AND IT IS A CYCLE BROKEN BY ONE EXTRA PASS. `buildLiveWeekContextInto`
  // reads `feat_player_week_model` for the target week (the universe), and `buildForwardInto` reads
  // `feat_player_week_context` (the availability block). Run once, the model rows carry LAST tick's
  // context; the second pass is what puts this tick's into them.
  //
  // Everything here is best-effort and NAMED when it is skipped: a store without the live status
  // tables (a bare format features.db), an offline machine, or an nflverse asset that 404s must
  // degrade to the previous behaviour, not fail the actuals ingest. A silent skip is what this whole
  // work package exists to remove, so every skip prints its reason.
  const live = { snapRows: 0, contextRows: 0, withSnap: 0, withRoute: 0, note: null as string | null };
  try {
    const { ingestRawSnapCountsInto } = await import("../data/rawSources.js");
    const snapReport = await ingestRawSnapCountsInto(db, { seasons: [season], refresh: true });
    live.snapRows = snapReport.total;
  } catch (e) { live.note = `snap-count refresh skipped: ${String((e as Error).message).slice(0, 160)}`; }
  try {
    const { buildLiveWeekContextInto } = await import("../features/sources/weekContext.js");
    const ctx = buildLiveWeekContextInto(db, { season });
    live.contextRows = ctx.rows; live.withSnap = ctx.withSnap; live.withRoute = ctx.withRoute;
    if (ctx.skipped) live.note = `${live.note ? live.note + "; " : ""}live context skipped: ${ctx.skipped}`;
    else if (ctx.missingFeeds.length) live.note = `${live.note ? live.note + "; " : ""}${ctx.missingFeeds.join("; ")}`;
    if (!ctx.skipped) await buildForwardInto(db, { season });   // second pass: fold the block in
  } catch (e) { live.note = `${live.note ? live.note + "; " : ""}live context skipped: ${String((e as Error).message).slice(0, 160)}`; }

  return { season, weekRows, modelRows: wr.rows, keys: pop.length, maxWeek, withPts, live };
}
