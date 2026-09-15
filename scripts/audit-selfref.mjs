// SKEPTICAL AUDIT: is 8==3's #1 power-ranking REAL or an artifact of our own projector?
// Re-ranks all 16 teams under INDEPENDENT valuations (FFToday points, FantasyPros ECR, draft ADP)
// instead of our projector, using the SAME roster join the sim uses and the SAME optimalLineup.
//   node --import tsx scripts/audit-selfref.mjs
import Database from "better-sqlite3";
import { nameKey, dstAliasKey } from "../src/draft/values.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";

const db = new Database("data/ff.db", { readonly: true });
const SEASON = 2026;
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const lg = db.prepare("SELECT league_id, team_id FROM league WHERE season=? AND team_id IS NOT NULL").get(SEASON);
const MY_TEAM = String(lg.team_id);

// --- board: player_id -> {name,pos,ourProj,player_sk} (exactly the sim's source) ---
const board = new Map();
for (const r of db.prepare("SELECT player_id, player_sk, row_json FROM board WHERE season=?").all(SEASON)) {
  const j = JSON.parse(r.row_json);
  board.set(r.player_id, { name: String(j.Player), pos: String(j.Pos), proj: Number(j.ProjPts) || 0, sk: r.player_sk });
}
// --- independent sources, keyed to join to roster players ---
const ff = new Map(); // `${pos}|${name_key}` -> proj_fpts
for (const r of db.prepare("SELECT pos, name_key, proj_fpts FROM raw_fftoday_proj WHERE season=? AND proj_fpts IS NOT NULL").all(SEASON))
  ff.set(`${r.pos}|${r.name_key}`, r.proj_fpts);
const adp = new Map(); // player_id -> adp
for (const r of db.prepare("SELECT player_id, adp FROM adp WHERE adp IS NOT NULL").all()) adp.set(String(r.player_id), r.adp);
const ecr = new Map(); // player_id -> overall_rank
for (const r of db.prepare("SELECT player_id, overall_rank FROM ranking WHERE season=? AND source='fantasypros_ecr' AND overall_rank IS NOT NULL").all(SEASON))
  ecr.set(String(r.player_id), r.overall_rank);

// --- rosters: replicate the sim's ownership->board join incl. DST alias ---
const rosters = new Map(); // team_id -> {abbrev, players:[{pid,name,pos,ourProj,ff,adp,ecr}]}
const unmatched = [];
for (const r of db.prepare("SELECT player_id, team_id, team_abbrev FROM ownership WHERE league_id=?").all(lg.league_id)) {
  const alias = dstAliasKey(r.player_id);
  const b = board.get(r.player_id) ?? (alias ? board.get(alias) : undefined);
  const tid = String(r.team_id);
  if (!rosters.has(tid)) rosters.set(tid, { abbrev: r.team_abbrev, players: [] });
  if (!b) { unmatched.push(`${tid}:${r.player_id}`); continue; }
  const nk = nameKey(b.name);
  rosters.get(tid).players.push({
    pid: String(r.player_id), name: b.name, pos: b.pos, ourProj: b.proj,
    ff: ff.get(`${b.pos}|${nk}`) ?? null,
    adp: adp.get(String(r.player_id)) ?? null,
    ecr: ecr.get(String(r.player_id)) ?? null,
  });
}
db.close();

console.log(`League ${lg.league_id}, season ${SEASON}, our team ${MY_TEAM} (${rosters.get(MY_TEAM).abbrev})`);
if (unmatched.length) console.log(`UNMATCHED (no board row, dropped): ${unmatched.join(", ")}`);

const SKILL_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "FLEX"];
const FLEX_OK = ["RB", "WR", "TE"];
const FULL_SLOTS = cfg.slots;

// best-lineup sum under a given value function (players missing a value are excluded from that source)
function bestLineup(players, valOf, slots, flexOk) {
  const rp = players.filter((p) => valOf(p) != null).map((p) => ({ name: p.name, pos: p.pos, proj: valOf(p), available: true }));
  const res = optimalLineup(rp, slots, flexOk);
  return { sum: res.starters.reduce((a, s) => a + s.proj, 0), starters: res.starters, n: rp.length };
}

// ADP / ECR: lower is better. Convert to a "higher=better" value for optimalLineup so it picks the
// best skill lineup, then we report the MEAN raw rank of the chosen starters (lower mean = stronger).
function bestLineupByRank(players, rankOf, slots, flexOk) {
  const rankByName = new Map();
  const rp = players.filter((p) => rankOf(p) != null).map((p) => {
    rankByName.set(`${p.name}|${p.pos}`, rankOf(p));
    return { name: p.name, pos: p.pos, proj: -rankOf(p), available: true };
  });
  const res = optimalLineup(rp, slots, flexOk);
  const chosen = res.starters.filter((s) => s.name !== "(empty)");
  const ranks = chosen.map((s) => rankByName.get(`${s.name}|${s.pos}`)).filter((x) => x != null);
  return { meanRank: ranks.reduce((a, x) => a + x, 0) / Math.max(1, ranks.length), nStart: chosen.length, filled: res.starters.length };
}

const teams = [...rosters.entries()].map(([tid, r]) => {
  const ourFull = bestLineup(r.players, (p) => p.ourProj, FULL_SLOTS, FLEX_OK);
  const ourSkill = bestLineup(r.players, (p) => p.ourProj, SKILL_SLOTS, FLEX_OK);
  const ffSkill = bestLineup(r.players, (p) => p.ff, SKILL_SLOTS, FLEX_OK);
  const ffCov = r.players.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos) && p.ff != null).length;
  const ffSkillPlayers = r.players.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos)).length;
  const ecrL = bestLineupByRank(r.players, (p) => p.ecr, SKILL_SLOTS, FLEX_OK);
  const adpL = bestLineupByRank(r.players, (p) => p.adp, SKILL_SLOTS, FLEX_OK);
  return {
    tid, abbrev: r.abbrev, us: tid === MY_TEAM,
    ourFull: Math.round(ourFull.sum), ourSkill: Math.round(ourSkill.sum),
    ffSkill: Math.round(ffSkill.sum), ffCov: `${ffCov}/${ffSkillPlayers}`,
    ecrMean: +ecrL.meanRank.toFixed(1), ecrN: ecrL.nStart,
    adpMean: +adpL.meanRank.toFixed(1), adpN: adpL.nStart,
    nPlayers: r.players.length,
  };
});

function rankTable(label, key, ascending = false) {
  const sorted = [...teams].sort((a, b) => ascending ? a[key] - b[key] : b[key] - a[key]);
  const usIdx = sorted.findIndex((t) => t.us);
  const us = sorted[usIdx];
  console.log(`\n=== RANK BY ${label} (${ascending ? "lower=better" : "higher=better"}) ===`);
  sorted.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.abbrev.padEnd(6)} ${String(t[key]).padStart(8)}${t.us ? "   <== US" : ""}`));
  const second = sorted[usIdx === 0 ? 1 : 0];
  const margin = ascending ? (second[key] - us[key]) : (us[key] - second[key]);
  console.log(`  --> 8==3 rank #${usIdx + 1} of ${sorted.length}; margin to ${usIdx === 0 ? "#2" : "#1"} = ${margin.toFixed(1)}`);
  return usIdx + 1;
}

console.log("\n############ TEST 1: INDEPENDENT-VALUATION RE-RANK ############");
rankTable("OUR PROJECTOR, full lineup (reproduces startPts)", "ourFull");
rankTable("OUR PROJECTOR, skill-only (QB/RB/WR/TE/2FLEX)", "ourSkill");
rankTable("FFTODAY POINTS, skill-only", "ffSkill");
rankTable("FANTASYPROS ECR mean overall-rank of best skill lineup", "ecrMean", true);
rankTable("DRAFT ADP mean of best skill lineup", "adpMean", true);
console.log("\nFFToday skill coverage per team (matched/total QB+RB+WR+TE):");
console.log("  " + teams.map((t) => `${t.abbrev}:${t.ffCov}`).join("  "));
console.log("ECR starters used / ADP starters used per team (of 6 skill slots):");
console.log("  " + teams.map((t) => `${t.abbrev}:ecr${t.ecrN}/adp${t.adpN}`).join("  "));

// dump for other tests
import { writeFileSync } from "node:fs";
writeFileSync("scratch-teams.json", JSON.stringify({ teams, rosters: [...rosters.entries()] }, null, 1));
