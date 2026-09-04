// TS port of the assembler (was tools/build_report.py). Reads reference data from the store (ECR,
// bio, byes, news -- all put there by `ff ingest`), ports the two remaining fetches (ESPN draft
// ranks + last-year actuals aggregation), runs the existing TS computeValues on the projections,
// computes every derived field (rank/pos_rank/tier/vsECR/age/ht/espn_pos), and writes L1 player_value
// + L2 board + the ESPN ranking. Only remaining Python after this: build_projections (the curve).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchCsv, pick, NFLVERSE } from "./nflverse.js";
import { nameKey, computeValues, resolveValueLeague, type PointsRow } from "../draft/values.js";
import { scoreWeek, type ScoringRules } from "../draft/scoring.js";
import { openDb, getConfig, nowIso } from "../db/db.js";
import { dataPath } from "./paths.js";

// last-year (season-1) REG fantasy points + games played under the LEAGUE's scoring, keyed by name_key
async function lastYear(season: number, scoring: ScoringRules): Promise<Map<string, { pts: number; gms: number }>> {
  const rows = await fetchCsv(`${NFLVERSE}/stats_player/stats_player_week_${season - 1}.csv`);
  const agg = new Map<string, { pts: number; weeks: Set<number> }>();
  for (const r of rows) {
    if (pick(r, "season_type") !== "REG") continue;
    const name = pick(r, "player_display_name"); if (!name) continue;
    const fp = scoreWeek(r, scoring);
    const k = nameKey(name);
    if (!agg.has(k)) agg.set(k, { pts: 0, weeks: new Set() });
    const a = agg.get(k)!; a.pts += fp; const wk = Number(pick(r, "week")); if (wk) a.weeks.add(wk);
  }
  const out = new Map<string, { pts: number; gms: number }>();
  for (const [k, a] of agg) out.set(k, { pts: Math.round(a.pts * 10) / 10, gms: a.weeks.size });
  return out;
}

// ESPN draft rank (STANDARD) + ADP, keyed by name_key
async function espnRanks(season: number): Promise<Map<string, { rank: number; adp: number | null }>> {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const filter = JSON.stringify({ players: { limit: 900, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } });
  const out = new Map<string, { rank: number; adp: number | null }>();
  try {
    const res = await fetch(url, { headers: { "x-fantasy-filter": filter } });
    const data = await res.json() as { players?: { player?: { fullName?: string; draftRanksByRankType?: { STANDARD?: { rank?: number } }; ownership?: { averageDraftPosition?: number } } }[] };
    for (const p of data.players ?? []) {
      const pp = p.player ?? {};
      const rank = pp.draftRanksByRankType?.STANDARD?.rank;
      const adp = pp.ownership?.averageDraftPosition;
      const k = nameKey(pp.fullName ?? "");
      if (k && rank != null && !out.has(k)) out.set(k, { rank, adp: adp != null && adp > 0 ? Math.round(adp * 10) / 10 : null });
    }
  } catch { /* best-effort second source */ }
  return out;
}

function fmtHt(h: string): string {
  if (!h) return "";
  const m = h.match(/^(\d)[-'](\d{1,2})/); if (m) return `${m[1]}'${m[2]}"`;
  const inches = parseInt(h, 10);
  return Number.isFinite(inches) ? `${Math.floor(inches / 12)}'${inches % 12}"` : h;
}

type Row = Record<string, string | number>;
const COLS = ["rank", "player", "pos", "pos_rank", "ecr_pos", "espn_pos", "tier", "team", "bye", "age", "exp", "ht", "wt", "forty",
  "our_value", "edge", "adp", "vs_adp", "mkt_trend", "proj_pts", "last_pts", "last_gms", "ecr", "best", "worst", "espn_rank", "espn_adp", "rostered", "buzz", "depth", "news", "news_url"];
const header = (lastYr: number) => ["Rank", "Player", "Pos", "Us_Pos", "ECR_Pos", "ESPN_Pos", "Tier", "Team", "Bye", "Age", "Exp", "Ht", "Wt", "40yd",
  "OurValue$", "vsECR", "ADP", "vsADP", "Mkt30d", "ProjPts", `${lastYr}Pts`, `${lastYr}Gms`, "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "SleeperBuzz", "Depth", "Latest News", "NewsURL"];

export async function assemble(dbPath?: string, pointsPath = dataPath("points.csv")): Promise<number> {
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const season = cfg.season;
  const asof = Date.UTC(season, 8, 1); // Sep 1

  // 1. projections -> our values (existing TS computeValues)
  if (!existsSync(pointsPath)) throw new Error(`missing ${pointsPath} (run build_projections first)`);
  const points: PointsRow[] = readFileSync(pointsPath, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
    const [name, pos, pts] = l.split(","); return { name: (name || "").trim(), pos: (pos || "").trim().toUpperCase(), points: Number(pts) };
  }).filter((p) => p.name && Number.isFinite(p.points));
  const projByName = new Map(points.map((p) => [p.name, p.points]));
  const values = computeValues(points, resolveValueLeague(cfg), cfg.levers.maxKDst);

  // 2-4. external fetches (ported): last-year actuals + ESPN ranks
  const [ly, espn] = await Promise.all([lastYear(season, cfg.scoring_rules), espnRanks(season)]);

  // 5. reference data from the store, keyed by name_key
  type Ecr = { team: string; ecr: number; ecr_pos: string; best: number; worst: number; rostered: number };
  const ecr = new Map<string, Ecr>();
  for (const r of db.prepare("SELECT p.player_id, p.name, p.position, p.nfl_team AS team, r.overall_rank AS ecr, r.pos_rank AS ecr_pos, r.best, r.worst, r.rostered_pct AS rostered FROM ranking r JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s").all({ s: season }) as (Ecr & { player_id: string; name: string; position: string })[]) {
    const e: Ecr = { team: r.team, ecr: r.ecr, ecr_pos: r.ecr_pos, best: r.best, worst: r.worst, rostered: r.rostered };
    ecr.set(r.player_id, e); // DST now key consistently by team abbr from ingest -- no nickname hack needed
  }
  const bio = new Map<string, { height: string; weight: number; forty: number; birth_date: string; exp: number }>();
  for (const b of db.prepare("SELECT player_id, height, weight, forty, birth_date, exp FROM player_bio").all() as { player_id: string; height: string; weight: number; forty: number; birth_date: string; exp: number }[]) bio.set(b.player_id, b);
  const byes = new Map<string, number>();
  for (const t of db.prepare("SELECT team, bye FROM team_bye WHERE season=@s").all({ s: season }) as { team: string; bye: number }[]) byes.set(t.team, t.bye);
  // FFC draft-market ADP + FantasyCalc 30-day momentum, keyed by name_key
  const adpMap = new Map<string, number>();
  for (const a of db.prepare("SELECT player_id, adp FROM adp").all() as { player_id: string; adp: number }[]) adpMap.set(a.player_id, a.adp);
  const trendMap = new Map<string, number>();
  for (const m of db.prepare("SELECT player_id, trend_30d FROM market_value").all() as { player_id: string; trend_30d: number }[]) if (m.trend_30d != null) trendMap.set(m.player_id, m.trend_30d);
  const newsByKey = new Map<string, { injury: string; depth: string; buzz: string; news: string; url: string }>();
  for (const r of db.prepare("SELECT player_id, category, detail, source, url FROM news ORDER BY id").all() as { player_id: string; category: string; detail: string; source: string; url: string }[]) {
    const d = newsByKey.get(r.player_id) ?? { injury: "", depth: "", buzz: "", news: "", url: "" };
    if (r.category === "injury" && !d.injury) d.injury = r.detail;
    else if (r.category === "role" && !d.depth) { const m = /depth (\d+)/.exec(r.detail); if (m) d.depth = m[1]; }
    else if (r.category === "trending" && !d.buzz) d.buzz = /add/.test(r.source) ? "ADD" : "DROP";
    else if (r.category === "headline" && !d.news) { d.news = `${r.detail} (${r.source})`; d.url = r.url; }
    newsByKey.set(r.player_id, d);
  }

  // 6. assemble one row per valued player
  const rows: Row[] = [];
  for (const v of values) {
    const k = nameKey(v.name);
    const m = ecr.get(k); const b = bio.get(k); const nd = newsByKey.get(k);
    const team = m?.team ?? "";
    let age: number | "" = "";
    if (b?.birth_date) { const d = Date.parse(String(b.birth_date).slice(0, 10)); if (!Number.isNaN(d)) age = Math.round((asof - d) / (365.25 * 864e5) * 10) / 10; }
    const lyRow = ly.get(k); const es = espn.get(k);
    rows.push({
      player: v.name, pos: v.pos.toUpperCase(), team, bye: byes.get(team) ?? "",
      age, exp: b?.exp === 0 ? "R" : (b?.exp ?? ""), ht: fmtHt(b?.height ?? ""), wt: b?.weight ?? "", forty: b?.forty ?? "",
      our_value: Math.round(v.value), adp: adpMap.get(k) ?? "", mkt_trend: trendMap.get(k) ?? "",
      proj_pts: Math.round((projByName.get(v.name) ?? 0) * 10) / 10,
      last_pts: lyRow ? lyRow.pts : "", last_gms: lyRow ? lyRow.gms : "",
      ecr: m?.ecr ?? "", ecr_pos: m?.ecr_pos ?? "", best: m?.best ?? "", worst: m?.worst ?? "",
      espn_rank: es?.rank ?? "", espn_adp: es?.adp ?? "", rostered: m?.rostered != null ? Math.round(m.rostered) : "",
      injury: nd?.injury ?? "", depth: nd?.depth ?? "", buzz: nd?.buzz ?? "", news: nd?.news ?? "", news_url: nd?.url ?? "",
    });
  }
  rows.sort((a, b) => (b.our_value as number) - (a.our_value as number));

  // rank / pos_rank / tier / vsECR
  const posSeen: Record<string, number> = {}, tierTop: Record<string, number> = {}, tierNo: Record<string, number> = {};
  rows.forEach((r, i) => {
    r.rank = i + 1; const p = r.pos as string;
    posSeen[p] = (posSeen[p] ?? 0) + 1; r.pos_rank = `${p}${posSeen[p]}`;
    r.edge = typeof r.ecr === "number" ? Math.round((r.ecr as number) - (r.rank as number)) : "";
    // vsADP: market's ADP minus our rank. POSITIVE = the room lets them fall past where we value them (a bargain).
    r.vs_adp = typeof r.adp === "number" ? Math.round((r.adp as number) - (r.rank as number)) : "";
    if (!(p in tierTop) || (r.our_value as number) < tierTop[p] * cfg.levers.tierBreak) { tierNo[p] = (tierNo[p] ?? 0) + 1; tierTop[p] = r.our_value as number; }
    r.tier = `${p}-T${tierNo[p]}`;
  });
  // ESPN positional rank (within pos, by ESPN overall)
  const byPos: Record<string, Row[]> = {};
  for (const r of rows) if (typeof r.espn_rank === "number") (byPos[r.pos as string] ??= []).push(r);
  for (const p in byPos) { byPos[p].sort((a, b) => (a.espn_rank as number) - (b.espn_rank as number)); byPos[p].forEach((r, i) => (r.espn_pos = `${p}${i + 1}`)); }
  for (const r of rows) if (r.espn_pos == null) r.espn_pos = "";

  // 7. write L1 player_value + ESPN ranking + L2 board (full-refresh for the season)
  const HEAD = header(season - 1);
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM player_value WHERE season=@s").run({ s: season });
    db.prepare("DELETE FROM ranking WHERE source='espn' AND season=@s").run({ s: season });
    db.prepare("DELETE FROM board WHERE season=@s").run({ s: season });
    const upPlayer = db.prepare("INSERT INTO player (player_id, name, position, updated_at) VALUES (?,?,?,?) ON CONFLICT(player_id) DO NOTHING");
    const upVal = db.prepare("INSERT INTO player_value (player_id, season, our_value, our_rank, pos_rank, tier, proj_pts, last_pts, last_gms, updated_at) VALUES (@id,@s,@v,@rk,@pr,@t,@pp,@lp,@lg,@now)");
    const upRank = db.prepare("INSERT INTO ranking (player_id, source, season, overall_rank, pos_rank, adp, fetched_at) VALUES (@id,'espn',@s,@rank,@pos,@adp,@now) ON CONFLICT(player_id,source,season) DO UPDATE SET overall_rank=excluded.overall_rank, pos_rank=excluded.pos_rank, adp=excluded.adp, fetched_at=excluded.fetched_at");
    const upBoard = db.prepare("INSERT INTO board (player_id, season, row_json, updated_at) VALUES (@id,@s,@json,@now)");
    const numOrNull = (x: unknown) => typeof x === "number" ? x : null;
    for (const r of rows) {
      const id = nameKey(r.player as string); if (!id) continue;
      upPlayer.run(id, r.player, r.pos, now);
      upVal.run({ id, s: season, v: r.our_value, rk: r.rank, pr: r.pos_rank, t: r.tier, pp: numOrNull(r.proj_pts), lp: numOrNull(r.last_pts), lg: numOrNull(r.last_gms), now });
      if (typeof r.espn_rank === "number") upRank.run({ id, s: season, rank: r.espn_rank, pos: r.espn_pos || null, adp: numOrNull(r.espn_adp), now });
      const obj: Record<string, unknown> = {}; COLS.forEach((c, i) => (obj[HEAD[i]] = r[c]));
      upBoard.run({ id, s: season, json: JSON.stringify(obj), now });
    }
  });
  tx();

  // player-report.csv for compat/validation (build_app_data no longer needs it; kept during transition)
  const san = (x: unknown) => String(x ?? "").replace(/,/g, " ").replace(/\n/g, " ").trim();
  const lines = [HEAD.join(",")];
  for (const r of rows) lines.push(COLS.map((c) => san(r[c])).join(","));
  writeFileSync(dataPath("player-report.csv"), lines.join("\n") + "\n", "utf8");
  db.close();
  return rows.length;
}
