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
 *
 * THE FEED IS SEPARABLE FROM THE WRITE (M2c, 2026-09-16), and that is the whole point of the split
 * below. `fetchGamedayStatus` returns rows; `ingestGamedayStatus` resolves and stores them. A caller
 * can therefore (a) SAVE a live pull to a file, and (b) REPLAY that file with a player flipped, which
 * is the only way to exercise the Sunday path on a Wednesday without either waiting four days or
 * asserting against a feed that agrees with us by construction. A fixture run is marked `fixture` in
 * the result so a dry-run can never be mistaken for a live read of the NFL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { openDb, nowIso, type DB } from "../db/db.js";

const SB = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SUM = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=";

/**
 * `details` IS AN OBJECT, NOT A STRING, and typing it as one cost the whole field.
 *
 * It was declared `details?: string` and passed through `String(v)`, which on an object yields the
 * literal text `"[object Object]"` -- so every row in `raw_gameday_status` carried that instead of
 * the injury. Nothing failed: the column is nullable, the value is a non-empty string, and the only
 * consumer prints it. Found on 2026-09-18 while reading Jordan Mason's IR designation, where the
 * detail that should have said what was wrong with him said `[object Object]`.
 *
 * The real shape carries the body part and the nature of the injury separately, so it is composed
 * into a readable line rather than stringified. A STRING is still accepted, because a feed that
 * changes back must not break, and anything else yields null rather than a placeholder.
 */
interface EspnInjuryDetails {
  type?: string; location?: string; detail?: string; side?: string; returnDate?: string;
}
interface EspnInjury {
  status?: string; date?: string; details?: string | EspnInjuryDetails;
  type?: { description?: string }; athlete?: { id?: string | number; displayName?: string };
}

/** The injury as one human line: "Left Knee -- Sprain (return 2026-10-01)". Null when the feed gave
 *  nothing usable -- never `[object Object]`, and never a fabricated placeholder. */
export function describeInjury(details: unknown, fallback?: string | null): string | null {
  if (typeof details === "string" && details.trim()) return details.trim();
  if (details && typeof details === "object") {
    const d = details as EspnInjuryDetails;
    const part = [d.side, d.location ?? d.type].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
    const what = typeof d.detail === "string" && d.detail.trim() ? d.detail.trim() : null;
    const head = [part || null, what].filter(Boolean).join(" -- ");
    const ret = typeof d.returnDate === "string" && d.returnDate.trim() ? ` (return ${d.returnDate.trim()})` : "";
    if (head) return `${head}${ret}`;
  }
  const f = typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
  return f;
}

/** One designation as the feed publishes it, before any identity resolution. This is the shape a
 *  fixture holds, so a fixture is a record of what ESPN said rather than of what we made of it. */
export interface GamedayRow {
  espnAthleteId: string;
  name: string | null;
  status: string | null;
  detail: string | null;
  asOf: string | null;
}

export interface GamedayFeed { season: number; week: number; events: number; rows: GamedayRow[]; source: "espn" | "fixture" }

/** THE NETWORK HALF. No store, no identity, no writes -- so a test or a dry-run replaces exactly this. */
export async function fetchGamedayStatus(opts: { week?: number; year?: number } = {}): Promise<GamedayFeed> {
  const sbUrl = opts.week ? `${SB}?seasontype=2&week=${opts.week}${opts.year ? `&dates=${opts.year}` : ""}` : SB;
  const sb = await (await fetch(sbUrl)).json() as { events?: { id: string }[]; season?: { year?: number }; week?: { number?: number } };
  const season = opts.year ?? sb.season?.year ?? new Date().getFullYear();
  const week = opts.week ?? sb.week?.number ?? 0;
  const events = (sb.events ?? []).map((e) => e.id);
  const rows: GamedayRow[] = [];
  for (const id of events) {
    let sum: { injuries?: { injuries?: EspnInjury[] }[] };
    try { sum = await (await fetch(SUM + id)).json() as typeof sum; } catch { continue; }
    for (const t of sum.injuries ?? []) for (const i of t.injuries ?? []) {
      const espn = i.athlete?.id != null ? String(i.athlete.id) : null;
      if (!espn) continue;
      const s = (v: string | undefined | null) => (v == null ? null : String(v));
      rows.push({
        espnAthleteId: espn, name: s(i.athlete?.displayName), status: s(i.status),
        detail: describeInjury(i.details, i.type?.description), asOf: s(i.date),
      });
    }
  }
  return { season: Number(season), week: Number(week), events: events.length, rows, source: "espn" };
}

/** Read a saved feed back. The season/week travel WITH the fixture, so a replay cannot be silently
 *  attributed to the week the machine happens to be in. */
export function loadGamedayFixture(path: string): GamedayFeed {
  const f = JSON.parse(readFileSync(path, "utf8")) as Partial<GamedayFeed>;
  if (!Array.isArray(f.rows) || !Number.isFinite(Number(f.season)) || !Number.isFinite(Number(f.week))) {
    throw new Error(`gameday fixture ${path} is not a saved feed -- it needs {season, week, rows:[...]}`);
  }
  return { season: Number(f.season), week: Number(f.week), events: Number(f.events ?? 0), rows: f.rows as GamedayRow[], source: "fixture" };
}

export function saveGamedayFixture(path: string, feed: GamedayFeed): void {
  writeFileSync(path, JSON.stringify(feed, null, 2));
}

/** THE STORE HALF: resolve to player_sk and upsert. Takes a feed so the caller decides where it came
 *  from; `ingestGamedayStatus` below keeps the old signature for every existing caller. */
export function storeGamedayStatus(db: DB, feed: GamedayFeed): { rows: number; out: number; unresolved: number } {
  const now = nowIso();
  const xref = db.prepare("SELECT CAST(player_sk AS TEXT) sk FROM player_xref WHERE source='espn' AND source_id=?");
  const ins = db.prepare(
    `INSERT INTO raw_gameday_status (season, week, player_sk, espn_athlete_id, name, status, detail, as_of, fetched_at)
     VALUES (@season,@week,@sk,@espn,@name,@status,@detail,@asOf,@now)
     ON CONFLICT(season, week, player_sk) DO UPDATE SET espn_athlete_id=excluded.espn_athlete_id,
       name=excluded.name, status=excluded.status, detail=excluded.detail, as_of=excluded.as_of, fetched_at=excluded.fetched_at`,
  );
  let rows = 0, out = 0, unresolved = 0;
  const seen = new Set<string>();
  for (const i of feed.rows) {
    const r = xref.get(i.espnAthleteId) as { sk: string } | undefined;
    // NOT fantasy-relevant, or a name the identity registry has never seen. Counted rather than
    // dropped in silence: an unresolved designation is a coverage fact, and a feed whose resolution
    // collapses would otherwise read exactly like a week with no injuries.
    if (!r) { unresolved++; continue; }
    if (seen.has(r.sk)) continue;                      // one row per player
    seen.add(r.sk);
    ins.run({ season: feed.season, week: feed.week, sk: String(r.sk), espn: String(i.espnAthleteId),
      name: i.name, status: i.status, detail: i.detail, asOf: i.asOf, now });
    rows++; if (i.status === "Out") out++;
  }
  return { rows, out, unresolved };
}

export async function ingestGamedayStatus(
  opts: { dbPath?: string; week?: number; year?: number; fixture?: string; saveFixture?: string } = {},
): Promise<{ season: number; week: number; events: number; rows: number; out: number; unresolved: number; source: "espn" | "fixture" }> {
  const feed = opts.fixture ? loadGamedayFixture(opts.fixture) : await fetchGamedayStatus(opts);
  if (opts.saveFixture) saveGamedayFixture(opts.saveFixture, feed);
  const db: DB = openDb(opts.dbPath);
  try {
    const r = storeGamedayStatus(db, feed);
    return { season: feed.season, week: feed.week, events: feed.events, source: feed.source, ...r };
  } finally { db.close(); }
}
