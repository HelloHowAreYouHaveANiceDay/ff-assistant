/**
 * THE PRICE MODEL EVALUATOR -- what this room pays, as a function of what the room knows.
 *
 * The counterpart of `tools/train_price.py`, and the same seam as the projection artifact for the
 * same reason: the trainer is Python because a logistic and a ridge want scikit-learn, the engine is
 * TypeScript because it runs inside an Electron app in the middle of a live auction, and a seam
 * between a producer and a consumer is exactly where the two drift apart while both stay green.
 *
 * So the artifact carries a GOLDEN BLOCK -- five fixture rows with the trainer's own predictions --
 * and `loadPriceModel` recomputes them here and REFUSES the artifact if they disagree by more than
 * 1e-6. It is the only test where the two implementations are genuinely independent.
 *
 * THE ARITHMETIC, stated once so both sides can be checked against it:
 *
 *     lin(h)     = rankTable[pos][h][rank] + coef[pos][h] . x
 *     p          = sigmoid(lin(hurdle))                will he go for more than $1?
 *     levelShare = exp(lin(level)) / 1000 * smear      his share of the room's money if he does
 *     share      = p * levelShare + (1 - p) * (1/M)    recombined, so the $1 mass is respected
 *     price      = clamp(share * M, $1, hi * M)
 *
 * M is the ROOM'S MONEY -- teams x budget -- and it enters only at the end. That is what lets a model
 * fitted on three 14-team seasons and one 16-team season price a draft in either: the fit is about
 * shares, and the size of the room is the one thing nobody has to estimate.
 *
 * THE RANK EFFECT IS A TABLE, NOT A POLYNOMIAL, and that is a repair rather than a style choice. A
 * per-position parabola in log rank fitted on 58-253 picks came back non-monotone -- the RB3 above
 * the RB1, the K60 above the K1 -- which inverts the ordering the entire auction expresses while
 * every residual statistic improves. The trainer evaluates the fitted rank terms onto a table over
 * ranks 1..N and repairs it with a cumulative min, exactly as src/data/projections.ts repairs the
 * projection curve, and ships the table. Past its end the last row carries, which is also how an
 * unranked player is priced.
 */

/** THE PUBLISHED DICTIONARY. An artifact naming anything else is REFUSED rather than scored as zero,
 *  which is how a producer and a consumer stay green while disagreeing. */
export const PRICE_FEATURE_FIELDS = [
  "no_consensus", "sd_rel",
  // `infl` is the market-state term that survived measurement: money left per remaining slot,
  // relative to the same ratio at the first pick. Exactly 1 at the start by construction, so it is
  // not mechanically tied to draft progress the way the three below are -- see the note in
  // tools/train_price.py about the RB1 who prices at $101 early and $2.70 late.
  "infl",
  "money_left", "slots_left", "pick_share",
] as const;
export type PriceFeatureField = typeof PRICE_FEATURE_FIELDS[number];

export type PriceHead = "hurdle" | "level";
export const PRICE_HEADS: PriceHead[] = ["hurdle", "level"];

export interface PriceSpec {
  name: PriceFeatureField;
  center: number;
  scale: number;
  /** The POST-standardisation value for a missing input. Required to be explicit. */
  missing: number;
}

export interface PriceArtifact {
  schema: number;
  kind: "price";
  fittedFrom: string;
  fittedAt?: string;
  seasons: number[];
  holdoutSeason: number | null;
  budget: number;
  unrankedRank: number;
  rankTableMax?: number;
  features: PriceSpec[];
  /** pos -> head -> the head's linear predictor at rank 1, 2, 3, ..., monotone non-increasing. */
  rankTable: Record<string, Record<PriceHead, number[]>>;
  coef: Record<string, Record<PriceHead, Record<string, number>>>;
  /** Duan smearing factor for the log retransformation. */
  smear: number;
  alpha?: { hurdle: number; level: number };
  /** `hi` is a SHARE of the room's money, not dollars, so it means the same thing in any league size. */
  clamps: { lo: number; hi: number };
  seasonMeta?: Record<string, { teams: number; picks: number; leagueMoney: number; spent: number }>;
  golden?: PriceGolden[];
  notes?: string;
}

export interface PriceGolden {
  pos: string;
  leagueMoney: number;
  rank: number | null;
  f: Partial<Record<PriceFeatureField, number>>;
  expect: number;
}

/** The market state a bidder can see at the moment a player is nominated. Every field is something
 *  the simulator computes for itself mid-auction -- a price model needing anything else would be a
 *  description of a draft rather than an opponent in one. */
export interface MarketState {
  /** Consensus positional rank. Null = unranked, which is a real and cheap state. */
  ecrPosRank: number | null;
  /** Expert dispersion at that rank, absolute. Null = unknown. */
  ecrSd: number | null;
  /** Share of the room's money still unspent, in [0, 1]. */
  moneyLeft: number;
  /** Share of roster slots still open, in [0, 1]. */
  slotsLeft: number;
  /** How far into the draft this pick is, in [0, 1]. */
  pickShare: number;
  /** The room's total money: teams x budget. */
  leagueMoney: number;
}

export function priceFeatures(m: MarketState): Partial<Record<PriceFeatureField, number>> {
  const ranked = m.ecrPosRank != null && m.ecrPosRank > 0;
  return {
    no_consensus: ranked ? 0 : 1,
    sd_rel: ranked && m.ecrSd != null && m.ecrSd > 0 ? m.ecrSd / m.ecrPosRank! : 0,
    infl: Math.min(5, m.moneyLeft / Math.max(1e-9, m.slotsLeft)),
    money_left: m.moneyLeft,
    slots_left: m.slotsLeft,
    pick_share: m.pickShare,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where a rank reads on the rank table. Unranked and anything past the table's end read its last
 *  row -- the same carry-the-last-value rule the projection curve uses. */
export function rankIndex(a: PriceArtifact, pos: string, rank: number | null): number {
  const n = a.rankTable[pos]?.level.length ?? 0;
  if (!n) return 0;
  if (rank == null || !Number.isFinite(rank) || rank < 1) return n - 1;
  return Math.min(Math.round(rank) - 1, n - 1);
}

/** The evaluator. Pure: no file reads, no clock, no store. */
export function evaluatePrice(a: PriceArtifact, pos: string, rank: number | null, f: Partial<Record<PriceFeatureField, number>>, leagueMoney: number): number {
  const c = a.coef[pos], tab = a.rankTable[pos];
  if (!c || !tab) return a.clamps.lo;
  const x: Record<string, number> = {};
  for (const s of a.features) {
    const v = f[s.name];
    x[s.name] = v == null || !Number.isFinite(v) ? s.missing : (v - s.center) / s.scale;
  }
  const i = rankIndex(a, pos, rank);
  const lin = (h: PriceHead): number => {
    let t = tab[h][i];
    for (const s of a.features) t += (c[h][s.name] ?? 0) * x[s.name];
    return clamp(t, -40, 40);
  };
  const p = 1 / (1 + Math.exp(-lin("hurdle")));
  const levelShare = (Math.exp(lin("level")) / 1000) * a.smear;
  const share = p * levelShare + (1 - p) * (1 / leagueMoney);
  return clamp(share * leagueMoney, a.clamps.lo, a.clamps.hi * leagueMoney);
}

/** The whole path a caller wants: market state in, dollars out. */
export function priceFor(a: PriceArtifact, pos: string, m: MarketState): number {
  return evaluatePrice(a, pos, m.ecrPosRank, priceFeatures(m), m.leagueMoney);
}

const SCHEMA = 1;

/**
 * LOAD AND VALIDATE. An artifact this evaluator cannot FULLY evaluate is refused, loudly.
 *
 * The failures being prevented are the quiet ones: a renamed feature, a missing head or a missing
 * smearing factor all degrade to "that term contributes nothing", which produces a slightly
 * different price and no error at all -- and a price book that is silently 15% low would hand the
 * simulator a room that does not exist while every distribution still looked plausible.
 */
export function loadPriceModel(json: unknown, opts: { checkGolden?: boolean; tol?: number } = {}): PriceArtifact {
  const bad = (m: string): never => { throw new Error(`price model: ${m}`); };
  const a = json as PriceArtifact;
  if (!a || typeof a !== "object") bad("not an object");
  if (a.kind !== "price") bad(`kind is ${JSON.stringify(a.kind)}, expected "price"`);
  if (Number(a.schema) !== SCHEMA) bad(`schema ${a.schema}, this evaluator understands ${SCHEMA}`);
  if (!Array.isArray(a.features) || !a.features.length) bad("no features");
  const known = new Set<string>(PRICE_FEATURE_FIELDS);
  const seen = new Set<string>();
  for (const s of a.features) {
    if (!known.has(s.name)) {
      bad(`feature ${JSON.stringify(s.name)} is not one this evaluator can compute. Known: ` +
        `${[...known].join(", ")}. A renamed feature must be renamed on BOTH sides.`);
    }
    if (seen.has(s.name)) bad(`feature ${s.name} appears twice`);
    seen.add(s.name);
    if (typeof s.center !== "number" || !Number.isFinite(s.center)) bad(`feature ${s.name}: no centre`);
    if (!(Number(s.scale) > 0)) bad(`feature ${s.name}: scale must be positive`);
    if (typeof s.missing !== "number" || !Number.isFinite(s.missing)) bad(`feature ${s.name}: 'missing' must be explicit`);
  }
  if (!a.coef || !Object.keys(a.coef).length) bad("no per-position coefficients");
  if (!a.rankTable || !Object.keys(a.rankTable).length) bad("no rank table -- the rank effect travels as a monotone table, not as coefficients");
  for (const [pos, heads] of Object.entries(a.coef)) {
    const tab = a.rankTable[pos];
    if (!tab) bad(`${pos}: coefficients but no rank table`);
    for (const h of PRICE_HEADS) {
      const c = heads?.[h];
      if (!c) bad(`${pos}: no '${h}' head -- both parts of a hurdle model are required, and a missing one silently prices everybody at the floor`);
      for (const s of a.features) if (typeof c[s.name] !== "number") bad(`${pos}.${h}: no coefficient for '${s.name}'`);
      for (const k of Object.keys(c)) if (!seen.has(k)) bad(`${pos}.${h}: coefficient '${k}' names no declared feature`);
      const t = tab[h];
      if (!Array.isArray(t) || t.length < 10) bad(`${pos}.${h}: rank table is missing or too short`);
      // MONOTONE, checked here rather than trusted. A table that climbs with rank prices a worse
      // player higher, which is the ordering the whole auction expresses, inverted -- and it is
      // exactly what the unrepaired polynomial produced while every residual statistic improved.
      for (let i = 1; i < t.length; i++) {
        if (!(t[i] <= t[i - 1] + 1e-9)) {
          bad(`${pos}.${h}: rank table climbs at rank ${i + 1} (${t[i]} > ${t[i - 1]}). A price book ` +
            `in which a worse-ranked player costs more is not a price book.`);
        }
      }
    }
  }
  if (!(Number(a.smear) > 0)) bad("smear must be positive -- a log fit read back without its retransformation is biased low by construction");
  if (!(Number(a.unrankedRank) > 0)) bad("unrankedRank must be positive");
  if (!a.clamps || !(a.clamps.lo >= 1) || !(a.clamps.hi > 0)) bad("clamps must be a [lo >= 1, hi > 0] pair, hi as a SHARE of the room's money");
  if (opts.checkGolden !== false && a.golden?.length) checkPriceGolden(a, opts.tol ?? 1e-6);
  return a;
}

/** The contract test, carried ON the artifact. See the header. */
export function checkPriceGolden(a: PriceArtifact, tol = 1e-6): void {
  for (const [i, g] of (a.golden ?? []).entries()) {
    const got = evaluatePrice(a, g.pos, g.rank, g.f, g.leagueMoney);
    if (!(Math.abs(got - g.expect) <= tol)) {
      throw new Error(
        `price model: golden row ${i} (${g.pos}) -- trainer said ${g.expect}, this evaluator says ` +
        `${got} (difference ${Math.abs(got - g.expect)}, tolerance ${tol}). The two sides implement ` +
        `the same model differently; do not ship either until they agree.`);
    }
  }
}
