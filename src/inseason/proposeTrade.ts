// Resolve a trade to the exact ESPN transaction it would be, and -- only behind an explicit gate --
// submit it through the app's authenticated session. This is the FIRST thing in the system that can
// write to the league; everything else is read-only by design. So the safe half (resolve + validate +
// show) is the default, and the write is a separate, opt-in step whose payload is printed in full
// before it is ever sent. Nothing here runs on the automation loop; a trade proposal is only ever a
// deliberate, per-trade act.
import { getConfig, type DB } from "../db/db.js";
import { ESPN_WRITES_BASE } from "../data/espnApi.js";

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
