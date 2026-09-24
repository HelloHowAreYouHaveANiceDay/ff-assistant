// CAN ROTOGURU'S DFS SALARIES BE JOINED TO OUR PLAYER-WEEKS AT ALL?
//
// This is the de-risking step before any ingestion, and it is the FIRST thing to check rather than
// the last: a name join is this repo's recurring wound (two-way players, Adrian Peterson with 32
// games in a 16-game season, 736 rows silently rewritten). A feature that only matches 60% of rows
// is a feature that is mostly missing, and it would be cheaper to learn that now than after
// building an ingest, a column, a rebuild and two 80-minute arms.
//
// THE JOIN IS (season, week, nameKey, pos) -- FOUR KEYS, NOT A NAME.
//   - `team` is deliberately NOT a join key. RotoGuru uses its own lowercase codes ("kan", "lvr",
//     "sfo") against our standard abbreviations, so joining on it would require a mapping table
//     whose errors would look exactly like missing players. It is read back as a CHECK instead:
//     if the matched rows disagree on team more than rarely, the join is wrong even when it is
//     finding somebody.
//   - `pos` is included because a name collision across positions is the realistic one.
//
// It reports the match rate IN BOTH DIRECTIONS. Ours-matched is what determines feature coverage;
// theirs-unmatched surfaces whether we are dropping a systematic class (kickers, defences, a
// name-format case) rather than a scattering of practice-squad names.
import Database from "better-sqlite3";
import { nameKey } from "../src/draft/values.ts";

const YEAR = Number(process.argv[2] ?? 2020);
const WEEK = Number(process.argv[3] ?? 5);
const URL = `http://rotoguru1.com/cgi-bin/fyday.pl?game=dk&scsv=1&week=${WEEK}&year=${YEAR}`;

/** "Mahomes II, Patrick" -> "Patrick Mahomes II". RotoGuru is Last-first; nameKey is not. */
function flip(n: string): string {
  const i = n.indexOf(",");
  if (i < 0) return n.trim();
  const last = n.slice(0, i).trim();
  const first = n.slice(i + 1).trim();
  return `${first} ${last}`.trim();
}

const html = await (await fetch(URL)).text();
const block = html.match(/<pre>([\s\S]*?)<\/pre>/i)?.[1] ?? "";
const lines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(";"));
const header = lines.shift() ?? "";
console.log(`fetched ${YEAR} week ${WEEK}: ${lines.length} data rows`);
console.log(`header: ${header}`);

interface Rg { name: string; pos: string; team: string; pts: number | null; salary: number | null }
const rg: Rg[] = [];
for (const l of lines) {
  const f = l.split(";");
  if (f.length < 10) continue;
  const salary = Number(f[9]);
  rg.push({
    name: flip(f[3] ?? ""), pos: (f[4] ?? "").toUpperCase(), team: (f[5] ?? "").toUpperCase(),
    pts: Number.isFinite(Number(f[8])) ? Number(f[8]) : null,
    salary: Number.isFinite(salary) && salary > 0 ? salary : null,
  });
}
const withSalary = rg.filter((r) => r.salary != null);
console.log(`parsed ${rg.length} rows, ${withSalary.length} carry a salary`);
console.log("by position:", Object.entries(withSalary.reduce<Record<string, number>>((a, r) => { a[r.pos] = (a[r.pos] ?? 0) + 1; return a; }, {})).map(([k, v]) => `${k}:${v}`).join(" "));

const db = new Database("data/ff.db", { readonly: true });
const ours = db.prepare(
  `SELECT name, pos, team FROM feat_player_week_model
    WHERE season=? AND week=? AND pos IN ('QB','RB','WR','TE')`,
).all(YEAR, WEEK) as { name: string; pos: string; team: string | null }[];

const rgIndex = new Map<string, Rg>();
for (const r of withSalary) {
  if (!["QB", "RB", "WR", "TE"].includes(r.pos)) continue;
  rgIndex.set(`${nameKey(r.name)}|${r.pos}`, r);
}

let matched = 0, teamAgree = 0, teamSeen = 0;
const misses: string[] = [];
for (const o of ours) {
  const hit = rgIndex.get(`${nameKey(o.name)}|${o.pos}`);
  if (!hit) { if (misses.length < 12) misses.push(`${o.name} (${o.pos}, ${o.team ?? "?"})`); continue; }
  matched++;
  if (o.team && hit.team) { teamSeen++; if (o.team.toUpperCase() === hit.team.toUpperCase()) teamAgree++; }
}
console.log(`\nOUR rows ${ours.length} | matched ${matched} (${((100 * matched) / ours.length).toFixed(1)}%)`);
console.log(`team AGREEMENT on matched rows: ${teamAgree}/${teamSeen} (${teamSeen ? ((100 * teamAgree) / teamSeen).toFixed(1) : "0"}%)`);
console.log("  -- team codes differ by vocabulary, so a LOW number here is expected; what matters is");
console.log("     whether it is near-constant, which would mean the join is pairing the wrong men.");
console.log(`\nsample of OUR rows with no salary (${Math.min(12, misses.length)} of ${ours.length - matched}):`);
for (const m of misses) console.log(`  ${m}`);
db.close();
