/**
 * DOES A DEPTH-AWARE DROP BEAT A VALUE-MINIMIZING DROP? -- measured, not argued.
 *
 * The one-week streaming helper picks its drop as "the lowest-projected body that still fields a
 * legal lineup this week" (copilot.ts streamRecommend). That is blind to positional insurance: it
 * will cut the last backup at a scarce position (the only TE behind your starter) before a redundant
 * sixth receiver, because the receiver projects higher. The claim under test is that a DEPTH-AWARE
 * drop -- one that keeps a backup at scarce positions and cuts a redundant body instead -- leaves you
 * with more REALIZED points once real injuries land.
 *
 * THE EXPERIMENT, isolated so only the drop differs:
 *   For each (season, team, decision-week W), both policies would ADD the same free agent, so the add
 *   cancels. What differs is WHO they drop. We measure the REALIZED rest-of-season lineup value of the
 *   dropped player -- how many points he would have contributed to the team's optimal weekly lineup
 *   over weeks W..end, on the ACTUAL results and ACTUAL availability that followed. Dropping the
 *   player with the SMALLER realized value is the better policy.
 *
 *     diff = mv(value-min drop) - mv(depth-aware drop)     (positive => depth-aware kept the more
 *                                                            valuable man, i.e. depth-aware is better)
 *
 * POINT-IN-TIME, like every backtest here. The DROP CHOICE reads only week-W projections and roster
 * counts. The SCORING reads actual points and actual availability from week W onward -- the outcome,
 * never an input to the choice. The roster is frozen at W for the forward score (both policies freeze
 * it identically, so the comparison is fair); a team's later real transactions are not modeled,
 * which is a symmetric simplification, not a bias toward either policy.
 *
 * THE UNIT IS THE SEASON. Decisions within a season share its injuries and are not independent, so the
 * aggregate is reported with a season-level bootstrap CI, the same discipline as the weekly gate.
 */
import { optimalLineup, type RosterPlayer } from "../lineup.js";
import { loadWeekContext, loadModel, type ModelName } from "./context.js";
import { getConfig, type DB } from "../../db/db.js";

/** Positions where you start exactly one and a backup is genuine injury/bye insurance. A depth-aware
 *  policy refuses to cut the LAST backup here; RB/WR are deep by construction and freely droppable. */
const SCARCE = new Set(["QB", "TE", "K", "DST"]);

interface RosterMember { playerSk: string; name: string; pos: string; proj: number }

interface SeasonRow { pts: number; bye: boolean; out: boolean; pos: string }

export interface DropPolicyResult {
  seasons: number[];
  model: ModelName;
  decisions: number;         // (team, week) states evaluated
  differing: number;         // where the two policies chose a different drop
  agree: number;             // where they agreed (diff is exactly 0)
  meanDiff: number;          // mean realized points saved per DIFFERING decision by depth-aware
  meanDiffAll: number;       // spread over ALL decisions (agreements count as 0)
  perSeason: { season: number; differing: number; meanDiff: number }[];
  bootstrap: { lo: number; hi: number; pDepthBetter: number }; // season-level 90% CI on meanDiffAll
  // POSITIVE CONTROL: a policy that drops the HIGHEST-projected starter must score far WORSE than
  // value-min, or the harness is not measuring realized lineup value at all.
  controlDropStarterMeanDiff: number; // mv(value-min) - mv(drop-best); must be large NEGATIVE
}

/** A legal drop keeps enough bodies to fill the starting template at every position (roster-
 *  construction legality, independent of this week's byes/injuries). */
function canFillTemplate(members: RosterMember[], template: string[], flexOk: Set<string>): boolean {
  const players: RosterPlayer[] = members.map((m) => ({ name: m.name, pos: m.pos, proj: 1, available: true }));
  const res = optimalLineup(players, template, flexOk);
  const need = template.filter((s) => s !== "BE" && s !== "BENCH").length;
  return res.starters.length >= need;
}

/** Backups at a position = rostered there minus the dedicated starting slots for it. */
function backupsAt(members: RosterMember[], pos: string, template: string[]): number {
  const rostered = members.filter((m) => m.pos === pos).length;
  const dedicated = template.filter((s) => s === pos).length;
  return rostered - dedicated;
}

/** value-min: lowest week-W projection among legal drops. depth-aware: lowest projection among legal
 *  drops that do NOT cut the last backup at a scarce position; if none qualifies, it falls back to
 *  value-min (there was no depth-preserving drop to make). */
function chooseDrops(members: RosterMember[], template: string[], flexOk: Set<string>):
  { valueMin: RosterMember | null; depth: RosterMember | null; best: RosterMember | null } {
  const legal = members.filter((m) => canFillTemplate(members.filter((x) => x !== m), template, flexOk));
  if (!legal.length) return { valueMin: null, depth: null, best: null };
  const byProjAsc = [...legal].sort((a, b) => a.proj - b.proj || a.playerSk.localeCompare(b.playerSk));
  const valueMin = byProjAsc[0];
  const depthSafe = byProjAsc.filter((m) => !SCARCE.has(m.pos) || backupsAt(members, m.pos, template) - 1 >= 1);
  const depth = depthSafe.length ? depthSafe[0] : valueMin;
  const best = [...legal].sort((a, b) => b.proj - a.proj || a.playerSk.localeCompare(b.playerSk))[0]; // control
  return { valueMin, depth, best };
}

/** Realized rest-of-season lineup value of dropping `x` from the frozen roster: sum over weeks
 *  fromW..toW of (best actual lineup WITH x) - (best actual lineup WITHOUT x), using real points and
 *  real availability. Zero in a week where x would not have started anyway. */
function marginalValue(
  members: RosterMember[], x: RosterMember, fromW: number, toW: number,
  season: Map<string, Map<number, SeasonRow>>, template: string[], flexOk: Set<string>,
): number {
  let total = 0;
  for (let w = fromW; w <= toW; w++) {
    const withX: RosterPlayer[] = [];
    const withoutX: RosterPlayer[] = [];
    for (const m of members) {
      const r = season.get(m.playerSk)?.get(w);
      const available = !!r && !r.bye && !r.out;
      const rp: RosterPlayer = { name: m.name, pos: m.pos, proj: available ? r!.pts : 0, available };
      withX.push(rp);
      if (m.playerSk !== x.playerSk) withoutX.push(rp);
    }
    total += optimalLineup(withX, template, flexOk).totalProj - optimalLineup(withoutX, template, flexOk).totalProj;
  }
  return total;
}

export function backtestDropPolicy(
  db: DB, opts: { leagueId: string; seasons: number[]; model?: ModelName; maxDecisionWeek?: number },
): DropPolicyResult {
  const modelName = opts.model ?? "served";
  const model = loadModel(modelName);
  const cfg = getConfig(db);
  const flexOk = new Set<string>(cfg.flex_ok as string[]);

  const perSeasonDiffs = new Map<number, number[]>();
  const controlDiffs: number[] = [];
  let decisions = 0, differing = 0, agree = 0;

  for (const season of opts.seasons) {
    // Preload the whole season's weekly rows once, indexed by player_sk -> week -> outcome.
    const season2 = new Map<string, Map<number, SeasonRow>>();
    for (const r of db.prepare(
      `SELECT player_sk, week, pts, is_bye, inj_out, pos, name FROM feat_player_week_model
        WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { player_sk: string; week: number; pts: number | null; is_bye: number | null; inj_out: number | null; pos: string; name: string }[]) {
      let m = season2.get(r.player_sk); if (!m) { m = new Map(); season2.set(r.player_sk, m); }
      m.set(r.week, { pts: r.pts ?? 0, bye: !!r.is_bye, out: !!r.inj_out, pos: r.pos });
    }
    const regWeeks = (db.prepare(`SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?`).get(season) as { rw: number | null }).rw
      ?? (db.prepare(`SELECT MAX(week) w FROM feat_player_week_model WHERE season=? AND pts IS NOT NULL`).get(season) as { w: number | null }).w
      ?? 14;
    const maxW = Math.min(opts.maxDecisionWeek ?? regWeeks - 1, regWeeks - 1);
    perSeasonDiffs.set(season, []);

    for (let W = 1; W <= maxW; W++) {
      const ctx = loadWeekContext(db, opts.leagueId, season, W, model);
      const template = ctx.template;
      for (const [, entries] of ctx.rosters) {
        const members: RosterMember[] = [];
        for (const e of entries) {
          const p = ctx.players.get(e.playerSk);
          if (!p) continue; // no feature row -> unknown player, skip (rare, reported by ctx.fellBack)
          members.push({ playerSk: e.playerSk, name: p.name, pos: p.pos, proj: p.proj ?? p.fallback ?? 0 });
        }
        if (members.length < template.filter((s) => s !== "BE" && s !== "BENCH").length + 1) continue; // no real drop choice
        const { valueMin, depth, best } = chooseDrops(members, template, flexOk);
        if (!valueMin || !depth) continue;
        decisions++;
        // Control: value-min vs dropping the BEST player -- must be strongly negative.
        if (best && best.playerSk !== valueMin.playerSk) {
          controlDiffs.push(
            marginalValue(members, valueMin, W, regWeeks, season2, template, flexOk) -
            marginalValue(members, best, W, regWeeks, season2, template, flexOk),
          );
        }
        if (depth.playerSk === valueMin.playerSk) { agree++; perSeasonDiffs.get(season)!.push(0); continue; }
        differing++;
        const diff =
          marginalValue(members, valueMin, W, regWeeks, season2, template, flexOk) -
          marginalValue(members, depth, W, regWeeks, season2, template, flexOk);
        perSeasonDiffs.get(season)!.push(diff);
      }
    }
  }

  const all: number[] = [];
  const perSeason = opts.seasons.map((s) => {
    const d = perSeasonDiffs.get(s) ?? [];
    const nz = d.filter((x) => x !== 0);
    for (const x of d) all.push(x);
    return { season: s, differing: nz.length, meanDiff: nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0 };
  });
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const nzAll = all.filter((x) => x !== 0);

  // Season-level bootstrap on the per-season mean-over-all-decisions.
  const seasonMeans = perSeason.map((p) => { const d = perSeasonDiffs.get(p.season) ?? []; return mean(d); });
  const boot: number[] = [];
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let b = 0; b < 2000; b++) {
    let s = 0; for (let i = 0; i < seasonMeans.length; i++) s += seasonMeans[Math.floor(rand() * seasonMeans.length)];
    boot.push(s / seasonMeans.length);
  }
  boot.sort((a, b) => a - b);

  return {
    seasons: opts.seasons, model: modelName,
    decisions, differing, agree,
    meanDiff: mean(nzAll),
    meanDiffAll: mean(all),
    perSeason,
    bootstrap: {
      lo: boot[Math.floor(0.05 * boot.length)], hi: boot[Math.floor(0.95 * boot.length)],
      pDepthBetter: boot.filter((x) => x > 0).length / boot.length,
    },
    controlDropStarterMeanDiff: mean(controlDiffs),
  };
}
