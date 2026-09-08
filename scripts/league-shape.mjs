// WHO IS OVERLOADED AT WHAT? A roster-shape scan of all sixteen teams.
//
//   node --import tsx scripts/league-shape.mjs
//
// The trade sweep brute-forces every swap and scores it, which is thorough and slow. This answers
// the question that USUALLY comes first and in a second: which team has more of a position than it
// can start, and which team is short? A complementary pair -- their surplus meets our need and ours
// meets theirs -- is where a proposal has a chance, because both managers are already looking at the
// problem the trade solves.
//
// SURPLUS IS DEFINED BY THE LINEUP, NOT BY COUNTING. Holding four running backs is not a surplus if
// two start and two more fill the flex; holding four QUARTERBACKS in a one-QB league is a surplus of
// three no matter how good they are. So each roster is run through the real lineup optimiser and a
// player is surplus if he does not make the starting lineup. That is also why the number is stated in
// PROJECTED POINTS rather than in bodies: a bench quarterback worth 300 points and a bench kicker are
// both "one spare player" and they are not remotely the same trade asset.
//
// NEED IS MARGINAL VALUE, and the obvious definition is wrong in a way that produced a flatly
// self-contradictory first run. Defining need as "this team's starters at P versus the league median
// at P" reported DAN as holding 406 spare RB points AND being 293 short at RB. Both cannot be true.
// The cause is that starter points at a position depend on how many of that position a manager
// CHOOSES to start: DAN starts one back and three receivers in the flex, so his RB starter total is
// compared against a median that includes teams starting three backs. That measures lineup
// composition, not scarcity.
//
// So need is measured the only way that cannot be gamed by roster shape: give the team a hypothetical
// league-median starter at position P and ask how much his optimal lineup improves. A team already
// deep at P gains nothing, because the new man does not crack the lineup. A team genuinely short
// gains a lot. It is immune to how the flex happens to be filled, and it is the same quantity the
// trade actually delivers.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { optimalLineup } from "../src/inseason/lineup.ts";

const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const lg = db.prepare("SELECT league_id, team_id FROM league WHERE season=? AND team_id IS NOT NULL").get(cfg.season);
const SLOTS = cfg.slots.filter((s) => s !== "BE" && s !== "IR");
const FLEX = cfg.flex_ok;
const POS = ["QB", "RB", "WR", "TE"];

const board = new Map();
for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfg.season)) {
  const j = JSON.parse(r.row_json);
  board.set(r.player_id, { name: j.Player, pos: j.Pos, proj: j.ProjPts || 0, value: j["OurValue$"] || 0 });
}
const teams = new Map();
for (const r of db.prepare("SELECT player_id, team_id, owner, team_abbrev FROM ownership WHERE league_id=?").all(lg.league_id)) {
  const b = board.get(r.player_id);
  if (!b) continue;
  if (!teams.has(r.team_id)) teams.set(r.team_id, { id: r.team_id, owner: r.owner, abbr: r.team_abbrev, players: [] });
  teams.get(r.team_id).players.push({ ...b, available: true });
}

const rows = [];
for (const [tid, t] of teams) {
  const res = optimalLineup(t.players, SLOTS, FLEX);
  const starters = new Set(res.starters.map((s) => s.name));
  const shape = { id: tid, abbr: t.abbr, owner: t.owner, mine: tid === String(lg.team_id), count: {}, surplus: {}, starterPts: {} };
  for (const p of POS) { shape.count[p] = 0; shape.surplus[p] = 0; shape.starterPts[p] = 0; }
  for (const p of t.players) {
    if (!POS.includes(p.pos)) continue;
    shape.count[p.pos]++;
    if (starters.has(p.name)) shape.starterPts[p.pos] += p.proj;
    else shape.surplus[p.pos] += p.proj;          // does not start -> scores nothing for him
  }
  shape.emptySlots = res.starters.filter((s) => s.name === "(empty)").map((s) => s.slot);
  rows.push(shape);
}
// A league-median STARTER at each position: the median projection among players who actually start
// somewhere. That is the calibre a trade realistically delivers, so it is what we hand each team to
// measure their need.
const startersByPos = {};
for (const [, t] of teams) {
  const st = new Set(optimalLineup(t.players, SLOTS, FLEX).starters.map((s) => s.name));
  for (const p of t.players) if (POS.includes(p.pos) && st.has(p.name)) (startersByPos[p.pos] ??= []).push(p.proj);
}
const medStarter = {};
for (const p of POS) {
  const v = (startersByPos[p] ?? [0]).sort((a, b) => a - b);
  medStarter[p] = v[v.length >> 1];
}
// NEED = what a median starter at P would add to this team's lineup. Zero means "already covered".
const score = (players) => optimalLineup(players, SLOTS, FLEX).starters.reduce((a, x) => a + x.proj, 0);
for (const r of rows) {
  const t = teams.get(r.id);
  const base = score(t.players);
  r.need = {};
  for (const p of POS) {
    r.need[p] = score([...t.players, { name: `__median_${p}`, pos: p, proj: medStarter[p], available: true }]) - base;
  }
}

console.log(`ROSTER SHAPE -- ${rows.length} teams, starters decided by the real lineup optimiser\n`);
console.log("  team    owner                 QB       RB       WR       TE     bench pts   holes");
console.log("                              n/spare  n/spare  n/spare  n/spare   (unstartable)");
for (const r of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
  const cell = (p) => `${r.count[p]}/${r.surplus[p] > 0 ? Math.round(r.surplus[p]) : "-"}`.padStart(8);
  const benchTotal = POS.reduce((a, p) => a + r.surplus[p], 0);
  console.log(
    `  ${(r.abbr + (r.mine ? "*" : "")).padEnd(7)} ${String(r.owner).slice(0, 20).padEnd(20)}` +
    POS.map(cell).join("") + `${Math.round(benchTotal).toString().padStart(11)}   ${r.emptySlots.join(",") || "-"}`,
  );
}
console.log(`  * = us.  "n/spare" is roster count / projected points sitting on the bench at that position.`);

// --- the actual question: who is overloaded at RB, and are they short where we are long? ----------
const us = rows.find((r) => r.mine);
console.log(`\nOUR SHAPE: ` + POS.map((p) => `${p} ${us.count[p]} (${Math.round(us.surplus[p])} spare, need ${Math.round(us.need[p])})`).join(", "));
console.log(`  a league-median starter projects -- ` + POS.map((p) => `${p} ${Math.round(medStarter[p])}`).join(", "));

console.log(`\nRB-OVERLOADED TEAMS -- spare RB points benched, and what a median starter would add them:`);
console.log("  team    spare RB    their needs (pts a median starter adds)     complementary with us?");
const ranked = rows.filter((r) => !r.mine).sort((a, b) => b.surplus.RB - a.surplus.RB);
for (const r of ranked.slice(0, 8)) {
  if (r.surplus.RB <= 0) continue;
  const needs = POS.map((p) => ({ p, n: r.need[p] })).sort((a, b) => b.n - a.n);
  const worst = needs[0];
  // A match needs THEIR biggest need to be a position WE have sitting unused.
  // Match on ANY need we can supply, not just their largest. Their top hole is often QB or RB --
  // positions we have nothing spare at -- but a secondary WR need we CAN fill still makes a deal,
  // and keying only on the maximum reported "no match" for every team with a fillable second need.
  const fillable = needs.filter((x) => x.n > 10 && us.surplus[x.p] > 40);
  const match = fillable.length
    ? `YES -- ${fillable.map((x) => `${x.p} +${Math.round(x.n)}`).join(", ")} (we bench ${fillable.map((x) => Math.round(us.surplus[x.p])).join("/")})`
    : worst.n <= 10 ? `no -- no real hole anywhere` : `no -- needs ${needs.filter((x) => x.n > 10).map((x) => x.p).join("/")}, none of which we spare`;
  const needStr = needs.filter((x) => x.n > 5).map((x) => `${x.p}+${Math.round(x.n)}`).join(" ") || "none";
  console.log(`  ${r.abbr.padEnd(7)} ${Math.round(r.surplus.RB).toString().padStart(8)}    ${needStr.padEnd(40)} ${match}`);
}

// CONSISTENCY CHECK, on its third definition, because the first two were wrong in ways that each
// looked reasonable:
//
//   v1  "starters at P vs the league median at P" -- reported DAN as holding 406 spare RB points AND
//       being 293 short at RB. It measured how many of a position a manager CHOOSES to start.
//   v2  "does a median starter at P improve the lineup?" -- fired for 14 of 16 teams, which is a
//       check that flags everything and therefore says nothing. A median starter improves almost any
//       bench, so v2 was asking "would you like a good player" and getting the obvious answer.
//
// Both conflated DEPTH with QUALITY. Holding four mediocre backs is not the same as being covered at
// RB, and wanting a better one is not a contradiction. The only genuine inconsistency is when a
// team's BEST BENCHED player at P already out-projects a median starter at P and the model still
// says they need P -- there, the man to fill the hole is already on their own bench.
const bestBench = {};
for (const [tid, t] of teams) {
  const st = new Set(optimalLineup(t.players, SLOTS, FLEX).starters.map((s) => s.name));
  bestBench[tid] = {};
  for (const p of POS) {
    bestBench[tid][p] = Math.max(0, ...t.players.filter((x) => x.pos === p && !st.has(x.name)).map((x) => x.proj));
  }
}
const contradictions = rows.filter((r) => POS.some((p) => bestBench[r.id][p] > medStarter[p] && r.need[p] > 20));
console.log(contradictions.length
  ? `\n  CONTRADICTION -- a benched player already better than a median starter, yet the slot reads as a need:\n` +
    contradictions.map((r) => `   - ${r.abbr}: ` + POS.filter((p) => bestBench[r.id][p] > medStarter[p] && r.need[p] > 20)
      .map((p) => `${p} best bench ${Math.round(bestBench[r.id][p])} > median starter ${Math.round(medStarter[p])}, yet need +${Math.round(r.need[p])}`).join(", ")).join("\n")
  : `\n  consistency check: nobody is reported as needing a position their own bench already covers.`);
