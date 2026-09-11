/**
 * PHASE 2 of the progressive-projection experiment -- the PROGRESSIVE PROJECTOR.
 *
 * Re-scale the frozen season line by how much a player's ROLE has grown or shrunk vs his own season-
 * to-date level, and IGNORE efficiency entirely (efficiency swings are the noise that sank trailing-
 * points form). Because pts = opportunity x efficiency, a trailing POINTS ratio is just form; the
 * decomposition earns its keep only by trusting the opportunity (role) ratio and discarding the
 * efficiency ratio -- so this projector uses role alone.
 *
 *   mu_hat(w) = season_line_pg x clamp( ((roleRecent + s)/(roleToDate + s))^alpha , [lo, hi] )
 *
 * The design endpoints, each asserted in the Phase-2 test:
 *   - EARLY (games < minGames): returns the frozen line unchanged -- too little to trend on.
 *   - FLAT role (recent == to-date): multiplier 1 -> exactly the frozen line.
 *   - alpha = 0: collapses to the frozen line for EVERY player (the knob-off identity, the analog of
 *     Phase 0's frozen-vs-frozen == 0). Any measured effect must be attributable to alpha > 0.
 *   - RISING role -> above the frozen line (the leading indicator); FALLING -> below.
 * Additive smoothing `s` bounds the role-EMERGENCE case (to-date ~ 0), and the caps stop a small-
 * sample blip from exploding the projection. Only skill positions (role is meaningful) are adjusted.
 */
import type { DB } from "../../db/db.js";
import { makeRoleAggregates } from "./opportunity.js";
import type { Projector } from "./projectors.js";

export interface ProgressiveParams {
  /** trust in the role trend. 0 = ignore it (frozen line); 1 = full ratio. Tuned on holdout. */
  alpha?: number;
  window?: number;      // trailing-window length for roleRecent
  smoothing?: number;   // additive constant bounding the to-date~0 emergence case (role-share units)
  lo?: number; hi?: number;   // multiplier caps
  minGames?: number;    // games observed before we trend at all
  positions?: Set<string>;
}

export function makeProgressiveProjector(db: DB, params: ProgressiveParams = {}): Projector {
  const alpha = params.alpha ?? 0.5;
  const smoothing = params.smoothing ?? 0.1;
  const lo = params.lo ?? 0.5, hi = params.hi ?? 2.0;
  const minGames = params.minGames ?? 2;
  const positions = params.positions ?? new Set(["RB", "WR", "TE"]);
  const roleAgg = makeRoleAggregates(db, { window: params.window ?? 3 });

  return (m, season, week) => {
    if (alpha === 0 || !positions.has(m.pos)) return m.proj;              // knob off / position not role-driven
    const agg = roleAgg(m.playerSk, m.pos, season, week);
    if (!agg || agg.games < minGames) return m.proj;                     // too little observed to trend
    const ratio = (agg.roleRecent + smoothing) / (agg.roleToDate + smoothing);
    const mult = Math.min(hi, Math.max(lo, Math.pow(ratio, alpha)));
    return m.proj * mult;
  };
}

export interface RegimeParams extends ProgressiveParams {
  /** minimum recent-vs-prior role gap (share units) to declare a change-point. Below it -> frozen. */
  threshold?: number;
}

/**
 * PHASE 3 -- the REGIME DETECTOR. Fires ONLY on a change-point: when recent role differs from the
 * PRE-change baseline (rolePrior, which excludes the recent window) by more than `threshold`. Then it
 * re-scales the frozen line by recent/pre-change -- a SHARP step, not diluted by the recent games the
 * way roleToDate is. When no change-point is detected it returns the frozen line, so divergences
 * concentrate on genuine role changes instead of firing on every wobble.
 */
export function makeRegimeProjector(db: DB, params: RegimeParams = {}): Projector {
  const alpha = params.alpha ?? 0.5;
  const smoothing = params.smoothing ?? 0.1;
  const lo = params.lo ?? 0.5, hi = params.hi ?? 2.0;
  const minGames = params.minGames ?? 3;
  const threshold = params.threshold ?? 0.15;
  const positions = params.positions ?? new Set(["RB", "WR", "TE"]);
  const roleAgg = makeRoleAggregates(db, { window: params.window ?? 3 });

  return (m, season, week) => {
    if (alpha === 0 || !positions.has(m.pos)) return m.proj;
    const agg = roleAgg(m.playerSk, m.pos, season, week);
    if (!agg || agg.games < minGames || agg.rolePrior == null) return m.proj;   // no baseline to detect against
    if (Math.abs(agg.roleRecent - agg.rolePrior) < threshold) return m.proj;    // no change-point -> frozen
    const ratio = (agg.roleRecent + smoothing) / (agg.rolePrior + smoothing);
    const mult = Math.min(hi, Math.max(lo, Math.pow(ratio, alpha)));
    return m.proj * mult;
  };
}
