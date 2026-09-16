// Stage B of continuous in-season updates: a MATERIALISED decision state. The copilot recomputes
// waiver/trade/odds on demand, which is right for a person asking a question -- but a continuous loop
// wants the current answer already computed and stamped, so the app (or the next reader) sees fresh
// recommendations without waiting on a simulation, and can see WHEN they were last refreshed and
// against WHICH actuals. This is refresh-only by construction: it writes a snapshot of advice, never
// an ESPN move (the copilot's own D3 rule -- every run is logged at status "recommended").
//
// The snapshot is keyed by verb (one current row each), stamped with the actuals hash that triggered
// the refresh, so "is this stale?" is a hash comparison, exactly as sync-actuals decides whether to
// rebuild at all.
import { openDb, nowIso, activeLeagueId } from "../db/db.js";
import { runCopilot, copilotContext, type CopilotVerb } from "./copilotActions.js";

/** The decision surfaces a continuous refresh materialises. Odds first (context), then the two the
 *  user named -- waivers and trades. Lineup is intentionally omitted: it is a per-week serve the app
 *  already renders live, not a standing recommendation that drifts with actuals. */
export const SNAPSHOT_VERBS: CopilotVerb[] = ["season_odds", "waiver_targets", "trade_finder"];

// THE CREATE LIVES IN schema.sql (S-13, 2026-09-16). It used to live here, and it omitted the
// `league_id` the INSERT below has always written -- so a FRESH store got a one-row-per-verb table
// shared by every league while an existing store (migrated by `migrateLeagueIdPk`) got the keyed one.
// Two spellings of one table, and the one that ran first on a new machine was the broken one.

/**
 * Recompute the snapshot verbs against the current board and store them, stamped with `actualsHash`.
 * Builds the sim context ONCE and shares it across verbs (rosters/board/schedule are identical for
 * all three), so a refresh is three sims over one context rather than three cold starts.
 */
export async function refreshDecisionSnapshot(opts: {
  dbPath?: string; actualsHash?: string | null; schedule?: "real" | "generated" | "auto";
  /** WHICH LEAGUE this snapshot is of. Omitted = the ACTIVE league, resolved ONCE below. */
  leagueId?: string | null;
} = {}): Promise<{ rows: number; schedule: string; week: number | null; verbs: string[]; leagueId: string }> {
  // RESOLVE THE LEAGUE ONCE, BEFORE THE CONTEXT IS BUILT, AND STAMP FROM THAT (I-7). It used to build
  // the context against the active league and then re-read `activeLeagueId(db)` AFTER the three
  // simulations had run -- so a league switch during the refresh (the app's league tab writes that
  // setting) stamped one league's rows with another league's numbers. Nothing would have failed; the
  // snapshot would simply have been about the wrong team, which is the whole failure class.
  const lg = (() => {
    const db0 = openDb(opts.dbPath);
    try { return opts.leagueId ?? activeLeagueId(db0) ?? ""; } finally { db0.close(); }
  })();
  const ctx = await copilotContext(opts.schedule ?? "auto", lg || undefined);
  const db = openDb(opts.dbPath);
  try {
    const ins = db.prepare(
      `INSERT INTO decision_snapshot (league_id, verb, season, week, schedule, actuals_hash, summary, result_json, updated_at)
       VALUES (@lg,@verb,@season,@week,@schedule,@hash,@summary,@json,@now)
       ON CONFLICT(league_id,verb) DO UPDATE SET season=excluded.season, week=excluded.week, schedule=excluded.schedule,
         actuals_hash=excluded.actuals_hash, summary=excluded.summary, result_json=excluded.result_json,
         updated_at=excluded.updated_at`,
    );
    const now = nowIso();
    const done: string[] = [];
    let schedule = "unknown";
    for (const verb of SNAPSHOT_VERBS) {
      // Share the one context; runCopilot still logs each run to action_log at "recommended" (D3).
      const run = await runCopilot(verb, { schedule: opts.schedule ?? "auto", ...(lg ? { league: lg } : {}) }, { dbPath: opts.dbPath, ctx });
      const a = (run.result as { assumptions?: { schedule?: string } }).assumptions;
      schedule = a?.schedule ?? schedule;
      ins.run({
        lg, verb, season: ctx.season, week: (ctx as { week?: number }).week ?? null,
        schedule: a?.schedule ?? null, hash: opts.actualsHash ?? null,
        summary: run.summary.slice(0, 4000), json: JSON.stringify(run.result), now,
      });
      done.push(verb);
    }
    return { rows: done.length, schedule, week: (ctx as { week?: number }).week ?? null, verbs: done, leagueId: lg };
  } finally { db.close(); }
}
