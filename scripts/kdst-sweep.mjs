// THE KICKER AND DEFENSE SCREEN -- the hole the offensive sweep deliberately left.
//
//   node --import tsx scripts/kdst-sweep.mjs
//
// scripts/feature-sweep.mjs runs on QB/RB/WR/TE and excuses ~190 untouched columns as "kicker and
// defense, a separate screen". This is that screen. It reads the fg_*, pat_*, gwfg_* columns for
// kickers and the def_* team columns for defenses, neither of which any model here has ever looked at.
//
// It matters more than the received wisdom suggests. scripts/kdst-leverage.mjs measures how much
// title probability sits between the best and worst available occupant of each slot on our roster,
// and K came back at 1.11pp of realistic range against a 4.23% base -- the second-largest of any
// position, because K and DST are single-occupant slots with no substitute, while our sixth receiver
// is worth exactly nothing.
//
// ONE METHODOLOGICAL DIFFERENCE FROM THE OFFENSIVE SWEEP, and it is the important part. There, `age`
// served as a positive control: a feature already fitted, shipped and measured, which the screen had
// to rediscover before anything else it said could be believed. NOTHING is fitted for K or DST --
// no age curve, no opportunity model, both positions are `unfitted` in the variance model -- so there
// is no natural control available. A screen with no positive control that reports "no signal" is
// indistinguishable from a screen that is not connected to its data, and "K and DST are
// unpredictable" is exactly the answer everyone expects, which is what makes it dangerous to accept.
//
// So the control is SYNTHETIC: a column built from the actual outcome plus heavy noise. It is not a
// real feature and is never a finding -- it exists so that if it fails to survive, the run is void.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv, playerWeekUrl, teamWeekUrl, canonTeam, URLS } from "../src/data/nflverse.ts";

const SEASONS = Array.from({ length: 20 }, (_, i) => 2006 + i);
const CACHE = "data/cache";
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
async function csv(url, tag) {
  const p = `${CACHE}/${tag}.csv.gz`;
  if (existsSync(p)) return parseCsv(gunzipSync(readFileSync(p)).toString("utf8"));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  writeFileSync(p, gzipSync(Buffer.from(text)));
  return parseCsv(text);
}

// --- residuals: what a rank-only projection gets wrong at K and DST --------------------------------
const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (pos === "K" || pos === "DST") tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts), name, season: Number(s) });
}
const seasons = [...new Set([...tot.values()].map((v) => v.season))].sort().filter((s) => s >= 2007);
const rank = new Map();
for (const s of seasons.concat([seasons[0] - 1])) {
  for (const pos of ["K", "DST"]) {
    [...tot.entries()].filter(([, v]) => v.season === s && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts).forEach(([k], i) => rank.set(k, i + 1));
  }
}
const rows = [];
for (const v of tot.values()) {
  if (!seasons.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > 40) continue;
  rows.push({ season: v.season, pos: v.pos, name: v.name, y: v.pts, rank: r });
}
for (const hold of seasons) {
  const train = rows.filter((r) => r.season !== hold);
  if (train.length < 80) continue;
  const curve = {};
  for (const pos of ["K", "DST"]) {
    const byRank = new Map();
    for (const r of train) { if (r.pos !== pos) continue; if (!byRank.has(r.rank)) byRank.set(r.rank, []); byRank.get(r.rank).push(r.y); }
    curve[pos] = new Map([...byRank].map(([k, a]) => [k, a.reduce((x, y) => x + y, 0) / a.length]));
  }
  for (const r of rows.filter((x) => x.season === hold)) {
    const m = curve[r.pos];
    let pred = m?.get(r.rank);
    if (pred == null && m?.size) { let bd = Infinity; for (const [k, v] of m) { const d = Math.abs(k - r.rank); if (d < bd) { bd = d; pred = v; } } }
    r.pred = pred ?? 0;
    r.resid = r.y - r.pred;
  }
}
const scored = rows.filter((r) => r.pred > 20);

// --- KICKER features -------------------------------------------------------------------------------
console.log("aggregating kicker seasons ...");
const kFeat = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let raw; try { raw = await csv(playerWeekUrl(yr), `pw-${yr}`); } catch { continue; }
  const agg = new Map();
  for (const r of raw) {
    if (r.season_type !== "REG" || (r.position || "").toUpperCase() !== "K") continue;
    const name = (r.player_display_name || "").trim();
    if (!name) continue;
    let a = agg.get(name); if (!a) { a = { g: 0 }; agg.set(name, a); }
    a.g += 1;
    const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
    add("att", N(r.fg_att)); add("made", N(r.fg_made)); add("miss", N(r.fg_missed)); add("blk", N(r.fg_blocked));
    add("patAtt", N(r.pat_att)); add("patMade", N(r.pat_made)); add("patMiss", N(r.pat_missed));
    add("gwAtt", N(r.gwfg_att)); add("gwMade", N(r.gwfg_made));
    a.long = Math.max(a.long ?? 0, N(r.fg_long));
    // Attempt distribution by distance: made + missed in each bucket is the attempt count. A kicker's
    // LEG is visible in how often his coach sends him out from 50+, which is a different thing from
    // how accurate he is.
    for (const b of ["0_19", "20_29", "30_39", "40_49", "50_59", "60_"]) {
      add(`a${b}`, N(r[`fg_made_${b}`]) + N(r[`fg_missed_${b}`]));
      add(`m${b}`, N(r[`fg_made_${b}`]));
    }
  }
  for (const [name, a] of agg) {
    if (a.g < 4) continue;
    const per = (k) => (a[k] ?? 0) / a.g;
    const rate = (n, d) => (a[d] > 0 ? a[n] / a[d] : null);
    const long = (a.a50_59 ?? 0) + (a.a60_ ?? 0);
    kFeat.set(`${yr}|${name}`, {
      games: a.g,
      fgAtt: per("att"), fgMade: per("made"), fgPct: rate("made", "att"),
      patAtt: per("patAtt"), patPct: rate("patMade", "patAtt"),
      fgLong: a.long || null,
      longAttRate: a.att > 0 ? long / a.att : null,          // share of tries from 50+
      longMakeRate: long > 0 ? ((a.m50_59 ?? 0) + (a.m60_ ?? 0)) / long : null,
      shortPct: rate("m20_29", "a20_29"),
      midPct: rate("m30_39", "a30_39"),
      fortyPct: rate("m40_49", "a40_49"),
      blockRate: rate("blk", "att"),
      gwAtt: per("gwAtt"),
      // Total scoring opportunities: a kicker's fantasy points are mostly a function of how often his
      // offence reaches scoring range, which is a property of the TEAM, not of him.
      chances: per("att") + per("patAtt"),
    });
  }
}

// --- DEFENSE features ------------------------------------------------------------------------------
console.log("aggregating defense seasons ...");
const dFeat = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let raw; try { raw = await csv(teamWeekUrl(yr), `tw-${yr}`); } catch { continue; }
  const agg = new Map();
  for (const r of raw) {
    if (r.season_type !== "REG") continue;
    const t = canonTeam((r.team || r.recent_team || "").trim());
    if (!t) continue;
    let a = agg.get(t); if (!a) { a = { g: 0 }; agg.set(t, a); }
    a.g += 1;
    const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
    add("sack", N(r.def_sacks)); add("int", N(r.def_interceptions)); add("ff", N(r.def_fumbles_forced));
    add("fum", N(r.def_fumbles)); add("td", N(r.def_tds)); add("safety", N(r.def_safeties));
    add("pd", N(r.def_pass_defended)); add("qbh", N(r.def_qb_hits)); add("tfl", N(r.def_tackles_for_loss));
    add("blk", N(r.def_punt_blocks) + N(r.def_pat_blocks) + N(r.def_fg_blocks));
    add("sackYd", N(r.def_sack_yards)); add("intYd", N(r.def_interception_yards));
  }
  for (const [t, a] of agg) {
    const per = (k) => (a[k] ?? 0) / a.g;
    dFeat.set(`${yr}|${t}`, {
      games: a.g,
      sacks: per("sack"), ints: per("int"), forcedFumbles: per("ff"), fumbleRec: per("fum"),
      defTds: per("td"), safeties: per("safety"), passDefended: per("pd"), qbHits: per("qbh"),
      tacklesForLoss: per("tfl"), blocks: per("blk"), sackYards: per("sackYd"), intYards: per("intYd"),
      // TURNOVERS are the classic regression trap: they drive fantasy points and are far less stable
      // year to year than pressure is. Both go in so the screen can say which one carries.
      takeaways: per("int") + per("fum"),
      pressure: per("sack") + per("qbh") + per("tfl"),
    });
  }
}

// --- team + market context, shared by both ---------------------------------------------------------
console.log("fetching schedules ...");
const env = new Map(), market = new Map(), pointsAllowed = new Map();
try {
  const games = await csv(URLS.schedules, "schedules");
  const ea = new Map(), pa = new Map();
  for (const g of games) {
    if (g.game_type !== "REG") continue;
    const season = Number(g.season), wk = Number(g.week);
    for (const side of ["home", "away"]) {
      const t = canonTeam((g[`${side}_team`] || "").trim());
      const opp = canonTeam((g[side === "home" ? "away_team" : "home_team"] || "").trim());
      if (!t) continue;
      let a = ea.get(`${season}|${t}`);
      if (!a) { a = { g: 0, dome: 0, wind: 0, windN: 0, temp: 0, tempN: 0 }; ea.set(`${season}|${t}`, a); }
      a.g += 1;
      if (/dome|closed|indoor/i.test(g.roof || "")) a.dome += 1;
      if (g.wind !== "" && g.wind != null) { a.wind += N(g.wind); a.windN += 1; }
      if (g.temp !== "" && g.temp != null) { a.temp += N(g.temp); a.tempN += 1; }
      // Points conceded -- the largest single component of a defense's fantasy score, and not present
      // anywhere in the def_* columns.
      const conceded = N(g[side === "home" ? "away_score" : "home_score"]);
      let p = pa.get(`${season}|${t}`); if (!p) { p = { g: 0, pts: 0 }; pa.set(`${season}|${t}`, p); }
      p.g += 1; p.pts += conceded;
      if (wk === 1) {
        const spread = g.spread_line === "" ? null : N(g.spread_line) * (side === "home" ? 1 : -1);
        const total = g.total_line === "" ? null : N(g.total_line);
        market.set(`${season}|${t}`, {
          vegasSpread: spread, vegasTotal: total,
          vegasImpliedPts: total != null && spread != null ? total / 2 + spread / 2 : null,
          vegasImpliedAgainst: total != null && spread != null ? total / 2 - spread / 2 : null,
        });
      }
      void opp;
    }
  }
  for (const [k, a] of ea) env.set(k, {
    domeShare: a.g ? a.dome / a.g : null,
    avgWind: a.windN ? a.wind / a.windN : null,
    avgTemp: a.tempN ? a.temp / a.tempN : null,
  });
  for (const [k, p] of pa) pointsAllowed.set(k, p.g ? p.pts / p.g : null);
} catch (e) { console.log(`  schedules unavailable: ${e.message}`); }

// Kicker's team, from the weekly history file.
const kTeam = new Map();
{
  const seen = new Map();
  for (const line of readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const [s, name, pos, , , team] = line.split(",");
    if (pos !== "K" || !team) continue;
    const k = `${s}|${name}`;
    if (!seen.has(k)) seen.set(k, new Map());
    const m = seen.get(k); m.set(team, (m.get(team) ?? 0) + 1);
  }
  for (const [k, m] of seen) kTeam.set(k, canonTeam([...m].sort((a, b) => b[1] - a[1])[0][0]));
}

// --- assemble ---------------------------------------------------------------------------------------
let seed = 20260908;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (const r of scored) {
  const prev = r.season - 1;
  const team = r.pos === "DST" ? canonTeam(r.name.split(" ")[0]) : kTeam.get(`${prev}|${r.name}`);
  const own = r.pos === "DST" ? (dFeat.get(`${prev}|${team}`) ?? {}) : (kFeat.get(`${prev}|${r.name}`) ?? {});
  r.f = {
    ...own,
    ...(team ? env.get(`${prev}|${team}`) ?? {} : {}),
    ...(team ? market.get(`${r.season}|${team}`) ?? {} : {}),
    pointsAllowedPrior: team ? pointsAllowed.get(`${prev}|${team}`) ?? null : null,
  };
  r.f.__random = rnd();
  // SYNTHETIC POSITIVE CONTROL. Not a feature -- a column built from the answer plus heavy noise, so
  // the screen has something it MUST detect. Without it, "no signal at K or DST" cannot be
  // distinguished from "this screen is not wired to its data", and the former is the expected
  // result, which is precisely why it needs a check that can fail.
  r.f.__leak = r.resid + (rnd() - 0.5) * 260;
}

// --- statistics --------------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function spearman(a, b) {
  const rk = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const out = new Array(arr.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
      i = j + 1;
    }
    return out;
  };
  const ra = rk(a), rb = rk(b), ma = mean(ra), mb = mean(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
const erf = (x) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const pValue = (rho, n) => (n < 10 || Math.abs(rho) >= 1) ? 1 : 2 * (1 - 0.5 * (1 + erf(Math.abs(Math.atanh(rho) * Math.sqrt(n - 3)) / Math.SQRT2)));

for (const POS of ["K", "DST"]) {
  const g0 = scored.filter((r) => r.pos === POS);
  const keys = [...new Set(g0.flatMap((r) => Object.keys(r.f)))].sort();
  const res = [];
  for (const key of keys) {
    const g = g0.filter((r) => r.f[key] != null && Number.isFinite(r.f[key]));
    if (g.length < 100 || new Set(g.map((r) => r.f[key])).size < 8) continue;
    const rho = spearman(g.map((r) => r.f[key]), g.map((r) => r.resid));
    res.push({ key, n: g.length, rho, p: pValue(rho, g.length) });
  }
  const FDR = 0.10;
  const byP = [...res].sort((a, b) => a.p - b.p);
  let cut = 0;
  byP.forEach((r, i) => { if (r.p <= ((i + 1) / byP.length) * FDR) cut = i + 1; });
  const pass = new Set(byP.slice(0, cut).map((r) => r.key));
  res.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));

  console.log(`\n${"=".repeat(84)}`);
  console.log(`${POS} -- ${res.length} candidates vs ${g0.length} out-of-sample errors, BH-FDR ${FDR}`);
  console.log(`${"=".repeat(84)}`);
  console.log("  feature                     n        rho          p     survives");
  for (const r of res) {
    const label = r.key === "__random" ? "RANDOM (neg control)" : r.key === "__leak" ? "LEAK (pos control)" : r.key;
    console.log(`  ${label.padEnd(26)} ${String(r.n).padStart(4)} ${((r.rho >= 0 ? "+" : "") + r.rho.toFixed(3)).padStart(9)} ` +
      `${(r.p < 1e-4 ? r.p.toExponential(1) : r.p.toFixed(4)).padStart(10)}   ${pass.has(r.key) ? "YES" : ""}`);
  }
  const neg = res.find((r) => r.key === "__random"), pos = res.find((r) => r.key === "__leak");
  console.log(`\n  CONTROLS`);
  console.log(`    negative: ${neg ? (pass.has("__random") ? "*** SURVIVED -- screen is broken, ignore everything above ***" : `rho ${neg.rho.toFixed(3)}, correctly rejected`) : "absent"}`);
  console.log(`    positive: ${pos ? (pass.has("__leak") ? `rho ${pos.rho.toFixed(3)}, detected -- the screen CAN see a signal at ${POS}` : "*** NOT DETECTED -- this screen cannot find a signal it was handed; a null result here means nothing ***") : "absent"}`);
  const real = res.filter((r) => pass.has(r.key) && !r.key.startsWith("__"));
  console.log(`\n  ${real.length} real survivor(s): ${real.map((r) => `${r.key} (${r.rho >= 0 ? "+" : ""}${r.rho.toFixed(3)})`).join(", ") || "none"}`);
}

console.log(`
${"-".repeat(84)}
Both positions are 'unfitted' in the variance model and have no age curve and no opportunity model,
so anything surviving here is the first fitted signal either has ever had. Given kdst-leverage puts
K second only to QB in how much its occupant swings our title odds, that is worth the nested-CV
evaluation -- with the same expectation as everywhere else, that roughly half the apparent lift
survives an evaluation that cannot see the selection.`);
