// Does OUR scoring reproduce ESPN's? Position by position, against ESPN's own applied totals.
//
//   node --import tsx scripts/validate-scoring.mjs
//
// This is the producer/consumer contract test for the scoring layer. Every previous check on this
// data was a check against ITSELF: face validity confirmed 2024 came out DEN, MIN ... CAR last,
// which is the correct ORDERING and which a uniform level error passes effortlessly. The DST points-
// allowed ladder was overstating every defense by ~4-5 points a game and the ranking check never
// flinched. The only thing that catches that is running our numbers against the other side's.
//
// ESPN publishes `appliedTotal` per player per week -- the points it actually awarded. We recompute
// the same player-weeks from nflverse and compare.
import Database from "better-sqlite3";
import { attachWebview } from "../src/browser/webviewPage.ts";
import { scoreWeek, scoreKickerWeek, scoreDefenseWeek, DEFAULT_SCORING } from "../src/draft/scoring.ts";
import { fetchCsv } from "../src/data/nflverse.ts";

const ESPN_TEAM = { 1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",
  11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",
  22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WAS",29:"CAR",30:"JAC",33:"BAL",34:"HOU" };
const SLOT_POS = { 0:"QB",2:"RB",4:"WR",6:"TE",16:"DST",17:"K",23:"FLEX",20:"BE" };
const YR = 2025, WEEKS = [3, 5, 8, 11];
const nk = (s) => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ").replace(/[^a-z]/g, "");

const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
db.close();
const scoring = cfg.scoring_rules ?? DEFAULT_SCORING;

const { browser, raw: wv } = await attachWebview();
if (!/fantasy\.espn\.com/.test(await wv.refreshUrl())) { await wv.goto("https://fantasy.espn.com/football/"); await wv.waitForTimeout(4000); }
// mRoster on the LEAGUE endpoint (not the schedule) is the view that populates fullName AND
// defaultPositionId alongside the scored stats. The matchup view returns stats only, which is why a
// first attempt matched DST -- identified by proTeamId -- and silently dropped every skill player.
const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const espn = [];
for (const WK of WEEKS) {
  const j = await wv.fetchJson(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${YR}/segments/0/leagues/${lg.league_id}?view=mRoster&scoringPeriodId=${WK}`);
  for (const t of j.teams ?? [])
    for (const e of t.roster?.entries ?? []) {
      const pl = e.playerPoolEntry?.player ?? {};
      const st = (pl.stats ?? []).find((s) => s.statSourceId === 0 && s.scoringPeriodId === WK);
      if (!st || st.appliedTotal == null) continue;
      espn.push({ wk: WK, pos: ESPN_POS[pl.defaultPositionId] ?? "?", name: pl.fullName ?? null,
        team: ESPN_TEAM[st.proTeamId] ?? null, applied: st.appliedTotal });
    }
}
await browser.close();
console.log(`ESPN: ${espn.length} scored player-weeks over weeks ${WEEKS.join(", ")} of ${YR}`);

// --- our side, from nflverse -------------------------------------------------------------------
// Use the repo's fetchCsv, NOT a hand-rolled split(","). These feeds carry a QUOTED headshot URL
// containing commas, so naive splitting silently misaligns every field after it -- which surfaced
// as season_type reading "1" instead of "REG" and the entire skill-player join matching nothing,
// while DST (joined on proTeamId from a different feed) kept working and masked it.
const NV = "https://github.com/nflverse/nflverse-data/releases/download";
const players = await fetchCsv(`${NV}/stats_player/stats_player_week_${YR}.csv`);
const teamRows = await fetchCsv(`${NV}/stats_team/stats_team_week_${YR}.csv`);
const games = await fetchCsv(`${NV}/schedules/games.csv`);
const pa = new Map();
for (const g of games) {
  if (g.season !== String(YR) || g.game_type !== "REG") continue;
  const hs = Number(g.home_score), as = Number(g.away_score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
  pa.set(`${g.home_team}|${g.week}`, as); pa.set(`${g.away_team}|${g.week}`, hs);
}
const ours = new Map();
for (const r of players) {
  if (r.season_type !== "REG") continue;
  const pos = (r.position || "").toUpperCase();
  const pts = pos === "K" ? scoreKickerWeek(r) : scoreWeek(r, scoring);
  ours.set(`${nk(r.player_display_name)}|${r.week}`, pts);
}
for (const r of teamRows) {
  if (r.season_type !== "REG") continue;
  const allowed = pa.get(`${r.team}|${r.week}`);
  if (allowed == null) continue;
  ours.set(`DST:${r.team}|${r.week}`, scoreDefenseWeek(r, allowed));
}

// --- compare ------------------------------------------------------------------------------------
const byPos = {};
for (const e of espn) {
  const key = e.pos === "DST" ? `DST:${e.team}|${e.wk}` : (e.name ? `${nk(e.name)}|${e.wk}` : null);
  if (!key) continue;
  const mine = ours.get(key);
  if (mine == null) continue;
  (byPos[e.pos] ??= []).push({ espn: e.applied, mine, name: e.name ?? e.team, wk: e.wk });
}
console.log(`\n  pos    n    mean|err|   bias    r      worst miss`);
let worstPos = null;
for (const [pos, xs] of Object.entries(byPos).sort()) {
  const err = xs.map((x) => Math.abs(x.mine - x.espn));
  const mae = err.reduce((a, b) => a + b, 0) / xs.length;
  const bias = xs.reduce((a, x) => a + (x.mine - x.espn), 0) / xs.length;
  const mx = xs.map((x) => x.mine), ex = xs.map((x) => x.espn);
  const mm = mx.reduce((a, b) => a + b, 0) / mx.length, me = ex.reduce((a, b) => a + b, 0) / ex.length;
  const num = mx.reduce((a, v, i) => a + (v - mm) * (ex[i] - me), 0);
  const dx = Math.sqrt(mx.reduce((a, v) => a + (v - mm) ** 2, 0)), dy = Math.sqrt(ex.reduce((a, v) => a + (v - me) ** 2, 0));
  const r = dx && dy ? num / (dx * dy) : 0;
  const worst = xs.slice().sort((a, b) => Math.abs(b.mine - b.espn) - Math.abs(a.mine - a.espn))[0];
  console.log(`  ${pos.padEnd(5)} ${String(xs.length).padStart(3)}  ${mae.toFixed(2).padStart(8)}  ${(bias >= 0 ? "+" : "") + bias.toFixed(2)}  ${r.toFixed(3)}  ${String(worst.name).slice(0, 18).padEnd(19)} w${worst.wk} ours ${worst.mine.toFixed(1)} vs ${worst.espn.toFixed(1)}`);
  if (mae > 1.5 && (!worstPos || mae > worstPos[1])) worstPos = [pos, mae];
}
console.log(`\n  mean|err| is the average absolute gap in fantasy points per player-week.`);
console.log(`  bias is signed: positive = we OVERSCORE. A large bias with a high r means a level`);
console.log(`  error -- the kind face validity on ranking cannot see.`);
if (worstPos) console.log(`\n  WORST: ${worstPos[0]} at ${worstPos[1].toFixed(2)} pts/week average error.`);
