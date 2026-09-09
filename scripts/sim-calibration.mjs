// IS THE SEASON SIMULATOR CALIBRATED? Not "does it look sensible" -- does an 18% actually happen 18%
// of the time?
//
//   node --import tsx scripts/sim-calibration.mjs [--seasons 2022-2025] [--trials 3000]
//
// Every playoff and title probability this project produces comes out of `simulateSeasons`, and not
// one of them has ever been scored against an outcome. The whole apparatus -- trajectory pools, the
// two-level copula, the variance model, the streaming floor -- has been validated by comparing its
// INPUTS to history and its internals to each other. That is necessary and it is not the same thing
// as being right.
//
// WHAT IT DOES. For each season, rebuild all sixteen post-draft rosters from `fact_draft_pick` (the
// real picks this room made), project every player with the artifact BLIND to that season, simulate
// the season on a generated schedule, and score the resulting per-team probabilities against what
// happened: Brier for playoffs and for the title, a reliability table in probability bins, and the
// same for a uniform baseline that knows only how many teams there are.
//
// GENERATED SCHEDULE, always. The real one needs the league adaptor, and a number computed against a
// different schedule cannot be compared with one computed before it.
//
// ===================================================================================================
// THE OUTCOMES ARE NOT IN THE STORE, AND THIS RUNS ON A FIXTURE UNTIL THEY ARE.
//
// `matchup` holds 0 rows, `ownership` holds rosters rather than standings, and data/owners.json
// carries team names and owners with no results. The finalRank figures in docs/league-tendencies.md
// came from a live call to the league adaptor and were never written down. So:
//
//   real      data/league-outcomes.json exists -> every number below is a real calibration
//   fixture   it does not -> outcomes are DRAWN FROM THE SIMULATOR'S OWN PROBABILITIES with a fixed
//             seed, and every number below is a proof that the harness is CONNECTED, not a result
//
// The fixture mode is not decoration. A calibration harness that has never scored anything is a
// harness nobody knows the sign convention of, and the failure it hides is total: a Brier score
// computed against a permuted outcome vector looks exactly like one computed against the right one.
// So the fixture run also scores a SHUFFLED arm, and the harness is only believable if the honest
// arm beats it. Get the real outcomes with (a human, with the app open, once):
//
//   node --import tsx scripts/fetch-league-outcomes.mjs 2022 2025
// ===================================================================================================
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { simulateSeasons } from "../src/draft/season.ts";
import { buildSchedule } from "../src/draft/schedule.ts";
import { mulberry32 } from "../src/draft/spread.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [FROM, TO] = String(val("--seasons", "2022-2025")).split("-").map(Number);
const TRIALS = Number(val("--trials", 3000));
const ART_DIR = val("--artifact-dir", "data/fold-artifacts-2b");
const OUTCOMES = "data/league-outcomes.json";

const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomesPool = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corr = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));
const db = new Database("data/ff.db", { readonly: true });
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);

const real = existsSync(OUTCOMES) ? JSON.parse(readFileSync(OUTCOMES, "utf8")).rows : null;
console.log(real
  ? `SIMULATOR CALIBRATION -- REAL outcomes from ${OUTCOMES} (${real.length} team-seasons)\n`
  : `SIMULATOR CALIBRATION -- FIXTURE MODE. ${OUTCOMES} is absent, so outcomes below are DRAWN FROM
THE MODEL. Nothing here is a calibration result; it is a proof that the harness is connected end to
end. Fetch the real ones once, with the app open:
  node --import tsx scripts/fetch-league-outcomes.mjs ${FROM} ${TO}\n`);

// --- per season: rosters from the real picks, odds from the simulator ------------------------------
const seasonOdds = [];   // { season, teams: [{ id, name, playoffs, champion }] }
for (let yr = FROM; yr <= TO; yr++) {
  const picks = db.prepare("SELECT * FROM fact_draft_pick WHERE season = ? ORDER BY pick_order").all(yr);
  if (!picks.length) { console.log(`  ${yr}: no picks in the store -- skipped`); continue; }
  const artPath = `${ART_DIR}/artifact-${yr}.json`;
  if (!existsSync(artPath)) {
    console.error(`  ${yr}: missing ${artPath}. The projection must be BLIND to the season being ` +
      `scored, or the simulator is told the answer. Run:  npm run ff -- evaluate-projection ` +
      `--seasons 2008-2025 --keep-artifacts ${ART_DIR}`);
    process.exit(1);
  }
  const art = loadArtifact(JSON.parse(readFileSync(artPath, "utf8")));
  const proj = new Map();
  const poolRank = new Map();
  {
    const rows = boardProjection(db, yr, art).filter((r) => r.mean > 0);
    for (const r of rows) proj.set(`${r.pos}|${r.name}`, r);
    const byPos = {};
    for (const r of rows) (byPos[r.pos] ??= []).push(r);
    for (const l of Object.values(byPos)) {
      l.sort((a, b) => b.mean - a.mean);
      l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length }));
    }
  }
  const byTeam = new Map();
  let missing = 0;
  for (const p of picks) {
    if (!byTeam.has(p.team_name)) byTeam.set(p.team_name, { id: p.team_name, name: p.team_name, roster: [] });
    const pr = proj.get(`${p.pos}|${p.name}`);
    if (!pr) missing++;
    byTeam.get(p.team_name).roster.push({
      name: p.name, pos: p.pos, proj: pr ? pr.mean : 0,
      // NFL team is what identifies teammates to the copula, and fact_draft_pick does not carry it.
      // Left undefined, so those players are drawn independently -- an honest omission that makes
      // the simulated rosters slightly LESS correlated than the real ones, i.e. slightly
      // over-confident, which is stated rather than hidden.
      team: undefined, bye: null,
    });
  }
  const teams = [...byTeam.values()];
  const weeks = buildSchedule(teams.length, cfg.regWeeks ?? 14, 4).weeks;
  const odds = simulateSeasons(teams, weeks, vm, {
    weeks: weeks.length,
    playoffTeams: cfg.playoffTeams ?? 7,
    slots: cfg.slots, flexOk: cfg.flex_ok,
    projSd: 0.30, trials: TRIALS, seed: 20260908 + yr, poolRank,
    // These rosters are the DRAFT, before any waiver move, so a slot the draft did not fill is a
    // real gap rather than a bug in the fixture -- the check is opted out of, deliberately and here.
    allowIncompleteRosters: true,
    bootstrap: { outcomes: outcomesPool, corr, calibration: "scale" },
  });
  seasonOdds.push({ season: yr, teams: odds.map((o) => ({ id: o.id, name: o.name, playoffs: o.playoffs, champion: o.champion })) });
  console.log(`  ${yr}: ${teams.length} teams, ${picks.length} picks (${missing} without a projection), ${TRIALS} trials`);
}
db.close();
if (!seasonOdds.length) { console.log("nothing to calibrate"); process.exit(1); }

// --- outcomes: real, or drawn from the model -------------------------------------------------------
const rng = mulberry32(424242);
function outcomesFor(mode) {
  const out = [];
  for (const s of seasonOdds) {
    if (real) {
      const rows = real.filter((r) => r.season === s.season);
      for (const t of s.teams) {
        const hit = rows.find((r) => r.name === t.name || r.abbrev === t.name);
        if (hit) out.push({ season: s.season, p: t, y: { playoffs: hit.playoffs, champion: hit.champion } });
      }
      continue;
    }
    // FIXTURE: draw a consistent season -- the playoff field is the top `playoffTeams` by a score
    // drawn against each team's own odds, and the champion is one of them drawn by title odds. Drawn
    // jointly rather than per-team, so the fixture obeys the same constraints the real world does
    // (exactly one champion, exactly N playoff teams) and the reliability table is not scored
    // against an impossible outcome.
    const pt = cfg.playoffTeams ?? 7;
    const scored = s.teams.map((t) => ({ t, k: Math.log(Math.max(1e-9, t.playoffs)) - Math.log(-Math.log(Math.max(1e-9, rng()))) }));
    scored.sort((a, b) => b.k - a.k);
    const inPlayoffs = new Set(scored.slice(0, pt).map((x) => x.t.id));
    const champPool = scored.slice(0, pt);
    const wTot = champPool.reduce((a, x) => a + Math.max(1e-9, x.t.champion), 0);
    let r = rng() * wTot, champId = champPool[0].t.id;
    for (const x of champPool) { r -= Math.max(1e-9, x.t.champion); if (r <= 0) { champId = x.t.id; break; } }
    const rows = s.teams.map((t) => ({ id: t.id, playoffs: inPlayoffs.has(t.id) ? 1 : 0, champion: t.id === champId ? 1 : 0 }));
    if (mode === "shuffled") {
      // THE ADVERSARIAL ARM: the same season's outcomes, reassigned to the wrong teams. A Brier
      // score that cannot tell this from the honest arm is not measuring anything.
      const ys = rows.map((r2) => ({ playoffs: r2.playoffs, champion: r2.champion }));
      for (let i = ys.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; }
      rows.forEach((r2, i) => { r2.playoffs = ys[i].playoffs; r2.champion = ys[i].champion; });
    }
    for (const t of s.teams) {
      const y = rows.find((r2) => r2.id === t.id);
      out.push({ season: s.season, p: t, y: { playoffs: y.playoffs, champion: y.champion } });
    }
  }
  return out;
}

const brier = (rows, key) => rows.reduce((a, r) => a + (r.p[key] - r.y[key]) ** 2, 0) / rows.length;
const uniform = (rows, key, k) => rows.reduce((a, r) => a + (k - r.y[key]) ** 2, 0) / rows.length;

function report(label, rows) {
  const nTeams = (cfg.teams ?? 16), pt = (cfg.playoffTeams ?? 7);
  console.log(`\n  ${label}  (${rows.length} team-seasons)`);
  console.log(`    ${"target".padEnd(10)} ${"model".padStart(8)} ${"uniform".padStart(9)}  ${"skill".padStart(7)}`);
  for (const [key, base] of [["playoffs", pt / nTeams], ["champion", 1 / nTeams]]) {
    const b = brier(rows, key), u = uniform(rows, key, base);
    console.log(`    ${key.padEnd(10)} ${b.toFixed(4).padStart(8)} ${u.toFixed(4).padStart(9)}  ${((1 - b / u) * 100).toFixed(1).padStart(6)}%`);
  }
  // RELIABILITY: within each probability bin, does the predicted rate match the observed one?
  const BINS = [[0, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.7], [0.7, 1.01]];
  for (const key of ["playoffs", "champion"]) {
    const lines = [];
    for (const [lo, hi] of BINS) {
      const a = rows.filter((r) => r.p[key] >= lo && r.p[key] < hi);
      if (a.length < 3) continue;
      const pred = a.reduce((x, r) => x + r.p[key], 0) / a.length;
      const obs = a.reduce((x, r) => x + r.y[key], 0) / a.length;
      lines.push(`${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%: n${String(a.length).padStart(3)} pred ${(pred * 100).toFixed(1)} obs ${(obs * 100).toFixed(1)}`);
    }
    if (lines.length) console.log(`    reliability ${key.padEnd(9)} ${lines.join(" | ")}`);
  }
}

const honest = outcomesFor("honest");
report(real ? "REAL OUTCOMES" : "FIXTURE (outcomes drawn FROM the model)", honest);

if (!real) {
  const shuffled = outcomesFor("shuffled");
  report("FIXTURE, ADVERSARIAL (the same outcomes, assigned to the wrong teams)", shuffled);
  const hb = brier(honest, "playoffs"), sb = brier(shuffled, "playoffs");
  console.log(`\n  HARNESS CHECK: playoff Brier ${hb.toFixed(4)} honest vs ${sb.toFixed(4)} shuffled -- ` +
    (hb < sb
      ? "CONNECTED. The scorer distinguishes right answers from wrong ones."
      : "NOT CONNECTED. A scorer that cannot tell these apart is measuring nothing; fix it before " +
        "believing any calibration number it produces."));
  console.log(`  Every number above is a fixture. Fetch the real outcomes once, with the app open:`);
  console.log(`    node --import tsx scripts/fetch-league-outcomes.mjs ${FROM} ${TO}`);
}
