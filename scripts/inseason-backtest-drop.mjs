// Value-min vs depth-aware DROP selection, with the depth-aware policy TUNED per position: a bench
// slot is itself scarce, so a backup only earns it where its realized insurance value is positive.
// See src/inseason/backtest/dropPolicy.ts. Usage:
//   node --import tsx scripts/inseason-backtest-drop.mjs [--seasons 2018-2025] [--model served|floor]
//     [--protect QB,TE,K,DST]   (skip to run the per-position diagnostic + auto-tuned policy)
import { openDb } from "../src/db/db.ts";
import { backtestDropPolicy } from "../src/inseason/backtest/dropPolicy.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const run = (protect) => backtestDropPolicy(db, { leagueId: lg.league_id, seasons, model, protectedPositions: protect });
const line = (r, label) =>
  `  ${label.padEnd(22)} diff/decision ${r.meanDiffAll.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pDepthBetter).toFixed(0)}%  (differed ${r.differing})`;

const t0 = Date.now();
const ALL = ["QB", "RB", "WR", "TE", "K", "DST"];
console.log(`\nDEPTH-AWARE DROP TUNING -- ${model} model, seasons ${seasonsArg}\n`);

const explicit = arg("--protect", null);
if (explicit) {
  const set = new Set(explicit.split(",").map((s) => s.trim().toUpperCase()));
  console.log(line(run(set), `protect {${[...set].join(",")}}`));
} else {
  // 1) DIAGNOSTIC: protect a backup at EVERY position, and read off the per-position value of that
  //    backup. A position with mean <= 0 does not earn its bench slot.
  const diag = run(new Set(ALL));
  console.log("THE VALUE OF A BENCH BACKUP, PER POSITION (realized pts saved when depth-aware kept it):");
  console.log("  pos    times kept   mean diff (pts)");
  for (const p of diag.byPosition) console.log(`  ${p.pos.padEnd(5)}  ${String(p.n).padStart(6)}      ${p.meanDiff.toFixed(2).padStart(7)}`);
  console.log(`\n  positive control (drop-your-best): ${diag.controlDropStarterMeanDiff.toFixed(1)} pts  (must be strongly negative)\n`);

  // 2) TUNED policy: protect exactly the positions whose backup earned its slot (mean diff > 0).
  const tuned = new Set(diag.byPosition.filter((p) => p.meanDiff > 0).map((p) => p.pos));
  console.log("POLICY COMPARISON (diff/decision = realized pts saved vs value-min; season-level CI):");
  console.log(line(run(new Set()),               "protect {} (=value-min)"));
  console.log(line(run(new Set(["TE"])),         "protect {TE}"));
  console.log(line(run(new Set(["QB", "TE"])),   "protect {QB,TE}"));
  console.log(line(run(new Set(["QB", "TE", "K", "DST"])), "protect {QB,TE,K,DST}"));
  console.log(line(diag,                          "protect {all 6}"));
  console.log(line(run(tuned),                    `TUNED {${[...tuned].join(",")}}`));
}
db.close();
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
