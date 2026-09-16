// Build a per-format TRAINING DB: data/formats/<scoringKey>/features.db, whose feat_player_season AND
// feat_player_week_model are rescored under the format's scoring, so `train_projection.py --db <that>`
// trains the format's model with NO python change. (multi-format design, Phase 3b training layer.)
//
// Approach: COPY the main store (so every shared input the feature build reads -- identity, usage, ecr,
// draft -- is present and untouched in the original), then rebuild the SCORING-DERIVED tables in the
// copy under the format target CSVs. Correctness of the retarget is spot-checked against the format's
// own history CSV and the point-in-time prior_pts invariant.
//
// WP3 CHANGES (F-4/F-6):
//   - the scoring comes from `getConfig(db, --league <id>)`, not from the `SCORINGS = { yahoo: ... }`
//     registry of source constants that used to live here (a directory built from a constant is a
//     model of a source file, and nothing downstream could tell that from a model of a league);
//   - `feat_player_week_model` is REBUILT. It used to be inherited verbatim from the copy, i.e. a
//     row-for-row half-PPR table sitting inside a Yahoo-scored database, so any weekly serve off this
//     directory would silently have been half-PPR (finding F-4, measured);
//   - the manifest records whether the weekly season-line anchor was BLIND (one artifact per held-out
//     season) or not. A non-blind line is legitimate for a first build -- there is no fold set yet --
//     but it is lookahead, and the honest thing is to write that down where the trainer can read it.
//
// KNOWN APPROXIMATION: ecr_pos_rank (consensus market rank) in the copy is the ESPN league's -- a
// market feature that is format-ish (superflex QB ranks differ). Flagged; a Yahoo consensus can replace
// it later. Everything scoring-derived (pts, prior_pts, ranks, curves, the weekly line) IS retargeted.
//
// Usage: node --import tsx scripts/build-format-features.mjs --league 129048 [--seasons 1999-2025]
//        [--weekly-seasons 2010-2026] [--artifact-dir data/formats/<key>/fold-artifacts] [--weekly-only]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, getConfig, nowIso } from "../src/db/db.ts";
import { buildHistory } from "../src/data/history.ts";
import { buildFeatures } from "../src/features/build.ts";
import { buildWeekModelFeatures } from "../src/weekly/features.ts";
import { buildSkResolver } from "../src/data/skResolve.ts";
import { DEFAULT_LEAGUE_SCORING } from "../src/draft/scoring.ts";
import { scoringKeyFor, valueKey, formatKey } from "../src/data/formatKey.ts";
import { formatDir } from "../src/data/formatResolve.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { dataPath } from "../src/data/paths.ts";

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const has = (flag) => process.argv.includes(flag);
const range = (spec) => { const p = spec.split("-").map(Number); const o = []; for (let y = p[0]; y <= (p[1] ?? p[0]); y++) o.push(y); return o; };

const leagueArg = arg("--league", null);
const seasons = range(arg("--seasons", "1999-2025"));
const weeklyOnly = has("--weekly-only");

const mainDb = openDb();
const ctx = resolveLeagueContext(mainDb, leagueArg);
if (!ctx.leagueId) { console.error("build-format-features: no league -- pass --league <id>"); process.exit(1); }
const cfg = ctx.config;
const weeklySeasons = range(arg("--weekly-seasons", `2010-${cfg.season}`));

const key = scoringKeyFor({ rules: cfg.scoring_rules, kicker: cfg.kicker, defense: cfg.defense });
const fmtDir = formatDir(key);
mkdirSync(fmtDir, { recursive: true });
const featDb = join(fmtDir, "features.db");
const league = {
  ...DEFAULT_LEAGUE_SCORING(),
  rules: cfg.scoring_rules,
  ...(cfg.kicker ? { kicker: cfg.kicker } : {}),
  ...(cfg.defense ? { defense: cfg.defense } : {}),
};
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

console.log(`[${el()}] league ${ctx.leagueId} (${ctx.platform ?? "?"}) -> format ${key}`);
console.log(`[${el()}]   valueKey ${valueKey(cfg)}   formatKey ${formatKey(cfg)}   dir ${fmtDir}`);

// 1) target (frozen at SETTLED seasons -- F-8; the live season belongs in current-actuals.csv)
const settled = seasons.filter((y) => y < cfg.season);
if (!weeklyOnly) {
  console.log(`[${el()}] building target (${settled[0]}-${settled.at(-1)})...`);
  const resolver = buildSkResolver(mainDb);
  const r = await buildHistory(settled, league, resolver, fmtDir);
  console.log(`[${el()}]   target: ${r.points} season rows, sk ${r.resolved}/${r.resolved + r.unresolved}`);
}

// 1b) THE PREIMAGE. Written here too (not only by build-format-target) so a directory this script
// creates is verifiable the moment it exists -- a dir with artifacts and no scoring.json is exactly
// the unverifiable state the resolver refuses.
writeFileSync(join(fmtDir, "scoring.json"), JSON.stringify({
  scoringKey: key, rules: cfg.scoring_rules, kicker: cfg.kicker ?? null, defense: cfg.defense ?? null,
  provenance: {
    leagueId: ctx.leagueId, platform: ctx.platform, leagueName: ctx.name,
    configSource: cfg.format?.source ?? null, configFetchedAt: cfg.format?.fetchedAt ?? null,
    fetchedAt: nowIso(), builtBy: "scripts/build-format-features.mjs",
  },
}, null, 2) + "\n", "utf8");

// 2) copy the store (shared inputs) -> features.db
if (!weeklyOnly) {
  console.log(`[${el()}] copying store -> features.db (${(readFileSync(dataPath("ff.db")).length / 1e6) | 0}MB)...`);
  copyFileSync(dataPath("ff.db"), featDb);
}
if (!existsSync(featDb)) { console.error(`${featDb} missing -- run without --weekly-only first`); process.exit(1); }

// 3) rebuild feat_player_season in the copy under the format target CSVs
let fr = null;
if (!weeklyOnly) {
  console.log(`[${el()}] rebuilding feat_player_season under ${key} scoring...`);
  fr = await buildFeatures({
    dbPath: featDb, seasons: settled,
    pointsPath: join(fmtDir, "history-points.csv"), weeklyPath: join(fmtDir, "history-weekly.csv"),
  });
  console.log(`[${el()}]   feat rows: ${JSON.stringify(fr)}`);
}

// 3b) REBUILD feat_player_week_model IN THE FORMAT DB (F-4).
//
// The season-line anchor is projected from a projection artifact at rebuild time (D17). A historical
// season's line MUST come from an artifact BLIND to that season, which means one artifact per season
// in `--artifact-dir`. This format may have no fold set yet (training it is a separate, expensive
// step), so when the directory is absent the build runs off the format's single artifact and RECORDS
// that the anchor is not blind -- rather than producing a table that looks identical to an honest one.
const foldDir = arg("--artifact-dir", join(fmtDir, "fold-artifacts"));
const blind = existsSync(foldDir);
const artifactPath = join(fmtDir, "projection-artifact.json");
if (!existsSync(artifactPath)) {
  console.error(`\n${artifactPath} missing -- the weekly season line is projected FROM it. Train the ` +
    "format's projector first (tools/train_projection.py --db " + featDb + ").");
  process.exit(1);
}
console.log(`[${el()}] rebuilding feat_player_week_model (${weeklySeasons[0]}-${weeklySeasons.at(-1)}) ` +
  `under ${key}${blind ? `, blind lines from ${foldDir}` : ", NOT blind (no fold set for this format)"}...`);
const wr = await buildWeekModelFeatures({
  dbPath: featDb, seasons: weeklySeasons, currentSeason: cfg.season,
  artifactPath, ...(blind ? { artifactDir: foldDir } : {}),
});
console.log(`[${el()}]   feat_player_week_model: ${wr.rows} rows`);

// 4) POSITIVE CONTROL: the retarget actually landed in feat.
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
const inv = db.prepare(
  "SELECT s.player_sk, s.prior_pts, p.pts AS prev FROM feat_player_season s " +
  "JOIN feat_player_season p ON p.player_sk=s.player_sk AND p.season=s.season-1 " +
  "WHERE s.season=2024 AND s.player_sk IS NOT NULL AND s.prior_pts IS NOT NULL AND p.pts IS NOT NULL",
).all();
let invOk = 0, invBad = 0;
for (const r of inv) { if (Math.abs(r.prior_pts - r.prev) < 0.05) invOk++; else invBad++; }

// 4b) THE WEEKLY MEASUREMENT (F-3 in reverse): the format's weekly table must DIFFER from the main
// store's. Identical would mean the rebuild above did nothing -- the exact state this script shipped
// in for a day, and one that no count or coverage table can distinguish from a working build.
const main = new Database(dataPath("ff.db"), { readonly: true });
const cmpSql =
  "SELECT feat_key, season, week, pts, season_line_pg FROM feat_player_week_model " +
  "WHERE season=? AND week<=4 AND pts IS NOT NULL ORDER BY feat_key, week";
const cmpSeason = Math.max(...weeklySeasons.filter((y) => y < cfg.season));
const A = db.prepare(cmpSql).all(cmpSeason);
const B = main.prepare(cmpSql).all(cmpSeason);
const bByKey = new Map(B.map((r) => [`${r.feat_key}|${r.week}`, r]));
let both = 0, ptsDiff = 0, lineDiff = 0, maxAbs = 0;
for (const a of A) {
  const b = bByKey.get(`${a.feat_key}|${a.week}`);
  if (!b) continue;
  both++;
  const d = Math.abs((a.pts ?? 0) - (b.pts ?? 0));
  if (d > 0.05) ptsDiff++;
  if (d > maxAbs) maxAbs = d;
  if (Math.abs((a.season_line_pg ?? 0) - (b.season_line_pg ?? 0)) > 0.05) lineDiff++;
}
db.close(); main.close();

console.log(`\n[${el()}] POSITIVE CONTROL:`);
if (!weeklyOnly) console.log(`  feat.pts == format target CSV (top-8 2024): ${ptsOk}/8 match${ptsBad ? ` -- ${ptsBad} MISMATCH` : ""}`);
console.log(`  prior_pts[Y] == pts[Y-1] invariant (2024): ${invOk}/${invOk + invBad} match${invBad ? ` -- ${invBad} MISMATCH` : ""}`);
console.log(`  weekly table vs the MAIN store, ${cmpSeason} wk1-4: ${both} shared rows, ` +
  `${ptsDiff} differ in pts (max |d| ${maxAbs.toFixed(1)}), ${lineDiff} differ in season_line_pg`);
console.log(`  ${ptsDiff > both * 0.5 ? "PASS" : "FAIL"} -- a format weekly table that matched the main store's would be ` +
  "the half-PPR copy this rebuild exists to retire (F-4)");
if (!weeklyOnly) console.log(`  sample: ${sample.slice(0, 4).map((r) => `${r.name}(${r.pos}) ${r.pts.toFixed(1)}`).join(", ")}`);

// 5) MANIFEST -- including the honesty flag on the weekly anchor.
const manifestPath = join(fmtDir, "manifest.json");
let manifest = {};
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { /* first build */ }
manifest = {
  ...manifest,
  scoringKey: key, valueKey: valueKey(cfg), formatKey: formatKey(cfg), leagueId: ctx.leagueId,
  ...(fr ? { features: { seasons: [settled[0], settled.at(-1)], ...fr, builtAt: nowIso() } } : {}),
  weekly: {
    seasons: [weeklySeasons[0], weeklySeasons.at(-1)],
    rows: wr.rows,
    currentSeason: cfg.season,
    artifact: artifactPath,
    // THE HONESTY FLAG. False means every historical season's season-line anchor came from an
    // artifact that had SEEN that season -- usable for a first build, lookahead for an evaluation.
    seasonLineBlind: blind,
    ...(blind ? { foldArtifactDir: foldDir } : { seasonLineNote:
      "NOT BLIND: no fold-artifact set exists for this format, so every historical season's line was " +
      "projected from an artifact fitted on all seasons INCLUDING that one. Train one artifact per " +
      "held-out season (train_projection.py --holdout-season Y) into fold-artifacts/ and re-run with " +
      "--weekly-only before using this table to EVALUATE anything." }),
    builtAt: nowIso(), builtBy: "scripts/build-format-features.mjs",
  },
  ecrApproximation: "ecr_pos_rank is the ESPN league's consensus rank (format-ish; a native consensus would be cleaner)",
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`\n[${el()}] manifest -> ${manifestPath}`);
mainDb.close();
if (!blind) {
  console.log(`[${el()}] NOTE: manifest.weekly.seasonLineBlind = false. See manifest.weekly.seasonLineNote.`);
}
