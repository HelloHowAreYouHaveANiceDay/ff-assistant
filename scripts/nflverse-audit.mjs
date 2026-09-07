// WHAT DOES NFLVERSE GIVE US THAT WE DO NOT USE?
//
//   node --import tsx scripts/nflverse-audit.mjs
//
// An inventory, not an opinion: fetch the real column headers from each feed and check every one
// against our own source tree. The point is to find columns we have never once read -- an audit done
// from memory would list what I already know we use, which is exactly the set that cannot contain a
// surprise.
//
// Two things it deliberately does NOT do. It does not judge whether an unused column is worth using
// -- that needs a measurement per candidate, not a grep. And it does not treat "unused" as "missing
// feature": most of these columns are genuinely irrelevant to season-long fantasy, and the value of
// the list is that it makes the handful that are NOT irrelevant visible among them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { URLS, playerWeekUrl, teamWeekUrl } from "../src/data/nflverse.ts";

// --- everything we have ever written, as one haystack ---------------------------------------------
function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) { if (f !== "node_modules" && f !== ".git") walk(p, acc); }
    else if (/\.(ts|mjs|js|py)$/.test(f)) acc.push(p);
  }
  return acc;
}
const files = [...walk("src"), ...walk("scripts"), ...walk("test")];
const HAY = files.map((f) => readFileSync(f, "utf8")).join("\n");

const FEEDS = {
  "players": URLS.players,
  "schedules (games)": URLS.schedules,
  "combine": URLS.combine,
  "stats_player_week": playerWeekUrl(2024),
  "stats_team_week": teamWeekUrl(2024),
};

// Columns that exist purely to identify a row. Listing them as "unused signal" would be noise.
const KEYS = /^(season|week|season_type|game_id|player_id|player_name|player_display_name|gsis_id|pfr_id|pff_id|otc_id|esb_id|smart_id|espn_id|yahoo_id|sleeper_id|rotowire_id|rotoworld_id|sportradar_id|fantasy_data_id|team|recent_team|opponent_team|position|position_group|headshot_url|display_name|full_name|first_name|last_name|short_name|football_name|suffix|status|status_short_description|current_team_id|jersey_number|uniform_number)$/;

const report = {};
for (const [name, url] of Object.entries(FEEDS)) {
  let head;
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`  ${name}: HTTP ${res.status} -- skipped`); continue; }
    const text = await res.text();
    head = text.slice(0, text.indexOf("\n")).trim();
  } catch (e) { console.log(`  ${name}: ${e.message} -- skipped`); continue; }
  const cols = head.split(",").map((c) => c.replace(/^"|"$/g, "").trim()).filter(Boolean);
  const used = [], unused = [], keys = [];
  for (const c of cols) {
    if (KEYS.test(c)) { keys.push(c); continue; }
    // Quoted so a short name like "carries" cannot match inside another identifier by accident.
    const re = new RegExp(`["'\`]${c}["'\`]|\\.${c}\\b|\\b${c}:`, "");
    (re.test(HAY) ? used : unused).push(c);
  }
  report[name] = { cols, used, unused, keys };
}

console.log(`\nNFLVERSE COLUMN AUDIT -- ${files.length} source files searched\n`);
for (const [name, r] of Object.entries(report)) {
  console.log(`${name}  --  ${r.cols.length} columns: ${r.used.length} used, ${r.unused.length} unused, ${r.keys.length} identifiers`);
  console.log(`  USED:   ${r.used.join(", ") || "(none)"}`);
  console.log(`  UNUSED: ${r.unused.join(", ") || "(none)"}\n`);
}
