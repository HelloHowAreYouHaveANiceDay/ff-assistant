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
import { normalizeStatus, type AvailabilityMap, type GameRow, type Provenance } from "./copilot.js";

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
    return { games, season: cfg.season, regWeeks: cfg.regWeeks ?? 14 };
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
 * WHICH WEEK IS IT? -- and the honest answer is that the store usually does not know.
 *
 * There is no kickoff date anywhere in the schema: `game` carries season/week/team/opponent/lines
 * and no timestamp, and `matchup` (which does carry a week) is only populated once something has
 * fetched the live league. Guessing the week from the wall clock would be a hardcoded NFL calendar
 * wearing a derivation's clothes -- right by coincidence in September and silently wrong after any
 * flex or bye shuffle, which is exactly the defect `playoffTeams: 7` was.
 *
 * So this returns the week WITH ITS SOURCE, and a caller that gets `source: "default"` is being told
 * plainly that nobody knew. `ff copilot lineup` prints it; the MCP tool returns it; the tool
 * description tells the Assistant to pass `week` explicitly. An unknown week is a fine thing to
 * report and a terrible thing to hide.
 */
export function currentWeek(dbPath?: string): { week: number; source: string } {
  const db = open(dbPath);
  try {
    const cfg = configOf(db);
    const row = db.prepare("SELECT max(week) w FROM matchup").get() as { w: number | null } | undefined;
    if (row?.w != null) return { week: Number(row.w), source: "matchup table (last fetched live matchup)" };
    return { week: 1, source: `default -- nothing in the store records the current week (no kickoff dates in \`game\`, no rows in \`matchup\`); season ${cfg.season}, pass --week to be sure` };
  } catch {
    return { week: 1, source: "default -- the store could not be read" };
  } finally { db.close(); }
}
