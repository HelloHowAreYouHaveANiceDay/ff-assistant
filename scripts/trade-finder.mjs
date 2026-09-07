// WHICH 1-FOR-1 TRADES MAKE BOTH TEAMS BETTER?
//
//   node --import tsx scripts/trade-finder.mjs [ourTeamId]
//
// A trade is not a value comparison, it is a LINEUP comparison. Our board says Marvin Harrison Jr.
// is worth $10 and that is true in the abstract; on this roster he is a sixth receiver who cannot be
// started, so his marginal value to us is close to zero. The same player on a team starting a
// replacement-level flex is worth a great deal. That gap is the entire basis for a trade, and a
// dollar-for-dollar comparison cannot see it.
//
// So every candidate is scored by re-running the OPTIMAL LINEUP on both sides, before and after. A
// deal is only proposable if BOTH sides gain -- not because fairness is a virtue here, but because a
// proposal the other manager loses on will simply be rejected, and a "winning" trade nobody accepts
// is worth nothing.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO. It does not consult the sim for playoff odds -- a weekly
// starting-points delta is the honest unit for a lineup change, and dressing it up as a title
// probability would imply precision the trade search does not have. And it does not model the other
// manager's psychology, roster preferences or how much he likes his own players; it finds deals that
// are defensible on the numbers, and whether one gets accepted is a separate question.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { optimalLineup } from "../src/inseason/lineup.ts";

const OURS = process.argv[2] ?? null;
const db = new Database("data/ff.db", { readonly: true });
const lg = db.prepare("SELECT league_id, team_id FROM league WHERE season = 2026 AND team_id IS NOT NULL").get();
const LEAGUE = lg.league_id, ME = OURS ?? lg.team_id;
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const SLOTS = cfg.slots.filter((s) => s !== "BE" && s !== "IR");
const FLEX_OK = cfg.flex_ok;

const board = new Map();
for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season = 2026").all()) {
  const j = JSON.parse(r.row_json);
  board.set(r.player_id, { name: j.Player, pos: j.Pos, proj: (j.ProjPts || 0) / 17, value: j["OurValue$"] || 0 });
}
const teams = new Map();
for (const r of db.prepare("SELECT player_id, team_id, owner, team_abbrev FROM ownership WHERE league_id = ?").all(LEAGUE)) {
  const b = board.get(r.player_id);
  if (!b) continue;                                   // DST rows the board does not carry
  if (!teams.has(r.team_id)) teams.set(r.team_id, { id: r.team_id, owner: r.owner, abbr: r.team_abbrev, players: [] });
  teams.get(r.team_id).players.push({ ...b, available: true });
}
const score = (players) => {
  const r = optimalLineup(players, SLOTS, FLEX_OK);
  return r.starters.reduce((s, x) => s + x.proj, 0);
};
const us = teams.get(String(ME));
if (!us) { console.log(`team ${ME} not found -- run \`ff sync-rosters\``); process.exit(1); }
const usBase = score(us.players);
console.log(`US: ${us.abbr} (${us.owner}) -- ${us.players.length} players, ${usBase.toFixed(1)} starting pts/wk\n`);

const deals = [];
for (const [tid, them] of teams) {
  if (tid === String(ME)) continue;
  const themBase = score(them.players);
  for (const give of us.players) {
    for (const get of them.players) {
      if (give.name === get.name) continue;
      const usAfter = score([...us.players.filter((p) => p.name !== give.name), { ...get }]);
      const themAfter = score([...them.players.filter((p) => p.name !== get.name), { ...give }]);
      const dUs = usAfter - usBase, dThem = themAfter - themBase;
      if (dUs > 0.05 && dThem > 0.05) deals.push({ them, give, get, dUs, dThem, joint: dUs + dThem });
    }
  }
}
deals.sort((a, b) => b.dUs - a.dUs);
console.log(`${deals.length} one-for-one trades where BOTH lineups improve\n`);
console.log("  we give               we get                partner        us      them");
const seen = new Set();
for (const d of deals.slice(0, 18)) {
  const k = `${d.give.name}|${d.get.name}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(
    `  ${d.give.name.slice(0, 20).padEnd(20)}  ${d.get.name.slice(0, 20).padEnd(20)}  ${d.them.abbr.padEnd(6)} ` +
    `${("+" + d.dUs.toFixed(2)).padStart(7)} ${("+" + d.dThem.toFixed(2)).padStart(9)}`,
  );
}
if (!deals.length) {
  console.log("  none. That is a real answer: with a roster this lopsided, every 1-for-1 that helps us");
  console.log("  costs the other side, so the move has to be a 2-for-1 or a waiver claim instead.");
}

// WHO IS UNSTARTABLE HERE? The surplus that motivates a trade in the first place, stated explicitly
// so the list above can be read against it.
const start = new Set(optimalLineup(us.players, SLOTS, FLEX_OK).starters.map((s) => s.name));
const bench = us.players.filter((p) => !start.has(p.name)).sort((a, b) => b.proj - a.proj);
console.log(`\nOUR BENCH, by weekly projection -- trade material, since none of these score for us:`);
for (const p of bench) console.log(`  ${p.name.padEnd(22)} ${p.pos.padEnd(4)} ${p.proj.toFixed(1).padStart(5)} pts/wk   $${p.value}`);
