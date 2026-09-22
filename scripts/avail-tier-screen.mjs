// WHICH AVAILABILITY TABLE ACTUALLY PREDICTS WHO PLAYS? -- leave-season-out, both arms.
//
// `fit-variance.mjs` assigns a player's tier by his REALISED season total and calls that "the same
// way a draft board ranks". It is not: a board ranks by preseason projection, and for availability
// the difference is circular -- missing fourteen weeks PRODUCES a low total, so the bottom tiers
// absorb the injuries and the top tiers look durable by selection. Meanwhile `leadMissProb` serves
// the lookup by PROJECTED pool rank. Train on hindsight, serve on foresight.
//
// The shipped table says an elite RB misses 7.4% of weeks; the hindsight-free one says 18.6%. This
// script decides which is closer to the truth, and it has to be careful about two traps:
//
//   1. IN-SAMPLE FAVOURS ARM B BY CONSTRUCTION. If tiers are assigned hindsight-free at evaluation
//      time, the arm fitted that way wins trivially. So each season is scored by tables fitted with
//      that season EXCLUDED (`FIT_EXCLUDE`, which the fit script already supports for exactly this).
//   2. THE ARMS MUST BE INDEXED THE WAY THEY ARE SERVED. At serve, nobody knows a realised total, so
//      BOTH tables are looked up by the hindsight-free tier. That is not a handicap on arm A -- it
//      is the only thing a September decision can actually do, and it is what the shipped code
//      already does.
//
// Usage: node --import tsx scripts/avail-tier-screen.mjs [--from 2005] [--to 2025]
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2005)), TO = Number(arg("--to", 2025));
const POS = ["QB", "RB", "WR", "TE"];
const REG = 16, TIERS = 4;

const rows = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1);
const bySeason = new Map();
for (const line of rows) {
  const f = line.split(",");
  const s = Number(f[0]), name = f[1], pos = (f[2] ?? "").toUpperCase(), pts = Number(f[4]);
  if (!POS.includes(pos) || !Number.isFinite(pts)) continue;
  if (!bySeason.has(s)) bySeason.set(s, new Map());
  const m = bySeason.get(s);
  if (!m.has(pos)) m.set(pos, new Map());
  const b = m.get(pos);
  if (!b.has(name)) b.set(name, { n: 0, tot: 0 });
  const r = b.get(name); r.n++; r.tot += pts;
}
const seasons = [...bySeason.keys()].sort((a, b) => a - b);

/** pos|name -> prior season total, as of the START of `season`. */
function priorTotalsAsOf(season) {
  const m = new Map();
  for (const s of seasons) {
    if (s >= season) break;
    for (const [pos, byName] of bySeason.get(s)) for (const [name, r] of byName) m.set(pos + "|" + name, r.tot);
  }
  return m;
}

const tmp = mkdtempSync(join(tmpdir(), "avail-screen-"));
const fitInto = (mode, exclude) => {
  const out = join(tmp, `v-${mode}-${exclude}.json`);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/fit-variance.mjs"], {
    env: { ...process.env, TIER_MODE: mode, FIT_OUT_OVERRIDE: out, FIT_EXCLUDE: String(exclude) },
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(out, "utf8"));
};

const err = { total: [], prior: [] };
const byTier = { total: {}, prior: {} };
for (const o of ["total", "prior"]) for (let t = 0; t < TIERS; t++) byTier[o][t] = [];

for (const season of seasons.filter((s) => s >= FROM && s <= TO)) {
  const prior = priorTotalsAsOf(season);
  const tables = { total: fitInto("total", season), prior: fitInto("prior", season) };
  for (const pos of POS) {
    const byName = bySeason.get(season)?.get(pos);
    if (!byName) continue;
    // HINDSIGHT-FREE RANK: the only ranking a September decision could hold. Players with no prior
    // season are dropped -- a rookie has no such rank, and inventing one would be the very hindsight
    // this screen exists to remove.
    const ranked = [...byName].map(([name, r]) => ({ name, ...r }))
      .filter((p) => prior.has(pos + "|" + p.name))
      .sort((a, b) => prior.get(pos + "|" + b.name) - prior.get(pos + "|" + a.name));
    ranked.forEach((p, i) => {
      const t = Math.min(TIERS - 1, Math.floor((i / ranked.length) * TIERS));
      const actual = Math.min(1, p.n / REG);
      for (const o of ["total", "prior"]) {
        const a = tables[o].pos[pos];
        if (!a) continue;
        const pred = a.avail[t] ?? 0.85;
        err[o].push(Math.abs(pred - actual));
        byTier[o][t].push(pred - actual);       // SIGNED, so bias is visible, not just magnitude
      }
    });
  }
  process.stderr.write(`  ${season} done\n`);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log(`\nLEAVE-SEASON-OUT availability screen, ${FROM}-${TO}, n=${err.total.length} player-seasons`);
console.log(`  both arms indexed by the HINDSIGHT-FREE tier -- the only one a September decision has\n`);
console.log(`  MAE  shipped (tier by realised total) : ${mean(err.total).toFixed(4)}`);
console.log(`  MAE  fixed   (tier by prior season)   : ${mean(err.prior).toFixed(4)}`);
const lift = mean(err.total) - mean(err.prior);
console.log(`  improvement: ${lift >= 0 ? "+" : ""}${lift.toFixed(4)} (positive = the fix predicts better)\n`);
console.log("  SIGNED bias by tier (predicted minus actual; + = the table claims more availability than happened)");
console.log("  tier    shipped    fixed");
for (let t = 0; t < TIERS; t++) {
  console.log(`   ${t}    ${mean(byTier.total[t]).toFixed(4).padStart(9)} ${mean(byTier.prior[t]).toFixed(4).padStart(9)}   (n=${byTier.total[t].length})`);
}
