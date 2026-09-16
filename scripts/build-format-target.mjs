// Build a PER-FORMAT projection target (re-scored history) into data/formats/<scoringKey>/, without
// touching the active league's data/history-*.csv. The re-scoring is buildHistory -- shipped code -- so
// correctness reduces to scoreWeek (ground-truthed 8/8 vs Yahoo) + summation. This script adds:
//   1) a POSITIVE CONTROL that the new outDir path is a pure, deterministic redirect, and
//   2) face-validity output on the resulting target.
// Read-mostly: writes only under data/formats/<key>/ and two temp dirs. (multi-format design, Phase 3b)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, getConfig } from "../src/db/db.ts";
import { buildHistory } from "../src/data/history.ts";
import { buildSkResolver } from "../src/data/skResolve.ts";
import { DEFAULT_LEAGUE_SCORING, YAHOO_129048_SCORING, DEFAULT_SCORING } from "../src/draft/scoring.ts";
import { scoringKey, canonicalJson } from "../src/data/formatKey.ts";
import { dataPath } from "../src/data/paths.ts";

const rangeArg = (process.argv[2] ?? "2014-2025").split("-").map(Number);
const seasons = []; for (let y = rangeArg[0]; y <= (rangeArg[1] ?? rangeArg[0]); y++) seasons.push(y);

const db = openDb();
const resolver = buildSkResolver(db);
db.close();

const key = scoringKey(YAHOO_129048_SCORING);
const outDir = dataPath(join("formats", key));
const model = { ...DEFAULT_LEAGUE_SCORING(), rules: YAHOO_129048_SCORING };

console.log(`scoringKey(YAHOO) = ${key}`);
console.log(`canonical rules  = ${canonicalJson(YAHOO_129048_SCORING)}`);
console.log(`building Yahoo target for ${seasons.length} seasons (${seasons[0]}-${seasons.at(-1)}) -> ${outDir}\n`);

const r = await buildHistory(seasons, model, resolver, outDir);
console.log(`wrote ${r.points} season rows + ${r.weekly} weekly rows; sk resolved ${r.resolved}/${r.resolved + r.unresolved}`);

// --- POSITIVE CONTROL: the outDir redirect is deterministic + pure (same rules -> byte-identical). ---
const tA = mkdtempSync(join(tmpdir(), "fmt-a-")), tB = mkdtempSync(join(tmpdir(), "fmt-b-"));
try {
  await buildHistory(seasons, DEFAULT_SCORING, resolver, tA);
  await buildHistory(seasons, DEFAULT_SCORING, resolver, tB);
  const a = readFileSync(join(tA, "history-points.csv"), "utf8");
  const b = readFileSync(join(tB, "history-points.csv"), "utf8");
  console.log(`\nPOSITIVE CONTROL (outDir redirect deterministic): ${a === b ? "PASS -- byte-identical" : "FAIL -- differs!"}`);
  // and the half-PPR target must NOT equal the Yahoo target (proves scoring actually varies the target)
  const yah = readFileSync(join(outDir, "history-points.csv"), "utf8");
  console.log(`SANITY (Yahoo target != half-PPR target): ${a !== yah ? "PASS -- differs as it must" : "FAIL -- identical!"}`);
} finally { rmSync(tA, { recursive: true, force: true }); rmSync(tB, { recursive: true, force: true }); }

// --- FACE VALIDITY: top of the Yahoo season target, and QB share of it (superflex/6pt/PPR). ---
const lines = readFileSync(join(outDir, "history-points.csv"), "utf8").trim().split("\n").slice(1);
const rows = lines.map((l) => { const [season, name, pos, points] = l.split(","); return { season: +season, name, pos, pts: +points }; });
const y = rows.filter((x) => x.season === seasons.at(-1)).sort((a, b) => b.pts - a.pts);
console.log(`\n--- Yahoo target, ${seasons.at(-1)} season top 15 ---`);
for (const x of y.slice(0, 15)) console.log(`  ${x.pts.toFixed(1).padStart(7)}  ${x.pos.padEnd(3)} ${x.name}`);
const byPos = {}; for (const x of y.slice(0, 24)) byPos[x.pos] = (byPos[x.pos] ?? 0) + 1;
console.log(`  position mix of top 24: ${Object.entries(byPos).map(([p, n]) => `${p}:${n}`).join(" ")}`);
