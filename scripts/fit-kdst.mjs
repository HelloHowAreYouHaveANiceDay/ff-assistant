// FIT THE FIRST K AND DST MODEL THIS SYSTEM HAS EVER HAD.
//
//   node --import tsx scripts/fit-kdst.mjs [--write]
//
// Both positions are `unfitted` in the variance model, have no age curve and no opportunity model:
// the projection for a kicker is his rank-curve value and nothing else. scripts/kdst-sweep.mjs found
// signal at both, and scripts/kdst-leverage.mjs says the K slot swings more title probability than
// any position on our roster except QB, so the signal is worth converting into a multiplier.
//
// The shape copies the opportunity model deliberately -- features RELATIVE TO THE RANK BUCKET, a
// per-position amplitude scaled to that position's own measured lift, a multiplier of exactly 1
// wherever the inputs are missing -- because those three choices are what stopped that model from
// double-counting the rank, from giving its widest swing to its weakest signal, and from guessing.
//
// THE NUMBER THAT MATTERS IS THE NESTED ONE. Both existing models were claimed at roughly double
// their real lift (age +0.0154 claimed, +0.0069 measured; opportunity +0.0186 claimed, +0.0095
// measured) because the loop that scored them had also chosen them. These features were chosen by
// reading a screen that saw every season, so a plain leave-one-season-out number here would repeat
// exactly that error. The nested figure below re-runs the SELECTION inside each fold: for every
// held-out season, the candidate ranking, the choice of which features to use, and the fit are all
// redone on the training seasons alone. The gap between the two columns IS the selection effect,
// measured rather than argued about.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv, playerWeekUrl, teamWeekUrl, canonTeam, URLS } from "../src/data/nflverse.ts";

const WRITE = process.argv.includes("--write");
const SEASONS = Array.from({ length: 20 }, (_, i) => 2006 + i);
const BUCKET = 6, MAX_RANK = 40;
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

// --- rank curve + cases ----------------------------------------------------------------------------
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
// The rank curve itself: mean points by rank, per position, over all seasons.
const curve = {};
for (const pos of ["K", "DST"]) {
  const lists = seasons.map((s) => [...tot.values()].filter((v) => v.season === s && v.pos === pos).map((v) => v.pts).sort((a, b) => b - a));
  const maxlen = Math.max(0, ...lists.map((l) => l.length));
  curve[pos] = [];
  for (let k = 0; k < maxlen; k++) {
    let sum = 0, c = 0;
    for (const l of lists) if (k < l.length) { sum += l[k]; c++; }
    curve[pos][k] = c ? sum / c : 0;
  }
}

// --- features (same derivations as kdst-sweep, kept in step) ----------------------------------------
console.log("aggregating ...");
const kFeat = new Map(), dFeat = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  try {
    const raw = await csv(playerWeekUrl(yr), `pw-${yr}`);
    const agg = new Map();
    for (const r of raw) {
      if (r.season_type !== "REG" || (r.position || "").toUpperCase() !== "K") continue;
      const name = (r.player_display_name || "").trim(); if (!name) continue;
      let a = agg.get(name); if (!a) { a = { g: 0 }; agg.set(name, a); }
      a.g += 1;
      const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
      add("att", N(r.fg_att)); add("made", N(r.fg_made));
      add("patAtt", N(r.pat_att)); add("patMade", N(r.pat_made));
      a.long = Math.max(a.long ?? 0, N(r.fg_long));
      for (const b of ["20_29", "30_39", "40_49", "50_59", "60_"]) {
        add(`a${b}`, N(r[`fg_made_${b}`]) + N(r[`fg_missed_${b}`]));
        add(`m${b}`, N(r[`fg_made_${b}`]));
      }
    }
    for (const [name, a] of agg) {
      if (a.g < 4) continue;
      const long = (a.a50_59 ?? 0) + (a.a60_ ?? 0);
      kFeat.set(`${yr}|${name}`, {
        longAttRate: a.att > 0 ? long / a.att : null,
        patPct: a.patAtt > 0 ? a.patMade / a.patAtt : null,
        midPct: a.a30_39 > 0 ? a.m30_39 / a.a30_39 : null,
        fortyPct: a.a40_49 > 0 ? a.m40_49 / a.a40_49 : null,
        fgLong: a.long || null,
        fgAtt: a.att / a.g,
      });
    }
  } catch { /* season absent upstream */ }
  try {
    const raw = await csv(teamWeekUrl(yr), `tw-${yr}`);
    const agg = new Map();
    for (const r of raw) {
      if (r.season_type !== "REG") continue;
      const t = canonTeam((r.team || r.recent_team || "").trim()); if (!t) continue;
      let a = agg.get(t); if (!a) { a = { g: 0 }; agg.set(t, a); }
      a.g += 1;
      const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
      add("sack", N(r.def_sacks)); add("int", N(r.def_interceptions)); add("fum", N(r.def_fumbles));
      add("qbh", N(r.def_qb_hits)); add("tfl", N(r.def_tackles_for_loss));
    }
    for (const [t, a] of agg) dFeat.set(`${yr}|${t}`, {
      tacklesForLoss: a.tfl / a.g,
      pressure: (a.sack + a.qbh + a.tfl) / a.g,
      sacks: a.sack / a.g,
      takeaways: (a.int + a.fum) / a.g,
    });
  } catch { /* same */ }
}
const env = new Map(), market = new Map(), pa = new Map();
{
  const games = await csv(URLS.schedules, "schedules");
  const ea = new Map(), pp = new Map();
  for (const g of games) {
    if (g.game_type !== "REG") continue;
    const season = Number(g.season), wk = Number(g.week);
    for (const side of ["home", "away"]) {
      const t = canonTeam((g[`${side}_team`] || "").trim()); if (!t) continue;
      let a = ea.get(`${season}|${t}`);
      if (!a) { a = { g: 0, wind: 0, windN: 0, temp: 0, tempN: 0 }; ea.set(`${season}|${t}`, a); }
      a.g += 1;
      if (g.wind !== "" && g.wind != null) { a.wind += N(g.wind); a.windN += 1; }
      if (g.temp !== "" && g.temp != null) { a.temp += N(g.temp); a.tempN += 1; }
      let p = pp.get(`${season}|${t}`); if (!p) { p = { g: 0, pts: 0 }; pp.set(`${season}|${t}`, p); }
      p.g += 1; p.pts += N(g[side === "home" ? "away_score" : "home_score"]);
      if (wk === 1 && g.spread_line !== "" && g.total_line !== "") {
        const spread = N(g.spread_line) * (side === "home" ? 1 : -1), total = N(g.total_line);
        market.set(`${season}|${t}`, { vegasImpliedPts: total / 2 + spread / 2, vegasSpread: spread });
      }
    }
  }
  for (const [k, a] of ea) env.set(k, { avgWind: a.windN ? a.wind / a.windN : null, avgTemp: a.tempN ? a.temp / a.tempN : null });
  for (const [k, p] of pp) pa.set(k, p.g ? p.pts / p.g : null);
}
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

// Candidates offered to the selector. The nested loop picks from THIS list per fold; the list itself
// is the one place the whole-data screen still shows through, and it is deliberately wider than the
// features that survived it so the selector has something to reject.
const CAND = {
  K: ["longAttRate", "patPct", "midPct", "fortyPct", "fgLong", "fgAtt", "avgWind", "vegasImpliedPts"],
  DST: ["vegasImpliedPts", "vegasSpread", "tacklesForLoss", "avgTemp", "pressure", "sacks", "takeaways", "pointsAllowedPrior"],
};
const NPICK = { K: 2, DST: 3 };

const cases = { K: [], DST: [] };
for (const v of tot.values()) {
  if (!seasons.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > MAX_RANK) continue;
  const pred = curve[v.pos]?.[r - 1];
  if (!pred || pred < 20) continue;
  const prev = v.season - 1;
  const team = v.pos === "DST" ? canonTeam(v.name.split(" ")[0]) : kTeam.get(`${prev}|${v.name}`);
  const own = v.pos === "DST" ? dFeat.get(`${prev}|${team}`) : kFeat.get(`${prev}|${v.name}`);
  if (!own) continue;
  const f = {
    ...own,
    ...(team ? env.get(`${prev}|${team}`) ?? {} : {}),
    ...(team ? market.get(`${v.season}|${team}`) ?? {} : {}),
    pointsAllowedPrior: team ? pa.get(`${prev}|${team}`) ?? null : null,
  };
  cases[v.pos].push({ season: v.season, pos: v.pos, name: v.name, rank: r, ratio: v.pts / pred, f });
}

// --- relative-to-bucket normalisation ----------------------------------------------------------------
// Without it a model re-learns the rank. A DST1's pressure rate is high BECAUSE he is a DST1, which
// the rank already prices; what carries new information is being above what his rank usually shows.
const bucketOf = (r) => Math.floor((r - 1) / BUCKET);
const bmean = {};
for (const pos of ["K", "DST"]) {
  bmean[pos] = {};
  for (const b of new Set(cases[pos].map((x) => bucketOf(x.rank)))) {
    const inB = cases[pos].filter((x) => bucketOf(x.rank) === b);
    bmean[pos][b] = {};
    for (const c of CAND[pos]) {
      const vals = inB.map((x) => x.f[c]).filter((v) => v != null && Number.isFinite(v));
      bmean[pos][b][c] = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
    }
  }
}
const relOf = (pos, x, c, means) => {
  const m = (means ?? bmean[pos])[bucketOf(x.rank)]?.[c];
  const v = x.f[c];
  if (v == null || !Number.isFinite(v) || m == null || Math.abs(m) < 1e-6) return 1;
  return v / m;
};

// --- linear algebra ------------------------------------------------------------------------------------
function ols(rowsX, y) {
  const p = rowsX[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), t = new Array(p).fill(0);
  for (let i = 0; i < rowsX.length; i++) for (let a = 0; a < p; a++) { t[a] += rowsX[i][a] * y[i]; for (let b = 0; b < p; b++) A[a][b] += rowsX[i][a] * rowsX[i][b]; }
  for (let a = 0; a < p; a++) A[a][a] += 1e-6;
  const M = A.map((row, i) => [...row, t[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}
const design = (data, pos, feats, means) => data.map((x) => [1, ...feats.map((c) => relOf(pos, x, c, means))]);
const corrAbs = (a, b) => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? Math.abs(n / Math.sqrt(da * db)) : 0;
};

// --- the two lifts ---------------------------------------------------------------------------------------
// NAIVE: features fixed in advance (i.e. chosen on all seasons), one season held out.
// NESTED: the selection itself repeated inside each fold, on training data only.
function lift(pos, { nested }) {
  const data = cases[pos];
  let ssRank = 0, ssFull = 0, sst = 0;
  const picks = [];
  for (const hold of seasons) {
    const tr = data.filter((x) => x.season !== hold), te = data.filter((x) => x.season === hold);
    if (tr.length < 60 || !te.length) continue;

    // Bucket means must ALSO come from training only, or the normalisation leaks the held-out season.
    const bm = {};
    for (const b of new Set(tr.map((x) => bucketOf(x.rank)))) {
      const inB = tr.filter((x) => bucketOf(x.rank) === b);
      bm[b] = {};
      for (const c of CAND[pos]) {
        const vals = inB.map((x) => x.f[c]).filter((v) => v != null && Number.isFinite(v));
        bm[b][c] = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
      }
    }
    let feats;
    if (nested) {
      // Re-run the screen on the training seasons alone and take the top NPICK. This is the step a
      // plain LOSO skips, and skipping it is what made both existing models look twice as good as
      // they are.
      const y = tr.map((x) => x.ratio);
      feats = [...CAND[pos]]
        .map((c) => ({ c, r: corrAbs(tr.map((x) => relOf(pos, x, c, bm)), y) }))
        .sort((a, b) => b.r - a.r).slice(0, NPICK[pos]).map((x) => x.c);
      picks.push(feats.join("+"));
    } else {
      feats = SHIPPED[pos];
    }
    const bFull = ols(design(tr, pos, feats, bm), tr.map((x) => x.ratio));
    const mean = tr.reduce((a, x) => a + x.ratio, 0) / tr.length;
    for (const x of te) {
      const row = [1, ...feats.map((c) => relOf(pos, x, c, bm))];
      const pr = row.reduce((a, v, i) => a + v * bFull[i], 0);
      ssFull += (x.ratio - pr) ** 2;
      ssRank += (x.ratio - mean) ** 2;   // rank-only baseline: the curve, i.e. ratio ~ constant
      sst += (x.ratio - mean) ** 2;
    }
  }
  return { r2: 1 - ssFull / sst, base: 1 - ssRank / sst, picks };
}

// What ships: the features the whole-data screen chose. The nested number is what they are WORTH.
const SHIPPED = {
  K: ["longAttRate", "patPct"],
  DST: ["vegasImpliedPts", "tacklesForLoss", "avgTemp"],
};

// --- CAN THIS HARNESS DETECT A LIFT AT ALL? -----------------------------------------------------------
// A null result is only informative from an instrument known to be able to return a non-null one.
// Everything below reports "no signal", which is also exactly what a mis-wired normalisation, a
// broken join or a design matrix of constants would report. So: hand the same loop a feature built
// from the answer, and require it to find it. If this does not light up, no other number here means
// anything.
for (const pos of ["K", "DST"]) {
  for (const x of cases[pos]) x.f.__leak = x.ratio + (Math.random() - 0.5) * 0.9;
  CAND[pos].push("__leak");
  for (const b of Object.keys(bmean[pos])) {
    const inB = cases[pos].filter((x) => bucketOf(x.rank) === Number(b));
    bmean[pos][b].__leak = inB.reduce((a, x) => a + x.f.__leak, 0) / inB.length;
  }
}
console.log(`\nHARNESS CONTROL -- a feature built from the answer, which the loop MUST find`);
for (const pos of ["K", "DST"]) {
  const saved = SHIPPED[pos];
  SHIPPED[pos] = ["__leak"];
  const r = lift(pos, { nested: false });
  SHIPPED[pos] = saved;
  const ok = r.r2 > 0.2;
  console.log(`  ${pos.padEnd(4)} R2 ${r.r2.toFixed(4)} -- ${ok ? "detected, the fit loop works" : "*** NOT DETECTED: the harness is broken and every number below is void ***"}`);
}
for (const pos of ["K", "DST"]) {
  CAND[pos] = CAND[pos].filter((c) => c !== "__leak");
  for (const x of cases[pos]) delete x.f.__leak;
  for (const b of Object.keys(bmean[pos])) delete bmean[pos][b].__leak;
}

console.log(`\n${"=".repeat(78)}`);
console.log("HONEST LIFT -- selection outside the fold vs selection inside it");
console.log(`${"=".repeat(78)}`);
console.log("  pos     n     naive R2    NESTED R2    selection effect");
const AMP = {};
for (const pos of ["K", "DST"]) {
  const naive = lift(pos, { nested: false }), nest = lift(pos, { nested: true });
  AMP[pos] = Math.max(0, nest.r2);
  console.log(`  ${pos.padEnd(5)} ${String(cases[pos].length).padStart(5)}   ${naive.r2.toFixed(4).padStart(9)}   ${nest.r2.toFixed(4).padStart(10)}   ${(naive.r2 - nest.r2 >= 0 ? "-" : "+")}${Math.abs(naive.r2 - nest.r2).toFixed(4)}`);
  const freq = {};
  for (const p of nest.picks) freq[p] = (freq[p] ?? 0) + 1;
  const stable = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  console.log(`         features chosen per fold: ${stable.map(([k, v]) => `${k} x${v}`).join(", ")}`);
  console.log(`         shipping: ${SHIPPED[pos].join(" + ")}`);
}

// Amplitude scaled to each position's own nested lift, relative to the LARGER of the two -- the rule
// the age curve had to learn twice, so the position with the weaker signal cannot get the wider swing.
const MAXA = Math.max(...Object.values(AMP)) || 1;
const amplitude = Object.fromEntries(["K", "DST"].map((p) => [p, AMP[p] > 0 ? AMP[p] / MAXA : 0]));

// --- final fit on everything ---------------------------------------------------------------------------
const model = {
  fittedFrom: "fit-kdst.mjs", bucket: BUCKET, maxRank: MAX_RANK, seasons,
  amplitude, nestedLift: AMP, features: SHIPPED, pos: {}, bucketMeans: bmean, players: {},
};
console.log(`\nFITTED COEFFICIENTS (on the ratio actual/rank-predicted), normalised to mean 1.0`);
for (const pos of ["K", "DST"]) {
  const sub = cases[pos];
  if (amplitude[pos] <= 0 || sub.length < 120) { model.pos[pos] = null; console.log(`  ${pos}: flat -- no measured signal`); continue; }
  const feats = SHIPPED[pos];
  const b = ols(design(sub, pos, feats), sub.map((x) => x.ratio));
  const val = (rels) => b[0] + rels.reduce((a, v, i) => a + v * b[i + 1], 0);
  const mean = sub.reduce((a, x) => a + val(feats.map((c) => relOf(pos, x, c))), 0) / sub.length;
  model.pos[pos] = { b, feats, mean, amp: amplitude[pos] };
  const f = (m) => {
    const shape = Math.max(0.8, Math.min(1.2, val(feats.map(() => m)) / (mean || 1)));
    return 1 + (shape - 1) * amplitude[pos];
  };
  console.log(`  ${pos.padEnd(4)} amp ${(100 * amplitude[pos]).toFixed(0)}%  coefs ${b.map((x) => x.toFixed(3)).join(", ")}`);
  console.log(`        factor at 0.8x / 1.0x / 1.2x of bucket-normal: ${f(0.8).toFixed(3)} / ${f(1.0).toFixed(3)} / ${f(1.2).toFixed(3)}`);
}

// Bake per-season feature values so the consumer never makes a network call -- the same contract as
// the age curve and the opportunity model.
for (const pos of ["K", "DST"]) {
  for (const x of cases[pos]) {
    const key = `${x.season - 1}|${x.name}`;
    if (model.players[key]) continue;
    const kept = {};
    for (const c of SHIPPED[pos]) if (x.f[c] != null && Number.isFinite(x.f[c])) kept[c] = Math.round(x.f[c] * 10000) / 10000;
    if (Object.keys(kept).length) model.players[key] = { pos, ...kept };
  }
}
// The CURRENT season's inputs too, which the cases loop cannot produce (this season has no outcome
// yet, so it is not a case) -- without these the live board gets a factor of 1 for everyone.
const latest = Math.max(...seasons);
for (const [k, v] of kFeat) if (k.startsWith(`${latest}|`) && !model.players[k]) {
  const kept = {}; for (const c of SHIPPED.K) if (v[c] != null && Number.isFinite(v[c])) kept[c] = Math.round(v[c] * 10000) / 10000;
  if (Object.keys(kept).length) model.players[k] = { pos: "K", ...kept };
}
console.log(`\nbaked ${Object.keys(model.players).length} prior-season feature rows`);

if (WRITE) {
  writeFileSync("data/kdst-model.json", JSON.stringify(model));
  console.log("wrote data/kdst-model.json");
} else {
  console.log("(dry run -- pass --write to save)");
}
