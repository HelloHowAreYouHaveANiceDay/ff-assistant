/**
 * THE LEAGUE'S FORMAT HISTORY, one row per season, straight from ESPN's own settings.
 *
 * This exists because the calibration had been assuming one format for eight seasons. Printing the
 * table is the cheapest possible check on that assumption: the moment the columns differ between
 * rows, every historical average computed under a constant is measuring a league that did not play.
 *
 *   node --import tsx scripts/format-history.mjs
 */
import Database from "better-sqlite3";
import { dataPath } from "../src/data/paths.ts";

// ---- --league <id>, default the store's active league (mirrors activeLeagueId in src/db/db.ts) --
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const explicitLeague = argOf("--league");
// db path is the first positional (non "--league"/its value) argument, as before
const dbPathArg = process.argv.slice(2).filter((v, i, a) => !(v === "--league" || a[i - 1] === "--league"))[0];

const db = new Database(dbPathArg ?? dataPath("ff.db"), { readonly: true });

function resolveLeague(explicit) {
  if (explicit) return String(explicit);
  const sel = db.prepare("SELECT value FROM settings WHERE key='active_league'").get();
  if (sel && sel.value && db.prepare("SELECT 1 FROM league WHERE league_id=?").get(sel.value)) return String(sel.value);
  const r = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
  return r ? String(r.league_id) : null;
}
const leagueId = resolveLeague(explicitLeague);
if (!leagueId) { console.log("no league found -- run a league sync first"); process.exit(1); }
console.log(`league ${leagueId}`);

const rows = db.prepare(
  `SELECT s.season, s.size, s.reg_weeks, s.playoff_teams, s.playoff_round_weeks,
          s.playoff_reseed, s.seeding_rule, s.division_count,
          (SELECT COUNT(*) FROM fact_team_season t
            WHERE t.season = s.season AND t.league_id = s.league_id AND t.playoff_teams IS NOT NULL) AS carried
     FROM raw_league_season s WHERE s.league_id = ? AND s.available = 1 ORDER BY s.season`,
).all(leagueId);

console.log("season  teams  regWks  playoffs  field  rndWks  reseed  seeding                  divs  fact_team_season rows carrying it");
let missing = 0;
for (const r of rows) {
  if (r.reg_weeks == null) { missing++; }
  const po = r.reg_weeks == null ? "?" :
    Array.from({ length: 3 }, (_, i) => r.reg_weeks + 1 + i).join("/");
  console.log(
    `${r.season}    ${String(r.size ?? "?").padStart(2)}     ${String(r.reg_weeks ?? "?").padStart(2)}` +
    `      ${po.padEnd(9)} ${String(r.playoff_teams ?? "?").padStart(2)}      ${String(r.playoff_round_weeks ?? "?")}` +
    `      ${r.playoff_reseed == null ? "?" : (r.playoff_reseed ? "yes" : "no ")}     ` +
    `${String(r.seeding_rule ?? "?").padEnd(24)} ${String(r.division_count ?? "?").padStart(2)}    ${r.carried}`,
  );
}
if (missing) console.log(`\nWARNING: ${missing} season(s) carry NO format -- re-run \`ff ingest-raw league-history\`.`);
db.close();
