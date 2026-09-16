// Build a per-format TRAINING DB: data/formats/<scoringKey>/features.db, whose feat_player_season is
// rescored under the format's scoring, so `train_projection.py --db <that>` trains the format's model
// with NO python change. (multi-format design, Phase 3b training layer.)
//
// Approach: COPY the main store (so every shared input the feature build reads -- identity, usage, ecr,
// draft -- is present and untouched in the original), then rebuild ONLY feat_player_season in the copy
// under the format target CSVs. Correctness of the retarget is spot-checked against the 8/8-verified
// Yahoo history CSV and the point-in-time prior_pts invariant.
//
// KNOWN APPROXIMATION: ecr_pos_rank (consensus market rank) in the copy is the ESPN league's -- a
// market feature that is format-ish (superflex QB ranks differ). Flagged; a Yahoo consensus can replace
// it later. Everything scoring-derived (pts, prior_pts, ranks, curves) IS retargeted.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, getConfig } from "../src/db/db.ts";
import { buildHistory } from "../src/data/history.ts";
import { buildFeatures } from "../src/features/build.ts";
import { buildSkResolver } from "../src/data/skResolve.ts";
import { DEFAULT_LEAGUE_SCORING, YAHOO_129048_SCORING } from "../src/draft/scoring.ts";
import { scoringKey } from "../src/data/formatKey.ts";
import { dataPath } from "../src/data/paths.ts";

const SCORINGS = { yahoo: YAHOO_129048_SCORING };
const name = process.argv[2] ?? "yahoo";
const range = (process.argv[3] ?? "1999-2025").split("-").map(Number);
const seasons = []; for (let y = range[0]; y <= (range[1] ?? range[0]); y++) seasons.push(y);
const scoring = SCORINGS[name];
if (!scoring) { console.error(`unknown format '${name}' (have: ${Object.keys(SCORINGS).join(",")})`); process.exit(1); }

const key = scoringKey(scoring);
const fmtDir = dataPath(join("formats", key));
mkdirSync(fmtDir, { recursive: true });
const featDb = join(fmtDir, "features.db");
const model = { ...DEFAULT_LEAGUE_SCORING(), rules: scoring };
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

// 1) target
console.log(`[${el()}] format '${name}' -> ${key}\n[${el()}] building target (${seasons[0]}-${seasons.at(-1)})...`);
{
  const db = openDb(); const resolver = buildSkResolver(db); db.close();
  const r = await buildHistory(seasons, model, resolver, fmtDir);
  console.log(`[${el()}]   target: ${r.points} season rows, sk ${r.resolved}/${r.resolved + r.unresolved}`);
}

// 2) copy the store (shared inputs) -> features.db
console.log(`[${el()}] copying store -> features.db (${(readFileSync(dataPath("ff.db")).length / 1e6) | 0}MB)...`);
copyFileSync(dataPath("ff.db"), featDb);

// 3) rebuild feat_player_season in the copy under the format target CSVs
console.log(`[${el()}] rebuilding feat_player_season under ${name} scoring...`);
const fr = await buildFeatures({
  dbPath: featDb, seasons,
  pointsPath: join(fmtDir, "history-points.csv"), weeklyPath: join(fmtDir, "history-weekly.csv"),
});
console.log(`[${el()}]   feat rows: ${JSON.stringify(fr)}`);

// 4) POSITIVE CONTROL: the retarget actually landed in feat.
// (a) feat.pts == the 8/8-verified Yahoo history CSV, for a sample.
// (b) prior_pts[Y] == pts[Y-1] (point-in-time invariant, per-player).
const histLines = readFileSync(join(fmtDir, "history-points.csv"), "utf8").trim().split("\n").slice(1);
const histPts = new Map(); // `${sk}|${season}` -> pts   (sk is last col)
for (const l of histLines) { const c = l.split(","); const sk = c[c.length - 1]; if (sk) histPts.set(`${sk}|${c[0]}`, +c[3]); }
const db = new Database(featDb, { readonly: true });
const sample = db.prepare(
  "SELECT player_sk, season, name, pos, pts, prior_pts FROM feat_player_season WHERE player_sk IS NOT NULL AND season=2024 AND pts IS NOT NULL ORDER BY pts DESC LIMIT 8",
).all();
let ptsOk = 0, ptsBad = 0;
for (const r of sample) {
  const h = histPts.get(`${r.player_sk}|${r.season}`);
  const ok = h != null && Math.abs(h - r.pts) < 0.05;
  if (ok) ptsOk++; else ptsBad++;
}
// prior_pts invariant over all resolved 2024 rows
const inv = db.prepare(
  "SELECT s.player_sk, s.prior_pts, p.pts AS prev FROM feat_player_season s " +
  "JOIN feat_player_season p ON p.player_sk=s.player_sk AND p.season=s.season-1 " +
  "WHERE s.season=2024 AND s.player_sk IS NOT NULL AND s.prior_pts IS NOT NULL AND p.pts IS NOT NULL",
).all();
let invOk = 0, invBad = 0;
for (const r of inv) { if (Math.abs(r.prior_pts - r.prev) < 0.05) invOk++; else invBad++; }
db.close();

console.log(`\n[${el()}] POSITIVE CONTROL:`);
console.log(`  feat.pts == Yahoo target CSV (top-8 2024): ${ptsOk}/8 match${ptsBad ? ` -- ${ptsBad} MISMATCH` : ""}`);
console.log(`  prior_pts[Y] == pts[Y-1] invariant (2024): ${invOk}/${invOk + invBad} match${invBad ? ` -- ${invBad} MISMATCH` : ""}`);
console.log(`  sample: ${sample.slice(0, 4).map((r) => `${r.name}(${r.pos}) ${r.pts.toFixed(1)}`).join(", ")}`);
console.log(`\n[${el()}] DONE. Train with:`);
console.log(`  uv run --with scikit-learn --with numpy tools/train_projection.py --db ${featDb} --seasons ${seasons[0]}-${seasons.at(-1)} --holdout-season none --out ${join(fmtDir, "projection-artifact.json")}`);
