// Extended public data sources (all direct TS fetch, no ESPN, no key), keyed by name_key:
//   ingestAdvanced   -> player_advanced: snap % (snap_counts) + PFR receiving efficiency (adot, yac/rec, drop%)
//   ingestTradeValues-> trade_value: dynastyprocess 1QB/2QB values (for trade analysis)
//   ingestWeekly     -> weekly_rank: FantasyPros current-week positional rankings (in-season start/sit)
import { fetchCsv, pick } from "./nflverse.js";
import { nameKey } from "../draft/values.js";
import { nowIso, type DB } from "../db/db.js";

const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
const DPROC = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";
const num = (s: string): number | null => { const n = Number(s); return Number.isFinite(n) ? n : null; };
const int = (s: string): number | null => { const n = num(s); return n == null ? null : Math.round(n); };
const knownIds = (db: DB) => new Set((db.prepare("SELECT player_id FROM player").all() as { player_id: string }[]).map((r) => r.player_id));

async function fetchSeason(urlFor: (y: number) => string, years: number[]): Promise<Record<string, string>[]> {
  for (const y of years) { try { const rows = await fetchCsv(urlFor(y)); if (rows.length) return rows; } catch { /* next */ } }
  return [];
}

// snap % (snap_counts) + PFR receiving efficiency (adot, yac/rec, drop%) -> player_advanced
export async function ingestAdvanced(db: DB, season: number): Promise<{ snap: number; pfr: number }> {
  const years = [season - 1, season - 2];
  const known = knownIds(db);

  const snapRows = await fetchSeason((y) => `${NFLVERSE}/snap_counts/snap_counts_${y}.csv`, years);
  const snapAgg = new Map<string, { sum: number; n: number }>();
  for (const r of snapRows) {
    if (pick(r, "game_type") !== "REG") continue;
    const pct = num(pick(r, "offense_pct")); if (pct == null || pct <= 0) continue;
    const k = nameKey(pick(r, "player")); if (!k) continue;
    const a = snapAgg.get(k) ?? { sum: 0, n: 0 }; a.sum += pct; a.n++; snapAgg.set(k, a);
  }

  // PFR advanced receiving is one row per player-season (all seasons in one file); take the target year
  const pfrAll = await fetchCsv(`${NFLVERSE}/pfr_advstats/advstats_season_rec.csv`).catch(() => [] as Record<string, string>[]);
  const yr = pfrAll.some((r) => num(pick(r, "season")) === years[0]) ? years[0] : years[1];
  const pfr = new Map<string, { tgt: number | null; adot: number | null; yac_r: number | null; drop: number | null }>();
  for (const r of pfrAll) {
    if (num(pick(r, "season")) !== yr) continue;
    const k = nameKey(pick(r, "player")); if (!k) continue;
    pfr.set(k, { tgt: int(pick(r, "tgt")), adot: num(pick(r, "adot")), yac_r: num(pick(r, "yac_r")), drop: num(pick(r, "drop_percent")) });
  }

  const keys = [...new Set([...snapAgg.keys(), ...pfr.keys()])].filter((k) => known.has(k));
  const up = db.prepare(
    `INSERT INTO player_advanced (player_id, season, snap_pct, targets, adot, yac_r, drop_pct, updated_at)
     VALUES (@id, @s, @snap, @tgt, @adot, @yac, @drop, @now)
     ON CONFLICT(player_id) DO UPDATE SET season=excluded.season, snap_pct=excluded.snap_pct, targets=excluded.targets,
       adot=excluded.adot, yac_r=excluded.yac_r, drop_pct=excluded.drop_pct, updated_at=excluded.updated_at`,
  );
  const now = nowIso();
  db.transaction(() => {
    db.prepare("DELETE FROM player_advanced").run();
    for (const id of keys) {
      const s = snapAgg.get(id); const p = pfr.get(id);
      up.run({ id, s: years[0], snap: s ? Math.round((s.sum / s.n) * 1000) / 1000 : null, tgt: p?.tgt ?? null, adot: p?.adot ?? null, yac: p?.yac_r ?? null, drop: p?.drop ?? null, now });
    }
  })();
  return { snap: snapAgg.size, pfr: pfr.size };
}

// dynastyprocess 1QB/2QB trade values -> trade_value
export async function ingestTradeValues(db: DB): Promise<number> {
  const known = knownIds(db);
  const rows = await fetchCsv(`${DPROC}/values-players.csv`).catch(() => [] as Record<string, string>[]);
  const up = db.prepare(
    `INSERT INTO trade_value (player_id, value_1qb, value_2qb, age, draft_year, updated_at) VALUES (@id, @v1, @v2, @age, @dy, @now)
     ON CONFLICT(player_id) DO UPDATE SET value_1qb=excluded.value_1qb, value_2qb=excluded.value_2qb, age=excluded.age, draft_year=excluded.draft_year, updated_at=excluded.updated_at`,
  );
  const now = nowIso(); let n = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM trade_value").run();
    for (const r of rows) {
      const k = nameKey(pick(r, "player")); if (!k || !known.has(k)) continue;
      up.run({ id: k, v1: int(pick(r, "value_1qb")), v2: int(pick(r, "value_2qb")), age: num(pick(r, "age")), dy: int(pick(r, "draft_year")), now }); n++;
    }
  })();
  return n;
}

// Sleeper live player status (injury designation + depth-chart order) -> player_status.
// Sleeper's /players/nfl is one big JSON object keyed by sleeper id; we keep only fantasy skill
// players already in our universe (matched by name_key), first-seen wins on name collisions.
// Sleeper: one 14.6MB fetch of /players/nfl feeds BOTH player_status (live injury/depth) and, via the
// sleeperId->name_key map it builds, the add/drop trending lists -> player_status + trending.
const SLEEPER = "https://api.sleeper.app/v1/players/nfl";
const SKILL = new Set(["QB", "RB", "WR", "TE", "K"]);
export async function ingestSleeper(db: DB): Promise<{ status: number; trending: number }> {
  const known = knownIds(db);
  let raw: Record<string, any> = {};
  try { raw = (await (await fetch(SLEEPER)).json()) as Record<string, any>; } catch { return { status: 0, trending: 0 }; }
  const xref = new Map<string, string>(); // sleeperId -> name_key (our universe)
  const upS = db.prepare(
    `INSERT INTO player_status (player_id, injury_status, injury_body, depth_order, roster_status, updated_at)
     VALUES (@id, @inj, @body, @depth, @st, @now)
     ON CONFLICT(player_id) DO UPDATE SET injury_status=excluded.injury_status, injury_body=excluded.injury_body,
       depth_order=excluded.depth_order, roster_status=excluded.roster_status, updated_at=excluded.updated_at`,
  );
  const now = nowIso(); let status = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM player_status").run();
    const seen = new Set<string>();
    for (const [sid, p] of Object.entries(raw)) {
      if (!p || !SKILL.has(p.position)) continue;
      const k = nameKey(p.full_name ?? "");
      if (!k || !known.has(k)) continue;
      if (!xref.has(sid)) xref.set(sid, k);
      if (seen.has(k)) continue; seen.add(k);
      // Sleeper marks retired/free players injury_status="NA"; treat that as no active designation
      const inj = p.injury_status && p.injury_status !== "NA" ? p.injury_status : null;
      upS.run({ id: k, inj, body: p.injury_body_part || null, depth: p.depth_chart_order ?? null, st: p.status || null, now }); status++;
    }
  })();

  const upT = db.prepare(`INSERT OR REPLACE INTO trending (player_id, kind, count, scraped) VALUES (@id, @kind, @c, @now)`);
  const trows: { id: string; kind: string; c: number; now: string }[] = [];
  for (const kind of ["add", "drop"]) {
    try {
      const arr = (await (await fetch(`${SLEEPER}/trending/${kind}?lookback_hours=24&limit=200`)).json()) as { player_id: string; count: number }[];
      for (const t of arr ?? []) { const k = xref.get(String(t.player_id)); if (k) trows.push({ id: k, kind, c: t.count, now }); }
    } catch { /* skip this list */ }
  }
  let trending = 0;
  db.transaction(() => { db.prepare("DELETE FROM trending").run(); for (const r of trows) { upT.run(r); trending++; } })();
  return { status, trending };
}

// Fantasy Football Calculator real draft-market ADP -> adp. scoring picks the FFC format.
const FFC_FMT: Record<string, string> = { STD: "standard", HALF: "half-ppr", PPR: "ppr" };
const FFC_TEAMS = [8, 10, 12, 14]; // sizes FFC's ADP API publishes; snap the league size to the nearest
export async function ingestAdp(db: DB, season: number, scoring = "HALF", teams = 12): Promise<number> {
  const known = knownIds(db);
  const fmt = FFC_FMT[scoring] ?? "half-ppr";
  const t = FFC_TEAMS.reduce((best, n) => Math.abs(n - teams) < Math.abs(best - teams) ? n : best, 12);
  let data: any = {};
  try { data = await (await fetch(`https://fantasyfootballcalculator.com/api/v1/adp/${fmt}?teams=${t}&year=${season}`)).json(); } catch { return 0; }
  const up = db.prepare(
    `INSERT INTO adp (player_id, adp, high, low, stdev, times_drafted, scoring, scraped) VALUES (@id, @adp, @hi, @lo, @sd, @td, @sc, @now)
     ON CONFLICT(player_id) DO UPDATE SET adp=excluded.adp, high=excluded.high, low=excluded.low, stdev=excluded.stdev,
       times_drafted=excluded.times_drafted, scoring=excluded.scoring, scraped=excluded.scraped`,
  );
  const now = nowIso(); let n = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM adp").run();
    const seen = new Set<string>();
    for (const p of data.players ?? []) {
      const k = nameKey(p.name ?? ""); if (!k || !known.has(k) || seen.has(k)) continue; seen.add(k);
      up.run({ id: k, adp: num(String(p.adp)), hi: int(String(p.high)), lo: int(String(p.low)), sd: num(String(p.stdev)), td: int(String(p.times_drafted)), sc: fmt, now }); n++;
    }
  })();
  return n;
}

// FantasyCalc real-trade market values + 30-day momentum -> market_value.
const FC_PPR: Record<string, number> = { STD: 0, HALF: 0.5, PPR: 1 };
export async function ingestMarketValue(db: DB, scoring = "HALF", teams = 12, numQbs = 1): Promise<number> {
  const known = knownIds(db);
  const ppr = FC_PPR[scoring] ?? 0.5;
  let arr: any[] = [];
  try { arr = await (await fetch(`https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=${numQbs}&numTeams=${teams}&ppr=${ppr}`)).json(); } catch { return 0; }
  const up = db.prepare(
    `INSERT INTO market_value (player_id, value, overall_rank, pos_rank, trend_30d, adp, tier, sleeper_id, espn_id, updated_at)
     VALUES (@id, @val, @orank, @prank, @trend, @adp, @tier, @sid, @eid, @now)
     ON CONFLICT(player_id) DO UPDATE SET value=excluded.value, overall_rank=excluded.overall_rank, pos_rank=excluded.pos_rank,
       trend_30d=excluded.trend_30d, adp=excluded.adp, tier=excluded.tier, sleeper_id=excluded.sleeper_id, espn_id=excluded.espn_id, updated_at=excluded.updated_at`,
  );
  const now = nowIso(); let n = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM market_value").run();
    const seen = new Set<string>();
    for (const r of arr ?? []) {
      const pl = r.player ?? {}; const k = nameKey(pl.name ?? ""); if (!k || !known.has(k) || seen.has(k)) continue; seen.add(k);
      up.run({
        id: k, val: r.value ?? null, orank: r.overallRank ?? null, prank: r.positionRank ?? null, trend: r.trend30Day ?? null,
        adp: r.maybeAdp ?? null, tier: r.maybeTier ?? null, sid: pl.sleeperId != null ? String(pl.sleeperId) : null, eid: pl.espnId != null ? String(pl.espnId) : null, now,
      }); n++;
    }
  })();
  return n;
}

// Vegas implied team totals from ESPN's free odds feed -> team_odds. implied = total/2 +/- line/2.
const ESPN_SB = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export async function ingestOdds(db: DB): Promise<number> {
  let data: any = { events: [] };
  try { data = await (await fetch(ESPN_SB)).json(); } catch { return 0; }
  const up = db.prepare(
    `INSERT INTO team_odds (team, opponent, spread, total, implied_total, updated_at) VALUES (@team, @opp, @sp, @tot, @imp, @now)
     ON CONFLICT(team) DO UPDATE SET opponent=excluded.opponent, spread=excluded.spread, total=excluded.total,
       implied_total=excluded.implied_total, updated_at=excluded.updated_at`,
  );
  const now = nowIso(); let n = 0;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  db.transaction(() => {
    db.prepare("DELETE FROM team_odds").run();
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0]; const o = comp?.odds?.[0];
      if (!comp || !o || o.overUnder == null) continue;
      const total = Number(o.overUnder); const line = Math.abs(Number(o.spread) || 0);
      const home = comp.competitors?.find((c: any) => c.homeAway === "home");
      const away = comp.competitors?.find((c: any) => c.homeAway === "away");
      if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
      const homeFav = !!o.homeTeamOdds?.favorite;
      const homeImp = homeFav ? total / 2 + line / 2 : total / 2 - line / 2;
      const awayImp = total - homeImp;
      const rec = (team: string, opp: string, imp: number, fav: boolean) =>
        up.run({ team, opp, sp: fav ? -line : line, tot: total, imp: r1(imp), now });
      rec(home.team.abbreviation, away.team.abbreviation, homeImp, homeFav);
      rec(away.team.abbreviation, home.team.abbreviation, awayImp, !homeFav);
      n += 2;
    }
  })();
  return n;
}

// Boris Chen positional draft tiers (GMM clusters of expert consensus) -> boris_tier.
// Season-long tiers come only as text ("Tier N: Name, Name, ..."); RB/WR/TE have scoring variants
// (STD = no suffix, HALF = -HALF, PPR = -PPR), QB is scoring-agnostic. DST/K skipped (team-name
// nicknames don't key cleanly and their tiers carry little draft signal).
const BC = "https://s3-us-west-1.amazonaws.com/fftiers/out";
const BC_POS: [string, boolean][] = [["QB", false], ["RB", true], ["WR", true], ["TE", true]];
export async function ingestBorisTiers(db: DB, scoring = "HALF"): Promise<number> {
  const known = knownIds(db);
  const suffix = scoring === "STD" ? "" : `-${scoring}`;
  const up = db.prepare(
    `INSERT OR REPLACE INTO boris_tier (player_id, pos, tier, pos_rank, scoring, scraped) VALUES (@id, @pos, @tier, @pr, @sc, @now)`,
  );
  const now = nowIso();
  const rows: { id: string; pos: string; tier: number; pr: number; sc: string; now: string }[] = [];
  for (const [pos, hasScoring] of BC_POS) {
    const file = hasScoring && suffix ? `text_${pos}${suffix}.txt` : `text_${pos}.txt`;
    let txt = "";
    try { const r = await fetch(`${BC}/${file}`); if (!r.ok) continue; txt = await r.text(); } catch { continue; }
    let rank = 0;
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^Tier (\d+):\s*(.+)$/);
      if (!m) continue;
      const tier = Number(m[1]);
      for (const raw of m[2].split(",")) {
        const name = raw.trim(); if (!name) continue;
        rank++;
        const k = nameKey(name);
        if (!k || !known.has(k)) continue;
        rows.push({ id: k, pos, tier, pr: rank, sc: scoring, now });
      }
    }
  }
  db.transaction(() => {
    db.prepare("DELETE FROM boris_tier").run();
    for (const r of rows) up.run(r);
  })();
  return rows.length;
}

// FantasyPros current-week positional rankings -> weekly_rank
export async function ingestWeekly(db: DB): Promise<number> {
  const rows = await fetchCsv(`${DPROC}/fp_latest_weekly.csv`).catch(() => [] as Record<string, string>[]);
  const scraped = rows[0] ? pick(rows[0], "scrape_date") : "";
  const up = db.prepare(`INSERT OR REPLACE INTO weekly_rank (player_id, pos, rank, ecr, best, worst, sd, scraped) VALUES (@id, @pos, @rank, @ecr, @best, @worst, @sd, @sc)`);
  let n = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM weekly_rank").run();
    const seen = new Set<string>();
    for (const r of rows) {
      const k = nameKey(pick(r, "player_name")); const pos = pick(r, "pos");
      if (!k || !pos) continue; const pk = `${k}|${pos}`; if (seen.has(pk)) continue; seen.add(pk);
      up.run({ id: k, pos, rank: int(pick(r, "rank")), ecr: num(pick(r, "ecr")), best: int(pick(r, "best")), worst: int(pick(r, "worst")), sd: num(pick(r, "sd")), sc: scraped }); n++;
    }
  })();
  return n;
}
