// Paired analysis of two configs from --dump-trials output. This is the test the trial dump exists
// for, and it is the one the aggregate percentages cannot support.
//
// Seeds are COMMON RANDOM NUMBERS (seed = s+1+yr*1000, a function of season and index only), so a
// given seed means the SAME market noise and the SAME bot seats in both arms. Every trial is
// therefore a matched pair, and the right tests are paired ones:
//   - McNemar on discordant trial pairs (did A win where B lost, and vice versa)
//   - a season-level bootstrap CI, because the unit of GENERALISATION is the season, not the trial
//
//   node scripts/paired-analysis.mjs data/trials/shipped.tsv data/trials/olddef.tsv
//
// BOTH OUTCOMES ARE REPORTED, championship AND playoffs, and that is a Phase 3 change rather than a
// cosmetic one. The season simulator was scored against 114 real team-seasons and has measurable
// skill on the playoff berth and NONE on the champion (docs/validation.md, Phase 2c), so a harness
// that could only report the title was reporting the half of the objective the model cannot see.
// Reading only the title column is how a change that genuinely improves the roster gets rejected for
// losing a coin flip.
import fs from "node:fs";

const load = (p) => {
  const rows = fs.readFileSync(p, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
  const m = new Map();
  for (const r of rows) m.set(r[1], { season: Number(r[0]), champ: Number(r[2]), playoffs: Number(r[3]) });
  return m;
};

const [, , pathA, pathB] = process.argv;
const A = load(pathA), B = load(pathB);
const seeds = [...A.keys()].filter((k) => B.has(k));
if (seeds.length !== A.size || seeds.length !== B.size) {
  console.log(`WARNING: seed sets differ (A ${A.size}, B ${B.size}, shared ${seeds.length}) -- the`);
  console.log(`arms are then NOT paired and every number below is invalid. Re-run both with the same`);
  console.log(`--seasons and --n.`);
}
console.log(`paired on ${seeds.length} common seeds`);
console.log(`  A = ${pathA}`);
console.log(`  B = ${pathB}\n`);

const erfc = (x) => {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
};

function analyse(metric, label) {
  console.log(`================ ${label.toUpperCase()} ================`);

  // --- McNemar on discordant pairs -----------------------------------------------------------
  let bothWin = 0, aOnly = 0, bOnly = 0, neither = 0;
  for (const s of seeds) {
    const a = A.get(s)[metric], b = B.get(s)[metric];
    if (a && b) bothWin++; else if (a) aOnly++; else if (b) bOnly++; else neither++;
  }
  const n01 = aOnly, n10 = bOnly, disc = n01 + n10;
  // Continuity-corrected McNemar chi-square, 1 df.
  const chi2 = disc ? Math.pow(Math.abs(n01 - n10) - 1, 2) / disc : 0;
  // Normal approximation to the two-sided p-value (chi2 with 1df -> |z| = sqrt(chi2)).
  const p = erfc(Math.sqrt(chi2) / Math.SQRT2);
  console.log(`McNemar (${label}, trial-level pairs)`);
  console.log(`  A yes & B yes     ${bothWin}`);
  console.log(`  A only            ${n01}`);
  console.log(`  B only            ${n10}`);
  console.log(`  neither           ${neither}`);
  console.log(`  discordant ${disc}  chi2(1) ${chi2.toFixed(2)}  p ~ ${p < 1e-6 ? "<1e-6" : p.toExponential(2)}`);
  console.log(`  A rate ${((bothWin + n01) / seeds.length * 100).toFixed(1)}%  B rate ${((bothWin + n10) / seeds.length * 100).toFixed(1)}%\n`);

  // --- season-level paired bootstrap ----------------------------------------------------------
  // Resample SEASONS (not trials): that is the level at which a new year is a new draw from the world.
  const bySeason = new Map();
  for (const s of seeds) {
    const yr = A.get(s).season;
    if (!bySeason.has(yr)) bySeason.set(yr, { a: 0, b: 0, n: 0 });
    const e = bySeason.get(yr);
    e.a += A.get(s)[metric]; e.b += B.get(s)[metric]; e.n++;
  }
  const seasons = [...bySeason.keys()].sort();
  const diffs = seasons.map((y) => { const e = bySeason.get(y); return (e.a - e.b) / e.n * 100; });
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const md = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - md) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);

  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let i = 0; i < 20000; i++) {
    let acc = 0;
    for (let k = 0; k < diffs.length; k++) acc += diffs[Math.floor(rand() * diffs.length)];
    boot.push(acc / diffs.length);
  }
  boot.sort((x, y) => x - y);
  const lo = boot[Math.floor(0.025 * boot.length)], hi = boot[Math.floor(0.975 * boot.length)];
  const wins = diffs.filter((d) => d > 0).length, losses = diffs.filter((d) => d < 0).length;

  console.log(`Season-level paired difference (A - B), ${seasons.length} seasons`);
  console.log(`  per season: ${seasons.map((y, i) => `${y}:${diffs[i] > 0 ? "+" : ""}${diffs[i].toFixed(0)}`).join("  ")}`);
  console.log(`  mean ${md.toFixed(2)}pp   SD ${sd.toFixed(2)}   SE ${se.toFixed(2)}   t ${(md / se).toFixed(2)} on ${diffs.length - 1} df`);
  console.log(`  bootstrap 95% CI over seasons: [${lo.toFixed(2)}, ${hi.toFixed(2)}]pp`);
  console.log(`  A better in ${wins}/${seasons.length} seasons (worse in ${losses})`);
  console.log(`\n  Detectable effect at 80% power with ${seasons.length} seasons: ~${(2.9 * se).toFixed(2)}pp\n`);
}

// PLAYOFFS FIRST, deliberately. It is the factor the simulator can actually predict, so it is the
// primary objective; the title is printed beneath it and is never the number that decides alone.
analyse("playoffs", "playoffs (PRIMARY -- the factor the model has skill on)");
analyse("champ", "championship (reported alongside -- the model has no measured skill here)");
