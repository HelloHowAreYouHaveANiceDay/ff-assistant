import { readFileSync, writeFileSync } from "node:fs";
const recaps = JSON.parse(readFileSync("data/recaps.json", "utf8"));
const owners = JSON.parse(readFileSync("data/owners.json", "utf8"));

const norm = (s) => (s || "").toLowerCase().replace(/["'\s]+/g, " ").trim();
// season -> [{name, owner}]
const ownerBySeason = {};
for (const s of owners) { ownerBySeason[s.year] = (s.teams || []).map((t) => ({ n: norm(t.name), owner: t.owners[0]?.name?.replace(/\s+/g, " ").trim() || t.abbrev, abbrev: t.abbrev })); }

const matchOwner = (season, name) => {
  const list = ownerBySeason[season] || [];
  const n = norm(name);
  let hit = list.find((t) => t.n === n) || list.find((t) => t.n.startsWith(n) || n.startsWith(t.n)) || list.find((t) => t.n.includes(n) || n.includes(t.n));
  return hit;
};

// attach owner to each recap team
const unmatched = [];
for (const t of recaps) { const h = matchOwner(t.season, t.name); if (h) { t.owner = h.owner; t.abbrev = h.abbrev; } else unmatched.push(`${t.season} "${t.name}"`); }
if (unmatched.length) console.log("UNMATCHED:", unmatched.join(" | "), "\n");

// group by owner
const byOwner = new Map();
for (const t of recaps) { if (!t.owner) continue; if (!byOwner.has(t.owner)) byOwner.set(t.owner, []); byOwner.get(t.owner).push(t); }

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (x) => `${Math.round(x * 100)}%`;

const metrics = (t) => {
  const total = t.picks.reduce((s, p) => s + p.price, 0);
  const bp = Object.fromEntries(POS.map((p) => [p, 0]));
  for (const p of t.picks) if (p.pos in bp) bp[p.pos] += p.price;
  const sorted = t.picks.map((p) => p.price).sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3).reduce((s, x) => s + x, 0);
  const topSpend = [...t.picks].sort((a, b) => b.price - a.price).slice(0, 3);
  // did they pay up (>=$10) for QB or TE early? spend on RB vs WR balance
  return {
    season: t.season, name: t.name, total, max: sorted[0] || 0,
    rb: total ? bp.RB / total : 0, wr: total ? bp.WR / total : 0, qb: total ? bp.QB / total : 0, te: total ? bp.TE / total : 0,
    top3: total ? top3 / total : 0, cheap: t.picks.filter((p) => p.price <= 5).length,
    premQB: bp.QB >= 15, premTE: bp.TE >= 15,
    topStr: topSpend.map((p) => `${p.player.split(" ").slice(-1)[0]}(${p.pos})$${p.price}`).join(" "),
    rbwr: bp.RB + bp.WR ? bp.RB / (bp.RB + bp.WR) : 0.5, // RB-lean of the RB/WR budget
  };
};

const rows = [];
for (const [owner, teams] of byOwner) {
  teams.sort((a, b) => a.season - b.season);
  const ms = teams.map(metrics);
  const g = (k) => ms.map((m) => m[k]);
  rows.push({
    owner, n: teams.length, seasons: teams.map((t) => t.season),
    rb: mean(g("rb")), sdrb: sd(g("rb")), wr: mean(g("wr")),
    rbwr: mean(g("rbwr")), sdrbwr: sd(g("rbwr")),
    top3: mean(g("top3")), sdtop3: sd(g("top3")),
    max: mean(g("max")), sdmax: sd(g("max")),
    cheap: mean(g("cheap")), sdcheap: sd(g("cheap")),
    premQB: g("premQB").filter(Boolean).length, premTE: g("premTE").filter(Boolean).length,
    ms,
  });
}

// predictability = how tight the signature dials are across their seasons (lower sd = more predictable)
for (const r of rows) r.pred = r.sdrbwr + r.sdtop3 + r.sdcheap / 13;
rows.sort((a, b) => a.pred - b.pred);

console.log("=== PER-MANAGER DRAFT TENDENCIES (owner stable across seasons) ===");
console.log("league 462233, auction, seasons 2022-2025. Sorted MOST -> LEAST predictable.\n");
for (const r of rows) {
  const strat = r.top3 > 0.55 ? "STARS&SCRUBS" : r.top3 < 0.42 ? "BALANCED" : "moderate";
  const lean = r.rbwr > 0.62 ? "RB-heavy" : r.rbwr < 0.42 ? "WR-heavy" : "RB/WR-even";
  console.log(`## ${r.owner}  (${r.n} yrs: ${r.seasons.join("/")})  [${strat}, ${lean}]  predictability=${r.pred.toFixed(2)}`);
  console.log(`   top-3 concentration ${pct(r.top3)} (±${pct(r.sdtop3)}) | biggest buy avg $${Math.round(r.max)} (±${Math.round(r.sdmax)}) | $1-5 picks ${r.cheap.toFixed(1)}/yr (±${r.sdcheap.toFixed(1)})`);
  console.log(`   RB share of RB+WR spend ${pct(r.rbwr)} (±${pct(r.sdrbwr)}) | premium QB ${r.premQB}/${r.n} yrs, premium TE ${r.premTE}/${r.n} yrs`);
  for (const m of r.ms) console.log(`      ${m.season}: ${m.topStr}  [top3 ${pct(m.top3)}, ${m.cheap} cheap]`);
  console.log("");
}

// ---- emit machine-readable per-owner profiles for the sim bot model (data/managers.json) ----
// Each owner's AVERAGE positional spend share + concentration. The bot model turns share (relative
// to the league mean) into a per-position bid appetite, so a bot reproduces that owner's real
// spending mix. Uses ALL owners with >=1 season (incl. 2025 newcomers) so the 16-seat field is real.
const byOwnerAll = new Map();
for (const t of recaps) { if (!t.owner) continue; if (!byOwnerAll.has(t.owner)) byOwnerAll.set(t.owner, []); byOwnerAll.get(t.owner).push(t); }
const posShareOf = (teams) => {
  const acc = Object.fromEntries(POS.map((p) => [p, 0]));
  let tot = 0;
  for (const t of teams) for (const p of t.picks) { if (p.pos in acc) acc[p.pos] += p.price; tot += p.price; }
  return { share: Object.fromEntries(POS.map((p) => [p, tot ? acc[p] / tot : 0])), perYearTotal: tot / teams.length };
};
const leagueShare = posShareOf(recaps).share; // baseline: whole-league positional spend mix
const profiles = [];
for (const [owner, teams] of byOwnerAll) {
  teams.sort((a, b) => a.season - b.season);
  const ms = teams.map(metrics);
  const { share } = posShareOf(teams);
  profiles.push({
    owner,
    abbrev: (ownerBySeason[2025] || []).concat(ownerBySeason[2024] || []).find((t) => t.owner === owner)?.abbrev || owner.slice(0, 4),
    seasons: teams.map((t) => t.season),
    share,                                   // this owner's avg positional $ share
    conc: mean(ms.map((m) => m.top3)),       // avg top-3 concentration (stars-and-scrubs degree)
    maxBuy: mean(ms.map((m) => m.max)),      // avg biggest single buy $
    cheap: mean(ms.map((m) => m.cheap)),     // avg $1-5 picks/yr
  });
}
writeFileSync("data/managers.json", JSON.stringify({ leagueShare, profiles }, null, 0));
console.log(`wrote data/managers.json (${profiles.length} owners, league share ` +
  POS.map((p) => `${p} ${pct(leagueShare[p])}`).join(" ") + ")");
