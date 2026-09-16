// THE YAHOO LEAGUE'S REAL DRAFT, INTO THE STORE (M2e).
//
// WHY THIS EXISTS. `data/formats/sc-a845f67652fb/golden.json` gates this format on a room that is
// NOT this league's managers: "the store holds no raw_league_pick for 129048, so the field is a
// generic best-available room off our own VOR book". This is the verb that ends that -- it reads the
// league's own draft-results page through the app's logged-in `yahooview` guest and writes
// `raw_league_pick` / `raw_league_season` / `raw_league_team_season`, then rebuilds
// `fact_draft_pick`. `scripts/snake-room-error.mjs` is what consumes it.
//
// WHY A SCRIPT AND NOT `ff ingest-raw league-history`. That verb resolves the ACTIVE league and
// refuses a non-ESPN platform by name (`requirePlatform(..., "espn", ...)`), and its loader takes an
// ESPN `SeasonSnapshot`. The Yahoo path needs a different loader for a stated reason (a Yahoo draft
// page publishes a team NAME and nothing else -- see `loadYahooDraftHistory`), and nothing here
// reimplements a parser or a loader: both live in src/.
//
// READ-ONLY against Yahoo. Every fetch is a GET.
//
//   npx tsx scripts/yahoo-draft-ingest.mjs [--league 129048] [--dry-run] [--save-fixtures <dir>]
import { writeFileSync } from "node:fs";
import { openDb, nowIso } from "../src/db/db.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { loadYahooDraftHistory } from "../src/data/leagueHistory.ts";
import { yahooIO, yahooPlatform, yahooDraftSeasons } from "../src/league/yahoo.ts";
import { buildDraftPicks } from "../src/features/picks.ts";

const arg = (flag, dflt = null) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const has = (flag) => process.argv.includes(flag);
const leagueId = arg("--league", "129048");
const dry = has("--dry-run");
const fixtureDir = arg("--save-fixtures");

/** TEAM NAMES ARE JOINED ON THEIR LETTERS AND DIGITS ONLY. The draft page and the all-rosters page
 *  spell the same team differently often enough that an exact match is not a join: a curly
 *  apostrophe, `&#039;`, and a trailing emoji all appear in this league's twelve names. Stripping to
 *  alphanumerics is a join on the part of the name a human reads, and a collision between two teams
 *  under it is refused below rather than resolved by whichever came first. */
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

const db = openDb();
const ctx = resolveLeagueContext(db, leagueId);
if (ctx.platformRaw !== "yahoo") throw new Error(`league ${leagueId} is on "${ctx.platformRaw}", not yahoo -- this ingester reads Yahoo pages and would stamp them with an ESPN league's id.`);
const season = ctx.rowSeason ?? ctx.config.season;
const slots = Array.isArray(ctx.config.slots) ? ctx.config.slots : [];
const teamsCfg = Number(ctx.config.teams ?? 0);
if (!teamsCfg) throw new Error(`config:${leagueId} names no team count -- re-sync the league before ingesting its draft.`);

// The CURRENT season's team ids, observed from the all-rosters page rather than counted 1..N.
const rosters = await yahooPlatform.syncRosters(yahooIO, leagueId, season);
const idByName = new Map();
for (const r of rosters) {
  if (idByName.has(key(r.teamName))) throw new Error(`two teams normalize to the same name key "${key(r.teamName)}" -- the draft page's team column cannot be joined to a team id unambiguously. Nothing was written.`);
  idByName.set(key(r.teamName), r.teamId);
}

const drafts = await yahooDraftSeasons(yahooIO, leagueId, teamsCfg);
console.log(`league ${leagueId}: the draft page offers ${drafts.length} season(s): ${drafts.map((d) => `${d.season} (${d.period}, ${d.rounds} rounds x ${d.teams})`).join(", ")}`);

if (fixtureDir) {
  // Only the season selector and the `drafttables` region -- the rest of the page is chrome, ads and
  // the logged-in user's own nav, none of which any parser here reads.
  const { yahooUrls } = await import("../src/league/yahoo.ts");
  const carve = (html) => {
    const sel = /<select[^>]*id="yfa-draftresults-select"[\s\S]*?<\/select>/i.exec(html);
    const tbl = /<div[^>]*id="drafttables"[\s\S]*?(?=<\/section>)/i.exec(html);
    return `<html><body>\n${sel ? sel[0] : ""}\n${tbl ? tbl[0] : ""}\n</body></html>\n`;
  };
  for (const d of drafts) {
    for (const tab of ["round", "team"]) {
      const html = await yahooIO.get(yahooUrls.draftResults(leagueId, tab, d.period));
      const out = `${fixtureDir}/draft-${tab}-${d.season}-${leagueId}.html`;
      writeFileSync(out, carve(html));
      console.log(`  fixture ${out}`);
    }
  }
}

const rows = [];
for (const d of drafts) {
  const current = d.season === season;
  // TEAM IDENTITY, and the honest answer differs by season.
  //   CURRENT  every team name on the draft page joins to a real Yahoo team id from the all-rosters
  //            page, and all twelve must join or nothing is written.
  //   PRIOR    Yahoo's prior-season draft page carries NO team link, and four of this league's twelve
  //            teams RENAMED between 2025 and 2026 -- so most of the prior season's teams cannot be
  //            joined to a current team id at all, and matching the rest by elimination would be
  //            fabricated identity. The team_id IS the published team name for those seasons. It is a
  //            label, it is stated as one in the season's note, and because it is not numeric it can
  //            never be mistaken for a Yahoo team id by a join across seasons.
  const teamIdFor = (name) => {
    if (!current) return name;
    const id = idByName.get(key(name));
    if (!id) throw new Error(`draft ${d.season}: team "${name}" does not match any of the league's ${rosters.length} teams (${[...idByName.keys()].join(", ")}). Nothing was written.`);
    return id;
  };
  const teamNames = [...d.slotOf.keys()];
  rows.push({
    season: d.season,
    teams: teamNames.map((n) => ({ teamId: teamIdFor(n), name: n })),
    slotCounts: current ? slots.reduce((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}) : {},
    picks: d.picks.map((p) => ({ pickNo: p.overallPick, teamId: teamIdFor(p.teamName), name: p.name, pos: p.pos || null })),
    note: `yahoo draftresults (${d.period}), ${d.rounds} rounds x ${d.teams} teams, serpentine checked against the team tab's overall pick numbers; read ${nowIso()}.` +
      (current ? "" : " team_id is the PUBLISHED TEAM NAME, not a Yahoo team id: the prior-season draft page carries no team link and teams renamed."),
  });
  // Serpentine, restated as a number the operator sees rather than only as an internal assertion.
  const slot1 = teamNames.sort((a, b) => d.slotOf.get(a) - d.slotOf.get(b));
  console.log(`  ${d.season}: ${d.picks.length} picks; round-1 order = ${slot1.join(" | ")}`);
}

if (dry) { console.log("--dry-run: nothing written."); db.close(); process.exit(0); }

const before = db.prepare("SELECT league_id, COUNT(*) n FROM raw_league_pick GROUP BY league_id").all();
const counts = loadYahooDraftHistory(db, leagueId, rows, nowIso());
const after = db.prepare("SELECT league_id, COUNT(*) n FROM raw_league_pick GROUP BY league_id").all();
db.close();
console.log(`raw_league_* written: ${JSON.stringify(counts)}`);
console.log(`raw_league_pick BEFORE ${JSON.stringify(before)} AFTER ${JSON.stringify(after)}`);

const built = buildDraftPicks({ leagueId });
console.log(`fact_draft_pick (${built.leagueId}, source ${built.source}): ${built.rows} rows`);
for (const s of built.perSeason) console.log(`  ${s.season}: ${s.picks} picks, ${s.resolved} resolved to a player_sk, ${s.withConsensus} with a preseason consensus (asOf ${s.asOf})`);
if (built.mismatched.length) console.log(`  MISMATCHED SEASONS: ${built.mismatched.join(", ")}`);
