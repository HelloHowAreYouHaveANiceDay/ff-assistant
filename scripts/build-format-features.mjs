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
import { formatDir, resolveFormat } from "../src/data/formatResolve.ts";
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

// ==================================================================================================
// `--forward-only`: THE LIVE SEASON'S WEEKLY ROWS, IN THE FORMAT'S OWN FEATURE TABLES (WP8).
//
// `ff sync-actuals` writes a non-incumbent format's `current-actuals.csv` and then REFUSES the
// forward-board rebuild, for a reason that was correct when it was written: `buildForwardBoard`
// writes `feat_player_week` / `feat_player_week_model`, and in the main store those hold the
// INCUMBENT's scored target -- rebuilding them under another format's rules would silently replace
// every ESPN in-season feature. Its own note says what the fix is ("a per-format forward board needs
// the format dir's own feature tables"), and that database now exists.
//
// So this mode runs the SAME two builders against `data/formats/<key>/features.db`, with the format's
// own actuals and the format's own projector anchoring the season line. Nothing outside the format
// directory is opened for writing. Without it the live season's rows in the format db stop at the
// last week the target build covered, and the weekly serve has no row for THIS week -- which is the
// honest fallback, but it is not the edge.
// ==================================================================================================
if (has("--forward-only")) {
  if (!existsSync(featDb)) { console.error(`${featDb} missing -- run the full build first`); process.exit(1); }
  const fmt = resolveFormat(mainDb, ctx.leagueId);
  const actuals = fmt.model.path("current-actuals");
  if (!existsSync(actuals)) {
    console.error(`${actuals} missing -- run \`npm run ff -- sync-actuals --league ${ctx.leagueId}\` first ` +
      "(the forward board merges the settled weeks from it).");
    process.exit(1);
  }
  const season = cfg.season;
  const { buildForwardBoard } = await import("../src/weekly/forwardBoard.ts");
  const { buildForwardWeeks } = await import("../src/weekly/features.ts");
  console.log(`[${el()}] forward board for ${season} -> ${featDb} (actuals ${actuals})`);
  const b = await buildForwardBoard({ dbPath: featDb, season, actualsPath: actuals });
  console.log(`[${el()}]   feat_player_week: ${b.weekRows} rows (${b.withPts} with actual pts), ` +
    `${b.keys} players x ${b.maxWeek} weeks`);
  const f = await buildForwardWeeks({ dbPath: featDb, season, model: fmt.model });
  console.log(`[${el()}]   feat_player_week_model: ${f.rows} rows, ${f.players} players x ${f.weeks} weeks; ` +
    `${f.withLine} with a season line; weeks already played: ${f.playedWeeks.join(",") || "(none)"}`);
  // POSITIVE CONTROL: the live rows must be on the FORMAT's scale, not the incumbent's. The season
  // line is the thing the weekly model multiplies, so it is the thing to check.
  const chk = new Database(featDb, { readonly: true });
  const cmp = (p) => chk.prepare(
    "SELECT AVG(season_line_pg) a FROM feat_player_week_model WHERE season=? AND week=1 AND pos=? AND season_line_pg IS NOT NULL",
  ).get(season, p)?.a ?? null;
  const mainChk = new Database(dataPath("ff.db"), { readonly: true });
  const cmpMain = (p) => mainChk.prepare(
    "SELECT AVG(season_line_pg) a FROM feat_player_week_model WHERE season=? AND week=1 AND pos=? AND season_line_pg IS NOT NULL",
  ).get(season, p)?.a ?? null;
  console.log(`[${el()}]   mean season_line_pg, ${season} wk1 -- format vs the MAIN store:`);
  for (const p of ["QB", "RB", "WR", "TE"]) {
    const a = cmp(p), b2 = cmpMain(p);
    console.log(`      ${p}  ${a == null ? "-" : a.toFixed(2)}  vs  ${b2 == null ? "-" : b2.toFixed(2)}` +
      (a != null && b2 != null && Math.abs(a - b2) > 0.05 ? "" : "   <- IDENTICAL: the format rows are the incumbent's"));
  }
  chk.close(); mainChk.close(); mainDb.close();
  process.exit(0);
}

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
//
// WP8 HARDENING: `blind` used to be `existsSync(foldDir)` -- the presence of a DIRECTORY, which is a
// claim about a folder, not about the lines in the table. A fold set covering half the seasons, or one
// whose artifact-2019.json was fitted on 2019, set the honesty flag to true just as readily as a
// complete one. So blindness is now decided PER SEASON, from each artifact's own `holdoutSeason`
// header, and `manifest.weekly.seasonLineBlind` is true only when EVERY historical season that will
// be in the table has one. `buildInto` already throws if an artifact's holdoutSeason disagrees with
// the season it would project; this is the other half -- the seasons with no artifact at all, which
// fall back to the shipped (season-seeing) artifact and are merely WARNED about inside the build.
const foldDir = arg("--artifact-dir", join(fmtDir, "fold-artifacts"));
const artifactPath = join(fmtDir, "projection-artifact.json");
const histSeasons = weeklySeasons.filter((y) => y < cfg.season);
const blindSeasons = [], notBlindSeasons = [];
for (const y of histSeasons) {
  const p = join(foldDir, `artifact-${y}.json`);
  let ok = false;
  if (existsSync(p)) {
    try { ok = JSON.parse(readFileSync(p, "utf8")).holdoutSeason === y; } catch { ok = false; }
  }
  (ok ? blindSeasons : notBlindSeasons).push(y);
}
const blind = existsSync(foldDir) && notBlindSeasons.length === 0;
if (!existsSync(artifactPath)) {
  console.error(`\n${artifactPath} missing -- the weekly season line is projected FROM it. Train the ` +
    "format's projector first (tools/train_projection.py --db " + featDb + ").");
  process.exit(1);
}
console.log(`[${el()}] rebuilding feat_player_week_model (${weeklySeasons[0]}-${weeklySeasons.at(-1)}) ` +
  `under ${key}${blind ? `, blind lines from ${foldDir}` : notBlindSeasons.length && blindSeasons.length
    ? `, PARTIALLY blind (no artifact for ${notBlindSeasons.join(", ")})`
    : ", NOT blind (no fold set for this format)"}...`);
const wr = await buildWeekModelFeatures({
  dbPath: featDb, seasons: weeklySeasons, currentSeason: cfg.season,
  artifactPath, ...(existsSync(foldDir) ? { artifactDir: foldDir } : {}),
});
console.log(`[${el()}]   feat_player_week_model: ${wr.rows} rows`);

// 3c) PRUNE seasons OUTSIDE the built range. The builder replaces each season it builds and leaves
// every other season untouched, so a narrower rebuild (e.g. dropping 2010-2011, which no fold set can
// make blind) would otherwise leave those seasons' OLD, not-blind rows in the table while the manifest
// above described only the seasons just built. A flag rather than a default, because silently deleting
// rows nobody asked about is its own failure mode; the count is printed either way.
{
  const w = new Database(featDb);
  const lo = weeklySeasons[0], hi = weeklySeasons.at(-1);
  const stale = w.prepare("SELECT season, COUNT(*) n FROM feat_player_week_model WHERE season < ? OR season > ? GROUP BY season")
    .all(lo, hi);
  if (stale.length) {
    const what = stale.map((r) => `${r.season}:${r.n}`).join(", ");
    if (has("--prune-weekly")) {
      w.prepare("DELETE FROM feat_player_week_model WHERE season < ? OR season > ?").run(lo, hi);
      console.log(`[${el()}]   pruned rows outside ${lo}-${hi}: ${what}`);
    } else {
      console.log(`[${el()}]   WARNING rows remain OUTSIDE ${lo}-${hi} and were NOT rebuilt (${what}); ` +
        "their season lines are whatever an earlier build left. Pass --prune-weekly to delete them.");
    }
  }
  w.close();
}

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
    // WHICH seasons, not just whether. A reader asking "can I evaluate on 2019?" gets an answer
    // rather than a flag that summarises fourteen seasons into one bit.
    blindSeasons, notBlindSeasons,
    ...(blind ? { foldArtifactDir: foldDir } : { seasonLineNote:
      `NOT BLIND for ${notBlindSeasons.join(", ")}: no artifact-<season>.json in ${foldDir} declares ` +
      "that season held out, so its line was projected from an artifact fitted on all seasons INCLUDING " +
      "it. Train one artifact per held-out season (train_projection.py --holdout-season Y) into " +
      "fold-artifacts/ and re-run with --weekly-only before using THOSE seasons to EVALUATE anything " +
      `(the seasons in blindSeasons are honest already${blindSeasons.length ? "" : " -- there are none"}).` }),
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
