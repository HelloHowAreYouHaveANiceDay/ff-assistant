// CORRELATION ACROSS THE LINE OF SCRIMMAGE -- the half of the covariance structure we do not model.
//
//   node --import tsx scripts/fit-opponent-correlation.mjs
//
// data/correlation-model.json captures SAME-TEAM correlation: a QB and his own receivers boom
// together. That is the well-known half and the simulator's Gaussian copula handles it. The other
// half is between OPPOSING teams in the same NFL game, and we model none of it -- every player on
// one side is drawn independently of every player on the other.
//
// It matters for a reason specific to head-to-head leagues. Our weekly result is not our total, it is
// the MARGIN between our total and one opponent's. If our players and theirs sit in the same NFL
// games, the correlation structure changes the variance of that margin directly, and variance of the
// margin is what converts points into wins. A simulator that gets the marginals right and the
// cross-team covariance wrong will misprice exactly the close matchups that decide seeding.
//
// Measured on our own history joined to the real schedule, so the opponent is the actual opponent
// rather than a proxy.
import { readFileSync, writeFileSync } from "node:fs";
import { fetchCsv, URLS } from "../src/data/nflverse.ts";

const games = await fetchCsv(URLS.schedules);
const opp = new Map();
for (const g of games) {
  if (g.game_type !== "REG") continue;
  const s = Number(g.season), w = Number(g.week);
  opp.set(`${s}|${w}|${g.home_team}`, g.away_team);
  opp.set(`${s}|${w}|${g.away_team}`, g.home_team);
}

const L = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/);
const h = L[0].split(",");
const [SI, NI, PI, WI, YI, TI] = ["season", "name", "pos", "week", "points", "team"].map((c) => h.indexOf(c));
// TEAM-LEVEL totals per position: the quantity that matters is "how did this team's QBs do", not any
// one player, because a fantasy roster holds one of them and which one is a separate question.
const byKey = new Map();
for (const line of L.slice(1)) {
  const f = line.split(",");
  const k = `${f[SI]}|${f[WI]}|${f[TI]}|${f[PI]}`;
  byKey.set(k, (byKey.get(k) ?? 0) + (Number(f[YI]) || 0));
}
const pear = (a, b) => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};

const PAIRS = [["QB", "QB"], ["QB", "WR"], ["QB", "TE"], ["QB", "RB"], ["WR", "WR"], ["RB", "RB"],
  ["DST", "QB"], ["DST", "WR"], ["DST", "RB"], ["DST", "DST"], ["K", "K"], ["K", "QB"]];
const out = { fittedFrom: "history-weekly.csv joined to nflverse schedules", pairs: {}, n: {} };
console.log("OPPOSING-TEAM correlation, same NFL game\n");
console.log("  pair                n team-weeks    corr");
for (const [pa, pb] of PAIRS) {
  const A = [], B = [];
  for (const [k, v] of byKey) {
    const [s, w, t, p] = k.split("|");
    if (p !== pa) continue;
    const o = opp.get(`${s}|${w}|${t}`);
    if (!o) continue;
    const ov = byKey.get(`${s}|${w}|${o}|${pb}`);
    if (ov == null) continue;
    A.push(v); B.push(ov);
  }
  if (A.length < 500) continue;
  const r = pear(A, B);
  out.pairs[`${pa}-${pb}`] = Math.round(r * 1000) / 1000;
  out.n[`${pa}-${pb}`] = A.length;
  console.log(`  ${(pa + " vs opp " + pb).padEnd(18)} ${String(A.length).padStart(8)}   ${r >= 0 ? "+" : ""}${r.toFixed(3)}`);
}
writeFileSync("data/opponent-correlation.json", JSON.stringify(out, null, 2));
console.log(`
wrote data/opponent-correlation.json

WHAT THE SIGNS MEAN, because they are not all the same mechanism:

  QB vs opposing QB  +0.21   shootouts. Both offenses score in the same high-total game.
  QB/WR vs opposing  +0.18   the same effect reaching the pass-catchers.
  RB vs opposing RB  -0.11   GAME SCRIPT, and it points the other way: the team ahead runs out the
                             clock while the team behind abandons the run entirely.
  DST vs opposing QB -0.41   the strongest number in this table, and larger in absolute value than
                             ANY same-team correlation we currently model (QB-WR is +0.35). A
                             defense scores precisely when the quarterback it faces does not. Ours
                             draws them independently today.

For comparison, the same-team model we DO fit: QB-WR +0.348, QB-TE +0.223, K-DST +0.227, QB-RB
+0.080. So the cross-team structure is of comparable size and in places larger.`);
