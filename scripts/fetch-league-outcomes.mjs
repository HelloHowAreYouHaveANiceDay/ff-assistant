// FETCH WHAT ACTUALLY HAPPENED -- the one step of the calibration that needs the league.
//
//   npm run ff -- refresh        # (once, if the store is cold)
//   node --import tsx scripts/fetch-league-outcomes.mjs 2022 2025
//
// It writes data/league-outcomes.json: one row per (season, team) with the final rank, the record,
// whether they made the playoffs and whether they won the title. `scripts/sim-calibration.mjs` reads
// that file and needs nothing else from the network.
//
// WHY IT IS A SEPARATE SCRIPT AND NOT PART OF THE CALIBRATION. Everything else in the calibration is
// offline and reproducible; this is the one call that opens the league. Keeping it separate means
// the calibration can be re-run a hundred times against a file that was fetched once, and it means
// an agent working on the model can be told plainly that it must not run THIS.
//
// THE STORE DOES NOT HOLD THIS. `matchup` is empty, `ownership` carries rosters and not standings,
// and `data/owners.json` carries team names and owners but no results. The finalRank figures quoted
// in docs/league-tendencies.md came from exactly this call, through `lg.provider.history(...)`, and
// were never written down in machine-readable form.
import { writeFileSync } from "node:fs";
import { openLeague } from "../src/league/index.ts";

const first = Number(process.argv[2] ?? 2022);
const last = Number(process.argv[3] ?? 2025);
const seasons = [];
for (let y = first; y <= last; y++) seasons.push(y);

const lg = await openLeague();
const snaps = (await lg.provider.history(seasons)).filter((s) => s.available);
await lg.close();

const rows = [];
for (const s of snaps) {
  const done = (s.teams ?? []).filter((t) => t.finalRank != null && (t.wins ?? 0) + (t.losses ?? 0) > 0);
  if (!done.length) { console.log(`  ${s.season}: no completed standings -- skipped`); continue; }
  // THE SEASON'S OWN FIELD SIZE. `?? 7` was wrong for 2018-2024, when this league ran a SIX-team
  // field -- so every one of those seasons had its bottom playoff team recorded as a miss and the
  // outcome table, which is what the calibration is scored against, was wrong about 7 team-seasons.
  const playoffTeams = s.playoffTeams ?? s.format?.playoffTeams;
  if (playoffTeams == null) {
    console.log(`  ${s.season}: no playoff field size in the snapshot -- skipped rather than defaulted`);
    continue;
  }
  for (const t of done) {
    rows.push({
      season: s.season,
      teamId: String(t.id),
      name: t.name,
      abbrev: t.abbrev ?? null,
      owner: t.owners?.[0]?.name ?? null,
      finalRank: t.finalRank,
      wins: t.wins, losses: t.losses,
      pointsFor: t.pointsFor ?? null,
      // A LEAGUE'S OWN ORDERING, not a re-derivation. `finalRank` blends the regular season and the
      // playoff result, which is exactly the quantity "did they make the playoffs / win it" needs.
      playoffs: t.finalRank <= playoffTeams ? 1 : 0,
      champion: t.finalRank === 1 ? 1 : 0,
    });
  }
  console.log(`  ${s.season}: ${done.length} teams`);
}
if (!rows.length) { console.log("nothing to write"); process.exit(1); }
writeFileSync("data/league-outcomes.json", JSON.stringify({ fetchedAt: new Date().toISOString(), rows }, null, 2), "utf8");
console.log(`wrote data/league-outcomes.json (${rows.length} team-seasons)`);
