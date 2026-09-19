// Resolve a trade to the exact ESPN transaction it would be, and -- only behind an explicit gate --
// submit it through the app's authenticated session. This is the FIRST thing in the system that can
// write to the league; everything else is read-only by design. So the safe half (resolve + validate +
// show) is the default, and the write is a separate, opt-in step whose payload is printed in full
// before it is ever sent. Nothing here runs on the automation loop; a trade proposal is only ever a
// deliberate, per-trade act.
import { openDb, type DB } from "../db/db.js";
import { resolveLeagueContext } from "../data/leagueContext.js";
import { ESPN_READS_BASE } from "../data/espnApi.js";

export interface TradePlayer { name: string; playerId: string; teamId: string }
export interface TradeResolution {
  ok: boolean;
  problems: string[];
  season: number;
  leagueId: string | null;
  /** WHICH PLATFORM this league is on -- the raw stored string, so an unknown one survives to be
   *  refused by name rather than normalised to null. Decides whose write capability applies. */
  platform: string | null;
  myTeamId: string | null;
  otherTeamId: string | null;
  otherTeamName: string | null;
  give: TradePlayer[];
  get: TradePlayer[];
  writeUrl: string | null;
  /** The ESPN transactions payload this proposal would POST. Printed in the dry run so it can be eyeballed
   *  against ESPN's own API before anything is sent -- the item `type` and top-level shape follow ESPN's
   *  trade-proposal format, but this is the one part not verifiable without sending, so it is shown. */
  payload: unknown;
}


/** Find a player on the current-season roster feed by a loose name match; returns every hit so an
 *  ambiguous name is a reported problem, not a silent pick. */
function findPlayer(db: DB, leagueId: string, season: number, name: string): TradePlayer[] {
  // FILTERED BY LEAGUE (S-9/P-2). The roster feed holds every league's rows and the team ids overlap,
  // so an unfiltered match could resolve a give to ANOTHER league's roster and then assert it is not
  // on your team -- or worse, agree that it is.
  const rows = db.prepare(
    `SELECT DISTINCT name, espn_player_id AS playerId, team_id AS teamId
       FROM raw_league_roster_week
      WHERE league_id = ? AND season = ? AND lower(name) LIKE '%' || lower(?) || '%'`,
  ).all(leagueId, season, name) as TradePlayer[];
  return rows;
}

export function resolveTrade(db: DB, giveNames: string[], getNames: string[], leagueIdArg?: string | null): TradeResolution {
  // ONE RESOLVER, and this one mattered most: `propose_trade` is the system's only OUTWARD WRITE, and
  // it used to pick its league with an UNORDERED `.get()` over `season=? AND team_id IS NOT NULL` --
  // an arbitrary row the moment a second league of the same season has a team id (P-2).
  const ctx = resolveLeagueContext(db, leagueIdArg);
  const season = ctx.config.season;
  const problems: string[] = [];
  const leagueId = ctx.leagueId;
  const myTeamId = ctx.teamId;
  if (!leagueId) problems.push("no league in the store (sync the league first)");
  else if (!myTeamId) problems.push(`your team is not known: league ${leagueId} has no team_id (sync the league first)`);
  // A trade is POSTED to a platform, and WHICH platform is recorded rather than assumed. This used
  // to be `ctx.platform !== "espn"` -- a hardcoded name that would have had to be edited for every
  // platform that ever learned to write. The authority is now the platform's own `writes`
  // capability (step C), checked in `executeTradeProposal`, which refuses a platform that declares
  // none BY NAME and does so on the dry run too.
  const platform = ctx.platformRaw ?? ctx.platform ?? null;
  if (leagueId && !platform) problems.push(`league ${leagueId} names no platform (sync the league first)`);

  const teamName = (id: string): string | null => {
    if (!leagueId) return null;
    const r = db.prepare("SELECT name FROM raw_league_team_season WHERE league_id = ? AND season = ? AND team_id = ?").get(leagueId, season, id) as { name: string } | undefined;
    return r?.name ?? null;
  };

  const resolveSide = (names: string[], side: "give" | "get"): TradePlayer[] => names.map((n) => {
    if (!leagueId) return { name: n, playerId: "", teamId: "" };
    const hits = findPlayer(db, leagueId, season, n);
    if (hits.length === 0) { problems.push(`${side}: no roster player matches "${n}"`); return { name: n, playerId: "", teamId: "" }; }
    if (hits.length > 1) { problems.push(`${side}: "${n}" is ambiguous -- matches ${hits.map((h) => h.name).join(", ")}`); }
    return hits[0];
  });

  const give = resolveSide(giveNames, "give");
  const get = resolveSide(getNames, "get");

  // Every GIVE must be on MY team; every GET must be on ONE other team (the counterparty).
  for (const p of give) if (p.playerId && myTeamId && p.teamId !== myTeamId) {
    problems.push(`give: ${p.name} is on team ${p.teamId} (${teamName(p.teamId) ?? "?"}), not your team ${myTeamId} -- you cannot trade away a player you do not own`);
  }
  const otherTeamIds = [...new Set(get.filter((p) => p.playerId).map((p) => p.teamId))];
  if (otherTeamIds.length > 1) problems.push(`get: the players you want are on different teams (${otherTeamIds.join(", ")}) -- one ESPN proposal is with ONE team`);
  const otherTeamId = otherTeamIds[0] ?? null;
  if (otherTeamId && otherTeamId === myTeamId) problems.push("get: those players are on your own team");
  const otherTeamName = otherTeamId ? teamName(otherTeamId) : null;

  const ok = problems.length === 0 && !!myTeamId && !!otherTeamId && give.every((p) => p.playerId) && get.every((p) => p.playerId);

  // THE BODY AND THE URL ARE THE PLATFORM'S, not this module's (step C, 2026-09-19). Building an
  // ESPN transaction here meant the decision layer knew ESPN's field names, its team-id types and
  // that a proposal needs a scoringPeriodId -- none of which is a decision about a trade. It is the
  // last transport leak in src/inseason. `writeRequest` is filled by the caller, which has the
  // platform; `resolveTrade` stays a pure resolution that any platform's builder can consume.
  return { ok, problems, season, leagueId, platform, myTeamId, otherTeamId, otherTeamName, give, get,
    writeUrl: null, payload: null };
}

export interface TradeProposalRun {
  resolution: TradeResolution;
  scoringPeriodId: number | null;
  sent: boolean;
  response?: string;
  error?: string;
}

/**
 * Resolve a trade, inject the CURRENT scoringPeriodId (ESPN rejects a proposal without it), and --
 * ONLY when `send` is true -- POST it through the app's authenticated session. This is the shared
 * orchestration behind BOTH `ff propose-trade` and the MCP `propose_trade` tool, so the dry run and
 * the write cannot diverge between the two front doors. The write stays a deliberate, gated act:
 * callers default to send:false and must opt in per proposal; nothing here runs on a loop.
 */
export async function executeTradeProposal(
  dbPath: string | undefined,
  giveNames: string[],
  getNames: string[],
  opts: {
    send?: boolean; leagueId?: string | null;
    /**
     * WHO SENDS IT. Absent, the app bridge, which is what this has always used -- so every existing
     * caller is unchanged. Supplied, any `PlatformWriteIO`: a cookie session from a server-side
     * browser, or `recordingWriteIO()` to rehearse without sending.
     *
     * The writer carries the allowlist (`src/league/writeIO.ts`), so a new provider cannot become a
     * way to POST somewhere this tool was never permitted to write.
     */
    writer?: import("../league/writeIO.js").PlatformWriteIO;
  } = {},
): Promise<TradeProposalRun> {
  const db = openDb(dbPath);
  let resolution: TradeResolution;
  try { resolution = resolveTrade(db, giveNames, getNames, opts.leagueId); } finally { db.close(); }
  if (!resolution.ok) return { resolution, scoringPeriodId: null, sent: false };

  // THE PLATFORM, AND ITS WRITE CAPABILITY. A platform that declares none is refused BY NAME rather
  // than by its URL failing somebody else's regex -- the difference between a stated limit and what
  // looks like a bug. Yahoo is exactly that case today.
  const { platformFor } = await import("../league/platform.js");
  const { assertWritable } = await import("../league/writeIO.js");
  const plat = await platformFor(resolution.platform ?? "espn");
  if (!plat.writes?.proposeTrade) {
    return { resolution, scoringPeriodId: null, sent: false,
      error: `${plat.id} declares no trade-proposal write capability, so this tool cannot propose a ` +
        "trade there. That is a stated limit, not a failure -- see docs/platform-adapter.md." };
  }

  // The current scoringPeriodId, read LIVE through the app session (else the store's current week),
  // and handed to the BUILDER so the body a dry run prints is byte-identical to the body that is
  // sent. It used to be injected into the payload afterwards, which meant the two could differ.
  let spid: number | null = null;
  try {
    const { bridgeAvailable, bridgeFetch } = await import("../browser/appBridge.js");
    if (bridgeAvailable()) {
      const b = await bridgeFetch(`${ESPN_READS_BASE}/seasons/${resolution.season}/segments/0/leagues/${resolution.leagueId}?view=mStatus`);
      const sp = (JSON.parse(b) as { scoringPeriodId?: number }).scoringPeriodId;
      if (Number.isFinite(sp)) spid = Number(sp);
    }
  } catch { /* fall through to the store */ }
  if (spid == null) { try { const { currentWeek } = await import("./copilotStore.js"); spid = currentWeek(dbPath, new Date(), resolution.leagueId).week; } catch { /* leave null */ } }
  const req = plat.writes.proposeTrade({
    season: resolution.season,
    leagueId: String(resolution.leagueId),
    myTeamId: String(resolution.myTeamId),
    otherTeamId: String(resolution.otherTeamId),
    give: resolution.give.map((p) => ({ playerId: p.playerId })),
    get: resolution.get.map((p) => ({ playerId: p.playerId })),
    scoringPeriodId: spid,
  });
  // Surfaced on the resolution so the dry run still SHOWS what would be sent -- the one piece that
  // cannot be proven correct without sending it.
  resolution.writeUrl = req.url;
  resolution.payload = JSON.parse(req.body) as unknown;

  if (!opts.send) return { resolution, scoringPeriodId: spid, sent: false };
  if (spid == null) return { resolution, scoringPeriodId: null, sent: false, error: "cannot determine the current scoring period (need the app running) -- refusing to send without it" };
  try {
    const writer = opts.writer ?? (await import("../league/session.js")).resolveWriteIO();
    // Policed against THIS platform's rules before any provider is touched. The providers run the
    // url check too (nothing reaches ESPN without it); this adds the OPERATION check, which needs
    // the capability and so cannot live inside a provider that has never heard of a platform.
    assertWritable(plat.writes, req);
    const r = await writer.post(req.url, req.body);
    // A NON-2xx IS AN OUTCOME, NOT A CRASH. ESPN puts the reason in the body of a refusal -- an
    // ineligible player, a locked roster, a trade deadline that has passed -- and throwing the
    // status away loses exactly the sentence the manager needs.
    if (r.status >= 400) {
      return { resolution, scoringPeriodId: spid, sent: false,
        error: `ESPN refused the proposal with HTTP ${r.status} via ${writer.via}: ${r.body.slice(0, 400)}` };
    }
    return { resolution, scoringPeriodId: spid, sent: true, response: r.body };
  } catch (e) {
    return { resolution, scoringPeriodId: spid, sent: false, error: String(e instanceof Error ? e.message : e) };
  }
}
