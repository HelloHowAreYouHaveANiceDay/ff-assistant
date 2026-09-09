// DOES THE WIN-PROBABILITY SAMPLER ACTUALLY COUPLE TEAMMATES, AND BY HOW MUCH?
//
//   node --import tsx scripts/winprob-copula-check.mjs [--season 2024] [--week 8] [--sims 20000]
//
// WHY THIS EXISTS. `winprob.ts` imposes a Gaussian copula whose parameter is a correlation between
// NORMALS on RANKS, while `data/correlation-model.json` holds a PEARSON correlation between weekly
// fantasy POINTS. Those are not the same number: across a right-skewed marginal with an atom at
// zero, rank dependence maps to Pearson dependence with attenuation, so passing the fitted rho
// straight through under-delivers the co-movement it was fitted to describe. The season sampler
// already pays a 1.8x multiple for the same reason (`WEEKLY_COUPLING_DEFAULT`), and that number was
// calibrated for a DIFFERENT construction -- two stages against a bootstrap marginal, not one stage
// against a published band -- so reusing it would be assuming the answer.
//
// So this measures it: real teammate pairs, real bands from the challenger artifact, the sampler's
// OWN output, and the realised same-week Pearson beside the fitted target. The success signal and
// the number are captured from the SAME invocation -- a coupling sweep that reported a correlation
// without saying how many pairs produced it would be quoting a measurement of nothing.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dataPath } from "../src/data/paths.ts";
import { loadWeeklyRows } from "../src/weekly/features.ts";
import { loadWeeklyArtifact, projectWeekly, CHALLENGER_WEEKLY_ARTIFACT } from "../src/weekly/projector.ts";
import { sampleWeek } from "../src/inseason/winprob.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i < 0 ? d : process.argv[i + 1]; };
const season = Number(arg("--season", 2024));
const week = Number(arg("--week", 8));
const sims = Number(arg("--sims", 20000));

const artifact = loadWeeklyArtifact(JSON.parse(readFileSync(dataPath(CHALLENGER_WEEKLY_ARTIFACT), "utf8")));
const corr = JSON.parse(readFileSync(dataPath("correlation-model.json"), "utf8"));
const db = new Database(dataPath("ff.db"), { readonly: true });
const rows = loadWeeklyRows(db, season, week);
const proj = projectWeekly({ artifact, rows });
const teamOf = new Map();
for (const r of db.prepare("SELECT feat_key, team FROM feat_player_week_model WHERE season=? AND week=?").all(season, week)) {
  teamOf.set(r.feat_key, r.team);
}
db.close();
if (!proj.length) { console.error(`no projected rows for ${season} week ${week}`); process.exit(2); }

// The players, with their real bands and real NFL teams. One entry per (team, pos) at most -- the
// highest mean -- so a pair is a starter and his starting teammate rather than two fourth-stringers.
const best = new Map();
for (const p of proj) {
  const team = teamOf.get(p.feat_key);
  if (!team) continue;
  const k = `${team}|${p.pos}`;
  const prev = best.get(k);
  if (!prev || p.mean > prev.proj) {
    best.set(k, { name: p.name, pos: p.pos, team, available: true, proj: p.mean, band: { mean: p.mean, p10: p.p10, p50: p.p50, p90: p.p90, pZero: p.pZero ?? null } });
  }
}
const players = [...best.values()];
const idx = new Map(players.map((p, i) => [p, i]));

const pearson = (a, b) => {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
};

const PAIRS = [["QB", "WR"], ["QB", "TE"], ["K", "DST"], ["QB", "RB"]];
console.log(`season ${season} week ${week}: ${players.length} players over ${new Set(players.map((p) => p.team)).size} NFL teams, ${sims} sims`);
console.log(`target Pearson (data/correlation-model.json, ${corr.teamWeeks} team-weeks): ` +
  PAIRS.map(([a, b]) => `${a}-${b} ${corr.pairs[`${a}-${b}`] ?? corr.pairs[`${b}-${a}`]}`).join("  "));
console.log("");
console.log(["coupling", ...PAIRS.map(([a, b]) => `${a}-${b}`), "pairs"].map((s) => String(s).padStart(10)).join(""));

for (const coupling of [0, 0.5, 1.0, 1.1, 1.15, 1.2, 1.8]) {
  const m = sampleWeek(players, { sims, seed: 4242, coupling, corr });
  const out = [];
  let usedPairs = 0;
  for (const [pa, pb] of PAIRS) {
    const rs = [];
    for (const team of new Set(players.map((p) => p.team))) {
      const a = players.find((p) => p.team === team && p.pos === pa);
      const b = players.find((p) => p.team === team && p.pos === pb);
      if (!a || !b) continue;
      const r = pearson(m.pts[idx.get(a)], m.pts[idx.get(b)]);
      if (Number.isFinite(r)) rs.push(r);
    }
    usedPairs += rs.length;
    out.push(rs.length ? (rs.reduce((x, y) => x + y, 0) / rs.length).toFixed(3) : "n/a");
  }
  console.log([coupling.toFixed(2), ...out, usedPairs].map((s) => String(s).padStart(10)).join(""));
}
console.log("\nA coupling of 0 must produce ~0.000 on every pair. If it does not, the copula is not");
console.log("the thing producing the correlation and every number above is measuring something else.");
