/**
 * WEEKLY BAND COVERAGE BY PRESEASON LINE (2026-09-25).
 *
 *   node --import tsx scripts/weekly-band-coverage.ts [--seasons 2022-2025] [--artifact data/weekly-artifact.json]
 *
 * The weekly model predicts a RATIO to the preseason line, clamped to [0, 4], and was trained on lines
 * >= 3. A player whose line is tiny (a back nobody expected to play who now has a role) needs a ratio
 * above the clamp, so his mean AND upper quantiles pin at line x 4 and the band collapses. This prints
 * how often the realised week lands above p90 / below p10, by line bucket -- a calibrated band is ~10%.
 */
import { readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { loadWeeklyRows } from "../src/weekly/features.js";
import { projectWeekly, loadWeeklyArtifact } from "../src/weekly/projector.js";

const argv = process.argv.slice(2);
const val = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2022-2025").split("-").map(Number);
const art = loadWeeklyArtifact(JSON.parse(readFileSync(val("--artifact", "data/weekly-artifact.json"), "utf8")));
const db = openDb() as any;
const outcome = db.prepare("SELECT feat_key, pts, is_bye FROM feat_player_week_model WHERE season=? AND week=?");
type A = { n: number; above: number; below: number; posP10: number; capped: number; sumMean: number; sumPts: number; sumP50: number; belowP50: number };
const acc: Record<string, A> = {};
for (let season = LO; season <= HI; season++) {
  for (let week = 3; week <= 13; week++) {
    const rows = loadWeeklyRows(db, season, week) as any[];
    const out = new Map((outcome.all(season, week) as any[]).map((r) => [r.feat_key, r]));
    for (const p of projectWeekly({ artifact: art, rows })) {
      const o: any = out.get(p.feat_key);
      const r: any = rows.find((x) => x.feat_key === p.feat_key);
      if (!o || o.is_bye || o.pts == null || !["RB", "WR", "TE"].includes(p.pos) || !r) continue;
      const line = r.season_line_pg;
      const bucket = line < 1.5 ? "line <1.5" : line < 3 ? "line 1.5-3" : "line >=3";
      const a = (acc[bucket] ??= { n: 0, above: 0, below: 0, posP10: 0, capped: 0, sumMean: 0, sumPts: 0, sumP50: 0, belowP50: 0 });
      a.sumMean += p.mean; a.sumPts += o.pts; a.sumP50 += p.p50; if (o.pts < p.p50) a.belowP50++;
      a.n++; if (o.pts > p.p90) a.above++;
      if (p.p10 > 0) { a.posP10++; if (o.pts < p.p10) a.below++; }
      if (p.p90 >= line * art.clamps.hi * 0.999) a.capped++;
    }
  }
}
console.log(`served weekly band coverage, RB/WR/TE, ${LO}-${HI} weeks 3-13 (calibrated: ~10% above p90):`);
for (const k of ["line <1.5", "line 1.5-3", "line >=3"]) {
  const a = acc[k]; if (!a) continue;
  console.log(`  ${k.padEnd(11)} n ${String(a.n).padStart(6)}   above p90 ${(100 * a.above / a.n).toFixed(1).padStart(5)}%   below p10 (p10>0) ${(100 * a.below / Math.max(1, a.posP10)).toFixed(1).padStart(5)}%   p90 pinned at the cap ${(100 * a.capped / a.n).toFixed(0)}%`);
  console.log(`  ${"".padEnd(11)}          served mean ${(a.sumMean / a.n).toFixed(2)} vs realised ${(a.sumPts / a.n).toFixed(2)} (bias ${((a.sumMean - a.sumPts) / a.n).toFixed(2)})   realised below p50 ${(100 * a.belowP50 / a.n).toFixed(0)}% (calibrated ~50%)`);
}
