/**
 * ADJACENT-SEASON EMBARGO (WS3) -- the single TS source of truth for WHICH training seasons a fold
 * keeps, and the guard that proves the Python trainer actually applied it.
 *
 * Training is walk-forward (`season < asOf`), so `asOf` and every later season are already excluded
 * as future. The embargo ALSO removes the `embargo` seasons immediately below `asOf`, because year
 * N-1 autocorrelates with year N (career arcs, roster continuity), so a fold that trains on N-1 and
 * tests on N overstates generalisation to a genuinely unseen season. `embargo=0` removes nothing and
 * reproduces the pre-WS3 training set.
 *
 * These functions are pure so they can be fault-injected in isolation (test/embargo.test.ts), and
 * `embargoedSeasons` is reused by src/model/evaluate.ts as a runtime guard: after the trainer runs
 * with `--embargo N`, evaluate.ts asserts none of the embargoed seasons appear in the produced
 * artifact's `seasons`. That is the consumer validating the producer's emitted bytes -- the only
 * check that catches a `--embargo` flag the Python side silently failed to wire, rather than a
 * reimplementation grading its own homework.
 */

/** The seasons an embargo of `embargo` removes from a fold whose held-out season is `asOf`:
 *  `{asOf-embargo, ..., asOf-1}`. Empty when `embargo` is 0. */
export function embargoedSeasons(asOf: number, embargo: number): number[] {
  if (!Number.isInteger(embargo) || embargo < 0) {
    throw new Error(`embargo must be a non-negative integer, got ${embargo}`);
  }
  const out: number[] = [];
  for (let s = asOf - embargo; s < asOf; s++) out.push(s);
  return out;
}

/** The training seasons a fold keeps: those strictly before `asOf` and not embargoed. Throws if the
 *  embargo would empty the training set -- a dead trainer must fail loudly, not fit on nothing. */
export function embargoTrainingSeasons(allSeasons: number[], asOf: number, embargo: number): number[] {
  const emb = new Set(embargoedSeasons(asOf, embargo));
  const kept = allSeasons.filter((s) => s < asOf && !emb.has(s));
  if (!kept.length) {
    throw new Error(
      `embargo ${embargo} at as-of ${asOf} would empty the training set (seasons ${allSeasons.join(",")})`,
    );
  }
  return kept;
}
