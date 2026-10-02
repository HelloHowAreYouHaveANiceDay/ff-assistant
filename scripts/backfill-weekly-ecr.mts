/**
 * BACKFILL THE WEEKLY EXPERT CONSENSUS (`ranking_history`, ecr_type 'wp') FROM GIT HISTORY (DIM-1855).
 *
 *   node --import tsx scripts/backfill-weekly-ecr.mts --from 2025-08-25 --to 2025-12-31 [--write]
 *
 * WHY THIS WORKS. The live ingest (`ingestWeekly`, src/data/advanced.ts) reads DynastyProcess's
 * `fp_latest_weekly.csv`, which is overwritten in place -- but in a GIT repository that commits it
 * about twice a day. Every past version is therefore still there. The bulk archive (`db_fpecr.csv.gz`)
 * stopped at 2025-08-08, which left 2025's weekly consensus with zero rows; this recovers it.
 *
 * WHAT IT DOES. Lists the file's commits in the window (via `gh api`), keeps the LAST commit of each
 * UTC day, fetches that version from raw.githubusercontent.com, and replays it through EXACTLY the
 * live path: `weeklyCsvToSnapshotRows` -> `appendWeeklyRankSnapshot` (append-only, keyed by the feed's
 * own scrape_date, INSERT OR IGNORE) -> `fanOutWeeklyRankSnapshot` (each format store's copy). So a
 * backfilled row is byte-for-byte the row the live ingest would have written that day.
 *
 * POINT-IN-TIME. Rows are dated by the FEED'S scrape_date, never by commit or run time; the feature
 * builder then picks, per NFL week, a scrape from before that week's kickoff, exactly as it does for
 * the 2020-2024 archive and for 2026. `--to` should stay in December: `season` is the scrape YEAR on
 * this feed (see appendWeeklyRankSnapshot), so a January scrape would be filed under the next season.
 *
 * DRY RUN unless `--write`: it fetches and counts, and writes nothing.
 */
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db/db.js";
import { fetchCsv } from "../src/data/nflverse.js";
import { weeklyCsvToSnapshotRows } from "../src/data/advanced.js";
import { appendWeeklyRankSnapshot, fanOutWeeklyRankSnapshot } from "../src/data/ecrHistory.js";

const argv = process.argv.slice(2);
const val = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FROM = val("--from"), TO = val("--to");
const WRITE = argv.includes("--write");
if (!FROM || !TO) throw new Error("usage: --from YYYY-MM-DD --to YYYY-MM-DD [--write]");
const REPO = "DynastyProcess/data", PATH = "files/fp_latest_weekly.csv";

const out = execFileSync("gh", ["api", "--paginate",
  `repos/${REPO}/commits?path=${PATH}&since=${FROM}T00:00:00Z&until=${TO}T23:59:59Z&per_page=100`,
  "--jq", ".[] | [.sha, .commit.author.date] | @tsv"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const commits = out.trim().split("\n").filter(Boolean).map((l) => { const [sha, date] = l.split("\t"); return { sha, date }; });
// The LAST commit of each UTC day (the list is newest-first).
const byDay = new Map<string, { sha: string; date: string }>();
for (const c of commits) { const d = c.date.slice(0, 10); if (!byDay.has(d)) byDay.set(d, c); }
const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log(`${commits.length} commits of ${PATH} in ${FROM}..${TO}; ${days.length} days (last version each). ${WRITE ? "WRITING" : "DRY RUN"}`);

const db = openDb();
let inserted = 0, ignored = 0, bad = 0, fetched = 0;
const scrapeDates = new Set<string>();
try {
  for (const [day, c] of days) {
    const rows = await fetchCsv(`https://raw.githubusercontent.com/${REPO}/${c.sha}/${PATH}`);
    fetched++;
    const snap = weeklyCsvToSnapshotRows(rows);
    const dates = [...new Set(snap.map((r) => r.scrapeDate).filter(Boolean))] as string[];
    dates.forEach((d) => scrapeDates.add(d));
    if (!WRITE) { console.log(`  ${day} ${c.sha.slice(0, 8)}: ${rows.length} rows, scrape_date ${dates.join("/") || "NONE"}`); continue; }
    const r = appendWeeklyRankSnapshot(db, snap, day);
    inserted += r.inserted; ignored += r.ignored; bad += r.badRow;
    fanOutWeeklyRankSnapshot(snap, day);
    console.log(`  ${day} ${c.sha.slice(0, 8)}: +${r.inserted} rows (${r.ignored} already held, ${r.badRow} bad) at scrape ${r.dates.join("/")}`);
  }
} finally { db.close(); }
console.log(`fetched ${fetched} versions; ${scrapeDates.size} distinct scrape dates (${[...scrapeDates].sort()[0] ?? "-"} .. ${[...scrapeDates].sort().pop() ?? "-"})` +
  (WRITE ? `; inserted ${inserted}, already held ${ignored}, bad ${bad}` : "; nothing written"));
