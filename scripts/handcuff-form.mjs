// WHICH FUNCTIONAL FORM does the handcuff bump actually take? This decides the targeting strategy,
// so it is measured rather than picked.
//
//   node --import tsx scripts/handcuff-form.mjs
//
// Three candidate models for what a backup scores in a week his lead back misses:
//
//   ADDITIVE      backup_out = backup_in + c          the bump is a constant, same for everyone
//   MULTIPLICATIVE backup_out = backup_in * k         the bump scales with the backup's own role
//   INHERITANCE   backup_out = f * lead_in            he inherits a fraction of the STARTER's role
//
// They are not interchangeable and they imply opposite strategies. Under ADDITIVE, whose backup you
// own does not matter -- every handcuff is worth the same and you should buy the cheapest. Under
// INHERITANCE, the backup of an elite back is worth far more than the backup of a mediocre one,
// because he inherits a bigger job, and chasing elite handcuffs is correct.
//
// Scored out of sample by held-out SEASON, because the unit that generalises is the season: fitting
// and scoring on the same team-seasons would reward whichever form has the most freedom.
import { readFileSync } from "node:fs";

const L = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/);
const h = L[0].split(",");
const [SI, NI, PI, WI, YI, TI] = ["season", "name", "pos", "week", "points", "team"].map((c) => h.indexOf(c));

const byTeam = new Map(), early = new Map();
for (const line of L.slice(1)) {
  const f = line.split(",");
  if (f[PI] !== "RB" || !f[TI]) continue;
  const key = `${f[SI]}|${f[TI]}`;
  if (!byTeam.has(key)) byTeam.set(key, new Map());
  const wk = byTeam.get(key), w = Number(f[WI]), pts = Number(f[YI]) || 0;
  if (!wk.has(w)) wk.set(w, new Map());
  wk.get(w).set(f[NI], pts);
  if (w <= 4) early.set(`${f[SI]}|${f[NI]}`, (early.get(`${f[SI]}|${f[NI]}`) ?? 0) + pts);
}

// One row per (season, team, backup): his baseline with the lead in, the lead's own baseline, and
// what he actually scored with the lead out. Lead identified on WEEKS 1-4 only -- no hindsight.
const cases = [];
for (const [key, wk] of byTeam) {
  const [season] = key.split("|");
  const names = new Set();
  for (const m of wk.values()) for (const n of m.keys()) names.add(n);
  const ranked = [...names].sort((a, b) => (early.get(`${season}|${b}`) ?? 0) - (early.get(`${season}|${a}`) ?? 0));
  if (ranked.length < 2) continue;
  const lead = ranked[0], back = ranked[1];
  const backIn = [], backOut = [], leadIn = [];
  for (const [, m] of wk) {
    const lp = m.get(lead), bp = m.get(back);
    const leadPlayed = lp != null && lp > 0;
    if (leadPlayed) { leadIn.push(lp); if (bp != null) backIn.push(bp); }
    else if (bp != null) backOut.push(bp);
  }
  if (backIn.length < 4 || backOut.length < 2 || leadIn.length < 4) continue;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  cases.push({ season: Number(season), backIn: mean(backIn), leadIn: mean(leadIn), backOut: mean(backOut) });
}
const seasons = [...new Set(cases.map((c) => c.season))].sort();
console.log(`${cases.length} (season, team, backup) cases across ${seasons.length} seasons\n`);

// Out-of-sample: fit each form's single parameter on all seasons but one, score on the held-out one.
const MODELS = {
  "ADDITIVE       backup_in + c": {
    fit: (tr) => tr.reduce((a, c) => a + (c.backOut - c.backIn), 0) / tr.length,
    pred: (c, p) => c.backIn + p,
  },
  "MULTIPLICATIVE backup_in * k": {
    fit: (tr) => { const n = tr.reduce((a, c) => a + c.backIn * c.backOut, 0), d = tr.reduce((a, c) => a + c.backIn ** 2, 0); return d ? n / d : 1; },
    pred: (c, p) => c.backIn * p,
  },
  "INHERITANCE    f * lead_in": {
    fit: (tr) => { const n = tr.reduce((a, c) => a + c.leadIn * c.backOut, 0), d = tr.reduce((a, c) => a + c.leadIn ** 2, 0); return d ? n / d : 0; },
    pred: (c, p) => c.leadIn * p,
  },
  "BOTH           a*backup_in + b*lead_in": {
    fit: (tr) => {
      // 2x2 normal equations, no intercept
      let saa = 0, sab = 0, sbb = 0, say = 0, sby = 0;
      for (const c of tr) { saa += c.backIn ** 2; sab += c.backIn * c.leadIn; sbb += c.leadIn ** 2; say += c.backIn * c.backOut; sby += c.leadIn * c.backOut; }
      const det = saa * sbb - sab * sab;
      return det ? [(say * sbb - sby * sab) / det, (sby * saa - say * sab) / det] : [1, 0];
    },
    pred: (c, p) => c.backIn * p[0] + c.leadIn * p[1],
  },
};

console.log("OUT-OF-SAMPLE (hold out one season at a time), predicting the backup's points with the lead OUT");
console.log("  model                                 RMSE      R-sq     fitted parameter");
const gm = cases.reduce((a, c) => a + c.backOut, 0) / cases.length;
let sstAll = 0;
for (const c of cases) sstAll += (c.backOut - gm) ** 2;
for (const [name, M] of Object.entries(MODELS)) {
  let ss = 0;
  for (const hold of seasons) {
    const tr = cases.filter((c) => c.season !== hold), te = cases.filter((c) => c.season === hold);
    if (tr.length < 30 || !te.length) continue;
    const p = M.fit(tr);
    for (const c of te) ss += (c.backOut - M.pred(c, p)) ** 2;
  }
  const p = M.fit(cases);
  const ps = Array.isArray(p) ? p.map((x) => x.toFixed(3)).join(", ") : p.toFixed(3);
  console.log(`  ${name.padEnd(36)} ${Math.sqrt(ss / cases.length).toFixed(2).padStart(6)}  ${(1 - ss / sstAll).toFixed(3).padStart(7)}     ${ps}`);
}

// The decisive cut for STRATEGY: split by how good the lead back is. If the bump is a constant, the
// two halves gain the same amount and it does not matter whose backup you own.
const med = cases.map((c) => c.leadIn).sort((a, b) => a - b)[cases.length >> 1];
console.log(`\nDOES THE LEAD'S QUALITY MATTER? (median lead = ${med.toFixed(1)} pts/wk)`);
console.log("  lead tier          n    backup w/ lead in    backup w/ lead out     lift");
for (const [label, sel] of [["elite  (top half)", (c) => c.leadIn >= med], ["ordinary (bottom)", (c) => c.leadIn < med]]) {
  const g = cases.filter(sel);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const bi = mean(g.map((c) => c.backIn)), bo = mean(g.map((c) => c.backOut));
  console.log(`  ${label}  ${String(g.length).padStart(4)}  ${bi.toFixed(2).padStart(17)}  ${bo.toFixed(2).padStart(19)}   ${(bo - bi >= 0 ? "+" : "") + (bo - bi).toFixed(2)}`);
}
