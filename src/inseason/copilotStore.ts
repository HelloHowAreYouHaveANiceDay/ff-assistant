/**
 * THE STORE SIDE OF THE COPILOT -- everything the pure functions in copilot.ts refuse to read for
 * themselves.
 *
 * The split is deliberate. `copilot.ts` takes a `SimContext` plus plain arguments and returns JSON;
 * it opens no files and no database, so every function in it is testable on a fixture with no store,
 * no app and no league. The consequence is that somebody has to load the availability map, the depth
 * chart, the consensus values and the betting lines, and this is that somebody. Keeping it in one
 * file means there is exactly ONE definition of "what does the store say about who is out this week"
 * for the CLI and the MCP tools to share, rather than one per caller -- which is precisely how the
 * six hand-built sim contexts drifted before `loadSimContext` existed.
 *
 * Everything here is READ-ONLY. The database is opened `{ readonly: true }` on purpose: an in-season
 * recommendation surface has no business writing to the store, and the one write this track does
 * make -- the action-log row (D3) -- goes through the normal `openDb`/`logAction` path in the
 * callers, where it is visible.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { dataPath } from "../data/paths.js";
import { nameKey } from "../draft/values.js";
import type { VarianceModel } from "../draft/season.js";
import type { DepthEntry } from "./handcuff.js";
import { lineupNameKey, normalizeStatus, type AvailabilityMap, type GameRow, type Provenance } from "./copilot.js";
import { effectiveFormat } from "../league/index.js";
import { loadWeeklyRows } from "../weekly/features.js";
import { loadWeeklyArtifact, projectWeekly } from "../weekly/projector.js";
import { projectStreamingWith, formatServeTable, serveTable, type StreamDb } from "../weekly/streamingServe.js";
import type { WeeklyBand } from "./winprob.js";

const open = (dbPath?: string) => new Database(dbPath ?? dataPath("ff.db"), { readonly: true });

function configOf(db: import("better-sqlite3").Database): { season: number; regWeeks?: number; playoffTeams?: number; slots: string[]; flex_ok?: string[] } {
  const row = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
  if (!row) throw new Error("no config in settings -- run the app once, or `ff refresh`.");
  return JSON.parse(row.value);
}

/**
 * WHO CANNOT PLAY, from the two places the store records it.
 *
 * `player_status.injury_status` is the structured field (ESPN/nflverse: Out, IR, PUP, Questionable),
 * and `news` carries free-text injury rows from the aggregator. BOTH are read, because they arrive
 * on different refresh cycles and the one that is stale is not always the same one -- a designation
 * that only ever reached the news feed would otherwise be invisible to the lineup optimizer, which
 * is the failure this map exists to prevent.
 *
 * QUESTIONABLE IS NOT OUT and is deliberately still startable. A questionable starter plays more
 * often than he does not; benching every one of them costs more over a season than the occasional
 * zero, and the status is returned so a human can override on news the store does not have.
 */
export function loadAvailability(dbPath?: string): AvailabilityMap {
  const db = open(dbPath);
  const out: AvailabilityMap = new Map();
  try {
    for (const r of db.prepare("SELECT player_id, injury_status, injury_body FROM player_status WHERE injury_status IS NOT NULL").all() as { player_id: string; injury_status: string; injury_body: string | null }[]) {
      const status = normalizeStatus(r.injury_status);
      if (status === "ACTIVE") continue;
      out.set(r.player_id, { status, source: "player_status", detail: r.injury_body ?? r.injury_status });
    }
    // News rows only ever ESCALATE. A high-severity injury headline can rule a man out whose
    // structured status has not been refreshed yet; it must never quietly clear one who already is.
    for (const r of db.prepare("SELECT player_id, player_name, severity, detail FROM news WHERE category='injury'").all() as { player_id: string | null; player_name: string; severity: string; detail: string }[]) {
      if (String(r.severity).toLowerCase() !== "high") continue;
      const k = r.player_id ?? nameKey(r.player_name);
      if (!k) continue;
      const cur = out.get(k);
      if (cur?.status === "OUT") continue;
      out.set(k, { status: "OUT", source: "news(injury/high)", detail: String(r.detail ?? "").slice(0, 120) });
    }
  } finally { db.close(); }
  return out;
}

/** The depth chart + our projection, in the shape `handcuffBoard` wants, plus the positional pool
 *  sizes its injury tiers are fractions of. Mirrors `ff handcuffs` exactly so the two surfaces
 *  cannot report different boards. */
export function loadDepth(positions: string[], dbPath?: string): { depth: DepthEntry[]; poolSize: Record<string, number>; vm: VarianceModel } {
  const db = open(dbPath);
  try {
    const season = configOf(db).season;
    const rows = db.prepare(
      "SELECT b.row_json, s.depth_order AS depth FROM board b LEFT JOIN player_status s USING(player_id) WHERE b.season = ?",
    ).all(season) as { row_json: string; depth: number | null }[];
    const parsed = rows.map((r) => ({ j: JSON.parse(r.row_json) as Record<string, unknown>, depth: r.depth }));
    const poolSize: Record<string, number> = {};
    const poolRank = new Map<string, number>();
    for (const pos of positions) {
      const list = parsed.filter((p) => p.j.Pos === pos).sort((a, b) => (Number(b.j.ProjPts) || 0) - (Number(a.j.ProjPts) || 0));
      poolSize[pos] = list.length;
      list.forEach((p, i) => poolRank.set(String(p.j.Player), i));
    }
    const depth: DepthEntry[] = parsed.map((p) => ({
      name: String(p.j.Player), pos: String(p.j.Pos), team: String(p.j.Team ?? ""),
      depthOrder: p.depth, projPts: Number(p.j.ProjPts) || 0,
      rosteredPct: typeof p.j["Rostered%"] === "number" ? (p.j["Rostered%"] as number) : null,
      poolRank: poolRank.get(String(p.j.Player)) ?? null,
    }));
    const vm = JSON.parse(readFileSync(dataPath("variance-model.json"), "utf8")) as VarianceModel;
    return { depth, poolSize, vm };
  } finally { db.close(); }
}

/**
 * CONSENSUS VALUES for the trade finder, keyed by name so a player present under one spelling is not
 * silently valued at zero -- which would make every trade involving him look like a steal. The
 * board's own player_id is the join key everywhere else in this codebase and market_value uses it
 * too, so the id join comes first and the name key is the fallback.
 */
export function loadConsensusValues(dbPath?: string): Map<string, number> {
  const db = open(dbPath);
  try {
    const season = configOf(db).season;
    const byId = new Map<string, number>();
    for (const r of db.prepare("SELECT player_id, value FROM market_value").all() as { player_id: string; value: number | null }[]) {
      if (r.value != null) byId.set(r.player_id, Number(r.value));
    }
    const out = new Map<string, number>();
    for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(season) as { player_id: string; row_json: string }[]) {
      const v = byId.get(r.player_id);
      if (v == null) continue;
      out.set(nameKey(String((JSON.parse(r.row_json) as { Player: string }).Player)), v);
    }
    return out;
  } finally { db.close(); }
}

/** The NFL schedule with posted lines, for playoff SOS. */
export function loadGames(dbPath?: string): { games: GameRow[]; season: number; regWeeks: number } {
  const db = open(dbPath);
  try {
    const cfg = configOf(db);
    const games = db.prepare("SELECT week, team, opponent, home, spread_line FROM game WHERE season=?").all(cfg.season) as GameRow[];
    // FROM THE FORMAT BLOCK, not `?? 14`. Playoff SOS is computed off `regWeeks`, so a stale default
    // would score the wrong three weeks -- silently, and with a plausible-looking answer.
    return { games, season: cfg.season, regWeeks: effectiveFormat(cfg as never).regWeeks };
  } finally { db.close(); }
}

/** NFL team for any player name, so a SOS row can be produced for someone not on our roster. */
export function loadTeamOf(dbPath?: string): Map<string, string> {
  const db = open(dbPath);
  try {
    const out = new Map<string, string>();
    for (const r of db.prepare("SELECT name, nfl_team FROM player WHERE nfl_team IS NOT NULL").all() as { name: string; nfl_team: string }[]) {
      out.set(nameKey(r.name), r.nfl_team);
    }
    return out;
  } finally { db.close(); }
}

/**
 * WHAT DATA PRODUCED THIS ANSWER -- read once and carried in every `assumptions` block.
 *
 * Never quote a number without saying what made it. A championship probability from a board built
 * before three players changed teams is not the same number as one built after, and the only thing
 * standing between the Assistant and quoting the first as the second is this stamp.
 */
export function loadProvenance(dbPath?: string): Provenance {
  const db = open(dbPath);
  let season = 0, boardRows = 0;
  try {
    season = configOf(db).season;
    boardRows = (db.prepare("SELECT count(*) n FROM board WHERE season=?").get(season) as { n: number }).n;
  } finally { db.close(); }
  let varianceSeasons: number | null = null;
  try {
    const vm = JSON.parse(readFileSync(dataPath("variance-model.json"), "utf8")) as { seasons?: unknown[] };
    varianceSeasons = Array.isArray(vm.seasons) ? vm.seasons.length : null;
  } catch { /* the stamp is best-effort; a missing file is reported as null, never guessed */ }
  let projectionArtifact: string | null = null;
  try {
    const a = JSON.parse(readFileSync(dataPath("projection-artifact.json"), "utf8")) as { fittedAt?: string; fittedFrom?: string };
    projectionArtifact = a.fittedAt ? `${a.fittedFrom ?? "projection-artifact"}@${a.fittedAt}` : null;
  } catch { /* likewise */ }
  return { season, boardRows, varianceSeasons, sampler: "bootstrap", projectionArtifact };
}

/** FAAB budget, when the league recorded one. Defaults to a $100 scale (percentage-style bidding),
 *  which is what the FAAB rule of thumb in copilot.ts is expressed against. */
export function loadFaabBudget(dbPath?: string): number {
  const db = open(dbPath);
  try {
    const row = db.prepare("SELECT scoring_json FROM league WHERE scoring_json IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1").get() as { scoring_json: string } | undefined;
    if (!row) return 100;
    const j = JSON.parse(row.scoring_json) as { faabBudget?: number };
    return Number(j.faabBudget) > 0 ? Number(j.faabBudget) : 100;
  } catch { return 100; } finally { db.close(); }
}

/**
 * TODAY, as a LOCAL calendar date, `YYYY-MM-DD`.
 *
 * Deliberately NOT `toISOString().slice(0, 10)`, which is the UTC date. Every kickoff date in
 * `raw_nfl_game.gameday` is a US calendar date, and this machine runs west of Greenwich: any
 * evening after 8pm ET, the UTC date is already TOMORROW. That is not a rounding nuisance -- it
 * moves the answer across the boundary this function exists to find. A Monday-night reader in
 * week 1 would be told it is week 2 and shown next week's lineup. The weekly track hit the same
 * bug and it would have skipped week 1 outright.
 */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * WHICH WEEK IS IT?
 *
 * The data track put the answer in the store. `raw_nfl_game` carries a `gameday` per game for every
 * season including the live one, so the week is now DERIVED rather than defaulted:
 *
 *   week w is current from the day AFTER week w-1's last kickoff through week w's last kickoff,
 *   and before week 1's first kickoff the current week is 1.
 *
 * Equivalently: the lowest week whose last kickoff has not yet passed. That rule follows the real
 * schedule rather than a calendar arithmetic of "season start plus seven days", so a flex, a bye
 * shuffle, or an international game moving a week's Monday does not silently shift it -- which is
 * the defect the older note in this spot was rightly afraid of. It is a derivation, not a guess.
 *
 * The comparison is on LOCAL dates (see `localToday`). Doing it in UTC moves every evening after
 * 8pm ET onto the next calendar day, and on the last kickoff day of a week that hands back the
 * NEXT week -- the single failure this function must not have.
 *
 * When `raw_nfl_game` has no rows for the configured season -- a store that has never ingested the
 * schedule -- the old behaviour is kept exactly: week 1, `source: "default"`, said out loud. An
 * unknown week is a fine thing to report and a terrible thing to hide.
 */
export function currentWeek(dbPath?: string, now: Date = new Date()): { week: number; source: string } {
  const db = open(dbPath);
  try {
    const cfg = configOf(db);
    const weeks = db.prepare(
      `SELECT week, max(gameday) last_kick, min(gameday) first_kick
         FROM raw_nfl_game
        WHERE season = ? AND game_type = 'REG' AND week IS NOT NULL AND gameday IS NOT NULL
        GROUP BY week ORDER BY week`,
    ).all(cfg.season) as { week: number; last_kick: string; first_kick: string }[];

    if (weeks.length) {
      const today = localToday(now);
      const cur = weeks.find((w) => today <= w.last_kick) ?? weeks[weeks.length - 1];
      const done = today > cur.last_kick;
      return {
        week: Number(cur.week),
        source: `schedule -- raw_nfl_game for season ${cfg.season}: today is ${today} (local), and week ${cur.week} runs through its last kickoff on ${cur.last_kick}` +
          (done ? "; every REG week has been played, so this is the last one" : ""),
      };
    }

    return { week: 1, source: `default -- nothing in the store records the current week (no rows in \`raw_nfl_game\` for season ${cfg.season}); pass --week to be sure` };
  } catch {
    return { week: 1, source: "default -- the store could not be read" };
  } finally { db.close(); }
}

/**
 * THE WEEKLY PROJECTION FOR ONE WEEK -- the store side of the lineup seam.
 *
 * `lineupRecommend` is pure and will not read a file or a database, so this loads the artifact and
 * the week's `feat_player_week_model` rows, runs the projector, and hands back a plain map keyed the
 * way the roster can be looked up.
 *
 * IT ROUTES THROUGH `WEEKLY_SERVE`, PER POSITION -- which it did not until integration pass 4.
 *
 * Track C shipped the streaming model at QB, K and DST and Track F made `WEEKLY_SERVE` the one table
 * every consumer resolves through, but this function kept reading `SHIPPED_WEEKLY_ARTIFACT` for all
 * six positions. So the SCORECARD served QB from the streaming artifact while the LINEUP served the
 * floor, and the two disagreed about a quarterback's projection with nothing anywhere saying so. It
 * is exactly the drift `WEEKLY_SERVE` exists to make impossible, one seam short of the table.
 *
 * The routing is not reimplemented here: `projectStreamingWith` already groups the week's rows by
 * position, loads each serving artifact once, and joins the streaming columns. A second
 * implementation of the same table is how two consumers start disagreeing again.
 *
 * `artifactPath` still forces ONE artifact for every position. That is what the before/after
 * comparison in test/weekly-serve-lineup.test.ts uses, and what a caller asking "what would the
 * floor have said" needs; it bypasses the table deliberately and only on request.
 *
 * At RB, WR and TE the served artifact IS the floor -- every coefficient zero, mean intercept 1.0,
 * so the projection is the season line per game -- because no candidate passed the gate there. That
 * is the honest degradation, and it is why this change moves QB, K and DST and nothing else.
 *
 * Returns null when there is nothing to serve -- no artifact on disk, no feature rows for that week.
 * Null means "fall back to the season line and SAY SO", never "project zero".
 */
export function loadWeeklyProjection(
  season: number, week: number, dbPath?: string, artifactPath?: string,
): Map<string, number> | null {
  const db = open(dbPath);
  try {
    // Highest mean wins a name collision: two feature rows can normalize to one key (a father/son
    // pair, a duplicated board entry), and taking the first would be an arbitrary choice recorded
    // as a projection.
    const out = new Map<string, number>();
    const put = (name: string, mean: number) => {
      const k = lineupNameKey(name);
      const prev = out.get(k);
      if (prev == null || mean > prev) out.set(k, mean);
    };

    if (artifactPath) {
      let artifact;
      try {
        artifact = loadWeeklyArtifact(JSON.parse(readFileSync(artifactPath, "utf8")));
      } catch { return null; }
      const rows = loadWeeklyRows(db as unknown as StreamDb, season, week);
      if (!rows.length) return null;
      const proj = projectWeekly({ artifact, rows });
      if (!proj.length) return null;
      for (const p of proj) put(p.name, p.mean);
      return out;
    }

    const projected = projectStreamingWith(db as unknown as StreamDb, season, week);
    if (!projected?.rows.length) return null;
    for (const p of projected.rows) put(p.name, p.mean);
    return out;
  } finally { db.close(); }
}

/**
 * THE SAME PROJECTION, PLUS ITS SHAPE. `objective: "winprob"` needs a p10/p50/p90 and a P(zero week)
 * per player, not a mean -- without a band there is no distribution to take a probability under.
 *
 * It is ONE function returning both maps rather than a second loader beside `loadWeeklyProjection`,
 * because two loaders reading the same table on two calls is how a mean and a band start coming from
 * different artifacts. The means this returns ARE the means that function returns; the test asserts
 * it rather than the comment claiming it.
 */
export function loadWeeklyBands(
  season: number, week: number, dbPath?: string,
): { weekly: Map<string, number>; bands: Map<string, WeeklyBand> } | null {
  const db = open(dbPath);
  try {
    const projected = projectStreamingWith(db as unknown as StreamDb, season, week);
    if (!projected?.rows.length) return null;
    const weekly = new Map<string, number>();
    const bands = new Map<string, WeeklyBand>();
    for (const p of projected.rows) {
      const k = lineupNameKey(p.name);
      const prev = weekly.get(k);
      if (prev != null && prev >= p.mean) continue;
      weekly.set(k, p.mean);
      bands.set(k, { mean: p.mean, p10: p.p10, p50: p.p50, p90: p.p90, pZero: p.pZero });
    }
    return { weekly, bands };
  } finally { db.close(); }
}

/** WHICH ARTIFACT SERVED EACH POSITION, for the `assumptions` block of a lineup result. The lineup
 *  now reads the same table the scorecard does, so it can say so rather than leaving a reader to
 *  guess which of three models produced a number. */
export function weeklyServeAssumption(): { table: Record<string, string>; text: string } {
  return { table: serveTable(), text: formatServeTable() };
}
