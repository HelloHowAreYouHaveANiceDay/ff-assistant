// THE K / DST STREAMING REPLAY (2026-09-25) -- does streaming a kicker or defence on its MATCHUP beat
// starting the one you hold, on this league's real rosters and real free-agent pools?
//
//   node --import tsx scripts/stream-replay.mjs [--seasons 2018-2025] [--from-week 3] [--league 462233]
//
// One decision per (season, week, team, position). Points are the format's own weekly points
// (`feat_player_week.pts`) for every man, so ours and a free agent's are on one scale.
//
// AVAILABILITY IS REAL: a free agent is claimable for week w only if he was in the league's free-agent
// pool at BOTH week w-1 (claimable) and week w (nobody else took him that week) -- fifteen other
// managers stream too.
//
// PROJECTION, point-in-time only:
//   rate  the rest-of-season blend (K*line + k*to-date)/(K+k) with the per-position prior weight
//         (`rosKFor`: DST 20, K 6), on weeks before w.
//   matchup  Vegas implied points before kickoff: the OPPONENT's for a defence (fewer is better),
//         the player's OWN team's for a kicker (more is better). Coefficient b fitted LEAVE-ONE-
//         SEASON-OUT on 2012-2025: (pts - rate) ~ b * (x - mean x). proj = rate + b * (x - xbar).
//
// ARMS, all vs HOLD (start the best of the men WE rostered that week, by the same projection):
//   STREAM     start the best of ours + claimable free agents by projection (rate + matchup).
//   STREAM2    the SECOND-best claimable free agent (a stand-in for losing the first to a rival).
//   RATE       same as STREAM but projection = rate only (no matchup) -- isolates the matchup term.
//   IMPLIED    the matchup ALONE: start whichever of ours + the best claimable has the highest own
//              implied total (K) / faces the lowest opponent implied total (DST). No rate at all.
//   HINDSIGHT  the best realised score among ours + claimable (positive control; not achievable).
// Reported by season (the unit), split into weeks our man is on BYE and weeks he is not -- the bye
// weeks are where any streamer wins; the matchup question is the NON-bye weeks.
import Database from "better-sqlite3";
import { loadRosBlend, rosKFor } from "../src/draft/rosBlend.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2018-2025").split("-").map(Number);
const FROM = Number(val("--from-week", "3"));
const LEAGUE = val("--league", "462233");
const db = new Database("data/ff.db", { readonly: true });
const { blend } = loadRosBlend();
const POS = ["DST", "K"];

// ---- the outcome/feature table, 2012-2025 (fit) + the replay seasons ----
const rows = db.prepare(
  `SELECT f.season, f.week, f.player_sk sk, f.pos, f.pts, f.is_bye, f.implied_team_total it, f.total_line tl, m.season_line_pg line
     FROM feat_player_week f LEFT JOIN feat_player_week_model m ON m.season=f.season AND m.week=f.week AND m.feat_key=f.feat_key
    WHERE f.pos IN ('DST','K') AND f.season BETWEEN 2012 AND ? AND f.player_sk IS NOT NULL`,
).all(HI);
const bySk = new Map();   // `${season}|${sk}` -> Map(week -> row)
for (const r of rows) {
  const k = `${r.season}|${r.sk}`;
  (bySk.get(k) ?? bySk.set(k, new Map()).get(k)).set(r.week, r);
}
const xOf = (r) => {
  if (r.it == null) return null;
  return r.pos === "DST" ? (r.tl != null ? r.tl - r.it : null) : r.it;   // opponent's implied (DST) / own (K)
};
const lineOf = (season, sk) => {
  const wk = bySk.get(`${season}|${sk}`);
  if (!wk) return null;
  for (const r of wk.values()) if (r.line != null) return r.line;
  return null;
};
const rateAt = (season, sk, pos, w) => {
  const wk = bySk.get(`${season}|${sk}`);
  const line = lineOf(season, sk);
  let k = 0, pts = 0;
  if (wk) for (const [week, r] of wk) if (week < w && !r.is_bye) { k++; pts += r.pts ?? 0; }
  const K = rosKFor(blend, pos);
  if (line == null) return k ? pts / k : null;
  return k ? (K * line + pts) / (K + k) : line;
};

// ---- leave-one-season-out matchup coefficient ----
const fitB = (pos, holdOut) => {
  const pts = [];
  for (const r of rows) {
    if (r.pos !== pos || r.season === holdOut || r.season > 2025 || r.is_bye || r.week < 2) continue;
    const x = xOf(r); if (x == null) continue;
    const rate = rateAt(r.season, r.sk, pos, r.week); if (rate == null) continue;
    pts.push([x, (r.pts ?? 0) - rate]);
  }
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return { b: sxy / sxx, xbar: mx, n: pts.length };
};

const pool = db.prepare("SELECT season, week, player_sk sk, pos FROM fact_fa_pool_week WHERE league_id=? AND pos IN ('DST','K') AND player_sk IS NOT NULL").all(LEAGUE);
const inPool = new Set(pool.map((r) => `${r.season}|${r.week}|${r.sk}`));
const poolAt = new Map();
for (const r of pool) (poolAt.get(`${r.season}|${r.week}|${r.pos}`) ?? poolAt.set(`${r.season}|${r.week}|${r.pos}`, []).get(`${r.season}|${r.week}|${r.pos}`)).push(r.sk);
const roster = db.prepare("SELECT season, week, team_id, player_sk sk, pos FROM fact_roster_week WHERE league_id=? AND pos IN ('DST','K') AND player_sk IS NOT NULL").all(LEAGUE);
const ours = new Map();   // season|week|team|pos -> [sk]
for (const r of roster) (ours.get(`${r.season}|${r.week}|${r.team_id}|${r.pos}`) ?? ours.set(`${r.season}|${r.week}|${r.team_id}|${r.pos}`, []).get(`${r.season}|${r.week}|${r.team_id}|${r.pos}`)).push(r.sk);

const out = [];   // { season, pos, bye, arm, gain }
for (let season = LO; season <= HI; season++) {
  const fits = Object.fromEntries(POS.map((p) => [p, fitB(p, season)]));
  const weeks = [...new Set(roster.filter((r) => r.season === season).map((r) => r.week))].sort((a, b) => a - b);
  const teams = [...new Set(roster.filter((r) => r.season === season).map((r) => r.team_id))];
  for (const w of weeks) {
    if (w < FROM) continue;
    for (const pos of POS) {
      const f = fits[pos];
      const info = (sk) => {
        const r = bySk.get(`${season}|${sk}`)?.get(w);
        if (!r) return null;
        const rate = rateAt(season, sk, pos, w);
        if (rate == null) return null;
        const x = xOf(r);
        // impl: the MATCHUP ALONE, higher = better (own implied for K, minus the opponent's for DST).
        const impl = r.is_bye || x == null ? -1e9 : (pos === "K" ? x : -x);
        return { sk, bye: !!r.is_bye, pts: r.is_bye ? 0 : (r.pts ?? 0), rate, impl, proj: r.is_bye ? -1 : rate + (x == null ? 0 : f.b * (x - f.xbar)), projRate: r.is_bye ? -1 : rate };
      };
      // ACTIVE ONLY (2026-09-25): a free agent counts only if he PLAYED in his team's most recent game
      // before w -- knowable at the time. 40% of pooled kicker-weeks are men who did not play (backups,
      // cut or inactive kickers still carrying a team's label); a rule keyed on the TEAM's implied total
      // picked them 54% of the time on high-scoring teams and scored zeros (the first IMPLIED run, -2.91).
      const activeBefore = (sk) => {
        const wkMap = bySk.get(`${season}|${sk}`);
        if (!wkMap) return false;
        const prior = [...wkMap.entries()].filter(([wk, r]) => wk < w && !r.is_bye).sort((a, b) => b[0] - a[0])[0];
        return !!prior && prior[1].pts != null;
      };
      const claim = (poolAt.get(`${season}|${w}|${pos}`) ?? []).filter((sk) => inPool.has(`${season}|${w - 1}|${sk}`) && activeBefore(sk)).map(info).filter(Boolean);
      const byProj = [...claim].sort((a, b) => b.proj - a.proj);
      const byRate = [...claim].sort((a, b) => b.projRate - a.projRate);
      const byImpl = [...claim].sort((a, b) => b.impl - a.impl);
      for (const t of teams) {
        const mine = (ours.get(`${season}|${w}|${t}|${pos}`) ?? []).map(info).filter(Boolean);
        if (!mine.length) continue;
        const hold = [...mine].sort((a, b) => b.proj - a.proj)[0];
        const bye = mine.every((m) => m.bye);
        const pick = (cands, key) => [...cands].sort((a, b) => b[key] - a[key])[0];
        const stream = pick([...mine, ...byProj.slice(0, 1)], "proj");
        const stream2 = pick([...mine, ...byProj.slice(1, 2)], "proj");
        const rate = pick([...mine, ...byRate.slice(0, 1)], "projRate");
        const impl = pick([...mine, ...byImpl.slice(0, 1)], "impl");
        const hind = pick([...mine, ...claim], "pts");
        for (const [arm, p] of [["STREAM", stream], ["STREAM2", stream2], ["RATE", rate], ["IMPLIED", impl], ["HINDSIGHT", hind]]) {
          out.push({ season, pos, bye, arm, gain: (p?.pts ?? 0) - hold.pts, moved: p && p.sk !== hold.sk });
        }
      }
    }
  }
  console.error(`  ${season}: b(DST)=${fits.DST.b.toFixed(3)} per opp implied pt, b(K)=${fits.K.b.toFixed(3)} per own implied pt`);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const verdict = (per) => {
  const d = per.filter(Number.isFinite), m = mean(d);
  const se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / Math.max(1, d.length - 1));
  return `${m >= 0 ? "+" : ""}${m.toFixed(2)}  SE ${se.toFixed(2)}  ${d.filter((x) => x > 0).length}/${d.length} seasons up  ${m > 2.9 * se ? "BETTER" : m < -2.9 * se ? "WORSE" : "NULL"}`;
};
console.log(`\nK / DST STREAMING REPLAY -- league ${LEAGUE}, ${LO}-${HI}, weeks ${FROM}+; pts per team-week vs HOLD (season as the unit)`);
for (const pos of POS) {
  for (const bye of [false, true]) {
    const sub = out.filter((r) => r.pos === pos && r.bye === bye);
    const n = sub.filter((r) => r.arm === "STREAM").length;
    console.log(`\n  ${pos} -- ${bye ? "OUR MAN ON BYE" : "our man playing"} (${n} team-weeks)`);
    for (const arm of ["STREAM", "STREAM2", "RATE", "IMPLIED", "HINDSIGHT"]) {
      const a = sub.filter((r) => r.arm === arm);
      const per = [...new Set(a.map((r) => r.season))].sort().map((y) => mean(a.filter((r) => r.season === y).map((r) => r.gain)));
      console.log(`    ${arm.padEnd(10)} moved ${String(a.filter((r) => r.moved).length).padStart(4)}/${a.length}   ${verdict(per)}`);
    }
  }
}
