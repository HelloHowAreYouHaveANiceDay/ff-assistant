// WHY DOES OUR LINEUP LOSE TO REAL MANAGERS? -- the connectedness checks, before the result is
// written down as a finding.
//
//   node --import tsx scripts/inseason-lineup-diagnose.mjs
//
// A backtest saying "the tool is worse than the room" is exactly the shape of result that is
// usually a measurement defect, so three things are checked in the same invocation:
//
//   1. POSITIVE CONTROL ON THE OPTIMISER. Our lineup MUST have a higher PROJECTED total than the
//      manager's under the same projections -- it is the argmax of exactly that quantity. If it
//      does not, the lineup rule is not connected to the projections and the outcome comparison
//      measures nothing.
//   2. HOW OFTEN EACH SIDE STARTS A ZERO. A manager who benches a man ruled out on Sunday morning
//      has information the store's Wednesday injury block does not, and that shows up here.
//   3. WHAT THE MANAGERS' OWN CHOICE IMPLIES. Scoring the manager's started eight under OUR
//      projection says whether they were picking a lineup our model would also have liked, i.e.
//      whether the gap is the projection or the rule.
import Database from "better-sqlite3";
import { loadWeekContext, loadModel } from "../src/inseason/backtest/context.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";

const db = new Database("data/ff.db");
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;
const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

for (const model of ["floor", "challenger"]) {
  const artifact = loadModel(model);
  let n = 0, projWin = 0, projTie = 0;
  let toolZero = 0, mgrZero = 0, toolStarts = 0, mgrStarts = 0;
  let toolProj = 0, mgrProj = 0;
  let mgrStartedUnavailable = 0, toolStartedScoredZero = 0;
  for (const season of SEASONS) {
    const weeks = db.prepare("SELECT DISTINCT week FROM fact_roster_week WHERE season=? ORDER BY week").all(season).map((r) => r.week);
    for (const week of weeks) {
      const ctx = loadWeekContext(db, leagueId, season, week, artifact);
      if (!ctx.rosters.size || !ctx.template.length) continue;
      for (const [, entries] of ctx.rosters) {
        const players = [];
        for (const e of entries) {
          if (e.lineupSlotId === 21) continue;
          const p = ctx.players.get(e.playerSk);
          players.push({ name: `${e.name}#${e.playerSk}`, pos: e.pos, proj: p?.proj ?? p?.fallback ?? 0, available: p ? p.available : true, sk: e.playerSk });
        }
        const chosen = optimalLineup(players, ctx.template, ["RB", "WR", "TE"]);
        const projOf = new Map(players.map((p) => [p.name, p.proj]));
        let tProj = 0;
        for (const s of chosen.starters) {
          if (s.name === "(empty)") continue;
          tProj += projOf.get(s.name) ?? 0;
          const sk = s.name.split("#")[1];
          const a = ctx.players.get(sk);
          toolStarts++;
          if ((a?.actual ?? 0) === 0) { toolZero++; toolStartedScoredZero++; }
        }
        let mProj = 0;
        for (const e of entries) {
          if (!e.isStarter) continue;
          const p = ctx.players.get(e.playerSk);
          mProj += p?.proj ?? p?.fallback ?? 0;
          mgrStarts++;
          if ((p?.actual ?? 0) === 0) mgrZero++;
          if (p && !p.available) mgrStartedUnavailable++;
        }
        n++; toolProj += tProj; mgrProj += mProj;
        if (tProj > mProj + 1e-9) projWin++; else if (Math.abs(tProj - mProj) <= 1e-9) projTie++;
      }
    }
  }
  console.log(`\n=== ${model}`);
  console.log(`  team-weeks ${n}`);
  console.log(`  CONTROL: our lineup has the higher PROJECTED total in ${((projWin / n) * 100).toFixed(1)}% (+${((projTie / n) * 100).toFixed(1)}% exact ties) -- must be ~100%`);
  console.log(`  mean projected total: ours ${(toolProj / n).toFixed(2)} vs the manager's choice ${(mgrProj / n).toFixed(2)}`);
  console.log(`  starts that scored EXACTLY ZERO: ours ${((toolZero / toolStarts) * 100).toFixed(1)}%, the managers' ${((mgrZero / mgrStarts) * 100).toFixed(1)}%`);
  console.log(`  managers started a man our point-in-time block calls unavailable ${mgrStartedUnavailable} times (${((mgrStartedUnavailable / mgrStarts) * 100).toFixed(1)}%)`);
  void toolStartedScoredZero;
}
db.close();
