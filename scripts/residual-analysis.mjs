// WHERE IS THE MODEL WRONG? Error analysis, which is how you find the next feature instead of
// guessing at one.
//
//   node --import tsx scripts/residual-analysis.mjs
//
// Every feature in this projection was found the same way: someone had an idea, we tested it, and it
// either cleared the bar or did not. Age, opportunity shares, efficiency, contract data, expert
// disagreement. That is guess-and-check, and it has two costs -- the ideas come from whatever we
// happened to read, and each test spends the same evidence budget whether the idea was promising or
// not.
//
// Error analysis inverts it. Take the model's OUT-OF-SAMPLE residuals, and ask which slices of the
// data it is systematically wrong about. A slice with a large, consistent bias is a statement that
// something real is missing and unmodelled there; a slice with large but ZERO-MEAN error is just
// noise and no feature will fix it. The first is worth chasing, the second is the ceiling.
//
// The residuals here come from NESTED CV -- refit per fold -- so they are honest errors rather than
// a replay of decisions that already saw the test seasons.
import { readFileSync } from "node:fs";

const POS = ["QB", "RB", "WR", "TE"];
const tot = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) tot.set(`${Number(s)}|${name}`, { pos, pts: Number(pts), name, season: Number(s) });
}
const seasons = [...new Set([...tot.values()].map((v) => v.season))].sort().filter((s) => s >= 2007);
const rank = new Map();
for (const s of seasons.concat([seasons[0] - 1])) {
  for (const pos of POS) {
    [...tot.entries()].filter(([, v]) => v.season === s && v.pos === pos)
      .sort((a, b) => b[1].pts - a[1].pts).forEach(([k], i) => rank.set(k, i + 1));
  }
}
const birth = new Map();
try {
  const age = JSON.parse(readFileSync("data/age-curve.json", "utf8"));
  for (const [key, y] of Object.entries(age.birthYear ?? {})) birth.set(key.slice(key.indexOf("|") + 1), y);
} catch { /* age slice will be empty and says so */ }
const usage = new Map();
try {
  const opp = JSON.parse(readFileSync("data/opportunity-model.json", "utf8"));
  for (const [k, u] of Object.entries(opp.players ?? {})) usage.set(k, u);
} catch { /* same */ }

const rows = [];
for (const v of tot.values()) {
  if (!seasons.includes(v.season)) continue;
  const r = rank.get(`${v.season - 1}|${v.name}`);
  if (!r || r > 60) continue;
  const prior = tot.get(`${v.season - 1}|${v.name}`);
  rows.push({
    season: v.season, pos: v.pos, name: v.name, y: v.pts, rank: r,
    priorPts: prior ? prior.pts : 0,
    age: birth.has(v.name) ? v.season - birth.get(v.name) : null,
    use: usage.get(`${v.season - 1}|${v.name}`) ?? null,
  });
}

// --- the shipped model, refit per fold, producing honest residuals --------------------------------
function fitCurve(train) {
  const curve = {};
  for (const pos of POS) {
    const byRank = new Map();
    for (const r of train) { if (r.pos !== pos) continue; if (!byRank.has(r.rank)) byRank.set(r.rank, []); byRank.get(r.rank).push(r.y); }
    curve[pos] = new Map([...byRank].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  }
  return curve;
}
const curveAt = (curve, pos, rk) => {
  const m = curve[pos];
  if (!m?.size) return null;
  if (m.has(rk)) return m.get(rk);
  let best = null, bd = Infinity;
  for (const [k, v] of m) { const d = Math.abs(k - rk); if (d < bd) { bd = d; best = v; } }
  return best;
};
for (const hold of seasons) {
  const train = rows.filter((r) => r.season !== hold);
  if (train.length < 200) continue;
  const curve = fitCurve(train);
  for (const r of rows.filter((x) => x.season === hold)) {
    r.pred = curveAt(curve, r.pos, r.rank) ?? 0;
    r.resid = r.y - r.pred;                      // positive = we UNDER-projected him
  }
}
// --- the SHIPPED model: the same curve with the age and opportunity factors applied ----------------
// Two residuals per player, so every slice can be read as "was this already fixed".
//
// CAVEAT, and it runs the wrong way: both factors were fitted on all seasons, so applying them here
// leaks. That makes the shipped model look BETTER than it is, which biases this analysis toward
// declaring a slice solved. A slice that still shows bias after the leak is therefore a strong
// finding; a slice that goes quiet is only suggestive.
const { ageFactor } = await import("../src/draft/age.ts");
const { opportunityFactor } = await import("../src/draft/opportunity.ts");
let ageCurve = null, oppModel = null;
try { ageCurve = JSON.parse(readFileSync("data/age-curve.json", "utf8")); } catch { /* reported below */ }
try { oppModel = JSON.parse(readFileSync("data/opportunity-model.json", "utf8")); } catch { /* same */ }
for (const r of rows) {
  if (r.pred == null) continue;
  const af = ageCurve ? ageFactor(ageCurve, r.name, r.pos, r.season) : 1;
  const of = oppModel ? opportunityFactor(oppModel, r.name, r.pos, r.rank, r.season) : 1;
  r.predFull = r.pred * af * of;
  r.residFull = r.y - r.predFull;
}
const scored = rows.filter((r) => r.pred != null && r.pred > 20);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

console.log(`${scored.length} out-of-sample predictions from ${seasons.length} seasons\n`);
console.log("BIAS BY SLICE -- a large |mean residual| means something real is missing there.");
console.log("A large SD with a mean near zero is irreducible noise, and no feature will fix it.\n");
console.log("  RANK ONLY = the bare curve. SHIPPED = with the age and opportunity factors applied.");
console.log("  A slice biased under RANK ONLY but not SHIPPED is a feature we already built.");
console.log("  A slice still biased under SHIPPED is what is left to find.\n");
console.log("  slice                     n   --- RANK ONLY ---   ---- SHIPPED ----");
console.log("                                  mean       t        mean       t");

function slice(label, sel) {
  const g = scored.filter(sel);
  if (g.length < 40) return;
  const stat = (f) => {
    const a = g.map(f), m = mean(a), s = sd(a);
    return { m, t: m / (s / Math.sqrt(g.length)) };
  };
  const b = stat((r) => r.resid), f = stat((r) => r.residFull);
  const flag = Math.abs(f.t) > 3 ? "  <- STILL SYSTEMATIC" : (Math.abs(b.t) > 3 ? "  (fixed by a shipped feature)" : "");
  console.log(`  ${label.padEnd(24)} ${String(g.length).padStart(5)} ${b.m.toFixed(1).padStart(10)} ${b.t.toFixed(1).padStart(7)}  ${f.m.toFixed(1).padStart(10)} ${f.t.toFixed(1).padStart(7)}${flag}`);
}
for (const pos of POS) slice(`pos ${pos}`, (r) => r.pos === pos);
console.log();
for (const [lo, hi] of [[1, 6], [7, 12], [13, 24], [25, 40], [41, 60]]) slice(`rank ${lo}-${hi}`, (r) => r.rank >= lo && r.rank <= hi);
console.log();
for (const [lo, hi, lbl] of [[21, 24, "age 21-24"], [25, 27, "age 25-27"], [28, 30, "age 28-30"], [31, 40, "age 31+"]]) {
  slice(lbl, (r) => r.age != null && r.age >= lo && r.age <= hi);
}
console.log();
// Prior-season games is a proxy for "was he hurt last year", which the rank cannot express: a player
// who finished RB20 in nine games is a different bet from one who did it in seventeen.
for (const [lo, hi, lbl] of [[0, 0.4, "prior use: none/low"], [0.4, 1.2, "prior use: light"], [1.2, 2.5, "prior use: normal"], [2.5, 99, "prior use: heavy"]]) {
  slice(lbl, (r) => r.use && r.use.fd >= lo && r.use.fd < hi);
}

// --- WHAT CORRELATES WITH THE ERROR? The efficient screen ------------------------------------------
// Testing a candidate against the TARGET re-measures what rank already explains. Testing it against
// the RESIDUAL asks only whether it knows something the model does not, which is the actual question
// and needs far less data to answer.
console.log(`\nCANDIDATE FEATURES vs THE RESIDUAL -- correlation with what we get WRONG.`);
console.log(`  (a candidate uncorrelated with the residual cannot help, whatever it explains on its own)`);
console.log(`\n  candidate                    n   rank-only  shipped`);
const pear = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};
const cands = [
  ["age", (r) => r.age],
  ["prior first downs/g", (r) => r.use?.fd],
  ["prior target share", (r) => r.use?.ts],
  ["prior season points", (r) => r.priorPts],
  ["rank itself (control)", (r) => r.rank],
];
for (const [label, f] of cands) {
  const g = scored.filter((r) => f(r) != null && Number.isFinite(f(r)));
  if (g.length < 100) continue;
  const c = pear(g.map(f), g.map((r) => r.resid));
  const cf = pear(g.map(f), g.map((r) => r.residFull));
  const flag = Math.abs(cf) > 0.06 ? "  <- SIGNAL THE SHIPPED MODEL STILL LACKS"
    : Math.abs(c) > 0.06 ? "  (absorbed by a shipped feature)" : "  (nothing there)";
  console.log(`  ${label.padEnd(28)} ${String(g.length).padStart(5)}   ${(c >= 0 ? "+" : "") + c.toFixed(3)}   ${(cf >= 0 ? "+" : "") + cf.toFixed(3)}${flag}`);
}

// --- IS THE SURVIVING SLICE A MEAN SHIFT OR A TAIL? ------------------------------------------------
// This distinction decides what to build. If young players beat the curve ON AVERAGE, the fix is a
// bigger age multiplier -- a one-line change to an existing model. If instead the MEDIAN young player
// is projected correctly and the mean is dragged up by a handful of breakouts, then no multiplier can
// fix it: the miss is in the SHAPE of the distribution, and the simulator (which samples from
// rank-keyed pools) is drawing young players from a distribution with too thin a right tail.
console.log(`\nTHE SURVIVING SLICE: mean shift, or right tail?`);
console.log(`\n  age band     n     mean    median   p90 resid   share beating proj`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * q)]; };
for (const [lo, hi, lbl] of [[21, 24, "21-24"], [25, 27, "25-27"], [28, 30, "28-30"], [31, 40, "31+"]]) {
  const g = scored.filter((r) => r.age != null && r.age >= lo && r.age <= hi);
  if (g.length < 40) continue;
  const rs = g.map((r) => r.residFull);
  const beat = rs.filter((x) => x > 0).length / rs.length;
  console.log(`  ${lbl.padEnd(10)} ${String(g.length).padStart(5)} ${mean(rs).toFixed(1).padStart(8)} ${median(rs).toFixed(1).padStart(8)} ${pct(rs, 0.9).toFixed(1).padStart(10)} ${(100 * beat).toFixed(0).padStart(15)}%`);
}
// Which position carries it -- a slice driven by one position is a narrower and cheaper fix than one
// spread across all four.
console.log(`\n  age 21-24 by position (shipped-model residual):`);
for (const pos of POS) {
  const g = scored.filter((r) => r.pos === pos && r.age != null && r.age >= 21 && r.age <= 24);
  if (g.length < 40) continue;
  const rs = g.map((r) => r.residFull);
  const t = mean(rs) / (sd(rs) / Math.sqrt(rs.length));
  console.log(`    ${pos.padEnd(5)} n=${String(g.length).padStart(4)}  mean ${mean(rs).toFixed(1).padStart(6)}  median ${median(rs).toFixed(1).padStart(6)}  t ${t.toFixed(1).padStart(5)}`);
}

console.log(`
HOW A DATA SCIENTIST USES THIS.

1. A SYSTEMATIC slice is a missing feature with a known address. "We under-project 21-24 year olds by
   12 points" tells you what to build; "try adding snap counts" does not.
2. A slice with huge SD and zero mean is the CEILING. No feature fixes it, and effort there is spent.
3. The residual correlations are a SCREEN, not a result. A candidate that does not correlate with the
   error cannot help no matter how good it looks against the target -- so it can be dropped before
   spending a proper nested-CV evaluation on it.
4. Anything that survives the screen still has to clear nested CV, because a correlation found by
   looking at the residuals of the same data is exactly the selection effect measured earlier: the
   age curve and opportunity model both came in at roughly HALF their claimed lift once the
   evaluation stopped seeing the selection.`);
