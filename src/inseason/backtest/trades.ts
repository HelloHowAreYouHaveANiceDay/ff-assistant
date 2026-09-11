/**
 * TRADE BACKTEST -- the biggest gap the QA audit found: `trade_check`/`trade_finder` run a full paired
 * sim and ship live, but NOTHING measured whether their recommendations are good. The decision harness
 * is single-roster (a RosterPolicy transforms one team against one future), so a two-sided deal cannot
 * be A/B'd there. This is that missing piece.
 *
 * It replays every (season, week, us-team) point-in-time state, proposes the best roughly-FAIR one-for-
 * one (|proj gap| <= `gap`, the trade_finder fairness proxy) with any opponent that improves OUR
 * projected optimal lineup -- optionally requiring it to also not hurt THEM (mutual, the acceptable
 * subset trade_finder ships) -- applies it to both rosters, and scores each side's REALIZED rest-of-
 * season (a trade is a PERMANENT change, so frozen-forward is the right scorer, same as a drop). The
 * question: do projection-improving trades improve realized value, and by how much? A positive control
 * (give our best for their worst) must be strongly negative.
 */
import { optimalLineup } from "../lineup.js";
import { loadWeekContext, loadModel, type ModelName } from "./context.js";
import { realizedRestOfSeason, type DecisionMember, type Scorer, type ScoreCtx, type SeasonFuture } from "./harness.js";
import { getConfig, type DB } from "../../db/db.js";

const startersNeeded = (t: string[]) => t.filter((s) => s !== "BE" && s !== "BENCH").length;
const rp = (m: DecisionMember) => ({ name: m.name, pos: m.pos, proj: m.proj, available: true });

/** Can these players still field the whole starting template (filled slots, not slot count -- the
 *  same trap the drop policies hit)? */
function canField(members: DecisionMember[], template: string[], flexOk: Set<string>): boolean {
  const res = optimalLineup(members.map(rp), template, flexOk);
  return res.starters.filter((s) => s.name && s.name !== "(empty)").length >= startersNeeded(template);
}

export interface TradeResult {
  seasons: number[]; model: ModelName; scorer: string; mutual: boolean;
  evaluated: number; traded: number;
  meanOurDiff: number; meanOurDiffWhereTraded: number; meanTheirDiff: number;
  perSeason: { season: number; traded: number; meanOurDiff: number }[];
  bootstrap: { lo: number; hi: number; pBetter: number };
  control: { meanDiff: number };
  randomControl: { meanDiff: number; n: number };
}

export function backtestTrades(db: DB, opts: {
  leagueId: string; seasons: number[]; model?: ModelName; scorer?: Scorer; gap?: number; mutual?: boolean;
}): TradeResult {
  const model = opts.model ?? "served";
  const wm = loadModel(model);
  const scorer: Scorer = opts.scorer ?? { name: "realized-rest-of-season", score: realizedRestOfSeason };
  const gap = opts.gap ?? 3;            // |proj_X - proj_Y| <= gap  => a roughly-fair one-for-one
  const mutual = opts.mutual ?? true;   // require the deal to not hurt the counterparty (acceptable)
  const cfg = getConfig(db);
  const flexOk = new Set<string>(cfg.flex_ok as string[]);

  const perSeasonDiffs = new Map<number, number[]>();
  for (const s of opts.seasons) perSeasonDiffs.set(s, []);
  const controlDiffs: number[] = [];
  const randomDiffs: number[] = [];   // NEUTRAL control: a RANDOM fair legal trade, not selected for our gain
  const theirDiffs: number[] = [];
  let evaluated = 0, traded = 0;
  let rrng = 12345; const rand01 = () => (rrng = (rrng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (const season of opts.seasons) {
    const future: SeasonFuture = new Map();
    for (const r of db.prepare(
      `SELECT player_sk, week, pts, is_bye, inj_out FROM feat_player_week_model WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { player_sk: string; week: number; pts: number | null; is_bye: number | null; inj_out: number | null }[]) {
      let m = future.get(r.player_sk); if (!m) { m = new Map(); future.set(r.player_sk, m); }
      m.set(r.week, { pts: r.pts ?? 0, bye: !!r.is_bye, out: !!r.inj_out });
    }
    const regWeeks = (db.prepare(`SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?`).get(season) as { rw: number | null }).rw
      ?? (db.prepare(`SELECT MAX(week) w FROM feat_player_week_model WHERE season=? AND pts IS NOT NULL`).get(season) as { w: number | null }).w ?? 14;

    for (let W = 1; W <= regWeeks - 1; W++) {
      const wc = loadWeekContext(db, opts.leagueId, season, W, wm);
      const ctx: ScoreCtx = { season, fromWeek: W, toWeek: regWeeks, template: wc.template, flexOk, future };
      // every team's point-in-time roster as DecisionMembers
      const teams = new Map<string, DecisionMember[]>();
      for (const [teamId, entries] of wc.rosters) {
        const roster: DecisionMember[] = [];
        for (const e of entries) {
          const p = wc.players.get(e.playerSk); if (!p) continue;
          roster.push({ playerSk: e.playerSk, name: p.name, pos: p.pos, proj: p.proj ?? p.fallback ?? 0 });
        }
        teams.set(teamId, roster);
      }
      const teamIds = [...teams.keys()];
      for (const usId of teamIds) {
        const us = teams.get(usId)!;
        if (us.length < startersNeeded(wc.template) + 1) continue;
        evaluated++;
        const ourBase = optimalLineup(us.map(rp), wc.template, flexOk).totalProj;

        // best fair, improving (and optionally mutual) one-for-one across all opponents
        let best: { give: DecisionMember; get: DecisionMember; them: DecisionMember[]; themId: string; ourGain: number; theirGain: number } | null = null;
        for (const themId of teamIds) {
          if (themId === usId) continue;
          const them = teams.get(themId)!;
          const theirBase = optimalLineup(them.map(rp), wc.template, flexOk).totalProj;
          for (const X of us) for (const Y of them) {
            if (Math.abs(X.proj - Y.proj) > gap) continue;                 // roughly fair
            const usPost = [...us.filter((m) => m.playerSk !== X.playerSk), Y];
            const themPost = [...them.filter((m) => m.playerSk !== Y.playerSk), X];
            if (!canField(usPost, wc.template, flexOk) || !canField(themPost, wc.template, flexOk)) continue;
            const ourGain = optimalLineup(usPost.map(rp), wc.template, flexOk).totalProj - ourBase;
            if (ourGain <= 0) continue;                                     // must improve our lineup
            const theirGain = optimalLineup(themPost.map(rp), wc.template, flexOk).totalProj - theirBase;
            if (mutual && theirGain < 0) continue;                          // acceptable = doesn't hurt them
            if (!best || ourGain > best.ourGain) best = { give: X, get: Y, them, themId, ourGain, theirGain };
          }
        }

        if (best) {
          traded++;
          const usPost = [...us.filter((m) => m.playerSk !== best!.give.playerSk), best.get];
          const themPost = [...best.them.filter((m) => m.playerSk !== best!.get.playerSk), best.give];
          const usBaseScore = scorer.score(us, ctx);
          perSeasonDiffs.get(season)!.push(scorer.score(usPost, ctx) - usBaseScore);
          theirDiffs.push(scorer.score(themPost, ctx) - scorer.score(best.them, ctx));
        } else {
          perSeasonDiffs.get(season)!.push(0);
        }

        // NEUTRAL CONTROL: a RANDOM fair, legal one-for-one (not chosen for our gain). If this is ~0 while
        // the selected trade is positive, the edge is our SELECTION, not a frozen-forward/hindsight artifact.
        {
          const cands: { give: DecisionMember; get: DecisionMember }[] = [];
          for (const themId of teamIds) {
            if (themId === usId) continue;
            for (const X of us) for (const Y of teams.get(themId)!) {
              if (Math.abs(X.proj - Y.proj) > gap) continue;
              const usP = [...us.filter((m) => m.playerSk !== X.playerSk), Y];
              if (canField(usP, wc.template, flexOk)) cands.push({ give: X, get: Y });
            }
          }
          if (cands.length) {
            const c = cands[Math.floor(rand01() * cands.length)];
            const usP = [...us.filter((m) => m.playerSk !== c.give.playerSk), c.get];
            randomDiffs.push(scorer.score(usP, ctx) - scorer.score(us, ctx));
          }
        }

        // POSITIVE CONTROL: give our highest-proj startable for the opponent's lowest -- a fleecing in
        // reverse; realized value must drop hard.
        const oppAll = teamIds.filter((t) => t !== usId).flatMap((t) => teams.get(t)!);
        if (oppAll.length) {
          const ourBest = [...us].sort((a, b) => b.proj - a.proj)[0];
          const theirWorst = [...oppAll].sort((a, b) => a.proj - b.proj)[0];
          const usPostBad = [...us.filter((m) => m.playerSk !== ourBest.playerSk), theirWorst];
          if (canField(usPostBad, wc.template, flexOk)) controlDiffs.push(scorer.score(usPostBad, ctx) - scorer.score(us, ctx));
        }
      }
    }
  }

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const seasonMeans = opts.seasons.map((s) => mean(perSeasonDiffs.get(s) ?? []));
  const boot: number[] = []; let rng = 987654321;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) { let acc = 0; for (let k = 0; k < seasonMeans.length; k++) acc += seasonMeans[Math.floor(rand() * seasonMeans.length)]; boot.push(acc / Math.max(1, seasonMeans.length)); }
  boot.sort((a, b) => a - b);
  const allDiffs = opts.seasons.flatMap((s) => perSeasonDiffs.get(s) ?? []);
  const nz = allDiffs.filter((x) => x !== 0);

  return {
    seasons: opts.seasons, model, scorer: scorer.name, mutual, evaluated, traded,
    meanOurDiff: mean(allDiffs), meanOurDiffWhereTraded: mean(nz), meanTheirDiff: mean(theirDiffs),
    perSeason: opts.seasons.map((s) => { const d = (perSeasonDiffs.get(s) ?? []).filter((x) => x !== 0); return { season: s, traded: d.length, meanOurDiff: mean(d) }; }),
    bootstrap: { lo: boot[Math.floor(0.05 * boot.length)], hi: boot[Math.floor(0.95 * boot.length)], pBetter: boot.filter((x) => x > 0).length / boot.length },
    control: { meanDiff: mean(controlDiffs) },
    randomControl: { meanDiff: mean(randomDiffs), n: randomDiffs.length },
  };
}
