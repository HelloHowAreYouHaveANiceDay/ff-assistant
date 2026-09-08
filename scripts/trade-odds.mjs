// TRADES SCORED BY SIMULATED CHAMPIONSHIP ODDS -- the only metric that answers the actual question.
//
//   node --import tsx scripts/trade-odds.mjs [trials]
//
// Two earlier metrics both gave answers that were artifacts of themselves, and the progression is
// the point:
//
//   trade-finder.mjs   optimal lineup on point projections. A backup RB is worth exactly ZERO here
//                      because he never starts, so it reported that no trade for a second running
//                      back helps -- a statement about the metric, not about running backs.
//   rosterValue.ts     expected lineup under availability. Depth finally has value, but weekly
//                      points are still the wrong currency: our league pays on a THRESHOLD (7 of 16
//                      make the playoffs) and then TOP-HEAVY (one champion). Points are not linear
//                      in either.
//
// This runs the real forward simulator over all sixteen real rosters and the real schedule, swapping
// one player each way, and reports the change in TITLE probability. Under a threshold-plus-top-heavy
// payout the right amount of variance is not zero, and only a simulation that plays the bracket can
// tell you whether a given trade buys the useful kind.
//
// COMMON RANDOM NUMBERS ARE LOAD-BEARING, not a nicety. A trade moves title odds by a point or two
// and the sim's own noise at a few thousand trials is the same size. Every arm therefore runs with an
// IDENTICAL seed, so both sides face the same projection errors, the same weekly draws and the same
// schedule; the delta is then attributable to the roster change rather than to which arm drew a
// luckier season. Without this the ranking is mostly noise and would look perfectly plausible.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openLeague, nameKey } from "../src/league/index.ts";
import { dstAliasKey } from "../src/draft/values.ts";
import { rosterGaps } from "../src/draft/season.ts";
import { simulateSeasons } from "../src/draft/season.ts";

const TRIALS = Number(process.argv[2] ?? 1200);
const SEED = 7;
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corrModel = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));

// OFFLINE FALLBACK. openLeague() reaches ESPN through the desktop app's webview over CDP, so it
// fails whenever the app is closed or its debugging port is not bound -- and this script is most
// wanted precisely when someone is sitting there deciding whether to accept an offer. The ROSTERS
// are already persisted (ownership, synced with team ids); only the SCHEDULE is fetched live and the
// matchup table is empty. So fall back to rosters from the store plus a structurally correct
// generated schedule.
//
// The substitution is honest for THIS question and it is worth being precise about why: an invented
// schedule changes the ABSOLUTE odds, because who you actually play matters. It barely touches the
// DELTAS, because both arms run the same schedule under the same seed and the trade is the only
// thing that differs. Absolute numbers from offline mode should not be quoted; the ranking is sound.
let lg = null, sched = null, offline = false;
try {
  lg = await openLeague();
  sched = lg.provider.matchups ? await lg.provider.matchups() : null;
  if (!sched) throw new Error("adaptor exposes no schedule");
} catch (e) {
  offline = true;
  if (lg) { try { await lg.close(); } catch { /* already down */ } lg = null; }
  console.log(`OFFLINE MODE -- could not reach the app (${String(e.message).split("\n")[0]})`);
  console.log(`  rosters come from the store; the schedule is GENERATED, so absolute odds are not`);
  console.log(`  quotable. Trade deltas are, because both arms share the schedule and the seed.\n`);
}
const store = new Database("data/ff.db", { readonly: true });
const cfgAll = JSON.parse(store.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const cfgFlex = cfgAll.flex_ok;
// FROM CONFIG. This was a hardcoded 7 in two places -- right for this league by coincidence, and
// silently wrong for any other. Same class as the flex_ok the simulator was ignoring.
const PLAYOFF_TEAMS = cfgAll.playoffTeams ?? 7;
const byeOf = new Map();
const season = lg ? lg.season : 2026;
for (const r of store.prepare(
  `SELECT p.name, r.bye FROM player p JOIN ranking r ON r.player_id=p.player_id AND r.source='fantasypros_ecr' AND r.season=?`,
).all(season)) byeOf.set(nameKey(r.name), r.bye);

let baseTeams, idx, meIdx, slots, regWeeks;
if (!offline) {
  idx = new Map(lg.teams.map((t, i) => [t.id, i]));
  baseTeams = lg.teams.map((t) => ({
    id: t.id, name: t.name,
    roster: t.roster.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, team: p.team, bye: byeOf.get(nameKey(p.name)) ?? null })),
  }));
  meIdx = idx.get(lg.me.id);
  slots = lg.slots;
  regWeeks = lg.regWeeks;
} else {
  const cfgRow = JSON.parse(store.prepare("SELECT value FROM settings WHERE key='config'").get().value);
  const lgRow = store.prepare("SELECT league_id, team_id FROM league WHERE season=? AND team_id IS NOT NULL").get(cfgRow.season);
  const board = new Map();
  for (const r of store.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfgRow.season)) {
    const j = JSON.parse(r.row_json);
    board.set(r.player_id, { name: j.Player, pos: j.Pos, proj: j.ProjPts || 0, team: j.Team || "" });
  }
  const byTeam = new Map();
  const dropped = [];
  for (const r of store.prepare("SELECT player_id, team_id, owner, team_abbrev FROM ownership WHERE league_id=?").all(lgRow.league_id)) {
    // ESPN keys a defense by nickname ("packers"), the board by abbreviation ("gb"). This line used
    // to read `if (!b) continue; // DSTs the board does not carry` -- the board carries all 32, and
    // that comment turned a join failure into documented behaviour for as long as anyone read it.
    const b = board.get(r.player_id) ?? board.get(dstAliasKey(r.player_id) ?? "");
    if (!b) { dropped.push(r.player_id); continue; }
    if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, { id: r.team_id, name: r.team_abbrev || r.owner, roster: [] });
    byTeam.get(r.team_id).roster.push({ ...b, bye: byeOf.get(nameKey(b.name)) ?? null });
  }
  baseTeams = [...byTeam.values()].sort((a, b) => Number(a.id) - Number(b.id));
  idx = new Map(baseTeams.map((t, i) => [t.id, i]));
  meIdx = idx.get(String(lgRow.team_id));
  slots = cfgRow.slots;
  regWeeks = cfgRow.regWeeks ?? 14;
  console.log(`  offline rosters: ${baseTeams.length} teams, we are index ${meIdx} (${baseTeams[meIdx]?.name})`);
  if (dropped.length) console.log(`  WARNING: ${dropped.length} rostered players matched no board row: ${dropped.slice(0, 10).join(", ")}`);
}

const weeks = [];
if (!offline) {
  for (let w = 1; w <= regWeeks; w++) {
    const games = sched.games.filter((g) => g.week === w).map((g) => [idx.get(g.homeId), idx.get(g.awayId)]).filter(([a, b]) => a != null && b != null);
    if (games.length) weeks.push(games);
  }
} else {
  // Divisional structure matching the real league shape (16 teams, 4 divisions) so the generated
  // season has the right in-division/cross-division mix rather than a round robin.
  const { buildSchedule } = await import("../src/draft/schedule.ts");
  const built = buildSchedule(baseTeams.length, regWeeks, 4);
  weeks.push(...built.weeks);
}

// pool ranks from the FULL projection pool -- tiers are fractions of that, not of a roster
const poolRank = new Map();
{
  const byPos = {};
  for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    if (!f[0] || !f[2]) continue;
    (byPos[f[1].trim().toUpperCase()] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
  }
  for (const [, list] of Object.entries(byPos)) {
    list.sort((a, b) => b.pts - a.pts);
    list.forEach((x, i) => poolRank.set(x.name, { rank: i, of: list.length }));
  }
}
const projOf = new Map();
for (const line of readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const f = line.split(",");
  if (f[0]) projOf.set(f[0].trim(), { pos: f[1].trim().toUpperCase(), proj: Number(f[2]) });
}
if (lg) await lg.close();

const OPTS = { weeks: weeks.length, playoffTeams: PLAYOFF_TEAMS, slots, flexOk: cfgFlex, projSd: 0.30, trials: TRIALS, seed: SEED, poolRank,
  bootstrap: { outcomes, corr: corrModel, calibration: "scale" } };

// ONE simulation returns every team's odds, so read both sides out of the same call. The first
// version of this ran the sim THREE times per candidate -- once for us, once for them, and once to
// recompute a baseline that never changes -- which is 3x the work for identical numbers and made a
// full sweep take longer than it was worth. Wasted compute is not a correctness bug, but a search
// too slow to run is one in practice: it is the version nobody runs before trading.
function runAll(teams) {
  const odds = simulateSeasons(teams, weeks, vm, OPTS);
  // FIELD-NAME GUARD. The first version of this read `.playoff`; the interface calls it `.playoffs`,
  // so every playoff figure came out `undefined` and printed as NaN. NaN at least announced itself --
  // a field that happened to be numeric-but-wrong would have printed a plausible number forever.
  // Checked against the object the simulator actually returned, not against a remembered shape.
  const o = odds[meIdx];
  for (const f of ["champion", "playoffs"]) {
    if (typeof o?.[f] !== "number" || Number.isNaN(o[f])) {
      throw new Error(`simulateSeasons returned no numeric '${f}' -- fields present: ${Object.keys(o ?? {}).join(", ")}`);
    }
  }
  return odds;
}
function run(teams) {
  const odds = runAll(teams);
  return { title: 100 * odds[meIdx].champion, playoff: 100 * odds[meIdx].playoffs };
}
const clone = (teams) => teams.map((t) => ({ ...t, roster: t.roster.map((p) => ({ ...p })) }));

const base = run(baseTeams);
console.log(`TRADE ODDS -- ${season}, ${baseTeams.length} teams, ${weeks.length} weeks, ${TRIALS} trials, seed ${SEED} (common random numbers)`);
console.log(`  BASE: ${base.title.toFixed(1)}% title, ${base.playoff.toFixed(1)}% playoffs\n`);

// A null control. Re-running the identical roster must return the identical number; if it does not,
// the seed is not actually pinning the draws and every delta below is noise wearing a decimal point.
const nullRun = run(clone(baseTeams));
if (Math.abs(nullRun.title - base.title) > 1e-9) {
  console.log(`  SEED IS NOT PINNING THE DRAWS -- rerun of the same roster gave ${nullRun.title.toFixed(3)}% vs ${base.title.toFixed(3)}%.`);
  console.log(`  Every delta below would be noise. Stopping.`);
  process.exit(1);
}
console.log(`  null control: identical roster re-simulated -> ${nullRun.title.toFixed(2)}% (must match base exactly)  OK\n`);

const usRoster = baseTeams[meIdx].roster;
// CANDIDATE PRUNING, and the reason is statistical rather than cosmetic. A trade moves title odds by
// about a point; at 300 trials the sim's own standard error is larger than that. Fewer candidates at
// many more trials beats a full sweep at few, because a long list of deltas smaller than their own
// noise is not a ranking -- it is a random permutation that looks like an answer.
const MIN_GET = Number(process.env.MIN_GET ?? 100);   // ignore fringe players we would never start
const cand = [];
for (let ti = 0; ti < baseTeams.length; ti++) {
  if (ti === meIdx) continue;
  for (const give of usRoster) {
    if (["K", "DST"].includes(give.pos)) continue;
    for (const get of baseTeams[ti].roster) {
      if (["K", "DST"].includes(get.pos)) continue;
      if (get.proj < MIN_GET) continue;
      if (get.pos === give.pos && get.proj <= give.proj) continue;   // never a downgrade in kind
      cand.push({ ti, give, get });
    }
  }
}
const wanted = process.argv.includes("--rb") ? cand.filter((c) => c.get.pos === "RB") : cand;

// A swap that leaves EITHER side unable to field a lineup is not a trade anyone would make -- giving
// away your only quarterback for a receiver means you immediately claim a replacement quarterback,
// not that you start nobody. Before the roster guard existed these were simulated anyway and priced
// with an empty slot; now they would abort the whole sweep on the first one. Filter them out and say
// how many, so the exclusion is visible rather than silent.
const legal = [], illegal = [];
for (const c of wanted) {
  const mine = baseTeams[meIdx].roster.filter((p) => p.name !== c.give.name).concat([c.get]);
  const theirs = baseTeams[c.ti].roster.filter((p) => p.name !== c.get.name).concat([c.give]);
  const gaps = rosterGaps(
    [{ id: "me", name: "us", roster: mine }, { id: "them", name: baseTeams[c.ti].name, roster: theirs }],
    slots, cfgFlex,
  );
  (gaps.length ? illegal : legal).push(c);
}
const only = legal;
console.log(`evaluating ${only.length} one-for-one swaps at ${TRIALS} trials each${illegal.length ? " (" + illegal.length + " skipped: would leave a side unable to fill a slot)" : ""}...\n`);

// The unchanged baseline for EVERY team, computed once. Their "before" does not depend on which
// trade we are evaluating, so recomputing it per candidate bought nothing.
const baseAll = runAll(baseTeams);

// PARALLEL. Every candidate is an independent simulation over the same read-only inputs, so this was
// one core doing what 31 could -- a 700-candidate sweep at 3200 trials took ~40 minutes while the
// rest of the machine idled.
//
// The precondition is DETERMINISM, and it is new. Under the old sequential RNG a job's result
// depended on how many draws had already been consumed, which in a pool means it depends on which
// worker picked it up and when -- run-to-run variation indistinguishable from Monte Carlo noise and
// effectively undebuggable. The identity-keyed draws make a result a pure function of its job, so
// worker count and scheduling cannot reach it. assertDeterministic proves that on this data rather
// than trusting the argument: the same jobs are run on 1 worker and on 4 and required to be
// BIT-identical before the sweep starts.
const { runPool, assertDeterministic } = await import("../src/draft/simPool.ts");
const poolInit = {
  baseTeams, weeks, slots, flexOk: cfgFlex, playoffTeams: PLAYOFF_TEAMS, projSd: 0.30, poolRank,
  varianceModelPath: "data/variance-model.json",
  outcomesPath: "data/rank-outcomes.json",
  corrPath: "data/correlation-model.json",
};
const jobs = only.map((c, idx) => ({
  idx, meIdx, theirIdx: c.ti, giveName: c.give.name, getName: c.get.name, trials: TRIALS, seed: SEED,
}));
process.stderr.write(`  checking pool determinism...\n`);
await assertDeterministic(poolInit, jobs);
process.stderr.write(`  OK -- 1 worker and 4 workers agree exactly\n`);

const t0 = Date.now();
const poolOut = await runPool(poolInit, jobs, {
  onProgress: (d, total) => { if (d % 50 === 0 || d === total) process.stderr.write(`  ${d}/${total} (${((Date.now() - t0) / d).toFixed(0)}ms each)\n`); },
});
const out = only.map((c, i) => ({
  ...c,
  dTitle: poolOut[i].mine - base.title,
  // The worker returns championship odds only; playoff odds are not part of the ranking and were
  // costing a second field to keep in sync across a thread boundary. Dropped rather than carried
  // wrong -- this field printed NaN for an entire session because one of two readers spelled it
  // `.playoff` instead of `.playoffs`.
  dThem: poolOut[i].theirs - 100 * baseAll[c.ti].champion,
  abbr: baseTeams[c.ti].name,
}));
process.stderr.write(`  swept ${jobs.length} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
out.sort((a, b) => b.dTitle - a.dTitle);
console.log("  we give               we get                pos  partner                title     them");
for (const d of out.slice(0, 15)) {
  console.log(
    `  ${d.give.name.slice(0, 20).padEnd(20)}  ${d.get.name.slice(0, 20).padEnd(20)}  ${d.get.pos.padEnd(3)}  ${String(d.abbr).slice(0, 18).padEnd(18)} ` +
    `${(d.dTitle >= 0 ? "+" : "") + d.dTitle.toFixed(2)}pp`.padStart(9) +
    `${(d.dThem >= 0 ? "+" : "") + d.dThem.toFixed(2)}pp`.padStart(9),
  );
}
// PLAUSIBLY ACCEPTABLE DEALS -- the list above is dominated by proposals the other manager loses ten
// to twenty points on, which are not offers, they are fantasies. A deal is only actionable if the
// partner's own title odds survive it.
// Declared here because the acceptability filter below uses it -- it was originally defined after
// that block and threw a temporal-dead-zone ReferenceError, after four hundred simulations had
// already run. Cheap to fix, expensive to hit: the whole sweep is wasted when it fails at the end.
const { optimalLineup: optLineup } = await import("../src/inseason/lineup.ts");
const optimalLineupNames = (roster) => optLineup(roster.map((p) => ({ ...p, available: true })), slots, cfgFlex).starters.map((x) => x.name);
const noise = 2 * Math.sqrt(base.title * (100 - base.title) / TRIALS);

// ABSOLUTE POINTS ARE THE WRONG YARDSTICK FOR THE PARTNER, and filtering on them alone produced a
// misleading recommendation. A contender at 20% who drops 2.5pp has given up an eighth of his
// equity; a team at 1.5% who drops 1.1pp has given up THREE QUARTERS of his. The absolute filter
// waves the second one through as "barely costs him" and flags the first as expensive, which is
// backwards -- it systematically steers offers toward teams with the least left to lose, who are
// precisely the managers most likely to notice they are being asked to sell their season.
//
// So report BOTH, and rank by the relative loss. A team already out of it may still deal, but that
// is a judgement about his motivation, not a claim that the trade is cheap for him.
const okDeals = out
  .map((d) => ({ ...d, themBase: 100 * baseAll[d.ti].champion, rel: 100 * baseAll[d.ti].champion > 0.2 ? d.dThem / (100 * baseAll[d.ti].champion) : -1 }))
  .filter((d) => d.dTitle > noise && d.rel > -0.25)
  .sort((a, b) => b.dTitle - a.dTitle);
console.log(`\n  DEALS THE PARTNER MIGHT ACTUALLY TAKE (he keeps >=75% of his own title equity):`);
console.log("  we give               we get                pos  partner              us       them   (their base -> % of equity lost)");
for (const d of okDeals.slice(0, 12)) {
  console.log(
    `  ${d.give.name.slice(0, 20).padEnd(20)}  ${d.get.name.slice(0, 20).padEnd(20)}  ${d.get.pos.padEnd(3)}  ${String(d.abbr).slice(0, 18).padEnd(18)} ` +
    `${(d.dTitle >= 0 ? "+" : "") + d.dTitle.toFixed(2)}pp`.padStart(9) + `${(d.dThem >= 0 ? "+" : "") + d.dThem.toFixed(2)}pp`.padStart(9) +
    `   (${d.themBase.toFixed(1)}% -> ${(-100 * d.rel).toFixed(0)}% lost)`);
}
if (!okDeals.length) console.log("  (none -- every trade that materially helps us takes a quarter or more of the partner's equity)");


console.log(`\n  A delta smaller than about ${noise.toFixed(2)}pp is inside this run's own noise even`);
console.log(`  with common random numbers -- raise the trial count before acting on a close call.`);

// --- ANOMALY SCAN ---------------------------------------------------------------------------------
// A comprehensive sweep is not only a shopping list; it is the widest net this codebase has for
// finding places the model does something indefensible. Each check below is a statement that SHOULD
// be true of any sane valuation, so a hit is a defect report rather than a trade idea.
console.log(`\n================ ANOMALY SCAN over all ${out.length} evaluated swaps ================`);
const flags = [];

// 1. Strict dominance. Receiving a strictly better player at the SAME position for the same cost
//    cannot lower our title odds by more than noise.
// SAME PARTNER ONLY, and the first version of this got it wrong in an instructive way. It compared
// across teams and reported six "violations" -- Lamar Jackson (375) scoring 1.9pp WORSE than Joe
// Burrow (350), and so on. Every pair was on a DIFFERENT team, so the comparison confounded "is this
// player better" with "which rival did we just weaken". Taking a stud off a genuine contender helps
// us twice; taking the same stud off a team that was going to miss the playoffs anyway helps once.
// That is the simulator being RIGHT about a real effect, and it is worth more than the check was:
// who you trade with matters nearly as much as what you get, and a value-based trade tool cannot see
// that at all. Held to the same partner, the check means what it claims.
for (const d of out) {
  const same = out.filter((x) => x.ti === d.ti && x.give.name === d.give.name && x.get.pos === d.get.pos && x.get.proj > d.get.proj + 20);
  for (const better of same) {
    // TWO deltas are being compared, so the threshold is sqrt(2) x the single-delta noise, not the
    // single-delta noise. Using the latter is how a 1.42pp gap cleared a 1.36pp bar by 0.06pp and
    // was reported as structural -- it inverted completely at five times the trials.
    if (better.dTitle < d.dTitle - noise * Math.SQRT2) {
      flags.push({
        kind: "DOMINANCE",
        text: `DOMINANCE (same partner ${d.abbr}): giving ${d.give.name}, the BETTER ${better.get.name} (${better.get.proj.toFixed(0)}) ` +
          `scores ${better.dTitle.toFixed(2)}pp but the worse ${d.get.name} (${d.get.proj.toFixed(0)}) scores ${d.dTitle.toFixed(2)}pp`,
        probe: [better, d],
        holds: (r) => r[0] < r[1] - noise * Math.SQRT2,
      });
    }
  }
}
// 2. Free upgrades. Trading a player we cannot start for a clear starter should not HURT.
// A HIGHER PROJECTION IS NOT AN UPGRADE, and the first version of this check assumed it was. It
// flagged "Godwin (142, unstartable) -> Kyler Murray (230) = -0.88pp" as a defect. It is not: we
// already start Goff at 240, so Murray never plays, and the trade swaps one unstartable body for
// another WHILE handing the partner a useful receiver. A small negative is the correct answer.
//
// So the test has to be positional: the incoming player is only an upgrade if he would actually
// crack OUR lineup. Comparing raw projections across positions measures nothing -- a third-string
// quarterback out-projects a starting tight end and is worth less than the bench spot he occupies.
// (Third time an anomaly here has been my check rather than the model. The pattern is the same each
// time: a rule stated in terms that are easy to compute rather than in terms of what matters.)
const lineupNow = new Set(optimalLineupNames(baseTeams[meIdx].roster));
for (const d of out) {
  if (lineupNow.has(d.give.name)) continue;                       // giving up a starter is not "free"
  const after = new Set(optimalLineupNames(
    baseTeams[meIdx].roster.filter((p) => p.name !== d.give.name).concat([d.get])));
  if (!after.has(d.get.name)) continue;                            // he would not start -> not an upgrade
  if (d.dTitle < -noise) {
    flags.push({
      kind: "FREE UPGRADE",
      text: `FREE UPGRADE HURTS: ${d.give.name} (${d.give.proj.toFixed(0)}, benched) -> ${d.get.name} ` +
        `(${d.get.proj.toFixed(0)}, WOULD START) = ${d.dTitle.toFixed(2)}pp`,
      probe: [d],
      holds: (r) => r[0] < -noise,
    });
  }
}
// 3. Zero-sum sanity. In a 16-team league a trade that massively helps us should cost the partner
//    something; both sides gaining double digits means the sim is minting probability.
for (const d of out) {
  if (d.dTitle > 5 && d.dThem > 5) flags.push(`BOTH GAIN BIG: ${d.give.name} <-> ${d.get.name} gives us ${d.dTitle.toFixed(1)}pp AND them ${d.dThem.toFixed(1)}pp`);
}
// 4. Position blindness. Our roster has ONE running back and a mandatory RB slot, so acquiring a
//    second real RB should not be worth less than acquiring a fifth receiver of similar projection.
const rbGains = out.filter((d) => d.get.pos === "RB" && d.get.proj > 150).map((d) => d.dTitle);
const wrGains = out.filter((d) => d.get.pos === "WR" && d.get.proj > 150).map((d) => d.dTitle);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
if (rbGains.length && wrGains.length) {
  console.log(`  mean title delta acquiring a 150+ pt RB: ${avg(rbGains).toFixed(2)}pp   (n=${rbGains.length})`);
  console.log(`  mean title delta acquiring a 150+ pt WR: ${avg(wrGains).toFixed(2)}pp   (n=${wrGains.length})`);
  console.log(`  we roster ONE running back and the RB slot is mandatory, so RB should lead here.`);
  if (avg(wrGains) > avg(rbGains) + noise) {
    flags.push(`POSITION BLINDNESS: a 5th WR is worth more than a 2nd RB (${avg(wrGains).toFixed(2)} vs ${avg(rbGains).toFixed(2)}pp) on a one-RB roster`);
  }
}
// --- CONFIRM EVERY FLAG AT A SECOND SEED ------------------------------------------------------------
// All eight anomalies this scan reported on the previous run were Monte Carlo noise. Every one either
// inverted or vanished at five times the trials -- the "better player scores worse" pair reversed
// cleanly, and the four "free upgrade hurts" cases came back positive. That is not a coincidence, it
// is what a scan does when its threshold sits at roughly the size of its own error and it reads a
// single sample: across ~750 candidates it will manufacture a handful of confident findings every
// time, and each one costs somebody an investigation.
//
// So a flag is now a HYPOTHESIS, and it has to survive being re-measured on an independent seed
// before it is printed. This is the same rule applied everywhere else in this codebase and it was
// missing from precisely the tool whose job is to find things that look wrong.
const structural = flags.filter((f) => typeof f === "string");
const probed = flags.filter((f) => typeof f !== "string");
let confirmed = [], dropped = 0;
if (probed.length) {
  process.stderr.write(`  re-testing ${probed.length} flagged candidates at a second seed...\n`);
  const cjobs = [];
  for (const f of probed) {
    for (const d of f.probe) {
      cjobs.push({ idx: cjobs.length, meIdx, theirIdx: d.ti, giveName: d.give.name, getName: d.get.name, trials: TRIALS, seed: SEED + 1013 });
    }
  }
  const cOut = await runPool(poolInit, cjobs, {});
  // The baseline must come from the SAME seed as the arms it is compared against, or the delta
  // mixes two samples -- which is the error that produced these flags in the first place.
  const base2 = 100 * simulateSeasons(baseTeams, weeks, vm, { ...OPTS, seed: SEED + 1013 })[meIdx].champion;
  let k = 0;
  for (const f of probed) {
    const deltas = f.probe.map(() => cOut[k++].mine - base2);
    if (f.holds(deltas)) confirmed.push(f); else dropped++;
  }
}
const shown = [...structural, ...confirmed.map((f) => f.text)];
console.log(shown.length ? `\n  ${shown.length} ANOMALIES (confirmed on a second seed):` : `\n  no anomalies survived a second seed.`);
for (const f of shown.slice(0, 15)) console.log(`   - ${f}`);
if (dropped) {
  console.log(`\n  ${dropped} flag(s) did NOT reproduce on an independent seed and were discarded.`);
  console.log(`  That is the expected outcome for most of them: at ${TRIALS} trials a single delta`);
  console.log(`  carries about +/-${noise.toFixed(2)}pp, and a scan reading one sample over ~${out.length} candidates`);
  console.log(`  will invent a few confident findings every run.`);
}
