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
  /**
   * PER-POSITION PRIOR WEIGHTS where a position was fitted on its own (2026-09-25). `K` was fitted on
   * QB/RB/WR/TE only and borrowed by K and DST; for DST it is WORSE than ignoring the season (held-out
   * RMSE 2.728 at K=6 vs 2.726 line-only) -- two weeks of a defence are mostly matchup noise. DST fits
   * K=20 in all 14 leave-one-season-out folds (2.627). Kickers fit ~6-8, so they keep `K`.
   * `scripts/fit-ros-blend.mjs --pos DST`. Absent = every position uses `K`, byte-identical to before.
   */
  byPos?: Record<string, number>;
  /**
   * PRIOR WEIGHTS BY PRESEASON LINE BAND (2026-09-25), ascending `maxLine`: the first band whose
   * `maxLine` exceeds the line applies. `K` was fitted on lines >= 3 only; a man nobody expected to play
   * whose games now show a role was held at 75% of a near-zero line (Kendre Miller: rate 3.5, weekly
   * model 10.5). Fitted per band (`fit-ros-blend.mjs --min-line a --max-line b`, leave-one-season-out):
   * lines < 1.5 K=1-2 (held-out RMSE 5.95 at K=6 -> 5.28), 1.5-3 K=2 in 14/14 folds (3.77 -> 3.56).
   * `byPos` wins over `byLine` (a defence keeps its own weight). Absent = `K`, byte-identical.
   * `FF_ROS_BLEND_BYLINE="1.5:1,3:2"` overrides it for a gate run ("off" disables).
   */
  byLine?: { maxLine: number; K: number }[];
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
 * THE USAGE CORRECTION to the D18 blend (D41, 2026-09-25) -- the rest-of-season rate finally sees a
 * ROLE CHANGE, for every player a waiver claim can reach.
 *
 * The blend `(K*line + k*rate)/(K+k)` is a pure POINTS blend with one K for everybody: a backup priced
 * at 0.6 pts/g whose snap share went 18% -> 51% when the starter got hurt was still ~1 pt/g. Fitted by
 * `scripts/ros-usage-screen.mjs --write` on EVERY player with a season line (the old ros-gap fit
 * excluded exactly that player: line < 3, outside the decision population), per position, from:
 * the line, weeks elapsed, last week's snap share and its interaction with the line, target share to
 * date, and the snap TREND (last week's share minus his earlier mean). Leave-season-out, 2013-2025:
 * against a no-snap recalibration of the blend (the broader-lever control) it adds +0.0754 RMSE
 * overall (13/13) and +0.1484 on RBs with a line < 3 and a real snap share (11/13).
 *
 * Returns the correction in points per game, or 0 without an artifact, a position fit, or a played
 * week (k = 0 has nothing to correct -- the screen never fits a checkpoint before week 1 is played).
 */
export interface RosUsage { features: string[]; coef: Record<string, number[]> }
let _usageCache: { usage: RosUsage | null } | null = null;
export function loadRosUsage(path?: string): RosUsage | null {
  if (_usageCache && !path) return _usageCache.usage;
  const p = path ?? dataPath("ros-usage.json");
  let usage: RosUsage | null = null;
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<RosUsage>;
    if (Array.isArray(j.features) && j.coef) usage = j as RosUsage;
  }
  if (!path) _usageCache = { usage };
  return usage;
}
export function rosUsageAdjust(
  r: { pos: string; line: number; k: number; snap: number | null; ts: number | null; trend: number | null },
  usage: RosUsage | null,
): number {
  if (!usage || !(r.k > 0)) return 0;
  const c = usage.coef[r.pos];
  if (!c) return 0;
  const x: Record<string, number> = {
    line: r.line, k: r.k,
    snap: r.snap ?? 0, snap_missing: r.snap == null ? 1 : 0, snap_x_line: (r.snap ?? 0) * r.line,
    ts: r.ts ?? 0, ts_missing: r.ts == null ? 1 : 0,
    trend: r.trend ?? 0, trend_missing: r.trend == null ? 1 : 0,
  };
  let out = c[0];
  for (let i = 0; i < usage.features.length; i++) out += c[i + 1] * (x[usage.features[i]] ?? 0);
  return Number.isFinite(out) ? out : 0;
}

/**
 * THE SNAP/TARGET DIVERGENCE CORRECTION to the D18 blend (screened 2026-09-23, NOT a default).
 *
 * The blend is a pure POINTS blend: it cannot tell a man who is on the field and not being thrown to
 * from one whose role is intact and whose two games were noise. `ts_gap` -- target share minus the
 * median target share at his SNAP-SHARE DECILE and position -- is orthogonal to snap share by
 * construction and supplies exactly that missing axis. Held-out RMSE 4.3557 -> 4.2276 (paired
 * +0.1281 against a 0.0555 floor, 13/14 seasons; shuffle control negative at 0/14).
 *
 * THE SIGN IS THE REVERSE OF THE HYPOTHESIS, and the artifact says so on its face: the `ts_gap`
 * coefficient is NEGATIVE. Being under-targeted for your snaps predicts BEATING the blend, because
 * target share mean-reverts. It is not a role-collapse detector; it was built as one and the data
 * said otherwise.
 *
 * OFF BY DEFAULT. `FF_SIM_ROS_GAP=1` enables it. Absent artifact, missing `td_ts` or missing
 * `prior_snap_share` all return 0 -- the blend is then exactly what it was, because a correction
 * invented from a median fill for a player we have no usage for is a guess wearing a measurement's
 * clothes. `prior_route_share` is deliberately not used: it has 0% coverage in 2026 and would be a
 * dark column in the season this would actually serve.
 */
export interface RosGap {
  feats: string[]; coef: number[]; fill: Record<string, number>;
  curve: Record<string, { edges: number[]; median: number[] }>;
}
let _gapCache: { loaded: boolean; gap: RosGap | null } | null = null;
export function loadRosGap(path?: string): RosGap | null {
  if (_gapCache) return _gapCache.gap;
  const p = path ?? dataPath("ros-gap.json");
  let gap: RosGap | null = null;
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<RosGap>;
    if (j.feats && j.coef && j.curve && j.fill) gap = j as RosGap;
  }
  _gapCache = { loaded: true, gap };
  return gap;
}

/** The correction in points per week, or 0 when it cannot be computed from real usage. */
export function rosGapAdjust(
  r: { pos: string; line: number; k: number; td_ts: number | null; prior_snap_share: number | null },
  gap: RosGap | null,
): number {
  if (!gap || r.td_ts == null || r.prior_snap_share == null) return 0;
  const c = gap.curve[r.pos];
  if (!c) return 0;
  let b = 0;
  while (b < c.edges.length && r.prior_snap_share >= c.edges[b]) b++;
  const row: Record<string, number> = {
    line: r.line, k: r.k, ts_gap: r.td_ts - c.median[b], prior_snap_share: r.prior_snap_share,
  };
  let out = gap.coef[0];
  for (let i = 0; i < gap.feats.length; i++) out += gap.coef[i + 1] * (row[gap.feats[i]] ?? gap.fill[gap.feats[i]]);
  return Number.isFinite(out) ? out : 0;
}

/**
 * ONE PER-WEEK STRENGTH FOR A ROSTERED MAN (D33, 2026-09-17) -- and it is one function because it
 * was two numbers.
 *
 * `loadSimContext` computes the D18 blend once, per format, with that format's own fitted K, and
 * attaches it to each roster player as `rosPerGame`. The SEASON SIMULATOR read it
 * (`season.ts`: `p.rosPerGame ?? p.proj / 17`); the LINEUP verb did not -- `lineupRecommend` and
 * `toWp` in src/inseason/copilot.ts both wrote `p.proj / perWeek`, the PRESEASON line spread flat.
 * So on the same context, in week 10, the two surfaces held two different per-week strengths for the
 * same man: the simulator priced him on the games he had actually played and the lineup priced him
 * on his August number. Measured exposure (docs/lineup-stress-2026-09-17.md finding 2-d): the
 * fallback fires on 2.9% of rostered men in the 2018-2025 replay and 1 of 12 on the live roster.
 *
 * This is the function both call now. `perWeek` is the frame the SEASON PROJECTION is spread over
 * (17 scheduled NFL games -- see NFL_WEEKS in src/inseason/copilot.ts) and is only ever used for the
 * preseason half; `rosPerGame` is already a per-game number in that same frame, computed by
 * `rosPerGame()` above from `proj / 17`.
 *
 * A man with no played games, or a context built before D18, has no `rosPerGame` and gets exactly
 * what he got before. Nothing is invented here: the blend is fitted upstream or it is absent.
 */
export function perGameStrength(p: { proj: number; rosPerGame?: number }, perWeek: number): number {
  return p.rosPerGame != null && Number.isFinite(p.rosPerGame) ? p.rosPerGame : p.proj / perWeek;
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
  for (const [pos, v] of Object.entries(j.byPos ?? {})) {
    if (!(Number(v) >= 0)) throw new Error(`${p}: byPos.${pos} must be a non-negative number, got ${JSON.stringify(v)}`);
  }
  return { blend: { ...j, K }, source: "fitted" };
}

/** The line bands in force: the env override for a gate run, else the blend's own. */
function lineBands(blend: RosBlend): { maxLine: number; K: number }[] | null {
  const env = process.env.FF_ROS_BLEND_BYLINE;
  if (env === "off") return null;
  if (env) {
    return env.split(",").map((s) => {
      const [m, k] = s.split(":").map(Number);
      if (!(m > 0) || !(k >= 0)) throw new Error(`FF_ROS_BLEND_BYLINE "${env}" is not "maxLine:K,..."`);
      return { maxLine: m, K: k };
    }).sort((a, b) => a.maxLine - b.maxLine);
  }
  return blend.byLine?.length ? [...blend.byLine].sort((a, b) => a.maxLine - b.maxLine) : null;
}

/** The prior weight for one player: his position's own fit when it has one (DST), else his preseason
 *  line's band when the blend carries bands, else the pooled `K`. `line` is per scheduled week. */
export const rosKFor = (blend: RosBlend, pos: string, line?: number | null): number => {
  const v = blend.byPos?.[pos];
  if (v != null && Number.isFinite(Number(v))) return Number(v);
  const bands = line != null && Number.isFinite(line) ? lineBands(blend) : null;
  const band = bands?.find((b) => line! < b.maxLine);
  return band ? band.K : blend.K;
};
