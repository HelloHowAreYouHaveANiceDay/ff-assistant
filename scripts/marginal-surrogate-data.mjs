// M2i STEP 1 -- LABEL GENERATION. Roster states from the simulator itself, each labelled with the
// SIMULATED marginal for a set of candidates, plus the ANALYTIC surrogate's answer for the same man
// in the same state read out of V3 ITSELF.
//
//   node --import tsx scripts/marginal-surrogate-data.mjs --seasons 2013-2022 --seeds 1-20 \
//        --strategies v2,v3 --trials 300 --cands 60 --out <file.jsonl> --workers 28
//
// THE STATES ARE REAL, not invented -- the rule `scripts/marginal-agreement.mjs` established and the
// reason its forty states were worth anything. A marginal has no meaning without a roster, a budget,
// a pool and a field. So a full auction is DRAFTED and then REPLAYED pick by pick, and our seat is
// snapshotted after every one of our buys. Two things are widened against that harness:
//
//   BOTH BIDDERS DRAFT. Track G sampled V2 drafts only. The learned surrogate is meant to be read by
//   V3, so half the states it will actually see are states V3's own buying produces -- and V3 buys a
//   visibly different roster (Track G face validity: $165 spend, 15% QB, against V2's $45 / 31%). A
//   model trained only on V2's state distribution would be evaluated out of its own support the
//   moment it was wired in.
//
//   EVERY BUY, not five phases. Track G's five phases were chosen to READ; this is a training set,
//   and consecutive buys are the states a bidder actually walks through.
//
// THE HOLDOUT IS BY SEASON, which is why the board varies by season at all. Each season's board is
// that season's ACTUALS from `data/history-points.csv` -- exactly what `ff backtest` hands the bidder
// as its no-lookahead projection for the following year, and what `scripts/v3-roster.mjs --season Y`
// already drafts on. 2025 is NEVER READ by this script under any argument; the split lives one layer
// up, in which seasons are passed to train and which to score.
//
// WHAT IS SHARED ACROSS SEASONS AND WHY IT IS STATED. The season SIMULATOR's environment -- the
// schedule shape, the variance model, the copula, the playoff format -- comes from `loadSimContext`
// and is the league's, not the season's: it is a property of the FORMAT. What varies by season is the
// BOARD (projections, the pool, positional scarcity, the price book's ranks, the streaming floor) and
// therefore every draft, every roster and every marginal.
//
// TWO DELIBERATE DEPARTURES from `loadSimContext`'s defaults, both because a DRAFT marginal is a
// question about a whole season:
//
//   `played` IS STRIPPED. The live context seeds standings from the 2026 weeks already played, BY
//   SEAT INDEX -- so week 1's real results would be pinned onto sixteen synthetic draft seats. It is
//   meaningless here and, worse, it would make this measurement drift every Monday. Removed, and
//   said.
//   `poolRank` IS REBUILT per season. It is name-keyed off the 2026 board; a 2017 board shares few of
//   those names, so left alone it would tier most of a historical board as "barely plays".
//
// BYES ARE NULL ON BOTH BOOKS. `data/history-points.csv` carries no bye week -- the limitation
// `buildV3Config`'s own header states. Both the analytic and the simulated marginal therefore see
// `bye = null` for every man, which is consistent and fair, and means M2i tests nothing about the
// bye-collision term.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadSimContext } from "../src/draft/simContext.ts";
import { MarginalBook } from "../src/draft/rosterMarginal.ts";
import { computeValues, resolveValueLeague } from "../src/draft/values.ts";
import { loadPriceModel, priceFor } from "../src/model/price.ts";
import { buildV3Config, draftFieldSeats, ourSdFor } from "../src/draft/sim.ts";
import { makeV3Strategy } from "../src/draft/strategyV3.ts";
import { surrogateFeatures, SURROGATE_FEATURE_FIELDS } from "../src/draft/marginalSurrogate.ts";
import { pMap, withCpuSlot, defaultCpuConcurrency } from "../src/util/pool.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);
const range = (s) => {
  const out = [];
  for (const part of String(s).split(",")) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) { for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i); }
    else if (part.trim()) out.push(Number(part.trim()));
  }
  return out;
};

const SEASONS = range(val("--seasons", "2013-2022"));
const SEEDS = range(val("--seeds", "1-20"));
const STRATEGIES = val("--strategies", "v2,v3").split(",").map((s) => s.trim()).filter(Boolean);
const TRIALS = Number(val("--trials", "300"));
const CANDS = Number(val("--cands", "60"));
const BOOK_SEED = Number(val("--book-seed", "7"));
const OUT = val("--out", null);
const WORKERS = Number(val("--workers", "0"));
const SHARD = val("--shard", null);       // "i/N"
const MAX_BUYS = Number(val("--max-buys", "12"));
// ONLY these buy counts, when given ("3,6,9"). The label-noise probe needs a few states at a high
// trial count, not a whole draft's worth; without this the cheapest way to reach buys=9 is to label
// the eight states before it as well. Empty means every state, which is the default and the training
// set's setting.
const ONLY_BUYS = val("--only-buys", null) ? new Set(range(val("--only-buys", ""))) : null;

// 2025 IS HELD OUT ENTIRELY. Not by convention, not by remembering -- by a refusal here, so no
// argument anybody types later can reach it.
if (SEASONS.includes(2025)) {
  console.error("REFUSED: 2025 is held out entirely from M2i (pre-registration). Remove it from --seasons.");
  process.exit(2);
}
if (!OUT) { console.error("--out <file.jsonl> is required"); process.exit(2); }

// --- the units of work -------------------------------------------------------------------------
// One unit = one (season, seed, strategy) draft. A unit is self-contained, identity-keyed by its
// three coordinates, and produces its states in a deterministic order -- the independence `pMap`'s
// determinism contract requires.
const UNITS = [];
for (const season of SEASONS) for (const strategy of STRATEGIES) for (const seed of SEEDS) UNITS.push({ season, seed, strategy });

// ================================================================================================
// COORDINATOR: fan the units out over child processes.
//
// `pMap` + `withCpuSlot` is the repo's one fan-out primitive and the global `cpuBudget` bounds the
// whole tree. CHILD PROCESSES rather than promises, because the label is CPU-bound synchronous
// JavaScript: a `pMap` over in-process tasks would run them one at a time on one core, which is the
// exact 31-idle-cores failure `src/util/pool.ts`'s own header was written about.
if (WORKERS > 1 && !SHARD) {
  const self = fileURLToPath(import.meta.url);
  mkdirSync(dirname(OUT), { recursive: true });
  const shards = Array.from({ length: WORKERS }, (_, i) => i);
  const t0 = Date.now();
  let finished = 0;
  const parts = await pMap(shards, (i) => withCpuSlot(() => new Promise((resolve, reject) => {
    const part = `${OUT}.part${i}`;
    const args = ["--import", "tsx", self,
      "--seasons", SEASONS.join(","), "--seeds", SEEDS.join(","), "--strategies", STRATEGIES.join(","),
      "--trials", String(TRIALS), "--cands", String(CANDS), "--book-seed", String(BOOK_SEED),
      "--max-buys", String(MAX_BUYS), "--out", part, "--shard", `${i}/${WORKERS}`];
    if (ONLY_BUYS) args.push("--only-buys", [...ONLY_BUYS].join(","));
    if (has("--shuffle-check")) args.push("--shuffle-check");
    const ch = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr.on("data", (d) => { err += d.toString(); });
    ch.on("exit", (code) => {
      finished++;
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  shard ${i} exit ${code}  (${finished}/${WORKERS} done, ${mins} min)`);
      if (code !== 0) { console.error(err.slice(-4000)); reject(new Error(`shard ${i} failed`)); }
      else resolve(part);
    });
  })), { concurrency: WORKERS });
  writeFileSync(OUT, "");
  let rows = 0;
  for (const p of parts) {
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, "utf8");
    rows += txt.split("\n").filter(Boolean).length;
    appendFileSync(OUT, txt);
  }
  console.log(`\nwrote ${OUT}: ${rows} rows from ${WORKERS} shards in ${((Date.now() - t0) / 60000).toFixed(1)} min ` +
    `(cpu budget ${defaultCpuConcurrency()})`);
  process.exit(0);
}

// ================================================================================================
// WORKER
const [shardI, shardN] = SHARD ? SHARD.split("/").map(Number) : [0, 1];
const MINE = UNITS.filter((_u, i) => i % shardN === shardI);

const ctx = await loadSimContext({ schedule: "generated" });
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const priceArt = loadPriceModel(JSON.parse(readFileSync("data/price-model.json", "utf8")));
const LG = { teams: 16, budget: 200, slots: [...ctx.slots] };
const SLOTS_PER_TEAM = LG.slots.length;
const NFL_WEEKS = 17;
const FLEX_OK = ctx.flexOk ?? ["RB", "WR", "TE"];
const FLEXLIKE = /^(FLEX|OP|RB\/WR|WR\/TE|SUPERFLEX)$/i;

const histRows = readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)
  .map((l) => l.split(","));

/** Everything about ONE season's board, built once and reused for every unit on it. */
function seasonEnv(season) {
  const points = histRows.filter((f) => Number(f[0]) === season)
    .map((f) => ({ name: f[1].trim(), pos: f[2].trim().toUpperCase(), points: Number(f[3]) }))
    .filter((p) => p.name && Number.isFinite(p.points) && p.points > 0);
  if (points.length < 200) throw new Error(`season ${season}: only ${points.length} board rows`);
  const board = points.map((p) => ({ name: p.name, pos: p.pos, proj: p.points, bye: null }));
  const byName = new Map(board.map((p) => [p.name, p]));

  // Positional and overall ranks on THIS season's board.
  const posRank = new Map(), overallRank = new Map();
  {
    const seen = {};
    [...board].sort((a, b) => b.proj - a.proj).forEach((p, i) => {
      seen[p.pos] = (seen[p.pos] ?? 0) + 1;
      posRank.set(p.name, seen[p.pos]);
      overallRank.set(p.name, i + 1);
    });
  }
  const LEAGUE_MONEY = LG.teams * LG.budget;
  const priceOfName = (name, pos) => Math.max(1, Math.round(priceFor(priceArt, pos, {
    ecrPosRank: posRank.get(name) ?? null, ecrSd: null, moneyLeft: 1, slotsLeft: 1, pickShare: 0, leagueMoney: LEAGUE_MONEY,
  })));
  const priceOf = (p) => priceOfName(p.name, p.pos);

  const vor = new Map(computeValues(points, resolveValueLeague(LG), 2).map((r) => [r.name, r.value]));

  // poolRank, REBUILT for this board (the context's is name-keyed off the 2026 one).
  const poolRank = new Map();
  {
    const byPos = {};
    for (const p of board) (byPos[p.pos] ??= []).push(p);
    for (const l of Object.values(byPos)) { l.sort((a, b) => b.proj - a.proj); l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length })); }
  }
  // The streaming floor for THIS board, derived exactly as `buildV3Config` derives it.
  const replacement = {};
  {
    const byPos = new Map();
    for (const p of board) (byPos.get(p.pos) ?? byPos.set(p.pos, []).get(p.pos)).push(p.proj);
    for (const [pos, list] of byPos) {
      list.sort((a, b) => b - a);
      const dedicated = LG.slots.filter((s) => s === pos).length;
      const flexShare = ["RB", "WR", "TE"].includes(pos) ? LG.slots.filter((s) => s === "FLEX").length / 3 : 0;
      const idx = Math.min(list.length - 1, Math.round((dedicated + flexShare + 1) * LG.teams));
      replacement[pos] = Math.max(0, (list[idx] ?? 0) / NFL_WEEKS);
    }
  }
  // `played` STRIPPED, `poolRank` and `replacement` replaced. Everything else is the format's.
  const opts = (trials, seed) => {
    const o = ctx.opts(trials, seed);
    return { ...o, played: undefined, poolRank, replacement };
  };
  const env = { weeks: ctx.weeks, vm, opts, slots: ctx.slots, flexOk: ctx.flexOk, priceOf };
  const v3cfg = buildV3Config(points, LG, { byeOf: () => null, priceOf: priceOfName });
  return { season, points, board, byName, posRank, overallRank, priceOfName, priceOf, vor, replacement, env, v3cfg };
}

// --- STATE SAMPLING --------------------------------------------------------------------------
const openIdxFor = (slots, pos) => {
  let i = slots.findIndex((s, k) => s === null && LG.slots[k] === pos);
  if (i >= 0) return i;
  if (FLEX_OK.includes(pos)) { i = slots.findIndex((s, k) => s === null && FLEXLIKE.test(LG.slots[k])); if (i >= 0) return i; }
  return slots.findIndex((s, k) => s === null && /^(BE|BENCH|IR|ER)$/i.test(LG.slots[k]));
};

/** Replay one draft and snapshot our seat after every buy (and before the first). */
function statesFrom(se, seed, strategy, includeEmpty) {
  const cfg = { values: Object.fromEntries(se.vor), starterReserve: 4, benchReserve: 1, premium: 2, aggr: 0.7, maxShare: 0.25, maxKDst: 2, benchDiscount: 0.25, inflation: true };
  const { picks } = draftFieldSeats(se.points, se.vor, cfg, seed, LG, { botBook: "price", botIdioSd: 0.2, strategy });
  const teams = Array.from({ length: LG.teams }, () => ({ budget: LG.budget, slots: LG.slots.map(() => null) }));
  const gone = new Set();
  const out = [];
  const snap = () => {
    const mine = teams[0].slots.filter((s) => s != null).map((n) => se.byName.get(n)).filter(Boolean);
    const openSlots = LG.slots.filter((_s, k) => teams[0].slots[k] === null);
    if (!openSlots.length) return;
    const pool = se.board.filter((p) => !gone.has(p.name));
    const opponents = teams.slice(1).map((t, i) => ({
      id: `opp${i + 1}`, name: `opp${i + 1}`,
      roster: t.slots.filter((s) => s != null).map((n) => ({ ...se.byName.get(n) })),
    }));
    out.push({
      seed, strategy, buys: mine.length, budget: teams[0].budget, mine, openSlots, pool, opponents,
      mySlotCounts: (() => { const c = {}; for (const s of openSlots) { const k = /^(BE|BENCH|IR|ER)$/i.test(s) ? "BENCH" : s; c[k] = (c[k] ?? 0) + 1; } return c; })(),
      leagueDollars: teams.reduce((a, t) => a + Math.max(0, t.budget), 0),
      leagueOpenSlots: teams.reduce((a, t) => a + t.slots.filter((s) => s === null).length, 0),
      teamsView: teams.map((t, k) => ({ name: String(k), budgetLeft: t.budget, openSlots: t.slots.filter((s) => s === null).length })),
      oppRosterProjMean: opponents.reduce((a, o) => a + o.roster.reduce((x, p) => x + (p?.proj ?? 0), 0), 0) / Math.max(1, opponents.length),
    });
  };
  // THE EMPTY STATE IS THE SAME STATE IN EVERY SEED AND UNDER BOTH STRATEGIES -- no roster, the whole
  // board, $200, fifteen opponents who have bought nobody. Emitted once per SEASON; measuring it per
  // unit would weight one state forty times over and put byte-identical rows on both sides of any
  // split that believed it was splitting by draft. (Track G's own finding, one layer out.)
  if (includeEmpty) snap();
  for (const pk of picks) {
    gone.add(pk.name);
    const t = teams[pk.team];
    const i = openIdxFor(t.slots, pk.pos);
    if (i >= 0) t.slots[i] = pk.name;
    t.budget -= pk.price;
    if (pk.team !== 0) continue;
    const buys = teams[0].slots.filter((s) => s != null).length;
    if (buys >= 1 && buys <= MAX_BUYS) snap();
  }
  return out;
}

// --- LABEL ONE STATE ---------------------------------------------------------------------------
const ref = (p) => ({ name: p.name, pos: p.pos, team: "", espnPreDraftVal: null });

function labelState(se, st, bookSeed) {
  const mState = {
    roster: st.mine.map((p) => ({ ...p })), openSlots: [...st.openSlots], budget: Math.max(1, st.budget),
    pool: st.pool.map((p) => ({ ...p })), opponents: st.opponents, meId: "us", meName: "us",
  };
  const candidates = [...st.pool]
    .sort((a, b) => (se.vor.get(b.name) ?? 0) - (se.vor.get(a.name) ?? 0) || b.proj - a.proj)
    .slice(0, CANDS);
  if (!candidates.length) return null;

  // THE PER-CANDIDATE FRAMING, which is the one Track G's headline numbers are in and the one its
  // calibration was eligible against: each man is barred only from HIS OWN baseline fill. One book,
  // one budget curve, one set of random numbers for the whole state.
  const book = new MarginalBook(mState, se.env, { trials: TRIALS, seed: bookSeed, fillExclude: candidates.map((c) => c.name) });
  const sim = new Map();
  for (const c of candidates) sim.set(c.name, book.marginal(c, new Set([c.name])));

  // THE ANALYTIC COLUMN COMES OUT OF V3 ITSELF through `onDetail` -- never reimplemented here. A
  // harness that rebuilds `starterBaselines` + `lineupMarginal` drifts from the bidder and then
  // reports the drift as agreement.
  const detail = new Map();
  se.v3cfg.onDetail = (o) => detail.set(o.name, o);
  const strat = makeV3Strategy(se.v3cfg);
  const dstate = {
    myBudget: st.budget, mySlots: { ...st.mySlotCounts },
    myRoster: st.mine.map(ref), myPosCounts: (() => { const c = {}; for (const p of st.mine) c[p.pos] = (c[p.pos] ?? 0) + 1; return c; })(),
    onBlock: null, currentOffer: null, secondsLeft: null, iAmHighBidder: false,
    board: st.pool.map(ref), teams: st.teamsView,
    leagueDollars: st.leagueDollars, leagueOpenSlots: st.leagueOpenSlots,
  };

  // Positional ranks in the REMAINING pool, which is what a bidder can see.
  const poolPosRank = new Map();
  {
    const seen = {};
    for (const p of [...st.pool].sort((a, b) => b.proj - a.proj)) { seen[p.pos] = (seen[p.pos] ?? 0) + 1; poolPosRank.set(p.name, seen[p.pos]); }
  }

  const sState = {
    budget: st.budget, leagueBudget: LG.budget, openSlots: st.openSlots,
    roster: st.mine.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj })),
    poolSize: st.pool.length, leagueDollars: st.leagueDollars, leagueOpenSlots: st.leagueOpenSlots,
    oppRosterProjMean: st.oppRosterProjMean, slotsPerTeam: SLOTS_PER_TEAM,
  };
  const sEnv = { replacement: se.replacement, nflWeeks: NFL_WEEKS, flexOk: FLEX_OK };

  const rows = [];
  candidates.forEach((c, i) => {
    const anaDollars = strat.value(ref(c), dstate);
    const d = detail.get(c.name);
    const s = sim.get(c.name);
    const cand = {
      name: c.name, pos: c.pos, proj: c.proj,
      posRank: poolPosRank.get(c.name) ?? 999,
      vorRank: i + 1,
      vor: se.vor.get(c.name) ?? 0,
      price: se.priceOfName(c.name, c.pos),
      sd: ourSdFor(se.posRank.get(c.name) ?? null),
      avail: se.v3cfg.availOf?.(c.name, c.pos) ?? (se.v3cfg.lineup.avail[c.pos] ?? 0.85),
      anaPoints: d?.points ?? 0,
      anaDollars,
    };
    rows.push({
      x: surrogateFeatures(sState, cand, sEnv),
      y: s?.playoffsPp ?? 0,
      simDollars: s?.dollars ?? 0,
      anaDollars, anaPoints: cand.anaPoints,
      pos: c.pos, vorRank: i + 1, name: c.name,
    });
  });
  se.v3cfg.onDetail = undefined;
  return { rows, runs: book.runs };
}

// --- RUN ---------------------------------------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, "");
const t0 = Date.now();
let nStates = 0, nRows = 0, nRuns = 0, nDegenerate = 0;
const seenEmpty = new Set();
const envCache = new Map();

for (const u of MINE) {
  if (!envCache.has(u.season)) envCache.set(u.season, seasonEnv(u.season));
  const se = envCache.get(u.season);
  // The empty state belongs to the SEASON, and a shard only owns it if it owns the season's first
  // unit in the global order -- so exactly one shard emits it and no coordination is needed.
  const firstUnitIdx = UNITS.findIndex((x) => x.season === u.season);
  const includeEmpty = UNITS[firstUnitIdx].seed === u.seed && UNITS[firstUnitIdx].strategy === u.strategy && !seenEmpty.has(u.season);
  if (includeEmpty) seenEmpty.add(u.season);
  const states = statesFrom(se, u.seed, u.strategy, includeEmpty);
  const lines = [];
  for (const st of states) {
    if (ONLY_BUYS && !ONLY_BUYS.has(st.buys)) continue;
    const m = labelState(se, st, BOOK_SEED);
    if (!m) continue;
    nRuns += m.runs;
    // A state whose simulated book is FLAT AT $0 across the whole candidate set measures the trial
    // count, not the surrogate. It is MARKED, not dropped -- a training set may still want it, and a
    // SCORING pass must exclude it. Deciding that here would hide the choice from the reader.
    const live = m.rows.filter((r) => r.simDollars >= 1).length;
    const degenerate = live < 8;
    if (degenerate) nDegenerate++;
    nStates++;
    nRows += m.rows.length;
    lines.push(JSON.stringify({
      season: u.season, seed: u.seed, strategy: u.strategy, buys: st.buys, budget: st.budget,
      openSlots: st.openSlots.length, degenerate, liveRows: live, rows: m.rows,
    }));
  }
  if (lines.length) appendFileSync(OUT, lines.join("\n") + "\n");
  if (!SHARD || shardI === 0) {
    console.log(`  ${u.season} ${u.strategy} seed ${u.seed}: ${states.length} states, ` +
      `${nStates} total, ${nDegenerate} degenerate, ${nRuns} sim calls, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
}

const meta = {
  kind: "marginal-surrogate-data", features: SURROGATE_FEATURE_FIELDS,
  seasons: SEASONS, seeds: SEEDS, strategies: STRATEGIES, trials: TRIALS, cands: CANDS,
  bookSeed: BOOK_SEED, shard: SHARD, states: nStates, rows: nRows, simCalls: nRuns,
  degenerate: nDegenerate, minutes: (Date.now() - t0) / 60000,
};
writeFileSync(`${OUT}.meta.json`, JSON.stringify(meta, null, 1));
console.log(`[shard ${shardI}/${shardN}] ${nStates} states, ${nRows} rows, ${nRuns} sim calls, ` +
  `${nDegenerate} degenerate, ${((Date.now() - t0) / 60000).toFixed(1)} min -> ${OUT}`);
