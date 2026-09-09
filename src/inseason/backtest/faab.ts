/**
 * BACKTEST 4: WHAT OUR BID WOULD HAVE BEEN, AND WHETHER IT WOULD HAVE WON.
 *
 * Track B measured our waiver RANKING against the room's, and said plainly what it could not
 * measure: "The room's dollars are known; ours are not, because `faabFor` prices a
 * playoff-probability delta that cannot be computed for a past season." The fitted bid model does
 * not need that delta -- it prices a claim from the player, the week and the two budget shares --
 * so the missing half of that backtest is now available, and this is it.
 *
 * THE QUESTION. For every add our own ranking recommended in Track B's replay, what would
 * `bidForWinProb(0.70)` have asked for, and would that number have beaten what the room actually
 * paid for that man that week?
 *
 * THE ADJUDICATION IS THE LOG, NOT THE MODEL. A recommended bid wins if either
 *   - NOBODY claimed that player through waivers that week -- there was no auction to lose, or
 *   - our bid strictly EXCEEDS the winning bid that was actually recorded.
 * A TIE COUNTS AS A LOSS and is reported separately: ESPN breaks a tie on waiver priority, which
 * this replay has no way to reconstruct, and scoring an unknown as a win would inflate exactly the
 * number the whole exercise is about.
 *
 * THE HONEST LIMITS, all three of them, because none is a detail:
 *   1. THE FIELD DOES NOT RESPOND. The room's bids are held at what they actually were. A world in
 *      which we bid $30 for a man is a world in which somebody may have bid $31, and this replay
 *      cannot see it. So this is an upper bound on our win rate, not a simulation of an auction.
 *   2. OUR BUDGET IS OUR REAL ONE. `team_faab_share` is what we actually had left going into that
 *      week, not what we would have had after a season of counterfactual bidding. Compounding a
 *      counterfactual budget across sixteen weeks would make every late-season number a function of
 *      week 2's arithmetic.
 *   3. THE MODEL SAW THESE SEASONS. It is fitted on 2018-2025 and replayed on 2018-2025. That is
 *      why the headline is the WIN RATE -- adjudicated against the log, which the fit never saw a
 *      win/loss label for on an uncontested add -- and not the price error, which is measured
 *      leave-one-season-out in `tools/train_faab.py` where it belongs.
 */
import type { DB } from "../../db/db.js";
import { backtestWaivers } from "./waiver.js";
import type { ModelName } from "./context.js";
import {
  loadFaabModel, featureRow, bidForWinProb, clearingPrice, pWin, type FaabModel, type FaabRow,
} from "../faab.js";
import { faabFor } from "../copilot.js";

export interface FaabReplayRow {
  season: number; week: number; playerSk: string; name: string; pos: string;
  /** What the model asked for at the target, before any cap. */
  wanted: number | null;
  /** What we would actually have bid: the ask, capped at what we had left that week. */
  bid: number;
  remaining: number;
  clearing: number;
  /** The model's OWN P(win) at the bid we would actually have made. Compared against the realised
   *  win rate below: a target is only meaningful where the constraint binds, and the calibration
   *  check is what P63 should have asked for. */
  pWinAtBid: number;
  /** The winning bid actually recorded on this man this week, or null when nobody claimed him. */
  roomWon: number | null;
  contested: boolean;
  won: boolean;
  tie: boolean;
  /** The rule of thumb's dollars for the same claim, under the oracle constant fitted in step 2. */
  ruleBid: number;
  rosPts: number | null;
}

export interface FaabReplaySummary {
  target: number;
  rows: number;
  contested: number;
  wins: number;
  ties: number;
  winRatePct: number;
  /** Win rate on the CONTESTED subset alone -- the only rows where money did anything. */
  contestedWinRatePct: number | null;
  dollarsModel: number;
  dollarsRule: number;
  dollarsSaved: number;
  overRemaining: number;
  /** The bid distribution, because a mean hides a bimodal one -- and this one IS bimodal: where
   *  P(win) at a dollar already clears the target the ask is $1, and where it does not the ask can
   *  exceed the whole budget. Nothing in between. */
  bidAtFloorPct: number;
  medianBid: number;
  /** Calibration: the model's mean predicted P(win) at the bids it recommended, against what
   *  actually happened. This is the question a target win probability can honestly be scored on. */
  meanPredictedWinPct: number;
  seasons: { season: number; rows: number; wins: number; contested: number; model: number; rule: number }[];
}

/**
 * DID THIS BID WIN? The one rule the whole replay turns on, as a function so it can be tested and
 * fault-injected rather than living inline where nothing can reach it.
 *
 * A TIE IS A LOSS. ESPN breaks it on waiver priority, which this replay cannot reconstruct, and
 * scoring an unknown as a win would inflate the exact number being measured. There are ten of them.
 */
export function adjudicate(bid: number, roomWon: number | null): { won: boolean; tie: boolean; contested: boolean } {
  if (roomWon == null) return { won: true, tie: false, contested: false };
  return { won: bid > roomWon, tie: bid === roomWon, contested: true };
}

/** Our team id in a season, resolved by OWNER from the team we are today -- ESPN's numeric ids are
 *  stable in this league but that is a property to check, not to assume, and the owner is the thing
 *  that actually persists. */
export function ourTeamId(db: DB, season: number): string | null {
  const lg = db.prepare("SELECT team_id, season FROM league ORDER BY last_synced_at DESC LIMIT 1")
    .get() as { team_id: string; season: number } | undefined;
  if (!lg) return null;
  const me = db.prepare("SELECT owner FROM fact_team_season WHERE season=? AND team_id=?")
    .get(lg.season, String(lg.team_id)) as { owner: string | null } | undefined;
  if (!me?.owner) return String(lg.team_id);
  const row = db.prepare("SELECT team_id FROM fact_team_season WHERE season=? AND owner=?")
    .get(season, me.owner) as { team_id: string } | undefined;
  return row?.team_id ?? null;
}

/** Points above replacement, and the oracle constant, exactly as tools/train_faab.py fitted them --
 *  so "dollars saved" compares against the SAME rule-of-thumb baseline step 2 reported, not a
 *  second construction of it that happens to share a name. */
function ruleBaseline(db: DB, m: FaabModel): (season: number, pos: string, line: number | null, budget: number) => number {
  const rows = db.prepare(
    "SELECT season, pos, season_line_pg FROM fact_waiver_claim WHERE won=1 AND season_line_pg IS NOT NULL")
    .all() as { season: number; pos: string; season_line_pg: number }[];
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.season}|${r.pos}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r.season_line_pg);
  }
  const med = new Map<string, number>();
  for (const [k, v] of by) { v.sort((a, b) => a - b); med.set(k, v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2); }
  const k = (m.loso.ruleDeltaPerPointAbovReplacement as number) ?? 0;
  return (season, pos, line, budget) => {
    const base = med.get(`${season}|${pos}`);
    if (line == null || base == null) return 0;
    return faabFor(k * Math.max(0, line - base), budget);
  };
}

export function backtestFaab(
  db: DB, leagueId: string,
  opts: { seasons: number[]; model?: ModelName; target?: number; artifact?: FaabModel | null },
): { rows: FaabReplayRow[]; summary: FaabReplaySummary } {
  const m = opts.artifact !== undefined ? opts.artifact : loadFaabModel();
  if (!m) throw new Error("no FAAB artifact -- run tools/train_faab.py first");
  const target = opts.target ?? 0.7;
  const rule = ruleBaseline(db, m);

  const feat = db.prepare(
    "SELECT season_line_pg, td_ppg FROM feat_player_week_model WHERE season=? AND week=? AND player_sk=?");
  const priorPts = db.prepare(
    "SELECT pts FROM feat_player_week_model WHERE season=? AND week=? AND player_sk=? AND pts IS NOT NULL");
  const winnerOf = db.prepare(
    "SELECT MAX(bid_amount) b FROM fact_waiver_claim WHERE season=? AND week=? AND player_sk=? AND won=1");
  const rankCache = new Map<string, Map<string, number>>();
  const needCache = new Map<string, { need: number; teams: number }>();

  const ranksFor = (season: number, week: number, pos: string): Map<string, number> => {
    const k = `${season}|${week}|${pos}`;
    const hit = rankCache.get(k);
    if (hit) return hit;
    const rows = db.prepare(
      "SELECT player_sk, season_line_pg FROM feat_player_week_model WHERE season=? AND week=? AND pos=? AND season_line_pg IS NOT NULL")
      .all(season, week, pos) as { player_sk: string; season_line_pg: number }[];
    rows.sort((a, b) => b.season_line_pg - a.season_line_pg);
    const out = new Map<string, number>();
    rows.forEach((r, i) => out.set(r.player_sk, i + 1));
    rankCache.set(k, out);
    return out;
  };
  const needFor = (season: number, week: number, pos: string): { need: number; teams: number } => {
    const w = Math.max(1, week - 1);
    const k = `${season}|${w}|${pos}`;
    const hit = needCache.get(k);
    if (hit) return hit;
    const c = db.prepare(
      "SELECT team_id, SUM(CASE WHEN pos = ? THEN 1 ELSE 0 END) n FROM fact_roster_week WHERE season=? AND week=? GROUP BY team_id")
      .all(pos, season, w) as { team_id: string; n: number }[];
    const a = c.map((x) => x.n).sort((x, y) => x - y);
    const md = a.length ? (a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2) : 0;
    const v = { need: c.filter((x) => x.n < md).length, teams: c.length };
    needCache.set(k, v);
    return v;
  };

  const rows: FaabReplayRow[] = [];
  for (const season of opts.seasons) {
    const { weeks } = backtestWaivers(db, leagueId, { seasons: [season], model: opts.model ?? "challenger" });
    if (!weeks.length) continue;
    const meId = ourTeamId(db, season);
    const budgetRow = db.prepare("SELECT MAX(budget) b, MAX(teams_counted) t FROM fact_waiver_claim WHERE season=?")
      .get(season) as { b: number | null; t: number | null };
    const budget = budgetRow?.b ?? 100;
    const teams = budgetRow?.t ?? 12;

    // OUR remaining budget going into each week, and the room's -- point-in-time, from the claims
    // executed in strictly earlier weeks.
    const spent = db.prepare(
      "SELECT week, SUM(bid_amount) tot, SUM(CASE WHEN team_id=? THEN bid_amount END) mine FROM fact_waiver_claim WHERE season=? AND won=1 GROUP BY week")
      .all(meId ?? "", season) as { week: number; tot: number | null; mine: number | null }[];
    const before = (w: number): { mine: number; league: number } => {
      let mine = 0, tot = 0;
      for (const s of spent) if (s.week < w) { mine += s.mine ?? 0; tot += s.tot ?? 0; }
      return { mine: Math.max(0, budget - mine), league: Math.max(0, teams * budget - tot) };
    };

    for (const wk of weeks) {
      const bud = before(wk.week);
      for (const a of wk.ourAdds) {
        const f = feat.get(season, wk.week, a.playerSk) as { season_line_pg: number | null; td_ppg: number | null } | undefined;
        const pp = wk.week > 1
          ? (priorPts.get(season, wk.week - 1, a.playerSk) as { pts: number } | undefined)?.pts ?? null
          : null;
        const need = needFor(season, wk.week, a.pos);
        const row: FaabRow = {
          budget,
          f: featureRow(m, {
            pos: a.pos, week: wk.week,
            posLineRank: ranksFor(season, wk.week, a.pos).get(a.playerSk) ?? null,
            seasonLinePg: f?.season_line_pg ?? null, tdPpg: f?.td_ppg ?? null, priorPts: pp,
            teamFaabShare: bud.mine / budget, leagueFaabShare: bud.league / (teams * budget),
            teamsNeedPos: need.teams ? need.need : null, teamsCounted: need.teams || null,
          }),
        };
        const wanted = bidForWinProb(m, row, target);
        const bid = Math.min(wanted ?? Math.max(1, Math.round(clearingPrice(m, row))), bud.mine);
        const w = winnerOf.get(season, wk.week, a.playerSk) as { b: number | null };
        const roomWon = w?.b ?? null;
        rows.push({
          season, week: wk.week, playerSk: a.playerSk, name: a.name, pos: a.pos,
          wanted, bid, remaining: bud.mine, clearing: Math.round(clearingPrice(m, row) * 100) / 100,
          pWinAtBid: pWin(m, row, bid),
          roomWon, ...adjudicate(bid, roomWon),
          ruleBid: rule(season, a.pos, f?.season_line_pg ?? null, budget),
          rosPts: a.rosPts,
        });
      }
    }
  }

  const contested = rows.filter((r) => r.contested);
  const cw = contested.filter((r) => r.won).length;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    rows,
    summary: {
      target,
      rows: rows.length,
      contested: contested.length,
      wins: rows.filter((r) => r.won).length,
      ties: rows.filter((r) => r.tie).length,
      winRatePct: rows.length ? r1((100 * rows.filter((r) => r.won).length) / rows.length) : 0,
      contestedWinRatePct: contested.length ? r1((100 * cw) / contested.length) : null,
      dollarsModel: rows.reduce((s, r) => s + r.bid, 0),
      dollarsRule: rows.reduce((s, r) => s + r.ruleBid, 0),
      dollarsSaved: rows.reduce((s, r) => s + r.ruleBid - r.bid, 0),
      overRemaining: rows.filter((r) => r.wanted != null && r.wanted > r.remaining).length,
      bidAtFloorPct: rows.length ? r1((100 * rows.filter((r) => r.bid <= 1).length) / rows.length) : 0,
      medianBid: (() => {
        const a = rows.map((r) => r.bid).sort((x, y) => x - y);
        return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2) : 0;
      })(),
      meanPredictedWinPct: rows.length ? r1((100 * rows.reduce((s, r) => s + r.pWinAtBid, 0)) / rows.length) : 0,
      seasons: [...new Set(rows.map((r) => r.season))].sort().map((s) => {
        const g = rows.filter((r) => r.season === s);
        return {
          season: s, rows: g.length, wins: g.filter((r) => r.won).length,
          contested: g.filter((r) => r.contested).length,
          model: g.reduce((x, r) => x + r.bid, 0), rule: g.reduce((x, r) => x + r.ruleBid, 0),
        };
      }),
    },
  };
}
