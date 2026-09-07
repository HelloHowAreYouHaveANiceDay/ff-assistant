/**
 * A real fantasy regular-season schedule, with standard divisional play.
 *
 * WHAT THIS REPLACES. backtest.ts reshuffled the whole field every week, so each team's opponent was
 * an independent uniform draw. That is unbiased in expectation -- everyone's average opponent is the
 * league mean -- but it gets two things structurally wrong:
 *
 *   1. NO REPEAT CAP. Random pairing can hand you the best roster in the league four times and the
 *      worst never. A real schedule caps any opponent at two meetings.
 *   2. NO CORRELATED SCHEDULE RISK. In a real league a hard draw PERSISTS: you play your three
 *      division rivals twice each, so a strong division is a season-long tax and a weak one a
 *      season-long subsidy. Independent weekly draws wash that out entirely, which means the
 *      backtest could not see schedule luck as a source of variance at all.
 *
 * THE STANDARD FORMAT, for 16 teams / 4 divisions / 14 weeks:
 *   - 6 weeks in-division: a double round-robin against your 3 rivals.
 *   - 8 weeks cross-division: every team of two OTHER divisions, once each.
 *   - the third other division goes unplayed -- an unavoidable consequence of 14 weeks and 15
 *     possible opponents, not a defect.
 *
 * That is exactly the pattern this league's well-formed divisions follow, verified against ESPN
 * 2026-09-07 (two of its four divisions are misconfigured and play only 5 internal games; we model
 * the CORRECT format, not that bug).
 */

/** One week: a perfect matching over all teams, as [teamA, teamB] pairs. */
export type Week = [number, number][];

/** Round-robin rounds for one 4-team division: 3 rounds covering all 6 pairings exactly once. */
function quadRounds(t: number[]): Week[] {
  return [
    [[t[0], t[1]], [t[2], t[3]]],
    [[t[0], t[2]], [t[3], t[1]]],
    [[t[0], t[3]], [t[1], t[2]]],
  ];
}

/** 4 rounds pairing every member of `a` with every member of `b` exactly once. */
function crossRounds(a: number[], b: number[]): Week[] {
  const out: Week[] = [];
  for (let r = 0; r < a.length; r++) {
    out.push(a.map((x, i) => [x, b[(i + r) % b.length]] as [number, number]));
  }
  return out;
}

/** Circle-method round-robin for an even team count -- the fallback when divisions do not apply. */
function circle(teams: number): Week[] {
  const ids = [...Array(teams).keys()];
  const fixed = ids[0], rot = ids.slice(1);
  const out: Week[] = [];
  for (let r = 0; r < teams - 1; r++) {
    const wk: Week = [[fixed, rot[0]]];
    for (let i = 1; i < rot.length / 2 + 0.5; i++) {
      const a = rot[i], b = rot[rot.length - i];
      if (a != null && b != null && a !== b) wk.push([a, b]);
    }
    out.push(wk);
    rot.unshift(rot.pop()!);
  }
  return out;
}

/**
 * Build `weeks` weeks of schedule for `teams` teams split into `divisions` equal divisions.
 *
 * Falls back to a plain round-robin (repeating if `weeks` exceeds a full cycle) whenever the
 * divisional format does not divide evenly -- an odd team count, a division size other than 4, or
 * a league with no divisions. Callers get a valid schedule either way; `divisional` says which.
 */
export function buildSchedule(teams: number, weeks: number, divisions = 0): { weeks: Week[]; divisional: boolean; divisionOf: number[] } {
  const divisionOf = new Array(teams).fill(0);
  const size = divisions > 0 ? teams / divisions : 0;
  const canDivide = divisions === 4 && Number.isInteger(size) && size === 4 && teams === 16;

  if (canDivide) {
    const divs: number[][] = [];
    for (let d = 0; d < divisions; d++) {
      const members = [];
      for (let i = 0; i < size; i++) { const t = d * size + i; members.push(t); divisionOf[t] = d; }
      divs.push(members);
    }
    const out: Week[] = [];
    // 6 in-division weeks: all four divisions play their internal round-robin simultaneously, twice.
    for (let pass = 0; pass < 2; pass++) {
      const rounds = divs.map((d) => quadRounds(d));
      for (let r = 0; r < 3; r++) out.push(rounds.flatMap((x) => x[r]));
    }
    // 8 cross-division weeks: (D0 v D1, D2 v D3) then (D0 v D2, D1 v D3). D0-D3 and D1-D2 go unplayed.
    const pairA = crossRounds(divs[0], divs[1]), pairB = crossRounds(divs[2], divs[3]);
    for (let r = 0; r < 4; r++) out.push([...pairA[r], ...pairB[r]]);
    const pairC = crossRounds(divs[0], divs[2]), pairD = crossRounds(divs[1], divs[3]);
    for (let r = 0; r < 4; r++) out.push([...pairC[r], ...pairD[r]]);
    return { weeks: out.slice(0, weeks), divisional: true, divisionOf };
  }

  const base = circle(teams % 2 === 0 ? teams : teams + 1);
  const out: Week[] = [];
  for (let w = 0; w < weeks; w++) out.push(base[w % base.length].filter(([a, b]) => a < teams && b < teams));
  return { weeks: out, divisional: false, divisionOf };
}
