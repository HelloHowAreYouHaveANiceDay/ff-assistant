/**
 * ONE definition of "the league, ready to simulate".
 *
 * WHY THIS EXISTS. Six scripts -- trade-odds, trade-check, waiver-check, positional-value,
 * sim-convergence, season-odds -- each rebuilt the same context by hand: load three fitted models,
 * read the board, group rosters by team, resolve byes, compute pool ranks, build a schedule, assemble
 * the options object. Fifty-odd lines, copy-pasted six times, and they had already drifted:
 *
 *   - only trade-odds had the offline fallback for when the app is unreachable
 *   - season-odds, waiver-check and trade-odds used the REAL schedule; positional-value,
 *     sim-convergence and trade-check silently used a GENERATED one
 *   - every one of them hardcoded `playoffTeams: 7` and `projSd: 0.30` while config holds the real
 *     values
 *
 * The consequence was not theoretical. The same roster returned a base title probability of 4.17%,
 * 4.56% and 5.1% depending on which tool asked, and those numbers were compared against each other
 * as though they measured the same thing. A shared context is not tidiness here; it is the only way
 * two tools can be talking about the same league.
 *
 * CONFIG IS THE SOURCE, not the caller. playoffTeams, regWeeks, slots and flex_ok come from the
 * store. A hardcoded 7 that happens to match today is the same defect as the hardcoded FLEX_OK found
 * in the lineup optimiser: correct by coincidence, and silently wrong the moment the league changes.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { simulateSeasons, type SeasonTeamInput, type SeasonOdds, type VarianceModel } from "./season.js";
import { buildSchedule } from "./schedule.js";
import { nameKey, dstAliasKey } from "./values.js";
import { dataPath } from "../data/paths.js";

export interface SimContext {
  teams: SeasonTeamInput[];
  weeks: [number, number][][];
  meIdx: number;
  season: number;
  /** True when the schedule was generated because the real one was unreachable. */
  syntheticSchedule: boolean;
  /** Ready-made options; callers override only `trials` and `seed`. */
  opts: (trials: number, seed: number) => Parameters<typeof simulateSeasons>[3];
  run: (teams: SeasonTeamInput[], trials: number, seed: number) => SeasonOdds[];
  /** Deep copy, so a caller can mutate a roster without touching the shared base. */
  clone: (t?: SeasonTeamInput[]) => SeasonTeamInput[];
  board: Map<string, { name: string; pos: string; proj: number; team: string }>;
  ownedIds: Set<string>;
  /** The league's starting template and FLEX eligibility, so a caller building a hypothetical roster
   *  can ask whether it is legal (rosterGaps) instead of finding out when the simulator refuses. */
  slots: string[];
  flexOk?: string[];
  /** Per-position WEEKLY points freely available off waivers -- the streaming floor. */
  replacement: Record<string, number>;
}

/**
 * `schedule` decides where the weeks come from:
 *   "real"      fetch through the league adaptor; throws if unreachable
 *   "generated" always build one; deterministic and offline
 *   "auto"      real when reachable, generated otherwise, and SAYS WHICH
 *
 * "auto" is the default because a tool that silently swaps schedules produces numbers that cannot be
 * compared with each other -- which is exactly what happened. The flag is on the returned context so
 * a caller can print it rather than assume.
 */
export async function loadSimContext(opts: { schedule?: "real" | "generated" | "auto" } = {}): Promise<SimContext> {
  const want = opts.schedule ?? "auto";
  const vm = JSON.parse(readFileSync(dataPath("variance-model.json"), "utf8")) as VarianceModel;
  const outcomes = JSON.parse(readFileSync(dataPath("rank-outcomes.json"), "utf8"));
  const corr = JSON.parse(readFileSync(dataPath("correlation-model.json"), "utf8"));

  const db = new Database(dataPath("ff.db"), { readonly: true });
  const cfg = JSON.parse((db.prepare("SELECT value FROM settings WHERE key='config'").get() as { value: string }).value);
  const lgRow = db.prepare("SELECT league_id, team_id FROM league WHERE season=? AND team_id IS NOT NULL").get(cfg.season) as { league_id: string; team_id: string };

  const byeOf = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT p.name, r.bye FROM player p JOIN ranking r ON r.player_id=p.player_id AND r.source='fantasypros_ecr' AND r.season=?",
  ).all(cfg.season) as { name: string; bye: number }[]) byeOf.set(nameKey(r.name), r.bye);

  const board = new Map<string, { name: string; pos: string; proj: number; team: string }>();
  for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfg.season) as { player_id: string; row_json: string }[]) {
    const j = JSON.parse(r.row_json) as Record<string, unknown>;
    board.set(r.player_id, { name: String(j.Player), pos: String(j.Pos), proj: Number(j.ProjPts) || 0, team: String(j.Team ?? "") });
  }
  const ownedIds = new Set<string>();
  const byTeam = new Map<string, SeasonTeamInput>();
  const unmatched: string[] = [];
  for (const r of db.prepare("SELECT player_id, team_id, team_abbrev, owner FROM ownership WHERE league_id=?").all(lgRow.league_id) as { player_id: string; team_id: string; team_abbrev: string; owner: string }[]) {
    ownedIds.add(r.player_id);
    // ESPN keys defenses by NICKNAME ("packers"); the board keys them by ABBREVIATION ("gb"). The
    // alias table for exactly this has existed in values.ts since the draft-room lookup needed it,
    // and was simply never applied here -- so every one of the sixteen rosters silently lost its
    // defense, and every title probability this tool has ever produced was computed with all sixteen
    // teams fielding an empty DST slot.
    const alias = dstAliasKey(r.player_id);
    const b = board.get(r.player_id) ?? (alias ? board.get(alias) : undefined);
    if (!b) { unmatched.push(r.player_id); continue; }
    if (alias) ownedIds.add(alias);
    if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, { id: r.team_id, name: r.team_abbrev || r.owner, roster: [] });
    byTeam.get(r.team_id)!.roster.push({ ...b, bye: byeOf.get(nameKey(b.name)) ?? null });
  }
  // A roster row that matches nothing used to be skipped in silence, which is why the defect above
  // survived: an incomplete roster and a correct one produce the same output, and the simulator
  // happily fields an empty slot rather than complaining. Anything unmatched is now reported.
  if (unmatched.length) {
    console.warn(`WARNING: ${unmatched.length} rostered players matched no board row and were dropped from the simulation: ${unmatched.slice(0, 12).join(", ")}${unmatched.length > 12 ? " ..." : ""}`);
  }
  // The structural consequence -- a roster that cannot fill the lineup -- is NOT checked here. It is
  // enforced in simulateSeasons, which every path reaches and this one does not: six scripts build
  // their teams without ever calling loadSimContext. Checking it in both places would mean two
  // sources of truth for the same rule, and the weaker one warns where the other refuses.
  const teams = [...byTeam.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const meIdx = teams.findIndex((t) => t.id === String(lgRow.team_id));

  // Pool ranks from the FULL projection pool: the variance model's tiers are fractions of that, and
  // ranking within rostered players instead maps a 16-team league's WR4 onto the historical
  // "barely plays" tier. This subtlety is exactly the kind that a copy-pasted context gets wrong in
  // one place and right in five.
  const poolRank = new Map<string, { rank: number; of: number }>();
  {
    const byPos: Record<string, { name: string; pts: number }[]> = {};
    for (const line of readFileSync(dataPath("points.csv"), "utf8").trim().split(/\r?\n/).slice(1)) {
      const f = line.split(",");
      if (!f[0] || !f[2]) continue;
      (byPos[f[1].trim().toUpperCase()] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
    }
    for (const l of Object.values(byPos)) { l.sort((a, b) => b.pts - a.pts); l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length })); }
  }
  db.close();

  const regWeeks = cfg.regWeeks ?? 14;
  let weeks: [number, number][][] = [];
  let syntheticSchedule = true;
  if (want !== "generated") {
    try {
      const { openLeague } = await import("../league/index.js");
      const lg = await openLeague();
      const sched = lg.provider.matchups ? await lg.provider.matchups() : null;
      const idx = new Map(lg.teams.map((t, i) => [t.id, i]));
      await lg.close();
      if (sched) {
        for (let w = 1; w <= regWeeks; w++) {
          const g = sched.games.filter((x) => x.week === w)
            .map((x) => [idx.get(x.homeId), idx.get(x.awayId)] as [number, number])
            .filter(([a, b]) => a != null && b != null);
          if (g.length) weeks.push(g);
        }
        if (weeks.length) syntheticSchedule = false;
      }
    } catch (e) {
      if (want === "real") throw new Error(`real schedule unavailable: ${(e as Error).message}`);
    }
  }
  if (!weeks.length) {
    weeks = buildSchedule(teams.length, regWeeks, 4).weeks as [number, number][][];
    syntheticSchedule = true;
  }

  /**
   * STREAMING FLOOR, measured from the actual free-agent pool rather than assumed.
   *
   * QB, K and DST are streamable in every real league: if your starter is on bye you add whoever is
   * free that week, and at those positions the free option is close to the rostered one. The
   * simulator scored an unfillable slot as ZERO, which is a penalty nobody actually pays and which
   * falls entirely on rosters carrying one body at a mandatory slot -- ours carries one QB, one K,
   * one DST and one RB, so it was taking four guaranteed zeroes a season that would never happen.
   *
   * NOT the best free agent: fifteen other managers stream too, and the top man is gone by the time
   * most of them look. The SECOND-best available is a deliberately modest stand-in for that
   * competition. It is a judgement call, so it is stated here rather than buried, and the resolved
   * values are printed by `ff models`.
   */
  const REPLACEMENT_INDEX = 1;
  const replacement: Record<string, number> = {};
  {
    const freeByPos: Record<string, number[]> = {};
    for (const [id, p] of board) {
      if (ownedIds.has(id)) continue;
      (freeByPos[p.pos] ??= []).push(p.proj);
    }
    for (const [pos, list] of Object.entries(freeByPos)) {
      list.sort((a, b) => b - a);
      const seasonPts = list[Math.min(REPLACEMENT_INDEX, list.length - 1)] ?? 0;
      // Season projection -> per week. A streamed player is started for one week, not a season.
      replacement[pos] = Math.max(0, seasonPts / Math.max(1, regWeeks));
    }
  }

  const mkOpts = (trials: number, seed: number) => ({
    weeks: weeks.length,
    playoffTeams: cfg.playoffTeams ?? 7,     // FROM CONFIG -- a hardcoded 7 is right by coincidence
    slots: cfg.slots,
    // The league's own FLEX eligibility, which was being dropped here. optimalLineup defaults to
    // RB/WR/TE, which happens to be right for this league and would be silently wrong for a
    // superflex one -- a config value the code ignores reads as configured behaviour.
    flexOk: cfg.flex_ok,
    projSd: 0.30,
    replacement,
    trials, seed, poolRank,
    bootstrap: { outcomes, corr, calibration: "scale" as const },
  });
  return {
    teams, weeks, meIdx, season: cfg.season, syntheticSchedule, board, ownedIds,
    slots: cfg.slots as string[], flexOk: cfg.flex_ok as string[] | undefined, replacement,
    opts: mkOpts,
    run: (t, trials, seed) => simulateSeasons(t, weeks, vm, mkOpts(trials, seed)),
    clone: (t) => (t ?? teams).map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) })),
  };
}
