// HOW MUCH CAN THE KICKER AND DEFENSE ACTUALLY SWING A SEASON?
//
//   node --import tsx scripts/kdst-leverage.mjs [trials]
//
// The received wisdom is that K and DST barely matter and should be drafted last. The received
// wisdom is an argument about DRAFT COST, and it is being used here to answer a different question:
// how much title probability sits between the best and worst plausible occupant of those two slots.
// Those are not the same quantity and the second one is measurable, so measure it.
//
// The method is a SPREAD, not a point estimate. For each position, hold the rest of the roster
// fixed and swap that slot through the best, median and worst realistically-available option, then
// report the range of title probability that results. A position whose whole range is narrower than
// the simulator's own noise cannot make or break anything, whatever it feels like in week 14. A
// position with a wide range deserves modelling effort in proportion.
//
// Every position is measured the same way in the same run, so the K and DST numbers land next to an
// RB and WR number produced under identical conditions -- which is the only way to know whether a
// spread is large.
import { loadSimContext } from "../src/draft/simContext.ts";

const TRIALS = Number(process.argv[2] ?? 3000);
const SEEDS = [7, 101, 202, 303];

const ctx = await loadSimContext();
const { teams, meIdx, board } = ctx;
const run = (t, seed) => 100 * ctx.run(t, TRIALS, seed)[meIdx].champion;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Who is actually gettable. A "best available" that is on another roster is not an option we have,
// and measuring against it would overstate the swing at every position equally.
const owned = new Set();
for (const t of teams) for (const p of t.roster) owned.add(p.name);

const byPos = new Map();
for (const p of board.values()) {
  if (!byPos.has(p.pos)) byPos.set(p.pos, []);
  byPos.get(p.pos).push(p);
}
for (const list of byPos.values()) list.sort((a, b) => b.proj - a.proj);

const baseBySeed = SEEDS.map((s) => run(teams, s));
console.log(`K/DST LEVERAGE -- ${TRIALS} trials x ${SEEDS.length} seeds, shared sim context`);
console.log(`  BASE: ${mean(baseBySeed).toFixed(2)}% title\n`);
console.log(`  Swapping one slot through the best, median and worst FREE AGENT at that position,`);
console.log(`  holding everything else fixed. The spread is what that slot can be worth.\n`);
console.log("  pos    current           best FA          median FA        worst FA        SPREAD");

const rows = [];
for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
  const mine = teams[meIdx].roster.filter((p) => p.pos === pos);
  if (!mine.length) { console.log(`  ${pos}: none rostered`); continue; }
  const free = (byPos.get(pos) ?? []).filter((p) => !owned.has(p.name));
  if (free.length < 3) { console.log(`  ${pos}: fewer than 3 free agents on the board`); continue; }
  // Replace the WEAKEST rostered player at the position -- that is the slot actually in play.
  const target = mine.sort((a, b) => a.proj - b.proj)[0];
  const options = {
    best: free[0],
    median: free[Math.floor(free.length / 2)],
    worst: free[free.length - 1],
  };
  const got = {};
  for (const [label, p] of Object.entries(options)) {
    const vals = SEEDS.map((s) => {
      const t = ctx.clone();
      t[meIdx].roster = t[meIdx].roster.filter((x) => x.name !== target.name).concat([{ ...p }]);
      return run(t, s);
    });
    got[label] = { m: mean(vals), se: sd(vals) / Math.sqrt(SEEDS.length) };
  }
  const spread = got.best.m - got.worst.m;
  rows.push({ pos, target, options, got, spread });
  console.log(
    `  ${pos.padEnd(5)} ${mean(baseBySeed).toFixed(2)}%           ` +
    `${got.best.m.toFixed(2)}%  ${got.median.m.toFixed(2)}%  ${got.worst.m.toFixed(2)}%  ` +
    `${spread.toFixed(2)}pp`.padStart(10),
  );
}

// The comparison that decides whether any of it means anything.
const noise = mean(rows.map((r) => r.got.best.se + r.got.worst.se));
console.log(`\n  Simulator noise on a single arm is about +/-${(noise / 2).toFixed(2)}pp, so a spread`);
console.log(`  under roughly ${noise.toFixed(2)}pp is indistinguishable from measuring nothing.\n`);
// Best-vs-worst overstates a slot whose worst option nobody would ever roster, and it is not equally
// skewed across positions -- the worst free-agent kicker is a real kicker, while the worst free-agent
// receiver is a name on a page. Best-vs-MEDIAN compares two options a manager might actually face and
// is the fairer cross-position number, so report both and rank on the realistic one.
rows.forEach((r) => { r.realistic = r.got.best.m - r.got.median.m; });
rows.sort((a, b) => b.realistic - a.realistic);
console.log("  ranked by how much the slot can swing (best vs MEDIAN available -- the realistic range):");
for (const r of rows) {
  const verdict = r.realistic > 2 * noise ? "REAL and large" : r.realistic > noise ? "real but modest" : "below noise";
  console.log(`    ${r.pos.padEnd(5)} ${r.realistic.toFixed(2)}pp realistic / ${r.spread.toFixed(2)}pp best-to-worst  -- ${verdict}` +
    `   (best: ${r.options.best.name.slice(0, 20)})`);
}
console.log(`
  Read this as a BUDGET, not a verdict on the positions. A slot with a wide spread is worth
  modelling carefully and worth spending a waiver claim on; a slot whose spread is under the noise
  floor cannot be made to matter by projecting it better, because the range of outcomes it controls
  is smaller than the uncertainty in the answer.`);
