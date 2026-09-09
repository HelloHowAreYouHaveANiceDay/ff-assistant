/**
 * READ-ONLY: cache this league's ESPN settings + team/division/record payloads.
 *
 * The format block (regular-season length, playoff field, seeding rule, divisions) is a FACT about
 * the league, not a default -- so it has to come from ESPN, and the payload it came from has to be
 * kept so a later analysis can be re-run without the app being up. Everything written here lands in
 * data/cache/espn/ and nothing is ever POSTed to ESPN.
 *
 * Usage: node scripts/format-fetch.mjs [season ...]     (default 2018..2026)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { bridgeFetch } from "../src/browser/appBridge.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database("data/ff.db", { readonly: true });
const leagueId = String(db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id);
db.close();

const HOST = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const seasons = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

mkdirSync("data/cache/espn", { recursive: true });
for (const season of seasons) {
  const url = `${HOST}/seasons/${season}/segments/0/leagues/${leagueId}?view=mSettings&view=mTeam&view=mMatchup`;
  let raw;
  try { raw = await bridgeFetch(url); } catch (e) { console.log(`${season}: UNREACHABLE -- ${String(e.message).slice(0, 120)}`); continue; }
  let j;
  try { j = JSON.parse(raw); } catch { console.log(`${season}: not JSON (${raw.slice(0, 80)})`); continue; }
  // Keep only what the format work needs -- the full payload embeds every roster and is enormous.
  const ss = j.settings?.scheduleSettings ?? {};
  const slim = {
    season, leagueId, fetchedAt: new Date().toISOString(),
    settings: {
      size: j.settings?.size ?? null,
      scheduleSettings: {
        matchupPeriodCount: ss.matchupPeriodCount ?? null,
        matchupPeriodLength: ss.matchupPeriodLength ?? null,
        playoffTeamCount: ss.playoffTeamCount ?? null,
        playoffMatchupPeriodLength: ss.playoffMatchupPeriodLength ?? null,
        playoffSeedingRule: ss.playoffSeedingRule ?? null,
        playoffSeedingRuleBy: ss.playoffSeedingRuleBy ?? null,
        playoffReseed: ss.playoffReseed ?? null,
        divisions: (ss.divisions ?? []).map((d) => ({ id: d.id, name: d.name })),
        matchupPeriods: ss.matchupPeriods ?? null,
      },
    },
    status: {
      finalScoringPeriod: j.status?.finalScoringPeriod ?? null,
      currentMatchupPeriod: j.status?.currentMatchupPeriod ?? null,
    },
    teams: (j.teams ?? []).map((t) => ({
      id: t.id, name: (t.name || `${t.location ?? ""} ${t.nickname ?? ""}`).trim(),
      divisionId: t.divisionId ?? null,
      playoffSeed: t.playoffSeed ?? null,
      rankCalculatedFinal: t.rankCalculatedFinal ?? null,
      wins: t.record?.overall?.wins ?? null,
      losses: t.record?.overall?.losses ?? null,
      ties: t.record?.overall?.ties ?? null,
      pointsFor: t.record?.overall?.pointsFor ?? null,
    })),
    schedule: (j.schedule ?? []).map((m) => ({
      week: m.matchupPeriodId ?? null,
      playoffTierType: m.playoffTierType ?? null,
      winner: m.winner ?? null,
      homeId: m.home?.teamId ?? null, awayId: m.away?.teamId ?? null,
      homePts: m.home?.totalPoints ?? null, awayPts: m.away?.totalPoints ?? null,
    })),
  };
  writeFileSync(`data/cache/espn/settings-${season}.json`, JSON.stringify(slim, null, 2));
  const tiers = new Map();
  for (const m of slim.schedule) {
    const k = m.week;
    if (!tiers.has(k)) tiers.set(k, {});
    const t = m.playoffTierType ?? "none";
    tiers.get(k)[t] = (tiers.get(k)[t] ?? 0) + 1;
  }
  console.log(`${season}: matchupPeriodCount=${ss.matchupPeriodCount} playoffTeamCount=${ss.playoffTeamCount} seedingRule=${ss.playoffSeedingRule} divisions=${(ss.divisions ?? []).length} teams=${slim.teams.length}`);
  console.log(`  weeks -> tier counts: ${[...tiers.entries()].sort((a, b) => a[0] - b[0]).map(([w, t]) => `${w}:${JSON.stringify(t)}`).join(" ")}`);
}
