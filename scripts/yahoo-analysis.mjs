// OUR-MODEL Yahoo values for a season: serve the Yahoo projector + superflex VOR, index by nameKey,
// and report my roster's values + the overall board. Part A of the waiver/trade analysis (FA overlay
// is applied by the caller that passes a free-agent list). Full-season value (preseason projection);
// weeks 1-2 are not yet folded in (that is the D18 ROS refinement).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, getConfig } from "../src/db/db.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines, nameKey } from "../src/draft/values.ts";
import { dataPath } from "../src/data/paths.ts";

const season = Number(process.argv[2] ?? 2026);
const fmtDir = dataPath(join("formats", "sc-a845f67652fb"));

const MY_ROSTER = [
  ["Jared Goff", "BN?"], ["Joe Burrow", "BN?"], ["Tyler Shough", "BN"],
  ["Omarion Hampton", "RB"], ["Chase Brown", "RB"], ["Jacory Croskey-Merritt", "FLEX"],
  ["Tyjae Spears", "BN"], ["Mike Washington", "BN"], ["Emmett Johnson", "BN"],
  ["Garrett Wilson", "WR"], ["Jameson Williams", "WR"], ["Carnell Tate", "FLEX"],
  ["Makai Lemon", "BN"], ["Omar Cooper", "BN"], ["Chris Bell", "BN"],
  ["Kyle Pitts", "TE"], ["Michael Mayer", "FLEX"], ["Isiah Pacheco", "IR"],
];

const db = openDb(join(fmtDir, "features.db"));
const cfg = getConfig(db, "129048");
const art = loadArtifact(JSON.parse(readFileSync(join(fmtDir, "projection-artifact.json"), "utf8")), { checkGolden: true });
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

console.log(`OUR-MODEL Yahoo values, ${season} (superflex, PPR). Replacement baselines (pts):`);
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
