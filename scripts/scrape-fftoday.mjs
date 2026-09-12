// Scrape FFToday preseason projected fantasy points for a season into the raw_fftoday_proj CSV format.
//
//   node scripts/scrape-fftoday.mjs --season 2026 [--out data/fftoday-proj-2026.csv]
//
// FFToday's playerproj.php renders an HTML table: each player is a `players/<id>/First_Last?LeagueID=1`
// link followed by cells (team, bye, stat columns) ending in the FANTASY total cell, which is the one
// with BGCOLOR='#e0e0e0'. We take exactly that: name (from the link), team (first cell), proj_fpts (the
// e0e0e0 cell) -- FFToday's own scoring, stored verbatim, matching the 2008-2024 history scrape. No
// identity resolution here; the ingester derives name_key. LeagueID=1 is FFToday's default scoring, the
// same the historical rows used.
import { writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SEASON = Number(arg("--season", "2026"));
const OUT = arg("--out", `data/fftoday-proj-${SEASON}.csv`);
const POS = [["QB", 10], ["RB", 20], ["WR", 30], ["TE", 40]];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').trim();

// One page of one position -> [{name, team, proj_fpts}]. Returns [] when the page has no player rows
// (past the last page), which is the pagination stop condition.
async function scrapePage(posId, page) {
  const url = `https://www.fftoday.com/rankings/playerproj.php?Season=${SEASON}&PosID=${posId}&LeagueID=1&order_by=FFPts&sort_order=DESC&cur_page=${page}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const out = [];
  // Split on player links; each chunk after a link belongs to that player up to the next link.
  const linkRe = /players\/\d+\/([A-Za-z0-9_.'-]+)\?LeagueID=\d+["'][^>]*>/g;
  const marks = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) marks.push({ name: decode(m[1].replace(/_/g, " ")), idx: m.index });
  for (let i = 0; i < marks.length; i++) {
    const chunk = html.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : html.length);
    // team = first smallbody data cell after the name (a 2-3 letter abbrev)
    const teamM = chunk.match(/class=["']smallbody["'][^>]*>\s*([A-Z]{2,3})\s*<\/TD>/i);
    // fantasy points = the e0e0e0-highlighted cell (FFToday marks the fantasy total column this way)
    const fpM = chunk.match(/BGCOLOR=['"]#e0e0e0['"][^>]*>\s*([0-9,]+(?:\.[0-9]+)?)\s*<\/TD>/i);
    if (!fpM) continue;                                    // a link that isn't a projection row
    const fpts = Number(fpM[1].replace(/,/g, ""));
    if (!Number.isFinite(fpts)) continue;
    out.push({ name: marks[i].name, team: teamM ? teamM[1] : "", proj_fpts: fpts });
  }
  return out;
}

async function scrapePos(posName, posId) {
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < 12; page++) {                  // hard cap; FFToday is <=~12 pages/pos
    let batch;
    try { batch = await scrapePage(posId, page); } catch (e) { console.error(`  ${posName} page ${page}: ${e.message}`); break; }
    if (!batch.length) break;                              // past the last page
    let added = 0;
    for (const r of batch) { const k = `${r.name}|${r.team}`; if (seen.has(k)) continue; seen.add(k); rows.push(r); added++; }
    if (added === 0) break;                                // page repeated -> no real pagination past here
  }
  console.log(`  ${posName}: ${rows.length} players`);
  return rows;
}

console.log(`scraping FFToday ${SEASON} ...`);
const lines = ["season,pos,name,team,proj_fpts"];
for (const [posName, posId] of POS) {
  const rows = await scrapePos(posName, posId);
  for (const r of rows) lines.push(`${SEASON},${posName},${r.name},${r.team},${r.proj_fpts}`);
}
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${lines.length - 1} rows -> ${OUT}`);
