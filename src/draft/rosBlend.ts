/**
 * REST-OF-SEASON LINE: the preseason per-game projection, updated on the games a player has played.
 *
 * The season simulator used to price every player at his PRESEASON season total over 17, all season
 * long -- a running back who had played four games at twice his line was still simulated at his
 * line, and one who had not touched the field was still simulated at his full August number. The
 * weekly track at the other extreme trusts one hot game almost entirely (measured 2026-09-14: +3.7
 * points of over-projection on hot week-1 starters). The right amount is in between, and it is a
 * number that can be fitted rather than argued: how many games of the preseason line is a played
 * game worth?
 *
 *     ros_pg = (K * line + k * ppg) / (K + k)
 *
 * with `line` the preseason per-game projection, `ppg` the to-date per-game actual over `k` games
 * played, and K the weight of the prior IN GAMES. K = infinity is the old behaviour (line only);
 * K = 0 is "trust the games and nothing else". `scripts/fit-ros-blend.mjs` chooses K on 2012-2025
 * by season-grouped selection against realised rest-of-season per-game points and writes it to
 * data/ros-blend.json with the whole RMSE-by-K curve beside it, so the chosen value can be read
 * against its neighbours rather than trusted. This module reads that file; it does not decide K.
 *
 * Pure, so a test can hand it numbers. A missing or unreadable file yields K = infinity -- the old
 * behaviour -- and says so, because a silently invented K would be a projection change nobody asked
 * for.
 */
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../data/paths.js";

export const ROS_BLEND_FILE = "ros-blend.json";

export interface RosBlend {
  /** Prior weight in games. Infinity = line only. */
  K: number;
  fittedOn?: string;
  fittedAt?: string;
  /** RMSE of rest-of-season per-game points by K, from the fit, for the record. */
  rmseByK?: Record<string, number>;
  notes?: string;
}

/** The blended per-game mean. `line` is per game. A player with no games played, or no line, gets
 *  the line (or the actual, if only that exists); never a number invented from nothing. */
export function rosPerGame(line: number | null, tdGames: number | null, tdPts: number | null, K: number): number | null {
  const k = tdGames != null && Number.isFinite(tdGames) && tdGames > 0 ? tdGames : 0;
  const ppg = k > 0 && tdPts != null && Number.isFinite(tdPts) ? tdPts / k : null;
  if (line == null || !Number.isFinite(line)) return ppg;
  if (ppg == null || !Number.isFinite(K) || K === Infinity) return line;
  if (K <= 0) return ppg;
  return (K * line + k * ppg) / (K + k);
}

/**
 * THE BLEND FOR A FORMAT (WP8). K is fitted by minimising RMSE in POINTS on a format's own season
 * lines and weekly scores, so it is not a constant of football the way the age curve is: refitting
 * the Yahoo (full-PPR superflex) table moves it. `model.path` resolves to the `data/` root for the
 * incumbent, so the ESPN path is unchanged; a format with no fit of its own reports `absent` rather
 * than borrowing the root's number, which is the resolver's standing no-fallback rule.
 */
export function loadRosBlendFor(model: { path(name: "ros-blend"): string }): { blend: RosBlend; source: "fitted" | "absent" } {
  return loadRosBlend(model.path("ros-blend"));
}

/** Load the fitted blend. Absent -> K = infinity (the old behaviour), reported through `source`. */
export function loadRosBlend(path?: string): { blend: RosBlend; source: "fitted" | "absent" } {
  const p = path ?? dataPath(ROS_BLEND_FILE);
  if (!existsSync(p)) return { blend: { K: Infinity }, source: "absent" };
  const j = JSON.parse(readFileSync(p, "utf8")) as Partial<RosBlend>;
  const K = j.K == null ? Infinity : (typeof j.K === "string" && j.K === "Infinity" ? Infinity : Number(j.K));
  if (!(K >= 0)) throw new Error(`${p}: K must be a non-negative number or "Infinity", got ${JSON.stringify(j.K)}`);
  return { blend: { ...j, K }, source: "fitted" };
}
