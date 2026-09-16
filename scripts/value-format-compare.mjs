// Layer 2 payoff: our-model VALUE (VOR -> $) under each format, side by side. The Yahoo artifact +
// Yahoo config (superflex, 12-team, PPR) should value QBs FAR higher than the ESPN artifact + ESPN
// config (1 QB, 16-team, half-PPR) -- the same players, the superflex edge made concrete.
// VOR/$ ordering is format-correct regardless of auction vs snake (the $ scale is auction-specific).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, getConfig } from "../src/db/db.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines } from "../src/draft/values.ts";
import { dataPath } from "../src/data/paths.ts";

const season = Number(process.argv[2] ?? 2025);
const fmtDir = dataPath(join("formats", "sc-a845f67652fb"));

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

run("YAHOO (our model, superflex)", join(fmtDir, "projection-artifact.json"), join(fmtDir, "features.db"), "129048");
run("ESPN (our model, 1-QB half-PPR)", dataPath("projection-artifact.json"), dataPath("ff.db"), "462233");
