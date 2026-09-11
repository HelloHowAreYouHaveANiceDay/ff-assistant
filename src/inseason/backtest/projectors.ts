/**
 * PROJECTORS for the progressive-projection experiment -- each maps a point-in-time DecisionMember to
 * a rest-of-season per-game mean, the number a waiver/stream/start decision ranks by. A projector is
 * swapped into `waiverByProjection` (policies.ts) so the decision harness can A/B one projection
 * against another under common random numbers.
 *
 * PHASE 0 is the guillotine: before any real progressive model exists, these four controls prove the
 * harness can SEE projection quality and cannot be FOOLED by noise:
 *   - frozen  : the shipped season line (m.proj). Identical to the harness baseline, so a frozen-vs-
 *               frozen A/B MUST diverge on zero decisions -- proves the injection is wired, nothing more.
 *   - oracle  : peeks at ACTUAL rest-of-season points (the one projector allowed past the firewall).
 *               MUST beat frozen by a wide, CI-clear margin, or the harness cannot detect a better
 *               projection at all and every subsequent null is meaningless.
 *   - noise   : a deterministic fake projection uncorrelated with anything. MUST NOT beat frozen.
 *   - shuffle : a permutation of the real frozen lines across players -- same marginal distribution,
 *               player->projection link destroyed. MUST NOT beat frozen. Catches a "win" that is really
 *               the projection's DISTRIBUTION rather than its per-player signal.
 */
import type { DB } from "../../db/db.js";
import type { DecisionMember } from "./harness.js";

/** A projector returns the rest-of-season per-game mean to rank this player by, as of `week`. */
export type Projector = (m: DecisionMember, season: number, week: number) => number;

/** FROZEN: the shipped season line already on the member. The baseline every candidate is measured
 *  against; as a variant it is the wiring sanity check (must diverge on zero decisions vs itself). */
export const frozenProjector: Projector = (m) => m.proj;

// -- deterministic hashing so noise/shuffle are stable across runs (CRN-safe, no Math.random). --
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** uniform [0,1) from a string key */
const u01 = (key: string): number => fnv(key) / 0x100000000;

/** ORACLE (positive control): the player's realized rest-of-season points per remaining week, counting
 *  bye/out weeks as 0 so it rewards durability the way the realized scorer does. Peeks at the future --
 *  legitimate ONLY as a positive control. If this does not win, the instrument is blind. */
export function makeOracleProjector(db: DB): Projector {
  const bySeason = new Map<number, { pts: Map<string, Map<number, number>>; regWeeks: number }>();
  const load = (season: number) => {
    const pts = new Map<string, Map<number, number>>();
    for (const r of db.prepare(
      `SELECT player_sk, week, pts, is_bye, inj_out FROM feat_player_week_model
        WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { player_sk: string; week: number; pts: number | null; is_bye: number | null; inj_out: number | null }[]) {
      let m = pts.get(r.player_sk); if (!m) { m = new Map(); pts.set(r.player_sk, m); }
      m.set(r.week, r.is_bye || r.inj_out ? 0 : (r.pts ?? 0));
    }
    const regWeeks = (db.prepare(`SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?`).get(season) as { rw: number | null }).rw
      ?? (db.prepare(`SELECT MAX(week) w FROM feat_player_week_model WHERE season=? AND pts IS NOT NULL`).get(season) as { w: number | null }).w
      ?? 14;
    const entry = { pts, regWeeks }; bySeason.set(season, entry); return entry;
  };
  return (m, season, week) => {
    const e = bySeason.get(season) ?? load(season);
    const wk = e.pts.get(m.playerSk);
    let sum = 0, n = 0;
    for (let w = week; w <= e.regWeeks; w++) { sum += wk?.get(w) ?? 0; n++; }
    return n ? sum / n : 0;
  };
}

/** NOISE (negative control): a fake but STABLE projection per (season, player), uncorrelated with
 *  actuals, spread over a plausible fantasy range so it competes with real projections on scale. */
export function makeNoiseProjector(seed = 1): Projector {
  return (m, season) => u01(`${seed}|${season}|${m.playerSk}`) * 18; // ~0..18 ppg
}

/** SHUFFLE (negative control): each player is assigned ANOTHER player's real frozen season line, via a
 *  fixed within-season permutation. Preserves the projection distribution, destroys the per-player
 *  link -- so any "win" it produces is the distribution's doing, not real signal. */
export function makeShuffleProjector(db: DB): Projector {
  const bySeason = new Map<number, Map<string, number>>();
  const load = (season: number) => {
    const rows = db.prepare(
      `SELECT DISTINCT player_sk, season_line_pg FROM feat_player_week_model
        WHERE season=? AND player_sk IS NOT NULL AND season_line_pg IS NOT NULL`,
    ).all(season) as { player_sk: string; season_line_pg: number }[];
    // stable permutation: sort players by a hash, sort lines by value, zip -> each player gets some
    // other player's line, deterministically and bijectively (a genuine permutation of the marginal).
    const players = rows.map((r) => r.player_sk).sort((a, b) => u01(`sh|${season}|${a}`) - u01(`sh|${season}|${b}`));
    const lines = rows.map((r) => r.season_line_pg).sort((a, b) => a - b);
    const map = new Map<string, number>();
    players.forEach((p, i) => map.set(p, lines[i]));
    bySeason.set(season, map); return map;
  };
  return (m, season) => {
    const map = bySeason.get(season) ?? load(season);
    return map.get(m.playerSk) ?? m.proj;
  };
}
