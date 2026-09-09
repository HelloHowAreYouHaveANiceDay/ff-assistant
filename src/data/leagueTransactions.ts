/**
 * THIS LEAGUE'S TRANSACTION LOG -- every add, drop, waiver claim and trade -- as a raw asset.
 *
 * WHICH ENDPOINT, AND THE ONE PARAMETER THAT DECIDES WHETHER IT WORKS AT ALL. `view=mTransactions2`
 * returns an EMPTY array for every past season on the `leagueHistory` path, and an empty array on
 * the `/seasons/{Y}/` path too -- unless the request also carries `scoringPeriodId`. With it, the
 * same URL that returned nothing returns the week's real transactions (probed 2026-09-09: 2024 week
 * 5 returns 21). So the log is fetched PER SCORING PERIOD, and "the log is empty" was, for three
 * probes, a statement about a missing query parameter rather than about ESPN's retention.
 *
 * The `x-fantasy-filter` header is NOT sent: `{"transactions":{"limit":1000}}` makes ESPN answer
 * HTTP 400 here. The unfiltered request already returns the whole period.
 *
 * ONE ROW PER ITEM, not per transaction. An ESPN transaction is a container: a free-agent pickup is
 * one transaction with an ADD item and a DROP item, a trade is one with four. Keying on the
 * transaction id alone would force a choice about which player the row is "about", and there is no
 * right answer. `item_no` is the index inside ESPN's own array, for the same reason `raw_league_pick`
 * keys on the array index: the feed publishes no per-item id.
 *
 * NO PLAYER NAME, AND THAT IS THE FEED. A transaction item carries `playerId` and nothing else --
 * no name, no position. `name` and `position` are therefore NULL here and are resolved downstream by
 * ESPN id through `player_xref`, which is where identity resolution belongs. A name back-filled here
 * from the roster table would be a join in the raw layer wearing a published column's clothes.
 *
 * BID AMOUNT IS PRESENT BUT IS USUALLY ZERO. `bidAmount` is 0 on a FREEAGENT pickup (no bid was
 * made) and carries the claim on a WAIVER. Both are recorded exactly as given; a zero is not a
 * missing value here, it is a free-agent pickup.
 */
import { openDb, nowIso, type DB } from "../db/db.js";
import { espnGet, espnRoot, espnCachePath, weeksInSeason, weekKickoffs } from "./leagueRosters.js";
import { existsSync } from "node:fs";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

export interface TransactionItemRow {
  season: number; week: number; transactionId: string; itemNo: number;
  type: string; itemType: string;
  executedAt: string | null; proposedAtMs: number | null;
  teamId: string; memberId: string | null;
  espnPlayerId: string;
  fromTeamId: string | null; toTeamId: string | null;
  fromLineupSlotId: number | null; toLineupSlotId: number | null;
  bidAmount: number | null; status: string | null; executionType: string | null; isPending: number;
}

export interface TransactionWeekFetch {
  season: number; week: number; available: boolean; note: string | null; rows: TransactionItemRow[];
}

interface EspnItem { playerId?: number; type?: string; fromTeamId?: number; toTeamId?: number; fromLineupSlotId?: number; toLineupSlotId?: number }
interface EspnTx {
  id?: string; type?: string; teamId?: number; memberId?: string; bidAmount?: number;
  status?: string; executionType?: string; isPending?: boolean; proposedDate?: number;
  scoringPeriodId?: number; items?: EspnItem[];
}

/** PURE: one scoring period's payload -> item rows. Tested against real cached payloads. */
export function parseTransactionWeek(payload: unknown, season: number, week: number): TransactionWeekFetch {
  const j = espnRoot(payload);
  const tx = (j.transactions ?? []) as EspnTx[];
  if (!Array.isArray(tx)) return { season, week, available: false, rows: [], note: "no transactions array in the payload" };
  const rows: TransactionItemRow[] = [];
  for (const t of tx) {
    const items = t.items ?? [];
    items.forEach((it, i) => {
      if (it.playerId == null) return;
      rows.push({
        season, week: Number(t.scoringPeriodId ?? week),
        transactionId: String(t.id ?? `${season}-${week}-${rows.length}`), itemNo: i,
        type: String(t.type ?? ""), itemType: String(it.type ?? ""),
        // ESPN's epoch milliseconds, rendered as a LOCAL date-time so a week boundary reads the way
        // the league's own waiver deadline does.
        executedAt: t.proposedDate ? localIso(t.proposedDate) : null,
        proposedAtMs: t.proposedDate ?? null,
        teamId: String(t.teamId ?? ""), memberId: t.memberId ?? null,
        espnPlayerId: String(it.playerId),
        fromTeamId: it.fromTeamId == null ? null : String(it.fromTeamId),
        toTeamId: it.toTeamId == null ? null : String(it.toTeamId),
        fromLineupSlotId: it.fromLineupSlotId ?? null, toLineupSlotId: it.toLineupSlotId ?? null,
        bidAmount: t.bidAmount ?? null, status: t.status ?? null, executionType: t.executionType ?? null,
        isPending: t.isPending ? 1 : 0,
      });
    });
  }
  return { season, week, available: rows.length > 0, rows, note: rows.length ? null : "ESPN returned no transactions for this scoring period" };
}

/** LOCAL date-time, seconds resolution. The repo's dates are local; a UTC render would move a
 *  Tuesday-night waiver into Wednesday for half the season. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function fetchTransactionWeek(leagueId: string, season: number, week: number): Promise<TransactionWeekFetch> {
  const url = `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mTransactions2`;
  try {
    return parseTransactionWeek(await espnGet(`tx-${leagueId}-${season}-w${week}`, url), season, week);
  } catch (e) {
    return { season, week, available: false, rows: [], note: String((e as Error).message).slice(0, 160) };
  }
}

export interface TransactionCounts { weeks: number; available: number; rows: number; transactions: number }

export function loadLeagueTransactions(db: DB, leagueId: string, weeks: TransactionWeekFetch[], fetchedAt: string): TransactionCounts {
  const kick = weekKickoffs(db);
  const up = db.prepare(
    `INSERT INTO raw_league_transaction VALUES (@l,@s,@w,@id,@i,@ty,@ity,@ex,@ms,@t,@m,@p,@ft,@tt,@fs,@ts_,@bid,@st,@et,@pend,@a0,@a1,@now)
     ON CONFLICT(league_id,season,transaction_id,item_no) DO UPDATE SET
       week=excluded.week, type=excluded.type, item_type=excluded.item_type, executed_at=excluded.executed_at,
       proposed_at_ms=excluded.proposed_at_ms, team_id=excluded.team_id, member_id=excluded.member_id,
       espn_player_id=excluded.espn_player_id, from_team_id=excluded.from_team_id, to_team_id=excluded.to_team_id,
       from_lineup_slot_id=excluded.from_lineup_slot_id, to_lineup_slot_id=excluded.to_lineup_slot_id,
       bid_amount=excluded.bid_amount, status=excluded.status, execution_type=excluded.execution_type,
       is_pending=excluded.is_pending, as_of_start=excluded.as_of_start, as_of_end=excluded.as_of_end,
       fetched_at=excluded.fetched_at`);
  const upWeek = db.prepare(
    `INSERT INTO raw_league_transaction_status VALUES (@l,@s,@w,@a,@n,@note,@now)
     ON CONFLICT(league_id,season,week) DO UPDATE SET available=excluded.available, rows=excluded.rows,
       note=excluded.note, fetched_at=excluded.fetched_at`);
  const c: TransactionCounts = { weeks: 0, available: 0, rows: 0, transactions: 0 };
  const seen = new Set<string>();
  db.transaction(() => {
    for (const wk of weeks) {
      const k = kick.get(`${wk.season}|${wk.week}`) ?? null;
      c.weeks++;
      if (wk.available) c.available++;
      upWeek.run({ l: leagueId, s: wk.season, w: wk.week, a: wk.available ? 1 : 0, n: wk.rows.length, note: wk.note, now: fetchedAt });
      for (const r of wk.rows) {
        up.run({
          l: leagueId, s: r.season, w: r.week, id: r.transactionId, i: r.itemNo, ty: r.type, ity: r.itemType,
          ex: r.executedAt, ms: r.proposedAtMs, t: r.teamId, m: r.memberId, p: r.espnPlayerId,
          ft: r.fromTeamId, tt: r.toTeamId, fs: r.fromLineupSlotId, ts_: r.toLineupSlotId,
          bid: r.bidAmount, st: r.status, et: r.executionType, pend: r.isPending,
          a0: k?.first ?? null, a1: k?.last ?? null, now: fetchedAt,
        });
        c.rows++;
        if (!seen.has(r.transactionId)) { seen.add(r.transactionId); c.transactions++; }
      }
    }
  })();
  return c;
}

export interface TransactionCheck {
  season: number; weeks: number; weeksWithRows: number; items: number; transactions: number;
  adds: number; drops: number; waivers: number; trades: number; drafts: number;
  faab: number; resolvedPct: number;
}

/**
 * Read back per season, including how many transacted players RESOLVE to a surrogate key.
 *
 * The resolution rate is reported rather than asserted at 100%: ESPN rosters team defences under
 * NEGATIVE player ids (-16011 is a D/ST) which the cross-source id file has no row for, and a
 * kicker signed for two weeks in 2019 may genuinely not be in it either. A rate that DROPS is the
 * signal; a rate below 1 is not by itself a defect.
 */
export function readBackTransactions(db: DB, leagueId: string): TransactionCheck[] {
  return db.prepare(
    `SELECT t.season,
        (SELECT COUNT(*) FROM raw_league_transaction_status s WHERE s.league_id=t.league_id AND s.season=t.season) AS weeks,
        (SELECT COUNT(*) FROM raw_league_transaction_status s WHERE s.league_id=t.league_id AND s.season=t.season AND s.rows>0) AS weeksWithRows,
        COUNT(*) AS items,
        COUNT(DISTINCT t.transaction_id) AS transactions,
        SUM(CASE WHEN t.item_type='ADD' THEN 1 ELSE 0 END) AS adds,
        SUM(CASE WHEN t.item_type='DROP' THEN 1 ELSE 0 END) AS drops,
        SUM(CASE WHEN t.type='WAIVER' THEN 1 ELSE 0 END) AS waivers,
        SUM(CASE WHEN t.type LIKE 'TRADE%' THEN 1 ELSE 0 END) AS trades,
        SUM(CASE WHEN t.type='DRAFT' THEN 1 ELSE 0 END) AS drafts,
        COALESCE(SUM(CASE WHEN t.item_no=0 AND t.type='WAIVER' THEN t.bid_amount ELSE 0 END),0) AS faab,
        ROUND(100.0 * SUM(CASE WHEN x.player_sk IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS resolvedPct
      FROM raw_league_transaction t
      LEFT JOIN player_xref x ON x.source='espn' AND x.source_id=t.espn_player_id
      WHERE t.league_id=? GROUP BY t.season ORDER BY t.season`,
  ).all(leagueId) as TransactionCheck[];
}

export async function ingestLeagueTransactions(opts: { dbPath?: string; seasons: number[]; pauseMs?: number })
  : Promise<{ counts: TransactionCounts; checks: TransactionCheck[] }> {
  const { currentLeagueId } = await import("./leagueHistory.js");
  const db = openDb(opts.dbPath);
  try {
    const leagueId = currentLeagueId(db);
    const pause = opts.pauseMs ?? 400;
    const fetched: TransactionWeekFetch[] = [];
    for (const season of opts.seasons) {
      for (let w = 1; w <= weeksInSeason(season); w++) {
        const hit = existsSync(espnCachePath(`tx-${leagueId}-${season}-w${w}`));
        fetched.push(await fetchTransactionWeek(leagueId, season, w));
        if (!hit) await new Promise((r) => setTimeout(r, pause));
      }
    }
    const counts = loadLeagueTransactions(db, leagueId, fetched, nowIso());
    return { counts, checks: readBackTransactions(db, leagueId) };
  } finally { db.close(); }
}
