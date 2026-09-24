// ROTOGURU DFS SALARIES -> raw_dfs_salary, one (season, week, book) fetch at a time.
//
// Run: npx tsx scripts/ingest-rotoguru-salary.mts [--books dk,fd] [--from 2014] [--to 2021]
//
// THE FEED IS POLITE-RATE AND SMALL: ~400 rows per request, 17 weeks a season. The whole DK+FD
// archive is about 270 requests. A delay is kept between them because this is somebody's free
// hobby server and there is no reason to hammer it.
//
// IT REFUSES TO WRITE A WEEK IT COULD NOT PARSE. A request that returns the header and no rows is
// how this feed says "no data for that week" -- 2022 onward does exactly that -- and writing zero
// rows silently would leave a season looking ingested and empty. Each (season, week) reports its
// own count and the run prints a per-season total, so a hole is visible rather than inferred.
import Database from "better-sqlite3";
import { openDb } from "../src/db/db.ts";
import { nameKey } from "../src/draft/values.ts";

const argv = process.argv.slice(2);
const val = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BOOKS = val("--books", "dk").split(",").map((s) => s.trim()).filter(Boolean);
const FROM = Number(val("--from", "2014"));
const TO = Number(val("--to", "2021"));
const PAUSE_MS = Number(val("--pause", "400"));
const SKILL = new Set(["QB", "RB", "WR", "TE"]);

/** "Mahomes II, Patrick" -> "Patrick Mahomes II". RotoGuru is Last-first; nameKey expects natural. */
function flip(n: string): string {
  const i = n.indexOf(",");
  if (i < 0) return n.trim();
  return `${n.slice(i + 1).trim()} ${n.slice(0, i).trim()}`.trim();
}

const url = (book: string, year: number, week: number): string =>
  `http://rotoguru1.com/cgi-bin/fyday.pl?game=${book}&scsv=1&week=${week}&year=${year}`;

interface Row {
  season: number; week: number; book: string; gid: string | null; name: string; name_key: string;
  pos: string; team: string | null; opp: string | null; home: number | null;
  dfs_points: number | null; salary: number | null;
}

async function fetchWeek(book: string, year: number, week: number): Promise<Row[]> {
  const res = await fetch(url(book, year, week));
  if (!res.ok) return [];
  const html = await res.text();
  const block = html.match(/<pre>([\s\S]*?)<\/pre>/i)?.[1] ?? "";
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(";"));
  lines.shift();                                   // the header row
  const out: Row[] = [];
  for (const l of lines) {
    // Week;Year;GID;Name;Pos;Team;h/a;Oppt;<BOOK> points;<BOOK> salary
    const f = l.split(";");
    if (f.length < 10) continue;
    const pos = (f[4] ?? "").toUpperCase();
    if (!SKILL.has(pos)) continue;                 // DEF/K are priced too; the model fits neither here
    const name = flip(f[3] ?? "");
    const key = nameKey(name);
    if (!name || !key) continue;
    const sal = Number(f[9]);
    const pts = Number(f[8]);
    out.push({
      season: year, week, book, gid: (f[2] ?? "").trim() || null, name, name_key: key, pos,
      team: (f[5] ?? "").trim().toUpperCase() || null,
      opp: (f[7] ?? "").trim().toUpperCase() || null,
      home: (f[6] ?? "").trim().toLowerCase() === "h" ? 1 : (f[6] ?? "").trim().toLowerCase() === "a" ? 0 : null,
      dfs_points: Number.isFinite(pts) ? pts : null,
      salary: Number.isFinite(sal) && sal > 0 ? Math.round(sal) : null,
    });
  }
  return out;
}

const db: Database.Database = openDb();
const up = db.prepare(
  `INSERT INTO raw_dfs_salary
     (season, week, book, gid, name, name_key, pos, team, opp, home, dfs_points, salary, fetched_at)
   VALUES (@season, @week, @book, @gid, @name, @name_key, @pos, @team, @opp, @home, @dfs_points, @salary, @fetched_at)
   ON CONFLICT(season, week, book, name_key, pos) DO UPDATE SET
     gid=excluded.gid, name=excluded.name, team=excluded.team, opp=excluded.opp, home=excluded.home,
     dfs_points=excluded.dfs_points, salary=excluded.salary, fetched_at=excluded.fetched_at`,
);
const now = new Date().toISOString();

console.log(`books ${BOOKS.join(",")} | seasons ${FROM}-${TO} | pause ${PAUSE_MS}ms`);
let grand = 0;
for (const book of BOOKS) {
  for (let year = FROM; year <= TO; year++) {
    let seasonRows = 0;
    const empties: number[] = [];
    for (let week = 1; week <= 17; week++) {
      let rows: Row[] = [];
      try { rows = await fetchWeek(book, year, week); } catch { rows = []; }
      if (!rows.length) { empties.push(week); }
      else {
        db.transaction(() => { for (const r of rows) up.run({ ...r, fetched_at: now }); })();
        seasonRows += rows.length;
      }
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    grand += seasonRows;
    console.log(
      `  ${book} ${year}: ${String(seasonRows).padStart(6)} rows` +
      (empties.length ? `   EMPTY weeks: ${empties.join(",")}` : ""),
    );
  }
}
console.log(`total written: ${grand}`);
const chk = db.prepare(
  "SELECT book, COUNT(*) n, COUNT(DISTINCT season) s, SUM(salary IS NULL) nosal FROM raw_dfs_salary GROUP BY book",
).all() as { book: string; n: number; s: number; nosal: number }[];
for (const c of chk) console.log(`  stored ${c.book}: ${c.n} rows over ${c.s} seasons, ${c.nosal} without a salary`);
db.close();
