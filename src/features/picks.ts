/**
 * fact_draft_pick -- one row per pick this league actually made, with the market consensus as it
 * stood at the time.
 *
 * WHY IT IS NOT `draft_pick`. That table is draft-RUNTIME state: keyed by a live `draft_id`, written
 * per tick during a draft, and empty between drafts (it holds 0 rows in the shipped store). The
 * historical record of what this room paid lives in `data/recaps.json`, parsed out of the ESPN
 * recap pages, and nothing in the store held it. A price model needs the second thing, not the
 * first, and conflating them would mean the training set disappears the next time a draft ends.
 *
 * THE CONSENSUS COLUMNS are the point of the table. A price on its own says what somebody paid; a
 * price beside "and the market had him ranked WR14 with a dispersion of 4.2 at the time" says what
 * they paid RELATIVE to public information, which is the quantity a price model is actually about.
 *
 * WE DO NOT KNOW THE DRAFT DATES. ESPN's recap gives the picks and not the day, so `draft_date` is
 * NULL and the consensus is read from the LATEST PRESEASON SCRAPE of that season -- August, or the
 * first week of September. That is stated on every row (`consensus_asof`) rather than left implicit,
 * because "the consensus at the draft" and "the last consensus before week 1" are different
 * quantities and a model fitted on one while believing the other is a silent error.
 */
import { readFileSync, existsSync } from "node:fs";
import { openDb, nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { nameKey } from "../draft/values.js";
import { buildSkResolver } from "../data/skResolve.js";
import { normPos } from "../data/stgPlayer.js";

interface RecapTeam { season: number; name: string; picks: { pick: number; player: string; pos: string; price: number }[] }
interface OwnerYear { year: number; teams: { id: number; abbrev: string; name: string; owners: { name: string }[] }[] }

export interface PicksResult {
  rows: number;
  perSeason: { season: number; picks: number; total: number; resolved: number; withConsensus: number; asOf: string | null }[];
  absent: number[];
}

/** The seasons this league has played, so a season that is simply MISSING from the store is reported
 *  as absent rather than silently not appearing in a table of counts. */
const KNOWN_SEASONS = [2022, 2023, 2024, 2025, 2026];

export function buildDraftPicks(opts: { dbPath?: string; recapPath?: string } = {}): PicksResult {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const resolver = buildSkResolver(db);
  const recapPath = opts.recapPath ?? dataPath("recaps.json");
  const res: PicksResult = { rows: 0, perSeason: [], absent: [] };
  if (!existsSync(recapPath)) { db.close(); res.absent = KNOWN_SEASONS.slice(); return res; }
  const recaps = JSON.parse(readFileSync(recapPath, "utf8")) as RecapTeam[];

  // owner name per (season, team name), where we have it. Never invented: a team with no owner row
  // keeps NULL, which is honestly "we do not know" rather than a plausible wrong attribution.
  const ownerOf = new Map<string, { owner: string; teamId: string }>();
  const ownersPath = dataPath("owners.json");
  if (existsSync(ownersPath)) {
    for (const y of JSON.parse(readFileSync(ownersPath, "utf8")) as OwnerYear[]) {
      for (const t of y.teams ?? []) {
        ownerOf.set(`${y.year}|${t.name}`, { owner: t.owners?.[0]?.name ?? "", teamId: String(t.id) });
      }
    }
  }
  const leagueId = (db.prepare("SELECT league_id FROM league LIMIT 1").get() as { league_id: string } | undefined)?.league_id ?? null;

  const ins = db.prepare(
    `INSERT INTO fact_draft_pick (season, league_id, team_id, owner, team_name, player_sk, name, name_key,
       pos, price, pick_order, draft_date, consensus_asof, consensus_pos_rank_asof, consensus_sd_asof, updated_at)
     VALUES (@season,@lg,@teamId,@owner,@teamName,@sk,@name,@nk,@pos,@price,@order,@date,@asOf,@rank,@sd,@now)
     ON CONFLICT(season, team_name, pick_order) DO UPDATE SET
       player_sk=excluded.player_sk, name=excluded.name, pos=excluded.pos, price=excluded.price,
       owner=excluded.owner, team_id=excluded.team_id, consensus_asof=excluded.consensus_asof,
       consensus_pos_rank_asof=excluded.consensus_pos_rank_asof,
       consensus_sd_asof=excluded.consensus_sd_asof, updated_at=excluded.updated_at`,
  );

  const seasons = [...new Set(recaps.map((r) => r.season))].sort();
  for (const yr of seasons) {
    const { rank: cons, asOf } = preseasonConsensus(db, yr);
    let picks = 0, total = 0, resolved = 0, withCons = 0;
    db.transaction(() => {
      for (const t of recaps.filter((r) => r.season === yr)) {
        const o = ownerOf.get(`${yr}|${t.name}`);
        for (const p of t.picks) {
          const pos = normPos((p.pos ?? "").toUpperCase());
          const nk = nameKey(p.player);
          const sk = resolver.resolve({ name: p.player, pos });
          const c = cons.get(`${nk}|${pos}`);
          ins.run({
            season: yr, lg: leagueId, teamId: o?.teamId ?? null, owner: o?.owner || null, teamName: t.name,
            sk, name: p.player, nk, pos, price: p.price, order: p.pick,
            date: null, asOf, rank: c?.rank ?? null, sd: c?.sd ?? null, now,
          });
          picks++; total += p.price; if (sk) resolved++; if (c) withCons++;
        }
      }
    })();
    res.rows += picks;
    res.perSeason.push({ season: yr, picks, total, resolved, withConsensus: withCons, asOf });
  }
  res.absent = KNOWN_SEASONS.filter((s) => !seasons.includes(s));
  db.close();
  return res;
}

/** Positional rank + dispersion from the LATEST preseason scrape of that season. */
function preseasonConsensus(db: DB, yr: number): { rank: Map<string, { rank: number; sd: number | null }>; asOf: string | null } {
  const out = new Map<string, { rank: number; sd: number | null }>();
  let raw: { scrape_date: string; name: string; pos: string; ecr: number; sd: number | null }[] = [];
  try {
    raw = db.prepare(
      "SELECT scrape_date, name, pos, ecr, sd FROM ranking_history " +
      "WHERE ecr_type='ro' AND source='fantasypros' AND season=@s AND ecr IS NOT NULL " +
      "AND (substr(scrape_date,6,2)='08' OR (substr(scrape_date,6,2)='09' AND CAST(substr(scrape_date,9,2) AS INTEGER)<=7))",
    ).all({ s: yr }) as typeof raw;
  } catch { return { rank: out, asOf: null }; }
  if (!raw.length) return { rank: out, asOf: null };
  let latest = "";
  for (const r of raw) if (r.scrape_date > latest) latest = r.scrape_date;
  const byPos = new Map<string, typeof raw>();
  for (const r of raw) {
    if (r.scrape_date !== latest) continue;
    const pos = normPos((r.pos ?? "").toUpperCase());
    (byPos.get(pos) ?? byPos.set(pos, []).get(pos)!).push(r);
  }
  for (const [pos, list] of byPos) {
    list.sort((a, b) => a.ecr - b.ecr);
    list.forEach((r, i) => out.set(`${nameKey(r.name)}|${pos}`, { rank: i + 1, sd: r.sd ?? null }));
  }
  return { rank: out, asOf: latest };
}
