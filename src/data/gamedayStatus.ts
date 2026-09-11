/**
 * GAME-DAY STATUS ingest (B2) -- the freshest injury designation, from ESPN's public game summaries.
 *
 * The lineup information gap (edges.md #11) is worth ~1.8 pts/week and is a RESOLVED-FACT problem: a
 * play-probability model can't tell you WHICH questionable sits, only the game-day OUT list can. ESPN's
 * summary `injuries` block carries per-player status (Out/Doubtful/Questionable) updated close to
 * kickoff -- the ~90-min list our Friday-report/Sleeper-snapshot data misses. We crosswalk ESPN's
 * `athlete.id` to player_sk via player_xref('espn') and store it in raw_gameday_status; loadAvailability
 * then benches the freshest OUT/DOUBTFUL at lineup lock.
 *
 * Public, keyless: site.api.espn.com scoreboard -> event ids -> summary?event=<id> -> injuries.
 */
import { openDb, nowIso, type DB } from "../db/db.js";

const SB = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SUM = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=";

interface EspnInjury { status?: string; date?: string; details?: string; type?: { description?: string }; athlete?: { id?: string | number; displayName?: string } }

export async function ingestGamedayStatus(opts: { dbPath?: string; week?: number; year?: number } = {}): Promise<{ season: number; week: number; events: number; rows: number; out: number }> {
  const sbUrl = opts.week ? `${SB}?seasontype=2&week=${opts.week}${opts.year ? `&dates=${opts.year}` : ""}` : SB;
  const sb = await (await fetch(sbUrl)).json() as { events?: { id: string }[]; season?: { year?: number }; week?: { number?: number } };
  const season = opts.year ?? sb.season?.year ?? new Date().getFullYear();
  const week = opts.week ?? sb.week?.number ?? 0;
  const events = (sb.events ?? []).map((e) => e.id);

  const db: DB = openDb(opts.dbPath);
  const now = nowIso();
  const xref = db.prepare("SELECT CAST(player_sk AS TEXT) sk FROM player_xref WHERE source='espn' AND source_id=?");
  const ins = db.prepare(
    `INSERT INTO raw_gameday_status (season, week, player_sk, espn_athlete_id, name, status, detail, as_of, fetched_at)
     VALUES (@season,@week,@sk,@espn,@name,@status,@detail,@asOf,@now)
     ON CONFLICT(season, week, player_sk) DO UPDATE SET espn_athlete_id=excluded.espn_athlete_id,
       name=excluded.name, status=excluded.status, detail=excluded.detail, as_of=excluded.as_of, fetched_at=excluded.fetched_at`,
  );
  let rows = 0, out = 0;
  const seen = new Set<string>();
  for (const id of events) {
    let sum: { injuries?: { injuries?: EspnInjury[] }[] };
    try { sum = await (await fetch(SUM + id)).json() as typeof sum; } catch { continue; }
    for (const t of sum.injuries ?? []) for (const i of t.injuries ?? []) {
      const espn = i.athlete?.id != null ? String(i.athlete.id) : null;
      if (!espn) continue;
      const r = xref.get(espn) as { sk: string } | undefined;
      if (!r || seen.has(r.sk)) continue;              // fantasy-relevant only; one row per player
      seen.add(r.sk);
      const s = (v: string | undefined | null) => (v == null ? null : String(v));
      ins.run({ season: Number(season), week: Number(week), sk: String(r.sk), espn: String(espn),
        name: s(i.athlete?.displayName), status: s(i.status), detail: s(i.details ?? i.type?.description), asOf: s(i.date), now });
      rows++; if (i.status === "Out") out++;
    }
  }
  db.close();
  return { season, week, events: events.length, rows, out };
}
