// OPPONENT-DENIAL HANDCUFF, measured. The full title-Δ needs the field (unavailable historically),
// but the core quantity does not: when a workhorse RB actually MISSED, how much did his handcuff
// outscore the best RB a rival could have STREAMED instead? That margin is what owning the handcuff
// DENIES -- because in a deep league the rival just streams a replacement. If it's ~0, denial is
// empty (they recover); if large, denial has teeth.
//   node --import tsx scripts/inseason-backtest-denial.mjs [--seasons 2018-2025]
import { openDb } from "../src/db/db.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const [lo, hi] = (arg("--seasons", "2018-2025")).split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const db = openDb(arg("--db", undefined));

// season-line per RB (point-in-time proj), by NFL team, to find lead + handcuff (highest two by line).
const perSeason = [];
const perWeek = new Map(); for (let w = 1; w <= 17; w++) perWeek.set(w, { n: 0, hc: 0, fa: 0, denial: 0 });
for (const season of seasons) {
  const rbs = db.prepare(
    `SELECT name, player_sk, team, MAX(season_line_pg) line FROM feat_player_week_model
      WHERE season=? AND pos='RB' AND team IS NOT NULL AND season_line_pg IS NOT NULL GROUP BY player_sk`,
  ).all(season);
  const byTeam = new Map();
  for (const r of rbs) { let l = byTeam.get(r.team); if (!l) { l = []; byTeam.set(r.team, l); } l.push(r); }
  // lead = highest line; handcuff = 2nd (matching handcuffBoard's project-to-rank).
  const leadHc = [];
  for (const [, l] of byTeam) { if (l.length < 2) continue; l.sort((a, b) => b.line - a.line); leadHc.push({ lead: l[0], hc: l[1] }); }

  // point-in-time weekly rows: pts + inj_out, by player_sk|week.
  const rowByKey = new Map();
  for (const r of db.prepare(`SELECT player_sk, week, pts, inj_out, is_bye FROM feat_player_week_model WHERE season=? AND pos='RB' AND player_sk IS NOT NULL`).all(season))
    rowByKey.set(`${r.player_sk}|${r.week}`, r);
  // What a rival STREAMS: he picks by projection ex ante and sometimes whiffs. Estimate the expected
  // stream yield as the mean REALIZED points of the top-3 projected available RBs that week (a manager
  // has a few options; a single top pick's realized is too noisy and null-heavy to be the estimator).
  // A null actual = didn't play = a genuine 0 for that pick, which is part of streaming risk.
  const faByWeek = new Map(); // week -> [{line, actual}] sorted desc by line
  for (const f of db.prepare(
    `SELECT f.week, f.player_sk, m.season_line_pg line, m.pts actual, m.inj_out, m.is_bye
       FROM fact_fa_pool_week f JOIN feat_player_week_model m ON m.season=f.season AND m.week=f.week AND m.player_sk=f.player_sk
      WHERE f.season=? AND f.pos='RB' AND m.season_line_pg IS NOT NULL`).all(season)) {
    if (f.inj_out || f.is_bye) continue;      // can't stream a man who's out/bye ex ante
    let l = faByWeek.get(f.week); if (!l) { l = []; faByWeek.set(f.week, l); } l.push({ line: f.line, actual: f.actual ?? 0 });
  }
  const faBest = new Map(); // week -> expected stream yield (mean realized of top-3 projected)
  for (const [w, l] of faByWeek) { l.sort((a, b) => b.line - a.line); const top = l.slice(0, 3); faBest.set(w, { actual: top.reduce((s, x) => s + x.actual, 0) / top.length }); }

  let n = 0, hcSum = 0, faSum = 0;
  for (const { lead, hc } of leadHc) {
    for (let w = 1; w <= 17; w++) {
      const lr = rowByKey.get(`${lead.player_sk}|${w}`);
      if (!lr || !lr.inj_out) continue;             // only weeks the LEAD actually missed
      const hr = rowByKey.get(`${hc.player_sk}|${w}`);
      const hcPts = (hr && !hr.is_bye && !hr.inj_out) ? (hr.pts ?? 0) : 0;  // handcuff's actual (0 if he too was out)
      const fa = faBest.get(w);
      const denial = hcPts - (fa ? fa.actual : 0);
      n++; hcSum += hcPts; faSum += fa ? fa.actual : 0;
      const b = perWeek.get(w); b.n++; b.hc += hcPts; b.fa += fa ? fa.actual : 0; b.denial += denial;  // per-week bucket across all seasons
    }
  }
  perSeason.push({ season, leadOutWeeks: n, handcuffPts: n ? hcSum / n : 0, streamPts: n ? faSum / n : 0, denial: n ? (hcSum - faSum) / n : 0 });
}
db.close();

console.log(`\nOPPONENT-DENIAL VALUE -- handcuff vs the RB a rival would STREAM, in weeks the lead missed, ${arg("--seasons", "2018-2025")}\n`);
console.log("  season  lead-out wks   handcuff pts   stream pts   DENIAL (hc-stream)");
for (const s of perSeason) console.log(`  ${s.season}     ${String(s.leadOutWeeks).padStart(6)}       ${s.handcuffPts.toFixed(2).padStart(6)}       ${s.streamPts.toFixed(2).padStart(6)}      ${s.denial.toFixed(2).padStart(6)}`);
const tot = perSeason.reduce((a, s) => ({ n: a.n + s.leadOutWeeks, hc: a.hc + s.handcuffPts * s.leadOutWeeks, fa: a.fa + s.streamPts * s.leadOutWeeks }), { n: 0, hc: 0, fa: 0 });
console.log(`\n  OVERALL: ${tot.n} lead-out weeks; handcuff ${(tot.hc / tot.n).toFixed(2)} vs stream ${(tot.fa / tot.n).toFixed(2)} => DENIAL ${((tot.hc - tot.fa) / tot.n).toFixed(2)} pts per lead-out week`);

// WINDOWED: does the per-event denial hold up in the fantasy-playoff weeks, and how bench-efficient is
// carrying the handcuff for that window only vs all season? Efficiency = denial captured per bench-WEEK
// paid = (avg denial/event) x (lead-out weeks in window) / (weeks in window x seasons). One team-slot
// held for `weeks x seasons` team-weeks yields `denial in window` total points denied.
const NSEASONS = perSeason.filter((s) => s.leadOutWeeks > 0).length || 1;
const windowStats = (lo2, hi2) => {
  let n = 0, denial = 0; for (let w = lo2; w <= hi2; w++) { const b = perWeek.get(w); if (!b) continue; n += b.n; denial += b.denial; }
  const weeks = hi2 - lo2 + 1;
  return { lo: lo2, hi: hi2, weeks, n, perEvent: n ? denial / n : 0, totalDenial: denial, benchWeeks: weeks * NSEASONS,
           perBenchWeek: denial / (weeks * NSEASONS) };  // pts denied per team-slot-week you tie up
};
console.log(`\n  WINDOW EFFICIENCY -- denial per BENCH-WEEK you tie up (the cost of "pending playoff qual" is fewer weeks held):`);
console.log(`  window        weeks   lead-out evts   denial/event   pts-denied/bench-week`);
for (const [lo2, hi2, label] of [[1, 17, "all season"], [1, 13, "regular (1-13)"], [14, 17, "playoffs 14-17"], [15, 17, "playoffs 15-17"]]) {
  const s = windowStats(lo2, hi2);
  console.log(`  ${label.padEnd(15)} ${String(s.weeks).padStart(3)}     ${String(s.n).padStart(6)}         ${s.perEvent.toFixed(2).padStart(6)}          ${s.perBenchWeek.toFixed(2).padStart(6)}`);
}
const reg = windowStats(1, 13), po = windowStats(14, 17);
console.log(`\n  READ THIS RIGHT: denial per bench-week is ~FLAT across windows (${reg.perBenchWeek.toFixed(1)} reg vs ${po.perBenchWeek.toFixed(1)} playoff) because injury`);
console.log(`  hazard is ~uniform. There is NO per-week efficiency edge to timing the claim -- that naive argument is wrong.`);
console.log(`  The case for "pending playoff qualification" is entirely LEVERAGE + OPTIONALITY, which this harness cannot score:`);
console.log(`   1. LEVERAGE: ${reg.n} of ${(reg.n + po.n)} denial events (${(100 * reg.n / (reg.n + po.n)).toFixed(0)}%) land in weeks 1-13, where denying a rival barely moves their`);
console.log(`      title odds. Waiting concentrates 100% of the denial on the ~${po.n} playoff-week events that actually decide it.`);
console.log(`   2. OPTIONALITY: you commit the slot only AFTER you qualify and know your real rival -- no wasted carry in the`);
console.log(`      seasons you don't contend, no guessing the target in week 3.`);
console.log(`  Same per-event magnitude (${po.perEvent.toFixed(1)} pts in the playoff window); the win is WHICH games it lands on and WHETHER you pay at all.`);
console.log(`\n  CAVEAT the harness cannot see: late-season acquirability cuts the OTHER way. In sharp leagues the obvious`);
console.log(`  handcuff is already rostered by week 15, so the conditional play trades bench cost for a smaller candidate set.`);
