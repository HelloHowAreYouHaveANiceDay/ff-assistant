// BREAKING-NEWS WATCH -- the between-posts alarm (`ff news-watch`).
//
// WHY: on 2026-10-11 Marvin Harrison Jr. (dropped by us 09-30, so a free agent in league 462233)
// was added by team 15 at 12:08 ET. The feed had carried "Report: Cardinals will be trading receiver
// Marvin Harrison Jr." since 10-10 11:16 ET and Sleeper had him #4 in trending adds at the 11:40 ET
// ingest -- 28 minutes before the add. Nothing alerted because (a) every headline was severity "low"
// (fixed in src/data/headlineKind.ts), (b) the scheduled posts only read OUR roster, and (c) nothing
// ran between the fixed-time posts. ESPN free-agent adds are first-come, so the gap is the cost.
//
// The core (`pickAlerts`) is PURE: feed items + an ownership map + relevance + state in, alerts and
// the next state out. The loader reads the store; the verb wires the two and persists the state.
//
// Rules:
//   OURS (team = ourTeam): an ESPN status change (injury, source espn-status), or a headline whose
//     kind is transaction / injury / role.
//   FREE AGENT (no owner in the league): a transaction or role headline about him, or a Sleeper
//     top-10 trending ADD. Headlines are gated on relevance (ESPN rostered% or our value) so a
//     practice-squad signing does not page anyone; Sleeper top-10 is relevant by definition.
//   ANOTHER TEAM'S player: never (nothing we can do in the next hour).
// Each feed row alerts once (the `seen` set). A player alerted inside COOLDOWN_H is only re-alerted
// when a NEW reason appears (e.g. trade rumour -> trade done), so a story told by six outlets is one
// ping. Items first seen more than MAX_AGE_H ago are not news.
import { classifyHeadline } from "../data/headlineKind.js";
import { nameKey } from "../draft/values.js";
import type { DB } from "../db/db.js";

export const COOLDOWN_H = 12;
export const MAX_AGE_H = 36;
export const TRENDING_TOP = 10;
export const MIN_ROSTERED_PCT = 10;

export interface WatchItem {
  playerId: string; player: string; pos: string; team: string;
  category: string; source: string; severity: string; detail: string; url: string;
  firstSeen: string; // ISO
}
export interface Relevance { rosteredPct: number | null; value: number | null; projPts: number | null; usPos: string }
export interface WatchState { seen: Record<string, string>; lastAlert: Record<string, { at: string; reasons: string[] }> }
export interface Alert {
  playerId: string; player: string; pos: string; team: string;
  scope: "ours" | "fa"; reasons: string[]; items: WatchItem[]; relevance?: Relevance;
}

/** One key per STORY. Trending rows carry a running count in `detail`, so they key on the player. */
export function itemKey(i: WatchItem): string {
  return i.category === "trending" ? `${i.playerId}|trending|${i.source}` : `${i.playerId}|${i.category}|${i.source}|${i.detail}`;
}

function trendingRank(detail: string): number | null {
  const m = detail.match(/Sleeper #(\d+)/); return m ? Number(m[1]) : null;
}

/** The reason an item matters, or null. `scope` decides which reasons count. */
export function reasonFor(i: WatchItem, scope: "ours" | "fa"): string | null {
  if (i.category === "headline") {
    const { kind, severity } = classifyHeadline(i.detail);
    if (!kind) return null;
    if (scope === "fa" && kind === "injury") return null; // a free agent getting hurt is not a pickup
    return `${kind}:${severity}`;
  }
  if (i.category === "injury") return scope === "ours" && i.source === "espn-status" ? `status:${i.detail}` : null;
  if (i.category === "trending") {
    if (scope !== "fa" || i.source !== "sleeper:add") return null;
    const r = trendingRank(i.detail); return r !== null && r <= TRENDING_TOP ? "trending-add" : null;
  }
  return null;
}

export function pickAlerts(
  items: WatchItem[],
  ctx: {
    owner: Map<string, string>; // playerId -> team_id ("0"/missing = free agent)
    ourTeam: string;
    relevance: Map<string, Relevance>;
    state: WatchState;
    now: Date;
  },
): { alerts: Alert[]; state: WatchState } {
  const nowMs = ctx.now.getTime();
  const seen = { ...ctx.state.seen };
  const lastAlert = { ...ctx.state.lastAlert };
  const byPlayer = new Map<string, Alert>();
  for (const i of items) {
    const k = itemKey(i);
    if (seen[k]) continue;
    seen[k] = ctx.now.toISOString();
    const t = Date.parse(i.firstSeen);
    if (Number.isFinite(t) && nowMs - t > MAX_AGE_H * 3600e3) continue;
    const own = ctx.owner.get(i.playerId);
    const scope: "ours" | "fa" | null = own === ctx.ourTeam ? "ours" : (!own || own === "0") ? "fa" : null;
    if (!scope) continue;
    const reason = reasonFor(i, scope);
    if (!reason) continue;
    const rel = ctx.relevance.get(i.playerId);
    if (scope === "fa" && reason !== "trending-add") {
      const relevant = rel && ((rel.rosteredPct ?? 0) >= MIN_ROSTERED_PCT || (rel.value ?? 0) >= 1);
      if (!relevant) continue;
    }
    const a = byPlayer.get(i.playerId) ?? { playerId: i.playerId, player: i.player, pos: i.pos, team: i.team, scope, reasons: [], items: [], relevance: rel };
    if (!a.reasons.includes(reason)) a.reasons.push(reason);
    a.items.push(i);
    byPlayer.set(i.playerId, a);
  }
  const alerts: Alert[] = [];
  for (const a of byPlayer.values()) {
    const prev = lastAlert[a.playerId];
    const inCooldown = prev && nowMs - Date.parse(prev.at) < COOLDOWN_H * 3600e3;
    if (inCooldown && a.reasons.every((r) => prev.reasons.includes(r))) continue;
    lastAlert[a.playerId] = { at: ctx.now.toISOString(), reasons: [...new Set([...(inCooldown ? prev.reasons : []), ...a.reasons])] };
    alerts.push(a);
  }
  // prune: seen keys older than 21 days
  const cut = nowMs - 21 * 86400e3;
  for (const [k, v] of Object.entries(seen)) if (Date.parse(v) < cut) delete seen[k];
  alerts.sort((x, y) => (x.scope === y.scope ? 0 : x.scope === "ours" ? -1 : 1));
  return { alerts, state: { seen, lastAlert } };
}

/** Slack-ready text. ASCII only. */
export function renderAlerts(alerts: Alert[], meta: { ownershipAgeMin: number | null }): string {
  const lines: string[] = [];
  for (const a of alerts) {
    const who = a.scope === "ours" ? "OUR PLAYER" : "FREE AGENT";
    const rel = a.relevance ? ` [${a.relevance.usPos || a.pos}, proj ${a.relevance.projPts ?? "?"} pts, ESPN rostered ${a.relevance.rosteredPct ?? "?"}%]` : "";
    lines.push(`${who}: ${a.player} (${a.pos} ${a.team})${rel} -- ${a.reasons.join(", ")}`);
    const heads = a.items.filter((i) => i.category === "headline").sort((x, y) => y.firstSeen.localeCompare(x.firstSeen));
    for (const i of heads.slice(0, 3)) lines.push(`  - ${i.detail} (${i.source}, ${i.firstSeen.slice(0, 16)}Z) ${i.url}`.trimEnd());
    for (const i of a.items.filter((x) => x.category !== "headline")) lines.push(`  - ${i.detail} (${i.source})`);
  }
  if (meta.ownershipAgeMin !== null && meta.ownershipAgeMin > 60) lines.push(`NOTE: league ownership is ${meta.ownershipAgeMin} min old -- confirm a free agent is still free before acting.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- store loaders (not pure)
type DBLike = DB;

export function loadItems(db: DBLike, asOf?: Date): WatchItem[] {
  // news_history, not news: it carries first_seen, and a replay can cut it at any instant.
  const rows = db.prepare(
    `SELECT h.player_id, h.player_name, coalesce(p.position,'') pos, coalesce(p.nfl_team,'') team, h.category, h.source,
            h.severity, h.detail, coalesce(h.url,'') url, h.first_seen
       FROM news_history h LEFT JOIN player p ON p.player_id = h.player_id`,
  ).all() as { player_id: string; player_name: string; pos: string; team: string; category: string; source: string; severity: string; detail: string; url: string; first_seen: string }[];
  const cut = asOf?.toISOString();
  return rows.filter((r) => !cut || r.first_seen <= cut).map((r) => ({
    playerId: r.player_id, player: r.player_name, pos: r.pos, team: r.team, category: r.category,
    source: r.source, severity: r.severity, detail: r.detail, url: r.url, firstSeen: r.first_seen,
  })).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}

/** Ownership NOW, or rolled back to `asOf` by undoing every league transaction proposed after it. */
export function loadOwnership(db: DBLike, leagueId: string, season: number, asOf?: Date): Map<string, string> {
  const owner = new Map<string, string>();
  for (const r of db.prepare("SELECT player_id, team_id FROM ownership WHERE league_id=?").all(leagueId) as { player_id: string; team_id: string }[]) owner.set(r.player_id, String(r.team_id));
  if (!asOf) return owner;
  const espnToPid = new Map<string, string>();
  // player.espn_id is incomplete (Marvin Harrison Jr. has none), so ESPN's own name for the id,
  // nameKey'd exactly as `ownership.player_id` is, fills the gaps. player.espn_id wins when present.
  for (const r of db.prepare("SELECT DISTINCT espn_player_id, name FROM raw_league_roster_week WHERE league_id=? AND name IS NOT NULL").all(leagueId) as { espn_player_id: string; name: string }[]) espnToPid.set(String(r.espn_player_id), nameKey(r.name));
  for (const r of db.prepare("SELECT player_id, espn_id FROM player WHERE espn_id IS NOT NULL").all() as { player_id: string; espn_id: string }[]) espnToPid.set(String(r.espn_id), r.player_id);
  const txns = db.prepare(
    `SELECT espn_player_id, from_team_id, to_team_id, proposed_at_ms FROM raw_league_transaction
      WHERE league_id=? AND season=? AND status='EXECUTED' AND proposed_at_ms > ? AND espn_player_id IS NOT NULL
      ORDER BY proposed_at_ms DESC`,
  ).all(leagueId, season, asOf.getTime()) as { espn_player_id: string; from_team_id: string; to_team_id: string }[];
  for (const t of txns) {
    const pid = espnToPid.get(String(t.espn_player_id)); if (!pid) continue;
    owner.set(pid, String(t.from_team_id ?? "0"));
  }
  return owner;
}

export function loadRelevance(db: DBLike, leagueId: string): Map<string, Relevance> {
  const m = new Map<string, Relevance>();
  for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE league_id=?").all(leagueId) as { player_id: string; row_json: string }[]) {
    try {
      const j = JSON.parse(r.row_json);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      m.set(r.player_id, { rosteredPct: num(j["Rostered%"]), value: num(j["OurValue$"]), projPts: num(j["ProjPts"]), usPos: String(j["Us_Pos"] ?? "") });
    } catch { /* a bad row is just not relevant */ }
  }
  return m;
}
