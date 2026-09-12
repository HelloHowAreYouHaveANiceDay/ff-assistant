/**
 * raw_fftoday_proj -- FFToday's single-expert PRESEASON projected fantasy points.
 *
 * This one raw source does NOT come off a public feed like the nflverse sources in rawSources.ts; it
 * was scraped once into `data/fftoday-proj.csv` (season,pos,name,team,proj_fpts; 2008-2024, QB/RB/WR/TE)
 * and is committed as history. So the ingester reads that local file rather than fetching, but it
 * obeys the same raw-layer rules: EXACTLY WHAT THE SOURCE GAVE (proj_fpts is FFToday's own scoring,
 * stored verbatim), and NO IDENTITY RESOLUTION beyond deriving the canonical `name_key` -- the only
 * bridge to the player universe, since the scrape carries a name+team and no stable id.
 */
import { readFileSync } from "node:fs";
import { openDb, nowIso } from "../db/db.js";
import { parseCsv, pick } from "./nflverse.js";
import { num, int, str } from "./rawSources.js";
import { dataPath } from "./paths.js";
import { nameKey } from "../draft/values.js";

/**
 * Read data/fftoday-proj.csv, derive name_key via the canonical nameKey, and upsert into
 * raw_fftoday_proj. Every bound value is coerced null-safe (num/int/str/nameKey never return
 * undefined) so no bind hits the better-sqlite3 undefined trap. Returns the row count landed.
 */
export function ingestFftodayProj({ dbPath }: { dbPath?: string } = {}): number {
  const rows = parseCsv(readFileSync(dataPath("fftoday-proj.csv"), "utf8"));
  const db = openDb(dbPath);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO raw_fftoday_proj (season, pos, name, team, proj_fpts, name_key, fetched_at)
     VALUES (@season, @pos, @name, @team, @proj, @key, @now)
     ON CONFLICT(season, name_key, pos) DO UPDATE SET
       name=excluded.name, team=excluded.team, proj_fpts=excluded.proj_fpts, fetched_at=excluded.fetched_at`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const season = int(pick(r, "season"));
      const pos = str(pick(r, "pos"));
      const name = str(pick(r, "name"));
      const key = nameKey(pick(r, "name"));
      // name_key is the join key and part of the PK -- a row we cannot key is dropped, not stored blank.
      if (season == null || !pos || !key) continue;
      ins.run({ season, pos, name, team: str(pick(r, "team")), proj: num(pick(r, "proj_fpts")), key, now });
      n++;
    }
  })();
  db.close();
  return n;
}
