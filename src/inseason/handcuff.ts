/**
 * HANDCUFF VALUE -- what a backup is worth as insurance and as a lottery ticket.
 *
 * MEASURED, NOT ASSUMED. scripts/handcuff-effect.mjs and scripts/handcuff-form.mjs fit this on 27
 * seasons of our own weekly history, comparing each backup against HIMSELF: his mean in weeks his
 * lead back played, versus his mean in weeks the lead back did not. That within-player, within-team
 * design is what makes it a measurement -- comparing backups on injury-hit teams against backups on
 * healthy teams would confound the effect with team quality and roster fragility.
 *
 *   depth-2 backup, lead back out:  +4.42 pts/wk   t = 14.2   positive in 79% of 307 cases
 *
 * The lead is identified on WEEKS 1-4 ONLY, so the number is what a preseason depth chart could
 * actually have told you. Defining the lead by season total instead gives +5.06 and by points per
 * game +6.05; the hindsight-free figure is the conservative one and is what this ships with.
 *
 * THE FUNCTIONAL FORM WAS A HORSE RACE, out of sample by held-out season, because the three
 * candidates imply OPPOSITE strategies:
 *
 *   ADDITIVE        backup_in + 4.42            R-sq  0.142
 *   MULTIPLICATIVE  backup_in * 1.44            R-sq -0.126
 *   INHERITANCE     0.81 * lead_in              R-sq -0.377   <- the intuitive one, and the WORST
 *   BOTH            0.922*backup_in + 0.402*lead_in   R-sq 0.181   <- shipped
 *
 * "The backup inherits the starter's job" is the natural mental model and it predicts worse than a
 * flat constant. Shipping it would have systematically overvalued elite handcuffs.
 *
 * THE COUNTERINTUITIVE RESULT THAT DRIVES THE STRATEGY. Splitting by the lead back's own quality:
 *
 *                      backup w/ lead in   w/ lead out    lift
 *   elite lead (n=154)        5.43            10.81      +5.38
 *   ordinary   (n=153)        7.21            10.66      +3.44
 *
 * The LIFT is bigger for elite handcuffs, but the DESTINATION is the same -- 10.81 vs 10.66 is well
 * inside noise. A handcuff is worth about 10.7 points a week once activated no matter whose backup
 * he is. The larger lift behind an elite starter exists because that starter SUPPRESSES his backup
 * harder (5.43 vs 7.21 baseline), not because the payoff is richer. So the reason to prefer an elite
 * team's handcuff is that he is cheaper and less rostered for the same payoff -- not a bigger
 * ceiling. Reading the lift column alone would have got the strategy right for the wrong reason,
 * which is the kind of thing that stops being right when the market prices it.
 *
 * WHY THIS IS NOT ADDED TO THE PROJECTION, which is the obvious thing to do and would DOUBLE COUNT.
 * Our projection is the rank curve: historical points posted by players who entered a season at that
 * positional rank. Those historical seasons already include the ones where the man ahead got hurt
 * and the backup took over -- that is part of why a deep RB's pool has such a long right tail. Adding
 * an expected handcuff bonus on top would count the same event twice. The value belongs on its own
 * decision surface, as a ranked list of who to hold, which is also the question actually being
 * asked.
 */
import type { VarianceModel } from "../draft/season.js";

/**
 * CHECKED AGAINST A SECOND, INDEPENDENT DEFINITION OF THE EVENT (2026-09-09), AND IT STANDS.
 *
 * The fit above infers "the lead is out" from the lead's own missing week, with the lead identified
 * by weeks 1-4 production. `src/inseason/backtest/promotion.ts` builds the event from evidence that
 * design never used: the PUBLISHED DEPTH CHART moving a man from rank 2 to rank 1 in week w, with a
 * displaced week w-1 starter carrying an OUT designation that week -- a strictly pre-kickoff signal
 * a manager could have acted on. 67 events, 2018-2024:
 *
 *   pos   n    starter t4   backup pts, week   next-4   snap% before -> that week   share of starter
 *   RB    9         8.67              13.76      9.72          0.45 -> 0.61                    1.586
 *   QB   14        10.17               8.34      5.08          0.70 -> 0.90                    0.820
 *   WR   30         7.75               3.14      2.84          0.49 -> 0.61                    0.405
 *   TE   14         6.34               1.69      3.02          0.49 -> 0.60                    0.266
 *
 * A promoted running back outscores the man he replaced -- 158% of the departed starter's trailing
 * four-game average -- which corroborates the whole handcuff thesis from a direction the original
 * design could not see. The receiver and tight-end numbers are far lower, which is why this board
 * defaults to RB and why extending it to WR/TE on intuition would be a mistake.
 *
 * THE PRIOR WAS NOT REPLACED, AND THE GATE IS WHY. A regression of the backup's week-w points on
 * (the starter's trailing-4, the backup's prior snap share, the team's implied total), cross
 * validated NESTED BY SEASON against this same prior, is WORSE out of sample: RMSE 7.30 against the
 * prior's 6.78 pooled, and 3.27 against 1.50 on the nine running-back events. Adding the backup's
 * own trailing-4 -- the column the prior leans on -- brings the challenger to 6.59 against 6.78,
 * a 2.7% improvement on 66 events over seven folds, which is well inside the selection noise this
 * repo has been burned by before and fails outright on the position the board is actually for. So
 * the coefficients below are unchanged. `scripts/inseason-backtest-promotion.mjs` reruns it.
 */
/** Fitted on 27 seasons, out-of-sample selected. See the header. */
export const HANDCUFF_MODEL = { backup: 0.922, lead: 0.402, fittedFrom: "handcuff-form.mjs", cases: 307 } as const;

export interface DepthEntry { name: string; pos: string; team: string; depthOrder: number | null; projPts: number; rosteredPct?: number | null; poolRank?: number | null }

export interface HandcuffRow {
  name: string; pos: string; team: string; depthOrder: number;
  lead: string; leadProjPts: number;
  basePerWk: number;          // what he scores now, with the lead playing
  activePerWk: number;        // what he scores in a week the lead misses
  liftPerWk: number;          // the difference -- the thing you are buying
  missProb: number;           // per-week probability the lead misses, from the fitted availability
  expectedPts: number;        // lift * missProb * weeks -- the EV, which is NOT the whole story
  rosteredPct: number | null;
  /** The published depth chart calls this man the starter while our projection does not. That is a
   *  TIMESHARE, and it is the most useful row on the page rather than a data error to hide: the two
   *  sources disagreeing is precisely the signature of a backfield with no settled lead, where the
   *  "handcuff" may take over without anyone getting hurt at all. Live examples: Stevenson (NE, d1)
   *  behind Henderson, Hubbard (CAR, d1) behind Brooks. */
  contested: boolean;
}

/**
 * Per-week probability the lead back misses.
 *
 * The variance model's `avail` is games/17 and ALREADY INCLUDES THE BYE, so it must have the bye
 * divided back out before it can be read as an injury rate -- season.ts makes exactly this
 * correction and getting it wrong benches every player twice. Reused here so the two surfaces cannot
 * disagree about how durable a given tier is.
 */
export function leadMissProb(vm: VarianceModel, pos: string, poolRankFrac: number): number {
  const m = vm.pos[pos];
  if (!m) return 0.13;                                   // league-average-ish fallback, stated not hidden
  const tiers = vm.tiers ?? m.avail.length;
  const tier = Math.min(m.avail.length - 1, Math.max(0, Math.floor(poolRankFrac * tiers)));
  const availPerPlayableWeek = Math.min(1, (m.avail[tier] ?? 0.85) / (16 / 17));
  return Math.max(0, Math.min(1, 1 - availPerPlayableWeek));
}

/**
 * Rank every backup by what he is worth if the man ahead of him goes down.
 *
 * `weeks` is the REMAINING horizon, not 17 -- in week 10 a handcuff has eight weeks to pay off, not
 * seventeen, and quoting a preseason EV in November would overstate every row on the page.
 */
export function handcuffBoard(
  players: DepthEntry[],
  vm: VarianceModel,
  opts: { weeks?: number; positions?: string[]; poolSize?: Record<string, number> } = {},
): HandcuffRow[] {
  const weeks = opts.weeks ?? 17;
  const positions = opts.positions ?? ["RB"];
  const byTeamPos = new Map<string, DepthEntry[]>();
  for (const p of players) {
    if (!p.team || !positions.includes(p.pos)) continue;
    const k = `${p.team}|${p.pos}`;
    if (!byTeamPos.has(k)) byTeamPos.set(k, []);
    byTeamPos.get(k)!.push(p);
  }
  const out: HandcuffRow[] = [];
  for (const [, group] of byTeamPos) {
    // ORDER BY PROJECTION, NOT BY THE DEPTH CHART. The first version of this sorted on depth_order
    // and it produced nonsense, because that column is incomplete and sometimes simply disagrees
    // with reality:
    //
    //   KC   Kenneth Walker III  depth NULL, projects 225   <- the actual lead, sorted to LAST
    //   NE   Stevenson d1 (146) vs Henderson d2 (176)       <- order and projection disagree
    //   DET  Pacheco d4 (64) above Saylors d2 (26)          <- the real handcuff is listed fourth
    //
    // With nulls sorted last, KC's lead became Emmett Johnson (d2, 82 pts) and Walker was reported
    // as his BACKUP -- exactly inverted, and it rendered as a perfectly plausible top row.
    //
    // Projection is also the CONSISTENT choice: the fit behind this model identified the lead back
    // by weeks 1-4 PRODUCTION, not by anyone's published depth chart, so ranking by expected
    // production is what makes the shipped model match the measured one. depth_order is kept for
    // display and as a disagreement signal, never as the ordering.
    const ranked = group.slice().sort((a, b) => b.projPts - a.projPts || (a.depthOrder ?? 99) - (b.depthOrder ?? 99));
    const lead = ranked[0];
    if (!lead || lead.projPts <= 0) continue;
    const leadPerWk = lead.projPts / weeks;
    const poolSize = opts.poolSize?.[lead.pos] ?? 0;
    const frac = poolSize > 0 && lead.poolRank != null ? lead.poolRank / poolSize : 0;
    const missProb = leadMissProb(vm, lead.pos, frac);
    // ONLY THE TOP TWO BACKUPS, because that is the range the model was fitted on: the measurement
    // covers depth-2 (+4.42 pts/wk) and depth-3 (+2.37); it says nothing about a fourth-stringer.
    // Without this cap the board fills with players the fit never saw -- FULLBACKS, in practice:
    // Kyle Juszczyk (SF, 5th) and Alec Ingold (LAC, 4th) both scored above 6.0 if-out purely by
    // extrapolation. Someone who will never carry the ball is not a handcuff at any price.
    for (let i = 1; i < Math.min(3, ranked.length); i++) {
      const b = ranked[i];
      if (b.projPts <= 0) continue;
      const basePerWk = b.projPts / weeks;
      const activePerWk = HANDCUFF_MODEL.backup * basePerWk + HANDCUFF_MODEL.lead * leadPerWk;
      const lift = activePerWk - basePerWk;
      if (lift <= 0) continue;                            // already the de facto starter -- nothing to buy
      out.push({
        name: b.name, pos: b.pos, team: b.team, depthOrder: b.depthOrder ?? i + 1,
        lead: lead.name, leadProjPts: Math.round(lead.projPts * 10) / 10,
        basePerWk: Math.round(basePerWk * 100) / 100,
        activePerWk: Math.round(activePerWk * 100) / 100,
        liftPerWk: Math.round(lift * 100) / 100,
        missProb: Math.round(missProb * 1000) / 1000,
        expectedPts: Math.round(lift * missProb * weeks * 10) / 10,
        rosteredPct: b.rosteredPct ?? null,
        contested: b.depthOrder === 1,
      });
    }
  }
  // SORTED BY THE CONDITIONAL PAYOFF -- what he scores in a week the starter misses -- because that
  // is the question ("if my guy goes down, who saves my season?"). Getting here took two wrong
  // turns, both worth recording because each looked right in isolation.
  //
  // Sorting by LIFT is degenerate, and the algebra says so plainly:
  //     lift = activePerWk - basePerWk = (0.922 - 1)*base + 0.402*lead = -0.078*base + 0.402*lead
  // The coefficient on the backup's OWN value is NEGATIVE, so ranking by lift maximises the lead's
  // quality while minimising the backup's -- it returns the worst player behind the best starter.
  // On the live board that put Sione Vaki (projects 11.2) above Isiah Pacheco (63.9) behind the same
  // back, when Pacheco is plainly the better stash: 12.5 if-out against 9.6. `expectedPts` is
  // lift x missProb x weeks and inherits exactly the same defect.
  //
  // The earlier objection to this sort -- that it surfaces players who are already starters -- was a
  // real observation with the wrong cause. Kenneth Walker topped the list because the DEPTH-CHART
  // ordering had wrongly cast him as a backup, not because the sort was wrong. Fixing the ordering
  // fixed the symptom; changing the sort would have traded one bad list for another.
  return out.sort((a, b) => b.activePerWk - a.activePerWk);
}
