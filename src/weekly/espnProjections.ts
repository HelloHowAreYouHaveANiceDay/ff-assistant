/**
 * ESPN'S OWN WEEKLY PROJECTION, read-only, as a THIRD baseline.
 *
 * WHY IT MATTERS MORE THAN THE OTHER TWO. `season line` and `shipped week()` are both ours; beating
 * them proves the weekly layer improved on itself. ESPN's number is what the league's other fifteen
 * managers see in the app when they set a lineup, so it is the only baseline that measures whether
 * this work is worth anything AGAINST THE ROOM. docs/edges.md already records that an independent
 * projection is worth roughly +12 championship points at equal accuracy; this is the weekly test of
 * the same claim.
 *
 * READ-ONLY, THROUGH THE BRIDGE. src/browser/appBridge.ts posts a fetch into the desktop app's
 * logged-in webview. No ESPN write of any kind happens here and none can: the only route used is
 * `/fetch`, with a GET URL.
 *
 * WHAT IS AND IS NOT GUESSED. ESPN publishes per-player stat blocks under `kona_player_info`, each
 * carrying `statSourceId` (0 = actual, 1 = projected), `statSplitTypeId` (1 = a single scoring
 * period) and `scoringPeriodId`. A projection for week w is the block with source 1, split 1 and
 * scoringPeriodId w. If no such block is present in the payload the reader SAYS SO and stores
 * nothing -- it does not fall back to a season block divided by games, which would be our arithmetic
 * wearing ESPN's name and would make the third baseline a fourth copy of the first.
 */
import { bridgeAvailable, bridgeFetch } from "../browser/appBridge.js";
import { nowIso, type DB } from "../db/db.js";

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
/** ESPN numbers positions; 4 is a tight end. Same table src/league/espn.ts keeps. */
const ESPN_POS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };

interface EspnStat { statSourceId?: number; statSplitTypeId?: number; scoringPeriodId?: number; appliedTotal?: number }
interface EspnPlayer { id?: number; fullName?: string; defaultPositionId?: number; stats?: EspnStat[] }
interface EspnEntry { id?: number; player?: EspnPlayer; playerPoolEntry?: { player?: EspnPlayer } }

export interface EspnProjRow {
  season: number; week: number; espnPlayerId: string; name: string; pos: string; projPts: number;
}

export interface EspnFetchResult {
  ok: boolean;
  reason: string;
  rows: EspnProjRow[];
  /** How many players came back at all, whether or not they carried a weekly projection. */
  players: number;
}

/**
 * Fetch week `week` of `season`. `leagueId` selects the league-scoped pool (which carries our
 * scoring); omitting it reads the public `leaguedefaults/3` pool instead, which is standard scoring
 * and is stated as such rather than silently substituted.
 */
export async function fetchEspnWeekly(opts: {
  season: number; week: number; leagueId?: string; limit?: number;
}): Promise<EspnFetchResult> {
  if (!bridgeAvailable()) {
    return { ok: false, reason: "app bridge not available -- open the desktop app and log in to ESPN", rows: [], players: 0 };
  }
  const limit = opts.limit ?? 800;
  // THE WEEK GOES IN THE URL, as `scoringPeriodId`. Measured, not guessed
  // (scripts/weekly-espn-probe.mjs): with it, 40 of 40 players carry a `src=1 split=1 period=<week>`
  // block; without it the league endpoint returns only season-long blocks and NOTHING weekly, which
  // is what the first live snapshot hit. The `filterStatsForTopScoringPeriodIds` header form that
  // reads plausibly in ESPN's own payloads makes the bridge fetch fail outright.
  const base = opts.leagueId
    ? `${HOST}/seasons/${opts.season}/segments/0/leagues/${opts.leagueId}`
    : `${HOST}/seasons/${opts.season}/segments/0/leaguedefaults/3`;
  const url = `${base}?view=kona_player_info&scoringPeriodId=${opts.week}`;
  const filter = { players: { limit, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
  let body: string;
  try {
    body = await bridgeFetch(url, { "x-fantasy-filter": JSON.stringify(filter) });
  } catch (e) {
    return { ok: false, reason: `bridge fetch failed: ${e instanceof Error ? e.message : e}`, rows: [], players: 0 };
  }
  let json: { players?: EspnEntry[] };
  try { json = JSON.parse(body) as { players?: EspnEntry[] }; }
  catch { return { ok: false, reason: `ESPN returned non-JSON (${body.slice(0, 100)})`, rows: [], players: 0 }; }

  const entries = json.players ?? [];
  const rows: EspnProjRow[] = [];
  for (const e of entries) {
    const p = e.player ?? e.playerPoolEntry?.player;
    if (!p?.fullName) continue;
    const pos = ESPN_POS[p.defaultPositionId ?? -1];
    if (!pos) continue;
    const stat = (p.stats ?? []).find((s) =>
      s.statSourceId === 1 && s.statSplitTypeId === 1 && Number(s.scoringPeriodId) === opts.week);
    if (!stat || typeof stat.appliedTotal !== "number") continue;
    rows.push({
      season: opts.season, week: opts.week,
      espnPlayerId: String(p.id ?? e.id ?? p.fullName),
      name: p.fullName, pos, projPts: stat.appliedTotal,
    });
  }
  if (!entries.length) return { ok: false, reason: "ESPN returned no players -- session expired, or the payload shape changed", rows: [], players: 0 };
  if (!rows.length) {
    return {
      ok: false, players: entries.length, rows: [],
      reason: `ESPN returned ${entries.length} players but none carried a projected block for ` +
        `scoringPeriodId ${opts.week} (statSourceId 1, statSplitTypeId 1). The field is not in this ` +
        "payload, so nothing was stored. It is not inferred from a season total -- that would be our " +
        "arithmetic wearing ESPN's name.",
    };
  }
  return { ok: true, reason: `${rows.length} of ${entries.length} players carried a week-${opts.week} projection`, rows, players: entries.length };
}

/** Store a fetch. `as_of` is the snapshot instant and is the whole value of the row: a projection
 *  read after the games is not a projection. */
export function storeEspnWeekly(db: DB, rows: EspnProjRow[], asOf?: string): number {
  const now = nowIso();
  const stamp = asOf ?? now;
  const ins = db.prepare(
    `INSERT INTO raw_espn_projection (season, week, espn_player_id, name, pos, proj_pts, as_of, fetched_at)
     VALUES (@season,@week,@id,@name,@pos,@pts,@asOf,@now)
     ON CONFLICT(season, week, espn_player_id) DO UPDATE SET
       name=excluded.name, pos=excluded.pos, proj_pts=excluded.proj_pts, fetched_at=excluded.fetched_at`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      ins.run({ season: r.season, week: r.week, id: r.espnPlayerId, name: r.name, pos: r.pos, pts: r.projPts, asOf: stamp, now });
      n++;
    }
  })();
  return n;
}
