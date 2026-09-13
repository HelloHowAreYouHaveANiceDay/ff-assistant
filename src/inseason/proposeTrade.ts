// Resolve a trade to the exact ESPN transaction it would be, and -- only behind an explicit gate --
// submit it through the app's authenticated session. This is the FIRST thing in the system that can
// write to the league; everything else is read-only by design. So the safe half (resolve + validate +
// show) is the default, and the write is a separate, opt-in step whose payload is printed in full
// before it is ever sent. Nothing here runs on the automation loop; a trade proposal is only ever a
// deliberate, per-trade act.
import { getConfig, openDb, type DB } from "../db/db.js";
import { ESPN_READS_BASE, ESPN_WRITES_BASE } from "../data/espnApi.js";

export interface TradePlayer { name: string; playerId: string; teamId: string }
export interface TradeResolution {
  ok: boolean;
  problems: string[];
  season: number;
  leagueId: string | null;
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
function findPlayer(db: DB, season: number, name: string): TradePlayer[] {
  const rows = db.prepare(
    `SELECT DISTINCT name, espn_player_id AS playerId, team_id AS teamId
       FROM raw_league_roster_week
      WHERE season = ? AND lower(name) LIKE '%' || lower(?) || '%'`,
  ).all(season, name) as TradePlayer[];
  return rows;
}

export function resolveTrade(db: DB, giveNames: string[], getNames: string[]): TradeResolution {
  const cfg = getConfig(db) as { season: number };
  const season = cfg.season;
  const lg = db.prepare(
    "SELECT league_id, team_id FROM league WHERE season = ? AND team_id IS NOT NULL",
  ).get(season) as { league_id: string; team_id: string } | undefined;
  const problems: string[] = [];
  const leagueId = lg?.league_id ?? null;
  const myTeamId = lg?.team_id ?? null;
  if (!lg) problems.push("your team is not known: the league table has no team_id for this season (sync the league first)");

  const teamName = (id: string): string | null => {
    const r = db.prepare("SELECT name FROM raw_league_team_season WHERE season = ? AND team_id = ?").get(season, id) as { name: string } | undefined;
    return r?.name ?? null;
  };

  const resolveSide = (names: string[], side: "give" | "get"): TradePlayer[] => names.map((n) => {
    const hits = findPlayer(db, season, n);
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

  // ESPN trade-proposal transaction. Items carry the player and the direction; ESPN infers the
  // counterparty from the toTeamId. Shown in the dry run because this is the one piece that cannot be
  // proven correct without sending it.
  const payload = ok ? {
    isLeagueManager: false,
    teamId: Number(myTeamId),
    type: "TRADE_PROPOSAL",
    items: [
      ...give.map((p) => ({ playerId: Number(p.playerId), type: "TRADE", fromTeamId: Number(myTeamId), toTeamId: Number(otherTeamId) })),
      ...get.map((p) => ({ playerId: Number(p.playerId), type: "TRADE", fromTeamId: Number(otherTeamId), toTeamId: Number(myTeamId) })),
    ],
  } : null;

  const writeUrl = ok && leagueId ? `${ESPN_WRITES_BASE}/seasons/${season}/segments/0/leagues/${leagueId}/transactions/` : null;

  return { ok, problems, season, leagueId, myTeamId, otherTeamId, otherTeamName, give, get, writeUrl, payload };
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
  opts: { send?: boolean } = {},
): Promise<TradeProposalRun> {
  const db = openDb(dbPath);
  let resolution: TradeResolution;
  try { resolution = resolveTrade(db, giveNames, getNames); } finally { db.close(); }
  if (!resolution.ok) return { resolution, scoringPeriodId: null, sent: false };

  // The current scoringPeriodId, read LIVE through the app session (else the store's current week),
  // injected into the payload so what is validated is exactly what is sent.
  let spid: number | null = null;
  try {
    const { bridgeAvailable, bridgeFetch } = await import("../browser/appBridge.js");
    if (bridgeAvailable()) {
      const b = await bridgeFetch(`${ESPN_READS_BASE}/seasons/${resolution.season}/segments/0/leagues/${resolution.leagueId}?view=mStatus`);
      const sp = (JSON.parse(b) as { scoringPeriodId?: number }).scoringPeriodId;
      if (Number.isFinite(sp)) spid = Number(sp);
    }
  } catch { /* fall through to the store */ }
  if (spid == null) { try { const { currentWeek } = await import("./copilotStore.js"); spid = currentWeek(dbPath).week; } catch { /* leave null */ } }
  if (spid != null) (resolution.payload as { scoringPeriodId?: number }).scoringPeriodId = spid;

  if (!opts.send) return { resolution, scoringPeriodId: spid, sent: false };
  if (spid == null) return { resolution, scoringPeriodId: null, sent: false, error: "cannot determine the current scoring period (need the app running) -- refusing to send without it" };
  try {
    const { bridgeWriteTransaction } = await import("../browser/appBridge.js");
    const response = await bridgeWriteTransaction(resolution.writeUrl!, JSON.stringify(resolution.payload));
    return { resolution, scoringPeriodId: spid, sent: true, response };
  } catch (e) {
    return { resolution, scoringPeriodId: spid, sent: false, error: String(e instanceof Error ? e.message : e) };
  }
}
