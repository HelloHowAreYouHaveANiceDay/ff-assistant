// THE (lead, backup) PAIRS BOTH HANDCUFF EXPERIMENTS SCORE, in one place.
//
// `handcuff-gate.mjs` scores the SHIPPED lift against reality; `handcuff-lift-screen.mjs` fits a
// replacement and scores that. If each built its own pairs they would drift, and a difference
// between the two experiments would be unattributable -- which is the whole failure this repo keeps
// paying for. One builder, both callers.
//
// EVERY INPUT IS HINDSIGHT-FREE. Depth order, the projection proxy and the pool rank come from the
// PRIOR season. Two corrections are baked in because both were found the hard way:
//
//   - THE LEAD MUST BE ROSTERABLE (`leadMaxRank`). Calling every team's best-by-prior-total a "lead"
//     admits marginal players who vanish from weeks for reasons unrelated to injury: 99.7% of them
//     missed a week, at a 24.4% rate against a model that says 7.4%.
//   - THE BYE IS NOT AN ABSENCE. A bye week has no row, so counting it as a missed game inflated
//     every measured rate by roughly one game -- the exact quantity `leadMissProb` divides by 16/17
//     to avoid. Each team's bye is derived as the one week nobody on it appears.
import { readFileSync } from "node:fs";

export const POS = ["QB", "RB", "WR", "TE"];
export const REG = 16;

/** season -> pos -> name -> { weeks: Map<week,pts>, team, total } */
export function loadHistory(path = "data/history-weekly.csv") {
  const H = new Map();
  for (const line of readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const s = Number(f[0]), name = f[1], pos = (f[2] ?? "").toUpperCase(), wk = Number(f[3]), pts = Number(f[4]), team = f[5];
    if (!POS.includes(pos) || !Number.isFinite(pts) || !Number.isFinite(wk) || wk > REG) continue;
    if (!H.has(s)) H.set(s, new Map());
    const byPos = H.get(s);
    if (!byPos.has(pos)) byPos.set(pos, new Map());
    const byName = byPos.get(pos);
    if (!byName.has(name)) byName.set(name, { weeks: new Map(), team, total: 0 });
    const r = byName.get(name);
    r.weeks.set(wk, pts); r.total += pts; r.team = team || r.team;
  }
  return H;
}

/** season|team -> the one week nobody on that team appears. Absent when the team's coverage is not
 *  clean enough to be sure (anything other than exactly one missing week). */
export function byeIndex(H) {
  const BYE = new Map();
  for (const [season, byPos] of H) {
    const weeksByTeam = new Map();
    for (const [, byName] of byPos) {
      for (const [, r] of byName) {
        if (!r.team) continue;
        if (!weeksByTeam.has(r.team)) weeksByTeam.set(r.team, new Set());
        for (const w of r.weeks.keys()) weeksByTeam.get(r.team).add(w);
      }
    }
    for (const [team, played] of weeksByTeam) {
      const missing = [];
      for (let w = 1; w <= REG; w++) if (!played.has(w)) missing.push(w);
      if (missing.length === 1) BYE.set(season + "|" + team, missing[0]);
    }
  }
  return BYE;
}

/**
 * One row per (lead, backup) pair, carrying everything either experiment needs.
 *
 * `basePerWk` / `leadPerWk` are PRIOR-season totals over 16 -- a stand-in for the projection the
 * board would actually hold. Good enough to rank with and to compare two lift models against each
 * other; too crude to read as an absolute calibration constant, which is why both callers report
 * ratios rather than claiming a fitted number.
 */
export function buildPairs(H, BYE, { from, to, leadMaxRank = 36 } = {}) {
  const seasons = [...H.keys()].sort((a, b) => a - b);
  const out = [];
  for (const season of seasons.filter((s) => (from == null || s >= from) && (to == null || s <= to))) {
    const prevIdx = seasons.indexOf(season) - 1;
    if (prevIdx < 0) continue;
    const prev = H.get(seasons[prevIdx]), cur = H.get(season);
    if (!prev || !cur) continue;

    for (const pos of POS) {
      const prevByName = prev.get(pos), curByName = cur.get(pos);
      if (!prevByName || !curByName) continue;
      const pool = [...prevByName].map(([name, r]) => ({ name, total: r.total })).sort((a, b) => b.total - a.total);
      const rankOf = new Map(pool.map((p, i) => [p.name, i]));

      const byTeam = new Map();
      for (const [name, r] of curByName) {
        const p = prevByName.get(name);
        if (!p || !r.team) continue;
        if (!byTeam.has(r.team)) byTeam.set(r.team, []);
        byTeam.get(r.team).push({ name, priorTotal: p.total, cur: r });
      }
      for (const [, men] of byTeam) {
        men.sort((a, b) => b.priorTotal - a.priorTotal);
        const lead = men[0];
        if (!lead || lead.priorTotal <= 0 || men.length < 2) continue;
        const leadRank = rankOf.get(lead.name);
        if (leadRank == null || leadRank >= leadMaxRank) continue;
        const leadPerWk = lead.priorTotal / REG;
        const frac = leadRank / Math.max(1, pool.length);
        const leadBye = BYE.get(season + "|" + lead.cur.team) ?? null;
        const playable = leadBye != null ? REG - 1 : REG;

        let leadMissedGames = 0;
        for (let w = 1; w <= REG; w++) if (w !== leadBye && !lead.cur.weeks.has(w)) leadMissedGames++;

        for (const [bi, b] of men.slice(1, 3).entries()) {
          if (b.priorTotal <= 0) continue;
          const depthOrder = bi + 2;
          const basePerWk = b.priorTotal / REG;

          const playedPts = [], missedPts = [];
          for (let w = 1; w <= REG; w++) {
            if (w === leadBye) continue;
            const pts = b.cur.weeks.get(w);
            if (pts == null) continue;
            if (lead.cur.weeks.has(w)) playedPts.push(pts); else missedPts.push(pts);
          }
          const observedBase = playedPts.length ? playedPts.reduce((x, y) => x + y, 0) / playedPts.length : basePerWk;
          // What he ACTUALLY averaged in the weeks the lead was out -- the quantity a lift model
          // predicts. Null when the lead never missed, because there is nothing to have observed.
          const observedActive = missedPts.length ? missedPts.reduce((x, y) => x + y, 0) / missedPts.length : null;
          const realised = missedPts.reduce((a, p) => a + (p - observedBase), 0);

          out.push({
            season, pos, depthOrder, lead: lead.name, backup: b.name,
            basePerWk, leadPerWk, frac, playable, leadMissedGames,
            // How many weeks the contrast is built from on EACH side. `observedBase` silently falls
            // back to the projection proxy when `playedWeeks` is 0, so a caller fitting a
            // within-player ratio must be able to exclude that case rather than measure the proxy.
            playedWeeks: playedPts.length, activeWeeks: missedPts.length,
            observedBase, observedActive, realised,
          });
        }
      }
    }
  }
  return out;
}
