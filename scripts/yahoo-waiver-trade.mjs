// THE CULMINATION: our-model Yahoo waiver/trade analysis. Our Yahoo projector + superflex VOR value
// my roster and the live FA pool on the SAME format-native scale, then: optimal superflex lineup,
// weakest startable slots, FA upgrades, and the QB-surplus trade angle.
// Full-season preseason value; weeks 1-2 not yet folded in (D18 ROS blend is the refinement).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, getConfig } from "../src/db/db.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines, nameKey, slotEligibility } from "../src/draft/values.ts";
import { dataPath } from "../src/data/paths.ts";

const season = 2026;
const fmtDir = dataPath(join("formats", "sc-a845f67652fb"));
const MY_ROSTER = ["Jared Goff", "Joe Burrow", "Tyler Shough", "Omarion Hampton", "Chase Brown",
  "Jacory Croskey-Merritt", "Tyjae Spears", "Mike Washington", "Emmett Johnson", "Garrett Wilson",
  "Jameson Williams", "Carnell Tate", "Makai Lemon", "Omar Cooper", "Chris Bell", "Kyle Pitts",
  "Michael Mayer", "Isiah Pacheco"];

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
for (const v of vals) { const p = points.find((x) => x.name === v.name); byKey.set(nameKey(v.name), { ...v, points: p?.points ?? 0 }); }
const look = (n) => byKey.get(nameKey(n)) ?? { value: 1, pos: "?", valuePos: "?", points: 0 };

// --- optimal superflex lineup from my roster (greedy by value into eligibility-typed slots) --------
const starterSlots = cfg.slots.filter((s) => !/^(BE|IR|ER)$/i.test(s)).map((s) => ({ slot: s, elig: new Set(slotEligibility(s)) }))
  .sort((a, b) => a.elig.size - b.elig.size);        // fill dedicated first, superflex last
const mine = MY_ROSTER.map((n) => ({ name: n, ...look(n) })).sort((a, b) => b.value - a.value);
const filled = []; const used = new Set();
for (const slot of starterSlots) {
  const pick = mine.find((m) => !used.has(m.name) && slot.elig.has(m.pos));
  if (pick) { used.add(pick.name); filled.push({ slot: slot.slot, ...pick }); }
  else filled.push({ slot: slot.slot, name: "(empty)", value: 0, pos: "-" });
}
const bench = mine.filter((m) => !used.has(m.name));

console.log(`OUR-MODEL Yahoo (129048) waiver/trade analysis -- ${season}, superflex/PPR`);
console.log(`Replacement baselines (pts): QB ${base.QB?.toFixed(0)} RB ${base.RB?.toFixed(0)} WR ${base.WR?.toFixed(0)} TE ${base.TE?.toFixed(0)}\n`);
console.log(`=== MY OPTIMAL STARTING LINEUP (our value) ===`);
for (const f of filled) console.log(`  ${f.slot.padEnd(9)} $${String(f.value).padStart(3)}  ${(f.pos ?? "-").padEnd(3)} ${f.name}`);
const startVals = filled.filter((f) => f.value > 0).map((f) => f.value);
const weakest = Math.min(...startVals);
console.log(`  --> weakest startable value: $${weakest}`);
console.log(`\n  BENCH: ${bench.map((b) => `${b.name} $${b.value}(${b.pos})`).join(", ")}`);

// --- FA pool overlaid with our value ------------------------------------------------------------
const fa = JSON.parse(readFileSync(join(fmtDir, "fa-pool.json"), "utf8"));
const faVals = [];
for (const f of fa) { const v = byKey.get(nameKey(f.name)); if (v) faVals.push({ name: f.name, pos: v.valuePos ?? v.pos, value: v.value, points: v.points }); }
const seen = new Set(); const faUniq = faVals.filter((f) => (seen.has(nameKey(f.name)) ? false : seen.add(nameKey(f.name))));
faUniq.sort((a, b) => b.value - a.value);
console.log(`\n=== BEST AVAILABLE (our value), of ${fa.length} FAs scraped ===`);
for (const f of faUniq.slice(0, 15)) {
  const up = f.value > weakest ? `  <-- UPGRADE over $${weakest} flex` : "";
  console.log(`  $${String(f.value).padStart(3)}  ${f.pos.padEnd(3)} ${f.name.padEnd(24)} ${f.points.toFixed(0)}pt${up}`);
}
const upgrades = faUniq.filter((f) => f.value > weakest);
console.log(`\n  ${upgrades.length} FA(s) beat my weakest startable slot ($${weakest}).`);
