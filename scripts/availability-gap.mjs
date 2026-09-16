// THE AVAILABILITY INFORMATION GAP, MEASURED (M2c, 2026-09-16).
//
//   node --import tsx scripts/availability-gap.mjs [--seasons 2018-2025] [--league 462233]
//                                                  [--model served|floor|challenger] [--json <path>]
//
// docs/in-season-backtest.md records the mechanism behind P37's failure in one line: our recommended
// lineup starts a man who scores EXACTLY ZERO 4-6% of the time against the managers' 3.5%, and calls
// it "an information gap, not an optimisation gap". That sentence is a hypothesis. This script is the
// measurement, and it exists to answer one question with a number rather than a story:
//
//   OF THE ZEROS WE START, HOW MANY COULD A SUNDAY-MORNING RE-READ HAVE CAUGHT?
//
// THREE CLASSES, and the whole point is that they have different remedies:
//
//   (a) FRIDAY-KNOWABLE   the injury report already said Out/Doubtful before the week's first
//                         kickoff. Our lineup rule reads `feat_player_week_model.inj_out` /
//                         `inj_doubtful` and refuses to start such a man, so class (a) in OUR started
//                         set MUST be ~zero. Any residue is an availability-PLUMBING defect -- a
//                         designation that reached `feat_player_week_context.report_status_fri` and
//                         never reached the model column the optimiser reads -- and is reported by
//                         name, per season, rather than folded into a total.
//   (b) GAME-DAY INACTIVE he carried no Friday designation and took ZERO snaps. This is the class a
//                         Sunday 11:30 re-read can recover, and it is the only class that bounds the
//                         `weekly_sunday` workflow's value.
//   (c) PLAYED, SCORED 0  he was active, took snaps, and did nothing. No feed recovers this; it is
//                         the irreducible floor and it belongs in the denominator so the bound is
//                         not flattered.
//   (d) NO SNAP COVERAGE  team defences, which are synthetic keys with no PFR snap row at all. Kept
//                         as its own class rather than silently counted as (b) -- a DST that scores
//                         zero has played, and calling it a game-day inactive would inflate exactly
//                         the number this script exists to bound.
//
// THE POSITIVE CONTROL ON THE SNAP JOIN, run first and printed, because class (b) is defined by an
// ABSENCE and an absence is what a broken join looks like. Every player who SCORED POINTS must have
// a snap row; if he does not, "took zero snaps" is measuring the crosswalk rather than the NFL. The
// control is reported as a rate, per season, and the run refuses below 95%.
//
// THE RECOVERABLE-POINTS BOUND is not derived from the class counts. It is a paired re-run: the same
// team-week, the same projections, the same template, with every class-(b) man marked UNAVAILABLE --
// i.e. a PERFECT game-day read -- and the resulting lineup scored on the same real results. The delta
// is per team-week, paired (common rosters), and bootstrapped at the SEASON level, because 1,896
// team-weeks are eight correlated seasons and CLAUDE.md says so. It is an ORACLE and therefore an
// UPPER BOUND: a real 11:30 ET feed catches the inactives that are published by 11:30, not all of
// them, and it never catches the mid-game injury.
//
// THE MANAGERS ARE CLASSIFIED THE SAME WAY, on the same rosters, in the same loop. If the "they read
// Sunday news and we do not" story is true, their class-(b) SHARE of starts must be lower than ours.
// If it is not lower, the story is wrong and this whole workflow is aimed at the wrong thing.
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { loadWeekContext, loadModel } from "../src/inseason/backtest/context.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";
import { seasonBootstrap } from "../src/inseason/backtest/lineup.ts";
import { classifyZero, snapPlayedIndex, snapControlRate, fridayIndex, ZERO_CLASSES } from "../src/inseason/availabilityGap.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const SEASONS = []; for (let y = lo; y <= hi; y++) SEASONS.push(y);
const MODEL = arg("--model", "served");

const db = new Database("data/ff.db", { readonly: true });
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "availability-gap");
console.log(`league ${leagueId}   seasons ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}   model ${MODEL}`);

const artifact = loadModel(MODEL);
const empty = () => Object.fromEntries(ZERO_CLASSES.map((c) => [c, 0]));

const tally = { tool: { starts: 0, zeros: 0, cls: empty() }, mgr: { starts: 0, zeros: 0, cls: empty() } };
const perSeason = [];
const plumbing = [];                 // class (a) residue in OUR started set -- named, never totalled away
const pairedRows = [];               // { season, week, teamId, toolGain } for the oracle arm
let control = { withPts: 0, withSnap: 0 };
let teamWeeks = 0;

for (const season of SEASONS) {
  const played = snapPlayedIndex(db, season);
  const friday = fridayIndex(db, season);
  const ctl = snapControlRate(db, season, played);
  control.withPts += ctl.withPts; control.withSnap += ctl.withSnap;
  const sTally = { tool: { starts: 0, zeros: 0, cls: empty() }, mgr: { starts: 0, zeros: 0, cls: empty() } };
  let sGain = 0, sN = 0;

  const weeks = db.prepare(
    "SELECT DISTINCT week FROM fact_lineup_week WHERE league_id=? AND season=? ORDER BY week",
  ).all(leagueId, season).map((r) => r.week);

  for (const week of weeks) {
    const ctx = loadWeekContext(db, leagueId, season, week, artifact);
    if (!ctx.rosters.size || !ctx.template.length) continue;

    for (const [teamId, entries] of ctx.rosters) {
      const players = [];
      for (const e of entries) {
        if (e.lineupSlotId === 21) continue;              // IR is not startable under league rules
        const p = ctx.players.get(e.playerSk);
        players.push({
          name: `${e.name}#${e.playerSk}`, pos: e.pos,
          proj: p?.proj ?? p?.fallback ?? 0,
          available: p ? p.available : true,
          sk: e.playerSk,
        });
      }
      if (!players.length) continue;
      teamWeeks++; sN++;

      const base = optimalLineup(players, ctx.template, ["RB", "WR", "TE"]);
      let baseScored = 0;
      for (const s of base.starters) {
        if (s.name === "(empty)") continue;
        const sk = s.name.split("#")[1];
        const p = ctx.players.get(sk);
        const act = p?.actual ?? 0;
        baseScored += act;
        tally.tool.starts++; sTally.tool.starts++;
        if (act !== 0) continue;
        const c = classifyZero({ week, sk, pos: p?.pos ?? "", played, friday, blockSaysOut: p ? !p.available : false });
        tally.tool.zeros++; sTally.tool.zeros++;
        tally.tool.cls[c.cls]++; sTally.tool.cls[c.cls]++;
        if (c.cls === "friday") plumbing.push({ season, week, teamId, name: p?.name ?? sk, pos: p?.pos ?? "", why: c.why });
      }

      // THE MANAGER, same week, same roster, same classifier.
      for (const e of entries) {
        if (!e.isStarter) continue;
        const p = ctx.players.get(e.playerSk);
        const act = p?.actual ?? 0;
        tally.mgr.starts++; sTally.mgr.starts++;
        if (act !== 0) continue;
        const c = classifyZero({ week, sk: e.playerSk, pos: p?.pos ?? e.pos, played, friday, blockSaysOut: p ? !p.available : false });
        tally.mgr.zeros++; sTally.mgr.zeros++;
        tally.mgr.cls[c.cls]++; sTally.mgr.cls[c.cls]++;
      }

      // THE ORACLE ARM: a perfect game-day read. Only class-(b) men are flipped -- a man already
      // unavailable is left alone (he was never a candidate) and a class-(c) man is NOT flipped,
      // because no feed could have told anyone he would score zero while playing.
      const oracle = players.map((pl) => {
        if (!pl.available) return pl;
        const p = ctx.players.get(pl.sk);
        if (!p || p.actual !== 0) return pl;
        const c = classifyZero({ week, sk: pl.sk, pos: p.pos, played, friday, blockSaysOut: false });
        return c.cls === "inactive" ? { ...pl, available: false } : pl;
      });
      const orc = optimalLineup(oracle, ctx.template, ["RB", "WR", "TE"]);
      let orcScored = 0;
      for (const s of orc.starters) {
        if (s.name === "(empty)") continue;
        orcScored += ctx.players.get(s.name.split("#")[1])?.actual ?? 0;
      }
      const gain = orcScored - baseScored;
      sGain += gain;
      pairedRows.push({ season, week, teamId, toolGain: gain });
    }
  }
  perSeason.push({ season, teamWeeks: sN, gain: sN ? sGain / sN : 0, ...sTally });
}

const ctlRate = control.withPts ? control.withSnap / control.withPts : 0;
console.log(`\nCONTROL -- players who SCORED and carry a PFR snap row: ${(ctlRate * 100).toFixed(1)}% ` +
  `(${control.withSnap}/${control.withPts}, DST excluded). Class (b) is defined by the ABSENCE of a snap row, so`);
console.log(`          a broken crosswalk would manufacture inactives. Refusing below 95%.`);
if (ctlRate < 0.95) {
  console.error(`\nREFUSED: the snap crosswalk resolves only ${(ctlRate * 100).toFixed(1)}% of scoring players. ` +
    "Every class-(b) count below would be a measurement of player_xref('pfr'), not of the NFL.");
  process.exit(3);
}
if (!teamWeeks) {
  console.error(`\nREFUSED: league ${leagueId} has ZERO team-weeks over these seasons -- nothing was measured.`);
  process.exit(3);
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : "0.00");
const line = (label, t) =>
  `  ${label.padEnd(10)} starts ${String(t.starts).padStart(6)}   zeros ${String(t.zeros).padStart(5)} (${pct(t.zeros, t.starts)}%)` +
  `   a/friday ${String(t.cls.friday).padStart(4)} (${pct(t.cls.friday, t.starts)}%)` +
  `   b/inactive ${String(t.cls.inactive).padStart(4)} (${pct(t.cls.inactive, t.starts)}%)` +
  `   c/played ${String(t.cls.played).padStart(4)} (${pct(t.cls.played, t.starts)}%)` +
  `   d/dst ${String(t.cls.dst).padStart(4)}`;

console.log(`\n=== ZERO-SCORING STARTS, CLASSIFIED (${teamWeeks} team-weeks)`);
console.log(line("OURS", tally.tool));
console.log(line("MANAGERS", tally.mgr));
console.log(`\n  The story in docs/in-season-backtest.md is that the managers read Sunday news and we do not.`);
console.log(`  THE TEST OF IT: the class-(b) SHARE of starts. ours ${pct(tally.tool.cls.inactive, tally.tool.starts)}% vs ` +
  `theirs ${pct(tally.mgr.cls.inactive, tally.mgr.starts)}% -- ` +
  `${tally.tool.cls.inactive / Math.max(1, tally.tool.starts) > tally.mgr.cls.inactive / Math.max(1, tally.mgr.starts) ? "HELD" : "FAILED"}`);

console.log(`\n=== CLASS (a): FRIDAY-KNOWABLE ZEROS IN OUR OWN STARTED SET -- must be ~0`);
if (!plumbing.length) {
  console.log(`  none. Every man our lineup started was startable under the point-in-time block, so the`);
  console.log(`  availability path reached the optimiser in every one of ${teamWeeks} team-weeks.`);
} else {
  console.log(`  ${plumbing.length} start(s). This is a PLUMBING defect, not a lineup choice: the designation`);
  console.log(`  reached feat_player_week_context and never reached the column the optimiser reads.`);
  const bySeason = {};
  for (const p of plumbing) bySeason[p.season] = (bySeason[p.season] ?? 0) + 1;
  console.log(`  by season: ${Object.entries(bySeason).map(([s, n]) => `${s}:${n}`).join(" ")}`);
  for (const p of plumbing.slice(0, 20)) console.log(`    ${p.season} w${String(p.week).padStart(2)} ${p.pos.padEnd(3)} ${p.name} -- ${p.why}`);
  if (plumbing.length > 20) console.log(`    ... and ${plumbing.length - 20} more`);
}

const boot = seasonBootstrap(pairedRows);
console.log(`\n=== THE RECOVERABLE-POINTS BOUND (ORACLE game-day read, paired on the same rosters)`);
console.log(`  per team-week ${boot.mean.toFixed(3)} pts   season bootstrap [${boot.lo.toFixed(3)}, ${boot.hi.toFixed(3)}] over ${boot.seasons} seasons`);
console.log(`  This is an UPPER bound: the oracle knows every inactive perfectly, a live 11:30 ET feed`);
console.log(`  knows only what is published by 11:30, and neither catches a man hurt in the first quarter.`);
console.log(`  Compare edges.md #11's ~1.8 pts/week claim against THIS number, not against the class counts.`);

console.log(`\n  season   n   a/friday  b/inactive  c/played  ours-zero%  mgr-zero%  oracle gain`);
for (const s of perSeason) {
  console.log(`   ${s.season}  ${String(s.teamWeeks).padStart(3)}   ${String(s.tool.cls.friday).padStart(7)}  ` +
    `${String(s.tool.cls.inactive).padStart(9)}  ${String(s.tool.cls.played).padStart(8)}  ` +
    `${pct(s.tool.zeros, s.tool.starts).padStart(9)}%  ${pct(s.mgr.zeros, s.mgr.starts).padStart(8)}%  ${s.gain.toFixed(3).padStart(10)}`);
}

const jsonPath = arg("--json", null);
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({
    leagueId, seasons: SEASONS, model: MODEL, teamWeeks, control: { ...control, rate: ctlRate },
    tally, perSeason, plumbing, bound: boot,
  }, null, 2));
  console.log(`\nwrote ${jsonPath}`);
}
db.close();
