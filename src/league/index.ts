/**
 * openLeague() -- pick the platform adaptor, attach OUR valuation, hand back a plain interface.
 *
 * The layering, which is the point of this directory:
 *   adaptor (espn.ts)  answers WHO is on which roster, in platform vocabulary
 *   this file          translates to our vocabulary and attaches WHAT THEY ARE WORTH
 *   analysis scripts   see only ./types and never import an adaptor
 *
 * Adding a platform is one file implementing LeagueProvider plus one case below.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { optimalLineup } from "../inseason/lineup.js";
import { dstAliasKey } from "../draft/values.js";
import type { LeaguePlayer, LeagueProvider, LeagueTeam } from "./types.js";
export type { LeaguePlayer, LeagueTeam, FreeAgent, LeagueShape, LeagueProvider } from "./types.js";

export const NFL_WEEKS = 17;

/** The fantasy playoff weeks. Shared so nothing hardcodes 15/16/17 -- a 13-week regular season or a
 *  4-round playoff shifts them, and a consumer that guessed would be silently wrong, not broken. */
export const playoffWeeksFor = (regWeeks: number, nflWeeks = NFL_WEEKS): number[] => {
  const out: number[] = [];
  for (let w = regWeeks + 1; w <= nflWeeks; w++) out.push(w);
  return out;
};

/** The league calendar WITHOUT needing the app running -- reads the synced config from our own db.
 *  Analysis that only needs the schedule (playoff SOS across all 32 NFL teams) should use this and
 *  stay runnable offline; only roster-dependent work needs openLeague. */
export function leagueCalendar(db: DB): { season: number; regWeeks: number; nflWeeks: number; playoffWeeks: number[] } {
  const row = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
  if (!row) throw new Error("no config in settings -- run the app once.");
  const cfg = JSON.parse(row.value) as { season: number; regWeeks?: number };
  const regWeeks = cfg.regWeeks ?? 14;
  return { season: cfg.season, regWeeks, nflWeeks: NFL_WEEKS, playoffWeeks: playoffWeeksFor(regWeeks) };
}

/** Name matching across sources: ESPN, FantasyPros and nflverse disagree on suffixes and punctuation. */
export const nameKey = (s: string): string =>
  String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");

export interface OpenLeague {
  provider: LeagueProvider;
  db: DB;
  season: number;
  slots: string[];
  /** Calendar, from the league -- never hardcode 17 or weeks 15/16/17 in a consumer. */
  regWeeks: number;
  nflWeeks: number;
  playoffWeeks: number[];
  teams: LeagueTeam[];
  me: LeagueTeam;
  /** Total projected points of the OPTIMAL starting lineup -- the only roster metric that matters. */
  score: (players: LeaguePlayer[]) => number;
  /** Our projection for any name, rostered or not (0 when unknown). */
  proj: (name: string) => number;
  posOf: (name: string) => string | undefined;
  teamOf: (name: string) => string | undefined;
  close: () => Promise<void>;
}

/**
 * Resolve a player by name against a roster, and FAIL if the answer is not exactly one.
 *
 * This exists because three analysis scripts identified our fragile star with `/hall/i.test(name)`,
 * an unanchored substring regex that also matches "Brandon Marshall". A wrong match there does not
 * error -- it silently benches the wrong player and reports confident, wrong trade values. Exact
 * key match first, then unique substring; zero or multiple hits throw with the candidates named.
 */
export function resolvePlayer(roster: LeaguePlayer[], query: string): LeaguePlayer {
  // RAW exact first. nameKey deliberately strips generational suffixes so ESPN's "Marvin Harrison
  // Jr." matches FantasyPros' "Marvin Harrison" -- but that makes a real Sr./Jr. PAIR collide, and
  // asking for "Josh Allen" when a "Josh Allen Jr." is also rostered should get the exact one, not
  // an ambiguity error. Verified by league-selftest.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const rawExact = roster.filter((p) => norm(p.name) === norm(query));
  if (rawExact.length === 1) return rawExact[0];

  const q = nameKey(query);
  const exact = roster.filter((p) => nameKey(p.name) === q);
  if (exact.length === 1) return exact[0];
  const partial = roster.filter((p) => nameKey(p.name).includes(q));
  if (partial.length === 1) return partial[0];

  const hits = exact.length > 1 ? exact : partial;
  if (hits.length > 1) {
    throw new Error(`"${query}" matches ${hits.length} players: ${hits.map((p) => p.name).join(", ")} -- be more specific.`);
  }
  throw new Error(`"${query}" matches nobody on that roster. Have: ${roster.map((p) => p.name).join(", ")}`);
}

export async function openLeague(opts: { dbPath?: string; points?: string } = {}): Promise<OpenLeague> {
  const db = new Database(opts.dbPath ?? "data/ff.db", { readonly: true });
  const cfgRow = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
  if (!cfgRow) { db.close(); throw new Error("no config in settings -- run the app once."); }
  const cfg = JSON.parse(cfgRow.value) as { platform?: string };

  const platform = cfg.platform ?? "espn";
  let provider: LeagueProvider;
  switch (platform) {
    case "espn": {
      const { EspnLeague } = await import("./espn.js");
      provider = await EspnLeague.open(db);
      break;
    }
    default:
      db.close();
      throw new Error(`no adaptor for platform "${platform}". Implement LeagueProvider in src/league/${platform}.ts and add a case here.`);
  }

  // --- OUR valuation, attached here so no adaptor ever has an opinion about worth ---------------
  const projOf = new Map<string, number>();
  for (const line of readFileSync(opts.points ?? "data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    if (f[0]) projOf.set(nameKey(f[0]), Number(f[2]));
  }
  const posOf = new Map<string, string>(), teamOf = new Map<string, string>();
  for (const r of db.prepare("SELECT name, position, nfl_team FROM player").all() as { name: string; position: string; nfl_team: string }[]) {
    posOf.set(nameKey(r.name), r.position);
    teamOf.set(nameKey(r.name), r.nfl_team);
  }
  /**
   * Resolve a name to our lookup key, falling back to the DST alias table.
   *
   * Our tables key defenses by ABBREVIATION ("MIN D/ST" -> "min") while ESPN's rosters say
   * "Vikings D/ST" ("vikings"). Without the alias every DST on every roster resolved to a projection
   * of ZERO -- a ~125-point hole per team. It affected all 16 teams about equally, so trade and
   * ranking comparisons still ordered correctly, which is exactly why it survived a full day of use:
   * the number that was obviously wrong (a 0 next to every other DST's 100-171) only shows up when
   * you print a roster and look at it.
   *
   * dstAliasKey already existed for this, built when the same bug bit the live draft. The adaptor
   * simply never called it -- a fix applied at one call site and not the others.
   */
  const lookupKey = (name: string): string => {
    const k = nameKey(name);
    if (projOf.has(k) || posOf.has(k)) return k;
    return dstAliasKey(name) ?? k;
  };
  const enrich = (p: LeaguePlayer): LeaguePlayer => {
    const k = lookupKey(p.name);
    return { ...p, proj: projOf.get(k) ?? 0, team: p.team ?? teamOf.get(k) };
  };

  const rawTeams = await provider.teams();
  const teams = rawTeams.map((t) => ({ ...t, roster: t.roster.map(enrich) }));
  const me = teams.find((t) => t.mine)!;
  const shape = await provider.shape();

  const score = (players: LeaguePlayer[]): number =>
    optimalLineup(players.map((p) => ({ ...p, available: true })), shape.slots)
      .starters.reduce((a, s) => a + (players.find((p) => p.name === s.name)?.proj ?? 0), 0);

  return {
    provider, db, season: shape.season, slots: shape.slots, teams, me, score,
    regWeeks: shape.regWeeks, nflWeeks: shape.nflWeeks, playoffWeeks: shape.playoffWeeks,
    proj: (n) => projOf.get(lookupKey(n)) ?? 0,
    posOf: (n) => posOf.get(lookupKey(n)),
    teamOf: (n) => teamOf.get(lookupKey(n)),
    close: async () => { await provider.close(); db.close(); },
  };
}

/** Free agents with our projection attached -- same enrichment as rosters. */
export async function freeAgentsWithProj(lg: OpenLeague, limit?: number) {
  const fas = await lg.provider.freeAgents(limit);
  return fas.map((f) => ({ ...f, proj: lg.proj(f.name), team: lg.teamOf(f.name) })).filter((f) => f.proj > 0);
}
