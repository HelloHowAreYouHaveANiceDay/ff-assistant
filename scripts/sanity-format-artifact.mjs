// Sanity-check a trained per-format projector: serve its projections and confirm the format signal is
// present (Yahoo superflex/6pt/PPR -> QBs dominate), side-by-side with the shipped ESPN artifact.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, activeLeagueId } from "../src/db/db.ts";
import { resolveFormat } from "../src/data/formatResolve.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { dataPath } from "../src/data/paths.ts";

const season = Number(process.argv[2] ?? 2025);
// WHICH LEAGUE / WHICH FORMAT (WP3/F-6). This used to hardcode `"sc-a845f67652fb"` and `"129048"`:
// the directory name was a literal in a source file, so nothing could tell a model of a LEAGUE from a
// model of a typo, and a re-key would have left five scripts reading a directory that no longer
// exists. `resolveFormat` derives the key from the league's stored scoring and verifies the
// directory's `scoring.json` preimage before handing back a path.
//   --league <id>   (default: the store's one league whose format is NOT the incumbent)
function formatArg(db) {
  const i = process.argv.indexOf("--league");
  if (i >= 0) return resolveFormat(db, process.argv[i + 1]);
  const rows = db.prepare("SELECT league_id FROM league ORDER BY league_id").all();
  const nonIncumbent = rows.map((r) => String(r.league_id))
    .map((id) => { try { return resolveFormat(db, id); } catch { return null; } })
    .filter((f) => f && f.provenance === "format-dir");
  if (nonIncumbent.length === 1) return nonIncumbent[0];
  throw new Error(`pass --league <id>: this store has ${nonIncumbent.length} leagues on a built ` +
    `non-incumbent format (${rows.map((r) => r.league_id).join(", ")} exist), so there is no unambiguous default.`);
}

const mainDb = openDb();
const FMT = formatArg(mainDb);
const INCUMBENT = resolveFormat(mainDb, activeLeagueId(mainDb));
mainDb.close();

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
serve(`${FMT.scoringKey} artifact vs its features.db`, FMT.model.require("projection"), FMT.model.require("features-db"));
serve(`${INCUMBENT.scoringKey} artifact (incumbent) vs the main store`, INCUMBENT.model.require("projection"), INCUMBENT.model.require("features-db"));
