// The tunable LEVERS -- every knob that shapes our values, tiers, and bidding, in ONE typed config
// section so they are visible, editable in the UI, and readable/writable by the assistant.
//
// SINGLE SOURCE OF TRUTH: `LEVER_SPECS` below. Everything else in this file is DERIVED from it
// (`DEFAULT_LEVERS`, `LEVER_META`), and so are the CLI overrides (`leverOverridesFromArgv`) and the
// strategy config (`leversToV2Config`). To add a lever you add ONE entry; nothing else needs editing.
//
// Why this is a registry and not four parallel literals: a lever that is DEFINED but not WIRED reads
// exactly like a lever that does nothing (docs/validation.md, "prove the lever is CONNECTED"), and
// this repo has been bitten by duplicated lever tables twice -- the renderer's "Reset levers" button
// carried a stale copy of the DEFAULTS (aggr 1.0 / reserve 15) that would have silently undone the
// tuning, and `maxKDst` had no backtest flag so the arbiter could not measure it at all. Deriving
// every surface from one array makes both of those unrepresentable.
//
// ADDING A LEVER (the whole checklist):
//   1. add the field to `Levers`
//   2. add one `LEVER_SPECS` entry (the compiler fails until you do -- see the exhaustiveness check)
//   3. consume it in strategy.ts / values.ts (extend `leversToV2Config` if it feeds V2Config)
//   4. prove it CONNECTED: `node scripts/lever-connected.mjs <key> <a> <b>`
//   5. measure it: `npm run ff -- backtest --full --no-lookahead --inflation --<flag> <v>`
// Its CLI flag, UI row, clamping, and reset behaviour all come for free from step 2.

export interface Levers {
  tierBreak: number;        // new positional tier starts when value drops below this fraction of the tier top
  maxKDst: number;          // hard $ cap on K/DST (they stream -- never price them like starters)
  starterReserve: number;   // $ held back for still-unfilled STARTER slots when computing a max bid
  benchReserve: number;     // $ held back per bench slot
  maxShare: number;         // max fraction of the budget to spend on any single player
  aggr: number;             // bidding aggressiveness multiplier (1 = neutral)
  premium: number;          // extra $ willing to pay at the margin to win a targeted player
  sleeperThreshold: number; // min vsECR for a player to count as a SLEEPER (board filter)
  benchDiscount: number;    // value multiplier for a player who can ONLY fill a bench slot
  // Per-position multipliers on OUR value. 1 = trust the VOR book as-is. These correct for the fact
  // that VOR prices a position in isolation, while the ROSTER decides how many startable weeks a
  // dollar there actually buys (1 QB slot vs 4 RB/WR/TE-eligible starting slots).
  // K/DST deliberately have no multiplier: maxKDst hard-caps them at $2, so one could not bind.
  multQB: number;
  multRB: number;
  multWR: number;
  multTE: number;
  // Re-rank the draft board's ORDERING toward the FFToday expert consensus (0 = our projection as-is,
  // 1 = order purely by the consensus where it ranks a player, keeping our own point magnitudes). A
  // BOARD lever: it changes the drafted book, so a rebuild is required. Validated by the CPCV arbiter
  // (~+2.8pp championships; docs/edges.md, docs/redesign/experimentation-redesign.md). Applied to the
  // projection before computeValues, so it does not feed V2Config.
  consensusBlend: number;
}

/** What a lever ACTS ON. Drives grouping in the UI and tells an agent which harness can see it:
 *  `value` and `board` levers change the drafted book (rebuild required), `bidding` applies live. */
export type LeverGroup = "value" | "bidding" | "board";

/** Shipped = measured and in the default config. Experimental = wired and measurable, but not part
 *  of the validated posture; an agent may sweep it freely without claiming it is tuned. */
export type LeverStatus = "shipped" | "experimental";

export interface LeverSpec {
  key: keyof Levers;      // typo-proof: a key not on `Levers` is a compile error
  kind: "number" | "boolean";
  default: number | boolean;
  /** The value at which this lever does NOTHING -- multipliers disable at 1, additive knobs at 0.
   *  Lets an agent (or `--lever-off <key>`) neutralise one knob without knowing its semantics, and
   *  lets the UI badge it "off".
   *
   *  OPTIONAL, because not every lever HAS a no-op setting: `tierBreak` always partitions the board
   *  somehow, `maxKDst` always caps, `maxShare` always bounds concentration, and `sleeperThreshold`
   *  always filters. Inventing an "off" for those would mean writing a value outside the lever's own
   *  legal range, so they simply declare none and `--lever-off` refuses them. */
  off?: number | boolean;
  min?: number;           // numbers only
  max?: number;
  step?: number;
  label: string;
  help: string;
  board: boolean;         // changing it changes the BOARD -> needs a data refresh to take effect
  group: LeverGroup;
  /** CLI flag WITHOUT the leading dashes. Explicit rather than derived from the key, because the
   *  shipped flags are not all plain kebab-case (`maxKDst` -> `max-kdst`, not `max-k-dst`) and
   *  renaming a flag would silently invalidate every command line in the docs and runbook. */
  flag: string;
  status: LeverStatus;
  /** Provenance: what was measured, when, and against which baseline. Kept as DATA so an agent can
   *  read it back (`read_levers`) instead of parsing comments. */
  note?: string;
}

// Defaults = the shipped, holdout-validated posture (2026-09-05): aggr 0.7 / benchDiscount 0.25 /
// starterReserve 4 / maxShare 0.25 / premium 2, all positional multipliers 1.0. ~33% championships
// on 25 scored seasons. Do NOT edit a value here without re-reading docs/validation.md -- several of
// these were measured, rejected, and re-measured, and the reasoning is recorded per lever below.
export const LEVER_SPECS: readonly LeverSpec[] = [
  {
    key: "tierBreak", kind: "number", default: 0.75, min: 0.5, max: 0.95, step: 0.01,
    label: "Tier break", board: true, group: "board", flag: "tier-break", status: "shipped",
    help: "Lower = fewer, bigger tiers (a new tier starts at a steeper value drop).",
  },
  {
    key: "maxKDst", kind: "number", default: 2, min: 1, max: 10, step: 1,
    label: "Max K/DST $", board: true, group: "value", flag: "max-kdst", status: "shipped",
    help: "Hard cap on kicker/defense price -- they stream.",
    note: "Defence in depth: the value table's own $2 clamp is keyed by name, and live ESPN shows "
      + "'Texans D/ST' where our table stores 'HOU D/ST', so the lookup can miss (F3).",
  },
  {
    key: "starterReserve", kind: "number", default: 4, off: 0, min: 0, max: 60, step: 1,
    label: "Starter reserve $", board: false, group: "bidding", flag: "starter-reserve", status: "shipped",
    help: "Budget held back for unfilled starting slots when bidding.",
  },
  {
    key: "benchReserve", kind: "number", default: 1, off: 0, min: 0, max: 10, step: 1,
    label: "Bench reserve $", board: false, group: "bidding", flag: "bench-reserve", status: "shipped",
    help: "Budget held back per bench slot ($1 each keeps you legal).",
  },
  {
    key: "maxShare", kind: "number", default: 0.25, min: 0.1, max: 0.7, step: 0.01,
    label: "Max share", board: false, group: "bidding", flag: "max-share", status: "shipped",
    help: "Ceiling on the fraction of budget spent on one player.",
    note: "Concentration cap -- stops the stars-and-scrubs failure where 3 studs eat the budget and "
      + "the tail cannot fill.",
  },
  {
    key: "aggr", kind: "number", default: 0.7, off: 1, min: 0.5, max: 2, step: 0.05,
    label: "Aggressiveness", board: false, group: "bidding", flag: "aggr", status: "shipped",
    help: "Bidding multiplier: >1 chases, <1 waits for value.",
    // The WINNER'S CURSE correction. Drafting is a common-value auction on noisy estimates, so the
    // winner is disproportionately whoever OVERestimated; shading offsets it. Verified to build a
    // genuinely better team, not merely a cheaper one (+53.5 starting-lineup points, 82% -> 92% of
    // the field outscored, at the SAME spend -- scripts/roster-strength.mjs).
    //
    // Chosen by MINIMAX over two opponent models, because the optimum depends on whose book the bots
    // bid and we cannot know which is right (25 seasons, n=150):
    //     aggr                    0.6    0.65   0.7    1.0
    //     vor book (mirror)      32.9   33.3   34.9   25.3
    //     rank book (calibrated) 34.7   34.2   34.3   25.8
    //     worst case             32.9   33.3   34.3   25.3
    //
    // HISTORY, because the intermediate answer was wrong and the reason is worth keeping: an earlier
    // uncalibrated rank book (decay 2.2) put the optimum at 0.5 and made 0.7 look like a collapse to
    // 27.1%, so 0.6 was briefly shipped on minimax. scripts/face-validity.mjs then showed that book
    // modelled a room that does not exist -- median price $8 and 39% of picks at $1-5, against this
    // league's real $2 and 61%. Calibrating its decay to the real price distribution (RANK_DECAY 5)
    // moved the optimum to a 0.6-0.7 plateau and restored 0.7 as the minimax choice.
    // The lesson: a robustness check is only as good as the realism of the alternative it tests
    // against. Validate the challenger model before letting it overrule a result.
    note: "Minimax over two opponent books, 25 seasons n=150. Worst case 34.3 at 0.7 vs 25.3 at 1.0.",
  },
  {
    key: "premium", kind: "number", default: 2, off: 0, min: 0, max: 10, step: 1,
    label: "Outbid premium $", board: false, group: "bidding", flag: "premium", status: "shipped",
    help: "Extra dollars to win a specifically targeted player.",
    note: "Applied only to values >= $5, so the $1 tail is not inflated to $3.",
  },
  {
    key: "sleeperThreshold", kind: "number", default: 5, min: 1, max: 20, step: 1,
    label: "Sleeper cutoff (vsECR)", board: false, group: "board", flag: "sleeper-threshold", status: "shipped",
    help: "Min vsECR for the SLEEPERS board filter.",
  },
  {
    key: "benchDiscount", kind: "number", default: 0.25, off: 1, min: 0.1, max: 1, step: 0.05,
    label: "Bench discount", board: false, group: "value", flag: "bench-discount", status: "shipped",
    help: "How much a bench-only player is worth vs his standalone value. 1 = no discount.",
    note: "Measured 2026-09-04: full-system no-lookahead championships 24.4% -> 28.0% (n=400 x 9 "
      + "seasons, SE ~0.6). A bench-only player never enters the lineup, so his standalone value "
      + "overstates him; 0 collapses to 19.6% because depth still matters for byes/injuries.",
  },
  // All 1.0 by evidence. multQB 0.7 DID measure +1.3 pts (27.6% -> 28.6%, n=800) while aggr was 1.0
  // -- but that gain was the WINNER'S CURSE correction wearing a QB costume. With aggr 0.7 shipped,
  // multQB 1.0 and 0.7 both score 33.7% at n=800: exactly zero effect. Positional multipliers stay
  // at 1.0 until one of them beats the global dial on its own; see docs/validation.md.
  {
    key: "multQB", kind: "number", default: 1, off: 1, min: 0.4, max: 1.5, step: 0.05,
    label: "QB value x", board: false, group: "value", flag: "mult-qb", status: "shipped",
    help: "Multiplier on OUR QB values. <1 = pay less for QB than raw VOR says.",
    note: "0.7 measured +1.3pp at aggr 1.0, then EXACTLY 0 once aggr 0.7 shipped (n=800). It was "
      + "the global shading effect wearing a costume.",
  },
  {
    key: "multRB", kind: "number", default: 1, off: 1, min: 0.4, max: 1.5, step: 0.05,
    label: "RB value x", board: false, group: "value", flag: "mult-rb", status: "shipped",
    help: "Multiplier on OUR RB values. <1 = pay less for RB than raw VOR says.",
  },
  {
    key: "multWR", kind: "number", default: 1, off: 1, min: 0.4, max: 1.5, step: 0.05,
    label: "WR value x", board: false, group: "value", flag: "mult-wr", status: "shipped",
    help: "Multiplier on OUR WR values. <1 = pay less for WR than raw VOR says.",
  },
  {
    key: "multTE", kind: "number", default: 1, off: 1, min: 0.4, max: 1.5, step: 0.05,
    label: "TE value x", board: false, group: "value", flag: "mult-te", status: "shipped",
    help: "Multiplier on OUR TE values. <1 = pay less for TE than raw VOR says.",
  },
  {
    key: "consensusBlend", kind: "number", default: 1, off: 0, min: 0, max: 1, step: 0.05,
    label: "FFToday consensus blend", board: true, group: "board", flag: "consensus-blend", status: "shipped",
    help: "Re-rank the board's ORDERING toward the FFToday consensus (0 = our projection, 1 = the consensus). Validated ~+2.8pp titles.",
  },
];

/** Registry indexed by key. */
export const LEVER_BY_KEY = Object.fromEntries(LEVER_SPECS.map((s) => [s.key, s])) as Record<keyof Levers, LeverSpec>;

// EXHAUSTIVENESS: every field on `Levers` must have a spec. Adding a field without a spec fails to
// compile here rather than producing a lever with no default, no UI row, and no CLI flag.
const _everyLeverHasASpec: Record<keyof Levers, LeverSpec> = LEVER_BY_KEY;
void _everyLeverHasASpec;

/** The shipped defaults, DERIVED from the registry (never a second literal to drift out of sync). */
export const DEFAULT_LEVERS: Levers = Object.fromEntries(
  LEVER_SPECS.map((s) => [s.key, s.default]),
) as unknown as Levers;

export interface LeverMeta { label: string; min: number; max: number; step: number; board: boolean; help: string; }
/** UI/agent metadata, DERIVED. Booleans surface as a 0/1 range so existing numeric consumers (the
 *  Settings inputs, `read_levers`) keep working without special-casing. */
export const LEVER_META: Record<keyof Levers, LeverMeta> = Object.fromEntries(
  LEVER_SPECS.map((s) => [s.key, {
    label: s.label,
    min: s.kind === "boolean" ? 0 : (s.min ?? 0),
    max: s.kind === "boolean" ? 1 : (s.max ?? 1),
    step: s.kind === "boolean" ? 1 : (s.step ?? 0.01),
    board: s.board,
    help: s.help,
  }]),
) as Record<keyof Levers, LeverMeta>;

/** Coerce + clamp a single lever to its spec. Returns null for an unknown key or an uncoercible
 *  value. Booleans accept true/false and 1/0 so a numeric UI input still works. */
export function clampLever(key: string, value: unknown): number | null {
  const spec = (LEVER_BY_KEY as Record<string, LeverSpec | undefined>)[key];
  if (!spec) return null;
  if (spec.kind === "boolean") {
    if (typeof value === "boolean") return value ? 1 : 0;
    const n = Number(value);
    return Number.isFinite(n) ? (n ? 1 : 0) : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
}

/** Merge a partial levers patch onto a base, clamping each provided key. */
export function applyLevers(base: Levers, patch: Record<string, unknown>): Levers {
  const out: Levers = { ...base };
  for (const [k, v] of Object.entries(patch)) { const c = clampLever(k, v); if (c != null) (out as unknown as Record<string, number>)[k] = c; }
  return out;
}

/** Is this lever currently doing nothing? False for levers that have no no-op setting at all. */
export function isLeverOff(key: keyof Levers, levers: Levers): boolean {
  const spec = LEVER_BY_KEY[key];
  if (spec?.off == null) return false;
  return Number(levers[key]) === Number(spec.off);
}

/** Every lever's CLI override, parsed from argv in ONE place.
 *
 *  `--<flag> <value>` sets a lever; `--lever-off <key>` neutralises one (sets it to `spec.off`).
 *  Because this walks the registry, a NEW lever is backtest-overridable the moment its spec exists
 *  -- which is the bug that left `maxKDst` unmeasurable by the arbiter. Values are clamped to spec.
 */
export function leverOverridesFromArgv(
  argv: readonly string[],
  onClamp?: (key: keyof Levers, requested: number, clamped: number) => void,
): Partial<Record<keyof Levers, number>> {
  const out: Partial<Record<keyof Levers, number>> = {};
  const at = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  for (const spec of LEVER_SPECS) {
    const raw = at(spec.flag);
    if (raw === undefined) continue;
    const c = clampLever(spec.key, raw);
    if (c == null) continue;
    // A sweep that asks for a value outside the spec range must NOT be silently answered with a
    // different one -- that would report a number for a config nobody ran. Surface it instead.
    const asked = Number(raw);
    if (Number.isFinite(asked) && asked !== c) onClamp?.(spec.key, asked, c);
    out[spec.key] = c;
  }
  // `--lever-off <key>` may be repeated. Ignored for an unknown key, and for a lever that declares
  // no no-op value -- writing an invented "off" there would land outside its own legal range.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--lever-off") continue;
    const key = argv[i + 1] as keyof Levers | undefined;
    const spec = key ? LEVER_BY_KEY[key] : undefined;
    if (spec?.off != null) out[key as keyof Levers] = Number(spec.off);
  }
  return out;
}

/** Map levers onto the strategy's V2Config shape. One place, so a new lever cannot be added to the
 *  registry and then silently never reach the strategy (a DEAD lever -- the exact failure that
 *  `scripts/lever-connected.mjs` exists to catch after the fact). */
export function leversToV2Config(lv: Levers): {
  starterReserve: number; benchReserve: number; premium: number; aggr: number;
  maxShare: number; maxKDst: number; benchDiscount: number; posMult: Record<string, number>;
} {
  return {
    starterReserve: lv.starterReserve,
    benchReserve: lv.benchReserve,
    premium: lv.premium,
    aggr: lv.aggr,
    maxShare: lv.maxShare,
    maxKDst: lv.maxKDst,
    benchDiscount: lv.benchDiscount,
    posMult: { QB: lv.multQB, RB: lv.multRB, WR: lv.multWR, TE: lv.multTE },
  };
}
