// B1 -- does a play-probability model recover the lineup info gap (#11, ~1.8 pts/wk)?
// Three lineups per team-week, all set by projection, scored on ACTUAL points:
//   NAIVE : bench OUT/DOUBTFUL/bye; start questionables flat (the live copilot rule).
//   B1    : same benches, but rank by proj x P(active) so a likely-scratch questionable (Q + DNP)
//           loses its slot to a healthy alternative.
//   FRESH : bench every actual scratch (perfect availability -- the Part-A ceiling).
// P(active) is fit LEAVE-ONE-SEASON-OUT. Question: how much of (FRESH-NAIVE) does B1 recover?
//   node --import tsx scripts/inseason-backtest-playprob.mjs [--seasons 2018-2024]
import { openDb, getConfig } from "../src/db/db.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";
import { loadWeekContext, loadModel } from "../src/inseason/backtest/context.ts";
import { fitPlayProb } from "../src/inseason/backtest/playProb.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2024").split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
const wm = loadModel("served");
const flexOk = new Set(getConfig(db).flex_ok);

const lineupActual = (roster, template, rankOf, availableFn) => {
  const players = roster.map((m) => ({ name: m.name, pos: m.pos, proj: rankOf(m), available: availableFn(m) }));
  const starters = optimalLineup(players, template, flexOk).starters.filter((s) => s.name && s.name !== "(empty)");
  const actualOf = new Map(roster.map((m) => [m.name, m.actual]));
  return starters.reduce((s, st) => s + (actualOf.get(st.name) ?? 0), 0);
};

// show the fitted table once (all seasons) for face validity
const show = fitPlayProb(db, { seasons: [lo, hi] });
console.log(`\nB1 play-probability table P(active), key = report|practice:`);
for (const k of Object.keys(show.table).sort()) console.log(`  ${k.padEnd(24)} ${(100 * show.table[k].p).toFixed(0)}%  (n ${show.table[k].n})`);

let tw = 0, sNaive = 0, sB1 = 0, sFresh = 0; const perSeason = new Map();
for (const season of seasons) {
  const pp = fitPlayProb(db, { excludeSeason: season, seasons: [lo, hi] }); // leakage-clean
  const regWeeks = (db.prepare("SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?").get(season)?.rw) ?? 14;
  const status = new Map(), model = new Map();
  for (const r of db.prepare("SELECT week, player_sk, report_status_fri report, practice_status_fri practice FROM feat_player_week_context WHERE season=?").all(season))
    status.set(`${r.week}|${r.player_sk}`, r);
  for (const r of db.prepare("SELECT week, player_sk, pts, is_bye FROM feat_player_week_model WHERE season=? AND player_sk IS NOT NULL").all(season))
    model.set(`${r.week}|${r.player_sk}`, r);
  let n = 0, gN = 0, gB = 0, gF = 0;
  for (let W = 1; W <= regWeeks; W++) {
    let wc; try { wc = loadWeekContext(db, lg.league_id, season, W, wm); } catch { continue; }
    for (const [, entries] of wc.rosters) {
      const roster = [];
      for (const e of entries) {
        const p = wc.players.get(e.playerSk); if (!p) continue;
        const st = status.get(`${W}|${e.playerSk}`), md = model.get(`${W}|${e.playerSk}`);
        const report = st?.report ?? null;
        roster.push({ name: p.name, pos: p.pos, proj: p.proj ?? p.fallback ?? 0, actual: md?.pts ?? 0,
          played: md ? md.pts != null : false, bye: !!md?.is_bye,
          benched: report === "Out" || report === "Doubtful", report, practice: st?.practice ?? null });
      }
      if (roster.length < 5) continue;
      const avail = (m) => !m.benched && !m.bye;
      const naive = lineupActual(roster, wc.template, (m) => m.proj, avail);
      const b1 = lineupActual(roster, wc.template, (m) => m.proj * pp.p(m.report, m.practice), avail);
      const fresh = lineupActual(roster, wc.template, (m) => m.proj, (m) => m.played && !m.bye);
      n++; gN += naive; gB += b1; gF += fresh;
    }
  }
  tw += n; sNaive += gN; sB1 += gB; sFresh += gF;
  perSeason.set(season, { recover: gF > gN ? (gB - gN) / (gF - gN) : 0, b1: (gB - gN) / n });
}
db.close();

const mn = (x) => (x / tw).toFixed(2);
const gapNaiveFresh = (sFresh - sNaive) / tw, gapB1 = (sB1 - sNaive) / tw;
console.log(`\nLINEUP (realized pts/team-week), ${arg("--seasons", "2018-2024")}, ${tw} team-weeks:`);
console.log(`  NAIVE (start Q flat): ${mn(sNaive)}   B1 (proj x P-active): ${mn(sB1)}   FRESH (perfect avail): ${mn(sFresh)}`);
console.log(`\n  info gap (FRESH-NAIVE): ${gapNaiveFresh.toFixed(2)} pts/wk`);
console.log(`  B1 gain (B1-NAIVE):    ${gapB1.toFixed(2)} pts/wk  => recovers ${(100 * gapB1 / gapNaiveFresh).toFixed(0)}% of the gap`);
console.log(`  per-season B1 gain/wk: ${[...perSeason].map(([s, v]) => `${s}:${v.b1.toFixed(2)}`).join("  ")}`);
