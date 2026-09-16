// Build a PER-FORMAT projection target (re-scored history) into data/formats/<scoringKey>/, without
// touching the active league's data/history-*.csv. The re-scoring is buildHistory -- shipped code -- so
// correctness reduces to scoreWeek (ground-truthed 8/8 vs Yahoo) + summation. This script adds:
//   1) a POSITIVE CONTROL that the new outDir path is a pure, deterministic redirect, and
//   2) face-validity output on the resulting target, and
//   3) the PREIMAGE (scoring.json) + manifest.json the resolver verifies the directory against.
//
// THE SCORING COMES FROM THE LEAGUE, NOT FROM A CONSTANT (WP3/F-6). This used to read the literal
// `YAHOO_129048_SCORING` and hardcode the resulting key, so the built directory was a model of a
// constant in a source file rather than of a league's stored rules -- and nothing could tell the two
// apart once the directory existed. Now it takes `--league <id>`, derives the rules from
// `getConfig(db, id)`, and writes the preimage so `resolveFormat` can re-hash and refuse a mismatch.
//
// Usage: node --import tsx scripts/build-format-target.mjs --league 129048 [--seasons 2014-2025]
// Read-mostly: writes only under data/formats/<key>/ and two temp dirs. (multi-format design, Phase 3b)
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, getConfig, nowIso } from "../src/db/db.ts";
import { buildHistory } from "../src/data/history.ts";
import { buildSkResolver } from "../src/data/skResolve.ts";
import { DEFAULT_LEAGUE_SCORING, DEFAULT_SCORING } from "../src/draft/scoring.ts";
import { canonicalJson, scoringKeyFor, valueKey, formatKey } from "../src/data/formatKey.ts";
import { formatDir } from "../src/data/formatResolve.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const leagueArg = arg("--league", null);
const range = (arg("--seasons", "2014-2025")).split("-").map(Number);
const seasons = []; for (let y = range[0]; y <= (range[1] ?? range[0]); y++) seasons.push(y);

const db = openDb();
const ctx = resolveLeagueContext(db, leagueArg);
if (!ctx.leagueId) { console.error("build-format-target: no league -- pass --league <id>"); process.exit(1); }
const cfg = ctx.config;
const resolver = buildSkResolver(db);

// THE FORMAT'S SCORING, from the league's own config. `kicker`/`defense` are carried through so the
// key and the target agree: the target CSV scores K and DST rows, and a league that overrides those
// tables must get its own directory rather than sharing the default one.
const league = {
  ...DEFAULT_LEAGUE_SCORING(),
  rules: cfg.scoring_rules,
  ...(cfg.kicker ? { kicker: cfg.kicker } : {}),
  ...(cfg.defense ? { defense: cfg.defense } : {}),
};
const key = scoringKeyFor({ rules: cfg.scoring_rules, kicker: cfg.kicker, defense: cfg.defense });
const outDir = formatDir(key);
mkdirSync(outDir, { recursive: true });

console.log(`league ${ctx.leagueId} (${ctx.platform ?? "?"}, ${ctx.name ?? "unnamed"})`);
console.log(`scoringKey = ${key}   valueKey = ${valueKey(cfg)}   formatKey = ${formatKey(cfg)}`);
console.log(`canonical rules = ${canonicalJson(cfg.scoring_rules)}`);
console.log(`building target for ${seasons.length} seasons (${seasons[0]}-${seasons.at(-1)}) -> ${outDir}\n`);

// THE FROZEN WINDOW (F-8). history-*.csv are BACKTEST inputs: a partial live season in them is 421
// rows of half-a-season totals presented as season totals, and the live season has its own home
// (current-actuals.csv, written by `ff sync-actuals`). So the target stops at the last SETTLED season.
const settled = seasons.filter((y) => y < cfg.season);
if (settled.length !== seasons.length) {
  console.log(`  NOTE: dropping ${seasons.filter((y) => y >= cfg.season).join(", ")} -- the target is frozen at ` +
    `SETTLED seasons (< ${cfg.season}); the live season lives in current-actuals.csv (F-8).\n`);
}

const r = await buildHistory(settled, league, resolver, outDir);
console.log(`wrote ${r.points} season rows + ${r.weekly} weekly rows; sk resolved ${r.resolved}/${r.resolved + r.unresolved}`);

// --- THE PREIMAGE + MANIFEST: what makes the directory name falsifiable (F-5). --------------------
const scoringDoc = {
  scoringKey: key,
  rules: cfg.scoring_rules,
  kicker: cfg.kicker ?? null,
  defense: cfg.defense ?? null,
  provenance: {
    leagueId: ctx.leagueId,
    platform: ctx.platform,
    leagueName: ctx.name,
    // WHERE THE CONFIG ITSELF CAME FROM. `config.format.source` records whether the league's settings
    // were synced from the platform or overridden by the owner; carrying it here means the directory
    // says how much to trust its own rules, not merely what they are.
    configSource: cfg.format?.source ?? null,
    configFetchedAt: cfg.format?.fetchedAt ?? null,
    fetchedAt: nowIso(),
    builtBy: "scripts/build-format-target.mjs",
  },
};
writeFileSync(join(outDir, "scoring.json"), JSON.stringify(scoringDoc, null, 2) + "\n", "utf8");
const manifestPath = join(outDir, "manifest.json");
let manifest = {};
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { /* first build */ }
manifest = {
  ...manifest,
  scoringKey: key, valueKey: valueKey(cfg), formatKey: formatKey(cfg),
  leagueId: ctx.leagueId,
  target: {
    seasons: r.seasons, points: r.points, weekly: r.weekly,
    resolved: r.resolved, unresolved: r.unresolved,
    frozenBelowSeason: cfg.season,
    builtAt: nowIso(), builtBy: "scripts/build-format-target.mjs",
  },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`preimage -> ${join(outDir, "scoring.json")}   manifest -> ${manifestPath}`);

// --- POSITIVE CONTROL: the outDir redirect is deterministic + pure (same rules -> byte-identical). ---
const tA = mkdtempSync(join(tmpdir(), "fmt-a-")), tB = mkdtempSync(join(tmpdir(), "fmt-b-"));
try {
  await buildHistory(settled, DEFAULT_SCORING, resolver, tA);
  await buildHistory(settled, DEFAULT_SCORING, resolver, tB);
  const a = readFileSync(join(tA, "history-points.csv"), "utf8");
  const b = readFileSync(join(tB, "history-points.csv"), "utf8");
  console.log(`\nPOSITIVE CONTROL (outDir redirect deterministic): ${a === b ? "PASS -- byte-identical" : "FAIL -- differs!"}`);
  // and the half-PPR target must NOT equal this format's target (proves scoring actually varies the target)
  const mine = readFileSync(join(outDir, "history-points.csv"), "utf8");
  console.log(`SANITY (this target != half-PPR target): ${a !== mine ? "PASS -- differs as it must" : "FAIL -- identical!"}`);
} finally { rmSync(tA, { recursive: true, force: true }); rmSync(tB, { recursive: true, force: true }); }
db.close();

// --- FACE VALIDITY: top of the season target, and its position mix. ------------------------------
const lines = readFileSync(join(outDir, "history-points.csv"), "utf8").trim().split("\n").slice(1);
const rows = lines.map((l) => { const [season, name, pos, points] = l.split(","); return { season: +season, name, pos, pts: +points }; });
const last = settled.at(-1);
const y = rows.filter((x) => x.season === last).sort((a, b) => b.pts - a.pts);
console.log(`\n--- target, ${last} season top 15 ---`);
for (const x of y.slice(0, 15)) console.log(`  ${x.pts.toFixed(1).padStart(7)}  ${x.pos.padEnd(3)} ${x.name}`);
const byPos = {}; for (const x of y.slice(0, 24)) byPos[x.pos] = (byPos[x.pos] ?? 0) + 1;
console.log(`  position mix of top 24: ${Object.entries(byPos).map(([p, n]) => `${p}:${n}`).join(" ")}`);
