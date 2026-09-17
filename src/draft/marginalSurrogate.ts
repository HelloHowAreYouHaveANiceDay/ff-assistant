/**
 * A LEARNED SURROGATE for the SIMULATED roster marginal (M2i, 2026-09-16). NOTHING HERE SHIPS.
 *
 * WHY. Track G (docs/validation.md, TRACK G) closed V3's third rejection by naming the residual:
 * `lineupMarginal.ts`'s analytic marginal gets the ORDER wrong exactly where a draft is decided --
 * rank correlation with the simulated marginal 0.68 on an empty roster, -0.29 after six buys, -0.51
 * after nine, -0.10 across the 37-60 rank band. A monotone calibration is incapable of fixing an
 * ordering, which is why Track G's fitted level correction was worth +0.28pp. The remaining idea is
 * structural: LEARN the simulated marginal, from roster-state features, with a model whose serve cost
 * is a dot product rather than fifteen thousand season simulations.
 *
 * D10 IS SATISFIED. A fixed-weight MLP evaluated here is deterministic TypeScript -- the same inputs
 * give the same bid on every machine, forever. There is no LLM and no randomness at serve.
 *
 * THE CONTRACT IS THE PROJECTOR'S (src/model/projector.ts), deliberately, because it is the one
 * pattern in this repo that has already survived a producer/consumer drift audit:
 *
 *   - a PUBLISHED DICTIONARY of feature names (`SURROGATE_FEATURE_FIELDS`). An artifact naming
 *     anything else, or naming them in a different order, is REFUSED rather than silently misread.
 *     A weight vector applied to a permuted design matrix is a model that scores plausibly and means
 *     nothing, and nothing else would notice.
 *   - ONE feature builder (`surrogateFeatures`) called by the LABEL HARNESS and by the SERVE PATH.
 *     Two builders is the producer-writes-its-own-validator shape: the harness drifts from the bidder
 *     and then reports the drift as agreement.
 *   - a GOLDEN BLOCK carrying scikit-learn's OWN predictions for fixture rows, checked at load. The
 *     walker is checked against the PRODUCER, not against a second walker.
 */

/**
 * THE PUBLISHED DICTIONARY, in evaluation order. `surrogateFeatures` emits exactly this, in exactly
 * this order; `assertFeatureContract` refuses any artifact that says otherwise.
 *
 * BYES ARE ABSENT AND THAT IS SAID RATHER THAN HIDDEN. The historical points table carries no bye
 * week (the same limitation `buildV3Config`'s header states), so every state in the M2i label set was
 * built with `bye = null` on BOTH books. The bye-collision term is therefore untested by M2i, and a
 * bye feature here would be a constant -- dead weight that reads like a modelled quantity.
 */
export const SURROGATE_FEATURE_FIELDS = [
  // ---- THE STATE: our money, our slots, our roster, the room ----
  "budget_share", "budget_log", "open_slots", "dollars_per_open_slot",
  "open_qb", "open_rb", "open_wr", "open_te", "open_flex", "open_dst", "open_k", "open_be",
  "roster_n", "phase",
  "held_qb", "held_rb", "held_wr", "held_te", "held_dst", "held_k",
  "starter1_qb", "starter1_rb", "starter1_wr", "starter1_te",
  "starter2_rb", "starter2_wr",
  "roster_proj_sum", "pool_n", "league_dollars", "league_open_slots", "market_tightness",
  "opp_roster_proj_mean",
  // ---- THE CANDIDATE ----
  "is_qb", "is_rb", "is_wr", "is_te", "is_k", "is_dst",
  "cand_proj", "cand_pos_rank_log", "cand_vor_rank_log", "cand_vor", "cand_price",
  "cand_open_at_pos", "cand_upgrade", "cand_over_repl", "cand_held_at_pos",
  "cand_sd", "cand_avail",
  // ---- THE ANALYTIC SURROGATE'S OWN ANSWER, as an input rather than as the answer ----
  // It is free at serve time (V3 computes it to decide anything at all), it carries real ORDER signal
  // in the 1-12 band (rho 0.53), and an MLP over it plus the state is exactly the NON-monotone
  // correction a calibration could not express. Reported as part of the feature set rather than
  // buried: if the learned book beats the analytic one it is partly by re-ordering its own input.
  "ana_points", "ana_dollars", "ana_dollars_share",
] as const;
export type SurrogateFeature = typeof SURROGATE_FEATURE_FIELDS[number];

/** Our seat at one decision point, in the vocabulary the label harness already speaks. */
export interface SurrogateState {
  budget: number;
  leagueBudget: number;
  /** Open slot KEYS in the league's own vocabulary ("QB", "FLEX", "BE", ...). */
  openSlots: string[];
  /** What we already hold. */
  roster: { name: string; pos: string; proj: number }[];
  poolSize: number;
  leagueDollars: number;
  leagueOpenSlots: number;
  /** Mean of the opponents' rostered projection totals -- how strong the room already is. */
  oppRosterProjMean: number;
  /** The league's roster template length, for `phase`. */
  slotsPerTeam: number;
}

/** The man being priced, with everything about him the state does not already carry. */
export interface SurrogateCandidate {
  name: string;
  pos: string;
  proj: number;
  /** His rank within his own position in the REMAINING pool (1-based). */
  posRank: number;
  /** His rank in the candidate set by VOR (1-based) -- the band Track G reports on. */
  vorRank: number;
  vor: number;
  /** What the market would charge for him. */
  price: number;
  /** Predictive log-sd at his rank band (sim.ts OUR_SD_BAND). */
  sd: number;
  /** Share of weeks he is expected available (the variance model's tier). */
  avail: number;
  /** V3's OWN analytic answer for this man in this state, read through `V3Config.onDetail` -- never
   *  recomputed here. */
  anaPoints: number;
  anaDollars: number;
}

/** Per-league constants the features need and the state does not carry. */
export interface SurrogateEnv {
  /** Per-WEEK streaming floor by position. */
  replacement: Record<string, number>;
  /** NFL weeks a season total is spread over (17). */
  nflWeeks: number;
  flexOk: readonly string[];
}

const FLEXLIKE = /^(FLEX|OP|RB\/WR|WR\/TE|SUPERFLEX)$/i;
const BENCHLIKE = /^(BE|BENCH|IR|ER)$/i;

/**
 * THE ONE FEATURE BUILDER. Called by `scripts/marginal-surrogate-data.mjs` to label and by the serve
 * path to predict, so the two cannot disagree about what column 17 means.
 *
 * Every scale here is a STATED constant, not a fitted one: the standardiser lives in the artifact
 * (`xMean`/`xScale`), fitted on the training seasons only. Dividing by 100 here is only so a reader
 * of a raw feature row sees numbers of order 1.
 */
export function surrogateFeatures(st: SurrogateState, c: SurrogateCandidate, env: SurrogateEnv): number[] {
  const openCount = (pred: (s: string) => boolean): number => st.openSlots.filter(pred).length;
  const held: Record<string, number> = {};
  const bestAt: Record<string, number[]> = {};
  let rosterProj = 0;
  for (const p of st.roster) {
    held[p.pos] = (held[p.pos] ?? 0) + 1;
    (bestAt[p.pos] ??= []).push(p.proj);
    rosterProj += p.proj;
  }
  for (const k of Object.keys(bestAt)) bestAt[k].sort((a, b) => b - a);
  const nth = (pos: string, i: number): number => (bestAt[pos]?.[i] ?? 0) / 100;

  const openSlots = st.openSlots.length;
  const canStart = (pos: string) => st.openSlots.filter((s) => s === pos
    || (FLEXLIKE.test(s) && env.flexOk.includes(pos))).length;

  const f: Record<SurrogateFeature, number> = {
    budget_share: st.budget / Math.max(1, st.leagueBudget),
    budget_log: Math.log1p(Math.max(0, st.budget)),
    open_slots: openSlots,
    dollars_per_open_slot: st.budget / Math.max(1, openSlots),
    open_qb: openCount((s) => s === "QB"),
    open_rb: openCount((s) => s === "RB"),
    open_wr: openCount((s) => s === "WR"),
    open_te: openCount((s) => s === "TE"),
    open_flex: openCount((s) => FLEXLIKE.test(s)),
    open_dst: openCount((s) => s === "DST" || s === "D/ST"),
    open_k: openCount((s) => s === "K"),
    open_be: openCount((s) => BENCHLIKE.test(s)),
    roster_n: st.roster.length,
    phase: st.roster.length / Math.max(1, st.slotsPerTeam),
    held_qb: held.QB ?? 0,
    held_rb: held.RB ?? 0,
    held_wr: held.WR ?? 0,
    held_te: held.TE ?? 0,
    held_dst: held.DST ?? 0,
    held_k: held.K ?? 0,
    starter1_qb: nth("QB", 0),
    starter1_rb: nth("RB", 0),
    starter1_wr: nth("WR", 0),
    starter1_te: nth("TE", 0),
    starter2_rb: nth("RB", 1),
    starter2_wr: nth("WR", 1),
    roster_proj_sum: rosterProj / 1000,
    pool_n: st.poolSize / 500,
    league_dollars: st.leagueDollars / 3200,
    league_open_slots: st.leagueOpenSlots / 192,
    market_tightness: st.leagueDollars / Math.max(1, st.leagueOpenSlots),
    opp_roster_proj_mean: st.oppRosterProjMean / 1000,
    is_qb: c.pos === "QB" ? 1 : 0,
    is_rb: c.pos === "RB" ? 1 : 0,
    is_wr: c.pos === "WR" ? 1 : 0,
    is_te: c.pos === "TE" ? 1 : 0,
    is_k: c.pos === "K" ? 1 : 0,
    is_dst: c.pos === "DST" ? 1 : 0,
    cand_proj: c.proj / 100,
    cand_pos_rank_log: Math.log1p(Math.max(0, c.posRank)),
    cand_vor_rank_log: Math.log1p(Math.max(0, c.vorRank)),
    cand_vor: c.vor / 100,
    cand_price: c.price / 100,
    cand_open_at_pos: canStart(c.pos),
    cand_upgrade: (c.proj - (bestAt[c.pos]?.[0] ?? 0)) / 100,
    cand_over_repl: c.proj / env.nflWeeks - (env.replacement[c.pos] ?? 0),
    cand_held_at_pos: held[c.pos] ?? 0,
    cand_sd: c.sd,
    cand_avail: c.avail,
    ana_points: c.anaPoints,
    ana_dollars: c.anaDollars / 100,
    ana_dollars_share: c.anaDollars / Math.max(1, st.budget),
  };
  return SURROGATE_FEATURE_FIELDS.map((k) => {
    const v = f[k];
    // A NaN reaching the dot product produces a NaN bid, which the auction would read as "no bid" --
    // a silent refusal. Refuse loudly instead; every one of these is computable from the inputs.
    if (!Number.isFinite(v)) throw new Error(`marginal surrogate: feature '${k}' is not finite for ${c.name}`);
    return v;
  });
}

// ---------------------------------------------------------------------------------------------
// THE ARTIFACT

export interface DenseLayer {
  /** w[i][j] -- input i to unit j, exactly scikit-learn's `coefs_[l]` orientation. */
  w: number[][];
  b: number[];
}

export interface SurrogateGoldenRow {
  /** RAW (un-standardised) feature row, in `SURROGATE_FEATURE_FIELDS` order. */
  x: number[];
  /** scikit-learn's OWN `predict()` output for that row, in the TARGET's own units. */
  y: number;
}

export interface MarginalSurrogateArtifact {
  schema: 1;
  kind: "marginal-surrogate";
  createdAt: string;
  notes?: string;
  /** WHAT THE TARGET IS, named on the artifact so a reader never has to guess which quantity a
   *  number is in. M2i's is the simulated marginal in PERCENTAGE POINTS of P(playoffs). */
  target: "playoffs_pp";
  features: string[];
  xMean: number[];
  xScale: number[];
  yMean: number;
  yScale: number;
  activation: "relu" | "tanh" | "logistic" | "identity";
  layers: DenseLayer[];
  golden: SurrogateGoldenRow[];
  /** Whatever the trainer wants a reader to see -- fold sizes, held-out scores. Never read by code. */
  meta?: Record<string, unknown>;
}

const act = (kind: MarginalSurrogateArtifact["activation"], z: number): number => {
  switch (kind) {
    case "relu": return z > 0 ? z : 0;
    case "tanh": return Math.tanh(z);
    case "logistic": return 1 / (1 + Math.exp(-z));
    case "identity": return z;
  }
};

/**
 * scikit-learn's `MLPRegressor.predict` in a dot product.
 *
 * `x` is the RAW feature row. Standardisation, the hidden stack (activation on every layer but the
 * last), the linear output and the target un-standardisation all happen here, because all four are
 * part of what the trainer fitted and splitting them across two files is how one of them goes
 * missing.
 */
export function predictSurrogate(a: MarginalSurrogateArtifact, x: readonly number[]): number {
  if (x.length !== a.features.length) {
    throw new Error(`marginal surrogate: ${x.length} features supplied, artifact wants ${a.features.length}`);
  }
  let h = x.map((v, i) => (v - a.xMean[i]) / (a.xScale[i] || 1));
  for (let l = 0; l < a.layers.length; l++) {
    const { w, b } = a.layers[l];
    const out = b.slice();
    for (let i = 0; i < h.length; i++) {
      const row = w[i];
      const hi = h[i];
      if (hi === 0) continue;
      for (let j = 0; j < out.length; j++) out[j] += hi * row[j];
    }
    h = l === a.layers.length - 1 ? out : out.map((z) => act(a.activation, z));
  }
  return h[0] * a.yScale + a.yMean;
}

function bad(msg: string): never {
  throw new Error(`marginal surrogate artifact: ${msg}`);
}

/** The contract check that a name-keyed design matrix cannot pass by accident. */
export function assertFeatureContract(a: MarginalSurrogateArtifact): void {
  if (!Array.isArray(a.features)) bad("no feature list");
  if (a.features.length !== SURROGATE_FEATURE_FIELDS.length) {
    bad(`artifact has ${a.features.length} features, this build publishes ${SURROGATE_FEATURE_FIELDS.length}`);
  }
  for (const [i, n] of a.features.entries()) {
    if (n !== SURROGATE_FEATURE_FIELDS[i]) {
      bad(`feature ${i} is '${n}', this build publishes '${SURROGATE_FEATURE_FIELDS[i]}' -- a permuted design matrix scores plausibly and means nothing`);
    }
  }
}

/**
 * Load, validate, and CHECK AGAINST THE PRODUCER.
 *
 * The golden rows carry scikit-learn's own `predict()` output, so a walker that disagrees with the
 * trainer fails here rather than in a backtest six hours later. `tol` is 1e-6, the projector's.
 */
export function loadMarginalSurrogate(json: unknown, opts: { tol?: number; checkGolden?: boolean } = {}): MarginalSurrogateArtifact {
  const a = json as MarginalSurrogateArtifact;
  if (!a || typeof a !== "object") bad("not an object");
  if (a.schema !== 1) bad(`unknown schema ${JSON.stringify(a.schema)}`);
  if (a.kind !== "marginal-surrogate") bad(`kind is ${JSON.stringify(a.kind)}`);
  if (a.target !== "playoffs_pp") bad(`unknown target ${JSON.stringify(a.target)} -- the units of the answer are not optional`);
  assertFeatureContract(a);
  const n = a.features.length;
  if (!Array.isArray(a.xMean) || a.xMean.length !== n) bad("xMean does not match the feature list");
  if (!Array.isArray(a.xScale) || a.xScale.length !== n) bad("xScale does not match the feature list");
  if (a.xScale.some((s) => !Number.isFinite(s))) bad("xScale has a non-finite entry");
  if (!Number.isFinite(a.yMean) || !Number.isFinite(a.yScale)) bad("yMean/yScale are not finite");
  if (!["relu", "tanh", "logistic", "identity"].includes(a.activation)) bad(`unknown activation ${JSON.stringify(a.activation)}`);
  if (!Array.isArray(a.layers) || !a.layers.length) bad("no layers -- an empty stack is a constant wearing a learner's name");
  let width = n;
  for (const [l, layer] of a.layers.entries()) {
    if (!Array.isArray(layer.w) || layer.w.length !== width) bad(`layer ${l} expects ${width} inputs, has ${layer.w?.length}`);
    const units = layer.b?.length;
    if (!Array.isArray(layer.b) || !units) bad(`layer ${l} has no bias vector`);
    for (const [i, row] of layer.w.entries()) {
      if (!Array.isArray(row) || row.length !== units) bad(`layer ${l} row ${i} has ${row?.length} weights, bias has ${units}`);
      if (row.some((v) => !Number.isFinite(v))) bad(`layer ${l} row ${i} has a non-finite weight`);
    }
    width = units;
  }
  if (width !== 1) bad(`the output layer has ${width} units -- the surrogate answers one number`);
  if (opts.checkGolden !== false) checkSurrogateGolden(a, opts.tol ?? 1e-6);
  return a;
}

/** The golden block, against the walker. Exported so a test can call it on a mutated artifact and
 *  prove the check can FAIL -- a golden check nobody has seen fail is a golden check nobody has. */
export function checkSurrogateGolden(a: MarginalSurrogateArtifact, tol = 1e-6): void {
  if (!Array.isArray(a.golden) || !a.golden.length) bad("no golden rows -- the walker would be unchecked against its own trainer");
  for (const [i, g] of a.golden.entries()) {
    const got = predictSurrogate(a, g.x);
    if (!Number.isFinite(got) || Math.abs(got - g.y) > tol) {
      bad(`golden row ${i} -- the trainer said ${g.y}, this walker says ${got} (tol ${tol})`);
    }
  }
}
