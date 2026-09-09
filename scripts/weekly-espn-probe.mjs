// PROBE, not a feature: what stat blocks does ESPN actually return for a week, through the app
// bridge? Written because the first read came back with 800 players and zero weekly projections,
// and the only honest way to tell "the field is not published" from "we asked wrong" is to look at
// the raw blocks rather than guess at a filter.
//
// Read-only. One GET through src/browser/appBridge.ts. Never writes to ESPN.
//   node --import tsx scripts/weekly-espn-probe.mjs [season] [week]
import { bridgeFetch, bridgeAvailable } from "../src/browser/appBridge.js";
import { openDb } from "../src/db/db.js";

const season = Number(process.argv[2] ?? 2026);
const week = Number(process.argv[3] ?? 1);
if (!bridgeAvailable()) { console.log("app bridge not available -- open the desktop app"); process.exit(2); }

const db = openDb();
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
db.close();

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const attempts = [
  { name: "league + scoringPeriodId in URL",
    url: `${HOST}/seasons/${season}/segments/0/leagues/${lg.league_id}?view=kona_player_info&scoringPeriodId=${week}`,
    filter: { players: { limit: 40, sortPercOwned: { sortPriority: 1, sortAsc: false } } } },
  { name: "league + filterStatsForTopScoringPeriodIds",
    url: `${HOST}/seasons/${season}/segments/0/leagues/${lg.league_id}?view=kona_player_info`,
    filter: { players: { limit: 40, sortPercOwned: { sortPriority: 1, sortAsc: false },
      filterStatsForTopScoringPeriodIds: { value: [week] } } } },
  { name: "leaguedefaults + scoringPeriodId in URL",
    url: `${HOST}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${week}`,
    filter: { players: { limit: 40, sortPercOwned: { sortPriority: 1, sortAsc: false } } } },
];

for (const a of attempts) {
  let players;
  try {
    const body = await bridgeFetch(a.url, { "x-fantasy-filter": JSON.stringify(a.filter) });
    players = JSON.parse(body).players ?? [];
  } catch (e) { console.log(`${a.name}: FAILED -- ${e.message}`); continue; }
  const kinds = new Map();
  let withWeekProj = 0;
  for (const pe of players) {
    const p = pe.player ?? pe.playerPoolEntry?.player ?? {};
    for (const s of p.stats ?? []) {
      const k = `src=${s.statSourceId} split=${s.statSplitTypeId} period=${s.scoringPeriodId} season=${s.seasonId}`;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    if ((p.stats ?? []).some((s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && Number(s.scoringPeriodId) === week)) withWeekProj++;
  }
  console.log(`\n${a.name}: ${players.length} players, ${withWeekProj} with a week-${week} projection`);
  for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1]).slice(0, 10)) console.log(`   ${k}  x${n}`);
  const first = players[0]?.player ?? players[0]?.playerPoolEntry?.player;
  if (first) console.log(`   sample: ${first.fullName}, ${(first.stats ?? []).length} stat blocks`);
}
