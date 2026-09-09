/**
 * IS THE 2026 SCHEDULE BALANCED, WHERE ARE THE DIVISION GAMES, AND HOW STRONG IS OUR DIVISION?
 *
 *   node --import tsx scripts/schedule-balance.mjs
 *
 * Written because all three of those were CLAIMS being carried between agents, and a claim about a
 * schedule is exactly the kind that survives the schedule changing under it -- which this one did,
 * twice in a day. Everything printed here is recomputed from `raw_league_matchup` and
 * `raw_league_division` at the moment it runs.
 *
 * The division-strength figure is a mean of rostered PROJECTED season points, which is a crude
 * measure and is meant to be: it says which division is soft, not by how much.
 */
import Database from 'better-sqlite3';
const db = new Database('data/ff.db', { readonly: true });
const divs = db.prepare("SELECT division_id, name, team_ids_json FROM raw_league_division WHERE season=2026 ORDER BY division_id").all();
const dOf = new Map();
for (const d of divs) for (const id of JSON.parse(d.team_ids_json)) dOf.set(String(id), d.division_id);
const games = db.prepare("SELECT week, home_id, away_id FROM raw_league_matchup WHERE season=2026 ORDER BY week").all();
console.log('games', games.length, 'weeks', new Set(games.map((g) => g.week)).size);
const perTeam = new Map(), opp = new Map();
for (const g of games) {
  for (const [a, b] of [[g.home_id, g.away_id], [g.away_id, g.home_id]]) {
    perTeam.set(a, (perTeam.get(a) ?? 0) + 1);
    const k = `${a}|${b}`; opp.set(k, (opp.get(k) ?? 0) + 1);
  }
}
console.log('games per team:', [...new Set(perTeam.values())].join(','));
console.log('max meetings with one opponent:', Math.max(...opp.values()));
for (let w = 1; w <= 13; w++) {
  const wk = games.filter((g) => g.week === w);
  const intra = wk.filter((g) => dOf.get(String(g.home_id)) === dOf.get(String(g.away_id))).length;
  console.log(`week ${String(w).padStart(2)}: ${wk.length} games, ${intra} in-division`);
}
// projection strength per division, from player_value on the 2026 board joined through ownership
const proj = db.prepare(`
  SELECT o.team_id, SUM(pv.proj_pts) AS pts, COUNT(*) n
    FROM ownership o JOIN player_value pv ON pv.player_id = o.player_id AND pv.season = 2026
   GROUP BY o.team_id`).all();
const byDiv = new Map();
for (const t of proj) {
  const d = dOf.get(String(t.team_id));
  if (d == null) continue;
  if (!byDiv.has(d)) byDiv.set(d, { pts: 0, teams: 0 });
  byDiv.get(d).pts += t.pts; byDiv.get(d).teams++;
}
console.log('\ndivision mean projected roster points (all rostered players):');
for (const d of divs) {
  const v = byDiv.get(d.division_id);
  if (v) console.log(`  ${d.name.padEnd(16)} ${(v.pts / v.teams).toFixed(1)}  (${v.teams} teams)`);
}
const me = db.prepare("SELECT team_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
console.log('our team id', me.team_id, 'division', dOf.get(String(me.team_id)));
