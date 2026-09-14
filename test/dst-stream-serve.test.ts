// THE DST STREAMING ARTIFACT ON DISK, AND THE ONE PROPERTY ITS SERVE MUST NEVER LOSE.
//
// docs/decisions.md D20 routes DST off the season-line floor and onto a matchup model fitted on the
// twelve feat_player_week_stream columns. It is a WeeklyArtifact served by projectWeekly() unchanged,
// so the loader's golden block already proves the trainer and the serve agree. What THIS file guards
// is the reason the model is safe to ship forward into a live season: it MUST degrade to the
// season-line floor -- never to a NaN, an Infinity, or a pathological number -- for a DST row whose
// matchup columns are missing. That is exactly the 2026 forward case (opp_implied_total is gone by
// week 10) and it is the failure the D19 boost shipped and had to be pulled for. A linear head cannot
// have a tree cliff, and this asserts it rather than trusting it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadWeeklyArtifact, projectWeekly, type WeeklyInputRow } from "../src/weekly/projector.js";
import { dataPath } from "../src/data/paths.js";
import { DST_STREAM_ARTIFACT } from "../src/weekly/streamingServe.js";

function art() {
  // checkGolden runs inside the loader; a mismatch throws here, which is the whole point.
  return loadWeeklyArtifact(JSON.parse(readFileSync(dataPath(DST_STREAM_ARTIFACT), "utf8")));
}

function row(f: WeeklyInputRow["f"], line = 6.0): WeeklyInputRow {
  return { feat_key: "t", player_sk: null, name: "D", pos: "DST", season: 2026, week: 5, season_line_pg: line, f };
}

test("the DST streaming artifact loads, is a DST-only weekly linear artifact, and its golden block checks", () => {
  const a = art();
  assert.equal(a.kind, "weekly");
  assert.equal(a.target, "ratio_to_season_line");
  assert.deepEqual(Object.keys(a.coef), ["DST"]);
  assert.equal(a.features.length, 12, "the twelve matchup features must be declared");
  assert.ok((a.golden?.length ?? 0) >= 3, "the artifact must carry golden fixtures, incl. a thin-feature one");
  // it is NOT boosted: a linear head is what makes the missing-feature degradation cliff-free.
  assert.notEqual(a.learner, "gbm");
});

test("DST serve DIFFERENTIATES by matchup: a soft matchup projects above a hard one", () => {
  const a = art();
  const soft = projectWeekly({ artifact: a, rows: [row({ opp_implied_total: 17.0, opp_off_giveaways_pg: 2.0 })] });
  const hard = projectWeekly({ artifact: a, rows: [row({ opp_implied_total: 29.0, opp_off_giveaways_pg: 0.6 })] });
  assert.equal(soft.length, 1);
  assert.equal(hard.length, 1);
  assert.ok(soft[0].mean > hard[0].mean + 1.0,
    `a soft matchup (${soft[0].mean.toFixed(2)}) must project meaningfully above a hard one (${hard[0].mean.toFixed(2)}) ` +
    "-- if it does not, the matchup features are not connected at serve");
  for (const p of [...soft, ...hard]) {
    for (const h of [p.mean, p.p10, p.p50, p.p90]) assert.ok(Number.isFinite(h), "a served head is not finite");
  }
});

test("THE G2 PROPERTY: a DST row with NO matchup features degrades to ~ the season-line floor, never to a pathological value", () => {
  const a = art();
  const line = 6.0;
  const thin = projectWeekly({ artifact: a, rows: [row({}, line)] });
  assert.equal(thin.length, 1, "a DST row with a line but no matchup features must still project");
  const m = thin[0].mean;
  assert.ok(Number.isFinite(m) && Number.isFinite(thin[0].p10) && Number.isFinite(thin[0].p90),
    "the thin-feature serve produced a non-finite head -- the exact forward-serve collapse D20 must avoid");
  // The mean-imputed missing features contribute zero, so the projection is line * intercept. The
  // intercept is the pooled ratio (~1.0), so the thin serve must sit within ~25% of the raw floor --
  // stated, not silently worse, and nowhere near a cliff value.
  assert.ok(Math.abs(m - line) <= 0.25 * line,
    `thin-feature DST mean ${m.toFixed(2)} is not within 25% of the season line ${line} -- it did not degrade to the floor`);
  assert.ok(m > 0, "a DST projection must be positive");
});

test("FAULT INJECTION: a broken (non-numeric) matchup value is treated as missing, not propagated as NaN", () => {
  const a = art();
  // Infinity/NaN inputs must be caught by the feature evaluator and imputed, not multiplied through.
  const bad = projectWeekly({ artifact: a, rows: [row({ opp_implied_total: Number.NaN, opp_off_giveaways_pg: Infinity })] });
  assert.equal(bad.length, 1);
  assert.ok(Number.isFinite(bad[0].mean), "a non-finite matchup input propagated to the served mean");
});
