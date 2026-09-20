/**
 * ONBOARD A LEAGUE THROUGH ITS ADAPTOR -- `npx tsx scripts/platform-onboard.ts --platform <id> --league <id> [--season Y] [--write]`
 *
 * WHY THIS EXISTS. `Platform.syncSettings` is the contract's "read this league's rules" method, and
 * until now NOTHING CALLED IT from a terminal: the CLI's `ff sync-settings` is a separate, ESPN-only
 * Playwright body that refuses every other platform by name. So an adaptor could satisfy the whole
 * contract and still have no way to put its league in the store -- the same shape of gap that
 * `registerPlatform` closed for the registry.
 *
 * DRY RUN BY DEFAULT. It prints exactly what it would write and changes nothing without `--write`,
 * because the store is shared with a live league on a game day.
 *
 * IT NEVER TOUCHES `active_league`. A second league appearing in the store must not silently become
 * the one every flagless verb answers for. `setConfig` mirrors to the legacy `config` key ONLY for
 * the active league, so an inactive onboard cannot disturb the incumbent's config either.
 */
import Database from "better-sqlite3";
import { platformFor, publicPlatformIO, bridgePlatformIO, knownPlatforms, type PlatformIO } from "../src/league/platform.js";
import { slotEligibility } from "../src/draft/slots.js";
import { valueKey } from "../src/data/formatKey.js";

const argv = process.argv.slice(2);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const platformId = val("--platform");
const leagueId = val("--league");
const season = Number(val("--season") ?? new Date().getFullYear());
const dbPath = val("--db") ?? "data/ff.db";
const write = argv.includes("--write");

if (!platformId || !leagueId) {
  console.error("usage: platform-onboard --platform <id> --league <id> [--season Y] [--db F] [--write]");
  console.error(`known platforms: ${knownPlatforms().join(", ")}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const plat = await platformFor(platformId);

  /**
   * WHICH TRANSPORT. A platform that declares a `webview` keeps its login in the desktop app, so its
   * reads must go through the bridge; one that does not is public and takes a plain fetch. Choosing
   * on the DECLARATION rather than on the platform's name means a fourth adaptor gets the right
   * transport without editing this line.
   */
  const io: PlatformIO = plat.webview ? bridgePlatformIO(plat.host) : publicPlatformIO();
  console.log(`platform ${plat.id} | host ${plat.host} | transport ${plat.webview ? "app bridge (login required)" : "public fetch (no session)"}`);

  const s = await plat.syncSettings(io, leagueId!, season);
  const flexOk = slotEligibility("FLEX");

  const cfg = {
    season: s.season,
    teams: s.teams,
    budget: s.budget,
    slots: s.slots,
    flex_ok: flexOk,
    format: s.format,
    playoffTeams: s.format.playoffTeams,
    regWeeks: s.format.regWeeks,
    scoring: s.scoringBucket,
    draftType: s.draftType,
    scoring_rules: s.scoring,
    // A KEY INPUT, not decoration: valueKey hashes it, so a dynasty league cannot silently share a
    // redraft league's trained value book and golden master. Absent keys exactly as before.
    leagueType: s.leagueType ?? undefined,
    kicker: s.kicker,
    defense: s.defense,
    rosterSettings: s.rosterSettings,
    acquisition: s.acquisition,
    provenance: s.provenance,
  };

  console.log(`\nWOULD WRITE league row:`);
  console.log(`  league_id ${s.leagueId} | platform ${s.platform} | name ${JSON.stringify(s.name)} | season ${s.season} | team_id ${s.teamId ?? "(null -- kept)"}`);
  console.log(`\nWOULD WRITE config:${s.leagueId}:`);
  console.log(`  teams ${cfg.teams} | draftType ${cfg.draftType} | budget ${cfg.budget} | bucket ${cfg.scoring}`);
  console.log(`  slots ${cfg.slots.join(" ")}`);
  console.log(`  flex_ok ${cfg.flex_ok.join("/")}`);
  console.log(`  kicker ${cfg.kicker ? "present" : "null"} | defense ${cfg.defense ? "present" : "null"}`);
  console.log(`  leagueType ${cfg.leagueType ?? "(not reported -- keys as redraft)"} | valueKey ${valueKey(cfg as never)}`);
  console.log(`  format regWeeks ${cfg.regWeeks} playoffTeams ${cfg.playoffTeams} weeks ${s.format.playoffWeeks.join("/")}`);

  if (!write) { console.log("\nDRY RUN -- nothing written. Pass --write to commit."); return; }

  const db = new Database(dbPath);
  try {
    const active = (db.prepare("SELECT value FROM settings WHERE key='active_league'").get() as { value?: string } | undefined)?.value ?? null;
    db.prepare(
      "INSERT INTO league (league_id, platform, name, season, team_id, scoring_json, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(league_id) DO UPDATE SET platform=excluded.platform, name=COALESCE(excluded.name, league.name), " +
      // team_id is COALESCEd: a read that cannot see our seat returns null, which means "cannot tell",
      // never "we have no team". Blanking it breaks every verb that needs it and still looks like success.
      "season=excluded.season, team_id=COALESCE(excluded.team_id, league.team_id), scoring_json=excluded.scoring_json, last_synced_at=excluded.last_synced_at",
    ).run(s.leagueId, s.platform, s.name ?? null, s.season, s.teamId ?? null, JSON.stringify({ provenance: s.provenance, rosterSettings: s.rosterSettings }), new Date().toISOString());

    const key = `config:${s.leagueId}`;
    const prev = (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined)?.value;
    const merged = JSON.stringify({ ...(prev ? JSON.parse(prev) : {}), ...cfg });
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, merged, new Date().toISOString());

    console.log(`\nWROTE league ${s.leagueId} and ${key}.`);
    console.log(`active_league is still ${JSON.stringify(active)} -- deliberately UNCHANGED, so every flagless verb still answers for it.`);
  } finally { db.close(); }
}

main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
