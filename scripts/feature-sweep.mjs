// EVERY FEATURE WE CAN DERIVE, SCREENED AGAINST THE MODEL'S ERROR, IN ONE PASS.
//
//   node --import tsx scripts/feature-sweep.mjs [--refresh]
//
// scripts/nflverse-audit.mjs lists the columns we have never read -- 87 in the player-week feed
// alone. That is an inventory, and an inventory is not a measurement: most of those columns are
// genuinely irrelevant to season-long fantasy, and the ones that are not cannot be picked out by
// reading their names. So this derives a feature from each plausible column, or combination, and
// screens all of them at once against the residual.
//
// SCREENING AGAINST THE RESIDUAL, not against points, is the whole trick. Correlating a candidate
// with fantasy points mostly re-measures what preseason rank already knows -- carries correlate with
// points because good players get carries. Correlating it with what the model gets WRONG asks the
// only question that matters: does this column know something the model does not?
//
// THE HAZARD, and it is the reason for most of the code below. Screening ~50 candidates at p<0.05
// produces two or three "significant" results from pure noise, every time, by construction. That is
// not a risk, it is arithmetic. Three defences:
//
//   1. BENJAMINI-HOCHBERG false discovery rate control over the whole family, so the reported
//      survivors carry a bounded expected proportion of false ones.
//   2. A NEGATIVE CONTROL -- a seeded random feature. It must not survive. If it does, the screen is
//      broken and every other row on the page is uninterpretable.
//   3. A POSITIVE CONTROL -- age, which we know is real because it is already shipped and measured.
//      It must survive against the bare curve. A screen that only ever reports nothing looks exactly
//      like a screen that is not connected to its data.
//
// Surviving here is a licence to run a proper nested-CV evaluation, and nothing more. The age curve
// and the opportunity model both came in at roughly HALF their claimed lift once the evaluation
// stopped seeing the selection, and every candidate below was selected by looking at these residuals.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseCsv, playerWeekUrl, teamWeekUrl, canonTeam, URLS } from "../src/data/nflverse.ts";

const REFRESH = process.argv.includes("--refresh");
const POS = ["QB", "RB", "WR", "TE"];
const SEASONS = Array.from({ length: 20 }, (_, i) => 2006 + i);
const CACHE = "data/cache";
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };

// Disk-cached fetch. Nineteen season files is roughly 300MB over the wire; re-downloading it on every
// iteration of a screen makes the screen too expensive to iterate on, which is how a sweep silently
// becomes a one-off nobody re-runs.
async function csv(url, tag) {
  const p = `${CACHE}/${tag}.csv.gz`;
  if (!REFRESH && existsSync(p)) return parseCsv(gunzipSync(readFileSync(p)).toString("utf8"));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  writeFileSync(p, gzipSync(Buffer.from(text)));
  return parseCsv(text);
}

// --- the target: what the SHIPPED model gets wrong --------------------------------------------------
//
// PHASE 2a: THE RESIDUALS COME FROM THE SHIPPED PROJECTOR, NOT FROM A REIMPLEMENTATION.
//
// This script used to rebuild the curve internally, hold out a season, and multiply the age and
// opportunity factors back in by hand -- a fourth copy of the projection, screened against its own
// errors. Screening candidates against the residual of a model we do not ship answers a question
// nobody asked, and it is how nested-cv.mjs came to be fitting E[y | rank] for years while the board
// applied an order statistic.
//
//   npm run ff -- evaluate-projection --seasons 2008-2025 --dump-residuals data/residuals.tsv
//   node --import tsx scripts/feature-sweep.mjs --residuals data/residuals.tsv
//
// The rows themselves come from feat_player_season, so prior rank is the one the projector used.
const residArg = (() => { const i = process.argv.indexOf("--residuals"); return i > 0 ? process.argv[i + 1] : "data/residuals.tsv"; })();
if (!existsSync(residArg)) {
  console.error(`${residArg} missing. Produce it with:
  npm run ff -- evaluate-projection --seasons 2008-2025 --dump-residuals ${residArg}

This screen deliberately has NO fallback to an internally-rebuilt model. Screening candidates
against the residual of a model we do not ship is how the harness and the board came to disagree
about what a projection is.`);
  process.exit(1);
}
const { loadFeatures } = await import("./lib/features.mjs");
const featRows = loadFeatures({ from: 2007, to: 2025, pos: POS });
const byKey = new Map(featRows.map((r) => [`${r.season}|${r.pos}|${r.name}`, r]));
const rows = [];
// TWO residual columns, and the distinction is the screen's whole method:
//   resid      against the BARE curve, no multipliers -- "is there signal here at all?"
//   residFull  against the SHIPPED model              -- "is there signal LEFT?"
// A candidate whose two rho values are far apart is already captured by something we ship, and
// adding it would be paying twice for one signal. The bare column is also what keeps the positive
// control alive: age is now a fitted feature, so against the shipped model it MUST measure ~0.
for (const line of readFileSync(residArg, "utf8").trim().split(/\r?\n/).slice(1)) {
  const c = line.split("\t");
  const [season, name, pos, rk] = c;
  if (!POS.includes(pos)) continue;
  const actual = Number(c[5]), mean = Number(c[6]), meanBare = c[11] === "" ? NaN : Number(c[11]);
  const f = byKey.get(`${Number(season)}|${pos}|${name}`);
  rows.push({
    season: Number(season), pos, name, rank: Number(rk),
    y: actual, pred: Number.isFinite(meanBare) ? meanBare : mean,
    resid: actual - (Number.isFinite(meanBare) ? meanBare : mean),
    residFull: actual - mean,
    feat: f ?? null,
  });
}
const seasons = [...new Set(rows.map((r) => r.season))].sort();
console.log(`${rows.length} per-fold residual rows over ${seasons.length} seasons (${seasons[0]}-${seasons[seasons.length - 1]})`);
const scored = rows.filter((r) => Number.isFinite(r.pred) && r.pred > 20 && Number.isFinite(r.residFull));

// --- PRIOR-SEASON player features -------------------------------------------------------------------
// Everything here is measured in season S-1 and screened against the error in season S, which is the
// only ordering a preseason projection could actually use.
console.log(`fetching player-week stats (cached in ${CACHE}) ...`);
const feat = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let raw;
  try { raw = await csv(playerWeekUrl(yr), `pw-${yr}`); } catch { continue; }
  const agg = new Map();
  for (const r of raw) {
    if (r.season_type !== "REG") continue;
    const name = (r.player_display_name || "").trim();
    if (!name || !POS.includes((r.position || "").toUpperCase())) continue;
    let a = agg.get(name);
    if (!a) { a = { g: 0, wk: [] }; agg.set(name, a); }
    a.g += 1;
    a.wk.push(N(r.fantasy_points_ppr));
    const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
    // volume
    add("att", N(r.attempts)); add("cmp", N(r.completions)); add("car", N(r.carries)); add("tgt", N(r.targets)); add("rec", N(r.receptions));
    // yards
    add("pyd", N(r.passing_yards)); add("ryd", N(r.rushing_yards)); add("recyd", N(r.receiving_yards));
    add("pay", N(r.passing_air_yards)); add("ray", N(r.receiving_air_yards));
    add("pyac", N(r.passing_yards_after_catch)); add("ryac", N(r.receiving_yards_after_catch));
    // scoring
    add("ptd", N(r.passing_tds)); add("rtd", N(r.rushing_tds)); add("rectd", N(r.receiving_tds));
    // first downs
    add("pfd", N(r.passing_first_downs)); add("rfd", N(r.rushing_first_downs)); add("recfd", N(r.receiving_first_downs));
    // efficiency / advanced -- rate stats, so averaged over games below
    add("_epaP", N(r.passing_epa)); add("_epaR", N(r.rushing_epa)); add("_epaRec", N(r.receiving_epa));
    add("_cpoe", N(r.passing_cpoe)); add("_pacr", N(r.pacr)); add("_racr", N(r.racr));
    add("_ts", N(r.target_share)); add("_ays", N(r.air_yards_share)); add("_wopr", N(r.wopr));
    // explosives (counts of plays over N yards)
    add("p20", N(r.passing_20)); add("p40", N(r.passing_40));
    add("r20", N(r.rushing_20)); add("r40", N(r.rushing_40));
    add("rec20", N(r.receiving_20)); add("rec40", N(r.receiving_40));
    // negative events
    add("sack", N(r.sacks_suffered)); add("sackyd", N(r.sack_yards_lost));
    add("fum", N(r.fumbles_total)); add("fumlost", N(r.fumbles_lost_total));
    add("pen", N(r.penalties)); add("penyd", N(r.penalty_yards));
    add("int", N(r.passing_interceptions));
    // return work -- a real usage signal for the back half of a depth chart
    add("kr", N(r.kickoff_returns)); add("pr", N(r.punt_returns));
    add("kryd", N(r.kickoff_return_yards)); add("pryd", N(r.punt_return_yards));
    add("sttd", N(r.special_teams_tds)); add("misc", N(r.misc_yards));
    // MID-TIER explosives. The 20+ and 40+ columns catch the highlight plays; the 10/12/16-yard
    // columns are a different thing -- the rate at which a player moves the chains without breaking
    // one. A back who gains 11 yards twice a game and a back who breaks one 40 have the same total
    // and are not the same asset.
    add("p10", N(r.passing_10)); add("p16", N(r.passing_16));
    add("r10", N(r.rushing_10)); add("r12", N(r.rushing_12));
    add("rec10", N(r.receiving_10)); add("rec16", N(r.receiving_16));
    add("twoPt", N(r.passing_2pt_conversions) + N(r.rushing_2pt_conversions) + N(r.receiving_2pt_conversions));
  }
  for (const [name, a] of agg) {
    if (a.g < 4) continue;
    const per = (k) => (a[k] ?? 0) / a.g;
    const rate = (n, d) => (a[d] > 0 ? a[n] / a[d] : null);
    const m = a.wk.reduce((x, y) => x + y, 0) / a.wk.length;
    const v = a.wk.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.wk.length - 1);
    const touches = (a.car ?? 0) + (a.rec ?? 0);
    const yards = (a.ryd ?? 0) + (a.recyd ?? 0);
    feat.set(`${yr}|${name}`, {
      games: a.g,
      // --- volume, per game
      carries: per("car"), targets: per("tgt"), receptions: per("rec"), attempts: per("att"),
      touches: touches / a.g, airYards: per("ray"), passAirYards: per("pay"),
      firstDowns: (per("rfd") + per("recfd")),
      // --- efficiency
      ypc: rate("ryd", "car"), ypt: rate("recyd", "tgt"), ypr: rate("recyd", "rec"),
      ypa: rate("pyd", "att"), cmpPct: rate("cmp", "att"),
      yacPerRec: rate("ryac", "rec"), adot: rate("ray", "tgt"),
      epaPass: per("_epaP"), epaRush: per("_epaR"), epaRec: per("_epaRec"),
      cpoe: per("_cpoe"), pacr: per("_pacr"), racr: per("_racr"),
      targetShare: per("_ts"), airYardsShare: per("_ays"), wopr: per("_wopr"),
      // --- explosive-play rates
      explRush: rate("r20", "car"), explRec: rate("rec20", "tgt"), explPass: rate("p20", "att"),
      breakaway: rate("r40", "car"),
      // --- touchdown dependence: the classic regression candidate. A player whose points came from
      //     scores rather than yards is expected to give some back, because TD rate is far less
      //     stable year to year than volume is.
      tdPerTouch: touches > 0 ? ((a.rtd ?? 0) + (a.rectd ?? 0)) / touches : null,
      tdPerYard: yards > 0 ? ((a.rtd ?? 0) + (a.rectd ?? 0)) / (yards / 100) : null,
      passTdRate: rate("ptd", "att"),
      // --- negative events
      sackRate: a.att > 0 ? (a.sack ?? 0) / (a.att + (a.sack ?? 0)) : null,
      fumblesPerTouch: touches > 0 ? (a.fum ?? 0) / touches : null,
      intRate: rate("int", "att"),
      penalties: per("pen"),
      // --- availability and consistency
      weeklyCv: m > 0 ? Math.sqrt(v) / m : null,
      weeklySd: Math.sqrt(v),
      bestWeek: Math.max(...a.wk), worstWeek: Math.min(...a.wk),
      // --- special teams usage
      returns: (per("kr") + per("pr")),
      returnYards: (per("kryd") + per("pryd")),
      stTds: per("sttd"), miscYards: per("misc"), twoPt: per("twoPt"),
      // --- mid-tier chain-moving rates, distinct from the 20+/40+ highlight rates above
      steadyRush: rate("r10", "car"), steadyRec: rate("rec10", "tgt"), steadyPass: rate("p10", "att"),
      midRush: rate("r12", "car"), midRec: rate("rec16", "tgt"), midPass: rate("p16", "att"),
    });
  }
}

// --- TEAM CONTEXT ---------------------------------------------------------------------------------
// A player's offence is not visible in his own stat line. Two receivers with identical usage on a
// 1,100-play pass-first offence and a 950-play run-first one are not the same asset, and preseason
// rank prices the player rather than the situation he is walking into.
//
// Team is taken from history-weekly (the modal team a player actually played for), so a player who
// changed teams is attributed to where he was, not where the feed's latest_team says he ended up.
const playerTeam = new Map();
{
  const seen = new Map();
  for (const line of readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
    const [s, name, , , , team] = line.split(",");
    if (!team) continue;
    const k = `${s}|${name}`;
    if (!seen.has(k)) seen.set(k, new Map());
    const m = seen.get(k);
    m.set(team, (m.get(team) ?? 0) + 1);
  }
  for (const [k, m] of seen) playerTeam.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
}
console.log("fetching team-week stats ...");
const teamCtx = new Map();
for (const yr of [SEASONS[0] - 1, ...SEASONS]) {
  let raw;
  try { raw = await csv(teamWeekUrl(yr), `tw-${yr}`); } catch { continue; }
  const agg = new Map();
  for (const r of raw) {
    if (r.season_type !== "REG") continue;
    const t = canonTeam((r.team || r.recent_team || "").trim());
    if (!t) continue;
    let a = agg.get(t);
    if (!a) { a = { g: 0 }; agg.set(t, a); }
    a.g += 1;
    const add = (k, v) => { a[k] = (a[k] ?? 0) + v; };
    add("att", N(r.attempts)); add("car", N(r.carries));
    add("pyd", N(r.passing_yards)); add("ryd", N(r.rushing_yards));
    add("ptd", N(r.passing_tds)); add("rtd", N(r.rushing_tds));
    add("pay", N(r.passing_air_yards)); add("epaP", N(r.passing_epa)); add("epaR", N(r.rushing_epa));
    add("tgt", N(r.targets)); add("rec", N(r.receptions));
  }
  for (const [t, a] of agg) {
    const plays = (a.att ?? 0) + (a.car ?? 0);
    teamCtx.set(`${yr}|${t}`, {
      teamPlays: plays / a.g,
      teamPassRate: plays > 0 ? a.att / plays : null,
      teamYards: ((a.pyd ?? 0) + (a.ryd ?? 0)) / a.g,
      teamTds: ((a.ptd ?? 0) + (a.rtd ?? 0)) / a.g,
      teamPassEpa: (a.epaP ?? 0) / a.g,
      teamRushEpa: (a.epaR ?? 0) / a.g,
      teamAirYards: (a.pay ?? 0) / a.g,
    });
  }
}

// --- SCHEDULE AND MARKET CONTEXT --------------------------------------------------------------------
// The games feed carries the betting market, which is the sharpest single estimate of team strength
// that exists, plus the physical environment.
//
// LEAKAGE, handled explicitly: a game's spread and total are set shortly before kickoff, so season-S
// lines encode how season S is going and using them would be cheating. Only WEEK 1 lines of season S
// are taken -- those are published well before the season and are genuinely available at draft time.
// Everything else here is season S-1 and backward-looking.
console.log("fetching schedules ...");
const teamEnv = new Map();      // S-1 environment
const teamMarket = new Map();   // season-S week-1 lines, preseason-knowable
try {
  const games = await csv(URLS.schedules, "schedules");
  const envAgg = new Map();
  for (const g of games) {
    if (g.game_type !== "REG") continue;
    const season = Number(g.season), wk = Number(g.week);
    for (const side of ["home", "away"]) {
      const t = canonTeam((g[`${side}_team`] || "").trim());
      if (!t) continue;
      let a = envAgg.get(`${season}|${t}`);
      if (!a) { a = { g: 0, dome: 0, temp: 0, tempN: 0, wind: 0, windN: 0, div: 0, rest: 0, restN: 0 }; envAgg.set(`${season}|${t}`, a); }
      a.g += 1;
      if (/dome|closed|indoor/i.test(g.roof || "")) a.dome += 1;
      if (/turf|synthetic|astro|field ?turf/i.test(g.surface || "")) a.turf = (a.turf ?? 0) + 1;
      // Primetime: a night kickoff, or any game not on a Sunday. Fewer of them, and they are the
      // games a fantasy roster is most often short-handed for.
      const hh = Number(String(g.gametime || "").slice(0, 2));
      if (Number.isFinite(hh) && hh >= 19) a.prime = (a.prime ?? 0) + 1;
      if (g.weekday && !/sunday/i.test(g.weekday)) a.offday = (a.offday ?? 0) + 1;
      if (g.temp !== "" && g.temp != null) { a.temp += N(g.temp); a.tempN += 1; }
      if (g.wind !== "" && g.wind != null) { a.wind += N(g.wind); a.windN += 1; }
      if (N(g.div_game) === 1) a.div += 1;
      const rest = N(g[`${side}_rest`]);
      if (rest > 0) { a.rest += rest; a.restN += 1; }
      if (wk === 1) {
        // Positive spread_line favours the home team in this feed, so flip it for the away side to
        // get "points this team is favoured by".
        const spread = g.spread_line === "" ? null : N(g.spread_line) * (side === "home" ? 1 : -1);
        const total = g.total_line === "" ? null : N(g.total_line);
        teamMarket.set(`${season}|${t}`, {
          vegasWk1Spread: spread,
          vegasWk1Total: total,
          // Implied team points: half the total, shifted by half the spread. The market's own
          // preseason estimate of how much offence this team will produce.
          vegasImpliedPts: total != null && spread != null ? total / 2 + spread / 2 : null,
        });
      }
    }
  }
  for (const [k, a] of envAgg) {
    teamEnv.set(k, {
      domeShare: a.g > 0 ? a.dome / a.g : null,
      avgTemp: a.tempN > 0 ? a.temp / a.tempN : null,
      avgWind: a.windN > 0 ? a.wind / a.windN : null,
      divShare: a.g > 0 ? a.div / a.g : null,
      avgRest: a.restN > 0 ? a.rest / a.restN : null,
      turfShare: a.g > 0 ? (a.turf ?? 0) / a.g : null,
      primetimeShare: a.g > 0 ? (a.prime ?? 0) / a.g : null,
      offSundayShare: a.g > 0 ? (a.offday ?? 0) / a.g : null,
    });
  }
} catch (e) { console.log(`  schedules feed unavailable: ${e.message}`); }

// --- BIOGRAPHICAL and DRAFT-CAPITAL features ------------------------------------------------------
// Draft capital is the one candidate with a strong prior attached before any measurement: teams give
// early picks the benefit of the doubt for years, and that is opportunity a stat line cannot see.
console.log("fetching players + combine ...");
const bio = new Map();
try {
  for (const r of await csv(URLS.players, "players")) {
    const n = (r.display_name || r.football_name || "").trim();
    if (!n) continue;
    bio.set(n, {
      draftRound: r.draft_round ? Number(r.draft_round) : null,
      draftPick: r.draft_pick ? Number(r.draft_pick) : null,
      height: N(r.height) || null, weight: N(r.weight) || null,
      bmi: N(r.height) > 0 ? (N(r.weight) * 703) / N(r.height) ** 2 : null,
      rookieSeason: r.rookie_season ? Number(r.rookie_season) : null,
      // Birth date straight from the feed. The age used as the positive control comes from our own
      // fitted age-curve map, which only covers players that fit reached; this covers everyone, so a
      // gap in that map cannot masquerade as an absence of age signal.
      birthYear: r.birth_date ? Number(String(r.birth_date).slice(0, 4)) : null,
    });
  }
} catch (e) { console.log(`  players feed unavailable: ${e.message}`); }
const combine = new Map();
try {
  for (const r of await csv(URLS.combine, "combine")) {
    const n = (r.player_name || "").trim();
    if (!n) continue;
    combine.set(n, {
      forty: N(r.forty) || null, vertical: N(r.vertical) || null,
      broad: N(r.broad_jump) || null, cone: N(r.cone) || null, shuttle: N(r.shuttle) || null, bench: N(r.bench) || null,
    });
  }
} catch (e) { console.log(`  combine feed unavailable: ${e.message}`); }

// --- assemble the candidate matrix -----------------------------------------------------------------
let seed = 20260908;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (const r of scored) {
  const f = feat.get(`${r.season - 1}|${r.name}`) ?? {};
  const b = bio.get(r.name) ?? {};
  const c = combine.get(r.name) ?? {};
  // Prior-season team for backward-looking context; the SEASON-S team for the market lines, because
  // where a player will play is known at draft time even though how he plays is not.
  const prevTeam = playerTeam.get(`${r.season - 1}|${r.name}`);
  const thisTeam = playerTeam.get(`${r.season}|${r.name}`);
  const tc = prevTeam ? teamCtx.get(`${r.season - 1}|${prevTeam}`) ?? {} : {};
  const te = prevTeam ? teamEnv.get(`${r.season - 1}|${prevTeam}`) ?? {} : {};
  const tm = thisTeam ? teamMarket.get(`${r.season}|${thisTeam}`) ?? {} : {};
  r.f = { ...f, ...b, ...c, ...tc, ...te, ...tm };
  // Did he change teams? A move resets the depth chart and the scheme, and rank cannot see it.
  r.f.changedTeam = prevTeam && thisTeam ? (prevTeam === thisTeam ? 0 : 1) : null;
  // Experience derived here rather than taken from the feed's own years_of_experience, which is
  // relative to the CURRENT season and would leak the future into a historical row.
  r.f.experience = b.rookieSeason ? r.season - b.rookieSeason : null;
  // Age from the IDENTITY REGISTRY via feat_player_season, not from the age curve's own birthYear
  // map. That map is keyed "POS|Name", which is the join that put a father's birth year on his son.
  //
  // NOTE ON THE POSITIVE CONTROL: age is now a FITTED FEATURE of the trained artifact, so when the
  // residuals come from that rung age SHOULD measure near zero -- the model has already used it.
  // That is the control passing in a new way, and it is only a control at all if the reader is told
  // which rung produced the residuals. Screen against the curve-only rung to get the old reading.
  r.f.age = r.feat?.age ?? null;
  r.f.ageFromFeed = b.birthYear ? r.season - b.birthYear : null;
  r.f.__random = rnd();          // negative control
}

// --- statistics ------------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function spearman(a, b) {
  const rk = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const out = new Array(arr.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
      i = j + 1;
    }
    return out;
  };
  const ra = rk(a), rb = rk(b), ma = mean(ra), mb = mean(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
// Two-sided p from a normal approximation to Fisher's z. Ample at these sample sizes.
const erf = (x) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const pValue = (rho, n) => {
  if (n < 10 || Math.abs(rho) >= 1) return 1;
  const z = Math.atanh(rho) * Math.sqrt(n - 3);
  return 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
};

// Which positions a feature is even defined for -- screening a passing rate across all four positions
// buries a real QB signal in three positions of zeros.
const SCOPE = {
  attempts: ["QB"], ypa: ["QB"], cmpPct: ["QB"], epaPass: ["QB"], cpoe: ["QB"], pacr: ["QB"],
  passTdRate: ["QB"], sackRate: ["QB"], intRate: ["QB"], explPass: ["QB"], passAirYards: ["QB"],
  carries: ["RB", "QB"], ypc: ["RB", "WR"], explRush: ["RB"], breakaway: ["RB"], epaRush: ["RB", "QB"],
  targets: ["RB", "WR", "TE"], receptions: ["RB", "WR", "TE"], ypt: ["WR", "TE", "RB"], ypr: ["WR", "TE", "RB"],
  adot: ["WR", "TE"], racr: ["WR", "TE"], airYards: ["WR", "TE"], airYardsShare: ["WR", "TE"],
  targetShare: ["RB", "WR", "TE"], wopr: ["WR", "TE"], explRec: ["WR", "TE"], epaRec: ["WR", "TE", "RB"],
  yacPerRec: ["WR", "TE", "RB"], returns: ["RB", "WR"], returnYards: ["RB", "WR"],
  steadyPass: ["QB"], midPass: ["QB"], steadyRush: ["RB"], midRush: ["RB"],
  steadyRec: ["WR", "TE", "RB"], midRec: ["WR", "TE"],
  forty: ["RB", "WR", "TE"], vertical: ["RB", "WR", "TE"], broad: ["RB", "WR", "TE"],
  cone: ["RB", "WR", "TE"], shuttle: ["RB", "WR", "TE"], bench: ["RB", "WR", "TE"],
};
const LABEL = {
  __random: "RANDOM (negative control)", age: "age (positive control)",
};

const CANDIDATES = [...new Set(scored.flatMap((r) => Object.keys(r.f)))].sort();
const results = [];
for (const key of CANDIDATES) {
  const scope = SCOPE[key];
  const g = scored.filter((r) => (!scope || scope.includes(r.pos)) && r.f[key] != null && Number.isFinite(r.f[key]));
  if (g.length < 150) continue;
  const xs = g.map((r) => r.f[key]);
  if (new Set(xs).size < 8) continue;            // effectively constant
  const rhoBare = spearman(xs, g.map((r) => r.resid));
  const rho = spearman(xs, g.map((r) => r.residFull));
  results.push({ key, n: g.length, scope: scope ? scope.join("/") : "all", rhoBare, rho, p: pValue(rho, g.length) });
}

// --- Benjamini-Hochberg over the whole family --------------------------------------------------------
const FDR = 0.10;
const byP = [...results].sort((a, b) => a.p - b.p);
let cut = 0;
byP.forEach((r, i) => { if (r.p <= ((i + 1) / byP.length) * FDR) cut = i + 1; });
const passing = new Set(byP.slice(0, cut).map((r) => r.key));
results.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));

console.log(`\n${"=".repeat(96)}`);
console.log(`FEATURE SWEEP -- ${results.length} candidates vs ${scored.length} out-of-sample errors, ${seasons.length} seasons`);
console.log(`Spearman rho against the residual. BH-FDR at ${FDR} over the whole family of ${results.length} tests.`);
console.log(`${"=".repeat(96)}\n`);
console.log("  feature                 scope        n    rho(bare)  rho(shipped)      p     survives FDR");
for (const r of results) {
  const mark = passing.has(r.key) ? "  YES" : "";
  const label = LABEL[r.key] ?? r.key;
  console.log(
    `  ${label.padEnd(24)} ${r.scope.padEnd(11)} ${String(r.n).padStart(5)} ` +
    `${(r.rhoBare >= 0 ? "+" : "") + r.rhoBare.toFixed(3)}`.padStart(11) +
    `${(r.rho >= 0 ? "+" : "") + r.rho.toFixed(3)}`.padStart(14) +
    `${r.p < 1e-4 ? r.p.toExponential(1) : r.p.toFixed(4)}`.padStart(11) + mark,
  );
}

// --- ARE THE SURVIVORS INDEPENDENT? -------------------------------------------------------------------
// Nine surviving QB columns is not nine opportunities. Passing volume, efficiency and touchdown rate
// all move together, so reporting them as separate findings would overstate what is available by
// roughly the number of ways we happened to measure the same thing. Cluster them by mutual
// correlation and treat each cluster as ONE candidate.
const surv = results.filter((r) => passing.has(r.key) && r.key !== "__random" && r.key !== "age");
console.log(`\n${"-".repeat(96)}\nARE THE SURVIVORS INDEPENDENT? (mutual |rho| >= 0.5 grouped)\n`);
const clusters = [];
// Scope must be honoured here too. Without it, two features defined for disjoint positions get
// compared on whatever handful of rows happens to carry both -- a receiver's receptions against a
// quarterback's air yards -- and land in the same cluster on a correlation drawn from noise.
const inScope = (key, r) => { const sc = SCOPE[key]; return (!sc || sc.includes(r.pos)) && r.f[key] != null && Number.isFinite(r.f[key]); };
for (const s of surv) {
  const mine = scored.filter((r) => inScope(s.key, r));
  let placed = false;
  for (const c of clusters) {
    const other = c[0];
    const both = mine.filter((r) => inScope(other.key, r));
    if (both.length > 120 && Math.abs(spearman(both.map((r) => r.f[s.key]), both.map((r) => r.f[other.key]))) >= 0.5) {
      c.push(s); placed = true; break;
    }
  }
  if (!placed) clusters.push([s]);
}
clusters.sort((a, b) => Math.abs(b[0].rho) - Math.abs(a[0].rho));
clusters.forEach((c, i) => {
  console.log(`  cluster ${i + 1} (best rho ${c[0].rho.toFixed(3)}, scope ${c[0].scope}): ${c.map((x) => x.key).join(", ")}`);
});
console.log(`\n  ${clusters.length} independent candidates, not ${surv.length}.`);

// --- the controls decide whether any of the above is readable -----------------------------------------
const neg = results.find((r) => r.key === "__random");
const pos = results.find((r) => r.key === "age");
console.log(`\n${"-".repeat(96)}\nCONTROLS\n`);
if (neg) {
  const ok = !passing.has("__random");
  console.log(`  negative (random column): rho ${neg.rho.toFixed(3)}, p ${neg.p.toFixed(3)} -- ` +
    (ok ? "does NOT survive, as required. The screen is not simply rewarding noise."
        : "*** SURVIVED. The screen is broken and nothing above can be believed. ***"));
}
if (pos) {
  console.log(`  positive (age, already shipped): rho ${pos.rhoBare.toFixed(3)} against the bare curve -- ` +
    (Math.abs(pos.rhoBare) > 0.05 ? "detected, so the screen can find a signal it was not told about."
        : "*** NOT DETECTED. The screen cannot see a feature we know is real; it is mis-wired. ***"));
  console.log(`     and ${pos.rho.toFixed(3)} against the shipped model -- the age factor absorbing its own signal.`);
}
// --- COVERAGE: WHICH RAW COLUMNS HAS THIS SWEEP STILL NEVER TOUCHED? ---------------------------------
// The list of consumed columns is written by hand, which normally rots the moment a feed adds one --
// so it is diffed against the LIVE headers rather than against a second hand-written list. A column
// added upstream shows up here as unconsumed on the next run without anyone remembering to add it.
const CONSUMED = new Set([
  // player-week
  "attempts", "completions", "carries", "targets", "receptions", "passing_yards", "rushing_yards",
  "receiving_yards", "passing_air_yards", "receiving_air_yards", "passing_yards_after_catch",
  "receiving_yards_after_catch", "passing_tds", "rushing_tds", "receiving_tds", "passing_first_downs",
  "rushing_first_downs", "receiving_first_downs", "passing_epa", "rushing_epa", "receiving_epa",
  "passing_cpoe", "pacr", "racr", "target_share", "air_yards_share", "wopr", "passing_20", "passing_40",
  "rushing_20", "rushing_40", "receiving_20", "receiving_40", "sacks_suffered", "sack_yards_lost",
  "fumbles_total", "fumbles_lost_total", "penalties", "penalty_yards", "passing_interceptions",
  "kickoff_returns", "punt_returns", "fantasy_points_ppr",
  "kickoff_return_yards", "punt_return_yards", "special_teams_tds", "misc_yards",
  "passing_10", "passing_16", "rushing_10", "rushing_12", "receiving_10", "receiving_16",
  "passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions",
  // players / combine
  "draft_round", "draft_pick", "height", "weight", "rookie_season", "forty", "vertical", "broad_jump",
  "cone", "shuttle", "bench", "birth_date",
  // schedules
  "roof", "temp", "wind", "div_game", "away_rest", "home_rest", "spread_line", "total_line",
  "surface", "gametime", "weekday",
]);
const FEEDS = {
  "stats_player_week": `${CACHE}/pw-2023.csv.gz`,
  "stats_team_week": `${CACHE}/tw-2023.csv.gz`,
  "players": `${CACHE}/players.csv.gz`,
  "combine": `${CACHE}/combine.csv.gz`,
  "schedules": `${CACHE}/schedules.csv.gz`,
};
// Identifiers and pure labels. Listing them as "unscanned signal" would bury the real gaps.
const IDCOL = /^(season|week|season_type|game_id|player_id|player_name|player_display_name|gsis_id|pfr_id|pff_id|otc_id|esb_id|smart_id|espn_id|yahoo_id|sleeper_id|rotowire_id|rotoworld_id|sportradar_id|fantasy_data_id|team|recent_team|opponent_team|position|position_group|headshot|headshot_url|display_name|full_name|first_name|last_name|common_first_name|short_name|football_name|suffix|status|.*status.*|nfl_id|old_game_id|nfl_detail_id|pff|ftn|gsis|pfr|espn|cfb_id|stadium_id|jersey_number|uniform_number|current_team_id|.*_id)$/;
console.log(`\n${"-".repeat(96)}\nCOVERAGE -- raw columns this sweep has still never derived a feature from\n`);
let totalGap = 0;
for (const [name, path] of Object.entries(FEEDS)) {
  if (!existsSync(path)) { console.log(`  ${name}: not cached, skipped`); continue; }
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  const cols = text.slice(0, text.indexOf("\n")).trim().split(",").map((c) => c.replace(/^"|"$/g, "").trim()).filter(Boolean);
  const gap = cols.filter((c) => !CONSUMED.has(c) && !IDCOL.test(c));
  totalGap += gap.length;
  console.log(`  ${name}: ${cols.length} columns, ${cols.filter((c) => CONSUMED.has(c)).length} consumed, ${gap.length} untouched`);
  if (gap.length) console.log(`    ${gap.join(", ")}\n`);
}
console.log(`  ${totalGap} untouched columns remain.

  Most of what is left is genuinely out of scope rather than overlooked, and it is worth being
  specific about which is which:
    - KICKER and DEFENSE columns (fg_*, pat_*, pt_*, def_*) are unscanned because this sweep runs on
      QB/RB/WR/TE only. They are a separate screen, not a gap in this one.
    - Team-week offensive columns duplicate the player-week ones we already aggregate to team level.
    - Coaching, referee, stadium and gameday columns are labels; using them would be fitting noise
      with a plausible name attached.
  What is NOT excused: anything offensive and player-level still on that list is a real gap.`);

console.log(`
${"-".repeat(96)}
READING THIS

Surviving FDR means "worth the cost of a proper evaluation", not "true" and not "worth shipping".
Every candidate here was chosen by looking at these residuals, which is the same selection effect
that cut the age curve from a claimed +0.0154 R2 to a measured +0.0069 and the opportunity model from
+0.0186 to +0.0095 once nested CV stopped seeing the selection. Expect roughly half.

rho(bare) far from rho(shipped) means an existing feature already captures most of it -- adding it
would be paying twice for one signal. The two columns being close means it is genuinely new.

A SURVIVOR CAN STILL BE A PROXY rather than a feature. primetimeShare is the clearest case here:
the league schedules primetime games for teams it expects to be good, so a high share is mostly a
restatement of preseason team quality -- which vegasImpliedPts measures directly and better. It is
legitimately knowable at draft time (the schedule comes out in May), so it is not leakage; it is
just unlikely to add anything once the market line is in the model. Test correlated survivors
TOGETHER, not one at a time, or the same signal gets paid for twice.

Features are screened only within the positions they exist for. Screening a passing rate across all
four positions buries a real QB effect under three positions of zeros, which is how a sweep returns a
confident nothing.`);
