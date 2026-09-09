// DEPRECATED (copilot track, 2026-09-08). Superseded by:  ff copilot trade-finder
//   -- src/inseason/copilot.ts :: tradeFinder, also served as an MCP tool (docs/mcp.md).
//
// The computation moved into a callable FUNCTION rather than a program that prints and exits, so
// the desktop Assistant and any MCP client reach the same number this script prints -- which they
// could not do while it lived in a script. Every result now carries its assumptions (real vs
// generated schedule, trials, seeds, data stamp) in the returned JSON.
//
// KEPT, NOT DELETED: docs/validation.md and docs/edges.md cite figures this script produced, and a
// deleted script makes those citations unverifiable. Do not build anything new on it.
// TRADES THE OTHER MANAGER WOULD ACTUALLY CONSIDER, ranked by whether they help BOTH teams.
//
//   node --import tsx scripts/win-win.mjs [trials] [--maxGap 0.15]
//
// WHY THIS EXISTS. trade-odds filters for deals "the partner might take" by simulating HIS title
// probability and keeping the ones that cost him under a quarter of his own equity. That is the
// wrong instrument, and it produced Pittman -> McCaffrey as a headline recommendation: a WR4 for a
// top-five overall back. It passes the filter because the partner is already at 1.4% and has almost
// no equity left to lose, so the simulator shrugs. No human accepts that offer, and our own board
// says so -- the two players are about 4,700 consensus points apart.
//
// A manager does not evaluate an offer by simulating his season. He looks at what each side is worth
// on the consensus market and refuses anything lopsided. So acceptability is gated on CONSENSUS
// VALUE here (market_value.value, the KeepTradeCut-style 0-10,000 scale we already ingest), and the
// simulator is used only for the question it is actually good at: given a deal both sides would
// sign, does it help us -- and does it help them too?
//
// THAT PAIR IS THE WHOLE POINT. A genuine win-win is not a free lunch and does not require anyone to
// be fooled. It comes from ROSTER CONSTRUCTION: we carry six receivers for five effective slots and
// exactly one back, so our sixth receiver is worth almost nothing to us and a mid-tier back is worth
// a lot. A team in the opposite shape values them the other way round. Equal consensus value, both
// sides better off, nobody misled.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadSimContext } from "../src/draft/simContext.ts";
import { effectiveFormat } from "../src/league/index.ts";
import { rosterGaps } from "../src/draft/season.ts";
import { nameKey } from "../src/draft/values.ts";

const TRIALS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 2000);
const gapArg = process.argv.indexOf("--maxGap");
const MAX_GAP = gapArg > -1 ? Number(process.argv[gapArg + 1]) : 0.15;
const SEED = 7;

const ctx = await loadSimContext();
const { teams, meIdx, slots, flexOk } = ctx;

// --- consensus value ------------------------------------------------------------------------------
const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const valueOf = new Map();
for (const r of db.prepare("SELECT player_id, value FROM market_value").all()) {
  if (r.value != null) valueOf.set(r.player_id, Number(r.value));
}
// The board's own id is the join key everywhere else in this codebase; market_value uses the same.
// Fall back to a name key so a player present under one spelling is not silently valued at zero --
// which would make every trade involving him look like a steal.
const byName = new Map();
for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfg.season)) {
  const j = JSON.parse(r.row_json);
  const v = valueOf.get(r.player_id);
  if (v != null) byName.set(nameKey(j.Player), v);
}
db.close();
const val = (name) => byName.get(nameKey(name)) ?? null;

// --- candidates ------------------------------------------------------------------------------------
const mine = teams[meIdx].roster;
const cand = [];
let noValue = 0;
for (const give of mine) {
  const gv = val(give.name);
  if (gv == null) { noValue++; continue; }
  for (let ti = 0; ti < teams.length; ti++) {
    if (ti === meIdx) continue;
    for (const get of teams[ti].roster) {
      const tv = val(get.name);
      if (tv == null) continue;
      // BALANCED BY CONSENSUS. Symmetric: neither side may be getting materially the better of it,
      // because a deal that is a steal FOR US is exactly the one that never gets accepted.
      const gap = Math.abs(tv - gv) / Math.max(tv, gv);
      if (gap > MAX_GAP) continue;
      // Both rosters must still be legal afterwards.
      const a = mine.filter((p) => p.name !== give.name).concat([get]);
      const b = teams[ti].roster.filter((p) => p.name !== get.name).concat([give]);
      if (rosterGaps([{ id: "a", name: "us", roster: a }, { id: "b", name: teams[ti].name, roster: b }], slots, flexOk).length) continue;
      cand.push({ ti, give, get, gv, tv, gap });
    }
  }
}
console.log(`WIN-WIN SEARCH -- consensus values within ${(100 * MAX_GAP).toFixed(0)}%, ${TRIALS} trials, seed ${SEED}`);
if (noValue) console.log(`  (${noValue} of our players carry no market value and were skipped)`);
console.log(`  ${cand.length} balanced, legal one-for-one swaps\n`);
if (!cand.length) { console.log("  nothing within the value band -- widen it with --maxGap"); process.exit(0); }

// --- simulate ---------------------------------------------------------------------------------------
const { runPool, assertDeterministic } = await import("../src/draft/simPool.ts");
const poolInit = {
  baseTeams: teams, weeks: ctx.weeks, slots, flexOk, replacement: ctx.replacement,
  playoffTeams: effectiveFormat(cfg).playoffTeams,
  playoffReseed: effectiveFormat(cfg).playoffReseed, projSd: 0.30,
  poolRank: (() => {
    const byPos = {}, m = new Map();
    for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
      const f = line.split(",");
      if (!f[0] || !f[2]) continue;
      (byPos[f[1].trim().toUpperCase()] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
    }
    for (const l of Object.values(byPos)) { l.sort((a, b) => b.pts - a.pts); l.forEach((x, i) => m.set(x.name, { rank: i, of: l.length })); }
    return m;
  })(),
  varianceModelPath: "data/variance-model.json",
  outcomesPath: "data/rank-outcomes.json",
  corrPath: "data/correlation-model.json",
};
const jobs = cand.map((c, idx) => ({ idx, meIdx, theirIdx: c.ti, giveName: c.give.name, getName: c.get.name, trials: TRIALS, seed: SEED }));
process.stderr.write("  checking pool determinism ...\n");
await assertDeterministic(poolInit, jobs.slice(0, 8));
const t0 = Date.now();
const out = await runPool(poolInit, jobs, {
  onProgress: (d, t) => { if (d % 50 === 0 || d === t) process.stderr.write(`  ${d}/${t} (${((Date.now() - t0) / d).toFixed(0)}ms each)\n`); },
});

// Baselines from ONE call, so every delta is measured against the same sample.
const baseOdds = ctx.run(teams, TRIALS, SEED);
const baseMine = 100 * baseOdds[meIdx].champion;
const rows = cand.map((c, i) => ({
  ...c,
  dUs: out[i].mine - baseMine,
  dThem: out[i].theirs - 100 * baseOdds[c.ti].champion,
}));

// NOISE FLOOR, stated before anything is ranked. At these trial counts a single delta carries about
// this much error, and the anomaly scan in trade-odds flagged eight "structural" findings that were
// all inside it -- every one inverted or vanished at five times the trials.
const noise = 100 * Math.sqrt((baseMine / 100) * (1 - baseMine / 100) / TRIALS) * 1.4;
console.log(`  base ${baseMine.toFixed(2)}% -- a delta under about ${noise.toFixed(2)}pp is inside this run's own noise\n`);

const winwin = rows.filter((r) => r.dUs > noise && r.dThem > noise).sort((a, b) => (b.dUs + b.dThem) - (a.dUs + a.dThem));
console.log(`  BOTH SIDES BETTER OFF (${winwin.length}) -- balanced on value, positive for each team`);
console.log("  we give               we get                pos  partner        value gap      us      them");
for (const r of winwin.slice(0, 15)) {
  console.log(`  ${r.give.name.slice(0, 20).padEnd(20)}  ${r.get.name.slice(0, 20).padEnd(20)} ${r.get.pos.padEnd(4)} ${String(teams[r.ti].name).slice(0, 13).padEnd(13)} ` +
    `${(100 * r.gap).toFixed(0).padStart(6)}%  ${("+" + r.dUs.toFixed(2)).padStart(7)}pp ${((r.dThem >= 0 ? "+" : "") + r.dThem.toFixed(2)).padStart(7)}pp`);
}
if (!winwin.length) {
  console.log("  (none clear the noise floor on both sides -- raise the trial count before concluding they do not exist)");
}

const forUs = rows.filter((r) => r.dUs > noise).sort((a, b) => b.dUs - a.dUs);
console.log(`\n  BEST FOR US among balanced deals (${forUs.length} clear the noise floor)`);
console.log("  we give               we get                pos  partner        value gap      us      them");
for (const r of forUs.slice(0, 12)) {
  console.log(`  ${r.give.name.slice(0, 20).padEnd(20)}  ${r.get.name.slice(0, 20).padEnd(20)} ${r.get.pos.padEnd(4)} ${String(teams[r.ti].name).slice(0, 13).padEnd(13)} ` +
    `${(100 * r.gap).toFixed(0).padStart(6)}%  ${("+" + r.dUs.toFixed(2)).padStart(7)}pp ${((r.dThem >= 0 ? "+" : "") + r.dThem.toFixed(2)).padStart(7)}pp`);
}
console.log(`
  The value gap is what the OTHER manager sees. A deal at 5% is one he reads as fair; the
  Pittman -> McCaffrey deal trade-odds was recommending sits at 79%, which is why it was never
  going to be accepted whatever the simulator said about his title equity.

  Deltas at this trial count are indicative. Confirm a short list with
  scripts/trade-check.mjs at 6000+ trials and several seeds before sending an offer.`);
