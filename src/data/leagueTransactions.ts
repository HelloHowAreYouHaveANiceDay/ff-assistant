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
import { espnGet, espnRoot, cacheCapturedAt, weekPayloadFreshAfter, weeksInSeason, weekKickoffs } from "./leagueRosters.js";
import { ESPN_READS_BASE as HOST } from "./espnApi.js";


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

/**
 * A TRANSACTION ESPN RETURNED THAT PRODUCED NO ROWS, and the reason this type exists at all.
 *
 * The log is stored ONE ROW PER ITEM, so a transaction whose `items` array is empty contributes
 * nothing -- and was, until 2026-09-18, discarded in silence. That is not a hypothetical: ESPN
 * serves a trade between two OTHER teams as a container with `items: []` (our own trades come back
 * with their items intact), so a third-party trade was invisible to every surface that reads this
 * table while the ingest reported its row count and succeeded.
 *
 * Measured on league 462233: a 14 <-> 13 trade on 2026-09-17 moving Jalen Hurts and Ladd McConkey
 * appeared in the payload TWICE -- `TRADE_ACCEPT` with `status: undefined` and `TRADE_UPHOLD`
 * EXECUTED -- both with zero items, and neither produced a row. It was found only because a
 * ROSTER-move cross-check disagreed with `ownership` on exactly two players out of 48.
 *
 * So they are COUNTED AND NAMED rather than dropped. The rows still cannot be written -- ESPN did
 * not say who moved, and inventing the players would be worse than reporting the gap -- but "ESPN
 * withheld the items of N transactions" and "there were no transactions" are now different
 * sentences, which is the whole point.
 */
export interface ItemlessTransaction {
  transactionId: string; type: string; status: string | null; teamId: string; executedAt: string | null;
}

export interface TransactionWeekFetch {
  season: number; week: number; available: boolean; note: string | null; rows: TransactionItemRow[];
  /** Transactions ESPN returned with no items -- see `ItemlessTransaction`. Never silently dropped. */
  itemless: ItemlessTransaction[];
  /** Items ESPN returned with no `playerId`. Same rule: counted, not assumed to be zero. */
  itemsWithoutPlayer: number;
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
  if (!Array.isArray(tx)) return { season, week, available: false, rows: [], itemless: [], itemsWithoutPlayer: 0, note: "no transactions array in the payload" };
  const rows: TransactionItemRow[] = [];
  const itemless: ItemlessTransaction[] = [];
  let itemsWithoutPlayer = 0;
  for (const t of tx) {
    const items = t.items ?? [];
    // ZERO ITEMS IS A FACT ABOUT THE PAYLOAD, NOT AN ABSENCE OF ONE. See `ItemlessTransaction`.
    if (!items.length) {
      itemless.push({
        transactionId: String(t.id ?? ""), type: String(t.type ?? ""), status: t.status ?? null,
        teamId: String(t.teamId ?? ""), executedAt: t.proposedDate ? localIso(t.proposedDate) : null,
      });
      continue;
    }
    items.forEach((it, i) => {
      if (it.playerId == null) { itemsWithoutPlayer++; return; }
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
  return {
    season, week, available: rows.length > 0, rows, itemless, itemsWithoutPlayer,
    // THE NOTE MUST SEPARATE THE THREE CASES, and the first draft of this did not: with zero rows
    // AND withheld items it still said "ESPN returned no transactions", which is the precise
    // confusion the itemless count exists to remove. Caught by the test, not by reading the code.
    note: itemless.length
      ? `${itemless.length} transaction(s) carried NO items and produced no rows` +
        (rows.length ? "" : " -- ESPN returned transactions for this period but none could be stored")
      : (rows.length ? null : "ESPN returned no transactions for this scoring period"),
  };
}

/** LOCAL date-time, seconds resolution. The repo's dates are local; a UTC render would move a
 *  Tuesday-night waiver into Wednesday for half the season. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function fetchTransactionWeek(
  leagueId: string, season: number, week: number, opts?: { freshAfter?: Date | null },
): Promise<TransactionWeekFetch> {
  const url = `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=mTransactions2`;
  try {
    const payload = await espnGet(`tx-${leagueId}-${season}-w${week}`, url, undefined, { freshAfter: opts?.freshAfter ?? null });
    return parseTransactionWeek(payload, season, week);
  } catch (e) {
    return { season, week, available: false, rows: [], itemless: [], itemsWithoutPlayer: 0, note: String((e as Error).message).slice(0, 160) };
  }
}

export interface TransactionCounts { weeks: number; available: number; rows: number; transactions: number }

/** Upsert transaction ROWS only (by PK, never delete-replace) -- no status-table touch. Shared by the
 *  full per-week sync and the pending-proposal capture, so a pending-only fetch cannot clobber a week's
 *  real transaction count in raw_league_transaction_status. */
export function upsertTransactionRows(db: DB, leagueId: string, rows: TransactionItemRow[], fetchedAt: string): number {
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
  db.transaction(() => {
    for (const r of rows) {
      const k = kick.get(`${r.season}|${r.week}`) ?? null;
      up.run({
        l: leagueId, s: r.season, w: r.week, id: r.transactionId, i: r.itemNo, ty: r.type, ity: r.itemType,
        ex: r.executedAt, ms: r.proposedAtMs, t: r.teamId, m: r.memberId, p: r.espnPlayerId,
        ft: r.fromTeamId, tt: r.toTeamId, fs: r.fromLineupSlotId, ts_: r.toLineupSlotId,
        bid: r.bidAmount, st: r.status, et: r.executionType, pend: r.isPending,
        a0: k?.first ?? null, a1: k?.last ?? null, now: fetchedAt,
      });
    }
  })();
  return rows.length;
}

export function loadLeagueTransactions(db: DB, leagueId: string, weeks: TransactionWeekFetch[], fetchedAt: string): TransactionCounts {
  const upWeek = db.prepare(
    `INSERT INTO raw_league_transaction_status VALUES (@l,@s,@w,@a,@n,@note,@now)
     ON CONFLICT(league_id,season,week) DO UPDATE SET available=excluded.available, rows=excluded.rows,
       note=excluded.note, fetched_at=excluded.fetched_at`);
  const c: TransactionCounts = { weeks: 0, available: 0, rows: 0, transactions: 0 };
  const seen = new Set<string>();
  const allRows: TransactionItemRow[] = [];
  db.transaction(() => {
    for (const wk of weeks) {
      c.weeks++;
      if (wk.available) c.available++;
      upWeek.run({ l: leagueId, s: wk.season, w: wk.week, a: wk.available ? 1 : 0, n: wk.rows.length, note: wk.note, now: fetchedAt });
      for (const r of wk.rows) {
        allRows.push(r);
        c.rows++;
        if (!seen.has(r.transactionId)) { seen.add(r.transactionId); c.transactions++; }
      }
    }
  })();
  upsertTransactionRows(db, leagueId, allRows, fetchedAt);
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

export async function ingestLeagueTransactions(opts: { dbPath?: string; seasons: number[]; pauseMs?: number; leagueId?: string })
  : Promise<{ counts: TransactionCounts; checks: TransactionCheck[]; refetched: number; itemless: ItemlessTransaction[]; itemsWithoutPlayer: number }> {
  const { resolveLeagueContext, requirePlatform } = await import("./leagueContext.js");
  const db = openDb(opts.dbPath);
  try {
    const leagueId = requirePlatform(resolveLeagueContext(db, opts.leagueId), "espn", "ingest league-transactions", "syncTransactions");
    const pause = opts.pauseMs ?? 400;
    // THE SAME FRESHNESS RULE THE BOXSCORE SWEEP USES, and for the same reason. A scoring period's
    // transaction log keeps growing all week -- every add, drop, waiver claim and trade lands in the
    // CURRENT period -- so a cached payload for an unfinished week is a snapshot of a log that has
    // since moved on. Measured before this landed: league 462233's 2026 caches were all written
    // 2026-09-12 15:19, the newest stored transaction was 2026-09-10, and every trade and waiver
    // move the league had made in the eight days since was invisible to every surface that reads
    // this table -- while the ingest reported its row count and succeeded.
    const kick = weekKickoffs(db);
    let refetched = 0;
    const fetched: TransactionWeekFetch[] = [];
    for (const season of opts.seasons) {
      for (let w = 1; w <= weeksInSeason(season); w++) {
        const freshAfter = weekPayloadFreshAfter(kick, season, w);
        const captured = cacheCapturedAt(`tx-${leagueId}-${season}-w${w}`);
        const willFetch = !captured || (freshAfter != null && captured < freshAfter);
        if (willFetch) refetched++;
        fetched.push(await fetchTransactionWeek(leagueId, season, w, { freshAfter }));
        if (willFetch) await new Promise((r) => setTimeout(r, pause));
      }
    }
    const counts = loadLeagueTransactions(db, leagueId, fetched, nowIso());
    // AGGREGATED AND RETURNED, not logged and forgotten: the caller prints it, and a run where ESPN
    // withheld a trade's items now looks different from a run where nothing happened.
    const itemless = fetched.flatMap((f) => f.itemless);
    const itemsWithoutPlayer = fetched.reduce((a, f) => a + f.itemsWithoutPlayer, 0);
    return { counts, checks: readBackTransactions(db, leagueId), refetched, itemless, itemsWithoutPlayer };
  } finally { db.close(); }
}

/**
 * YAHOO'S TRANSACTION LOG -> `raw_league_transaction`, in the ESPN row shape (WP9).
 *
 * WHAT YAHOO GIVES THAT ESPN'S RENDERED PAGE DOES NOT: the WINNING FAB BID on every team's claim, not
 * just ours. That is the whole reason this is worth having -- it is what `train_faab.py` is fitted on
 * for the ESPN league, and without it the Yahoo league's FAAB advice can only ever be the rule of
 * thumb. Verified on the live page 2026-09-16: "$2 Waiver", "$3 Waiver", "$7 Waiver" beside other
 * managers' adds.
 *
 * THREE FIELDS YAHOO DOES NOT PUBLISH, recorded as such rather than reconstructed:
 *   transaction_id   there is none. The key is DERIVED (team + timestamp text + row ordinal) and is
 *                    prefixed `y-` so nothing can mistake it for a platform id. It is stable for a
 *                    given page ordering, which is what an upsert needs, and nothing joins on it.
 *   member_id        absent; the team id is what Yahoo names.
 *   losing bids      absent. Only the winning claim is shown, so a FAAB model fitted on this sees
 *                    clearing prices and not the book. Stated because "we have the bids" would be
 *                    a materially stronger claim than what is true.
 *
 * WEEK IS DERIVED FROM THE DATE, because Yahoo publishes no scoring period on this page. A claim is
 * attributed to the NEXT week whose games have not finished -- a Tuesday-morning waiver run is for
 * the coming Sunday, which is the convention every waiver consumer in this repo already assumes.
 * `executed_at` is a LOCAL date-time like the ESPN path's, built from Yahoo's own "Sep 16, 4:55 am"
 * plus the season year (a month before August belongs to the following calendar year).
 */
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Sep 16, 4:55 am" + season 2026 -> "2026-09-16 04:55:00". Null when the text is not that shape --
 *  a null timestamp is a fact; a fabricated one silently moves a claim across a waiver deadline. */
export function yahooTxWhen(text: string, season: number): string | null {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,)?\s*(?:(\d{1,2}):(\d{2})\s*([ap])m?)?/i.exec(String(text ?? ""));
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  const year = mon >= 8 ? season : season + 1;
  let hour = m[3] ? Number(m[3]) % 12 : 0;
  if (m[5] && m[5].toLowerCase() === "p") hour += 12;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(mon)}-${p(Number(m[2]))} ${p(hour)}:${p(Number(m[4] ?? 0))}:00`;
}

/**
 * INGEST A NON-ESPN LEAGUE'S TRANSACTION LOG (WP13) -- the dispatcher `ff ingest-raw
 * league-transactions --league <id>` reaches for a league whose platform is not ESPN.
 *
 * There is no `transactions` method on the `Platform` interface: ESPN's log comes from a JSON feed
 * fetched per scoring period and Yahoo's from a rendered page, and the two ingesters differ in more
 * than their transport (event-derived keys, FAB bids Yahoo publishes and ESPN does not). So this is a
 * REGISTRY of the readers that exist, and a platform with no entry is refused BY NAME rather than
 * silently writing nothing -- which is indistinguishable from a league that had no transactions.
 */
export async function ingestPlatformTransactions(opts: { dbPath?: string; leagueId?: string; season?: number; limit?: number })
  : Promise<{ rows: number; transactions: number; withBid: number; season: number; platform: string }> {
  const { resolveLeagueContext } = await import("./leagueContext.js");
  const platform = (() => {
    const db = openDb(opts.dbPath);
    try { return String(resolveLeagueContext(db, opts.leagueId).platformRaw ?? ""); } finally { db.close(); }
  })();
  if (platform === "yahoo") return { ...(await ingestYahooTransactions(opts)), platform };
  throw new Error(
    `ingest league-transactions: no transaction reader for platform "${platform || "unknown"}" -- ` +
    "ESPN goes through ingestLeagueTransactions and Yahoo through ingestYahooTransactions. Nothing " +
    "was written: a platform with no reader must be refused by name, because writing zero rows reads " +
    "exactly like a league that made no moves.",
  );
}

export async function ingestYahooTransactions(opts: { dbPath?: string; leagueId?: string; season?: number; limit?: number })
  : Promise<{ rows: number; transactions: number; withBid: number; season: number }> {
  const { resolveLeagueContext, requirePlatform } = await import("./leagueContext.js");
  const db = openDb(opts.dbPath);
  try {
    const ctx = resolveLeagueContext(db, opts.leagueId);
    const leagueId = requirePlatform(ctx, "yahoo", "ingest yahoo transactions", "transactions");
    const season = opts.season ?? ctx.rowSeason ?? ctx.config.season;
    const { YahooLeague, yahooPlayerKey } = await import("../league/yahoo.js");
    const lg = YahooLeague.direct(leagueId, ctx.teamId, ctx.config as never);
    const log = await lg.transactions(opts.limit ?? 150);

    // The week each date falls in: the first week whose last game day is NOT before the date.
    const weeks = db.prepare(
      "SELECT week, MAX(gameday) AS last FROM raw_nfl_game WHERE season=? AND game_type='REG' AND gameday IS NOT NULL AND gameday<>'' GROUP BY week ORDER BY week",
    ).all(season) as { week: number; last: string }[];
    const weekOf = (when: string | null): number => {
      if (!when) return 0;
      const d = when.slice(0, 10);
      for (const w of weeks) if (!(w.last < d)) return w.week;
      return weeks.length ? weeks[weeks.length - 1].week : 0;
    };

    const rows: TransactionItemRow[] = [];
    let withBid = 0;
    for (const t of log) {
      const when = yahooTxWhen(t.when, season);
      const week = weekOf(when);
      t.items.forEach((it, i) => {
        if (it.bid != null) withBid++;
        rows.push({
          season, week, transactionId: t.key, itemNo: i,
          type: it.bid != null ? "WAIVER" : "FREEAGENT",
          itemType: it.action === "add" ? "ADD" : "DROP",
          executedAt: when, proposedAtMs: null,
          teamId: t.teamId ?? "", memberId: null,
          espnPlayerId: yahooPlayerKey(it.playerId),
          fromTeamId: it.action === "add" ? "-1" : (t.teamId ?? null),
          toTeamId: it.action === "add" ? (t.teamId ?? null) : "-1",
          fromLineupSlotId: null, toLineupSlotId: null,
          bidAmount: it.bid, status: null, executionType: null, isPending: 0,
        });
      });
    }
    upsertTransactionRows(db, leagueId, rows, nowIso());
    return { rows: rows.length, transactions: log.length, withBid, season };
  } finally { db.close(); }
}

/**
 * CAPTURE PENDING TRADE PROPOSALS with FULL TERMS, before ESPN purges them. The regular mTransactions2
 * feed keeps a PENDING/CANCELED proposal's terms but DROPS a DECLINED proposal's -- leaving only a thin
 * decline event + a dangling relatedTransactionId (verified 2026-09-12: the Garrett Wilson decline's
 * proposal was gone). `mPendingTransactions` returns the same transaction objects WHILE the trade is
 * live, so polling it and upserting into raw_league_transaction banks every proposal's full bilateral
 * terms (both teams, all players, proposer) permanently -- they persist even after the trade resolves.
 * Uncached (bridgeFetch, not espnGet) so a poll always sees fresh pending state; needs the app running.
 */
export async function ingestPendingTrades(opts: { dbPath?: string; leagueId?: string }): Promise<{ pending: number; proposals: number }> {
  const { resolveLeagueContext, requirePlatform } = await import("./leagueContext.js");
  const { bridgeFetch } = await import("../browser/appBridge.js");
  const db = openDb(opts.dbPath);
  try {
    const ctx = resolveLeagueContext(db, opts.leagueId);
    const leagueId = requirePlatform(ctx, "espn", "sync-pending-trades", "syncTransactions");
    const season = ctx.config.season;
    const url = `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?view=mPendingTransactions`;
    let payload: unknown;
    try { payload = JSON.parse(await bridgeFetch(url, {}, 20000)); }
    catch (e) { console.log(`pending-trades: fetch failed (${(e as Error).message}) -- is the app running + logged in?`); return { pending: 0, proposals: 0 }; }
    const parsed = parseTransactionWeek(payload, season, 0);   // each row's real week comes from its scoringPeriodId
    upsertTransactionRows(db, leagueId, parsed.rows, nowIso());
    const proposals = new Set(parsed.rows.filter((r) => r.type === "TRADE_PROPOSAL").map((r) => r.transactionId)).size;
    console.log(`pending-trades: ${parsed.rows.length} pending item(s), ${proposals} trade proposal(s) captured with full terms -> raw_league_transaction`);
    return { pending: parsed.rows.length, proposals };
  } finally { db.close(); }
}
