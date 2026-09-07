// Does the rank-joined bootstrap preserve what our projections say?
//
//   node --import tsx scripts/bootstrap-calibration.mjs
//
// The bootstrap joins on RANK, so it keeps our projection ORDERING and discards our projection
// MAGNITUDES -- a player we project at 300 pts is scored from the historical record of players who
// entered a season at his rank, whatever that record says. That is mostly a feature (the historical
// record already prices injury and bust risk, which a projection does not), but it has to be checked
// rather than assumed, because two failure modes would both be invisible in the odds table:
//   1. a LEVEL shift -- if pool means sit far below projections, every team's total drops and the
//      simulator is answering about a lower-scoring league than the one being played
//   2. COMPRESSION -- if the pool means are flatter than the projections, good and bad rosters are
//      pulled together, which would inflate a mid-pack team's playoff odds for no real reason
import { readFileSync } from "node:fs";

const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];

// our projections, ranked within position
const byPos = {};
for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const f = line.split(",");
  if (!f[0] || !f[2]) continue;
  const pos = f[1].trim().toUpperCase();
  if (!POS.includes(pos)) continue;
  (byPos[pos] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log("projection (per game) vs BOOTSTRAP POOL MEAN, by positional rank");
console.log("a healthy result: pool below projection (projections ignore injury), and the SPREAD");
console.log("between rank 1 and rank 24 preserved rather than flattened\n");
console.log("  pos  rank   ourProj/gm   poolMean   ratio");
const ratios = [];
for (const pos of POS) {
  const list = (byPos[pos] ?? []).sort((a, b) => b.pts - a.pts);
  const pools = outcomes.pos[pos] ?? {};
  for (const r of [1, 6, 12, 24]) {
    const p = list[r - 1];
    const pool = pools[String(r)];
    if (!p || !pool) continue;
    const proj = p.pts / 17, pm = mean(pool);
    ratios.push(pm / proj);
    console.log(`  ${pos.padEnd(4)} ${String(r).padStart(4)}   ${proj.toFixed(1).padStart(10)} ${pm.toFixed(1).padStart(10)}   ${(pm / proj).toFixed(2)}`);
  }
}
console.log(`\n  mean ratio across all sampled ranks: ${mean(ratios).toFixed(2)}`);

// --- compression check ---------------------------------------------------------------------------
// Compare the rank1 -> rank24 DROP in our projections against the same drop in the pools. If the
// pools are much flatter, the simulator is quietly erasing the difference between rosters.
console.log(`\nSPREAD PRESERVATION -- drop from rank 1 to rank 24, ours vs the pools`);
console.log("  pos    ourDrop   poolDrop   preserved");
for (const pos of POS) {
  const list = (byPos[pos] ?? []).sort((a, b) => b.pts - a.pts);
  const pools = outcomes.pos[pos] ?? {};
  const a = list[0], b = list[23];
  const pa = pools["1"], pb = pools["24"];
  if (!a || !b || !pa || !pb) continue;
  const ourDrop = (a.pts - b.pts) / 17;
  const poolDrop = mean(pa) - mean(pb);
  console.log(`  ${pos.padEnd(4)} ${ourDrop.toFixed(1).padStart(9)} ${poolDrop.toFixed(1).padStart(10)}   ${(poolDrop / ourDrop).toFixed(2)}`);
}
console.log(`\n  "preserved" near 1.0 means the pools separate players as much as our board does.`);
console.log(`  Well below 1.0 means COMPRESSION: the sim would flatten the field and inflate a`);
console.log(`  mid-pack team's odds. Well above 1.0 means the sim exaggerates our own board.`);
