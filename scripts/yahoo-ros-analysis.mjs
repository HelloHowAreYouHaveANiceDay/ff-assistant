// STEP 4: our-model Yahoo waiver/trade analysis on REST-OF-SEASON value (D18 blend, retargeted).
// Each player's ROS per-week = (K*line + k*rate)/(K+k) via the shipped rosPerGame, with line = our
// Yahoo preseason projection/17 and rate = to-date Yahoo points/weeks played. K=6 (data/ros-blend.json,
// an NFL-level stabilization constant; refitting on Yahoo scoring is a minor follow-up). Then VOR under
// the Yahoo superflex config on ROS totals. Only week 1 is final, so the update is deliberately modest.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, getConfig } from "../src/db/db.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines, nameKey, slotEligibility } from "../src/draft/values.ts";
import { rosPerGame, loadRosBlend } from "../src/draft/rosBlend.ts";
import { dataPath } from "../src/data/paths.ts";

const fmtDir = dataPath(join("formats", "sc-a845f67652fb"));
const MY_ROSTER = ["Jared Goff", "Joe Burrow", "Tyler Shough", "Omarion Hampton", "Chase Brown",
  "Jacory Croskey-Merritt", "Tyjae Spears", "Mike Washington", "Emmett Johnson", "Garrett Wilson",
  "Jameson Williams", "Carnell Tate", "Makai Lemon", "Omar Cooper", "Chris Bell", "Kyle Pitts",
  "Michael Mayer", "Isiah Pacheco"];

const { blend, source } = loadRosBlend();
const K = blend.K;

// --- preseason projection (the line) ---
const db = openDb(join(fmtDir, "features.db"));
const cfg = getConfig(db, "129048");
const art = loadArtifact(JSON.parse(readFileSync(join(fmtDir, "projection-artifact.json"), "utf8")), { checkGolden: true });
const proj = boardProjection(db, 2026, art).filter((r) => r.mean > 0);
db.close();

// --- to-date 2026 Yahoo points + weeks played, from the weekly target ---
const wk = readFileSync(join(fmtDir, "history-weekly.csv"), "utf8").trim().split("\n").slice(1);
const td = new Map(); // nameKey -> {pts, games}
let maxWk = 0;
for (const l of wk) { const c = l.split(","); if (+c[0] !== 2026) continue; const k = nameKey(c[1]); const a = td.get(k) ?? { pts: 0, games: 0 }; a.pts += +c[4]; a.games++; td.set(k, a); maxWk = Math.max(maxWk, +c[3]); }
const REMAINING = 17 - maxWk;   // scheduled weeks left after the last played week

// --- ROS totals: blend line/17 with the observed rate, spread over remaining weeks ---
const rosPoints = proj.map((r) => {
  const linePg = r.mean / 17;
  const a = td.get(nameKey(r.name));
  const pg = rosPerGame(linePg, a?.games ?? 0, a?.pts ?? null, K);
  return { name: r.name, pos: r.pos, points: (pg ?? linePg) * REMAINING, preseason: r.mean, wk1: a?.pts ?? null };
});

const lg = resolveValueLeague(cfg);
const base = baselines(rosPoints, lg);
const vals = computeValues(rosPoints, lg, cfg.levers?.maxKDst ?? 2);
const byKey = new Map();
for (const v of vals) { const p = rosPoints.find((x) => x.name === v.name); byKey.set(nameKey(v.name), { ...v, ...p }); }
const look = (n) => byKey.get(nameKey(n)) ?? { value: 1, pos: "?", valuePos: "?", points: 0, wk1: null };

console.log(`OUR-MODEL Yahoo ROS analysis (D18 blend K=${K}, ${source}; week ${maxWk} final, ${REMAINING} wks left)`);
console.log(`ROS replacement baselines (pts over ${REMAINING} wks): QB ${base.QB?.toFixed(0)} RB ${base.RB?.toFixed(0)} WR ${base.WR?.toFixed(0)} TE ${base.TE?.toFixed(0)}\n`);

// optimal superflex lineup
const slots = cfg.slots.filter((s) => !/^(BE|IR|ER)$/i.test(s)).map((s) => ({ slot: s, elig: new Set(slotEligibility(s)) })).sort((a, b) => a.elig.size - b.elig.size);
const mine = MY_ROSTER.map((n) => ({ name: n, ...look(n) })).sort((a, b) => b.value - a.value);
const used = new Set(); const filled = [];
for (const s of slots) { const p = mine.find((m) => !used.has(m.name) && s.elig.has(m.pos)); if (p) { used.add(p.name); filled.push({ slot: s.slot, ...p }); } else filled.push({ slot: s.slot, name: "(empty)", value: 0 }); }
console.log(`=== MY STARTING LINEUP (ROS value) ===`);
for (const f of filled) console.log(`  ${f.slot.padEnd(9)} $${String(f.value).padStart(3)}  ${(f.valuePos ?? f.pos ?? "-").padEnd(3)} ${f.name}`);
const weakest = Math.min(...filled.filter((f) => f.value > 0).map((f) => f.value));
console.log(`  weakest startable: $${weakest};  BENCH: ${mine.filter((m) => !used.has(m.name)).map((b) => `${b.name} $${b.value}`).join(", ")}`);

// FA overlay
const fa = JSON.parse(readFileSync(join(fmtDir, "fa-pool.json"), "utf8"));
const seen = new Set(); const faVals = [];
for (const f of fa) { const v = byKey.get(nameKey(f.name)); if (v && !seen.has(nameKey(f.name))) { seen.add(nameKey(f.name)); faVals.push(v); } }
faVals.sort((a, b) => b.value - a.value);
console.log(`\n=== BEST AVAILABLE (ROS value) ===`);
for (const f of faVals.slice(0, 12)) console.log(`  $${String(f.value).padStart(3)}  ${(f.valuePos ?? f.pos).padEnd(3)} ${f.name.padEnd(22)} ROS ${f.points.toFixed(0)}  wk1 ${f.wk1 == null ? "-" : f.wk1.toFixed(0)}  (pre ${f.preseason.toFixed(0)})${f.value > weakest ? "  <-- UPGRADE" : ""}`);
console.log(`\n  ${faVals.filter((f) => f.value > weakest).length} FA(s) beat weakest startable ($${weakest}).`);
