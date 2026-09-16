// Sanity-check a trained per-format projector: serve its projections and confirm the format signal is
// present (Yahoo superflex/6pt/PPR -> QBs dominate), side-by-side with the shipped ESPN artifact.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { dataPath } from "../src/data/paths.ts";

const season = Number(process.argv[2] ?? 2025);
const fmtDir = dataPath(join("formats", "sc-a845f67652fb"));

function serve(label, artifactPath, dbPath) {
  const art = loadArtifact(JSON.parse(readFileSync(artifactPath, "utf8")), { checkGolden: true });
  const db = openDb(dbPath);
  const rows = boardProjection(db, season, art).filter((r) => r.mean > 0).sort((a, b) => b.mean - a.mean);
  db.close();
  const top = rows.slice(0, 24);
  const mix = {}; for (const r of top) mix[r.pos] = (mix[r.pos] ?? 0) + 1;
  console.log(`\n=== ${label} (project ${season}) ===  golden: OK`);
  console.log(`top 24 position mix: ${Object.entries(mix).map(([p, n]) => `${p}:${n}`).join(" ")}`);
  for (const r of rows.slice(0, 12)) console.log(`  ${r.mean.toFixed(1).padStart(7)}  ${r.pos.padEnd(3)} ${r.name}`);
  return rows;
}

console.log(`Serving projections for ${season}. Expectation: Yahoo QBs dominate; ESPN QBs do not.`);
serve("YAHOO artifact vs Yahoo features.db", join(fmtDir, "projection-artifact.json"), join(fmtDir, "features.db"));
serve("ESPN artifact (shipped) vs main store", dataPath("projection-artifact.json"), dataPath("ff.db"));
