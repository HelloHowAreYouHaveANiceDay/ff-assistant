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
// THE OTHER-MODEL LEAK, NOW MEASURED AND CLOSABLE. The variance model, the outcome pools and the
// correlation model default to the SHIPPED ones, fitted over all history INCLUDING these seasons -- a
// real leak that flatters the simulator (only the projection artifact was per-fold). It is now fixable:
// run `UNLEAK=1` and this harness loads, per season Y, the three models REFIT on history EXCLUDING Y
// (data/fold-models/, produced by fit-variance/fit-correlation/fit-bootstrap with FIT_EXCLUDE=Y FIT_OUT=...).
//   Regenerate the folds once:  for Y in 2018..2025: FIT_EXCLUDE=$Y FIT_OUT=data/fold-models/<kind>-$Y.json node --import tsx scripts/fit-<kind>.mjs
// MEASURED 2026-09-11 (2018-2025, 3000 trials, seed 7): the leak is NEGLIGIBLE. Playoff Brier 0.2343 ->
// 0.2347, skill vs uniform 4.4% -> 4.2%; title stays no-skill (0.1% -> -0.8%). So the honest OUT-OF-SAMPLE
// number is ~4.2% playoff skill, the leak flattered by ~0.2pp, and every paired A/B gate run through this
// harness (it uses the same models in both arms) was already valid. Default stays shipped-models so a
// fresh clone reproduces the recorded figures without first regenerating 24 fold files.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { simulateSeasons, LEVEL_PRIOR_WEEKS } from "../src/draft/season.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { nameKey, dstAliasKey } from "../src/draft/values.ts";
import { playoffFieldFor } from "../src/features/picks.ts";
import { rosPerGame, loadRosBlend } from "../src/draft/rosBlend.ts";
import { loadConsensusPct, blendConsensus } from "../src/draft/consensusBlend.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";
import { loadInjuryHorizonArtifact, horizonFor } from "../src/inseason/injuryHorizon.ts";
import { tailHazardFrom } from "../src/draft/knownInjury.ts";

// PER-POSITION CONSENSUS BLEND (explore/perpos-blend), env-gated so the default gate is untouched.
// BLEND_QB / BLEND_RB / BLEND_WR / BLEND_TE in [0,1] re-rank that position's projector means toward
// the FFToday consensus, exactly as the board does -- so this measures whether the same posture that
// the draft board would carry improves the IN-SEASON simulator's calibration. Applied to proj.mean
// before rosters, pool ranks and the free-agent floor are built, so every downstream input sees it.
const BLEND_W = { QB: Number(process.env.BLEND_QB ?? 0), RB: Number(process.env.BLEND_RB ?? 0), WR: Number(process.env.BLEND_WR ?? 0), TE: Number(process.env.BLEND_TE ?? 0) };
const BLEND_ANY = Object.values(BLEND_W).some((w) => w > 0);

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = (val("--seasons", "2018-2025")).split("-").map(Number);
const TRIALS = Number(val("--trials", "3000"));
const SEED = Number(val("--seed", "7"));
const FOLD_DIR = val("--artifact-dir", "data/fold-artifacts-2b");
const JSON_OUT = argv.includes("--json");
// `--at-week W` -- THE IN-SEASON GATE (D18, 2026-09-14). Instead of the post-draft roster and a
// from-scratch season, every team's roster AS OF week W (fact_roster_week), and three arms scored
// against the same real outcomes:
//   A  from scratch: the pre-D18 simulator with week-W rosters (no seed, preseason lines)
//   B  standings SEEDED from the W-1 settled weeks (fact_lineup_week started points, fact_matchup)
//   C  B plus REST-OF-SEASON lines: each man's preseason per-week line updated on his W-1 weeks by
//      the fitted blend (data/ros-blend.json, K weeks of prior)
// Paired per season, so the delta is a season-level statistic. `--at-week` one past the regular
// season is the sanity check: every week settled, C must reproduce the realised field exactly.
const AT_WEEK = val("--at-week", null) == null ? null : Number(val("--at-week", null));
// `--emit-odds <path>` writes one row per team-season: the probabilities this harness produced and
// the outcome they are scored against. It exists so `scripts/odds-accrual-2025.mjs` can push exactly
// these numbers through `scorecard.ts`'s odds branch and check the two agree -- a scorer validated
// against a reimplementation of itself would prove nothing, so it is validated against the harness
// that produced the reference figures in docs/validation.md.
const EMIT_ODDS = val("--emit-odds", null);
// `--seeding record|division-winners-first` picks the SEEDING RULE the simulator uses. Default
// "record", which is what this harness has always done, so the shipped figures are reproducible with
// no flag. The two rules are indistinguishable on this league's real seeds 2018-2025
// (scripts/format-seeding.mjs), so the point of running both here is not to identify the rule -- it
// is to measure whether choosing the one we cannot rule out COSTS anything in calibration.
const SEEDING = val("--seeding", "record");
if (SEEDING !== "record" && SEEDING !== "division-winners-first") {
  throw new Error(`--seeding "${SEEDING}" is not a rule -- use record | division-winners-first.`);
}
// `--per-season-format` takes the field size, the seeding rule and the reseed flag from EACH
// SEASON'S OWN ESPN settings (raw_league_season, populated by `ff ingest-raw league-history`)
// instead of applying one rule to all eight. It is a flag rather than the default so the recorded
// figures stay reproducible, and so the pair is a measurement rather than a replacement.
//
// `--field N` forces a CONSTANT field for every season. It exists only to reproduce the constant-7
// arm that P49 is registered against; it is never the right way to score a league.
// `--replacement-frame nfl|reg` -- WHICH WEEK FRAME THE STREAMING FLOOR IS IN (D25, 2026-09-16).
//
//   nfl (default)  seasonProj / 17 -- the frame the rostered men are priced in (`season.ts:503`:
//                  `rosPerGame ?? proj / 17`), so the floor and the bodies it stands in for are
//                  comparable. This is what `src/draft/simContext.ts` now produces.
//   reg            seasonProj / regWeeks -- the pre-D25 behaviour, 17/reg (1.31x for a 13-week
//                  season) HIGH. Kept so the change is a paired measurement from ONE version of this
//                  script rather than a comparison of two script versions, which is how a pipeline
//                  difference gets mistaken for a result.
const REPLACEMENT_FRAME = val("--replacement-frame", "nfl");
if (REPLACEMENT_FRAME !== "nfl" && REPLACEMENT_FRAME !== "reg") {
  throw new Error(`--replacement-frame "${REPLACEMENT_FRAME}" is not a frame -- use nfl | reg.`);
}
const PER_SEASON_FORMAT = argv.includes("--per-season-format");
const FIELD_OVERRIDE = val("--field", null) == null ? null : Number(val("--field", null));
if (PER_SEASON_FORMAT && FIELD_OVERRIDE != null) {
  throw new Error("--per-season-format and --field are contradictory: one reads the season's own field, the other overrides it.");
}

// `--db <path>` -- WHICH STORE. Default the live one. It exists so a paired A/B can be run against a
// SNAPSHOT COPY: `data/ff.db` is written by other verbs (and, during a multi-executor session, by
// other sessions), and a mid-run migration made this harness print `SKIPPED -- no rosters for week 8`
// for all eight seasons -- a substrate change reported as a data absence. Two arms of one comparison
// must read the same bytes, so point both at one copy.
const db = new Database(val("--db", "data/ff.db"), { readonly: true });
// ONE LEAGUE, NAMED (S-9). Every `fact_*` / `raw_league_*` table below holds more than one league's
// rows now, and their team ids collide across platforms -- so a season-only filter silently unions
// two rooms. `--league <id>`; absent = the ACTIVE league.
const LEAGUE = requireLeagueId(
  resolveLeagueContext(db, argv.includes("--league") ? argv[argv.indexOf("--league") + 1] : undefined),
  "season-calibration");
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const outcomes = JSON.parse(readFileSync("data/rank-outcomes.json", "utf8"));
const corr = JSON.parse(readFileSync("data/correlation-model.json", "utf8"));

// UN-LEAKED calibration: with UNLEAK set, each season Y is scored with the variance / outcome-pool /
// correlation models REFIT on history EXCLUDING Y (data/fold-models/, from fit-*.mjs FIT_EXCLUDE=Y).
// Unset -> the SHIPPED all-history models, i.e. the leaked baseline the header above declares. The
// projection artifact was already per-fold; this closes the leak in the other three inputs so the
// Brier is honestly out-of-sample. Missing a fold file falls back to shipped (and is worth noticing).
const UNLEAK = !!process.env.UNLEAK;
const foldModel = (kind, season) => {
  const p = `data/fold-models/${kind}-${season}.json`;
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  if (UNLEAK) console.warn(`  UNLEAK: no ${p} -- falling back to the SHIPPED (leaked) model for ${season}`);
  return null;
};

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
    "SELECT week, COUNT(*) n FROM fact_matchup WHERE league_id = ? AND season = ? GROUP BY week ORDER BY week",
  ).all(LEAGUE, season);
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
  const row = db.prepare("SELECT slot_counts_json FROM raw_league_season WHERE league_id = ? AND season = ?").get(LEAGUE, season);
  if (!row?.slot_counts_json) return null;
  const counts = JSON.parse(row.slot_counts_json);
  const order = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BE"];
  const out = [];
  for (const k of order) for (let i = 0; i < (counts[k] ?? 0); i++) out.push(k);
  for (const [k, n] of Object.entries(counts)) if (!order.includes(k)) for (let i = 0; i < n; i++) out.push(k);
  return out;
}

// ==================================================================================================
// THE KNOWN-INJURY SEAM (commit 3 of docs/week-state-design-2026-09-18.md), as a GATE ARM.
//
// `simulateSeasons` prices every remaining week of every rostered man at a per-position, per-tier
// availability rate drawn independently each week. For a man carrying a designation that rate is
// both unconditional (a torn Achilles and a Questionable hamstring are the same number) and i.i.d.
// across weeks (real injuries persist). The seam replaces it, for those men only, with an EPISODE
// drawn from his own horizon curve. Whether that is an improvement is what this arm measures.
//
// FF_SIM_KNOWN_INJURY=1 turns it on, so `--sweep FF_SIM_KNOWN_INJURY --values 0,1` is a paired A/B
// on identical rosters, schedule, seeds and models -- the seam is the only thing that differs.
//
// THREE WAYS THIS COULD CHEAT, AND WHAT STOPS EACH:
//
//   THE MODEL SAW THE SEASON. The shipped artifact is fitted on every season including the one
//   being scored. So this loads a BLIND artifact per season from --injury-artifact-dir, and asserts
//   both that its holdout IS this season and that its newest training season is strictly earlier.
//   An artifact that fails either is refused rather than quietly used.
//
//   THE REPORT WAS FILED AFTER THE DECISION. Rows are read at WEEK W ONLY -- the report a manager
//   running season odds in week W actually has. `feat_injury_horizon` is already built at that
//   week's Friday cutoff, so the point-in-time property is the builder's, not re-derived here.
//
//   THE TAIL SAW THE SEASON. `tailHazardFrom` is fitted on episodes from seasons STRICTLY BEFORE
//   this one. Pooling all history would let the season being scored inform its own extrapolation.
//
// AND THE CURVE IS FORCED MONOTONE. The four horizons are four independent fits, so nothing makes
// P(miss>=4) <= P(miss>=1) by construction. `drawEpisodeLength` inverse-transforms a SURVIVAL curve
// and a non-monotone one silently truncates the draw at the first rise. Violations are clamped by
// running minimum and COUNTED, because a clamp that fires constantly is a broken model wearing a
// fixed one's clothes.
const INJURY_FOLD_DIR = val("--injury-artifact-dir", "data/fold-injury");
const injCache = new Map();
function blindInjuryArtifact(season) {
  if (injCache.has(season)) return injCache.get(season);
  const p = `${INJURY_FOLD_DIR}/artifact-${season}.json`;
  let a = null;
  if (existsSync(p)) {
    a = loadInjuryHorizonArtifact(JSON.parse(readFileSync(p, "utf8")), { checkGolden: true });
    if (Number(a.holdoutSeason) !== season) {
      throw new Error(`${p} declares holdout ${a.holdoutSeason} but is being used to score ${season}.`);
    }
    const newest = Math.max(...a.seasons);
    if (newest >= season) {
      throw new Error(`${p} was trained through ${newest}, which is not strictly before ${season}. That is lookahead.`);
    }
  }
  injCache.set(season, a);
  return a;
}

/** The seam's inputs for one season at one week, or null where anything needed is absent. */
function buildKnownInjury(season, week, skOf) {
  const a = blindInjuryArtifact(season);
  if (!a) return { curves: new Map(), tailHazard: 0.72, fromWeek: week, note: `no blind artifact in ${INJURY_FOLD_DIR}` };

  // The tail, from episodes STRICTLY BEFORE this season.
  const eps = db.prepare(
    "SELECT injury_group, weeks_missed FROM fact_injury_episode WHERE weeks_missed IS NOT NULL AND season < ?",
  ).all(season);
  const tail = tailHazardFrom(eps);

  const nameOf = new Map();                        // player_sk -> the projection name the sim uses
  for (const [name, sk] of skOf) nameOf.set(String(sk), name);

  const rows = db.prepare(
    `SELECT player_sk, designation, practice_status, injury_group, pos, weeks_missed_so_far,
            weeks_in_episode, prior_episodes_same, prior_episodes_any, age, injury_secondary_present
       FROM feat_injury_horizon WHERE season = ? AND week = ?`,
  ).all(season, Math.min(week, 17));

  const curves = new Map();
  let clamped = 0, onRoster = 0;
  for (const r of rows) {
    const name = nameOf.get(String(r.player_sk));
    if (!name) continue;                           // on the report but on nobody's roster here
    onRoster++;
    const pred = horizonFor(a, r);
    const raw = [pred.p[1], pred.p[2], pred.p[3], pred.p[4]];
    let run = 1, bad = false;
    const curve = raw.map((v) => { if (v > run + 1e-9) bad = true; run = Math.min(run, v); return run; });
    if (bad) clamped++;
    curves.set(name, curve);
  }
  return { curves, tailHazard: tail.pooled, fromWeek: week, clamped, onRoster, tailN: tail.n };
}

function buildSeason(season, atWeek = null) {
  const path = `${FOLD_DIR}/artifact-${season}.json`;
  if (!existsSync(path)) return { skip: `no ${path}` };
  const art = loadArtifact(JSON.parse(readFileSync(path, "utf8")));
  const proj = boardProjection(db, season, art, `${season}-09-01`).filter((r) => r.mean > 0);
  if (!proj.length) return { skip: "no projections" };
  if (BLEND_ANY) {
    const pct = loadConsensusPct(db);
    const input = proj.map((p) => ({ name: p.name_key ?? nameKey(p.name), pos: p.pos, points: p.mean }));
    const out = blendConsensus(input, (pos, name) => pct.get(`${season}|${pos}|${name}`) ?? null, BLEND_W);
    for (let i = 0; i < proj.length; i++) proj[i].mean = out[i].points;
  }

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

  // THE ROSTERS. Post-draft (the preseason question) or AS OF WEEK W (the in-season gate). Both carry
  // the season's outcomes on the team so the scoring below is one code path.
  const picks = atWeek == null
    ? db.prepare(
      `SELECT p.team_id, p.name, p.pos, NULL AS player_sk, t.owner, t.team_name, t.wins, t.points_for, t.playoff_seed,
              t.final_rank, t.champion, t.made_playoffs
         FROM fact_draft_pick p JOIN fact_team_season t ON t.league_id = p.league_id AND t.season = p.season AND t.team_id = p.team_id
        WHERE p.league_id = ? AND p.season = ? ORDER BY p.pick_order`,
    ).all(LEAGUE, season)
    : db.prepare(
      `SELECT r.team_id, r.name, r.pos, r.player_sk, t.owner, t.team_name, t.wins, t.points_for, t.playoff_seed,
              t.final_rank, t.champion, t.made_playoffs
         FROM fact_roster_week r JOIN fact_team_season t ON t.league_id = r.league_id AND t.season = r.season AND t.team_id = r.team_id
        WHERE r.league_id = ? AND r.season = ? AND r.week = ? ORDER BY r.team_id, r.name`,
    ).all(LEAGUE, season, Math.min(atWeek, 17));
  if (!picks.length) return { skip: atWeek == null ? "no picks" : `no rosters for week ${atWeek}` };

  const byTeam = new Map();
  let matched = 0, missed = 0;
  const rostered = new Set();
  const skOf = new Map();                          // projection name -> player_sk (in-season only)
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
    if (p.player_sk != null) skOf.set(pr.name, String(p.player_sk));
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
    const g = db.prepare("SELECT home_id, away_id FROM fact_matchup WHERE league_id = ? AND season = ? AND week = ?").all(LEAGUE, season, w)
      .map((x) => [idx.get(String(x.home_id)), idx.get(String(x.away_id))])
      .filter(([a, b]) => a != null && b != null);
    if (g.length) weeks.push(g);
  }
  if (weeks.length !== reg) return { skip: `schedule has ${weeks.length} of ${reg} regular-season weeks` };

  // THE SEASON SO FAR, for the in-season gate: standings from the W-1 settled weeks (started points
  // per team-week from fact_lineup_week, head-to-head from fact_matchup) and each man's
  // rest-of-season line from his W-1 weeks, in the frame the blend was fitted in (per non-bye week,
  // a missed game a zero). Both are built here and applied per ARM in the run loop, so arms A, B and
  // C differ in exactly one thing each.
  let played = null;
  const rosOf = new Map();
  let rosK = Infinity;
  if (atWeek != null && atWeek > 1) {
    const playedWeeks = Math.min(atWeek - 1, reg);
    const startedPts = new Map();
    for (const r of db.prepare("SELECT week, team_id, started_pts FROM fact_lineup_week WHERE league_id = ? AND season = ? AND week <= ?").all(LEAGUE, season, playedWeeks)) {
      startedPts.set(`${r.week}|${r.team_id}`, r.started_pts);
    }
    const wins = teams.map(() => 0), pts = teams.map(() => 0);
    for (let w = 1; w <= playedWeeks; w++) {
      teams.forEach((t, i) => { pts[i] += startedPts.get(`${w}|${t.id}`) ?? 0; });
      for (const [a, b] of weeks[w - 1]) {
        const sa = startedPts.get(`${w}|${teams[a].id}`) ?? 0, sb = startedPts.get(`${w}|${teams[b].id}`) ?? 0;
        if (sa >= sb) wins[a]++; else wins[b]++;
      }
    }
    played = { weeks: playedWeeks, wins, pts };
    const { blend } = loadRosBlend();
    rosK = blend.K;
    if (rosK !== Infinity) {
      const rate = new Map();
      for (const r of db.prepare("SELECT player_sk, pts, is_bye FROM feat_player_week WHERE season = ? AND week <= ? AND player_sk IS NOT NULL").all(season, playedWeeks)) {
        if (r.is_bye) continue;
        const cur = rate.get(String(r.player_sk)) ?? rate.set(String(r.player_sk), { k: 0, pts: 0 }).get(String(r.player_sk));
        cur.k++; cur.pts += r.pts ?? 0;
      }
      for (const t of teams) for (const p of t.roster) {
        const sk = skOf.get(p.name);
        const td = sk ? rate.get(sk) : null;
        if (!td || td.k <= 0) continue;
        const ros = rosPerGame(p.proj / 17, td.k, td.pts, rosK);
        if (ros != null) rosOf.set(p.name, ros);
      }
    }
  }

  // Streaming floor: the second-best UNROSTERED projection at each position, per week. Same rule as
  // src/draft/simContext.ts, which is where it is justified -- INCLUDING the divisor, which is why
  // `--replacement-frame` exists (D25): this file holds a SECOND COPY of that rule, so correcting
  // only the module would have left the arbiter measuring the old behaviour and reporting "no
  // change" -- the fix-two-of-three-callers shape this repo has been burned by before.
  const replacement = {};
  {
    const denom = REPLACEMENT_FRAME === "reg" ? reg : 17;
    const free = {};
    for (const p of proj) if (!rostered.has(p.name)) (free[p.pos] ??= []).push(p.mean);
    for (const [pos, list] of Object.entries(free)) {
      list.sort((a, b) => b - a);
      replacement[pos] = Math.max(0, (list[Math.min(1, list.length - 1)] ?? 0) / denom);
    }
  }

  // THE SEASON'S OWN FORMAT, from ESPN's settings for that season. `playoffFieldFor(teams.length)`
  // is the fallback and it is a PROXY: it infers the field from the team count, which is right for
  // this league's whole history and structurally incapable of being wrong out loud. `--field` forces
  // a constant, which is the arm P49 is registered against.
  const fmtRow = db.prepare(
    "SELECT reg_weeks, playoff_teams, playoff_reseed, seeding_rule, division_count FROM raw_league_season WHERE league_id = ? AND season = ?",
  ).get(LEAGUE, season);
  const espnField = fmtRow?.playoff_teams == null ? null : Number(fmtRow.playoff_teams);
  const field = FIELD_OVERRIDE ?? ((PER_SEASON_FORMAT && espnField != null) ? espnField : playoffFieldFor(teams.length));
  const fieldSource = FIELD_OVERRIDE != null ? `forced ${FIELD_OVERRIDE}`
    : (PER_SEASON_FORMAT && espnField != null) ? "espn" : "team-count proxy";
  const seasonSeeding = PER_SEASON_FORMAT && fmtRow?.seeding_rule ? String(fmtRow.seeding_rule) : SEEDING;
  const seasonReseed = PER_SEASON_FORMAT && fmtRow?.playoff_reseed != null ? Boolean(Number(fmtRow.playoff_reseed)) : true;

  // DIVISIONS, from the league's own raw rows for THAT season -- not from today's four-division
  // config. 2018-2024 really did have one division and 2025 four, so a single hardcoded map would be
  // wrong for seven of the eight seasons while still producing a bracket. A team the rows do not
  // place gets no division, and the whole season falls back to record seeding rather than being
  // handed a division to win by accident.
  let divisionOf;
  {
    const divs = db.prepare("SELECT division_id, team_ids_json FROM raw_league_division WHERE league_id = ? AND season = ? ORDER BY division_id").all(LEAGUE, season);
    if (divs.length > 1) {
      const dOf = new Map();
      divs.forEach((d, i) => { for (const id of JSON.parse(d.team_ids_json)) dOf.set(String(id), i); });
      const mapped = teams.map((t) => dOf.get(String(t.id)));
      if (mapped.every((d) => d != null)) divisionOf = mapped;
    }
  }

  // The seam is an IN-SEASON question: week W's report is what a manager running odds in week W
  // has. The preseason arm has no player_sk on its draft picks and no report that is knowable at a
  // September as-of, so it carries no curves and the knob is inert there -- deliberately.
  const knownInjury = atWeek == null ? null : buildKnownInjury(season, atWeek, skOf);

  return { season, teams, weeks, slots, reg, field, fieldSource, seasonSeeding, seasonReseed, poolRank, replacement, matched, missed, divisionOf, played, rosOf, rosK, knownInjury };
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

// ---------------------------------------------------------------------------------------------
// THE SWEEP AXIS (M2d, 2026-09-16). `--sweep KNOB=v1,v2,...` runs the SAME season, the SAME rosters
// and the SAME seeds once per value of one env-gated dispersion knob, so every arm of a calibration
// experiment comes from ONE version of this script rather than from a script edited between runs --
// the difference that turns a pipeline change into a "result". The first value is the CONTROL and
// MUST be the knob's shipped default, which is asserted by reproducing the flagless number: a sweep
// whose control does not match the recorded figure is measuring something else.
//
// Nothing here writes a default. The knobs are read at call time by src/draft/season.ts and
// src/draft/bootstrap.ts and are no-ops at their default values, so an unswept run of this script is
// byte-identical to the one that produced the D25 record.
//
//   FF_SIM_LEVEL_SCALE  (default 1)    spread of a player's SEASON LEVEL about his target
//   FF_SIM_TEAM_SD      (default 0)    sd of a per-fantasy-roster season-long common factor
//   FF_SIM_WEEKLY_VAR   (default 1)    week-to-week spread WITHIN a drawn season (level preserved)
//   FF_WEEKLY_COUPLING  (default 1.8)  within-week teammate copula multiple
//   FF_SIM_CORR_SCALE   (default 1)    season-level teammate copula multiple
//   FF_SIM_LEVEL_SHRINK (default: the D18 sqrt(K/(K+k)))  in-season level shrink override
//   FF_SIM_LEVEL_PRIOR_WEEKS (default LEVEL_PRIOR_WEEKS = 1, D28)  the level's prior weight in weeks;
//                       6 restores the pre-D28 posture (the ros blend's K), which is D28's rollback
// ---------------------------------------------------------------------------------------------
const SWEEP = val("--sweep", null);
const SWEEP_OUT = val("--sweep-out", null);
const SWEEP_DEFAULTS = {
  FF_SIM_LEVEL_SCALE: "1", FF_SIM_TEAM_SD: "0", FF_SIM_WEEKLY_VAR: "1",
  FF_WEEKLY_COUPLING: "1.8", FF_SIM_CORR_SCALE: "1", FF_SIM_LEVEL_SHRINK: null,
  FF_SIM_LEVEL_PRIOR_WEEKS: String(LEVEL_PRIOR_WEEKS),
  // OFF is the shipped posture. The seam is a model change and D13 plus owner sign-off govern it.
  FF_SIM_KNOWN_INJURY: "0",
};
if (SWEEP) {
  const eq = SWEEP.indexOf("=");
  const knob = eq < 0 ? SWEEP : SWEEP.slice(0, eq);
  if (!(knob in SWEEP_DEFAULTS)) {
    throw new Error(`--sweep "${knob}" is not a knob this simulator has -- use one of ${Object.keys(SWEEP_DEFAULTS).join(", ")}.`);
  }
  const values = SWEEP.slice(eq + 1).split(",").map((s) => s.trim()).filter(Boolean);
  if (!values.length) throw new Error("--sweep needs at least one value");
  const restore = process.env[knob];
  const setKnob = (v) => { if (v === "unset") delete process.env[knob]; else process.env[knob] = v; };

  // Per value: one row per team-season (playoff, and title in the preseason mode), plus the UNSEEDED
  // arm A at every value in the in-season mode -- the D18 dominance assertion has to be re-checked
  // under any change, not assumed to survive it.
  const rows = {}, titleRows = {}, rowsA = {};
  for (const v of values) { rows[v] = []; titleRows[v] = []; rowsA[v] = []; }

  console.log(`SWEEP ${knob} = ${values.join(", ")} -- ${AT_WEEK == null ? "PRESEASON" : `week ${AT_WEEK}`}, ${LO}-${HI}, ${TRIALS} trials, seed ${SEED}, artifacts ${FOLD_DIR}, replacement frame ${REPLACEMENT_FRAME}`);
  console.log(`  control (first value) ${values[0]}; the knob's shipped default is ${SWEEP_DEFAULTS[knob] ?? "the D18 sqrt(K/(K+k))"}\n`);

  for (const season of seasons) {
    const s = buildSeason(season, AT_WEEK);
    if (s.skip) { console.log(`  ${season}  SKIPPED -- ${s.skip}`); continue; }
    if (AT_WEEK != null && AT_WEEK > s.reg + 1) { console.log(`  ${season}  SKIPPED -- week ${AT_WEEK} is past the regular season (${s.reg} weeks)`); continue; }
    const useVm = UNLEAK ? (foldModel("variance", season) ?? vm) : vm;
    const useOutcomes = UNLEAK ? (foldModel("outcomes", season) ?? outcomes) : outcomes;
    const useCorr = UNLEAK ? (foldModel("correlation", season) ?? corr) : corr;
    const base = {
      weeks: s.weeks.length, playoffTeams: s.field, slots: s.slots, flexOk: ["RB", "WR", "TE"],
      seeding: s.seasonSeeding, divisionOf: s.divisionOf, playoffReseed: s.seasonReseed,
      projSd: 0.30, replacement: s.replacement, trials: TRIALS, seed: SEED, poolRank: s.poolRank,
      bootstrap: { outcomes: useOutcomes, corr: useCorr, calibration: "scale" },
      allowIncompleteRosters: true,
    };
    const withRos = s.teams.map((t) => ({ ...t, roster: t.roster.map((p) => (s.rosOf.has(p.name) ? { ...p, rosPerGame: s.rosOf.get(p.name) } : { ...p })) }));
    const servedOpts = AT_WEEK == null
      ? base
      : { ...base, played: s.played ? { ...s.played, priorWeeks: LEVEL_PRIOR_WEEKS } : undefined };
    const cells = [];
    for (const v of values) {
      setKnob(v);
      // The seam reads its env knob HERE rather than in `servedOpts` above, because the sweep sets
      // the knob per value and `servedOpts` is built once per season. Off, the option is absent and
      // `simulateSeasons` takes the branch it took before the seam existed.
      const armOpts = process.env.FF_SIM_KNOWN_INJURY === "1" && s.knownInjury
        ? { ...servedOpts, knownInjury: s.knownInjury }
        : servedOpts;
      const odds = simulateSeasons(AT_WEEK == null ? s.teams : withRos, s.weeks, useVm, armOpts);
      const byId = new Map(odds.map((o) => [o.id, o]));
      const seasonRows = s.teams.map((t) => ({ season, team: t.name, p: byId.get(t.id)?.playoffs ?? s.field / s.teams.length, y: t.outcome.playoffs ? 1 : 0 }));
      rows[v].push(...seasonRows);
      if (AT_WEEK == null) {
        titleRows[v].push(...s.teams.map((t) => ({ season, team: t.name, p: byId.get(t.id)?.champion ?? 1 / s.teams.length, y: t.outcome.champion ? 1 : 0 })));
      } else {
        const oddsA = simulateSeasons(s.teams, s.weeks, useVm, base);   // unseeded, SAME knob value
        const byA = new Map(oddsA.map((o) => [o.id, o]));
        rowsA[v].push(...s.teams.map((t) => ({ season, team: t.name, p: byA.get(t.id)?.playoffs ?? s.field / s.teams.length, y: t.outcome.playoffs ? 1 : 0 })));
      }
      cells.push(brier(seasonRows));
    }
    setKnob(restore === undefined ? "unset" : restore);
    const ki = s.knownInjury;
    const kiNote = knob === "FF_SIM_KNOWN_INJURY"
      ? `   [seam: ${ki ? `${ki.curves.size} curves on ${ki.onRoster ?? 0} rostered, tail ${ki.tailHazard.toFixed(3)} from ${ki.tailN ?? 0}${ki.clamped ? `, ${ki.clamped} clamped` : ""}` : "none"}]`
      : "";
    console.log(`  ${season}  teams ${String(s.teams.length).padStart(2)} reg ${s.reg} field ${s.field}   ` +
      values.map((v, i) => `${v}: ${cells[i].toFixed(4)}`).join("   ") + kiNote);
  }
  if (!rows[values[0]].length) { console.log("nothing scored."); process.exit(1); }

  const seasonsIn = [...new Set(rows[values[0]].map((r) => r.season))].sort();
  const brierOf = (rs) => brier(rs);
  const perSeason = (rs, y) => brier(rs.filter((r) => r.season === y));
  // Season-level paired bootstrap, deterministic: resample the eight seasons with replacement and
  // recompute the mean paired delta. The unit of analysis is the SEASON, per the repo checklist.
  const bootCI = (deltas) => {
    let sd = 987654321;
    const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const means = [];
    for (let b = 0; b < 4000; b++) {
      let sum = 0;
      for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(rnd() * deltas.length)];
      means.push(sum / deltas.length);
    }
    means.sort((a, b) => a - b);
    return [means[Math.floor(0.025 * means.length)], means[Math.floor(0.975 * means.length)]];
  };

  console.log(`\n  POOLED playoff Brier by ${knob} (${rows[values[0]].length} team-seasons), paired against the control ${values[0]}`);
  console.log(`    ${"value".padEnd(10)} ${"playoff".padStart(8)} ${AT_WEEK == null ? `${"title".padStart(8)} ` : ""}${"paired d".padStart(10)} ${"SE".padStart(8)} ${"t".padStart(6)}  ${"95% CI (season bootstrap)".padStart(24)}  wins`);
  for (const v of values) {
    const d = seasonsIn.map((y) => perSeason(rows[v], y) - perSeason(rows[values[0]], y));
    const m = d.reduce((a, x) => a + x, 0) / d.length;
    const sdv = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
    const se = sdv / Math.sqrt(d.length);
    const [lo, hi] = bootCI(d);
    console.log(`    ${String(v).padEnd(10)} ${brierOf(rows[v]).toFixed(4).padStart(8)} ` +
      (AT_WEEK == null ? `${brierOf(titleRows[v]).toFixed(4).padStart(8)} ` : "") +
      `${((m >= 0 ? "+" : "") + m.toFixed(4)).padStart(10)} ${se.toFixed(4).padStart(8)} ${(se > 0 ? m / se : 0).toFixed(2).padStart(6)}  ` +
      `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`.padStart(24) + `  ${d.filter((x) => x < 0).length}/${d.length}`);
  }

  // LEAVE-ONE-SEASON-OUT over the swept values: pick the best value on seven seasons, score the
  // eighth with it, pool. The in-sample best of eight is a winner's curse; this is the number.
  {
    let held = 0, heldN = 0; const picked = [];
    for (const ho of seasonsIn) {
      let best = { v: values[0], b: Infinity };
      for (const v of values) {
        const tr = rows[v].filter((r) => r.season !== ho);
        const b = brier(tr);
        if (b < best.b) best = { v, b };
      }
      picked.push(best.v);
      const te = rows[best.v].filter((r) => r.season === ho);
      held += brier(te) * te.length; heldN += te.length;
    }
    console.log(`\n  LEAVE-ONE-SEASON-OUT over these values: held-out playoff Brier ${(held / heldN).toFixed(4)} ` +
      `(control ${brierOf(rows[values[0]]).toFixed(4)}), value chosen per fold: ${picked.join(", ")}`);
  }

  // The shuffled-outcome control, at every value: a Brier computed against permuted outcomes looks
  // exactly like an honest one.
  for (const v of values) {
    let sd = 1234567;
    const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const out = rows[v].map((r) => ({ ...r }));
    for (const season of new Set(out.map((r) => r.season))) {
      const idx = out.map((r, i) => i).filter((i) => out[i].season === season);
      const ys = idx.map((i) => out[i].y);
      for (let i = ys.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; }
      idx.forEach((i, k) => { out[i].y = ys[k]; });
    }
    console.log(`  CONTROL ${knob}=${v}: shuffled ${brier(out).toFixed(4)} vs honest ${brierOf(rows[v]).toFixed(4)} -> ${brier(out) > brierOf(rows[v]) ? "honest wins" : "WARNING: no better than shuffled"}`);
  }
  if (AT_WEEK != null) {
    console.log(`\n  SEEDED vs UNSEEDED (D18) at every value -- the seeded arm must still dominate`);
    for (const v of values) {
      const d = seasonsIn.map((y) => perSeason(rows[v], y) - perSeason(rowsA[v], y));
      const m = d.reduce((a, x) => a + x, 0) / d.length;
      console.log(`    ${String(v).padEnd(10)} seeded ${brierOf(rows[v]).toFixed(4)}  unseeded ${brierOf(rowsA[v]).toFixed(4)}  paired ${(m >= 0 ? "+" : "") + m.toFixed(4)}  better in ${d.filter((x) => x < 0).length}/${d.length}`);
    }
  }

  for (const v of values) {
    console.log(`\n  RELIABILITY, ${knob}=${v} -- PLAYOFFS`);
    for (const b of reliability(rows[v])) {
      console.log(`    ${`${(100 * b.lo).toFixed(0)}-${(100 * b.hi).toFixed(0)}%`.padEnd(10)} n ${String(b.n).padStart(4)}  predicted ${(100 * b.predicted).toFixed(1).padStart(5)}%  observed ${(100 * b.observed).toFixed(1).padStart(5)}%  gap ${((b.observed - b.predicted) >= 0 ? "+" : "") + (100 * (b.observed - b.predicted)).toFixed(1)}`);
    }
  }
  if (SWEEP_OUT) {
    writeFileSync(SWEEP_OUT, JSON.stringify({ knob, values, atWeek: AT_WEEK, rows, titleRows, rowsA }), "utf8");
    console.log(`\n  wrote per-team-season rows for every value -> ${SWEEP_OUT}`);
  }
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// THE IN-SEASON GATE (--at-week). Three arms per season on the same week-W rosters, scored against
// the same outcomes, paired by season. Exits when done; the preseason report below is untouched.
// ---------------------------------------------------------------------------------------------
if (AT_WEEK != null) {
  console.log(`IN-SEASON CALIBRATION at week ${AT_WEEK} -- ${LO}-${HI}, ${TRIALS} trials, seed ${SEED}, per-fold artifacts from ${FOLD_DIR}, replacement frame ${REPLACEMENT_FRAME}\n`);
  console.log(`  arms: A = from scratch (pre-D18: week-${AT_WEEK} rosters, preseason lines, no standings)   B = A + standings seeded from ${AT_WEEK - 1} settled weeks   C = B + rest-of-season lines   D = C + level uncertainty shrunk by sqrt(K/(K+k)), K = LEVEL_PRIOR_WEEKS ${LEVEL_PRIOR_WEEKS} (D28; =6 restores D18 via FF_SIM_LEVEL_PRIOR_WEEKS)\n`);
  const arms = ["A", "B", "C", "D"];
  const rows = { A: [], B: [], C: [], D: [] };
  const perSeasonBrier = [];
  console.log(`  season teams reg field  played  ros men   Brier A     Brier B     Brier C     Brier D    uniform    (D - A)`);
  for (const season of seasons) {
    const s = buildSeason(season, AT_WEEK);
    if (s.skip) { console.log(`  ${season}  SKIPPED -- ${s.skip}`); continue; }
    if (AT_WEEK > s.reg + 1) { console.log(`  ${season}  SKIPPED -- week ${AT_WEEK} is past the regular season (${s.reg} weeks)`); continue; }
    const useVm = UNLEAK ? (foldModel("variance", season) ?? vm) : vm;
    const useOutcomes = UNLEAK ? (foldModel("outcomes", season) ?? outcomes) : outcomes;
    const useCorr = UNLEAK ? (foldModel("correlation", season) ?? corr) : corr;
    const base = {
      weeks: s.weeks.length, playoffTeams: s.field, slots: s.slots, flexOk: ["RB", "WR", "TE"],
      seeding: s.seasonSeeding, divisionOf: s.divisionOf, playoffReseed: s.seasonReseed,
      projSd: 0.30, replacement: s.replacement, trials: TRIALS, seed: SEED, poolRank: s.poolRank,
      bootstrap: { outcomes: useOutcomes, corr: useCorr, calibration: "scale" },
      allowIncompleteRosters: true,
    };
    const withRos = s.teams.map((t) => ({ ...t, roster: t.roster.map((p) => (s.rosOf.has(p.name) ? { ...p, rosPerGame: s.rosOf.get(p.name) } : { ...p })) }));
    const oddsBy = {
      A: simulateSeasons(s.teams, s.weeks, useVm, base),
      B: simulateSeasons(s.teams, s.weeks, useVm, { ...base, played: s.played ?? undefined }),
      C: simulateSeasons(withRos, s.weeks, useVm, { ...base, played: s.played ?? undefined }),
      D: simulateSeasons(withRos, s.weeks, useVm, { ...base, played: s.played ? { ...s.played, priorWeeks: LEVEL_PRIOR_WEEKS } : undefined }),
    };
    const b = {};
    for (const arm of arms) {
      const byId = new Map(oddsBy[arm].map((o) => [o.id, o]));
      const seasonRows = s.teams.map((t) => ({ season, team: t.name, p: byId.get(t.id)?.playoffs ?? s.field / s.teams.length, y: t.outcome.playoffs ? 1 : 0 }));
      rows[arm].push(...seasonRows);
      b[arm] = brier(seasonRows);
    }
    const bu = brier(s.teams.map((t) => ({ p: s.field / s.teams.length, y: t.outcome.playoffs ? 1 : 0 })));
    perSeasonBrier.push({ season, ...b, uniform: bu });
    console.log(`  ${season}  ${String(s.teams.length).padStart(4)} ${String(s.reg).padStart(4)} ${String(s.field).padStart(5)}  ${String(s.played?.weeks ?? 0).padStart(6)}  ${String(s.rosOf.size).padStart(7)}   ${b.A.toFixed(4)}      ${b.B.toFixed(4)}      ${b.C.toFixed(4)}      ${b.D.toFixed(4)}     ${bu.toFixed(4)}    ${(b.D - b.A >= 0 ? "+" : "") + (b.D - b.A).toFixed(4)}`);
  }
  if (!perSeasonBrier.length) { console.log("nothing scored."); process.exit(1); }
  const n = perSeasonBrier.length;
  const meanOf = (f) => perSeasonBrier.reduce((a, r) => a + f(r), 0) / n;
  const paired = (x, y) => {
    const d = perSeasonBrier.map((r) => r[y] - r[x]);               // positive = y worse than x
    const m = d.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(d.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, n - 1));
    return { m, se: sd / Math.sqrt(n), wins: d.filter((v) => v < 0).length };
  };
  console.log(`\n  POOLED playoff Brier over ${rows.A.length} team-seasons: A ${brier(rows.A).toFixed(4)}   B ${brier(rows.B).toFixed(4)}   C ${brier(rows.C).toFixed(4)}   D ${brier(rows.D).toFixed(4)}   uniform ${meanOf((r) => r.uniform).toFixed(4)}`);
  console.log(`  season-mean Brier:                      A ${meanOf((r) => r.A).toFixed(4)}   B ${meanOf((r) => r.B).toFixed(4)}   C ${meanOf((r) => r.C).toFixed(4)}   D ${meanOf((r) => r.D).toFixed(4)}`);
  for (const [x, y, label] of [["A", "B", "seeding the standings (B vs A)"], ["B", "C", "rest-of-season lines on top (C vs B)"], ["C", "D", "level shrink on top (D vs C)"], ["A", "D", "everything (D vs A)"]]) {
    const p = paired(x, y);
    console.log(`  ${label.padEnd(40)} Brier change ${(p.m >= 0 ? "+" : "") + p.m.toFixed(4)} +/- SE ${p.se.toFixed(4)}  (t ${(p.se > 0 ? p.m / p.se : 0).toFixed(2)}; better in ${p.wins}/${n} seasons)`);
  }
  // THE POSITIVE CONTROL for the served arm, same as the preseason report's: outcomes shuffled within season.
  {
    let sd = 1234567;
    const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const out = rows.D.map((r) => ({ ...r }));
    for (const season of new Set(out.map((r) => r.season))) {
      const idx = out.map((r, i) => i).filter((i) => out[i].season === season);
      const ys = idx.map((i) => out[i].y);
      for (let i = ys.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; }
      idx.forEach((i, k) => { out[i].y = ys[k]; });
    }
    console.log(`  CONTROL, outcomes shuffled within season: D ${brier(out).toFixed(4)} (honest ${brier(rows.D).toFixed(4)}) -> ${brier(out) > brier(rows.D) ? "the honest arm wins; the join is real" : "WARNING: no better than shuffled"}`);
  }
  for (const arm of ["C", "D"]) {
    console.log(`\n  RELIABILITY, arm ${arm} -- what it predicted against what happened`);
    for (const b of reliability(rows[arm])) console.log(`    ${`${(100 * b.lo).toFixed(0)}-${(100 * b.hi).toFixed(0)}%`.padEnd(10)} n ${String(b.n).padStart(4)}  predicted ${(100 * b.predicted).toFixed(1).padStart(5)}%  observed ${(100 * b.observed).toFixed(1).padStart(5)}%`);
  }
  if (JSON_OUT) console.log(JSON.stringify({ atWeek: AT_WEEK, perSeasonBrier, pooled: { A: brier(rows.A), B: brier(rows.B), C: brier(rows.C), D: brier(rows.D) } }, null, 2));
  db.close();
  process.exit(0);
}

const sim = { playoff: [], title: [] };
const uni = { playoff: [], title: [] };
const pf = { playoff: [], title: [] };
const perSeason = [];
const bySeed = new Map();

console.log(`SEASON-SIM CALIBRATION -- ${LO}-${HI}, ${TRIALS} trials, seed ${SEED}, seeding ${SEEDING}, per-fold artifacts from ${FOLD_DIR}\n`);
console.log(`  season teams  reg  field(src)  seeding                 reseed  roster match   champion (seed)      sim's most likely champion`);

for (const season of seasons) {
  const s = buildSeason(season);
  if (s.skip) { console.log(`  ${season}  SKIPPED -- ${s.skip}`); continue; }
  const useVm = UNLEAK ? (foldModel("variance", season) ?? vm) : vm;
  const useOutcomes = UNLEAK ? (foldModel("outcomes", season) ?? outcomes) : outcomes;
  const useCorr = UNLEAK ? (foldModel("correlation", season) ?? corr) : corr;
  const odds = simulateSeasons(s.teams, s.weeks, useVm, {
    weeks: s.weeks.length, playoffTeams: s.field, slots: s.slots, flexOk: ["RB", "WR", "TE"],
    seeding: s.seasonSeeding, divisionOf: s.divisionOf, playoffReseed: s.seasonReseed,
    projSd: 0.30, replacement: s.replacement, trials: TRIALS, seed: SEED, poolRank: s.poolRank,
    bootstrap: { outcomes: useOutcomes, corr: useCorr, calibration: "scale" },
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
  console.log(`  ${season}  ${String(s.teams.length).padStart(4)}  ${String(s.reg).padStart(4)}  ` +
    `${String(s.field).padStart(2)} (${s.fieldSource.padEnd(16)})  ${s.seasonSeeding.padEnd(22)} ${s.seasonReseed ? "yes" : "no "}     ` +
    `${String(s.matched).padStart(4)}/${String(s.matched + s.missed).padEnd(4)}  ` +
    `${(champ ? `${champ.name} (${champ.outcome.seed})` : "?").padEnd(20)} ${simChamp ? `${simChamp.name} ${(100 * simChamp.p).toFixed(1)}%` : "-"}`);
  perSeason.push({ season, teams: s.teams.length, field: s.field, fieldSource: s.fieldSource,
    seeding: s.seasonSeeding, reseed: s.seasonReseed, matched: s.matched, missed: s.missed });
}

if (!sim.playoff.length) { console.log("\nnothing scored."); process.exit(1); }

// PER-SEASON Brier, and the emitted rows. The aggregate hides which season a number came from, and
// the accrual scorer is checked against ONE season, so the two have to be comparable.
{
  const brier1 = (rows) => rows.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / rows.length;
  console.log(`\n  PER-SEASON Brier (the figure the accrual scorer is checked against)`);
  for (const y of [...new Set(sim.playoff.map((r) => r.season))].sort()) {
    const p = sim.playoff.filter((r) => r.season === y), t = sim.title.filter((r) => r.season === y);
    console.log(`    ${y}  playoffs ${brier1(p).toFixed(6)}  title ${brier1(t).toFixed(6)}  (n=${p.length})`);
  }
  if (EMIT_ODDS) {
    const byKey = new Map();
    for (const r of sim.playoff) byKey.set(`${r.season}|${r.team}`, { season: r.season, team: r.team, playoffPct: 100 * r.p, madePlayoffs: r.y });
    for (const r of sim.title) {
      const e = byKey.get(`${r.season}|${r.team}`);
      if (e) { e.titlePct = 100 * r.p; e.champion = r.y; }
    }
    const lines = ["season\tteam\tplayoffPct\ttitlePct\tmadePlayoffs\tchampion"];
    for (const e of byKey.values()) lines.push([e.season, e.team, e.playoffPct, e.titlePct, e.madePlayoffs, e.champion].join("\t"));
    writeFileSync(EMIT_ODDS, lines.join("\n") + "\n", "utf8");
    console.log(`\n  wrote ${byKey.size} team-season odds rows -> ${EMIT_ODDS}`);
  }
}

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
  // THE GAP THIS USED TO REPORT IS CLOSED. Until Phase 3 the SNAPSHOT path existed and the SCORING
  // path did not, so these 32 rows could never have become a Brier score without new code, and this
  // line said so. `src/weekly/scorecard.ts` now carries the `odds` branch and
  // `scripts/odds-accrual-2025.mjs` proves it reproduces THIS harness's 2025 Brier to six decimals
  // (playoffs 0.209587, title 0.052147). The message is corrected rather than deleted: a script that
  // keeps printing a resolved gap is how a stale claim outlives the thing it described.
  console.log(`    scorecard.ts now SCORES this kind too (Phase 3): \`ff scorecard --season 2026\` produces a`);
  console.log(`    Brier and a log loss per model against its own uniform floor once the season settles.`);
  console.log(`    scripts/odds-accrual-2025.mjs checks that scorer against THIS harness on 2025, to six decimals.`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    perSeason,
    brier: { sim: { playoff: brier(sim.playoff), title: brier(sim.title) }, uniform: { playoff: brier(uni.playoff), title: brier(uni.title) } },
    reliability: { playoff: reliability(sim.playoff), title: reliability(sim.title) },
  }, null, 2));
}
db.close();
