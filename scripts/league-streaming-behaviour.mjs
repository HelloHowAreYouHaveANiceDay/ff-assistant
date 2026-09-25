// DOES THIS LEAGUE STREAM K AND DST? (2026-09-25) -- the premise behind reading the K/DST streaming
// replay's null as "the room already streams, so the good matchups are gone".
//
//   node scripts/league-streaming-behaviour.mjs [--league 462233]
//
// From the league's own history:
//   1. STARTER CHURN   per team-season, how often the STARTED K / DST changed from the previous week
//                      (weeks where both are known), and how many distinct ones were started.
//   2. PICKUPS         K / DST adds per team-season (raw_league_transaction ADD items, position from the
//                      weekly rosters).
//   3. WHO STREAMS     team-seasons bucketed: holder (<= 2 distinct starters), mixed (3-4), streamer (5+).
//   4. ARE THE GOOD MATCHUPS GONE?  each week, the five DSTs facing the LOWEST opponent implied totals
//                      (Vegas, before kickoff): what share are ROSTERED (by anyone) vs in the free pool?
//                      Compared against the five with the HIGHEST opponent implied totals -- if the room
//                      streams on matchups, the good-matchup defences are rostered far more often.
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const LEAGUE = val("--league", "462233");
const db = new Database("data/ff.db", { readonly: true });

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (x) => `${(100 * x).toFixed(0)}%`;

// ---- 1 + 3: starter churn ----
const starters = db.prepare(
  "SELECT season, week, team_id, pos, player_sk sk FROM fact_roster_week WHERE league_id=? AND pos IN ('K','DST') AND is_starter=1 AND player_sk IS NOT NULL",
).all(LEAGUE);
const seasons = [...new Set(starters.map((r) => r.season))].sort((a, b) => a - b);
const byTs = new Map();   // season|team|pos -> Map(week -> sk)
for (const r of starters) {
  const k = `${r.season}|${r.team_id}|${r.pos}`;
  (byTs.get(k) ?? byTs.set(k, new Map()).get(k)).set(r.week, r.sk);
}

// ---- 2: pickups ----
const posOf = new Map();
for (const r of db.prepare("SELECT DISTINCT espn_player_id id, position FROM raw_league_roster_week WHERE league_id=?").all(LEAGUE)) {
  if (r.position === "D/ST" || r.position === "DST") posOf.set(String(r.id), "DST");
  else if (r.position === "K") posOf.set(String(r.id), "K");
}
const adds = new Map();   // season|team|pos -> n
for (const r of db.prepare(
  "SELECT season, to_team_id team, espn_player_id id FROM raw_league_transaction WHERE league_id=? AND item_type='ADD' AND status='EXECUTED' AND to_team_id IS NOT NULL AND to_team_id <> '-1'",
).all(LEAGUE)) {
  const pos = posOf.get(String(r.id)) ?? (Number(r.id) < 0 ? "DST" : null);
  if (!pos) continue;
  const k = `${r.season}|${r.team}|${pos}`;
  adds.set(k, (adds.get(k) ?? 0) + 1);
}

console.log(`\nK / DST STREAMING IN LEAGUE ${LEAGUE} -- per team-season (regular + playoff weeks the rosters cover)\n`);
for (const pos of ["DST", "K"]) {
  console.log(`  ${pos}   season  team-seasons  weeks/ts  started-changed  distinct started  adds/ts   holder / mixed / streamer`);
  const all = { chg: [], dist: [], adds: [], buckets: [0, 0, 0] };
  for (const y of seasons) {
    const rows = [...byTs.entries()].filter(([k]) => k.startsWith(`${y}|`) && k.endsWith(`|${pos}`));
    const chg = [], dist = [], nAdds = [], wks = [];
    const buckets = [0, 0, 0];
    for (const [k, m] of rows) {
      const weeks = [...m.keys()].sort((a, b) => a - b);
      wks.push(weeks.length);
      let c = 0, n = 0;
      for (let i = 1; i < weeks.length; i++) {
        if (weeks[i] !== weeks[i - 1] + 1) continue;
        n++; if (m.get(weeks[i]) !== m.get(weeks[i - 1])) c++;
      }
      if (n) chg.push(c / n);
      const d = new Set(m.values()).size;
      dist.push(d);
      buckets[d <= 2 ? 0 : d <= 4 ? 1 : 2]++;
      nAdds.push(adds.get(k) ?? 0);
    }
    all.chg.push(...chg); all.dist.push(...dist); all.adds.push(...nAdds); buckets.forEach((b, i) => { all.buckets[i] += b; });
    console.log(`        ${y}      ${String(rows.length).padStart(4)}        ${mean(wks).toFixed(1).padStart(5)}        ${pct(mean(chg)).padStart(5)}            ${mean(dist).toFixed(1).padStart(4)}          ${mean(nAdds).toFixed(1).padStart(4)}     ${buckets.join(" / ")}`);
  }
  console.log(`        ALL                                  ${pct(mean(all.chg)).padStart(5)}            ${mean(all.dist).toFixed(1).padStart(4)}          ${mean(all.adds).toFixed(1).padStart(4)}     ${all.buckets.join(" / ")}  (${pct(all.buckets[2] / all.dist.length)} streamers)\n`);
}

// ---- 4: are the good matchups gone? (DST: opponent's implied total, low = good; K: own team's, high = good) ----
for (const pos of ["DST", "K"]) {
  const rostered = new Set(db.prepare("SELECT season, week, player_sk sk FROM fact_roster_week WHERE league_id=? AND pos=? AND player_sk IS NOT NULL").all(LEAGUE, pos).map((r) => `${r.season}|${r.week}|${r.sk}`));
  const rows4 = db.prepare(
    "SELECT season, week, player_sk sk, implied_team_total it, total_line tl FROM feat_player_week WHERE pos=? AND is_bye=0 AND implied_team_total IS NOT NULL AND total_line IS NOT NULL AND season BETWEEN ? AND ?",
  ).all(pos, seasons[0], seasons[seasons.length - 1]);
  const rosterWeeks = new Set([...rostered].map((k) => k.split("|").slice(0, 2).join("|")));
  const byWeek = new Map();
  for (const r of rows4) {
    const k = `${r.season}|${r.week}`;
    if (!rosterWeeks.has(k)) continue;
    // "goodness": lower is a better matchup, so a DST sorts on the opponent's implied total and a K on
    // minus his own team's.
    (byWeek.get(k) ?? byWeek.set(k, []).get(k)).push({ ...r, bad: pos === "DST" ? r.tl - r.it : -r.it });
  }
  console.log(`  ARE THE GOOD ${pos} MATCHUPS GONE? share of the week's ${pos}s that are ROSTERED, by ${pos === "DST" ? "OPPONENT" : "OWN TEAM"} implied total`);
  console.log("    season   5 best matchups   middle   5 worst matchups   (weeks)");
  const tot = { easy: [], mid: [], hard: [] };
  for (const y of seasons) {
    const e = [], m = [], h = [];
    for (const [k, list] of byWeek) {
      if (!k.startsWith(`${y}|`)) continue;
      const srt = [...list].sort((a, b) => a.bad - b.bad);
      if (srt.length < 15) continue;
      const share = (xs) => xs.filter((r) => rostered.has(`${r.season}|${r.week}|${r.sk}`)).length / xs.length;
      e.push(share(srt.slice(0, 5))); h.push(share(srt.slice(-5))); m.push(share(srt.slice(5, -5)));
    }
    tot.easy.push(...e); tot.mid.push(...m); tot.hard.push(...h);
    console.log(`    ${y}          ${pct(mean(e)).padStart(4)}           ${pct(mean(m)).padStart(4)}          ${pct(mean(h)).padStart(4)}          ${e.length}`);
  }
  console.log(`    ALL           ${pct(mean(tot.easy)).padStart(4)}           ${pct(mean(tot.mid)).padStart(4)}          ${pct(mean(tot.hard)).padStart(4)}\n`);
}
