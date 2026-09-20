/**
 * LIVE POSITIVE CONTROL for the Sleeper adaptor -- `npx tsx scripts/sleeper-live-check.ts`.
 *
 * Every byte comes back through `platformFor("sleeper")` + `publicPlatformIO`, so what this
 * exercises is the REGISTRY, the CONTRACT and the PARSERS -- not a shell pipeline that happens to
 * curl the same URLs. A fixture test proves the parsers handle a payload I saved; this proves the
 * payload Sleeper serves today is still that shape, which is the half a fixture can never cover.
 *
 * Needs FF_SLEEPER_USER set (Sleeper's API is public and therefore anonymous -- it cannot infer
 * whose leagues to list). It makes no writes and stores nothing.
 */
import { platformFor, publicPlatformIO, knownPlatforms } from "../src/league/platform.js";

async function main() {
  // LIVE END-TO-END READ of The Dy-nasty through the registered adaptor -- not through curl.
  // The point is that every byte comes back through `platformFor("sleeper")` + `publicPlatformIO`,
  // so what is exercised is the registry, the contract and the parsers, not my shell.

  const LEAGUE = "1353038434335195136";
  const SEASON = 2026;

  const io = publicPlatformIO();
  console.log("registered platforms:", knownPlatforms().join(", "));

  const plat = await platformFor("sleeper");
  console.log("adaptor id:", plat.id, "| host:", plat.host, "| webview:", plat.webview ? "yes" : "none (no login needed)", "| writes:", plat.writes ? "yes" : "none (read-only)");

  console.log("\n=== discover ===");
  const found = await plat.discover(io, SEASON);
  for (const d of found) console.log(`  ${d.leagueId}  ${JSON.stringify(d.name)}  season=${d.season}  ourTeam=${d.teamId}`);

  console.log("\n=== syncSettings ===");
  const s = await plat.syncSettings(io, LEAGUE, SEASON);
  console.log(`  name        ${s.name}`);
  console.log(`  platform    ${s.platform}  season ${s.season}  teams ${s.teams}  ourTeam ${s.teamId}`);
  console.log(`  draftType   ${s.draftType}  budget ${s.budget}`);
  console.log(`  slots       ${s.slots.join(" ")}`);
  console.log(`  bucket      ${s.scoringBucket}`);
  console.log(`  scoring     rec=${s.scoring.rec} passTD=${s.scoring.passTD} int=${s.scoring.int} rushYd=${s.scoring.rushYd} twoPt=${s.scoring.twoPt}`);
  console.log(`  kicker      ${s.kicker ? JSON.stringify(s.kicker) : "null  <- no K slot, per the contract"}`);
  console.log(`  defense     ${s.defense ? `sack=${s.defense.sack} int=${s.defense.interception} td=${s.defense.td} ladder=${JSON.stringify(s.defense.paLadder)}` : "null"}`);
  console.log(`  format      regWeeks=${s.format.regWeeks} playoffTeams=${s.format.playoffTeams} weeks=${s.format.playoffWeeks.join("/")} seeding=${s.format.seeding}`);
  console.log(`  acquisition waivers=${s.acquisition.waivers} faab=${s.acquisition.faabBudget} days=${s.acquisition.processDays.join(",")}`);
  console.log(`  rosterSettings:`);
  for (const [k, v] of Object.entries(s.rosterSettings)) console.log(`     ${k.padEnd(20)} ${v}`);

  console.log("\n=== syncRosters ===");
  const rosters = await plat.syncRosters(io, LEAGUE, SEASON);
  console.log(`  ${rosters.length} rosters`);
  for (const r of rosters.slice(0, 3)) {
    const starters = r.players.filter((p) => p.slot !== "BE" && p.slot !== "IR");
    console.log(`  team ${r.teamId} ${JSON.stringify(r.teamName)} owner=${r.owner} players=${r.players.length} starters=${starters.length}`);
    console.log(`     ${starters.map((p) => `${p.slot}:${p.name}`).join("  ")}`);
  }

  console.log("\n=== readTeam (ours) ===");
  const mine = await plat.readTeam(io, LEAGUE, SEASON, s.teamId!);
  console.log(`  ${mine.name} -- ${mine.roster.length} men`);
  console.log(`  ${mine.roster.map((p) => `${p.pos} ${p.name}`).join(", ")}`);

  console.log("\n=== rosterWeek(1) -- the settled week ===");
  const wk = await plat.rosterWeek!(io, LEAGUE, SEASON, 1);
  console.log(`  ${wk.length} player-weeks across ${new Set(wk.map((r) => r.teamId)).size} teams`);
  const started = wk.filter((r) => r.isStarter);
  console.log(`  starters=${started.length}  bench=${wk.length - started.length}`);
  const withPts = wk.filter((r) => r.appliedPoints !== null);
  console.log(`  rows carrying points: ${withPts.length}  (null = no entry, never a manufactured 0)`);
  const ours = started.filter((r) => r.teamId === s.teamId);
  console.log(`  our week-1 starters:`);
  for (const r of ours) console.log(`     slot ${String(r.lineupSlotId).padStart(2)} ${(r.position + " " + r.name).padEnd(28)} ${r.appliedPoints}  id=${r.platformPlayerId} team=${r.proTeam}`);
  const total = ours.reduce((a, r) => a + (r.appliedPoints ?? 0), 0);
  console.log(`  our week-1 started total: ${total.toFixed(2)}`);

}
main().catch((e) => { console.error(e); process.exit(1); });
