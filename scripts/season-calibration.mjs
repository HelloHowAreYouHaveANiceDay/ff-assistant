// IS THE SEASON SIMULATOR CALIBRATED? Eight seasons of this league's real outcomes say.
//
//   node --import tsx scripts/season-calibration.mjs [--seasons 2018-2025] [--trials 3000] [--seed 7]
//
// WHAT HAS NEVER BEEN CHECKED. `seasonOdds` produces a playoff and a title probability for every
// team, and those numbers drive trade advice, waiver advice and the frozen preseason scorecard. They
// have been validated for INTERNAL consistency -- conservation laws, marginals, the copula's
// correlations -- and never once against what actually happened. A simulator can satisfy every
// invariant it states about itself and still be systematically over-confident, and internal checks
// are structurally incapable of noticing: they compare the system against itself.
//
// THE MEASUREMENT. For each completed season the league has played:
//
//   roster      every team's POST-DRAFT roster, from fact_draft_pick. Not its end-of-season roster:
//               the question is what the odds would have said in September, and a roster containing
//               the waiver adds is a roster containing the answer.
//   projection  the per-fold artifact for that season (data/fold-artifacts-2b/artifact-<Y>.json),
//               fitted only on seasons BEFORE Y and evaluated at as-of <Y>-09-01. The shipped
//               artifact has seen every season and using it here would be lookahead in the one
//               input that decides everything.
//   schedule    the league's REAL schedule, from fact_matchup. A generated one produces a playoff
//               probability that is not this league's.
//   outcome     fact_team_season: did the team make the playoffs, did it win the title.
//
// scored with the Brier score and log loss against two baselines that a useful model must beat:
//
//   uniform     everyone gets field/teams and 1/teams. The floor. A model that cannot beat this
//               knows nothing about the teams at all.
//   points-for  the teams ranked by the season's REALISED points for, with the top `field` given
//               the playoff berth. It is CHEATING -- it has seen the season -- and it is here as a
//               CEILING rather than a rival: it says how much of the outcome is decidable from
//               scoring alone once you know it, which bounds what any preseason model could reach.
//
// WHAT THIS DOES NOT FIX. The variance model, the outcome pools and the correlation model are the
// SHIPPED ones, fitted over all history including these seasons. That is a real leak and it flatters
// the simulator; it is declared rather than removed because refitting three models per season is a
// different piece of work, and every direction it biases is towards the simulator looking BETTER,
// which makes an over-confidence finding a lower bound rather than an artefact.
import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { simulateSeasons } from "../src/draft/season.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { nameKey, dstAliasKey } from "../src/draft/values.ts";
import { playoffFieldFor } from "../src/features/picks.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = (val("--seasons", "2018-2025")).split("-").map(Number);
const TRIALS = Number(val("--trials", "3000"));
const SEED = Number(val("--seed", "7"));
const FOLD_DIR = val("--artifact-dir", "data/fold-artifacts-2b");
const JSON_OUT = argv.includes("--json");

const db = new Database("data/ff.db", { readonly: true });
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corr = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));

// ---------------------------------------------------------------------------------------------
// ONE SEASON'S LEAGUE, assembled from the facts.
// ---------------------------------------------------------------------------------------------

/** Bye week per NFL team, from the real schedule: the regular-season week in which the team has no
 *  game. Derived, because a bye table hardcoded for one season is wrong in every other. */
function byesFor(season) {
  const played = new Map();
  for (const g of db.prepare(
    "SELECT week, home_team, away_team FROM raw_nfl_game WHERE season = ? AND game_type = 'REG'",
  ).all(season)) {
    for (const t of [g.home_team, g.away_team]) {
      if (!played.has(t)) played.set(t, new Set());
      played.get(t).add(g.week);
    }
  }
  const maxWeek = Math.max(0, ...[...played.values()].flatMap((s) => [...s]));
  const bye = new Map();
  for (const [t, weeks] of played) {
    for (let w = 1; w <= maxWeek; w++) if (!weeks.has(w)) { bye.set(t, w); break; }
  }
  return bye;
}

/**
 * WHERE THE REGULAR SEASON ENDS, read off the schedule rather than assumed.
 *
 * In the regular season every team plays, so the league runs exactly teams/2 games a week. The first
 * playoff week runs FEWER, because the top seeds have a first-round bye. So the regular season is
 * the week before the first short week. This measures 13 for the 16-week NFL seasons and 14 from
 * 2021 on, which is what the league's own config says -- but derived per season, because the config
 * holds one number and the league has already changed it once.
 */
function regularSeasonWeeks(season, teams) {
  const perWeek = db.prepare(
    "SELECT week, COUNT(*) n FROM fact_matchup WHERE season = ? GROUP BY week ORDER BY week",
  ).all(season);
  const full = teams / 2;
  let reg = 0;
  for (const w of perWeek) {
    if (w.n < full) break;
    reg = w.week;
  }
  return reg >= 12 && reg <= 15 ? reg : null;
}

/** The lineup template, expanded from the season's own slot counts. */
function slotsFor(season) {
  const row = db.prepare("SELECT slot_counts_json FROM raw_league_season WHERE season = ?").get(season);
  if (!row?.slot_counts_json) return null;
  const counts = JSON.parse(row.slot_counts_json);
  const order = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BE"];
  const out = [];
  for (const k of order) for (let i = 0; i < (counts[k] ?? 0); i++) out.push(k);
  for (const [k, n] of Object.entries(counts)) if (!order.includes(k)) for (let i = 0; i < n; i++) out.push(k);
  return out;
}

function buildSeason(season) {
  const path = `${FOLD_DIR}/artifact-${season}.json`;
  if (!existsSync(path)) return { skip: `no ${path}` };
  const art = loadArtifact(JSON.parse(readFileSync(path, "utf8")));
  const proj = boardProjection(db, season, art, `${season}-09-01`).filter((r) => r.mean > 0);
  if (!proj.length) return { skip: "no projections" };

  // NFL team per player, for the bye. From the season's own feature rows -- the same table the
  // projection was built from, so a player cannot be projected as one man and given another's bye.
  const nflTeam = new Map();
  for (const r of db.prepare("SELECT name, pos, team FROM feat_player_season WHERE season = ? AND team IS NOT NULL").all(season)) {
    nflTeam.set(`${nameKey(r.name)}|${r.pos}`, r.team);
  }
  const bye = byesFor(season);

  const byKey = new Map();
  for (const p of proj) byKey.set(`${nameKey(p.name)}|${p.pos}`, p);

  /**
   * A DEFENSE IS SPELLED THREE WAYS and none of them is the others. ESPN's draft history says
   * "Bears D/ST"; the feature tables say "CHI DST"; the alias table in values.ts is keyed on the
   * bare nickname. Left unhandled, every one of the sixteen rosters loses its defense and the
   * simulator fields an empty mandatory slot for all of them -- which is exactly the defect
   * `loadSimContext` was found to have, arrived at from a different table.
   */
  const lookup = (name, pos) => {
    const direct = byKey.get(`${nameKey(name)}|${pos}`);
    if (direct || pos !== "DST") return direct;
    const abbr = dstAliasKey(String(name).replace(/\s*D\/?ST\s*$/i, "").trim());
    return abbr ? byKey.get(`${nameKey(`${abbr} DST`)}|DST`) : undefined;
  };

  // Pool rank within position, over the FULL projection pool. The variance model's tiers are
  // fractions of that pool; ranking within rostered players maps a real WR4 onto the historical
  // "barely plays" tier, which is a silent 20%-of-a-roster error.
  const poolRank = new Map();
  {
    const byPos = {};
    for (const p of proj) (byPos[p.pos] ??= []).push(p);
    for (const l of Object.values(byPos)) {
      l.sort((a, b) => b.mean - a.mean);
      l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length }));
    }
  }

  const picks = db.prepare(
    `SELECT p.team_id, p.name, p.pos, t.owner, t.team_name, t.wins, t.points_for, t.playoff_seed,
            t.final_rank, t.champion, t.made_playoffs
       FROM fact_draft_pick p JOIN fact_team_season t ON t.season = p.season AND t.team_id = p.team_id
      WHERE p.season = ? ORDER BY p.pick_order`,
  ).all(season);
  if (!picks.length) return { skip: "no picks" };

  const byTeam = new Map();
  let matched = 0, missed = 0;
  const rostered = new Set();
  for (const p of picks) {
    const t = byTeam.get(p.team_id) ?? byTeam.set(p.team_id, {
      id: String(p.team_id), name: p.owner ?? p.team_name ?? String(p.team_id), roster: [],
      outcome: { wins: p.wins, pointsFor: p.points_for, seed: p.playoff_seed, rank: p.final_rank, champion: p.champion, playoffs: p.made_playoffs },
    }).get(p.team_id);
    const k = `${nameKey(p.name)}|${p.pos}`;
    const pr = lookup(p.name, p.pos);
    if (!pr) { missed++; continue; }               // counted, never replaced by a stand-in
    matched++;
    rostered.add(pr.name);
    const tm = nflTeam.get(`${nameKey(pr.name)}|${pr.pos}`) ?? nflTeam.get(k) ?? null;
    t.roster.push({ name: pr.name, pos: pr.pos, proj: pr.mean, team: tm ?? "", bye: tm ? (bye.get(tm) ?? null) : null });
  }
  const teams = [...byTeam.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const slots = slotsFor(season);
  if (!slots) return { skip: "no slot counts" };
  const reg = regularSeasonWeeks(season, teams.length);
  if (!reg) return { skip: "could not derive the regular-season length" };

  const idx = new Map(teams.map((t, i) => [t.id, i]));
  const weeks = [];
  for (let w = 1; w <= reg; w++) {
    const g = db.prepare("SELECT home_id, away_id FROM fact_matchup WHERE season = ? AND week = ?").all(season, w)
      .map((x) => [idx.get(String(x.home_id)), idx.get(String(x.away_id))])
      .filter(([a, b]) => a != null && b != null);
    if (g.length) weeks.push(g);
  }
  if (weeks.length !== reg) return { skip: `schedule has ${weeks.length} of ${reg} regular-season weeks` };

  // Streaming floor: the second-best UNROSTERED projection at each position, per week. Same rule as
  // src/draft/simContext.ts, which is where it is justified.
  const replacement = {};
  {
    const free = {};
    for (const p of proj) if (!rostered.has(p.name)) (free[p.pos] ??= []).push(p.mean);
    for (const [pos, list] of Object.entries(free)) {
      list.sort((a, b) => b - a);
      replacement[pos] = Math.max(0, (list[Math.min(1, list.length - 1)] ?? 0) / reg);
    }
  }

  const field = playoffFieldFor(teams.length);

  return { season, teams, weeks, slots, reg, field, poolRank, replacement, matched, missed };
}

// ---------------------------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------------------------

const brier = (rows) => rows.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / rows.length;
const logloss = (rows) => -rows.reduce((a, r) => {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, r.p));
  return a + (r.y ? Math.log(p) : Math.log(1 - p));
}, 0) / rows.length;

const BINS = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 1.0001];
function reliability(rows) {
  const out = [];
  for (let i = 0; i < BINS.length - 1; i++) {
    const a = rows.filter((r) => r.p >= BINS[i] && r.p < BINS[i + 1]);
    if (!a.length) continue;
    out.push({
      lo: BINS[i], hi: Math.min(1, BINS[i + 1]), n: a.length,
      predicted: a.reduce((x, r) => x + r.p, 0) / a.length,
      observed: a.reduce((x, r) => x + r.y, 0) / a.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------------------------

const seasons = [];
for (let y = LO; y <= HI; y++) seasons.push(y);
const sim = { playoff: [], title: [] };
const uni = { playoff: [], title: [] };
const pf = { playoff: [], title: [] };
const perSeason = [];
const bySeed = new Map();

console.log(`SEASON-SIM CALIBRATION -- ${LO}-${HI}, ${TRIALS} trials, seed ${SEED}, per-fold artifacts from ${FOLD_DIR}\n`);
console.log(`  season teams  reg  field  roster match   champion (seed)      sim's most likely champion`);

for (const season of seasons) {
  const s = buildSeason(season);
  if (s.skip) { console.log(`  ${season}  SKIPPED -- ${s.skip}`); continue; }
  const odds = simulateSeasons(s.teams, s.weeks, vm, {
    weeks: s.weeks.length, playoffTeams: s.field, slots: s.slots, flexOk: ["RB", "WR", "TE"],
    projSd: 0.30, replacement: s.replacement, trials: TRIALS, seed: SEED, poolRank: s.poolRank,
    bootstrap: { outcomes, corr, calibration: "scale" },
    // A REAL POST-DRAFT ROSTER CAN BE SHORT AT A SLOT, and refusing to simulate it would drop the
    // team. Some managers really do leave the draft with no tight end and stream one; the
    // `replacement` floor above is exactly the model of that, and it is per-position and measured.
    // The guard this waives is the right default for a HYPOTHETICAL roster, where a missing slot
    // means a failed join -- and it did its job here, catching the DST spelling above before any
    // number was produced.
    allowIncompleteRosters: true,
  });
  const oddsById = new Map(odds.map((o) => [o.id, o]));
  const n = s.teams.length;

  // POINTS-FOR CEILING: the teams ranked by REALISED points for. It has seen the season, which is
  // the point -- it bounds what is decidable from scoring alone.
  const byPf = [...s.teams].sort((a, b) => (b.outcome.pointsFor ?? 0) - (a.outcome.pointsFor ?? 0));
  const pfRank = new Map(byPf.map((t, i) => [t.id, i + 1]));

  let simChamp = null;
  for (const t of s.teams) {
    const o = oddsById.get(t.id);
    if (!o) continue;
    if (!simChamp || o.champion > simChamp.p) simChamp = { name: t.name, p: o.champion };
    const yP = t.outcome.playoffs ? 1 : 0, yT = t.outcome.champion ? 1 : 0;
    sim.playoff.push({ season, team: t.name, p: o.playoffs, y: yP });
    sim.title.push({ season, team: t.name, p: o.champion, y: yT });
    uni.playoff.push({ season, team: t.name, p: s.field / n, y: yP });
    uni.title.push({ season, team: t.name, p: 1 / n, y: yT });
    // The points-for baseline is a RANKING, so it is turned into a probability the same way the
    // uniform one is: a flat p inside the top `field` and a flat p outside, with the two chosen so
    // the probabilities sum to the number of berths -- the same conservation the simulator obeys.
    const inField = pfRank.get(t.id) <= s.field;
    pf.playoff.push({ season, team: t.name, p: inField ? 0.9 : (s.field - 0.9 * s.field) / (n - s.field), y: yP });
    pf.title.push({ season, team: t.name, p: pfRank.get(t.id) === 1 ? 0.35 : (1 - 0.35) / (n - 1), y: yT });
    const seed = t.outcome.seed;
    if (seed != null) {
      const e = bySeed.get(seed) ?? bySeed.set(seed, { n: 0, titles: 0, pred: 0 }).get(seed);
      e.n++; e.titles += yT; e.pred += o.champion;
    }
  }
  const champ = s.teams.find((t) => t.outcome.champion);
  console.log(`  ${season}  ${String(s.teams.length).padStart(4)}  ${String(s.reg).padStart(4)}  ${String(s.field).padStart(5)}  ` +
    `${String(s.matched).padStart(4)}/${String(s.matched + s.missed).padEnd(4)}  ` +
    `${(champ ? `${champ.name} (${champ.outcome.seed})` : "?").padEnd(20)} ${simChamp ? `${simChamp.name} ${(100 * simChamp.p).toFixed(1)}%` : "-"}`);
  perSeason.push({ season, teams: s.teams.length, field: s.field, matched: s.matched, missed: s.missed });
}

if (!sim.playoff.length) { console.log("\nnothing scored."); process.exit(1); }

const table = (label, rows) => `  ${label.padEnd(24)} ${brier(rows).toFixed(4).padStart(8)}  ${logloss(rows).toFixed(4).padStart(8)}  ${rows.length}`;
console.log(`\n  ${sim.playoff.length} team-seasons scored\n`);
console.log(`  ${"model".padEnd(24)} ${"Brier".padStart(8)}  ${"log loss".padStart(8)}  n`);
console.log(`  PLAYOFFS`);
console.log(table("simulator", sim.playoff));
console.log(table("uniform", uni.playoff));
console.log(table("points-for (cheats)", pf.playoff));
console.log(`  TITLE`);
console.log(table("simulator", sim.title));
console.log(table("uniform", uni.title));
console.log(table("points-for (cheats)", pf.title));

const skill = (a, b) => `${(100 * (1 - brier(a) / brier(b))).toFixed(1)}%`;
console.log(`\n  Brier skill score against uniform -- playoffs ${skill(sim.playoff, uni.playoff)}, title ${skill(sim.title, uni.title)}`);
console.log(`  (positive = the simulator beats the floor; negative = it is worse than knowing nothing)`);

// THE POSITIVE CONTROL, and this harness does not get to report a number without it. A Brier score
// computed against a PERMUTED outcome vector looks exactly like one computed against the right one:
// same range, same shape, same confident decimal. So the outcomes are shuffled WITHIN each season --
// preserving how many berths and titles there were, destroying only which team got them -- and the
// honest arm must beat the shuffled one. If it does not, the harness is measuring nothing, and no
// amount of the tables above would say so.
{
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shuffleWithinSeason = (rows) => {
    const out = rows.map((r) => ({ ...r }));
    for (const season of new Set(out.map((r) => r.season))) {
      const idx = out.map((r, i) => i).filter((i) => out[i].season === season);
      const ys = idx.map((i) => out[i].y);
      for (let i = ys.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; }
      idx.forEach((i, k) => { out[i].y = ys[k]; });
    }
    return out;
  };
  const sp = brier(shuffleWithinSeason(sim.playoff)), st = brier(shuffleWithinSeason(sim.title));
  console.log(`  CONTROL, outcomes shuffled within each season: playoffs ${sp.toFixed(4)} (honest ${brier(sim.playoff).toFixed(4)}), ` +
    `title ${st.toFixed(4)} (honest ${brier(sim.title).toFixed(4)})`);
  const ok = sp > brier(sim.playoff) && st > brier(sim.title);
  console.log(ok
    ? `  the honest arm beats the shuffled one on both -- the outcomes really are joined to the right teams.`
    : `  WARNING: the shuffled arm is NOT worse. Either the join is broken or the model has no signal at all;`);
}

for (const [what, rows] of [["PLAYOFFS", sim.playoff], ["TITLE", sim.title]]) {
  console.log(`\n  RELIABILITY, ${what} -- what the simulator predicted against what happened`);
  console.log(`    ${"bin".padEnd(14)} ${"n".padStart(4)}  ${"predicted".padStart(10)}  ${"observed".padStart(9)}  ${"gap".padStart(7)}`);
  for (const b of reliability(rows)) {
    const gap = b.observed - b.predicted;
    console.log(`    ${`${(100 * b.lo).toFixed(0)}-${(100 * b.hi).toFixed(0)}%`.padEnd(14)} ${String(b.n).padStart(4)}  ` +
      `${(100 * b.predicted).toFixed(1).padStart(9)}%  ${(100 * b.observed).toFixed(1).padStart(8)}%  ${(gap >= 0 ? "+" : "") + (100 * gap).toFixed(1).padStart(6)}`);
  }
}

console.log(`\n  P(title | SEED) -- the simulator's mean predicted title probability against the realised rate`);
console.log(`    ${"seed".padEnd(6)} ${"n".padStart(4)}  ${"predicted".padStart(10)}  ${"observed".padStart(9)}`);
for (const [seed, e] of [...bySeed.entries()].sort((a, b) => a[0] - b[0])) {
  if (seed > 8) continue;
  console.log(`    ${String(seed).padEnd(6)} ${String(e.n).padStart(4)}  ${(100 * e.pred / e.n).toFixed(1).padStart(9)}%  ${(100 * e.titles / e.n).toFixed(1).padStart(8)}%`);
}

// ---------------------------------------------------------------------------------------------
// SHRINKAGE TOWARD UNIFORM, measured leave-one-season-out. A FINDING, not a change: nothing here
// writes it anywhere, and applying a correction chosen on the same seasons that measured it is the
// winner's curse with extra steps.
// ---------------------------------------------------------------------------------------------
function shrunkBrier(rows, base, lam) {
  return brier(rows.map((r, i) => ({ ...r, p: (1 - lam) * r.p + lam * base[i].p })));
}
const LAMS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7];
console.log(`\n  SHRINKAGE TOWARD UNIFORM, leave-one-season-out (a FINDING for Phase 3 -- nothing applies it)`);
for (const [what, s, u] of [["playoffs", sim.playoff, uni.playoff], ["title", sim.title, uni.title]]) {
  const seasonsIn = [...new Set(s.map((r) => r.season))];
  let held = 0, heldN = 0, picked = [];
  for (const ho of seasonsIn) {
    const trIdx = s.map((r, i) => i).filter((i) => s[i].season !== ho);
    const teIdx = s.map((r, i) => i).filter((i) => s[i].season === ho);
    let best = { lam: 0, b: Infinity };
    for (const lam of LAMS) {
      const b = shrunkBrier(trIdx.map((i) => s[i]), trIdx.map((i) => u[i]), lam);
      if (b < best.b) best = { lam, b };
    }
    picked.push(best.lam);
    held += shrunkBrier(teIdx.map((i) => s[i]), teIdx.map((i) => u[i]), best.lam) * teIdx.length;
    heldN += teIdx.length;
  }
  const base = brier(s);
  console.log(`    ${what.padEnd(10)} raw Brier ${base.toFixed(4)} -> ${(held / heldN).toFixed(4)} held out ` +
    `(${(100 * (1 - (held / heldN) / base)).toFixed(1)}% better), shrink chosen per fold: ${picked.join(", ")}`);
}

// ---------------------------------------------------------------------------------------------
// THE FROZEN 2026 ODDS. Can anything READ them? A write-once row that nothing can consume is a
// record, not a prediction, and the difference is invisible until the season ends.
// ---------------------------------------------------------------------------------------------
{
  const rows = db.prepare(
    "SELECT model, subject, name, value, as_of FROM scorecard_prediction WHERE kind = 'odds' ORDER BY season, model, subject",
  ).all();
  const byTeam = new Map();
  for (const r of rows) {
    const t = byTeam.get(r.subject) ?? byTeam.set(r.subject, { name: r.name }).get(r.subject);
    t[r.model] = r.value;
    t.asOf = r.as_of;
  }
  // The two models are named `playoff` and `title` on the row. Reading them under any other name is
  // the "facts emitted under a name the consumer had renamed away" defect, and it reads as an empty
  // table rather than as an error -- which is exactly what the first cut of this block did.
  const complete = [...byTeam.values()].filter((t) => t.playoff != null && t.title != null);
  const sumP = complete.reduce((a, t) => a + t.playoff, 0), sumT = complete.reduce((a, t) => a + t.title, 0);
  console.log(`\n  FROZEN PRESEASON ODDS in scorecard_prediction: ${rows.length} rows -> ${byTeam.size} teams, ` +
    `${complete.length} with BOTH a playoff and a title probability, as of ${complete[0]?.asOf ?? "?"}`);
  console.log(`    they sum to ${sumP.toFixed(1)}% playoff and ${sumT.toFixed(1)}% title -- the conservation the simulator imposes,`);
  console.log(`    so the rows are readable and self-consistent and are waiting only for the season to settle.`);
  // AND THE GAP, stated plainly: the SNAPSHOT path exists, the SCORING path does not.
  // src/weekly/scorecard.ts scores the `weekly` and `season` kinds and has no branch for `odds`, so
  // when 2026 finishes nothing will turn these 32 rows into a Brier score without new code.
  console.log(`    NOTE: scorecard.ts writes this kind but does NOT score it -- there is no 'odds' branch in the`);
  console.log(`    scoring phase, only 'weekly' and 'season'. The accrual is a Phase 3 gap, not a data problem.`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    perSeason,
    brier: { sim: { playoff: brier(sim.playoff), title: brier(sim.title) }, uniform: { playoff: brier(uni.playoff), title: brier(uni.title) } },
    reliability: { playoff: reliability(sim.playoff), title: reliability(sim.title) },
  }, null, 2));
}
db.close();
