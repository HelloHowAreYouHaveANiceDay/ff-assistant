// DOES THE ODDS ACCRUAL AGREE WITH THE CALIBRATION HARNESS? Checked on 2025, the one settled season
// the league has played under the current format.
//
//   node --import tsx scripts/season-calibration.mjs --seasons 2025-2025 --emit-odds data/trials/odds-2025.tsv
//   node --import tsx scripts/odds-accrual-2025.mjs [--odds data/trials/odds-2025.tsv]
//
// WHY IT IS CHECKED THIS WAY. `scorecard.ts`'s new `odds` branch is a scorer, and the way a scorer
// goes wrong is silently: a Brier computed against a permuted outcome vector, or against a join that
// matched nobody, looks exactly like a correct one -- same range, same shape, same confident decimal.
// So it is NOT checked against a reimplementation of itself. It is handed the EXACT probabilities
// `scripts/season-calibration.mjs` produced for 2025 -- the harness behind every calibration figure
// in docs/validation.md -- and has to reproduce that harness's per-season Brier to six decimals.
//
// NOTHING IS WRITTEN TO data/ff.db. The 2025 probabilities are being computed NOW, after the season,
// so recording them in `scorecard_prediction` would be exactly the thing the write-once rule exists
// to prevent: a "prediction" made after the games, indistinguishable in the table from an honest one.
// They go into a throwaway database instead, which is also the only way this check runs offline.
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso } from "../src/db/db.ts";
import { scoreOdds } from "../src/weekly/scorecard.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const SRC = val("--odds", "data/trials/odds-2025.tsv");
const SEASON = Number(val("--season", "2025"));

const rows = readFileSync(SRC, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
  const f = l.split("\t");
  return { season: Number(f[0]), team: f[1], playoffPct: Number(f[2]), titlePct: Number(f[3]), madePlayoffs: Number(f[4]), champion: Number(f[5]) };
}).filter((r) => r.season === SEASON);
if (!rows.length) { console.error(`no rows for ${SEASON} in ${SRC} -- run season-calibration.mjs --emit-odds first`); process.exit(2); }

// The reference: the same arithmetic the calibration harness prints, computed here from its own
// emitted rows so the two sides of the comparison start from identical inputs.
const brier = (a) => a.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / a.length;
const refPlayoff = brier(rows.map((r) => ({ p: r.playoffPct / 100, y: r.madePlayoffs })));
const refTitle = brier(rows.map((r) => ({ p: r.titlePct / 100, y: r.champion })));

const dir = mkdtempSync(join(tmpdir(), "ff-odds-"));
const dbPath = join(dir, "accrual.db");
try {
  const db = openDb(dbPath);
  const field = rows.filter((r) => r.madePlayoffs).length;
  const insT = db.prepare(
    `INSERT INTO fact_team_season (league_id, season, team_id, team_name, owner, wins, losses, points_for,
        playoff_seed, final_rank, champion, made_playoffs, settled, updated_at)
     VALUES ('L',@season,@team,@team,@team,7,7,1000,@seed,@rank,@champ,@made,1,@now)`,
  );
  const insP = db.prepare(
    `INSERT INTO scorecard_prediction (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
     VALUES (@season,0,'odds',@model,@subject,@subject,NULL,@value,NULL,NULL,@asOf,@now)`,
  );
  const now = nowIso();
  db.transaction(() => {
    let seed = 0, rank = 0;
    for (const r of [...rows].sort((a, b) => b.champion - a.champion || b.madePlayoffs - a.madePlayoffs)) {
      rank++;
      insT.run({ season: SEASON, team: r.team, seed: r.madePlayoffs ? ++seed : null, rank, champ: r.champion, made: r.madePlayoffs, now });
      insP.run({ season: SEASON, model: "playoff", subject: r.team, value: r.playoffPct, asOf: `${SEASON}-09-01`, now });
      insP.run({ season: SEASON, model: "title", subject: r.team, value: r.titlePct, asOf: `${SEASON}-09-01`, now });
    }
  })();

  const scored = scoreOdds(db, SEASON);
  if (scored.skipped) { console.error(`the scorer refused: ${scored.skipped}`); process.exit(1); }
  const got = Object.fromEntries(scored.models.map((m) => [m.model, m]));

  const line = (label, mine, ref) =>
    `  ${label.padEnd(10)} scorer ${mine.toFixed(6)}   calibration harness ${ref.toFixed(6)}   ${Math.abs(mine - ref) < 1e-9 ? "MATCH" : "DISAGREE"}`;
  console.log(`ODDS ACCRUAL vs THE CALIBRATION HARNESS -- ${SEASON}, ${rows.length} teams, ${field} playoff berths`);
  console.log(line("playoffs", got.playoff.brier, refPlayoff));
  console.log(line("title", got.title.brier, refTitle));
  console.log(`  uniform floors: playoffs ${got.playoff.uniformBrier.toFixed(6)} (${field}/${rows.length}), title ${got.title.uniformBrier.toFixed(6)} (1/${rows.length})`);
  console.log(`  skill: playoffs ${(100 * got.playoff.skill).toFixed(1)}%, title ${(100 * got.title.skill).toFixed(1)}%  (positive beats the floor)`);
  for (const m of scored.models) {
    console.log(`  reliability, ${m.model}: ` + m.reliability
      .map((b) => `${(100 * b.lo).toFixed(0)}-${(100 * b.hi).toFixed(0)}% n=${b.n} pred ${(100 * b.predicted).toFixed(1)}% obs ${(100 * b.observed).toFixed(1)}%`).join("; "));
  }

  // THE CONTROL, because a Brier against a PERMUTED outcome looks exactly like one against the right
  // one. Shuffle which team got which outcome and the honest arm must beat it.
  const shuffled = rows.map((r, i) => ({ ...r, madePlayoffs: rows[(i + 5) % rows.length].madePlayoffs, champion: rows[(i + 5) % rows.length].champion }));
  const ctrlP = brier(shuffled.map((r) => ({ p: r.playoffPct / 100, y: r.madePlayoffs })));
  console.log(`  CONTROL, outcomes rotated between teams: playoffs ${ctrlP.toFixed(6)} against the honest ${refPlayoff.toFixed(6)} -- ` +
    (ctrlP > refPlayoff ? "the join is real." : "WARNING: the shuffled arm is no worse, so the join or the signal is not there."));

  const ok = Math.abs(got.playoff.brier - refPlayoff) < 1e-9 && Math.abs(got.title.brier - refTitle) < 1e-9;
  console.log(ok ? "\nAGREES with the calibration harness to six decimals." : "\nDISAGREES -- the accrual scorer and the harness are not measuring the same thing.");
  db.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
