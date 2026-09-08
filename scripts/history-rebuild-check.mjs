// Did adding player_sk change any NUMBER in the history files?
//
//   node scripts/history-rebuild-check.mjs
//
// The rebuild that appended `player_sk` also moved history.ts onto the disk cache, so two things
// changed at once. This asserts the only acceptable answer: every (season, name) that appears in
// both files carries the SAME points to the tenth, and reports the count that does not rather than
// leaving the comparison to a glance at two row counts. Two files can have identical row counts and
// disagree everywhere.
import { readFileSync, existsSync } from "node:fs";

const load = (p, ncol) => {
  const m = new Map();
  for (const line of readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    m.set(f.slice(0, ncol).join("|"), f);
  }
  return m;
};

let bad = 0, checked = 0, onlyPrev = 0, onlyNew = 0;
const PREV = "data/history-points.prev.csv", NOW = "data/history-points.csv";
if (!existsSync(PREV)) { console.log(`${PREV} absent -- nothing to compare against`); process.exit(0); }
const prev = load(PREV, 3), now = load(NOW, 3);
for (const [k, f] of prev) {
  const g = now.get(k);
  if (!g) { onlyPrev++; continue; }
  checked++;
  if (Math.abs(Number(f[3]) - Number(g[3])) > 0.05) { bad++; if (bad <= 10) console.log(`  DIFF ${k}: ${f[3]} -> ${g[3]}`); }
}
for (const k of now.keys()) if (!prev.has(k)) onlyNew++;
console.log(`history-points: ${checked} shared (season,name,pos) rows compared; ${bad} differ by more than 0.05`);
console.log(`  only in previous: ${onlyPrev}   only in rebuilt: ${onlyNew}`);

// player_sk coverage, sliced the way the acceptance bar is stated.
const SKILL = new Set(["QB", "RB", "WR", "TE"]);
let sk = 0, tot = 0, skAll = 0, totAll = 0;
for (const f of now.values()) {
  const yr = Number(f[0]);
  totAll++; if (f[4]) skAll++;
  if (!SKILL.has(f[2]) || yr < 2010 || yr > 2025) continue;
  tot++; if (f[4]) sk++;
}
console.log(`player_sk on skill positions 2010-2025: ${sk}/${tot} = ${((sk / tot) * 100).toFixed(2)}%`);
console.log(`player_sk on every row 1999-2025:        ${skAll}/${totAll} = ${((skAll / totAll) * 100).toFixed(2)}%`);

// Same check on the weekly file, which is what the trajectory pools are built from.
const PREVW = "data/history-weekly.prev.csv";
if (existsSync(PREVW)) {
  const pw = load(PREVW, 4), nw = load("data/history-weekly.csv", 4);
  let b = 0, c = 0;
  for (const [k, f] of pw) { const g = nw.get(k); if (!g) continue; c++; if (Math.abs(Number(f[4]) - Number(g[4])) > 0.05) b++; }
  console.log(`history-weekly: ${c} shared rows compared; ${b} differ by more than 0.05`);
}
if (bad > 0) process.exitCode = 1;
