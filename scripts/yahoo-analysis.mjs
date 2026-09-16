// OUR-MODEL Yahoo values for a season: serve the Yahoo projector + superflex VOR, index by nameKey,
// and report my roster's values + the overall board. Part A of the waiver/trade analysis (FA overlay
// is applied by the caller that passes a free-agent list). Full-season value (preseason projection);
// weeks 1-2 are not yet folded in (that is the D18 ROS refinement).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { resolveFormat } from "../src/data/formatResolve.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines, nameKey } from "../src/draft/values.ts";
import { dataPath } from "../src/data/paths.ts";

const season = Number(process.argv[2] ?? 2026);
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
const LEAGUE = FMT.leagueId;
const cfg = resolveLeagueContext(mainDb, LEAGUE).config;
mainDb.close();

const MY_ROSTER = [
  ["Jared Goff", "BN?"], ["Joe Burrow", "BN?"], ["Tyler Shough", "BN"],
  ["Omarion Hampton", "RB"], ["Chase Brown", "RB"], ["Jacory Croskey-Merritt", "FLEX"],
  ["Tyjae Spears", "BN"], ["Mike Washington", "BN"], ["Emmett Johnson", "BN"],
  ["Garrett Wilson", "WR"], ["Jameson Williams", "WR"], ["Carnell Tate", "FLEX"],
  ["Makai Lemon", "BN"], ["Omar Cooper", "BN"], ["Chris Bell", "BN"],
  ["Kyle Pitts", "TE"], ["Michael Mayer", "FLEX"], ["Isiah Pacheco", "IR"],
];

const db = openDb(FMT.model.require("features-db"));
const art = loadArtifact(JSON.parse(readFileSync(FMT.model.require("projection"), "utf8")), { checkGolden: true });
const proj = boardProjection(db, season, art).filter((r) => r.mean > 0);
db.close();

const lg = resolveValueLeague(cfg);
const points = proj.map((r) => ({ name: r.name, pos: r.pos, points: r.mean }));
const base = baselines(points, lg);
const vals = computeValues(points, lg, cfg.levers?.maxKDst ?? 2);
const byKey = new Map();
for (const v of vals) {
  const p = points.find((x) => x.name === v.name);
  byKey.set(nameKey(v.name), { ...v, points: p?.points ?? 0, vor: Math.max(0, (p?.points ?? 0) - (base[v.valuePos ?? v.pos] ?? 0)) });
}

console.log(`OUR-MODEL values for league ${LEAGUE}, format ${FMT.scoringKey} (value key ${FMT.valueKey}), ${season}. Replacement baselines (pts):`);
console.log(`  ${["QB", "RB", "WR", "TE"].map((p) => `${p} ${base[p]?.toFixed(0)}`).join("  ")}`);

console.log(`\n=== MY ROSTER (our value) ===`);
const mine = [];
for (const [name] of MY_ROSTER) {
  const v = byKey.get(nameKey(name));
  mine.push({ name, ...(v ?? {}) });
}
mine.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
for (const m of mine) {
  console.log(`  $${String(m.value ?? "?").padStart(3)}  ${(m.valuePos ?? m.pos ?? "?").padEnd(4)} ${m.name.padEnd(24)} ${m.points ? `${m.points.toFixed(0)}pt vor ${m.vor.toFixed(0)}` : "(no projection)"}`);
}

console.log(`\n=== TOP 24 OVERALL (our value) ===`);
for (const v of vals.slice(0, 24)) console.log(`  $${String(v.value).padStart(3)}  ${(v.valuePos ?? v.pos).padEnd(4)} ${v.name}`);
