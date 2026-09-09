/**
 * ONE DISPATCHER FOR EVERY IN-SEASON RECOMMENDATION -- and the D3 action-log write that must happen
 * before any of them is returned.
 *
 * WHY A DISPATCHER RATHER THAN TWO CALLERS. `ff copilot <verb>` and the MCP tools of the same name
 * are the same nine answers reached two ways. If each wired itself to `copilot.ts` directly they
 * would be two implementations of the same thing, and the repo has already paid for that mistake
 * once: six scripts hand-built the same sim context, three of them on the real schedule and three on
 * a generated one, and the base title probability came out 4.17%, 4.56% or 5.1% depending on which
 * tool you asked. Here there is one code path. A terminal and the Assistant cannot disagree about
 * what the number is, because there is only one place it is computed.
 *
 * WHY THE LOG IS IN THE DISPATCHER AND NOT IN THE TOOLS (D3, D7). The action log is a black-box
 * recorder: every move the agent makes is written BEFORE it happens and completed after, so any
 * action is visible and explainable without gating it. This phase makes no ESPN writes at all, and
 * the instinct is therefore that there is nothing to log -- which is exactly wrong. What the
 * Assistant DOES in this phase is give advice, and advice acted on by a human is still the agent
 * driving the team. So every recommendation is logged with its verb, its arguments and a summary of
 * what it said, at status `recommended`, before the caller ever sees the answer. When the write
 * tools do arrive, an ESPN move will sit in the same log directly beneath the recommendation that
 * produced it, which is the record you actually want when something goes wrong.
 *
 * Putting the write here rather than in each tool is the same argument as D7's constrained surface:
 * a caller cannot forget to log if there is no path that reaches the answer without logging.
 */
import { openDb, logAction } from "../db/db.js";
import { loadSimContext, type SimContext } from "../draft/simContext.js";
import * as C from "./copilot.js";
import * as S from "./copilotStore.js";

export const COPILOT_VERBS = [
  "season_odds", "lineup_recommend", "waiver_targets", "trade_check",
  "trade_finder", "handcuffs", "depth_risk", "power_rankings", "playoff_sos",
] as const;
export type CopilotVerb = (typeof COPILOT_VERBS)[number];

export interface CopilotArgs {
  schedule?: "real" | "generated" | "auto";
  trials?: number;
  seed?: number;
  week?: number;
  player?: string;
  give?: string[];
  get?: string[];
  positions?: string[];
  limit?: number;
  freeOnly?: boolean;
  maxGap?: number;
}

export interface CopilotRun<T = unknown> {
  verb: CopilotVerb;
  result: T;
  /** The human-readable version, which is also what lands in the action log. */
  summary: string;
  /** action_log row id, written BEFORE the result was returned. */
  logId: number;
}

const pct = (n: number) => `${n.toFixed(2)}%`;
const pp = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}pp`;

/** The caveat sentence every summary ends with. An Assistant that quotes the headline number and
 *  drops this is quoting a number without its assumptions, which is the whole failure mode. */
export function caveat(a: C.Assumptions): string {
  const bits = [
    a.schedule === "real" ? "REAL schedule" : "GENERATED schedule (not this league's actual matchups)",
    a.basis === "simulation" ? `${a.trials} trials x ${a.seeds?.length ?? 0} seed(s)` : a.basis === "market" ? "solved from posted betting lines" : "point projections, no simulation",
    `board ${a.artifact.season} (${a.artifact.boardRows} rows)`,
  ];
  return `[${bits.join("; ")}]`;
}

function summarize(verb: CopilotVerb, r: unknown): string {
  switch (verb) {
    case "season_odds": {
      const x = r as C.SeasonOddsResult;
      const top = x.teams.slice(0, 3).map((t) => `${t.name} ${pct(100 * t.champion)}`).join(", ");
      return `US: ${pct(100 * x.us.playoffs)} playoffs, ${pct(100 * x.us.champion)} title (random = ${x.randomTitlePct}%). Field leaders: ${top}. ${caveat(x.assumptions)}`;
    }
    case "lineup_recommend": {
      const x = r as C.LineupResultJson;
      const empties = x.starters.filter((s) => s.name === "(empty)").length;
      return `Week ${x.week}: ${x.totalProj} projected pts. ${x.starters.filter((s) => s.name !== "(empty)").map((s) => `${s.slot} ${s.name}`).join(", ")}.` +
        `${x.unavailable.length ? ` OUT/bye: ${x.unavailable.map((u) => `${u.name} (${u.reason})`).join(", ")}.` : ""}` +
        `${empties ? ` ${empties} slot(s) UNFILLABLE.` : ""} ${caveat(x.assumptions)}`;
    }
    case "waiver_targets": {
      const x = r as C.WaiverResult;
      if (!x.targets.length) return `No waiver claim scored. Base ${pct(x.baseTitlePct)} title. ${caveat(x.assumptions)}`;
      const rows = x.targets.slice(0, 4).map((t) => `ADD ${t.add} (${t.pos}) / DROP ${t.drop}: ${pp(t.deltaPp)}${t.clearsNoise ? "" : " (inside noise)"} , FAAB ~${t.faab}`).join("; ");
      return `Base ${pct(x.baseTitlePct)} title; noise floor ${x.noiseFloorPp}pp. ${rows}.` +
        `${x.refused.length ? ` Refused ${x.refused.length} drop(s) that leave a slot unfillable.` : ""} ${caveat(x.assumptions)}`;
    }
    case "trade_check": {
      const x = r as C.TradeCheckResult;
      return `${x.offer.give.join(" + ")} -> ${x.offer.get.join(" + ")} with ${x.them.teamName}: us ${pp(x.us.deltaPp)} (+/-${x.us.se}), them ${pp(x.them.deltaPp)}. Verdict: ${x.verdict}${x.mutual ? ", and it helps them too" : ""}. ${caveat(x.assumptions)}`;
    }
    case "trade_finder": {
      const x = r as C.TradeFinderResult;
      if (!x.ideas.length) return `No balanced one-for-one found within a ${Math.round(100 * x.maxValueGap)}% consensus-value band (${x.candidates} candidates). ${caveat(x.assumptions)}`;
      return `${x.candidates} balanced candidates; best: ` + x.ideas.slice(0, 4).map((i) => `${i.give} -> ${i.get} (${i.partner}) ${pp(i.deltaPp)}${i.mutual ? " MUTUAL" : i.themDeltaPp < 0 ? " (costs them)" : ""}`).join("; ") + `. Noise floor ${x.noiseFloorPp}pp. ${caveat(x.assumptions)}`;
    }
    case "handcuffs": {
      const x = r as C.HandcuffResult;
      return `${x.positions.join("/")} handcuffs over ${x.weeks} weeks: ` + x.rows.slice(0, 5).map((h) => `${h.name} behind ${h.lead} -- ${h.activePerWk}/wk if out${h.ours ? " (OURS)" : h.rostered ? "" : " (FREE)"}`).join("; ") + `. ${caveat(x.assumptions)}`;
    }
    case "depth_risk": {
      const x = r as C.DepthRiskResult;
      return `Losing ${x.player.name} costs ${pp(x.costPp)} of title probability (${pct(x.baseTitlePct)} -> ${pct(x.withoutTitlePct)}); noise floor ${x.noiseFloorPp}pp. Best insurance: ` +
        x.insurance.slice(0, 3).map((i) => `${i.name} (${i.free ? "free agent" : i.from}) recovers ${pp(i.recoversPp)}`).join("; ") + `. ${caveat(x.assumptions)}`;
    }
    case "power_rankings": {
      const x = r as C.PowerResult;
      return `We are #${x.ourRank} of ${x.rows.length} (league mean ${x.leagueMeanStartPts} starter pts). Top: ` +
        x.rows.slice(0, 4).map((t) => `${t.rank}. ${t.team} ${t.startPts}pts / ${t.titlePct}% title`).join("; ") + `. ${caveat(x.assumptions)}`;
    }
    case "playoff_sos": {
      const x = r as C.SosResult;
      return `Weeks ${x.playoffWeeks.join("/")} (${x.pricedPlayoffGames} of ${x.playoffGames} games priced so far). ` +
        x.players.slice(0, 5).map((p) => `${p.name} ${p.nflTeam ?? "?"} SOS ${p.sos ?? "?"} (rk ${p.rank ?? "?"}), ${p.costPerWeek == null ? "no slope for " + p.pos : `${p.costPerWeek > 0 ? "-" : "+"}${Math.abs(p.costPerWeek).toFixed(2)} pts/wk`}`).join("; ") +
        `. ${caveat(x.assumptions)}`;
    }
  }
}

/** Build the shared context once. Exposed so a caller running several verbs pays for it once. */
export async function copilotContext(schedule: CopilotArgs["schedule"] = "auto"): Promise<SimContext> {
  return loadSimContext({ schedule });
}

function dispatch(verb: CopilotVerb, ctx: SimContext, a: CopilotArgs, dbPath?: string): unknown {
  const provenance = S.loadProvenance(dbPath);
  const base = { provenance, trials: a.trials, seed: a.seed };
  switch (verb) {
    case "season_odds":
      return C.seasonOdds(ctx, { ...base, trials: a.trials ?? 2000 });
    case "lineup_recommend": {
      const wk = a.week ?? S.currentWeek(dbPath).week;
      return { ...C.lineupRecommend(ctx, wk, { provenance, availability: S.loadAvailability(dbPath) }), weekSource: a.week != null ? "caller" : S.currentWeek(dbPath).source };
    }
    case "waiver_targets":
      return C.waiverTargets(ctx, { provenance, trials: a.trials ?? 500, seeds: a.seed != null ? [a.seed] : [7, 101], adds: a.limit ?? 4, dropsPerAdd: 3, positions: a.positions, faabBudget: S.loadFaabBudget(dbPath) });
    case "trade_check":
      return C.tradeCheck(ctx, { give: a.give ?? [], get: a.get ?? [] }, { provenance, trials: a.trials ?? 1600, seeds: a.seed != null ? [a.seed] : [7, 101] });
    case "trade_finder":
      return C.tradeFinder(ctx, { provenance, values: S.loadConsensusValues(dbPath), trials: a.trials ?? 1200, seed: a.seed ?? 7, limit: a.limit ?? 8, maxGap: a.maxGap, positions: a.positions });
    case "handcuffs": {
      const positions = a.positions ?? ["RB"];
      const { depth, poolSize, vm } = S.loadDepth(positions, dbPath);
      return C.handcuffs(ctx, { provenance, depth, vm, poolSize, positions, weeks: a.week != null ? Math.max(1, C.NFL_WEEKS - a.week + 1) : C.NFL_WEEKS, freeOnly: a.freeOnly });
    }
    case "depth_risk":
      if (!a.player) throw new Error("depth_risk needs a player name");
      return C.depthRisk(ctx, a.player, { provenance, trials: a.trials ?? 1000, seeds: a.seed != null ? [a.seed] : [7, 101], insurers: a.limit ?? 4 });
    case "power_rankings":
      return C.powerRankings(ctx, { ...base, trials: a.trials ?? 2000 });
    case "playoff_sos": {
      const { games, regWeeks } = S.loadGames(dbPath);
      return C.playoffSos(ctx, { provenance, games, regWeeks, teamOf: S.loadTeamOf(dbPath) });
    }
  }
}

/**
 * Run one verb, LOG IT, and hand back the result plus its summary.
 *
 * The order is the whole point and matches D3: a `planned` row goes in before the work starts, so a
 * verb that crashes or hangs still leaves a trace of having been asked; the row is completed with
 * `recommended` and the summary before the caller is given anything. There is no return path that
 * skips the write. `test/copilot-actions.test.ts` fault-injects exactly that -- a variant that
 * returns without logging -- so the assertion is known to be able to fail.
 */
export async function runCopilot(
  verb: CopilotVerb,
  args: CopilotArgs = {},
  opts: { dbPath?: string; ctx?: SimContext } = {},
): Promise<CopilotRun> {
  if (!COPILOT_VERBS.includes(verb)) throw new Error(`unknown copilot verb "${verb}". Valid: ${COPILOT_VERBS.join(", ")}`);
  const db = openDb(opts.dbPath);
  const logId = logAction(db, { runType: "copilot", action: verb, detail: { args } });
  try {
    const ctx = opts.ctx ?? await copilotContext(args.schedule);
    const result = dispatch(verb, ctx, args, opts.dbPath);
    const summary = summarize(verb, result);
    // WRITTEN BEFORE THE RETURN, not after. `status` is `recommended` rather than `done` because
    // nothing was done -- advice was given, and the log should not claim a roster move happened.
    db.prepare("UPDATE action_log SET status=?, reason=? WHERE id=?").run("recommended", summary.slice(0, 2000), logId);
    db.close();
    return { verb, result, summary, logId };
  } catch (e) {
    db.prepare("UPDATE action_log SET status=?, reason=? WHERE id=?").run("failed", String(e).slice(0, 500), logId);
    db.close();
    throw e;
  }
}
