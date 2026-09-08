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
  for (const r of store.prepare("SELECT player_id, team_id, owner, team_abbrev FROM ownership WHERE league_id=?").all(lgRow.league_id)) {
    const b = board.get(r.player_id);
    if (!b) continue;                                   // DSTs the board does not carry
    if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, { id: r.team_id, name: r.team_abbrev || r.owner, roster: [] });
    byTeam.get(r.team_id).roster.push({ ...b, bye: byeOf.get(nameKey(b.name)) ?? null });
  }
  baseTeams = [...byTeam.values()].sort((a, b) => Number(a.id) - Number(b.id));
  idx = new Map(baseTeams.map((t, i) => [t.id, i]));
  meIdx = idx.get(String(lgRow.team_id));
  slots = cfgRow.slots;
  regWeeks = cfgRow.regWeeks ?? 14;
  console.log(`  offline rosters: ${baseTeams.length} teams, we are index ${meIdx} (${baseTeams[meIdx]?.name})`);
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

const OPTS = { weeks: weeks.length, playoffTeams: 7, slots, projSd: 0.30, trials: TRIALS, seed: SEED, poolRank,
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
const only = process.argv.includes("--rb") ? cand.filter((c) => c.get.pos === "RB") : cand;
console.log(`evaluating ${only.length} one-for-one swaps at ${TRIALS} trials each...\n`);

// The unchanged baseline for EVERY team, computed once. Their "before" does not depend on which
// trade we are evaluating, so recomputing it per candidate bought nothing.
const baseAll = runAll(baseTeams);
const out = [];
let done = 0;
const t0 = Date.now();
for (const c of only) {
  const teams = clone(baseTeams);
  teams[meIdx].roster = teams[meIdx].roster.filter((p) => p.name !== c.give.name).concat([{ ...c.get }]);
  teams[c.ti].roster = teams[c.ti].roster.filter((p) => p.name !== c.get.name).concat([{ ...c.give }]);
  // THEIR side matters too: a proposal the other manager loses on gets rejected, so a deal that only
  // helps us is not a plan. Both sides come out of this ONE simulation.
  const odds = runAll(teams);
  out.push({
    ...c,
    dTitle: 100 * odds[meIdx].champion - base.title,
    // `.playoffs`, not `.playoff`. I fixed this once in run() and left the SECOND caller wrong, so
    // the header still read fine while every row printed NaN -- the recurring half-fix. The guard in
    // runAll() proved the field exists and said nothing about whether each reader spells it right,
    // which is the difference between checking a contract and checking every use of it.
    dPlayoff: 100 * odds[meIdx].playoffs - base.playoff,
    dThem: 100 * (odds[c.ti].champion - baseAll[c.ti].champion),
    abbr: baseTeams[c.ti].name,
  });
  // NEWLINE, not a carriage return. A \r-terminated counter renders fine in a terminal and is
  // useless the moment the run is redirected to a file: the line is rewritten in place, nothing is
  // flushed as a record, and reading the tail shows a number far behind the truth. I killed two
  // otherwise-healthy sweeps as "too slow" on exactly that misreading -- the profile says a
  // candidate costs about a second, not the twenty-four I inferred from the stale counter.
  if (++done % 25 === 0) process.stderr.write(`  ${done}/${only.length} (${((Date.now() - t0) / done).toFixed(0)}ms each)\n`);
}
out.sort((a, b) => b.dTitle - a.dTitle);
console.log("  we give               we get                pos  partner                title    playoff   them");
for (const d of out.slice(0, 15)) {
  console.log(
    `  ${d.give.name.slice(0, 20).padEnd(20)}  ${d.get.name.slice(0, 20).padEnd(20)}  ${d.get.pos.padEnd(3)}  ${String(d.abbr).slice(0, 18).padEnd(18)} ` +
    `${(d.dTitle >= 0 ? "+" : "") + d.dTitle.toFixed(2)}pp`.padStart(9) +
    `${(d.dPlayoff >= 0 ? "+" : "") + d.dPlayoff.toFixed(2)}pp`.padStart(10) +
    `${(d.dThem >= 0 ? "+" : "") + d.dThem.toFixed(2)}pp`.padStart(9),
  );
}
// PLAUSIBLY ACCEPTABLE DEALS -- the list above is dominated by proposals the other manager loses ten
// to twenty points on, which are not offers, they are fantasies. A deal is only actionable if the
// partner's own title odds survive it.
// Declared here because the acceptability filter below uses it -- it was originally defined after
// that block and threw a temporal-dead-zone ReferenceError, after four hundred simulations had
// already run. Cheap to fix, expensive to hit: the whole sweep is wasted when it fails at the end.
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
    if (better.dTitle < d.dTitle - noise) {
      flags.push(`DOMINANCE (same partner ${d.abbr}): giving ${d.give.name}, the BETTER ${better.get.name} (${better.get.proj.toFixed(0)}) ` +
        `scores ${better.dTitle.toFixed(2)}pp but the worse ${d.get.name} (${d.get.proj.toFixed(0)}) scores ${d.dTitle.toFixed(2)}pp`);
    }
  }
}
// 2. Free upgrades. Trading a player we cannot start for a clear starter should not HURT.
const startable = new Set(baseTeams[meIdx].roster.slice().sort((a, b) => b.proj - a.proj).slice(0, 8).map((p) => p.name));
for (const d of out) {
  if (!startable.has(d.give.name) && d.get.proj > d.give.proj + 60 && d.dTitle < -noise) {
    flags.push(`FREE UPGRADE HURTS: ${d.give.name} (${d.give.proj.toFixed(0)}, unstartable) -> ${d.get.name} (${d.get.proj.toFixed(0)}) = ${d.dTitle.toFixed(2)}pp`);
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
console.log(flags.length ? `\n  ${flags.length} ANOMALIES:` : `\n  no anomalies -- every check above held.`);
for (const f of flags.slice(0, 15)) console.log(`   - ${f}`);
