/**
 * WHICH SEEDING RULE DOES ESPN ACTUALLY USE? Decided from this league's own seasons, not from
 * ESPN's help text.
 *
 * Both candidate rules are applied to each season's REAL records, points-for and divisions, and the
 * result compared against the REAL playoffSeed ESPN assigned. A rule that reproduces every seed in
 * every season is consistent with the data; a rule that does not is refused. The interesting answer
 * is the third one -- that both reproduce it, in which case the data cannot tell them apart and the
 * choice has to be made and LABELLED as an assumption rather than presented as a finding.
 *
 * Reads only data/cache/espn/settings-<season>.json (written by scripts/format-fetch.mjs).
 *
 * Usage: node scripts/format-seeding.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { seedField } from "../src/draft/schedule.ts";

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const rows = [];

for (const season of SEASONS) {
  const p = `data/cache/espn/settings-${season}.json`;
  if (!existsSync(p)) { console.log(`${season}: no cached settings -- run scripts/format-fetch.mjs`); continue; }
  const j = JSON.parse(readFileSync(p, "utf8"));
  const teams = j.teams.filter((t) => t.playoffSeed != null);
  if (!teams.length) { console.log(`${season}: no playoffSeed on any team`); continue; }
  const idx = new Map(teams.map((t, i) => [t.id, i]));
  const standings = teams.map((t) => ({ wins: t.wins ?? 0, pts: t.pointsFor ?? 0 }));
  const divIds = [...new Set(teams.map((t) => t.divisionId))].sort((a, b) => a - b);
  const divisionOf = teams.map((t) => divIds.indexOf(t.divisionId));
  const field = j.settings.scheduleSettings.playoffTeamCount;

  // ESPN's own answer: the teams whose playoffSeed is 1..field, in seed order.
  const real = teams.slice().sort((a, b) => a.playoffSeed - b.playoffSeed).slice(0, field).map((t) => idx.get(t.id));
  const byRecord = seedField(standings, field, "record", divisionOf);
  const byDivision = seedField(standings, field, "division-winners-first", divisionOf);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const name = (i) => teams[i].name;

  rows.push({ season, divisions: divIds.length, field, teams: teams.length,
    record: same(byRecord, real), division: same(byDivision, real), rulesAgree: same(byRecord, byDivision) });

  console.log(`\n=== ${season}: ${teams.length} teams, ${divIds.length} division(s), ${field}-team field ===`);
  console.log(`  ESPN's seeds        : ${real.map((i) => `${name(i)} (${standings[i].wins}-${teams[i].losses})`).join(" | ")}`);
  console.log(`  record              : ${same(byRecord, real) ? "MATCHES" : "DIFFERS -> " + byRecord.map(name).join(" | ")}`);
  console.log(`  division-winners-1st: ${same(byDivision, real) ? "MATCHES" : "DIFFERS -> " + byDivision.map(name).join(" | ")}`);
  console.log(`  the two rules ${same(byRecord, byDivision) ? "AGREE with each other -- this season CANNOT distinguish them" : "DISAGREE -- this season is decisive"}`);
}

console.log("\n=== VERDICT ===");
const decisive = rows.filter((r) => !r.rulesAgree);
const recordOk = rows.every((r) => r.record), divisionOk = rows.every((r) => r.division);
console.log(`  seasons examined      : ${rows.map((r) => r.season).join(", ")}`);
console.log(`  record reproduces all : ${recordOk}`);
console.log(`  division reproduces all: ${divisionOk}`);
console.log(`  DECISIVE seasons (the two rules disagree): ${decisive.length ? decisive.map((r) => r.season).join(", ") : "NONE"}`);
if (!decisive.length) {
  console.log(`  => The data CANNOT distinguish the rules. Every season either has one division (where`);
  console.log(`     they are the same rule) or has division winners who were already the best teams`);
  console.log(`     outright. Defaulting to division-winners-first where divisions exist is therefore`);
  console.log(`     an ASSUMPTION resting on ESPN's documented behaviour, not a measurement.`);
}
