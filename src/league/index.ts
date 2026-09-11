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
import { dstAliasKey, nameKey as valuesNameKey } from "../draft/values.js";
import type { LeagueDivision, LeagueFormat, LeaguePlayer, LeagueProvider, LeagueTeam, SeedingRule } from "./types.js";
export type { LeaguePlayer, LeagueTeam, FreeAgent, LeagueShape, LeagueProvider, LeagueFormat, LeagueDivision, SeedingRule } from "./types.js";

export const NFL_WEEKS = 17;

/** The fantasy playoff weeks. Shared so nothing hardcodes 15/16/17 -- a 13-week regular season or a
 *  4-round playoff shifts them, and a consumer that guessed would be silently wrong, not broken.
 *
 *  PREFER `leagueFormat(db).playoffWeeks`: this fills the season out to the last NFL week, which is
 *  right only when the bracket happens to run to the end of the year. The format block carries the
 *  weeks ESPN actually schedules the bracket in. */
export const playoffWeeksFor = (regWeeks: number, nflWeeks = NFL_WEEKS): number[] => {
  const out: number[] = [];
  for (let w = regWeeks + 1; w <= nflWeeks; w++) out.push(w);
  return out;
};

/** How many single-elimination rounds a field of `playoffTeams` needs (byes for the top seeds). */
export const playoffRounds = (playoffTeams: number): number => Math.ceil(Math.log2(Math.max(2, playoffTeams)));

/**
 * Read ESPN's `scheduleSettings` into our format block. NOTHING here defaults.
 *
 * A missing field throws, naming the field. That is the point of the whole exercise: the calendar was
 * previously `this.cfg.regWeeks ?? 14`, which cannot tell "ESPN says 14" from "ESPN said nothing" --
 * and the second of those has been true for the entire life of this repo, with the answer right by
 * coincidence. `?? 14` is not a fallback here, it is a fabricated fact.
 *
 * `payload` is the raw ESPN league JSON for `view=mSettings&view=mTeam` (or the slimmed cache
 * scripts/format-fetch.mjs writes, which keeps the same shape).
 */
export function formatFromEspnSettings(payload: unknown, now: Date = new Date()): LeagueFormat {
  const p = payload as { settings?: { scheduleSettings?: Record<string, unknown> }; teams?: { id?: unknown; divisionId?: unknown }[] };
  const ss = p?.settings?.scheduleSettings;
  if (!ss || typeof ss !== "object") {
    throw new Error("ESPN settings carry no scheduleSettings -- the league format cannot be read, and will NOT be defaulted.");
  }
  const need = (key: string): number => {
    const v = ss[key];
    if (v == null || typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`ESPN scheduleSettings.${key} is missing -- refusing to default the league format. Re-read the league (ff format sync) or set it explicitly (ff format set).`);
    }
    return v;
  };
  const regWeeks = need("matchupPeriodCount");
  const playoffTeams = need("playoffTeamCount");
  const playoffRoundWeeks = need("playoffMatchupPeriodLength");
  const seedingRule = ss.playoffSeedingRule;
  if (typeof seedingRule !== "string" || !seedingRule) {
    throw new Error("ESPN scheduleSettings.playoffSeedingRule is missing -- refusing to default the seeding tiebreak.");
  }
  if (ss.playoffReseed == null) {
    throw new Error("ESPN scheduleSettings.playoffReseed is missing -- refusing to guess whether the bracket reseeds.");
  }
  const rawDivs = ss.divisions;
  if (!Array.isArray(rawDivs)) {
    throw new Error("ESPN scheduleSettings.divisions is missing -- refusing to assume a single division.");
  }
  const teams = Array.isArray(p.teams) ? p.teams : [];
  const divisions: LeagueDivision[] = rawDivs.map((d) => {
    const dd = d as { id?: unknown; name?: unknown };
    return {
      id: String(dd.id), name: String(dd.name ?? `Division ${dd.id}`),
      teamIds: teams.filter((t) => String(t.divisionId) === String(dd.id)).map((t) => String(t.id)),
    };
  });
  const playoffWeeks: number[] = [];
  const rounds = playoffRounds(playoffTeams);
  for (let i = 0; i < rounds * playoffRoundWeeks; i++) playoffWeeks.push(regWeeks + 1 + i);
  return {
    regWeeks, playoffTeams, playoffRoundWeeks, playoffWeeks,
    // ESPN does not publish "division winners are seeded first" as a flag -- it is implied by the
    // league HAVING divisions, and its own help text says a division winner is guaranteed a seed.
    // With one division the two rules are the same rule, so "record" is not an assumption there.
    seeding: divisions.length > 1 ? "division-winners-first" : "record",
    playoffReseed: Boolean(ss.playoffReseed),
    tiebreak: seedingRule,
    divisions,
    source: "espn",
    fetchedAt: localStamp(now),
  };
}

/** LOCAL date-time, to the minute. A UTC stamp on a calendar fact reads an hour or two wrong to the
 *  person checking whether the block is stale, which is the only thing the stamp is for. */
export function localStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SEEDINGS: SeedingRule[] = ["record", "division-winners-first"];
export const isSeedingRule = (s: unknown): s is SeedingRule => SEEDINGS.includes(s as SeedingRule);

/**
 * Validate a stored block. A half-written format is worse than none: it looks configured.
 */
export function validateFormat(f: unknown, where: string): LeagueFormat {
  const g = f as Partial<LeagueFormat>;
  if (!g || typeof g !== "object") throw new Error(`${where}: no league format block. Run \`ff format sync\` (read it from ESPN) or \`ff format set\` (owner override).`);
  for (const k of ["regWeeks", "playoffTeams", "playoffRoundWeeks"] as const) {
    if (typeof g[k] !== "number" || !Number.isFinite(g[k]) || (g[k] as number) <= 0) throw new Error(`${where}: format.${k} is missing or not a positive number.`);
  }
  if (!Array.isArray(g.playoffWeeks) || !g.playoffWeeks.length) throw new Error(`${where}: format.playoffWeeks is missing or empty.`);
  if (!isSeedingRule(g.seeding)) throw new Error(`${where}: format.seeding must be one of ${SEEDINGS.join(" | ")}, got ${JSON.stringify(g.seeding)}.`);
  // A missing reseed flag is NOT defaulted to false: false is a real bracket rule, and defaulting to
  // it is how the repo simulated the wrong bracket for its whole life without a symptom.
  if (typeof g.playoffReseed !== "boolean") throw new Error(`${where}: format.playoffReseed must be true or false, got ${JSON.stringify(g.playoffReseed)}. Re-read the league (ff format sync) or set it explicitly (ff format set --playoff-reseed true|false).`);
  if (!Array.isArray(g.divisions)) throw new Error(`${where}: format.divisions is missing.`);
  if (g.source !== "espn" && g.source !== "owner-override") throw new Error(`${where}: format.source must be "espn" or "owner-override", got ${JSON.stringify(g.source)}.`);
  if (g.playoffWeeks[0] !== g.regWeeks! + 1) throw new Error(`${where}: format.playoffWeeks starts at ${g.playoffWeeks[0]} but the regular season ends week ${g.regWeeks} -- the calendar contradicts itself.`);
  return g as LeagueFormat;
}

/** The block IN FORCE, from a parsed config object. `format` is written by `ff format sync`/`set`;
 *  `formatEspn` keeps what ESPN said even while an owner override is in force. */
export function effectiveFormat(cfg: { format?: unknown }): LeagueFormat {
  return validateFormat(cfg?.format, "config.format");
}

/** The block in force, straight from the store. */
export function leagueFormat(db: DB): LeagueFormat {
  const row = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
  if (!row) throw new Error("no config in settings -- run the app once.");
  return effectiveFormat(JSON.parse(row.value));
}

/** The league calendar WITHOUT needing the app running -- reads the synced config from our own db.
 *  Analysis that only needs the schedule (playoff SOS across all 32 NFL teams) should use this and
 *  stay runnable offline; only roster-dependent work needs openLeague. */
export function leagueCalendar(db: DB): { season: number; regWeeks: number; nflWeeks: number; playoffWeeks: number[]; format: LeagueFormat } {
  const row = db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string } | undefined;
  if (!row) throw new Error("no config in settings -- run the app once.");
  const cfg = JSON.parse(row.value) as { season: number; format?: unknown };
  const format = effectiveFormat(cfg);
  return { season: cfg.season, regWeeks: format.regWeeks, nflWeeks: NFL_WEEKS, playoffWeeks: format.playoffWeeks, format };
}

/** Name matching across sources: ESPN, FantasyPros and nflverse disagree on suffixes and punctuation.
 *  Delegates to the CANONICAL nameKey in src/draft/values.ts -- the two were byte-for-byte identical
 *  (the only historical difference was this wrapper's defensive `String(s)` coercion, preserved here
 *  so a non-string caller still cannot throw). Kept as a re-export so every existing importer of
 *  `nameKey` from this module is unchanged. */
export const nameKey = (s: string): string => valuesNameKey(String(s));

export interface OpenLeague {
  provider: LeagueProvider;
  db: DB;
  season: number;
  slots: string[];
  /** Calendar, from the league -- never hardcode 17 or weeks 15/16/17 in a consumer. */
  regWeeks: number;
  nflWeeks: number;
  playoffWeeks: number[];
  /** The whole format block IN FORCE, so a consumer needs no second source for the field size, the
   *  seeding rule, the reseed flag or the divisions. Never re-derive any of these from a literal. */
  format: LeagueFormat;
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
    format: leagueFormat(db),
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
