// RB TRADES, scored under AVAILABILITY rather than on point estimates.
//
//   node --import tsx scripts/trade-rb.mjs
//
// scripts/trade-finder.mjs reported that no trade for a second running back improves our lineup, and
// that conclusion was an artifact of its metric rather than a fact about running backs. It scores the
// optimal lineup on point projections -- "what do my best eight score if everyone plays" -- under
// which a backup RB is worth exactly ZERO, because he never starts. A search built on that number
// cannot represent insurance at all, so it was always going to return "no RB trade helps" no matter
// what the roster looked like.
//
// This re-runs the same search under src/inseason/rosterValue.ts, which simulates weekly availability
// from the fitted per-tier rates and optimises the lineup over whoever is left. A mandatory slot with
// nobody to fill it scores zero, which is exactly the cost a second RB removes.
//
// COMMON RANDOM NUMBERS: every roster is scored with the same seed, so two rosters differing by one
// player face IDENTICAL injury draws. Without that, the difference between two close rosters is
// swamped by which simulation happened to draw a worse season.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { scoreRoster } from "../src/inseason/rosterValue.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";

const db = new Database("data/ff.db", { readonly: true });
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const lg = db.prepare("SELECT league_id, team_id FROM league WHERE season = 2026 AND team_id IS NOT NULL").get();
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const SLOTS = cfg.slots.filter((s) => s !== "BE" && s !== "IR");
const FLEX = cfg.flex_ok;
const SIMS = Number(process.env.SIMS ?? 300);

const board = new Map();
const posList = {};
for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season = 2026").all()) {
  const j = JSON.parse(r.row_json);
  board.set(r.player_id, { id: r.player_id, name: j.Player, pos: j.Pos, proj: (j.ProjPts || 0) / 17, value: j["OurValue$"] || 0 });
  (posList[j.Pos] ??= []).push({ name: j.Player, proj: j.ProjPts || 0 });
}
const rankFrac = new Map();
for (const pos of Object.keys(posList)) {
  const l = posList[pos].sort((a, b) => b.proj - a.proj);
  l.forEach((p, i) => rankFrac.set(p.name, i / l.length));
}
const withFrac = (p) => ({ ...p, poolRankFrac: rankFrac.get(p.name) ?? 0.5 });

const teams = new Map();
const ownedIds = new Set();
for (const r of db.prepare("SELECT player_id, team_id, owner, team_abbrev FROM ownership WHERE league_id = ?").all(lg.league_id)) {
  ownedIds.add(r.player_id);
  const b = board.get(r.player_id);
  if (!b) continue;
  if (!teams.has(r.team_id)) teams.set(r.team_id, { id: r.team_id, owner: r.owner, abbr: r.team_abbrev, players: [] });
  teams.get(r.team_id).players.push(withFrac(b));
}
const us = teams.get(String(lg.team_id));
const score = (players) => scoreRoster(players, SLOTS, FLEX, vm, { sims: SIMS, seed: 20260907 });

const base = score(us.players);
const naive = optimalLineup(us.players.map((p) => ({ ...p, available: true })), SLOTS, FLEX).starters.reduce((a, x) => a + x.proj, 0);
console.log(`US: ${us.abbr} (${us.owner})`);
console.log(`  point-estimate lineup (everyone plays):  ${naive.toFixed(2)} pts/wk   <- what trade-finder.mjs used`);
console.log(`  EXPECTED under availability:             ${base.expected.toFixed(2)} pts/wk`);
console.log(`  bad-season floor (p10):                  ${base.p10.toFixed(2)} pts/wk`);
console.log(`  weeks with an UNFILLABLE starting slot:  ${(100 * base.emptySlotRate).toFixed(1)}%`);
console.log(`  the ${(naive - base.expected).toFixed(1)} pt gap between the first two lines is what the old metric could not see.\n`);

// --- free agents first: the cheapest fix is not a trade at all -------------------------------------
const freeRB = [...board.values()].filter((p) => p.pos === "RB" && !ownedIds.has(p.id) && p.proj > 0)
  .sort((a, b) => b.proj - a.proj).slice(0, 12);
console.log("FREE-AGENT RBs -- add one, drop our least useful bench player (Isaiah Likely)");
console.log("  add                     exp     vs now    p10     empty%");
const drop = "Isaiah Likely";
const rows = [];
for (const fa of freeRB) {
  const after = score([...us.players.filter((p) => p.name !== drop), withFrac(fa)]);
  rows.push({ name: fa.name, ...after });
}
rows.sort((a, b) => b.expected - a.expected);
for (const r of rows.slice(0, 8)) {
  console.log(`  ${r.name.slice(0, 22).padEnd(22)} ${r.expected.toFixed(2).padStart(6)} ${(r.expected - base.expected >= 0 ? "+" : "") + (r.expected - base.expected).toFixed(2).padStart(7)} ${r.p10.toFixed(2).padStart(7)} ${(100 * r.emptySlotRate).toFixed(1).padStart(7)}%`);
}

// --- then trades: give a surplus WR, get an RB -----------------------------------------------------
console.log(`\nRB TRADES -- our surplus WR/TE out, their RB in. Both sides scored under availability.`);
console.log("  we give               we get                partner    us      them    our p10   empty%");
const deals = [];
for (const [tid, them] of teams) {
  if (tid === String(lg.team_id)) continue;
  const themBase = score(them.players);
  for (const give of us.players) {
    if (give.pos === "RB" || give.pos === "QB" || give.pos === "K" || give.pos === "DST") continue;
    for (const get of them.players) {
      if (get.pos !== "RB") continue;
      const ua = score([...us.players.filter((p) => p.name !== give.name), withFrac(get)]);
      const ta = score([...them.players.filter((p) => p.name !== get.name), withFrac(give)]);
      const dUs = ua.expected - base.expected, dThem = ta.expected - themBase.expected;
      if (dUs > 0.02) deals.push({ them, give, get, dUs, dThem, p10: ua.p10, empty: ua.emptySlotRate });
    }
  }
}
deals.sort((a, b) => b.dUs - a.dUs);
const shown = deals.filter((d) => d.dThem > 0.02);
for (const d of shown.slice(0, 12)) {
  console.log(
    `  ${d.give.name.slice(0, 20).padEnd(20)}  ${d.get.name.slice(0, 20).padEnd(20)}  ${d.them.abbr.padEnd(6)} ` +
    `${("+" + d.dUs.toFixed(2)).padStart(6)} ${("+" + d.dThem.toFixed(2)).padStart(8)} ${d.p10.toFixed(2).padStart(9)} ${(100 * d.empty).toFixed(1).padStart(7)}%`,
  );
}
if (!shown.length) {
  console.log("  (none where both sides gain)");
  console.log("\n  Best for US regardless of whether they would accept:");
  for (const d of deals.slice(0, 6)) {
    console.log(`  ${d.give.name.slice(0, 20).padEnd(20)}  ${d.get.name.slice(0, 20).padEnd(20)}  ${d.them.abbr.padEnd(6)} ` +
      `${("+" + d.dUs.toFixed(2)).padStart(6)} ${(d.dThem >= 0 ? "+" : "") + d.dThem.toFixed(2).padStart(8)} ${d.p10.toFixed(2).padStart(9)} ${(100 * d.empty).toFixed(1).padStart(7)}%`);
  }
}
