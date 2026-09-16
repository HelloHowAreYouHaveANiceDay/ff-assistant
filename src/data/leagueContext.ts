// LEAGUE CONTEXT -- THE ONLY WAY CODE LEARNS WHICH LEAGUE IT IS WORKING ON.
//
// WHAT THIS REPLACED (S-1/S-10, 2026-09-16). There were FOUR disagreeing answers to "which league",
// live in the same process at the same time:
//   * `activeLeagueId(db)`          -- honours `settings.active_league` (what the app's tabs set)
//   * `currentLeagueId(db)`         -- most-recently-synced, ignoring the active selection
//   * `activeLeague(db)` (agent.ts) -- most-recently-synced, current season preferred
//   * ~16 inline `ORDER BY last_synced_at DESC LIMIT 1` / `WHERE season=? AND team_id IS NOT NULL`
//     queries, one of which was an unordered `.get()` (an arbitrary row).
// On the live store that meant `activeLeagueId()` said ESPN 462233 while every last-synced resolver
// said Yahoo 129048 -- so `league_sync` read league A, wrote league B's row, and stored the config
// against a third. None of that failed; it produced confident, wrong numbers.
//
// So there is one resolver, `activeLeagueId(db)`, and one object carrying everything a verb needs to
// know about the league it is serving. Resolve ONCE per verb, thread it, never re-derive.
//
// AN EXPLICIT ID THAT NAMES NOTHING THROWS. `--league 46223` (a typo) must not silently become the
// active league and answer confidently about the wrong team; that is the same failure the four
// resolvers had, arrived at from the keyboard.
import type { DB } from "../db/db.js";
import { activeLeagueId, getConfig, type AppConfig } from "../db/db.js";

/** The platforms a league row can name. `null` on a row written before the column existed. */
export type LeaguePlatform = "espn" | "yahoo";

export interface LeagueContext {
  /** The league this computation is for. `null` only on a store that has never synced a league (a fresh
   *  clone before `league_sync`); config-only callers still work, league-history callers must guard. */
  leagueId: string | null;
  /** From the league ROW, not from the config -- one fact, one home. `null` on a fresh store, AND
   *  `null` for a platform string this build does not know (see `platformRaw`). */
  platform: LeaguePlatform | null;
  /**
   * THE PLATFORM STRING EXACTLY AS THE ROW CARRIES IT, before it is narrowed to the known union.
   *
   * `platform` is `null` both for "no league row" and for "a platform this build has never heard of",
   * and those are different facts: a refusal that says `league 129048 is on an unknown platform` when
   * the row plainly says `sleeper` has thrown away the one piece of information the reader needs.
   * Every refusal below prefers this, so an unknown platform is named rather than anonymised.
   */
  platformRaw: string | null;
  /** OUR team in this league. `null` when the league is known but our seat is not (a discovered-but-
   *  unsynced league, or Yahoo today) -- every verb that needs a team must say so by name. */
  teamId: string | null;
  /** The league's own season, from the row. `null` on a fresh store; prefer `config.season` for the
   *  season a computation runs over, which is the one the rest of the repo is keyed on. */
  rowSeason: number | null;
  /** The league's display name, when a sync has read one. */
  name: string | null;
  /** THIS LEAGUE's config -- `config:<leagueId>`, never another league's mirror. */
  config: AppConfig;
}

interface LeagueRow {
  league_id: string; platform: string | null; team_id: string | null; season: number | null; name: string | null;
}

/** The league row, or `undefined`. One place, so no verb re-spells the SELECT. */
export function leagueRow(db: DB, leagueId: string): LeagueRow | undefined {
  try {
    return db.prepare("SELECT league_id, platform, team_id, season, name FROM league WHERE league_id = ?")
      .get(leagueId) as LeagueRow | undefined;
  } catch { return undefined; }            // fresh store, before the league table exists
}

const asPlatform = (p: string | null | undefined): LeaguePlatform | null =>
  (p === "espn" || p === "yahoo" ? p : null);

/**
 * Resolve the context for `leagueId` (default: the ACTIVE league, `settings.active_league`).
 *
 * Throws when an explicit id names no league row. Does NOT throw when no league exists at all -- a
 * fresh clone degrades to `leagueId: null` so config-only paths keep working, exactly as before.
 */
export function resolveLeagueContext(db: DB, leagueId?: string | null): LeagueContext {
  const explicit = typeof leagueId === "string" && leagueId.length > 0;
  const id = explicit ? (leagueId as string) : activeLeagueId(db);
  if (id == null) return { leagueId: null, platform: null, platformRaw: null, teamId: null, rowSeason: null, name: null, config: getConfig(db) };
  const row = leagueRow(db, id);
  if (!row) {
    if (explicit) throw new Error(`no league "${id}" in the store -- \`ff app-data\`/the app's league tabs list the leagues this store knows.`);
    // The active id came from `activeLeagueId`, which only returns an id it has already seen in the
    // league table, so this is unreachable in practice; degrade rather than throw.
    return { leagueId: null, platform: null, platformRaw: null, teamId: null, rowSeason: null, name: null, config: getConfig(db) };
  }
  return {
    leagueId: String(row.league_id),
    platform: asPlatform(row.platform),
    platformRaw: row.platform ?? null,
    teamId: row.team_id == null ? null : String(row.team_id),
    rowSeason: row.season == null ? null : Number(row.season),
    name: row.name ?? null,
    config: getConfig(db, String(row.league_id)),
  };
}

/** The league id, or a named refusal. For a verb that cannot mean anything without a league. */
export function requireLeagueId(ctx: LeagueContext, verb: string): string {
  if (!ctx.leagueId) throw new Error(`${verb}: no league in the store -- run discover_leagues/league_sync once first.`);
  return ctx.leagueId;
}

/** OUR team id, or a named refusal. `team_id IS NULL` means the sync never identified our seat; a verb
 *  that falls through to another league's team id is the wrong-league-action failure in miniature. */
export function requireTeamId(ctx: LeagueContext, verb: string): string {
  const id = requireLeagueId(ctx, verb);
  if (!ctx.teamId) throw new Error(`${verb}: league ${id} has no team_id -- this store does not know which team is ours in that league (sync it once).`);
  return ctx.teamId;
}

/**
 * Refuse a league whose platform has no adaptor for what is about to happen, BEFORE any fetch or
 * DELETE (S-2/S-3/P-1). The old code built ESPN URLs for whatever league id it resolved and wrote the
 * results under that id -- so a Yahoo league would have been filled with another league's ESPN data.
 */
export function requirePlatform(ctx: LeagueContext, want: LeaguePlatform, what: string, adaptorMethod?: string): string {
  const id = requireLeagueId(ctx, what);
  if (ctx.platform !== want) {
    // NAME THE PLATFORM THE ROW ACTUALLY CARRIES, not the narrowed union (which is null for any
    // string this build does not know, turning "sleeper" into "an unknown platform").
    const got = ctx.platformRaw ?? ctx.platform;
    // NAME THE MISSING PIECE, not just the platform. "no yahoo sync adaptor exists" is not actionable;
    // "nothing wires yahooPlatform.syncRosters into this writer" says exactly what has to be built and
    // where, and stops a reader concluding the adaptor is absent when only the WIRING is.
    const missing = adaptorMethod
      ? ` This path needs \`platformFor("${got ?? "<platform>"}").${adaptorMethod}\` wired into it; until that exists it refuses rather than writing ${want}-shaped rows under league ${id}.`
      : "";
    throw new Error(`${what}: league ${id} is on ${got ? `"${got}"` : "an unknown platform"}; no ${got ? `"${got}"` : "such"} sync adaptor exists yet (this path is ${want}-only).${missing}`);
  }
  return id;
}

/** Refuse an AUCTION-only verb on a league that does not hold one (S-12). Dollars mean nothing in a
 *  snake draft, and quietly printing them would be a number with no referent. */
export function requireAuction(ctx: LeagueContext, what: string): void {
  const dt = ctx.config.draftType ?? "auction";
  if (dt !== "auction") {
    throw new Error(`${what}: league ${ctx.leagueId ?? "?"} is a ${dt} draft -- this verb prices an AUCTION and has no meaning here.`);
  }
}
