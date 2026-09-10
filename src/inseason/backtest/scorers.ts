/**
 * SCORERS for the decision harness. The default (realizedRestOfSeason, in harness.ts) scores the ONE
 * history that happened. This adds a SIM scorer that integrates over the injury DISTRIBUTION instead:
 * for a roster, it draws each player's weekly availability and score from the fitted variance model
 * (the same `sampleWeek` / tiering the season simulator uses) over the remaining weeks, sets the
 * optimal lineup from whoever is available, and averages many trials. It answers "does this roster
 * do better IN EXPECTATION over the distribution of injuries", not "did it beat the specific injuries
 * of 2018-2025" -- so a conclusion that holds under BOTH scorers is not an artifact of which starters
 * happened to get hurt.
 *
 * WHY EXPECTED POINTS AND NOT PLAYOFF-Δ. Playoff probability needs the whole field's rosters, the H2H
 * schedule and each season's projection pool, and `loadSimContext` builds all of that only for the
 * LIVE season -- there is no stored historical board to reconstruct 2018-2025 sim contexts from. So
 * this scores our roster's expected remaining-season lineup points, which is field-independent and
 * reconstructable per season from the weekly features, and is the tractable robust check.
 *
 * COMMON RANDOM NUMBERS: every draw is a pure function of (player, week, trial), so a player shared
 * between the two policy rosters lives the SAME simulated season in both -- the pairing the harness's
 * difference relies on. This mirrors the identity-keyed draws in season.ts.
 */
import type { DB } from "../../db/db.js";
import { dataPath } from "../../data/paths.js";
import { readFileSync } from "node:fs";
import { optimalLineup, type RosterPlayer } from "../lineup.js";
import { sampleWeek, tierFor, type VarianceModel } from "../../draft/season.js";
import type { DecisionMember, ScoreCtx, Scorer } from "./harness.js";

/** Each player's rank WITHIN his position, by preseason line, for that season -- the pool rank the
 *  variance tiers are fitted against. Reconstructed from feat_player_week_model (not the board, which
 *  is stored only for the live season). Keyed by name, which is what the roster carries. */
export function poolRankFor(db: DB, season: number): Map<string, { rank: number; of: number }> {
  const rows = db.prepare(
    `SELECT name, pos, MAX(season_line_pg) AS line FROM feat_player_week_model
      WHERE season=? AND season_line_pg IS NOT NULL AND name IS NOT NULL GROUP BY name, pos`,
  ).all(season) as { name: string; pos: string; line: number }[];
  const byPos = new Map<string, { name: string; line: number }[]>();
  for (const r of rows) { let l = byPos.get(r.pos); if (!l) { l = []; byPos.set(r.pos, l); } l.push({ name: r.name, line: r.line }); }
  const out = new Map<string, { rank: number; of: number }>();
  for (const l of byPos.values()) { l.sort((a, b) => b.line - a.line); l.forEach((x, i) => out.set(x.name, { rank: i, of: l.length })); }
  return out;
}

/** A deterministic uniform stream seeded by a string -- mulberry32 over an FNV-1a hash. Used so the
 *  draws for (player, week, trial) are identical whichever roster the player sits on. */
function seededRng(key: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The fitted variance model, read once. */
export function loadVarianceModel(): VarianceModel {
  return JSON.parse(readFileSync(dataPath("variance-model.json"), "utf8")) as VarianceModel;
}

/** (season, name) -> variance TIER, cached, from the per-season pool rank. Shared by the sim scorer
 *  and the ceiling function so both tier a player identically. */
export function makeTierFn(db: DB, vm: VarianceModel): (season: number, name: string) => number {
  const poolBySeason = new Map<number, Map<string, { rank: number; of: number }>>();
  const tierCache = new Map<string, number>();
  return (season, name) => {
    const ck = `${season}|${name}`;
    const cached = tierCache.get(ck); if (cached != null) return cached;
    let pool = poolBySeason.get(season); if (!pool) { pool = poolRankFor(db, season); poolBySeason.set(season, pool); }
    const pr = pool.get(name);
    const t = pr ? tierFor(pr.rank / Math.max(1, pr.of), vm.tiers) : 0;
    tierCache.set(ck, t);
    return t;
  };
}

/**
 * A player's weekly CEILING at a decision -- his projected mean scaled by his position/tier boom
 * factor (the p90 of the fitted lognormal weekly distribution). Used to A/B "keep the boom stash"
 * (drop by lowest ceiling) against value-min (drop by lowest mean): they diverge on exactly the
 * low-mean/high-variance body a floor-only view discards. Returns (member, season) -> ceiling points.
 */
export function makeCeilingFn(db: DB): (m: DecisionMember, season: number) => number {
  const vm = loadVarianceModel();
  const tierFn = makeTierFn(db, vm);
  return (m, season) => {
    const posVm = vm.pos[m.pos];
    if (!posVm) return m.proj;
    const tier = tierFn(season, m.name);
    const cv = posVm.cv[tier] ?? posVm.cv[posVm.cv.length - 1] ?? 0.5;
    const sigma = Math.sqrt(Math.log(1 + cv * cv));
    const p90mult = Math.exp(1.2816 * sigma - (sigma * sigma) / 2); // p90 of the E[·]=1 lognormal factor
    return m.proj * p90mult;
  };
}

export function makeSimExpectedScorer(db: DB, opts: { trials?: number; seed?: number } = {}): Scorer {
  const trials = opts.trials ?? 200;
  const seed = opts.seed ?? 7;
  const vm = loadVarianceModel();
  const tierOf = makeTierFn(db, vm);

  return {
    name: `sim-expected (${trials} trials)`,
    score(roster: DecisionMember[], ctx: ScoreCtx): number {
      let total = 0;
      for (let trial = 0; trial < trials; trial++) {
        for (let w = ctx.fromWeek; w <= ctx.toWeek; w++) {
          const players: RosterPlayer[] = roster.map((m) => {
            const posVm = vm.pos[m.pos];
            const tier = tierOf(ctx.season, m.name);
            const rng = seededRng(`${seed}|${m.name}|${w}|${trial}`);
            const avail = posVm ? (posVm.avail[tier] ?? posVm.avail[posVm.avail.length - 1] ?? 0.9) : 0.9;
            const available = rng() < avail;
            const cv = posVm ? (posVm.cv[tier] ?? posVm.cv[posVm.cv.length - 1] ?? 0.5) : 0.5;
            return { name: m.name, pos: m.pos, proj: available ? sampleWeek(m.proj, cv, rng) : 0, available };
          });
          total += optimalLineup(players, ctx.template, ctx.flexOk).totalProj;
        }
      }
      return total / trials;
    },
  };
}
