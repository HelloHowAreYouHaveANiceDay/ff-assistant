// Layer 2 payoff: our-model VALUE (VOR -> $) under each format, side by side. The Yahoo artifact +
// Yahoo config (superflex, 12-team, PPR) should value QBs FAR higher than the ESPN artifact + ESPN
// config (1 QB, 16-team, half-PPR) -- the same players, the superflex edge made concrete.
// VOR/$ ordering is format-correct regardless of auction vs snake (the $ scale is auction-specific).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, getConfig, activeLeagueId } from "../src/db/db.ts";
import { resolveFormat } from "../src/data/formatResolve.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines } from "../src/draft/values.ts";
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

function run(label, artifactPath, dbPath, leagueId) {
  const db = openDb(dbPath);
  const cfg = getConfig(db, leagueId);
  const art = loadArtifact(JSON.parse(readFileSync(artifactPath, "utf8")), { checkGolden: true });
  const proj = boardProjection(db, season, art).filter((r) => r.mean > 0);
  db.close();
  const lg = resolveValueLeague(cfg);
  const points = proj.map((r) => ({ name: r.name, pos: r.pos, points: r.mean }));
  const base = baselines(points, lg);
  const vals = computeValues(points, lg, cfg.levers?.maxKDst ?? 2).filter((v) => v.pos !== "K" && v.pos !== "DST");
  const top = vals.slice(0, 20);
  const mix = {}; for (const v of vals.slice(0, 24)) mix[v.pos] = (mix[v.pos] ?? 0) + 1;
  const topQB = vals.filter((v) => v.pos === "QB")[0];
  console.log(`\n=== ${label} (league ${leagueId}, ${cfg.teams}-team, project ${season}) ===`);
  console.log(`  slots: ${JSON.stringify(cfg.slots.filter((s) => !/^(BE|IR|ER)$/i.test(s)))}`);
  console.log(`  QB replacement baseline: ${base.QB?.toFixed(1)} pts   top-QB value: $${topQB?.value} (${topQB?.name})`);
  console.log(`  top-24 value mix: ${Object.entries(mix).map(([p, n]) => `${p}:${n}`).join(" ")}`);
  console.log(`  top 12 by value:`);
  for (const v of top.slice(0, 12)) console.log(`    $${String(v.value).padStart(3)}  ${v.pos.padEnd(3)} ${v.name}`);
  return { base, vals };
}

run(`CHALLENGER format ${FMT.scoringKey}`, FMT.model.require("projection"), FMT.model.require("features-db"), FMT.leagueId);
run(`INCUMBENT format ${INCUMBENT.scoringKey}`, INCUMBENT.model.require("projection"), INCUMBENT.model.require("features-db"), INCUMBENT.leagueId);
