/**
 * THE ODDS ACCRUAL: turning thirty-two frozen probabilities into a Brier score once the season ends.
 *
 * The snapshot side of this kind shipped in Phase 2c and the SCORING side did not, so the rows sat in
 * the store with nothing able to read them -- a record rather than a prediction, and the difference
 * is invisible until the season resolves, which is exactly when it is too late to notice.
 *
 * A SCORER IS THE EASIEST THING TO GET SILENTLY WRONG. A Brier computed against a permuted outcome
 * vector, or against a join that matched nobody, has the same range and the same confident decimal as
 * a correct one. So every assertion here is paired with the case that must come out differently, and
 * the real check against the calibration harness -- reproducing its 2025 figures to six decimals --
 * lives in `scripts/odds-accrual-2025.mjs`, where it can use the store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../src/db/db.js";
import { scoreOdds, formatScorecard, type ScorecardResult } from "../src/weekly/scorecard.js";

const SEASON = 2091;
const N = 16, FIELD = 7;

/** Sixteen teams: the first seven made the playoffs, the first won it. */
function seedLeague(db: DB, o: { settled?: boolean; ranked?: boolean; champions?: number } = {}): void {
  const settled = o.settled ?? true, ranked = o.ranked ?? true, champions = o.champions ?? 1;
  const ins = db.prepare(
    `INSERT INTO fact_team_season (league_id, season, team_id, team_name, owner, wins, losses, points_for,
        playoff_seed, final_rank, champion, made_playoffs, settled, updated_at)
     VALUES ('L',@season,@id,@id,@id,7,7,1000,@seed,@rank,@champ,@made,@settled,@now)`,
  );
  const now = nowIso();
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      ins.run({
        season: SEASON, id: `T${i}`, seed: i < FIELD ? i + 1 : null,
        rank: ranked ? i + 1 : null, champ: i < champions ? 1 : 0, made: i < FIELD ? 1 : 0,
        settled: settled ? 1 : 0, now,
      });
    }
  })();
}

/** `sharp` puts high probability on the teams that actually made it; `flat` gives everyone the
 *  uniform rate. Both are legal tables; only one of them knows anything. */
function seedOdds(db: DB, kind: "sharp" | "flat" | "backwards"): void {
  const ins = db.prepare(
    `INSERT INTO scorecard_prediction (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
     VALUES (@season,0,'odds',@model,@id,@id,NULL,@value,NULL,NULL,@asOf,@now)`,
  );
  const now = nowIso();
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const made = i < FIELD;
      const playoff = kind === "flat" ? (100 * FIELD) / N : kind === "sharp" ? (made ? 85 : 12) : (made ? 12 : 85);
      const title = kind === "flat" ? 100 / N : kind === "sharp" ? (i === 0 ? 40 : 4) : (i === 0 ? 1 : 6.6);
      ins.run({ season: SEASON, model: "playoff", id: `T${i}`, value: playoff, asOf: `${SEASON}-09-01`, now });
      ins.run({ season: SEASON, model: "title", id: `T${i}`, value: title, asOf: `${SEASON}-09-01`, now });
    }
  })();
}

function withDb<T>(fn: (db: DB) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ff-odds-t-"));
  const db = openDb(join(dir, "t.db"));
  try { return fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("a settled season is scored, playoff and title separately, each against its own uniform floor", () => {
  const r = withDb((db) => { seedLeague(db); seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  assert.equal(r.skipped, null);
  assert.deepEqual(r.models.map((m) => m.model), ["playoff", "title"]);
  const [p, t] = r.models;
  assert.equal(p.n, N);
  assert.equal(t.n, N);
  // The floors are the league's own, not a constant: 7-of-16 for the berth, 1-of-16 for the title.
  assert.ok(Math.abs(p.uniformBrier - ((FIELD / N) ** 2 * (N - FIELD) + (1 - FIELD / N) ** 2 * FIELD) / N) < 1e-9);
  assert.ok(Math.abs(t.uniformBrier - (((1 / N) ** 2 * (N - 1) + (1 - 1 / N) ** 2) / N)) < 1e-9);
  assert.ok(p.skill > 0 && t.skill > 0, `a table that knew the answer scored ${p.skill} / ${t.skill} skill`);
});

test("POSITIVE CONTROL: a sharper table beats a flat one, and a backwards one is WORSE than knowing nothing", () => {
  const sharp = withDb((db) => { seedLeague(db); seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  const flat = withDb((db) => { seedLeague(db); seedOdds(db, "flat"); return scoreOdds(db, SEASON); });
  const back = withDb((db) => { seedLeague(db); seedOdds(db, "backwards"); return scoreOdds(db, SEASON); });
  const brierOf = (r: typeof sharp, m: string) => r.models.find((x) => x.model === m)!.brier;
  assert.ok(brierOf(sharp, "playoff") < brierOf(flat, "playoff"), "the scorer cannot tell a sharp table from a flat one");
  assert.ok(brierOf(back, "playoff") > brierOf(flat, "playoff"), "a table that is exactly wrong scored no worse than the floor");
  // A flat table IS the floor, so its skill must be exactly zero -- the check that the floor is being
  // computed from the same rows rather than from something else.
  assert.ok(Math.abs(flat.models[0].skill) < 1e-9, `a table equal to the uniform prior scored ${flat.models[0].skill} skill`);
  assert.ok(back.models[0].skill < 0, "negative skill is unreachable, so 'beats the floor' can never fail");
});

test("FAULT: an UNSETTLED season is refused, and the refusal says what is missing", () => {
  const unsettled = withDb((db) => { seedLeague(db, { settled: false }); seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  assert.match(unsettled.skipped ?? "", /has not resolved/);
  assert.equal(unsettled.models.length, 0);
  const unranked = withDb((db) => { seedLeague(db, { ranked: false }); seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  assert.match(unranked.skipped ?? "", /has not resolved/);
  // Two champions is a season that cannot have happened; scoring it would report a verdict on data
  // that is wrong rather than incomplete.
  const twoChamps = withDb((db) => { seedLeague(db, { champions: 2 }); seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  assert.match(twoChamps.skipped ?? "", /champion/);
});

test("FAULT: frozen rows that join no team are refused rather than scored against nothing", () => {
  const r = withDb((db) => {
    seedLeague(db);
    // The same rows under team ids nobody holds -- the shape of a key-space mismatch, which would
    // otherwise produce an empty scored set and a Brier of NaN reported as a number.
    const ins = db.prepare(
      `INSERT INTO scorecard_prediction (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
       VALUES (@season,0,'odds',@model,@id,@id,NULL,@value,NULL,NULL,@asOf,@now)`,
    );
    const now = nowIso();
    for (let i = 0; i < N; i++) {
      ins.run({ season: SEASON, model: "playoff", id: `X${i}`, value: 50, asOf: "x", now });
      ins.run({ season: SEASON, model: "title", id: `X${i}`, value: 6, asOf: "x", now });
    }
    return scoreOdds(db, SEASON);
  });
  assert.match(r.skipped ?? "", /join no team/);
});

test("FAULT: no frozen rows at all is a skip that says so, not a score of zero", () => {
  const r = withDb((db) => { seedLeague(db); return scoreOdds(db, SEASON); });
  assert.match(r.skipped ?? "", /nothing was ever snapshotted/);
  const noTeams = withDb((db) => { seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  assert.match(noTeams.skipped ?? "", /no rows for/);
});

test("the 2026 rows stay unscored until the season resolves, and the report says why", () => {
  // 2026 is live. The rows exist, the outcomes do not, and the command has to say that rather than
  // print a Brier against an in-progress table.
  const r = withDb((db) => { seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  const rendered = formatScorecard({
    season: SEASON, today: "2026-09-09", imminentWeek: 1,
    snapshot: { week: null, taken: 0, skipped: "x", byModel: {} },
    challenger: { week: null, taken: 0, skipped: "x" },
    espn: { attempted: false, ok: false, reason: "n", stored: 0 },
    seasonKind: { taken: 0, skipped: null }, oddsKind: { taken: 32, skipped: null },
    scored: [], seasonScored: null, oddsScored: r, notes: [],
  } as ScorecardResult);
  assert.match(rendered, /ODDS ACCRUAL: not scored/);
});

test("the report renders the scored block with both models and their floors", () => {
  const r = withDb((db) => { seedLeague(db); seedOdds(db, "sharp"); return scoreOdds(db, SEASON); });
  const rendered = formatScorecard({
    season: SEASON, today: "2092-01-10", imminentWeek: null,
    snapshot: { week: null, taken: 0, skipped: "x", byModel: {} },
    challenger: { week: null, taken: 0, skipped: "x" },
    espn: { attempted: false, ok: false, reason: "n", stored: 0 },
    seasonKind: { taken: 0, skipped: null }, oddsKind: { taken: 32, skipped: null },
    scored: [], seasonScored: null, oddsScored: r, notes: [],
  } as ScorecardResult);
  assert.match(rendered, /ODDS ACCRUAL, 2091 \(16 teams\)/);
  assert.match(rendered, /playoff/);
  assert.match(rendered, /title/);
  assert.match(rendered, /reliability, playoff:/);
});
