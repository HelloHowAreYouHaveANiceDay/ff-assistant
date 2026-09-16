// THE PER-FORMAT GATE NUMBER (F-9, WP7).
//
// `scripts/cpcv.mjs` carried `--golden 96.0` and `--golden-title 38.5` as DEFAULTS in its own argument
// parser, and the ledger row it appended said nothing about which format the arms were run under. With
// one format that is merely undocumented; with two it is a wrong answer waiting to happen, because the
// consistency check would hold a second format's backtest against the INCUMBENT's 96.0% and either pass
// by coincidence or fail for the wrong reason.
//
// So the number moves next to the model it belongs to: `data/golden.json` for the incumbent (whose
// artifacts live at the data/ root) and `data/formats/<key>/golden.json` for anything else -- the same
// `golden` entry `formatResolve.ts`'s artifact table already declares.
//
// AND A FORMAT WITH NO GOLDEN IS REFUSED BY NAME. It is not defaulted to the incumbent's, and it is not
// invented from a single run. A golden master is a number somebody pinned after deciding what the
// shipped posture is; a format that has never had that conversation has no gate, and saying so is the
// only honest option. The Yahoo format additionally has no DraftModel for a snake draft at all, which
// the refusal says outright -- the pre-draft arbiter cannot be run there whatever number were written.
import { existsSync, readFileSync } from "node:fs";

export class NoGoldenError extends Error {}

/**
 * Load a format's golden master.
 *
 *   model   the format's `ModelHandle` (`resolveFormat(db, id).model`)
 *   key     the scoring key, for the refusal message
 *
 * Returns `{ playoffPct, titlePct, tolerancePp, path }`. THROWS `NoGoldenError` -- naming the format
 * and the file -- when the format has no `golden.json`, and a plain Error when it has one that does
 * not carry a numeric `playoffPct`.
 */
export function loadGolden(model, key) {
  const p = model.path("golden");
  if (!existsSync(p)) {
    throw new NoGoldenError(
      `format ${key} has no golden -- a pre-draft gate needs the snake DraftModel; in-season odds are reachable but ungated.\n` +
      `  (${p} does not exist. There is deliberately no fallback to the incumbent's ${"data/golden.json"}: gating one\n` +
      "   format's backtest against another format's pinned number is a pass or a fail for the wrong reason.)",
    );
  }
  let doc;
  try { doc = JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    throw new Error(`${p} is unparseable: ${e.message}`, { cause: e });
  }
  if (!doc || typeof doc.playoffPct !== "number") {
    throw new Error(`${p} carries no numeric \`playoffPct\` -- the PRIMARY gate (D13) has nothing to check against.`);
  }
  return {
    playoffPct: doc.playoffPct,
    // The title is CONTEXT, never a gate (D13), so a golden without one is fine -- it simply is not printed.
    titlePct: typeof doc.titlePct === "number" ? doc.titlePct : null,
    tolerancePp: typeof doc.tolerancePp === "number" ? doc.tolerancePp : 3.0,
    path: p,
  };
}
