// TEST 2 (above-market on our players) + scoring-robust percentile re-rank + TEST 3 (concentration).
// Reads scratch-teams.json written by audit-selfref.mjs.
//   node --import tsx scripts/audit-market.mjs
import { readFileSync } from "node:fs";
import { optimalLineup } from "../src/inseason/lineup.ts";
const { rosters } = JSON.parse(readFileSync("scratch-teams.json", "utf8"));
const MY = "8";
const teams = rosters.map(([tid, r]) => ({ tid, abbrev: r.abbrev, players: r.players }));
const allPlayers = teams.flatMap((t) => t.players.map((p) => ({ ...p, tid: t.tid })));

// --- positional percentile within the OWNED pool, per source (scoring-format robust) ---
// value semantics: ourProj/ff higher=better; ecr/adp lower=better (invert).
const SRC = {
  ourProj: { get: (p) => p.ourProj, better: "high" },
  ff: { get: (p) => p.ff, better: "high" },
  ecr: { get: (p) => p.ecr, better: "low" },
  adp: { get: (p) => p.adp, better: "low" },
};
const pct = {}; // src -> Map(pid -> percentile 0..100 within his position)
for (const [name, s] of Object.entries(SRC)) {
  const m = new Map();
  const byPos = {};
  for (const p of allPlayers) { const v = s.get(p); if (v == null) continue; (byPos[p.pos] ??= []).push({ pid: p.pid, v }); }
  for (const list of Object.values(byPos)) {
    list.sort((a, b) => s.better === "high" ? a.v - b.v : b.v - a.v); // ascending in "worse->better"
    list.forEach((x, i) => m.set(x.pid, list.length === 1 ? 100 : (i / (list.length - 1)) * 100));
  }
  pct[name] = m;
}

console.log("############ TEST 2: ARE WE PROJECTED ABOVE MARKET ON OUR OWN PLAYERS? ############");
console.log("(positional percentile within the 16-team owned pool; delta = OUR pct - INDEP pct; +delta = our projector likes him MORE than the market)\n");
function teamDeltas(tid, indep) {
  const ps = allPlayers.filter((p) => p.tid === tid && pct.ourProj.has(p.pid) && pct[indep].has(p.pid));
  return ps.map((p) => ({ name: p.name, pos: p.pos, our: pct.ourProj.get(p.pid), ind: pct[indep].get(p.pid), d: pct.ourProj.get(p.pid) - pct[indep].get(p.pid) }));
}
for (const indep of ["ff", "ecr", "adp"]) {
  const usD = teamDeltas(MY, indep);
  const fieldD = teams.filter((t) => t.tid !== MY).flatMap((t) => teamDeltas(t.tid, indep));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.log(`--- vs ${indep.toUpperCase()} ---`);
  console.log(`  8==3 mean delta: ${mean(usD.map((x) => x.d)).toFixed(1)} pctpts (n=${usD.length})   FIELD mean delta: ${mean(fieldD.map((x) => x.d)).toFixed(1)} (n=${fieldD.length})`);
  console.log(`  8==3 players above market by >15pct: ${usD.filter((x) => x.d > 15).map((x) => `${x.name}(${x.pos} +${x.d.toFixed(0)})`).join(", ") || "none"}`);
  console.log(`  8==3 players below market by >15pct: ${usD.filter((x) => x.d < -15).map((x) => `${x.name}(${x.pos} ${x.d.toFixed(0)})`).join(", ") || "none"}`);
}

// --- scoring-robust re-rank: sum of best-6-skill positional percentiles under each source ---
console.log("\n############ SCORING-ROBUST RE-RANK: sum of best-6-skill positional percentiles ############");
const SKILL = ["QB", "RB", "WR", "TE", "FLEX", "FLEX"], FOK = ["RB", "WR", "TE"];
function pctLineupSum(players, src) {
  const rp = players.filter((p) => pct[src].has(p.pid)).map((p) => ({ name: p.name, pos: p.pos, proj: pct[src].get(p.pid), available: true }));
  return optimalLineup(rp, SKILL, FOK).starters.reduce((a, s) => a + s.proj, 0);
}
for (const src of ["ourProj", "ff", "ecr", "adp"]) {
  const rows = teams.map((t) => ({ abbrev: t.abbrev, us: t.tid === MY, s: pctLineupSum(t.players, src) })).sort((a, b) => b.s - a.s);
  const ui = rows.findIndex((r) => r.us);
  console.log(`  ${src.padEnd(8)}: 8==3 rank #${ui + 1} (score ${rows[ui].s.toFixed(0)}); top4: ${rows.slice(0, 4).map((r) => `${r.abbrev}${r.us ? "*" : ""} ${r.s.toFixed(0)}`).join(", ")}`);
}

// --- TEST 3: concentration / sensitivity (drop 8==3 top-1, top-2 starters, re-rank by our full startPts) ---
console.log("\n############ TEST 3: CONCENTRATION (drop our top projected starter(s), re-rank by OUR projector) ############");
const FULL = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K"];
function ourStart(players, dropNames = []) {
  const rp = players.filter((p) => !dropNames.includes(p.name)).map((p) => ({ name: p.name, pos: p.pos, proj: p.ourProj, available: true }));
  return optimalLineup(rp, FULL, FOK).starters.reduce((a, s) => a + s.proj, 0);
}
const others = teams.filter((t) => t.tid !== MY).map((t) => ({ abbrev: t.abbrev, s: ourStart(t.players) }));
const us = teams.find((t) => t.tid === MY);
// our top starters by ourProj
const usStarters = optimalLineup(us.players.map((p) => ({ name: p.name, pos: p.pos, proj: p.ourProj, available: true })), FULL, FOK)
  .starters.filter((s) => s.name !== "(empty)").sort((a, b) => b.proj - a.proj);
console.log(`  8==3 starters by our proj: ${usStarters.map((s) => `${s.name}(${s.pos} ${s.proj.toFixed(0)})`).join(", ")}`);
for (const drop of [[], [usStarters[0].name], [usStarters[0].name, usStarters[1].name]]) {
  const usScore = ourStart(us.players, drop);
  const rank = 1 + others.filter((o) => o.s > usScore).length;
  console.log(`  drop [${drop.join(", ") || "none"}]: 8==3 startPts ${usScore.toFixed(0)} -> rank #${rank} of 16`);
}
