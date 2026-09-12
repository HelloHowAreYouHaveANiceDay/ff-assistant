// SURROGATE-POWERED LEVER RE-OPTIMISATION. Generates one backtest trial-dump per candidate lever value
// (resumable -- skips a dump that already exists), against the shipped baseline. Analysis is done by
// scripts/surrogate-validate.mjs, which measures each contrast's lift on the fitted SURROGATE INDEX
// (~2x the power of the binary title; docs/redesign/power-and-surrogate.md) plus champ/playoffs.
//
//   node scripts/lever-sweep.mjs            # run all candidate dumps (serial; hours)
//   node scripts/lever-sweep.mjs --print    # just print the analysis command over existing dumps
//
// Neighborhood sweep, NOT a blind grid: the shipped value is already the old optimum, so we test its
// OFF value and nearest neighbours and ask whether the OPTIMUM MOVED under the consensus-on baseline.
// Keeping the candidate count small is the deflated-Sharpe / minimum-backtest-length discipline (few
// observations -> cap the strategies tried); surrogate-validate applies the family view.
import fs from "node:fs";
import { execSync } from "node:child_process";

const BASE_FLAGS = "--full --no-lookahead --inflation";   // shipped, consensus-on by default
const SEASONS = "1999-2024", N = "150";
const DIR = "data/trials";
const BASE = `${DIR}/surrog-base.tsv`;

// candidate values per lever (shipped value omitted -- that IS the baseline). flag = LEVER_SPECS flag.
const CANDIDATES = [
  { flag: "mult-qb", vals: [0.85, 1.15] },
  { flag: "mult-rb", vals: [0.85, 1.15] },
  { flag: "mult-wr", vals: [0.85, 1.15] },
  { flag: "mult-te", vals: [0.85, 1.15] },
  { flag: "tier-break", vals: [0.65, 0.85] },
  { flag: "bench-discount", vals: [0.5] },       // 1.0 already dumped (surrog-benchdisc)
  { flag: "max-share", vals: [0.35] },           // 0.5 already dumped (surrog-maxshare)
  { flag: "aggr", vals: [0.6, 0.85] },           // 1.0 already dumped (surrog-aggr)
  { flag: "max-kdst", vals: [1, 5] },
  { flag: "starter-reserve", vals: [0, 10] },
  { flag: "bench-reserve", vals: [0, 3] },
  { flag: "premium", vals: [0, 5] },
  { flag: "sleeper-threshold", vals: [3, 10] },
];

// existing validation dumps that double as sweep points (label -> path)
const PREBUILT = {
  "bench-discount=1": `${DIR}/surrog-benchdisc.tsv`,
  "max-share=0.5": `${DIR}/surrog-maxshare.tsv`,
  "aggr=1": `${DIR}/surrog-aggr.tsv`,
};

const dumpPath = (flag, v) => `${DIR}/sweep-${flag}-${v}.tsv`;
const label = (flag, v) => `${flag}=${v}`;

if (!fs.existsSync(BASE)) { console.error(`missing baseline ${BASE} -- generate it first (shipped flagless dump).`); process.exit(1); }

// assemble the full contrast list (prebuilt + candidates)
const contrasts = Object.entries(PREBUILT).map(([lab, path]) => ({ lab, path }));
for (const { flag, vals } of CANDIDATES) for (const v of vals) contrasts.push({ lab: label(flag, v), path: dumpPath(flag, v), flag, v });

if (process.argv.includes("--print")) {
  const args = contrasts.filter((c) => fs.existsSync(c.path)).map((c) => `"${c.lab}=${c.path}"`).join(" \\\n  ");
  console.log(`node scripts/surrogate-validate.mjs ${BASE} \\\n  ${args}`);
  process.exit(0);
}

let ran = 0, skipped = 0;
for (const c of contrasts) {
  if (!c.flag) continue;                         // prebuilt -- nothing to run
  if (fs.existsSync(c.path)) { skipped++; continue; }
  const cmd = `npm run -s ff -- backtest ${BASE_FLAGS} --${c.flag} ${c.v} --seasons ${SEASONS} --n ${N} --dump-trials ${c.path}`;
  console.log(`\n[${ran + skipped + 1}/${contrasts.length}] ${c.lab}\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
  if (!fs.existsSync(c.path)) throw new Error(`backtest did not write ${c.path}`);
  ran++;
}
console.log(`\ndone: ${ran} dumps generated, ${skipped} already present. Analyse with:\n  node scripts/lever-sweep.mjs --print   # then run the printed command`);
