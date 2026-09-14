// THE WEEKLY PAIRED-SEASON FLOOR (Front A).
//
// docs/validation.md, WS1: the weekly track has NO paired-season floor like admit-feature/gate-variant
// -- its gate is the all-or-nothing pooled clause a/b/c, which cannot tell a real edge from noise the
// way the season arbiter's 2.9*SE season floor can. This builds one, on the SAME statistic the season
// track admits features on (scripts/lib/arbiter.mjs seasonEffect / admissionVerdict):
//
//   - The unit of analysis is the SEASON, not the row (CLAUDE.md). `ff evaluate-weekly` holds out one
//     season at a time and scores it, so bySeason[Y].weekly.crps is one matched point per season. The
//     two arms (baseline, candidate) see the SAME held-out rows and the SAME common-random-number
//     rosters, so the per-season CRPS delta is paired.
//   - The effect is the mean per-season improvement (base - cand; lower CRPS is better). The floor is
//     2.9*SE across seasons -- the smallest effect resolvable at ~80% power. A candidate is admitted
//     ONLY if it beats the floor, so a positive-but-sub-floor gain reads as the noise it is.
//   - SELECTION-BLIND: the admit/reject DECISION is made on the selection seasons only; the held-out
//     block (HOLDOUT_SEASONS, 2021-2025) is scored once as a separate CONFIRM number, so the choice is
//     not made on the seasons used to confirm it (WS2, the season track's discipline).
//
// USAGE:
//   node --import tsx scripts/weekly-paired-floor.mjs --baseline base.json --candidate cand.json
//        [--model weekly] [--holdout-seasons 2021-2025]
// where base.json / cand.json are `ff evaluate-weekly --json` outputs.
import { readFileSync } from "node:fs";
import { admissionVerdict, seasonEffect } from "./lib/arbiter.mjs";
import { HOLDOUT_SEASONS } from "./lib/holdout.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const basePath = val("--baseline", null);
const candPath = val("--candidate", null);
const model = val("--model", "weekly");
if (!basePath || !candPath) { console.error("usage: --baseline <json> --candidate <json> [--model weekly]"); process.exit(1); }
const holdoutSpec = val("--holdout-seasons", null);
const holdout = new Set(holdoutSpec
  ? (() => { const [a, b] = holdoutSpec.split("-").map(Number); const o = []; for (let y = a; y <= (b ?? a); y++) o.push(y); return o; })()
  : HOLDOUT_SEASONS);

const base = JSON.parse(readFileSync(basePath, "utf8"));
const cand = JSON.parse(readFileSync(candPath, "utf8"));

/** Map<season, pooled CRPS of `model`> from an eval JSON's bySeason block. */
function crpsBySeason(ev) {
  const m = new Map();
  for (const [y, byModel] of Object.entries(ev.bySeason ?? {})) {
    const s = byModel?.[model];
    if (s && Number.isFinite(s.crps)) m.set(Number(y), s.crps);
  }
  return m;
}
const baseM = crpsBySeason(base), candM = crpsBySeason(cand);
const seasons = [...baseM.keys()].filter((y) => candM.has(y)).sort((a, b) => a - b);
if (seasons.length < 3) { console.error(`only ${seasons.length} shared seasons -- need >=3 for a season floor`); process.exit(1); }

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "NA");
console.log(`WEEKLY PAIRED-SEASON FLOOR -- model "${model}", metric pooled CRPS (lower is better)`);
console.log(`  baseline: ${basePath}`);
console.log(`  candidate: ${candPath}`);
console.log(`  ${seasons.length} shared held-out seasons: ${seasons.join(", ")}`);
console.log("\n  per-season pooled CRPS (base -> cand, improvement = base - cand):");
for (const y of seasons) {
  const b = baseM.get(y), c = candM.get(y), d = b - c;
  console.log(`    ${y}  ${fmt(b)} -> ${fmt(c)}   ${d >= 0 ? "+" : ""}${fmt(d)}${holdout.has(y) ? "   (holdout)" : ""}`);
}

function report(label, ys) {
  if (ys.length < 3) { console.log(`\n  ${label}: only ${ys.length} seasons, skipped`); return null; }
  const v = admissionVerdict(candM, baseM, ys);
  console.log(`\n  ${label} (${ys.length} seasons: ${ys.join(", ")})`);
  console.log(`    improvement (base - cand):  ${fmt(v.improvement, 5)} CRPS`);
  console.log(`    SE across seasons:          ${fmt(v.se, 5)}`);
  console.log(`    2.9*SE floor:               ${fmt(v.floor, 5)}`);
  console.log(`    season bootstrap 95% CI:    [${fmt(v.ciLo, 5)}, ${fmt(v.ciHi, 5)}]`);
  console.log(`    wins/losses across seasons: ${v.wins}/${v.losses}`);
  console.log(`    VERDICT: ${v.pass ? "ADMIT -- improvement clears 2.9*SE" : "REJECT -- within the floor (noise) or negative"}`);
  return v;
}

const selection = seasons.filter((y) => !holdout.has(y));
const held = seasons.filter((y) => holdout.has(y));
report("ALL SEASONS", seasons);
report("SELECTION (the decision)", selection);
report("HOLDOUT CONFIRM", held);
