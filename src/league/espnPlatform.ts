/**
 * The ESPN half of the Platform seam (src/league/platform.ts).
 *
 * WHAT THIS IS AND IS NOT. The bodies below are LIFTED, behaviour-for-behaviour, from the
 * `discover_leagues` and `league_sync` MCP tools in src/agent/agent.ts -- the same ESPN vocabulary,
 * the same slot order, the same PPR bucket rule, the same refusal on a degenerate payload. What
 * changed is only that they are now pure functions over an injected `PlatformIO` instead of closures
 * over a Playwright page and an open database, so they can be called for a league whose PLATFORM was
 * dispatched on, and tested against a saved payload.
 *
 * AGENT.TS IS DELIBERATELY UNCHANGED IN THIS PASS (WP4 does not own it). It still calls its own copy.
 * WP5 swaps the two call sites to `platformFor(ctx.platform)` -- see the WP4 report for the exact
 * wiring. Until then these are the OBVIOUS replacement, not yet the live path, and the pure parsers
 * (`espnDiscoverFromLinks`, `espnSettingsFromPayload`) are covered by test/platform-espn.test.ts so a
 * drift between the two copies is visible rather than silent.
 */
import { ESPN_READS_BASE, ESPN_WRITES_BASE } from "../data/espnApi.js";
import { scoringFromEspn } from "../draft/scoring.js";
import { ESPN_POS } from "./espnSlots.js";
import { formatFromEspnSettings } from "./index.js";
import type { DiscoveredLeague, LeagueSettings, Platform, PlatformRoster } from "./platform.js";
import { ESPN_WRITE_TYPES, ESPN_WRITE_URL_PATTERN, type PlatformWrites } from "./writeIO.js";
import type { LeagueTeam } from "./types.js";

/** ESPN statId for a reception -- the PPR dial. */
const RECEPTION_STAT_ID = 53;

/** lineupSlotId -> our slot token, and the ORDER the config array is built in (starters, then
 *  DST/K, then bench). Byte-identical to agent.ts:18-25, which is the point. */
const ESPN_SLOT: Record<number, string> = { 0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER" };
const SLOT_ORDER = [0, 2, 3, 4, 5, 6, 23, 7, 16, 17, 20, 21, 24];

export function espnSlotsToConfig(counts: Record<string, number>): string[] {
  const out: string[] = [];
  for (const id of SLOT_ORDER) { const n = Number(counts[id] ?? 0); for (let i = 0; i < n; i++) out.push(ESPN_SLOT[id] ?? String(id)); }
  return out;
}

export const espnLeagueApiUrl = (season: number, leagueId: string, views: string[]): string =>
  `${ESPN_READS_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?` + views.map((v) => `view=${v}`).join("&");

export const normSwid = (s: string): string => (s || "").replace(/[{}]/g, "").toUpperCase();

/**
 * IDENTITY BEFORE ANY WRITE. ESPN echoes the league id back as `id`; a payload that is not this
 * league's, or carries no id at all, must not be written anywhere. Same rule (and same wording) as
 * `leagueSyncIdentityProblem` in agent.ts -- reading one league and writing another is S-3.
 */
export function espnIdentityProblem(payload: unknown, requestedId: string): string | null {
  const got = (payload as { id?: unknown })?.id;
  if (got == null || got === "") {
    return `the settings payload carries no league id, so it cannot be shown to be league ${requestedId}'s. Nothing was written.`;
  }
  if (String(got) !== String(requestedId)) {
    return `asked for league ${requestedId} but the payload is league ${String(got)} -- reading one league and writing another is how a league inherits another league's rules. Nothing was written.`;
  }
  return null;
}

/** PURE: ESPN fantasy-home anchors -> the leagues they name, filtered to `wantSeason`. Lifted from
 *  agent.ts's `discover_leagues`, including the season filter that stopped a next-season placeholder
 *  link becoming a `league` row of its own (S-14). */
export function espnDiscoverFromLinks(links: { h: string; t: string }[], wantSeason: number): { keep: DiscoveredLeague[]; skipped: DiscoveredLeague[] } {
  const seen: Record<string, boolean> = {};
  const found: DiscoveredLeague[] = [];
  for (const x of links) {
    try {
      const u = new URL(x.h);
      const lg = u.searchParams.get("leagueId");
      if (!lg) continue;
      const se = u.searchParams.get("seasonId") || "";
      const k = lg + "|" + se;
      if (seen[k]) continue;
      seen[k] = true;
      found.push({ leagueId: lg, season: Number(se) || null, teamId: u.searchParams.get("teamId") || null, name: (x.t || "").trim() || null });
    } catch { /* not a URL -- skip */ }
  }
  return {
    keep: found.filter((l) => !l.season || l.season === wantSeason),
    skipped: found.filter((l) => l.season != null && l.season !== wantSeason),
  };
}

/**
 * PURE: the ESPN `view=mSettings&view=mTeam` payload -> `LeagueSettings`.
 *
 * Every refusal agent.ts's `league_sync` makes is made here, BEFORE anything is returned: wrong/absent
 * league id, empty lineup slots, no teams, no scoring rules. `formatFromEspnSettings` throws on any
 * missing calendar field rather than defaulting it. `prevBudget`/`prevTeams` are the caller's current
 * stored values, used only where ESPN genuinely does not publish the field (a non-auction league has
 * no auctionBudget), exactly as the original did.
 */
export function espnSettingsFromPayload(
  payload: unknown,
  opts: { leagueId: string; season: number; swid?: string | null; prevBudget: number; prevTeams: number; now?: Date },
): LeagueSettings {
  const idProblem = espnIdentityProblem(payload, opts.leagueId);
  if (idProblem) throw new Error(`espn syncSettings REFUSED: ${idProblem}`);
  const j = payload as {
    settings?: Record<string, any>;
    teams?: { id?: unknown; name?: unknown; location?: unknown; nickname?: unknown; owners?: string[] }[];
  };
  const s = j.settings ?? {};
  const rs = (s.rosterSettings ?? {}) as Record<string, any>;
  const sc = (s.scoringSettings ?? {}) as Record<string, any>;
  const ds = (s.draftSettings ?? {}) as Record<string, any>;
  const slotCounts = (rs.lineupSlotCounts ?? {}) as Record<string, number>;
  const slots = espnSlotsToConfig(slotCounts);
  const teams = Number(s.size) || opts.prevTeams;
  const model = scoringFromEspn((sc.scoringItems ?? []) as { statId: number; points?: number }[]);
  if (!slots.length || !(teams > 0) || !Object.keys(model.rules).length) {
    throw new Error(`espn syncSettings REFUSED: league ${opts.leagueId} came back with ${slots.length} lineup slots / ${teams} teams -- a hollow settings pull would overwrite a working config and read as a successful sync.`);
  }
  const rec = ((sc.scoringItems ?? []) as { statId: number; points?: number }[]).find((it) => it.statId === RECEPTION_STAT_ID);
  const recPts = rec ? Number(rec.points ?? 0) : 0;
  const scoringBucket: LeagueSettings["scoringBucket"] = recPts >= 1 ? "PPR" : recPts >= 0.5 ? "HALF" : "STD";
  const draftType: "auction" | "snake" = ds.type === "AUCTION" ? "auction" : "snake";
  const budget = draftType === "auction" ? (Number(ds.auctionBudget) || opts.prevBudget) : null;
  const format = formatFromEspnSettings({ settings: s, teams: j.teams ?? [] }, opts.now ?? new Date());
  // OUR TEAM, from the SAME payload: the team whose owners include the logged-in SWID. `null` without
  // a swid -- the caller then KEEPS what the store holds rather than blanking it.
  const swid = normSwid(opts.swid ?? "");
  const mine = swid
    ? (j.teams ?? []).find((t) => (t.owners ?? []).some((o: string) => normSwid(o) === swid))
    : undefined;
  return {
    leagueId: opts.leagueId, platform: "espn", season: opts.season, name: (s.name as string) ?? null,
    teamId: mine && mine.id != null ? String(mine.id) : null,
    teams, slots, draftType, budget,
    scoring: model.rules, scoringBucket,
    // ESPN publishes kicking and defensive scoring whether or not the league rosters them, and this
    // league does roster both -- so unlike Yahoo 129048 these are never null here.
    kicker: model.kicker, defense: model.defense,
    format,
    acquisition: {
      waivers: true,
      faabBudget: Number(s.acquisitionSettings?.acquisitionBudget) || null,
      processDays: [], processHour: null,
      seasonLimit: Number(s.acquisitionSettings?.acquisitionLimit) || null,
      weeklyLimit: null,
    },
    rosterSettings: {},
    provenance: `espn ${espnLeagueApiUrl(opts.season, opts.leagueId, ["mSettings", "mTeam"])}`,
  };
}

/**
 * PURE: an ESPN `view=mRoster&view=mTeam` payload -> every team's roster in our vocabulary.
 *
 * `owner` and `abbrev` are lifted verbatim from the ownership sync that used to live in ff.ts: the
 * manager's display name from `members` keyed by the team's first owner GUID, falling back to
 * location+nickname and then to `Team <id>`, and ESPN's own `abbrev` falling back to `T<id>`. Same
 * strings, same precedence -- the ownership rows this produces must be byte-identical to the ones the
 * ESPN-only body produced, which is the control for this refactor.
 */
export function espnRostersFromPayload(payload: unknown): PlatformRoster[] {
  const j = payload as { teams?: any[]; members?: any[] };
  const memberName = new Map<string, string>((j.members ?? []).map((m: any) => [String(m.id), String(m.displayName || m.firstName || m.id)]));
  return (j.teams ?? []).map((t: any) => ({
    teamId: String(t.id),
    teamName: String(t.name ?? (`${t.location ?? ""} ${t.nickname ?? ""}`.trim() || t.id)),
    owner: memberName.get(String((t.owners ?? [])[0])) || `${t.location ?? ""} ${t.nickname ?? ""}`.trim() || `Team ${t.id}`,
    abbrev: t.abbrev || `T${t.id}`,
    players: ((t.roster?.entries ?? []) as any[]).map((e) => {
      const p = e.playerPoolEntry?.player ?? e.player ?? {};
      return {
        name: String(p.fullName ?? ""),
        pos: ESPN_POS[Number(p.defaultPositionId)] ?? "?",
        slot: ESPN_SLOT[Number(e.lineupSlotId)] ?? String(e.lineupSlotId ?? ""),
      };
    }).filter((p) => p.name),
  }));
}

/**
 * ESPN'S WRITE CAPABILITY. Exactly what the tool could already do -- one endpoint, one operation --
 * expressed as a platform capability instead of a constant the guard reached for directly.
 *
 * THE PAYLOAD LIVES HERE NOW, not in `src/inseason/proposeTrade.ts`. Building an ESPN transaction
 * body inside the decision layer was the last transport leak in that directory: the copilot knew
 * ESPN's field names, its team-id types, and that a proposal needs a `scoringPeriodId`. None of
 * that is a decision about a trade.
 */
const espnWrites: PlatformWrites = {
  urlPattern: ESPN_WRITE_URL_PATTERN,
  operations: ESPN_WRITE_TYPES,
  proposeTrade(ctx) {
    // Items carry the player and the DIRECTION; ESPN infers the counterparty from `toTeamId`.
    const body = {
      isLeagueManager: false,
      teamId: Number(ctx.myTeamId),
      type: "TRADE_PROPOSAL",
      items: [
        ...ctx.give.map((p) => ({ playerId: Number(p.playerId), type: "TRADE", fromTeamId: Number(ctx.myTeamId), toTeamId: Number(ctx.otherTeamId) })),
        ...ctx.get.map((p) => ({ playerId: Number(p.playerId), type: "TRADE", fromTeamId: Number(ctx.otherTeamId), toTeamId: Number(ctx.myTeamId) })),
      ],
      // ESPN REJECTS A PROPOSAL WITHOUT IT. Carried in the body the caller will actually send, so
      // what is validated in a dry run is what goes out -- it used to be injected afterwards.
      ...(ctx.scoringPeriodId != null ? { scoringPeriodId: ctx.scoringPeriodId } : {}),
    };
    return {
      url: `${ESPN_WRITES_BASE}/seasons/${ctx.season}/segments/0/leagues/${ctx.leagueId}/transactions/`,
      body: JSON.stringify(body),
      operation: "TRADE_PROPOSAL",
    };
  },
};

export const espnPlatform: Platform = {
  id: "espn",
  host: "espn.com",
  writes: espnWrites,
  webview: { elementId: "espnview", partition: "persist:espn" },
  urls: {
    home: "https://fantasy.espn.com/football/",
    league: (leagueId, season) => `https://fantasy.espn.com/football/league?leagueId=${leagueId}&seasonId=${season}`,
    team: (leagueId, season, teamId) => `https://fantasy.espn.com/football/team?leagueId=${leagueId}&seasonId=${season}${teamId ? `&teamId=${teamId}` : ""}`,
    scoreboard: (leagueId, season, week) => `https://fantasy.espn.com/football/league/scoreboard?leagueId=${leagueId}&seasonId=${season}${week ? `&matchupPeriodId=${week}` : ""}`,
    standings: (leagueId, season) => `https://fantasy.espn.com/football/league/standings?leagueId=${leagueId}&seasonId=${season}`,
    draftRoom: (leagueId, season, teamId) => `https://fantasy.espn.com/football/draft?leagueId=${leagueId}&seasonId=${season}${teamId ? `&teamId=${teamId}` : ""}`,
  },

  async discover(io, wantSeason) {
    // The fantasy home is an HTML page; the anchors carry the league ids. Parsed with the same URL
    // logic as the live tool, over the raw markup rather than a live DOM.
    const html = await io.get("https://fantasy.espn.com/football/");
    const links: { h: string; t: string }[] = [];
    for (const m of html.matchAll(/<a[^>]+href="([^"]*leagueId=[^"]*)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      links.push({ h: m[1].startsWith("http") ? m[1] : `https://fantasy.espn.com${m[1]}`, t: m[2].replace(/<[^>]*>/g, "").trim().slice(0, 80) });
    }
    return espnDiscoverFromLinks(links, wantSeason).keep;
  },

  async syncSettings(io, leagueId, season, hints) {
    const raw = await io.get(espnLeagueApiUrl(season, leagueId, ["mSettings", "mTeam"]));
    const payload = JSON.parse(raw);
    return espnSettingsFromPayload(payload, {
      leagueId, season,
      swid: hints?.swid ?? null,
      prevBudget: hints?.prevBudget ?? 200,
      prevTeams: hints?.prevTeams ?? 0,
    });
  },

  async syncRosters(io, leagueId, season) {
    const raw = await io.get(espnLeagueApiUrl(season, leagueId, ["mTeam", "mRoster"]));
    return espnRostersFromPayload(JSON.parse(raw));
  },

  async readTeam(io, leagueId, season, teamId) {
    const rosters = await this.syncRosters(io, leagueId, season);
    const t = rosters.find((r) => r.teamId === String(teamId));
    if (!t) throw new Error(`espn readTeam: league ${leagueId} has no team ${teamId} (has ${rosters.map((r) => r.teamId).join(", ")})`);
    const out: LeagueTeam = { id: t.teamId, name: t.teamName, mine: true, roster: t.players.map((p) => ({ name: p.name, pos: p.pos, proj: 0 })) };
    return out;
  },
};
