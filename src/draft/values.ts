// Compute OUR independent auction $ values from a projected-points table, via VOR -> $ (the
// standard VBD auction formula; see docs/value-methods.md). Pure + unit-testable.

export interface PointsRow { name: string; pos: string; points: number; }
export interface ValueRow { name: string; pos: string; value: number; }

/** Canonical name key that survives ESPN-vs-our-CSV spelling drift (finding #5): lowercases, drops
 *  generational suffix tokens (Jr/Sr/II..V), drops a trailing d/st|dst token (so "Broncos D/ST"
 *  keys the same as "Broncos"), and strips everything but letters. Used to key our value table AND
 *  to look a player up, so both sides of the join normalize identically. */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/\bd\/?st\b/g, " ")
    .replace(/[^a-z]/g, "");
}

// Our value table stores defenses by ABBREVIATION ("HOU D/ST" -> nameKey "hou"), but ESPN's draft
// room displays the NICKNAME ("Texans D/ST" -> nameKey "texans"), so a live DST lookup misses and
// falls back to ESPN's on-screen value (F3). This maps every nickname/city spelling ESPN might show
// onto the abbreviation our table is keyed by. Built through nameKey so both sides normalize
// identically -- note "49ers" keys as "ers" once non-letters are stripped, which is exactly why the
// map is derived rather than hand-typed.
const DST_ALIASES: [string, string][] = [
  ["Cardinals", "ARI"], ["Arizona", "ARI"], ["Falcons", "ATL"], ["Atlanta", "ATL"],
  ["Ravens", "BAL"], ["Baltimore", "BAL"], ["Bills", "BUF"], ["Buffalo", "BUF"],
  ["Panthers", "CAR"], ["Carolina", "CAR"], ["Bears", "CHI"], ["Chicago", "CHI"],
  ["Bengals", "CIN"], ["Cincinnati", "CIN"], ["Browns", "CLE"], ["Cleveland", "CLE"],
  ["Cowboys", "DAL"], ["Dallas", "DAL"], ["Broncos", "DEN"], ["Denver", "DEN"],
  ["Lions", "DET"], ["Detroit", "DET"], ["Packers", "GB"], ["Green Bay", "GB"],
  ["Texans", "HOU"], ["Houston", "HOU"], ["Colts", "IND"], ["Indianapolis", "IND"],
  ["Jaguars", "JAC"], ["Jacksonville", "JAC"], ["Chiefs", "KC"], ["Kansas City", "KC"],
  ["Chargers", "LAC"], ["Rams", "LAR"], ["Raiders", "LV"], ["Las Vegas", "LV"],
  ["Dolphins", "MIA"], ["Miami", "MIA"], ["Vikings", "MIN"], ["Minnesota", "MIN"],
  ["Patriots", "NE"], ["New England", "NE"], ["Saints", "NO"], ["New Orleans", "NO"],
  ["Giants", "NYG"], ["Jets", "NYJ"], ["Eagles", "PHI"], ["Philadelphia", "PHI"],
  ["Steelers", "PIT"], ["Pittsburgh", "PIT"], ["Seahawks", "SEA"], ["Seattle", "SEA"],
  ["49ers", "SF"], ["San Francisco", "SF"], ["Niners", "SF"],
  ["Buccaneers", "TB"], ["Bucs", "TB"], ["Tampa Bay", "TB"],
  ["Titans", "TEN"], ["Tennessee", "TEN"], ["Commanders", "WAS"], ["Washington", "WAS"],
];

/** nameKey(ESPN's DST spelling) -> nameKey(our table's "<ABBR> D/ST" spelling). Abbreviations map to
 *  themselves so an already-correct name is a no-op. */
export const DST_KEY_ALIASES: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [alias, abbr] of DST_ALIASES) m[nameKey(alias)] = nameKey(abbr);
  for (const [, abbr] of DST_ALIASES) m[nameKey(abbr)] = nameKey(abbr);
  return m;
})();

/** Resolve any DST spelling to the key our value table uses; null if it is not a known defense. */
export function dstAliasKey(name: string): string | null {
  return DST_KEY_ALIASES[nameKey(name)] ?? null;
}

export interface ValueLeague {
  teams: number;
  budget: number;
  rosterSpots: number; // total roster size (for the $1 min-bid reserve)
  starters: Record<string, number>; // dedicated starters per team (QB/RB/WR/TE/K/DST), plus FLEX
}

// rosterSpots MUST equal SIM_LEAGUE.slots.length (12) -- the real league is 16 teams x 12 slots.
// Kept as a literal (not imported from sim.ts, which imports THIS file) and bound by a test.
// Fallback only -- the live values come from resolveValueLeague(config). Starters match the real
// league's ESPN settings (1 RB, 1 WR, 2 FLEX), so even the fallback is honest.
export const DEFAULT_VALUE_LEAGUE: ValueLeague = {
  teams: 16, budget: 200, rosterSpots: 12,
  starters: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 2, K: 1, DST: 1 },
};

const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

/** Derive the VBD ValueLeague from the app config (the single source of format truth). Starters are
 *  counted from the configured slots (bench/IR excluded; FLEX kept as its own bucket), so changing
 *  the league's roster in config actually moves replacement levels and therefore the $ values. */
export function resolveValueLeague(cfg: { teams: number; budget: number; slots: string[] }): ValueLeague {
  const starters: Record<string, number> = {};
  for (const s of cfg.slots) {
    if (/^(BE|BENCH|IR|ER)$/i.test(s)) continue;
    const key = s === "FLEX" || s === "OP" || s === "RB/WR" || s === "WR/TE" ? "FLEX" : s;
    starters[key] = (starters[key] ?? 0) + 1;
  }
  return { teams: cfg.teams, budget: cfg.budget, rosterSpots: cfg.slots.length, starters };
}

/** Replacement baseline points per position = the points of the first NON-startable player at
 *  that position across the whole league (dedicated starters + this position's share of FLEX).
 *
 *  The FLEX share is allocated POINTS-WEIGHTED by default (`flexWeighted`): the league's FLEX slots
 *  are filled with the best leftover FLEX-eligible players by projected points, and each position's
 *  share is however many of those it actually claims. The old even 3-way split
 *  (`round(flexTotal / 3)`) handed TE ~11 phantom starting slots in this league -- a weighted fill
 *  gives TE ZERO -- which took TE's baseline 11 ranks too deep and inflated every TE's VOR (and
 *  symmetrically starved WR). Measured at 13.6% -> 22.2% championships on the 2015-2024 backtest
 *  (docs/validation.md). `flexWeighted = false` keeps the old behavior for regression tests. */
export function baselines(points: PointsRow[], lg: ValueLeague, flexWeighted = true): Record<string, number> {
  const byPos: Record<string, number[]> = {};
  for (const p of points) (byPos[p.pos] ??= []).push(p.points);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b - a);
  const flexTotal = (lg.starters.FLEX ?? 0) * lg.teams;
  let flexCount: Record<string, number> | null = null;
  if (flexWeighted) {
    // Pool = every FLEX-eligible player beyond his position's DEDICATED starters, league-wide.
    const pool: { pos: string; pts: number }[] = [];
    for (const pos of FLEX_ELIGIBLE) {
      const dedicated = (lg.starters[pos] ?? 0) * lg.teams;
      const arr = byPos[pos] ?? [];
      for (let i = dedicated; i < arr.length; i++) pool.push({ pos, pts: arr[i] });
    }
    pool.sort((a, b) => b.pts - a.pts);
    flexCount = { RB: 0, WR: 0, TE: 0 };
    for (const p of pool.slice(0, flexTotal)) flexCount[p.pos]++;
  }
  const out: Record<string, number> = {};
  for (const pos of Object.keys(byPos)) {
    const dedicated = (lg.starters[pos] ?? 0) * lg.teams;
    const flexShare = FLEX_ELIGIBLE.includes(pos)
      ? (flexCount ? flexCount[pos] : Math.round(flexTotal / FLEX_ELIGIBLE.length))
      : 0;
    const startable = dedicated + flexShare;
    const arr = byPos[pos];
    out[pos] = arr[startable] ?? arr[arr.length - 1] ?? 0; // first non-starter's points
  }
  return out;
}

/** Points table -> auction $ values. value = max(1, 1 + VOR x rate), rate spreads the
 *  discretionary money (total budget minus $1 per roster spot) across total positive VOR.
 *  K/DST are clamped to `maxKDst` ($2) -- this league streams them at $1-2 (finding #1), so a
 *  nominal points curve must not be allowed to price them like real starters. */
export function computeValues(points: PointsRow[], lg: ValueLeague = DEFAULT_VALUE_LEAGUE, maxKDst = 2, flexWeighted = true): ValueRow[] {
  const base = baselines(points, lg, flexWeighted);
  const withVor = points.map((p) => ({ ...p, vor: Math.max(0, p.points - (base[p.pos] ?? 0)) }));
  const totalVor = withVor.reduce((s, p) => s + p.vor, 0) || 1;
  const discretionary = lg.teams * lg.budget - lg.teams * lg.rosterSpots * 1;
  const rate = discretionary / totalVor;
  return withVor
    .map((p) => {
      const raw = Math.max(1, Math.round(1 + p.vor * rate));
      const value = (p.pos === "K" || p.pos === "DST") ? Math.min(raw, maxKDst) : raw;
      return { name: p.name, pos: p.pos, value };
    })
    .sort((a, b) => b.value - a.value);
}
