// EVERY PLAUSIBLE WAIVER CLAIM, SCORED ON TITLE ODDS.
//
//   node --import tsx scripts/waiver-sweep.mjs [trials] [--top 30]
//
// The two tools either side of this one answer different questions. waiver-targets ranks free agents
// by what they add to the LINEUP, which is fast and is the right screen but cannot see a threshold
// payout or a bye collision. waiver-check scores one named add against every drop. Neither sweeps,
// so the actual question -- of everyone available, which claim is worth making, and at the cost of
// whom -- has been answered by hand.
//
// TWO THINGS THIS PRICES THAT A PROJECTION CANNOT.
//
// The DROP is half the decision and usually the worse-understood half. Our sixth receiver is worth
// almost nothing because he never starts; our second tight end is the only cover for a mandatory
// slot. Both look equally expendable on a projection list and they are not, which kdst-leverage
// already showed at K and DST.
//
// And a claim that leaves a slot unfillable is not a claim. Dropping the only kicker to roster a
// fourth back means you go and claim a kicker, not that you field nobody -- so those pairings are
// excluded by name rather than priced with a zero.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadSimContext } from "../src/draft/simContext.ts";
import { rosterGaps } from "../src/draft/season.ts";

const TRIALS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 2500);
const topArg = process.argv.indexOf("--top");
const TOP = topArg > -1 ? Number(process.argv[topArg + 1]) : 30;
const SEEDS = [7, 101];

const ctx = await loadSimContext();
const { teams, meIdx, board, slots, flexOk } = ctx;
const mine = teams[meIdx].roster;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const owned = new Set();
for (const t of teams) for (const p of t.roster) owned.add(p.name);

// --- who is even worth simulating ------------------------------------------------------------------
// Screening first is not an optimisation, it is what makes the sweep honest: simulating 300 free
// agents at this trial count would put the best of ~2,700 arms comfortably inside the noise floor by
// multiple comparisons alone. Take the players a lineup optimizer says could plausibly matter.
const free = [...board.values()].filter((p) => !owned.has(p.name) && p.proj > 0)
  .sort((a, b) => b.proj - a.proj);
const byPos = {};
for (const p of free) (byPos[p.pos] ??= []).push(p);
// Positional scarcity on OUR roster decides how deep to look: we start one RB and roster one, so the
// RB list is worth going deeper into than the WR list where we are six deep.
const need = {};
for (const s of slots) if (!["BE", "IR", "FLEX"].includes(s)) need[s] = (need[s] ?? 0) + 1;
const have = {};
for (const p of mine) have[p.pos] = (have[p.pos] ?? 0) + 1;
const cands = [];
for (const [pos, list] of Object.entries(byPos)) {
  const depth = (have[pos] ?? 0) - (need[pos] ?? 0);       // spare bodies at that position
  const take = depth <= 0 ? 12 : depth === 1 ? 8 : 5;
  cands.push(...list.slice(0, take));
}
cands.sort((a, b) => b.proj - a.proj);
const adds = cands.slice(0, TOP);

// --- which drops are legal, per add -----------------------------------------------------------------
const pairs = [], illegal = new Map();
for (const add of adds) {
  for (const drop of mine) {
    const after = mine.filter((p) => p.name !== drop.name).concat([add]);
    if (rosterGaps([{ id: "me", name: "us", roster: after }], slots, flexOk).length) {
      illegal.set(drop.name, drop.pos);
      continue;
    }
    pairs.push({ add, drop });
  }
}
console.log(`WAIVER SWEEP -- ${adds.length} free agents x legal drops = ${pairs.length} claims`);
console.log(`  ${TRIALS} trials x ${SEEDS.length} seeds each\n`);

const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
db.close();
const cfgPlayoffTeams = cfg.playoffTeams ?? 7;
const poolRank = new Map();
{
  const byPosPts = {};
  for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    if (!f[0] || !f[2]) continue;
    (byPosPts[f[1].trim().toUpperCase()] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
  }
  for (const l of Object.values(byPosPts)) { l.sort((a, b) => b.pts - a.pts); l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length })); }
}

const baseBySeed = SEEDS.map((s) => 100 * ctx.run(teams, TRIALS, s)[meIdx].champion);
const base = mean(baseBySeed);
// The error on a single delta at this trial count, stated before anything is ranked. The trade
// scanner reported eight structural findings that were all inside its own noise, so the floor goes
// on the page next to the numbers rather than in a footnote.
const noise = 1.4 * 100 * Math.sqrt((base / 100) * (1 - base / 100) / TRIALS);
console.log(`  BASE: ${base.toFixed(2)}% title -- a delta under about ${noise.toFixed(2)}pp is inside this run's noise\n`);

// PARALLEL. Run single-threaded this took ~6 seconds a claim, which is 22 minutes for a real sweep --
// slow enough that the honest version is the one nobody runs before the waiver deadline. The worker
// pool already existed for trades; it understood only two-team swaps, so it now also takes a WAIVER
// job (theirIdx -1, the free agent carried on the job itself).
const { runPool } = await import("../src/draft/simPool.ts");
const poolInit = {
  baseTeams: teams, weeks: ctx.weeks, slots, flexOk,
  playoffTeams: cfgPlayoffTeams, projSd: 0.30, poolRank,
  varianceModelPath: "data/variance-model.json",
  outcomesPath: "data/rank-outcomes.json",
  corrPath: "data/correlation-model.json",
};
const jobs = [];
for (const { add, drop } of pairs) {
  for (const sd of SEEDS) {
    jobs.push({
      idx: jobs.length, meIdx, theirIdx: -1,
      giveName: drop.name, getName: add.name,
      getPlayer: { name: add.name, pos: add.pos, proj: add.proj, team: add.team, bye: add.bye ?? null },
      trials: TRIALS, seed: sd,
    });
  }
}
const t0 = Date.now();
const out = await runPool(poolInit, jobs, {
  onProgress: (d, t) => { if (d % 100 === 0 || d === t) process.stderr.write(`  ${d}/${t} (${((Date.now() - t0) / d).toFixed(0)}ms each)\n`); },
});
const rows = [];
pairs.forEach(({ add, drop }, i) => {
  const d = SEEDS.map((_, k) => out[i * SEEDS.length + k].mine - baseBySeed[k]);
  rows.push({ add, drop, d: mean(d), spread: Math.abs(d[0] - d[1]) });
});
rows.sort((a, b) => b.d - a.d);

console.log("  BEST CLAIMS");
console.log("  add                   pos  proj   drop                  delta    seed spread");
for (const r of rows.slice(0, 18)) {
  const flag = r.d > noise ? "" : "   (inside noise)";
  console.log(`  ${r.add.name.slice(0, 20).padEnd(20)} ${r.add.pos.padEnd(4)} ${r.add.proj.toFixed(0).padStart(5)}  ` +
    `${r.drop.name.slice(0, 20).padEnd(20)} ${((r.d >= 0 ? "+" : "") + r.d.toFixed(2) + "pp").padStart(8)}   ` +
    `${r.spread.toFixed(2)}${flag}`);
}

// Best claim per ADD, which is the form the decision actually takes: you claim a player, then decide
// who goes. Collapsing to one row per add stops a single strong add filling the whole table.
const bestPerAdd = new Map();
for (const r of rows) if (!bestPerAdd.has(r.add.name)) bestPerAdd.set(r.add.name, r);
const perAdd = [...bestPerAdd.values()].sort((a, b) => b.d - a.d).slice(0, 12);
console.log(`\n  BEST DROP FOR EACH ADD (one row per player, the form the decision takes)`);
console.log("  add                   pos  proj   drop him              delta");
for (const r of perAdd) {
  console.log(`  ${r.add.name.slice(0, 20).padEnd(20)} ${r.add.pos.padEnd(4)} ${r.add.proj.toFixed(0).padStart(5)}  ` +
    `${r.drop.name.slice(0, 20).padEnd(20)} ${((r.d >= 0 ? "+" : "") + r.d.toFixed(2) + "pp").padStart(8)}` +
    `${r.d > noise ? "" : "   (inside noise)"}`);
}

if (illegal.size) {
  console.log(`\n  NEVER DROPPABLE (only body at a mandatory slot -- you would claim a replacement instead):`);
  console.log(`    ${[...illegal].map(([n, p]) => `${n} (${p})`).join(", ")}`);
}
const clear = rows.filter((r) => r.d > noise);
console.log(`\n  ${clear.length} of ${rows.length} claims clear the noise floor.`);
console.log(`  Two seeds is enough to RANK; it is not enough to send. Confirm the top few with`);
console.log(`  scripts/waiver-check.mjs "<name>" 6000, which runs four seeds and reports a standard error.`);
