/**
 * COMPARE A WEEKLY CANDIDATE'S FOLDS TO THE CONTROL'S (2026-09-25).
 *
 *   node --import tsx scripts/weekly-candidate-compare.ts --control <dir> --candidate <dir> [--seasons 2012-2025]
 *
 * Both dirs hold `weekly-<season>.json` fold artifacts from `ff evaluate-weekly --keep-artifacts`
 * (each trained WITHOUT its season), so every number here is out-of-fold. Three reads:
 *   1. ROSTERED POPULATION, paired by SEASON: RMSE of the mean and pinball loss at p10/p50/p90, per
 *      position -- the gate's own population, at the unit this repo judges on (2.9 SE across seasons).
 *   2. EXTREME PROJECTIONS: established players (line >= 5) projected at >= 2.5x their line -- the
 *      defect that made clamp 8 fail (Kelce 2021 wk7 at 40.2), with the realised mean on those rows.
 *   3. SMALL-LINE MEAN BIAS: served mean vs realised for lines < 1.5 and 1.5-3, every non-bye row.
 */
import { readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { loadWeeklyRows } from "../src/weekly/features.js";
import { projectWeekly, loadWeeklyArtifact, type WeeklyArtifact } from "../src/weekly/projector.js";

const argv = process.argv.slice(2);
const val = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const C = val("--control"), X = val("--candidate");
if (!C || !X) throw new Error("usage: --control <dir> --candidate <dir>");
const [LO, HI] = (val("--seasons", "2012-2025") as string).split("-").map(Number);
// `--candidate-env KEY=VAL`: a SERVE-TIME knob applied to the candidate arm only (e.g. the mean cap),
// so a serve-side change can be judged on the same fold artifacts without retraining.
const CENV = val("--candidate-env");
const [CK, CV] = CENV ? [CENV.slice(0, CENV.indexOf("=")), CENV.slice(CENV.indexOf("=") + 1)] : [null, null];
const withEnv = <T,>(on: boolean, f: () => T): T => {
  if (!CK) return f();
  const prev = process.env[CK];
  if (on) process.env[CK] = CV!; else delete process.env[CK];
  try { return f(); } finally { if (prev === undefined) delete process.env[CK]; else process.env[CK] = prev; }
};
const db = openDb() as any;
const outc = db.prepare("SELECT feat_key, pts, is_bye, in_population pop FROM feat_player_week_model WHERE season=? AND week=?");
const pin = (y: number, q: number, t: number) => (y >= q ? t * (y - q) : (1 - t) * (q - y));
const load = (dir: string, s: number): WeeklyArtifact => loadWeeklyArtifact(JSON.parse(readFileSync(`${dir}/weekly-${s}.json`, "utf8")));
const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;

type Acc = { se: number; pl: number; n: number };
const per: Record<string, Record<number, { c: Acc; x: Acc }>> = {};
const ext = { c: { n: 0, sumPred: 0, sumY: 0 }, x: { n: 0, sumPred: 0, sumY: 0 }, rows: 0 };
const small: Record<string, { c: number; x: number; y: number; n: number }> = {};
for (let s = LO; s <= HI; s++) {
  const ac = load(C, s), ax = load(X, s);
  let prevPlayed = new Set<string>();   // feat_keys with a realised score the previous week of this season
  for (let w = 1; w <= 18; w++) {
    const rows = loadWeeklyRows(db, s, w) as any[]; if (!rows.length) continue;
    const lineOf = new Map(rows.map((r) => [r.feat_key, r.season_line_pg as number]));
    const o = new Map((outc.all(s, w) as any[]).map((r) => [r.feat_key, r]));
    const pc = new Map(withEnv(false, () => projectWeekly({ artifact: ac, rows })).map((r) => [r.feat_key, r]));
    const px = new Map(withEnv(true, () => projectWeekly({ artifact: ax, rows })).map((r) => [r.feat_key, r]));
    const playedNow = new Set([...o.values()].filter((r: any) => !r.is_bye && r.pts != null).map((r: any) => r.feat_key as string));
    for (const [k, c] of pc) {
      const x = px.get(k), r: any = o.get(k), line = lineOf.get(k);
      if (!x || !r || r.is_bye || line == null || !["QB", "RB", "WR", "TE"].includes(c.pos)) continue;
      const y = r.pts ?? 0;
      if (line >= 5) {
        ext.rows++;
        for (const [m, p] of [["c", c], ["x", x]] as const) if (p.mean / line >= 2.5) { ext[m].n++; ext[m].sumPred += p.mean; ext[m].sumY += y; }
      }
      if (line < 3) {
        const b = line < 1.5 ? "line <1.5" : "line 1.5-3";
        // The second key is the WAIVER-RELEVANT population: he played LAST week (knowable before the
        // decision). NOT "played this week" -- conditioning on the outcome makes any model look low.
        for (const key of [b, `${b}, played last wk`]) {
          if (key !== b && !prevPlayed.has(k)) continue;
          const a = (small[key] ??= { c: 0, x: 0, y: 0, n: 0 }); a.c += c.mean; a.x += x.mean; a.y += y; a.n++;
        }
      }
      if (!r.pop) continue;
      const acc = ((per[c.pos] ??= {})[s] ??= { c: { se: 0, pl: 0, n: 0 }, x: { se: 0, pl: 0, n: 0 } });
      for (const [m, p] of [["c", c], ["x", x]] as const) {
        const t = acc[m]; t.se += (p.mean - y) ** 2; t.pl += pin(y, p.p10, 0.1) + pin(y, p.p50, 0.5) + pin(y, p.p90, 0.9); t.n++;
      }
    }
    prevPlayed = playedNow;
  }
}
const verdict = (d: number[]) => {
  const m = mean(d), se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / (d.length - 1));
  return `${m >= 0 ? "+" : ""}${m.toFixed(4)} SE ${se.toFixed(4)} ${String(d.filter((x) => x < 0).length).padStart(2)}/${d.length} better ${m < -2.9 * se ? "BETTER" : m > 2.9 * se ? "WORSE " : "NULL  "}`;
};
console.log(`candidate ${X}${CENV ? ` with ${CENV}` : ""}\n  vs control ${C}, seasons ${LO}-${HI}, out-of-fold (negative = candidate better)\n`);
console.log("1. ROSTERED, paired by season:");
for (const pos of ["QB", "RB", "WR", "TE"]) {
  const ys = Object.keys(per[pos] ?? {}).map(Number);
  const dR = ys.map((y) => Math.sqrt(per[pos][y].x.se / per[pos][y].x.n) - Math.sqrt(per[pos][y].c.se / per[pos][y].c.n));
  const dP = ys.map((y) => per[pos][y].x.pl / per[pos][y].x.n - per[pos][y].c.pl / per[pos][y].c.n);
  console.log(`  ${pos}  RMSE(mean) ${verdict(dR)}  |  pinball ${verdict(dP)}`);
}
console.log(`\n2. EXTREME: established (line >= 5) projected >= 2.5x line, of ${ext.rows} rows:`);
for (const [m, lbl] of [["c", "control"], ["x", "candidate"]] as const) {
  const e = ext[m];
  console.log(`  ${lbl.padEnd(10)} ${String(e.n).padStart(5)} rows${e.n ? `; mean projected ${(e.sumPred / e.n).toFixed(1)} vs realised ${(e.sumY / e.n).toFixed(1)}` : ""}`);
}
console.log("\n3. SMALL-LINE MEAN BIAS (every non-bye row):");
for (const [b, a] of Object.entries(small).sort()) console.log(`  ${b.padEnd(28)} n ${String(a.n).padStart(6)}  control ${(a.c / a.n - a.y / a.n).toFixed(2)}   candidate ${(a.x / a.n - a.y / a.n).toFixed(2)}   (realised ${(a.y / a.n).toFixed(2)})`);
