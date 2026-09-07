// Strength of schedule for the FANTASY PLAYOFFS (weeks 15-17) -- the only weeks that decide a title.
//
//   node scripts/playoff-sos.mjs              # our roster
//   node scripts/playoff-sos.mjs --all        # all 32 teams, ranked
//   node scripts/playoff-sos.mjs "Jalen Hurts" "Jared Goff"    # compare named players
//
// WHY THIS DOES NOT USE defense-vs-position.
// The obvious build is "opponent's DvP multiplier for the player's position". We measured whether
// that carries year to year (tools/verify_dvp_signal.py) and it does not: r = +0.07 QB, +0.19 RB,
// +0.01 WR, +0.11 TE across 64 team-season pairs, where the standard error is ~0.125. Not one is
// distinguishable from zero. The same pipeline recovers r = +0.32 for team OFFENSE, so it can see
// real persistence when it exists -- prior-year DvP simply has none to see.
//
// What DOES persist is overall team quality, so opponent strength is taken from the 2026 BETTING
// MARKET: forward-looking, priced on current rosters, and already in our `game` table. Team ratings
// are solved from the posted lines as a simultaneous system (a team's average spread is confounded
// by whom it happened to play; this is not), then averaged over each team's weeks 15-17 opponents.
//
// HONEST LIMITS: ratings come from the ~7 weeks of lines posted so far and cannot know a November
// injury. Numbers are in POINTS of market spread -- a +2.0 playoff SOS means opponents about two
// points better than average.
//
// The spread-to-fantasy-points conversion below is MEASURED, not assumed (tools/spread_to_points.py:
// each team's feature player at each position, 2023-25, n=1632 per position, regressed on the team's
// own spread). All four slopes run the expected way -- more favoured, more points -- at r = -0.11 to
// -0.24. An earlier draft of this file guessed 0.7 pts per point of spread for every position; the
// real QB figure is 0.31 and TE is 0.09, so the guess overstated the effect by 2-8x. The effect is
// real but SMALL: it breaks ties between comparable players and does not overturn a projection gap.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { leagueCalendar, nameKey } from "../src/league/index.ts";

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const named = args.filter((a) => !a.startsWith("--"));
const HOME_EDGE = 1.0; // points; modern NFL home field
// fantasy points lost per point of harder opponent, per position -- measured, see header
const PTS_PER_SPREAD = { QB: 0.308, RB: 0.271, WR: 0.161, TE: 0.087 };

const db = new Database("data/ff.db", { readonly: true });
// Calendar from the LEAGUE, not hardcoded: a 13-week regular season moves the playoffs, and a
// hardcoded 15/16/17 would be silently wrong rather than broken.
const { season: SEASON, regWeeks, playoffWeeks: PLAYOFF_WEEKS } = leagueCalendar(db);
const games = db.prepare("SELECT week, team, opponent, home, spread_line FROM game WHERE season=?").all(SEASON);
if (!games.length) { console.log("no schedule rows -- run: npx tsx src/ff.ts ingest-source byes"); process.exit(1); }

// --- market-implied team ratings, solved from the posted lines ---------------------------------
// For a game, the market's expected margin for `team` is -spread_line (negative spread = favoured).
// That margin should equal rating(team) - rating(opponent) + home edge. Solve by iteration.
const withLine = games.filter((g) => g.spread_line != null);
const teams = [...new Set(games.map((g) => g.team))].sort();
const rating = new Map(teams.map((t) => [t, 0]));
for (let iter = 0; iter < 200; iter++) {
  const next = new Map();
  for (const t of teams) {
    const mine = withLine.filter((g) => g.team === t);
    if (!mine.length) { next.set(t, rating.get(t)); continue; }
    // rating(t) = margin + rating(opp) - homeEdge*sign, averaged over its priced games
    const est = mine.map((g) => (-g.spread_line) + rating.get(g.opponent) - HOME_EDGE * (g.home ? 1 : -1));
    next.set(t, est.reduce((a, b) => a + b, 0) / est.length);
  }
  const mean = [...next.values()].reduce((a, b) => a + b, 0) / next.size;
  for (const [t, v] of next) rating.set(t, v - mean); // centre so 0 = league average
}

// --- playoff SOS: average opponent rating over weeks 15-17 -------------------------------------
const sos = new Map();
for (const t of teams) {
  const wk = games.filter((g) => g.team === t && PLAYOFF_WEEKS.includes(g.week));
  if (!wk.length) continue;
  const opps = wk.map((g) => ({ w: g.week, opp: g.opponent, r: rating.get(g.opponent) ?? 0, home: g.home, priced: g.spread_line != null }));
  sos.set(t, { avg: opps.reduce((a, o) => a + o.r, 0) / opps.length, opps });
}
const ranked = [...sos.entries()].sort((a, z) => a[1].avg - z[1].avg); // easiest first
const rankOf = new Map(ranked.map(([t], i) => [t, i + 1]));

const nGames = 32 * PLAYOFF_WEEKS.length;
const pricedPlayoff = games.filter((g) => PLAYOFF_WEEKS.includes(g.week) && g.spread_line != null).length;
console.log(`PLAYOFF SOS -- ${SEASON} weeks ${PLAYOFF_WEEKS.join("/")}  (regular season ends week ${regWeeks})`);
console.log(`team ratings solved from ${withLine.length} priced games (points vs league average).`);
console.log(`${pricedPlayoff} of ${nGames} playoff-week games have a posted line yet,`);
console.log(`so opponent quality is the market's CURRENT read, projected forward. Re-run in November.\n`);

const line = (t) => {
  const s = sos.get(t);
  const detail = s.opps.map((o) => `w${o.w} ${o.home ? "vs" : "@"} ${o.opp}${o.r >= 0 ? "+" : ""}${o.r.toFixed(1)}`).join("  ");
  return `${String(rankOf.get(t)).padStart(2)}/32  ${t.padEnd(4)} ${(s.avg >= 0 ? "+" : "") + s.avg.toFixed(2)}`.padEnd(22) + detail;
};

if (ALL) {
  console.log("  rk  team  SOS     opponents (rating; negative = weaker opponent = EASIER for us)");
  for (const [t] of ranked) console.log("  " + line(t));
  console.log("\nrank 1 = easiest playoff schedule.");
  db.close();
  process.exit(0);
}

// --- players: ours, or the ones named on the command line --------------------------------------
// Named players resolve from our own db, so the common cases stay runnable OFFLINE. Only "our
// roster" needs the live league, and that is the one thing the adaptor must be opened for.
const teamOf = new Map(), posOf = new Map(), projOf = new Map();
for (const r of db.prepare("SELECT name, position, nfl_team FROM player").all()) {
  teamOf.set(nameKey(r.name), r.nfl_team);
  posOf.set(nameKey(r.name), r.position);
}
for (const f of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")))
  projOf.set(nameKey(f[0]), Number(f[2]));
const nk = nameKey;

let who = named, league = null;
if (!who.length) {
  const { openLeague } = await import("../src/league/index.ts");
  league = await openLeague();
  who = league.me.roster.map((p) => p.name);
}
db.close();
if (league) await league.close();

console.log("  pos  player                  team  playoff SOS   rk    season proj   SOS cost/wk");
const rows = who.map((n) => {
  const k = nk(n), t = teamOf.get(k);
  return { n, t, pos: posOf.get(k) ?? "?", proj: projOf.get(k) ?? 0, s: t ? sos.get(t) : null };
}).sort((a, z) => (a.s?.avg ?? 99) - (z.s?.avg ?? 99));
for (const r of rows) {
  if (!r.s) { console.log(`  ${(r.pos ?? "?").padEnd(4)} ${r.n.slice(0, 23).padEnd(24)} ${(r.t ?? "?").padEnd(5)} -- no schedule found`); continue; }
  // cost is relative to an AVERAGE schedule (rating 0), so a negative SOS shows as a gain
  const cost = r.s.avg * (PTS_PER_SPREAD[r.pos] ?? 0.2);
  console.log(`  ${r.pos.padEnd(4)} ${r.n.slice(0, 23).padEnd(24)} ${r.t.padEnd(5)} ${((r.s.avg >= 0 ? "+" : "") + r.s.avg.toFixed(2)).padStart(8)}   ${String(rankOf.get(r.t)).padStart(2)}/32  ${String(Math.round(r.proj)).padStart(8)}   ${((cost > 0 ? "-" : "+") + Math.abs(cost).toFixed(2)).padStart(9)}`);
}
console.log(`\nNEGATIVE SOS = weaker playoff opponents = better. Sorted easiest first.`);
console.log(`"SOS cost/wk" is the MEASURED fantasy swing in weeks 15-17 vs an average schedule,`);
console.log(`using the per-position slopes in the header (QB .31, RB .27, WR .16, TE .09 pts per`);
console.log(`point of spread). Compare it against the SEASON PROJECTION GAP before acting: for a`);
console.log(`typical starter the SOS term is under a point a week and rarely decides anything.`);
