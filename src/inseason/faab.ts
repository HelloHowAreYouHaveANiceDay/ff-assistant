/**
 * THE FAAB BID MODEL, read side. The trainer is `tools/train_faab.py`; this file is the evaluator
 * the copilot calls, and the two are held together by a golden block rather than by good intentions.
 *
 * WHAT IT ANSWERS, and they are two different questions:
 *
 *   clearingPrice(m, row)        what does this room PAY for a man like this, in this week, with
 *                                this much money left? Fitted on 576 winning bids, 2018-2025.
 *   pWin(m, row, bid)            would $B have beaten the field? Fitted on 630 win/loss outcomes,
 *                                2019-2025 -- ESPN publishes the LOSING bid, so this is measured
 *                                rather than inferred from the clearing price plus a margin.
 *   bidForWinProb(m, row, p)     the smallest whole dollar whose modelled P(win) reaches p.
 *
 * THE CAVEAT THAT TRAVELS WITH EVERY RECOMMENDED BID, and the artifact carries it as a field rather
 * than a comment. Resampled over SEASONS -- the unit of analysis here, as everywhere in this repo --
 * the `log_bid` coefficient's interval crosses zero. Two things make it so, and both are real:
 * roughly four claims in five in this room are UNCONTESTED, so most wins cost a dollar and tell you
 * nothing about what money buys; and a manager who bids big is a manager who already knew the player
 * was contested, which biases the observed effect of money DOWNWARD. So a recommended bid is a point
 * estimate the data cannot cleanly separate from "the bid does not matter much", and `recommendBid`
 * returns `bidEffectSignificant` so the caller can say that out loud instead of implying a precision
 * the fit does not have. That is still strictly more than the rule of thumb it replaces, which had
 * no interval at all because it was never fitted on anything.
 *
 * THE ARITHMETIC IS MIRRORED, DELIBERATELY. `predict_price` / `predict_win` / `bid_for` in the
 * trainer and `clearingPrice` / `pWin` / `bidForWinProb` here are the same three formulas written
 * twice, which is not duplication to be refactored away -- it is what makes `checkGolden` mean
 * anything. The golden block holds the TRAINER'S OWN outputs for five fixture rows, and the
 * contract test recomputes them here at 1e-6.
 */
import { existsSync, readFileSync } from "node:fs";

export const FAAB_ARTIFACT_PATH = process.env.FF_FAAB_MODEL ?? "data/faab-model.json";

export interface FeatureSpec { name: string; center: number; scale: number; missing: number }
export interface LinearHead { intercept: number; coef: Record<string, number> }

export interface FaabModel {
  kind: string;
  version: number;
  builtAt: string;
  trainedOn: {
    priceSeasons: number[]; winSeasons: number[];
    priceRows: number; winRows: number; baseWinRate: number;
  };
  /** The PUBLISHED input list. `scripts/faab-leakage.mjs` G5 reads this and fails if a target
   *  column appears in it -- checking emitted names against the contract, not against a symptom. */
  features: string[];
  priceFeatures: FeatureSpec[];
  winFeatures: FeatureSpec[];
  clamps: { lo: number; hi: number };
  rankWhenUnranked: number;
  price: LinearHead & { smear: number };
  win: LinearHead;
  loso: Record<string, number>;
  bidEffect: { coef: number; ci: [number, number] | null; significant: boolean; note: string };
  controls: Record<string, number>;
  bootstrap: Record<string, unknown>;
  golden: GoldenRow[];
}

export interface GoldenRow {
  pos: string; week: number; budget: number;
  f: Record<string, number | null>;
  price: number;
  pWinAt: Record<string, number>;
  bidAt70: number | null;
}

/** One claim as the model sees it. `f` is the raw feature dict; `budget` caps the price. */
export interface FaabRow { budget: number; f: Record<string, number | null | undefined> }

export const FAAB_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

/**
 * A copilot-side candidate turned into the trainer's feature dict.
 *
 * Mirrors `features_of` in tools/train_faab.py. An unranked player reads the artifact's own
 * `rankWhenUnranked`, not a constant retyped here: the two would drift on the first retrain and
 * nothing would fail.
 */
export function featureRow(m: FaabModel, x: {
  pos: string; week: number;
  posLineRank?: number | null; seasonLinePg?: number | null;
  tdPpg?: number | null; priorPts?: number | null;
  teamFaabShare?: number | null; leagueFaabShare?: number | null;
  teamsNeedPos?: number | null; teamsCounted?: number | null;
}): Record<string, number | null> {
  const f: Record<string, number | null> = {
    log_rank: Math.log(x.posLineRank && x.posLineRank > 0 ? x.posLineRank : m.rankWhenUnranked),
    line_pg: x.seasonLinePg ?? null,
    td_ppg: x.tdPpg ?? null,
    prior_pts: x.priorPts ?? null,
    week: x.week,
    team_faab_share: x.teamFaabShare ?? null,
    league_faab_share: x.leagueFaabShare ?? null,
    need_share: x.teamsCounted ? (x.teamsNeedPos ?? 0) / x.teamsCounted : null,
  };
  for (const p of FAAB_POSITIONS) f[`pos_${p}`] = x.pos === p ? 1 : 0;
  return f;
}

const std = (s: FeatureSpec, v: number | null | undefined): number =>
  v == null ? s.missing : (v - s.center) / s.scale;

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** What this room pays for a man like this. Mirrors `predict_price`. */
export function clearingPrice(m: FaabModel, row: FaabRow): number {
  let t = m.price.intercept;
  for (const s of m.priceFeatures) t += (m.price.coef[s.name] ?? 0) * std(s, row.f[s.name]);
  const d = Math.expm1(clamp(t, -20, 20)) * m.price.smear;
  return clamp(d, m.clamps.lo, row.budget);
}

/** The part of the win logit that does NOT involve the bid, and the bid's own spec. */
function winParts(m: FaabModel, row: FaabRow): { rest: number; spec: FeatureSpec } {
  let t = m.win.intercept;
  let spec: FeatureSpec | null = null;
  for (const s of m.winFeatures) {
    if (s.name === "log_bid") { spec = s; continue; }
    t += (m.win.coef[s.name] ?? 0) * std(s, row.f[s.name]);
  }
  if (!spec) throw new Error("the FAAB artifact has no log_bid spec -- it cannot price a bid");
  return { rest: t, spec };
}

/** P(this bid beats the field). Mirrors `predict_win`. */
export function pWin(m: FaabModel, row: FaabRow, bid: number): number {
  const { rest, spec } = winParts(m, row);
  const z = clamp(rest + m.win.coef.log_bid * ((Math.log1p(bid) - spec.center) / spec.scale), -40, 40);
  return 1 / (1 + Math.exp(-z));
}

/**
 * The smallest whole-dollar bid whose modelled P(win) reaches `target`, or null when money cannot
 * get there at all. Mirrors `bid_for` -- closed form, because the logit is linear in the
 * standardised log bid, and a search here would let the two languages drift.
 */
export function bidForWinProb(m: FaabModel, row: FaabRow, target: number): number | null {
  const b = m.win.coef.log_bid;
  if (!(b > 1e-9)) return null;
  const { rest, spec } = winParts(m, row);
  const t = clamp(target, 1e-6, 1 - 1e-6);
  const need = (Math.log(t / (1 - t)) - rest) / b;
  const dollars = Math.expm1(need * spec.scale + spec.center);
  return Math.max(1, Math.ceil(dollars - 1e-9));
}

export interface BidAdvice {
  /** What to bid, capped at the budget. NEVER silently capped: `overBudget` says when it was. */
  bid: number;
  /** The raw solve before any cap -- what the target would actually cost. */
  wanted: number | null;
  targetWinPct: number;
  /** P(win) at the bid we are actually recommending, which is not the target when it was capped. */
  winPctAtBid: number;
  clearingPrice: number;
  /** P(win) at three levels, so a reader can see the curve rather than one point on it. */
  curve: { bid: number; winPct: number }[];
  /** The target is unreachable inside the budget -- the row must SAY so, not quietly ask for less. */
  overBudget: boolean;
  /** True only when a bid larger than our remaining FAAB was required. */
  overRemaining: boolean;
  remaining: number | null;
  bidEffectSignificant: boolean;
  note: string;
}

/**
 * The copilot's answer for one waiver target.
 *
 * A recommendation above the budget is FLAGGED, not capped in silence. Capping quietly turns "this
 * costs more than you have" into "bid your last dollar", which reads as advice and is a different
 * claim entirely -- and it is the exact shape of failure this repo keeps finding: a refusal that
 * looks like a result.
 */
export function recommendBid(
  m: FaabModel, row: FaabRow,
  o: { target?: number; remaining?: number | null } = {},
): BidAdvice {
  const target = o.target ?? 0.7;
  const remaining = o.remaining ?? null;
  const wanted = bidForWinProb(m, row, target);
  const cap = Math.min(row.budget, remaining ?? row.budget);
  const bid = wanted == null ? Math.max(1, Math.round(clearingPrice(m, row))) : Math.min(wanted, cap);
  const levels = [...new Set([1, Math.max(1, Math.round(clearingPrice(m, row))), Math.min(cap, bid)])]
    .sort((a, b) => a - b);
  return {
    bid,
    wanted,
    targetWinPct: Math.round(target * 1000) / 10,
    winPctAtBid: Math.round(pWin(m, row, bid) * 1000) / 10,
    clearingPrice: Math.round(clearingPrice(m, row) * 100) / 100,
    curve: levels.map((b) => ({ bid: b, winPct: Math.round(pWin(m, row, b) * 1000) / 10 })),
    overBudget: wanted != null && wanted > row.budget,
    overRemaining: wanted != null && remaining != null && wanted > remaining,
    remaining,
    bidEffectSignificant: m.bidEffect.significant,
    note: m.bidEffect.note,
  };
}

export function loadFaabModel(path: string = FAAB_ARTIFACT_PATH): FaabModel | null {
  if (!existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, "utf8")) as FaabModel;
  if (m.kind !== "faab-bid") throw new Error(`${path} is not a FAAB artifact (kind=${m.kind})`);
  if (!m.priceFeatures?.length || !m.winFeatures?.length) throw new Error(`${path} carries no feature specs`);
  return m;
}

/** Recompute the trainer's own predictions here and report the worst disagreement. */
export function checkGolden(m: FaabModel): { rows: number; worst: number; where: string } {
  let worst = 0, where = "";
  for (const g of m.golden) {
    const row: FaabRow = { budget: g.budget, f: g.f };
    const probe: [string, number, number][] = [["price", clearingPrice(m, row), g.price]];
    for (const [b, want] of Object.entries(g.pWinAt)) probe.push([`pWin@${b}`, pWin(m, row, Number(b)), want]);
    if (g.bidAt70 != null) probe.push(["bid@0.70", bidForWinProb(m, row, 0.7) ?? NaN, g.bidAt70]);
    for (const [what, got, want] of probe) {
      const d = Math.abs(got - want);
      if (d > worst) { worst = d; where = `${g.pos} w${g.week} ${what}: ts ${got} vs py ${want}`; }
    }
  }
  return { rows: m.golden.length, worst, where };
}
