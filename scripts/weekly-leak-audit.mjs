// THE LEAKAGE AUDIT ON THE REAL TABLE.
//
// test/weekly-leakage.test.ts proves the BUILDER cannot leak, on a synthetic fixture it controls
// completely. This proves the TABLE THAT ACTUALLY SHIPPED does not, by recomputing three columns
// from the raw weekly facts with an independent implementation and an explicit `week < w` bound, and
// comparing. The two are different questions: a builder can be correct and the table still be stale,
// half-built, or written by an older version of the code.
//
// It is an independent implementation on purpose. Re-running the builder and diffing would compare
// the code against itself, which is the shape this repo has been burned by more than once -- a
// producer that ships its own validator grades its own homework and passes forever.
//
// Each check reports a MISMATCH COUNT and a WORST CASE, and each carries a positive control: the
// same arithmetic with the bound moved to `<= w` must produce mismatches, or the comparison is not
// sensitive to the thing it exists to detect.
//
//   node --import tsx scripts/weekly-leak-audit.mjs [season] [--db path]
import { openDb } from "../src/db/db.js";

const season = Number(process.argv[2] ?? 2023);
const dbArg = process.argv.indexOf("--db");
const db = openDb(dbArg >= 0 ? process.argv[dbArg + 1] : undefined);

const raw = db.prepare(
  "SELECT feat_key, week, pts, opponent, pos FROM feat_player_week WHERE season = ? ORDER BY feat_key, week",
).all(season);
const model = db.prepare(
  `SELECT feat_key, player_sk, week, td_games, td_ppg, t4_mean, dvp_mult, dvp_n, team, pos,
          inj_out, inj_doubtful, inj_questionable, teammates_out, inj_feed
     FROM feat_player_week_model WHERE season = ?`,
).all(season);

// ---- SOURCES FOR THE AVAILABILITY AUDIT (Phase 2d) ----
// Read here rather than inside the audit so the DB handle closes at the same point it always did.
const games = db.prepare(
  "SELECT week, home_team, away_team, gameday FROM raw_nfl_game WHERE season = ? AND game_type = 'REG'",
).all(season);
const injuries = db.prepare(
  `SELECT week, gsis_id, report_status, as_of, team, position FROM raw_injury
    WHERE season = ? AND as_of IS NOT NULL AND gsis_id IS NOT NULL ORDER BY as_of`,
).all(season);
const skOf = new Map(
  db.prepare("SELECT gsis_id, player_sk FROM stg_player WHERE gsis_id IS NOT NULL AND COALESCE(ambiguous, 0) = 0")
    .all().map((r) => [r.gsis_id, Number(r.player_sk)]),
);

// ---- SOURCES FOR THE STREAMING AUDIT (Track C) ----
// The streaming table is audited from the same handle, so a season with no streaming rows reports
// that fact rather than opening a second connection to discover it.
const hasStream = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='feat_player_week_stream'",
).get();
const stream = hasStream ? db.prepare(
  `SELECT feat_key, week, pos, team, opponent, opp_pa_pos, opp_pa_pos_n, opp_def_sacks_pg,
          opp_pass_yds_allowed_pg, team_fga_pg, roof_dome, opp_implied_total
     FROM feat_player_week_stream WHERE season = ?`,
).all(season) : [];
const priorRaw = db.prepare(
  "SELECT week, opponent, pos, pts FROM feat_player_week WHERE season = ? AND pts IS NOT NULL AND opponent IS NOT NULL",
).all(season - 1);
const modelLines = new Map(
  db.prepare("SELECT feat_key, week, total_line, implied_team_total FROM feat_player_week_model WHERE season = ?")
    .all(season).map((r) => [`${r.feat_key}|${r.week}`, r]),
);
db.close();

if (!raw.length || !model.length) {
  console.log(`nothing to audit for ${season} (raw ${raw.length}, model ${model.length})`);
  process.exit(2);
}

// ---- independent recomputation, parameterised by the bound so the control is the SAME code ----
const played = new Map();
for (const r of raw) {
  if (r.pts == null) continue;
  (played.get(r.feat_key) ?? played.set(r.feat_key, new Map()).get(r.feat_key)).set(r.week, r.pts);
}

/** `slack` 0 is the honest bound (weeks < w); 1 is the leak (weeks <= w). */
function expected(key, week, slack) {
  const m = played.get(key);
  if (!m) return { games: 0, ppg: null, t4: null };
  let games = 0, sum = 0;
  const trail = [];
  for (let w = 1; w <= week - 1 + slack; w++) {
    const v = m.get(w);
    if (v == null) continue;
    games++; sum += v;
  }
  for (let w = week - 1 + slack; w >= 1 && trail.length < 4; w--) {
    const v = m.get(w);
    if (v != null) trail.push(v);
  }
  return {
    games,
    ppg: games ? sum / games : null,
    t4: trail.length ? trail.reduce((s, x) => s + x, 0) / trail.length : null,
  };
}

function audit(slack) {
  let n = 0, bad = { games: 0, ppg: 0, t4: 0 }, worst = { ppg: 0, t4: 0 };
  for (const r of model) {
    const e = expected(r.feat_key, r.week, slack);
    n++;
    if ((r.td_games ?? 0) !== e.games) bad.games++;
    const cmp = (got, want, key) => {
      if (got == null && want == null) return;
      if (got == null || want == null) { bad[key]++; return; }
      const d = Math.abs(got - want);
      if (d > 1e-6) { bad[key]++; worst[key] = Math.max(worst[key], d); }
    };
    cmp(r.td_ppg, e.ppg, "ppg");
    cmp(r.t4_mean, e.t4, "t4");
  }
  return { n, bad, worst };
}

const honest = audit(0);
const leaked = audit(1);

console.log(`weekly leak audit -- season ${season}, ${honest.n} model rows recomputed independently\n`);
console.log("            mismatches vs `week < w`   vs `week <= w` (the leak)");
for (const k of ["games", "ppg", "t4"]) {
  console.log(`  ${k.padEnd(8)} ${String(honest.bad[k]).padStart(12)} ${String(leaked.bad[k]).padStart(22)}`);
}
console.log(`\n  worst absolute difference under the honest bound: ppg ${honest.worst.ppg}, t4 ${honest.worst.t4}`);

// ---- the verdicts, each with its control ----
let failed = false;
for (const k of ["games", "ppg", "t4"]) {
  if (honest.bad[k] > 0) {
    failed = true;
    console.log(`\nFAIL: ${k} disagrees with an independent 'weeks strictly before w' recomputation ` +
      `in ${honest.bad[k]} of ${honest.n} rows. Either the table is stale, or a column is reading ` +
      "week w itself.");
  }
  if (leaked.bad[k] === 0) {
    failed = true;
    console.log(`\nFAIL: moving the bound to 'weeks <= w' changed NOTHING for ${k}. This comparison ` +
      "cannot see the leak it exists to detect, so its clean verdict above means nothing.");
  }
}

// DvP is checked separately: it is a team-level statistic and the sensitive assertion is simply that
// the stored multiplier is not degenerate and its n never reaches the current week.
const dvpBad = model.filter((r) => r.dvp_n != null && r.dvp_n > r.week - 1).length;
if (dvpBad) {
  failed = true;
  console.log(`\nFAIL: ${dvpBad} rows carry dvp_n greater than week-1, i.e. the defence's record ` +
    "includes the week being predicted.");
}

// ==================================================================================================
// THE AVAILABILITY BLOCK (Phase 2d): inj_out and teammates_out.
//
// These are the columns that made the two-part model honest, and they are the ones most easily
// leaked, because the injury feed keeps filing all week: a Saturday downgrade to Out is a near-
// perfect predictor of a zero week and is not knowable at the Friday cutoff the builder claims.
//
// Same discipline as above and for the same reason -- an INDEPENDENT recomputation straight from
// `raw_injury` and `raw_nfl_game`, parameterised by the cutoff so the positive control is the same
// code with one number changed. `slackDays` 0 is the honest bound (reports filed at or before this
// team's kickoff minus two days); 2 moves it to kickoff itself, which admits every Saturday and
// gameday filing. That control MUST fire, or this comparison cannot see the leak it exists for.
//
// NOTE ON THE WEDNESDAY PAIR. Phase 2d set out to audit `report_status_wed` and found it empty:
// eleven values across 133,892 player-weeks, because the feed's dated filings land at kickoff minus
// two or later. There is nothing to audit, so the Friday designation -- the column the model
// actually declares -- is audited instead, and the emptiness is reported rather than passed over.
// ==================================================================================================
const shift = (iso, d) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + d * 864e5).toISOString().slice(0, 10) : iso;
};
const gameday = new Map();
for (const g of games) {
  if (!g.gameday || !g.week) continue;
  gameday.set(`${g.home_team}|${g.week}`, g.gameday);
  gameday.set(`${g.away_team}|${g.week}`, g.gameday);
}
/** (week|sk) -> every dated filing, in as_of order. */
const filings = new Map();
for (const r of injuries) {
  const sk = skOf.get(r.gsis_id);
  if (sk == null) continue;
  const k = `${r.week}|${sk}`;
  (filings.get(k) ?? filings.set(k, []).get(k)).push(r);
}
/** The latest filing at or before (this team's kickoff + slackDays - 2). */
function statusAt(week, sk, team, slackDays) {
  const day = gameday.get(`${team}|${week}`);
  if (!day) return undefined;
  const cutoff = shift(day, -2 + slackDays);
  let best;
  for (const r of filings.get(`${week}|${sk}`) ?? []) {
    if (r.as_of <= cutoff && (!best || r.as_of > best.as_of)) best = r;
  }
  return best ? best.report_status : null;
}

const avail = model.filter((r) => r.inj_feed === 1 && r.player_sk != null && r.team);
function auditAvail(slackDays) {
  let n = 0, bad = 0;
  for (const r of avail) {
    const want = statusAt(r.week, Number(r.player_sk), r.team, slackDays);
    if (want === undefined) continue;            // no scheduled game for that team-week
    n++;
    if ((r.inj_out ?? 0) !== (want === "Out" ? 1 : 0)) bad++;
  }
  return { n, bad };
}

if (!avail.length) {
  console.log(`\nnote: season ${season} has no league-week where the injury feed published a dated ` +
    "report (inj_feed = 1 nowhere), so the availability block is NOT audited here. From 2025 the " +
    "feed stopped publishing report dates entirely; that is a coverage fact, not a clean bill.");
} else {
  const honestA = auditAvail(0);
  const leakedA = auditAvail(2);
  console.log(`\navailability -- ${honestA.n} rows recomputed from raw_injury independently`);
  console.log(`  inj_out  mismatches vs the Friday cutoff: ${honestA.bad}` +
    `   vs a cutoff moved to kickoff (the leak): ${leakedA.bad}`);
  // THE BOUND IS NOT ZERO, and saying why matters more than the number. This recomputation resolves
  // a filing to a player through the gsis crosswalk ALONE, while the builder goes through
  // buildSourceResolver, which also falls back on name+position+team. That is the point -- an
  // independent implementation that agreed to the last row would be the same implementation -- so a
  // handful of rows differ for reasons that are about identity resolution rather than about time.
  // A LEAK does not look like a handful: moving the cutoff two days admits every Saturday downgrade
  // at once, which is why the discriminating assertion is the RATIO and not the count.
  const rate = honestA.n ? honestA.bad / honestA.n : 0;
  if (rate > 0.005) {
    failed = true;
    console.log(`\nFAIL: inj_out disagrees with an independent recomputation at the Friday cutoff in ` +
      `${honestA.bad} of ${honestA.n} rows (${(100 * rate).toFixed(2)}%), past the 0.5% residual that ` +
      "identity resolution can explain -- either the table is stale or the column is reading a " +
      "filing the builder claims it cannot see.");
  }
  if (!(leakedA.bad >= 2 * Math.max(1, honestA.bad))) {
    failed = true;
    console.log("\nFAIL: moving the injury cutoff from kickoff-minus-two to kickoff barely changed " +
      `anything (${honestA.bad} -> ${leakedA.bad}). This comparison cannot see a late-week downgrade ` +
      "reaching the feature, so its clean verdict above means nothing.");
  }

  // STALENESS, which the recomputation above cannot see: the model table could agree perfectly with
  // the raw feed's TIMING and still have been written by an older build, or joined on the wrong key.
  // So the stored indicator is also checked against the context table it is derived from, and THAT
  // comparison has no identity-resolution slack in it and must be exact.
  const ctxDb = openDb(dbArg >= 0 ? process.argv[dbArg + 1] : undefined);
  const ctx = new Map(ctxDb.prepare(
    "SELECT week, player_sk, report_status_fri FROM feat_player_week_context WHERE season = ?",
  ).all(season).map((r) => [`${r.week}|${r.player_sk}`, r.report_status_fri]));
  ctxDb.close();
  let stale = 0, staleN = 0;
  for (const r of avail) {
    const k = `${r.week}|${Number(r.player_sk)}`;
    if (!ctx.has(k)) continue;
    staleN++;
    if ((r.inj_out ?? 0) !== (ctx.get(k) === "Out" ? 1 : 0)) stale++;
  }
  console.log(`  inj_out vs feat_player_week_context (staleness, must be exact): ${stale} of ${staleN}`);
  if (stale > 0) {
    failed = true;
    console.log(`\nFAIL: ${stale} rows of feat_player_week_model disagree with the context table they ` +
      "are built from. The model table is stale or joined on the wrong key.");
  }

  // teammates_out is a COUNT derived from the same filings, so it gets its own check rather than
  // riding on inj_out's: a count can be right about who is Out and still be scoped to the wrong
  // team, the wrong position, or fail to exclude the player himself.
  const byTeamPos = new Map();
  for (const r of avail) {
    const want = statusAt(r.week, Number(r.player_sk), r.team, 0);
    if (want !== "Out") continue;
    const k = `${r.week}|${r.team}|${r.pos}`;
    (byTeamPos.get(k) ?? byTeamPos.set(k, new Set()).get(k)).add(Number(r.player_sk));
  }
  let tmN = 0, tmBad = 0, tmWorst = 0;
  for (const r of avail) {
    const set = byTeamPos.get(`${r.week}|${r.team}|${r.pos}`);
    const want = set ? set.size - (set.has(Number(r.player_sk)) ? 1 : 0) : 0;
    tmN++;
    const d = Math.abs((r.teammates_out ?? 0) - want);
    if (d > 0) { tmBad++; tmWorst = Math.max(tmWorst, d); }
  }
  console.log(`  teammates_out mismatches vs the same recomputation: ${tmBad} of ${tmN} (worst off by ${tmWorst})`);
  // The recomputation here only sees players who are IN the model table, and the builder counts every
  // player on the injury report -- so a small residual is expected and a large one is not. The bound
  // is stated rather than set to zero, because a zero that is only reachable by making the two
  // computations the same computation is not a check.
  if (tmBad > 0.05 * tmN) {
    failed = true;
    console.log(`\nFAIL: teammates_out disagrees in ${(100 * tmBad / tmN).toFixed(1)}% of rows, well ` +
      "past the residual expected from the two computations having different universes.");
  }
  const tmNonZero = avail.filter((r) => (r.teammates_out ?? 0) > 0).length;
  if (tmNonZero === 0) {
    failed = true;
    console.log("\nFAIL: teammates_out is 0 in every row. A column that can only ever return one " +
      "value is not measuring anything, and its agreement with a recomputation that also returns " +
      "zero everywhere proves nothing.");
  }
}

// ==================================================================================================
// THE STREAMING BLOCK (Track C): feat_player_week_stream.
//
// Twelve columns about the OPPONENT and the STADIUM, and the leak available in them is not a
// player's own week -- it is "what that defence allowed", computed for season Y instead of for the
// weeks before w. Same method as everything above: recompute from the raw facts with an explicit
// bound, and run the SAME code with the bound moved as a positive control.
//
// AN HONEST NOTE ON HOW INDEPENDENT THIS IS. The blend (weights 4 toward the league mean and 6
// toward the prior season) is the SAME arithmetic the builder uses; reimplementing a weighted mean
// differently would test nothing but arithmetic. What is independent here is the SOURCE -- straight
// from feat_player_week and the cached nflverse team-week CSV rather than from the builder -- and
// what is being tested is the BOUND, which is the only part that can leak. So the discriminating
// assertion is the RATIO between the honest bound and the leaked one, exactly as it is for inj_out.
// ==================================================================================================
if (!stream.length) {
  console.log(`\nnote: season ${season} has no feat_player_week_stream rows, so the streaming block ` +
    "is NOT audited here. Run `ff build-streaming-features`. That is a coverage fact, not a clean bill.");
} else {
  const { fetchCsvCached, teamWeekUrl, cacheTag, canonTeam, pick } = await import("../src/data/nflverse.js");
  const SHRINK = 4, PRIOR_W = 6;
  const num = (v) => {
    const s = String(v ?? "").trim();
    if (!s || s === "NA") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const teamWeek = async (yr) => {
    let rows = [];
    try { rows = await fetchCsvCached(teamWeekUrl(yr), cacheTag.teamWeek(yr)); } catch { return []; }
    return rows
      .filter((r) => {
        const t = String(pick(r, "season_type") ?? "").toUpperCase();
        return !t || t === "REG";
      })
      .map((r) => ({
        week: num(pick(r, "week")), team: canonTeam(String(pick(r, "team") ?? "")),
        opponent: canonTeam(String(pick(r, "opponent_team") ?? "")),
        defSacks: num(r.def_sacks), passYards: num(r.passing_yards), fgAtt: num(r.fg_att),
      }))
      .filter((r) => r.week && r.team);
  };
  const twCur = await teamWeek(season), twPrior = await teamWeek(season - 1);

  /** A blended, shrunk mean of `valueOf` attributed to `keyOf`, over weeks < w + slack. */
  const blend = (cur, prior, keyOf, valueOf) => (week, team, slack) => {
    const bound = week - 1 + slack;
    let sum = 0, n = 0, lg = 0, lgN = 0;
    for (const r of cur) {
      const v = valueOf(r); const k = keyOf(r);
      if (v == null || !k || r.week > bound) continue;
      lg += v; lgN++;
      if (k === team) { sum += v; n++; }
    }
    let pSum = 0, pN = 0, pLg = 0, pLgN = 0;
    for (const r of prior) {
      const v = valueOf(r); const k = keyOf(r);
      if (v == null || !k) continue;
      pLg += v; pLgN++;
      if (k === team) { pSum += v; pN++; }
    }
    const leagueMean = lgN > 0 ? lg / lgN : (pLgN > 0 ? pLg / pLgN : null);
    if (leagueMean == null) return null;
    const terms = [[SHRINK, leagueMean]];
    if (n > 0) terms.push([n, sum / n]);
    if (pN > 0) terms.push([PRIOR_W, pSum / pN]);
    const wsum = terms.reduce((s, t) => s + t[0], 0);
    return wsum > 0 ? terms.reduce((s, t) => s + t[0] * t[1], 0) / wsum : null;
  };

  // opp_pa_pos: fantasy points allowed per game to a POSITION, so its denominator is team-games
  // faced rather than rows, and it needs its own recomputation rather than `blend`'s.
  const paOf = (week, team, pos, slack) => {
    const bound = week - 1 + slack;
    let sum = 0, lg = 0;
    const faced = new Set(), lgFaced = new Set();
    for (const r of raw) {
      if (r.pts == null || !r.opponent || r.week > bound) continue;
      lgFaced.add(`${r.opponent}|${r.week}`);
      if (r.pos === pos) lg += r.pts;
      if (r.opponent === team) {
        faced.add(r.week);
        if (r.pos === pos) sum += r.pts;
      }
    }
    let pSum = 0, pLg = 0;
    const pFaced = new Set(), pLgFaced = new Set();
    for (const r of priorRaw) {
      if (r.pts == null || !r.opponent) continue;
      pLgFaced.add(`${r.opponent}|${r.week}`);
      if (r.pos === pos) pLg += r.pts;
      if (r.opponent === team) {
        pFaced.add(r.week);
        if (r.pos === pos) pSum += r.pts;
      }
    }
    const leagueMean = lgFaced.size > 0 ? lg / lgFaced.size : (pLgFaced.size > 0 ? pLg / pLgFaced.size : null);
    if (leagueMean == null) return { value: null, n: faced.size };
    const terms = [[SHRINK, leagueMean]];
    if (faced.size > 0) terms.push([faced.size, sum / faced.size]);
    if (pFaced.size > 0) terms.push([PRIOR_W, pSum / pFaced.size]);
    const wsum = terms.reduce((s, t) => s + t[0], 0);
    return { value: terms.reduce((s, t) => s + t[0] * t[1], 0) / wsum, n: faced.size };
  };

  const sacksOf = blend(twCur, twPrior, (r) => r.team, (r) => r.defSacks);
  const passOf = blend(twCur, twPrior, (r) => r.opponent, (r) => r.passYards);
  const fgaOf = blend(twCur, twPrior, (r) => r.team, (r) => r.fgAtt);

  // A SAMPLE, not every row: the recomputation above is O(rows) per lookup and the whole table is
  // ~12k rows a season. Every third week, every row in it -- which is thousands of comparisons and
  // enough to make a systematic one-week shift impossible to miss, while a single leaked row would
  // not be a leak, it would be a data error.
  const sample = stream.filter((r) => r.week % 3 === 2 && r.opponent && r.team);
  function auditStream(slack) {
    const bad = { opp_pa_pos: 0, opp_def_sacks_pg: 0, opp_pass_yds_allowed_pg: 0, team_fga_pg: 0 };
    let n = 0;
    for (const r of sample) {
      n++;
      const cmp = (got, want, key) => {
        if (got == null || want == null) return;
        if (Math.abs(got - want) > 1e-6) bad[key]++;
      };
      cmp(r.opp_pa_pos, paOf(r.week, r.opponent, r.pos, slack).value, "opp_pa_pos");
      cmp(r.opp_def_sacks_pg, sacksOf(r.week, r.opponent, slack), "opp_def_sacks_pg");
      cmp(r.opp_pass_yds_allowed_pg, passOf(r.week, r.opponent, slack), "opp_pass_yds_allowed_pg");
      cmp(r.team_fga_pg, fgaOf(r.week, r.team, slack), "team_fga_pg");
    }
    return { n, bad };
  }
  const honestS = auditStream(0);
  const leakedS = auditStream(1);
  console.log(`\nstreaming -- ${honestS.n} rows recomputed independently (every third week of ${season})`);
  console.log("            mismatches vs `week < w`   vs `week <= w` (the leak)");
  for (const k of Object.keys(honestS.bad)) {
    console.log(`  ${k.padEnd(24)} ${String(honestS.bad[k]).padStart(6)} ${String(leakedS.bad[k]).padStart(22)}`);
  }
  for (const k of Object.keys(honestS.bad)) {
    if (honestS.bad[k] > 0) {
      failed = true;
      console.log(`\nFAIL: ${k} disagrees with an independent 'weeks strictly before w' recomputation ` +
        `in ${honestS.bad[k]} of ${honestS.n} sampled rows. Either the table is stale or the column ` +
        "is reading week w itself.");
    }
    if (leakedS.bad[k] === 0) {
      failed = true;
      console.log(`\nFAIL: moving the bound to 'weeks <= w' changed NOTHING for ${k}. This comparison ` +
        "cannot see the leak it exists to detect, so its clean verdict above means nothing.");
    }
  }

  // The count of opponent-games behind opp_pa_pos must never reach the week being predicted -- the
  // defence-side version of the same claim, asserted on the stored column rather than recomputed.
  const nBad = stream.filter((r) => r.opp_pa_pos_n != null && r.opp_pa_pos_n > r.week - 1).length;
  if (nBad) {
    failed = true;
    console.log(`\nFAIL: ${nBad} rows carry opp_pa_pos_n greater than week-1, i.e. the defence's ` +
      "record includes the week being predicted.");
  }

  // opp_implied_total is derived, not accumulated, so it cannot leak by a bound -- it can only be
  // WRONG, which a recomputation from the two published lines catches exactly.
  let oitN = 0, oitBad = 0;
  for (const r of stream) {
    const m = modelLines.get(`${r.feat_key}|${r.week}`);
    if (!m || m.total_line == null || m.implied_team_total == null || r.opp_implied_total == null) continue;
    oitN++;
    if (Math.abs(r.opp_implied_total - (m.total_line - m.implied_team_total)) > 1e-6) oitBad++;
  }
  console.log(`  opp_implied_total vs total_line - implied_team_total (must be exact): ${oitBad} of ${oitN}`);
  if (oitBad > 0) {
    failed = true;
    console.log("\nFAIL: opp_implied_total is not the published total minus this team's implied total.");
  }

  // AND THE COLUMNS THAT MUST NOT EXIST. Observed weather is the most attractive leak on this table
  // and its absence is a claim worth checking rather than trusting.
  const cols = new Set(Object.keys(stream[0] ?? {}));
  for (const banned of ["temp", "wind", "temperature", "wind_mph"]) {
    if (cols.has(banned)) {
      failed = true;
      console.log(`\nFAIL: feat_player_week_stream carries '${banned}'. raw_nfl_game's weather is ` +
        "OBSERVED, not forecast -- it is not knowable before kickoff and must not be a feature.");
    }
  }
}

console.log(failed ? "\nAUDIT FAILED" : "\nAUDIT PASSED -- and the leaked-bound control fired on every column, so it was capable of failing.");
process.exit(failed ? 1 : 0);
