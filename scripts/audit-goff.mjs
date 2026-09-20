// How much of 8==3's #1 is Jared Goff, and is his projection a projector outlier vs the market?
// Fair concentration test: re-value Goff at a MARKET-CONSISTENT QB level (keep a QB in the slot).
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { nameKey } from "../src/draft/values.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";
const { rosters } = JSON.parse(readFileSync("scratch-teams.json", "utf8"));
const db = new Database("data/ff.db", { readonly: true });
// THE ACTIVE LEAGUE'S board. `board` is per-league since 2026-09-20; an unfiltered read here would
// union every league's pool and quietly double-count a player who is on two of them.
const AUDIT_LG = (db.prepare("SELECT value FROM settings WHERE key='active_league'").get() || {}).value ?? null;
const LGQ = AUDIT_LG ? " AND league_id = @lg" : "";
const LGP = AUDIT_LG ? { lg: AUDIT_LG } : {};
// QB landscape: our board proj, fftoday, ecr for all QBs
const qb = [];
for (const r of db.prepare(`SELECT player_id, row_json FROM board WHERE season=2026${LGQ}`).all(LGP)) {
  const j = JSON.parse(r.row_json); if (j.Pos !== "QB") continue;
  qb.push({ pid: String(r.player_id), name: String(j.Player), our: Number(j.ProjPts) || 0, nk: nameKey(String(j.Player)) });
}
const ff = new Map();
for (const r of db.prepare("SELECT name_key, proj_fpts FROM raw_fftoday_proj WHERE season=2026 AND pos='QB'").all()) ff.set(r.name_key, r.proj_fpts);
const ecr = new Map();
for (const r of db.prepare("SELECT player_id, overall_rank, pos_rank FROM ranking WHERE season=2026 AND source='fantasypros_ecr'").all()) ecr.set(String(r.player_id), { ovr: r.overall_rank, pr: r.pos_rank });
for (const q of qb) { q.ff = ff.get(q.nk) ?? null; q.ecr = ecr.get(q.pid)?.pr ?? null; }
qb.sort((a, b) => b.our - a.our);
console.log("QB board (top 16) by OUR projector, with FFToday pts and FantasyPros pos-rank:");
qb.slice(0, 16).forEach((q, i) => console.log(`  ${String(i + 1).padStart(2)}. ${q.name.padEnd(22)} our ${String(Math.round(q.our)).padStart(3)}  ff ${q.ff != null ? Math.round(q.ff) : "  -"}  ${q.ecr ?? ""}`));
const goff = qb.find((q) => q.name.includes("Goff"));
console.log(`\nGOFF: our=${Math.round(goff.our)} (our QB rank #${qb.findIndex((q) => q === goff) + 1}), ff=${goff.ff != null ? Math.round(goff.ff) : "-"} (ff QB rank #${[...qb].filter((q)=>q.ff!=null).sort((a,b)=>b.ff-a.ff).findIndex((q)=>q===goff)+1}), FantasyPros=${goff.ecr}`);
// market-consistent Goff value under OUR scale: the OUR-proj of the QB at Goff's FantasyPros QB rank
const goffPr = Number(String(goff.ecr).replace(/\D/g, "")); // e.g. QB9 -> 9
const qbByFp = [...qb].filter((q) => q.ecr).sort((a, b) => Number(String(a.ecr).replace(/\D/g,"")) - Number(String(b.ecr).replace(/\D/g,"")));
const marketGoff = qbByFp[goffPr - 1]?.our ?? goff.our;
console.log(`Market says Goff is QB${goffPr}. Our-scale value of the QB the market ranks QB${goffPr} = ${Math.round(marketGoff)} (vs our ${Math.round(goff.our)} for Goff). Over-valuation = ${Math.round(goff.our - marketGoff)} pts.`);

// re-rank 8==3 with Goff re-valued to marketGoff, everyone else unchanged
const FULL = ["QB","RB","WR","TE","FLEX","FLEX","DST","K"], FOK = ["RB","WR","TE"];
const teams = rosters.map(([tid, r]) => ({ tid, abbrev: r.abbrev, players: r.players }));
const startOf = (players, override) => optimalLineup(players.map((p) => ({ name: p.name, pos: p.pos, proj: override?.[p.name] ?? p.ourProj, available: true })), FULL, FOK).starters.reduce((a, s) => a + s.proj, 0);
const scores = teams.map((t) => ({ abbrev: t.abbrev, us: t.tid === "8", s: t.tid === "8" ? startOf(t.players, { "Jared Goff": marketGoff }) : startOf(t.players) })).sort((a, b) => b.s - a.s);
const ui = scores.findIndex((s) => s.us);
console.log(`\nRe-rank with Goff at market-QB${goffPr} value: 8==3 startPts ${Math.round(scores[ui].s)} -> rank #${ui + 1} of 16`);
console.log("  top5: " + scores.slice(0, 5).map((s) => `${s.abbrev}${s.us ? "*" : ""} ${Math.round(s.s)}`).join(", "));

// Detroit correlation note: which 8==3 starters are Lions?
const lionsNk = new Set();
for (const r of db.prepare(`SELECT row_json FROM board WHERE season=2026${LGQ}`).all(LGP)) { const j = JSON.parse(r.row_json); if (j.Team === "DET") lionsNk.add(nameKey(String(j.Player))); }
const us = teams.find((t) => t.tid === "8");
console.log("\n8==3 starters on same NFL team (correlation risk):");
const teamOf = new Map();
for (const r of db.prepare(`SELECT row_json FROM board WHERE season=2026${LGQ}`).all(LGP)) { const j = JSON.parse(r.row_json); teamOf.set(nameKey(String(j.Player)), j.Team); }
const byNfl = {};
for (const p of us.players) { const t = teamOf.get(nameKey(p.name)) ?? "?"; (byNfl[t] ??= []).push(`${p.name}(${p.pos})`); }
for (const [t, ps] of Object.entries(byNfl)) if (ps.length > 1) console.log(`  ${t}: ${ps.join(", ")}`);
db.close();
