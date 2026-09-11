// PART A -- size the LINEUP INFORMATION GAP (gap #3, the one decision we lose to humans).
// The live lineup benches OUT/DOUBTFUL but STARTS questionable players (copilot rule), and there is no
// game-day inactive feed -- so a questionable-then-inactive player is started and scores 0. This measures
// the ceiling of what game-day availability info is worth: set each historical lineup by PROJECTION two
// ways and diff the realized points:
//   NAIVE (our live behavior): available = not(OUT/DOUBTFUL/bye); questionable is startable.
//   FRESH (perfect availability): available = actually PLAYED (pts not null), i.e. bench every scratch.
// gap = fresh - naive = points recoverable by knowing who sits, before lock.
//   node --import tsx scripts/inseason-backtest-lineup-info.mjs [--seasons 2018-2024]
import { openDb, getConfig } from "../src/db/db.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";
import { loadWeekContext, loadModel } from "../src/inseason/backtest/context.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2024").split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }
const wm = loadModel("served");
const flexOk = new Set(getConfig(db).flex_ok);

// score a lineup chosen by projection among `availableFn`, paid in ACTUAL points
const scoreLineup = (roster, template, availableFn) => {
  const players = roster.map((m) => ({ name: m.name, pos: m.pos, proj: m.proj, available: availableFn(m) }));
  const starters = optimalLineup(players, template, flexOk).starters.filter((s) => s.name && s.name !== "(empty)");
  const actualOf = new Map(roster.map((m) => [m.name, m.actual]));
  return starters.reduce((s, st) => s + (actualOf.get(st.name) ?? 0), 0);
};

const perSeason = new Map();
let teamWeeks = 0, totalGap = 0, qStarts = 0, qSat = 0;
for (const season of seasons) {
  const regWeeks = (db.prepare("SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?").get(season)?.rw) ?? 14;
  // played-and-status per (week|player_sk)
  const info = new Map();
  for (const r of db.prepare(`SELECT week, player_sk, pts, is_bye, inj_out, inj_doubtful, inj_questionable
      FROM feat_player_week_model WHERE season=? AND player_sk IS NOT NULL`).all(season))
    info.set(`${r.week}|${r.player_sk}`, r);
  const diffs = [];
  for (let W = 1; W <= regWeeks; W++) {
    let wc; try { wc = loadWeekContext(db, lg.league_id, season, W, wm); } catch { continue; }
    for (const [, entries] of wc.rosters) {
      const roster = [];
      for (const e of entries) {
        const p = wc.players.get(e.playerSk); const inf = info.get(`${W}|${e.playerSk}`);
        if (!p) continue;
        roster.push({ name: p.name, pos: p.pos, proj: p.proj ?? p.fallback ?? 0,
          actual: inf?.pts ?? 0, played: inf ? inf.pts != null : false, bye: !!inf?.is_bye,
          out: !!inf?.inj_out || !!inf?.inj_doubtful, q: !!inf?.inj_questionable });
      }
      if (roster.length < 5) continue;
      // NAIVE: bench OUT/DOUBTFUL/bye; questionable startable (our live rule). FRESH: only who played.
      const naive = scoreLineup(roster, wc.template, (m) => !m.out && !m.bye);
      const fresh = scoreLineup(roster, wc.template, (m) => m.played && !m.bye);
      diffs.push(fresh - naive); teamWeeks++; totalGap += fresh - naive;
      for (const m of roster) if (m.q && !m.out && !m.bye) { qStarts++; if (!m.played) qSat++; }
    }
  }
  perSeason.set(season, diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0);
}
db.close();

console.log(`\nLINEUP INFO GAP -- realized points recoverable by knowing game-day availability, ${arg("--seasons", "2018-2024")}`);
console.log(`  (NAIVE starts questionables as the live copilot does; FRESH benches every actual scratch)\n`);
console.log(`  per-team-week gap: ${(totalGap / teamWeeks).toFixed(2)} pts  (over ${teamWeeks} team-weeks)`);
console.log(`  per season: ${[...perSeason].map(([s, g]) => `${s}:${g.toFixed(2)}`).join("  ")}`);
console.log(`  questionable players we'd START: ${qStarts}; of those SAT (scored 0): ${qSat} (${(100 * qSat / qStarts).toFixed(0)}%) -- the avoidable zeros`);
