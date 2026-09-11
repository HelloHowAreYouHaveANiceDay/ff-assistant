/**
 * PROSPECT FEATURE DERIVATION -- turn the raw combine + college-production tables into the per-player
 * rookie priors the projection's history-based features cannot supply, written to `feat_player_prospect`.
 *
 *  - ATHLETIC (RAS-like): a 0-10 position-relative percentile composite of the combine drills, from
 *    raw_combine resolved to player_sk via the clean pfr crosswalk. Lower-is-better drills (forty,
 *    cone, shuttle) are inverted so 10 = elite on every axis.
 *  - COLLEGE (Dominator / Breakout Age): from raw_college_player_season + team totals, crosswalked to
 *    player_sk by name+school+year through the combine bridge, with a school-alias map. Dominator =
 *    peak-season 0.8*yards-share + 0.2*TD-share of team offense; Breakout Age = age at the first season
 *    that cleared a 20% dominator (needs draft age; null when unavailable).
 *
 * The college crosswalk is name-based and imperfect (~82% before aliases); `college_match` records the
 * tier so a consumer can gate on it, and the builder reports the resolved rate.
 */
import { openDb, nowIso, type DB } from "../db/db.js";

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

const htToInches = (ht: string | null): number | null => {
  if (!ht) return null; const m = /^(\d+)-(\d+)$/.exec(ht); return m ? Number(m[1]) * 12 + Number(m[2]) : null;
};

/** combine `school` vs cfbfastR `team` name variants, normalized. Lifts the crosswalk hit-rate.
 *  Applied AFTER the word-expansions in canonSchool, so keys are already st->state etc. */
const SCHOOL_ALIAS: Record<string, string> = {
  "ole miss": "mississippi", "usc": "southern california", "pitt": "pittsburgh", "uconn": "connecticut",
  "smu": "southern methodist", "tcu": "texas christian", "ucf": "central florida", "utsa": "texas san antonio",
  "unlv": "nevada las vegas", "byu": "brigham young", "lsu": "louisiana state", "miami fl": "miami",
  "miami oh": "miami ohio", "southern miss": "southern mississippi", "fiu": "florida international",
  "app state": "appalachian state", "middle tennessee state": "middle tennessee",
  "texassan antonio": "texas san antonio", "texasel paso": "texas el paso", "utep": "texas el paso",
  "lamonroe": "louisiana monroe", "ul monroe": "louisiana monroe", "louisianalafayette": "louisiana",
  "ul lafayette": "louisiana", "northwestern st la": "northwestern state",
};
/** combine abbreviates where cfbfastR spells out -- expand the systematic ones (St->State is by far
 *  the biggest miss: Ohio St vs Ohio State), THEN apply the explicit alias table. */
const canonSchool = (s: string | null): string => {
  const n = norm(s)
    .replace(/\bst\b/g, "state")     // Ohio St -> Ohio State (the dominant miss)
    .replace(/\beast\b/g, "eastern") // East Washington -> Eastern Washington
    .replace(/\bwest\b/g, "western") // West Michigan -> Western Michigan
    .replace(/\bcol\b/g, "college"); // Boston Col -> Boston College
  return SCHOOL_ALIAS[n] ?? n;
};

type Combine = { player_sk: number; pos: string; forty: number | null; vertical: number | null; broad_jump: number | null; cone: number | null; shuttle: number | null; bench: number | null; ht: string | null; wt: number | null };

/** Position-relative percentile [0,1] of a value within its position's sorted distribution. */
function pctRank(sorted: number[], v: number, higherBetter: boolean): number {
  // fraction of players this value beats
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  const frac = sorted.length > 1 ? lo / (sorted.length - 1) : 0.5;
  return higherBetter ? frac : 1 - frac;
}

export function buildProspectFeatures(dbPath?: string): { rows: number; athletic: number; college: number; collegeSafe: number } {
  const db: DB = openDb(dbPath);
  const now = nowIso();

  // ---- ATHLETIC: combine resolved to player_sk via pfr ----
  const combine = db.prepare(
    `SELECT CAST(xr.player_sk AS INTEGER) player_sk, c.pos, c.forty, c.vertical, c.broad_jump, c.cone, c.shuttle, c.bench, c.ht, c.wt
       FROM raw_combine c JOIN player_xref xr ON xr.source='pfr' AND xr.source_id=c.pfr_player_id
      WHERE c.pos IN ('QB','RB','WR','TE')`,
  ).all() as Combine[];
  const DRILLS: [keyof Combine, boolean][] = [["forty", false], ["vertical", true], ["broad_jump", true], ["cone", false], ["shuttle", false], ["bench", true]];
  const dist = new Map<string, Map<string, number[]>>(); // pos -> drill -> sorted values
  for (const [drill] of DRILLS) {
    for (const c of combine) {
      const v = c[drill] as number | null; if (v == null) continue;
      const byDrill = dist.get(c.pos) ?? dist.set(c.pos, new Map()).get(c.pos)!;
      (byDrill.get(drill as string) ?? byDrill.set(drill as string, []).get(drill as string)!).push(v);
    }
  }
  for (const byDrill of dist.values()) for (const arr of byDrill.values()) arr.sort((a, b) => a - b);

  const athletic = new Map<number, { pos: string; score: number | null; n: number; c: Combine }>();
  for (const c of combine) {
    let sum = 0, n = 0;
    for (const [drill, higher] of DRILLS) {
      const v = c[drill] as number | null; if (v == null) continue;
      const sorted = dist.get(c.pos)?.get(drill as string); if (!sorted) continue;
      sum += pctRank(sorted, v, higher); n++;
    }
    // keep the richest combine row if a player somehow appears twice
    const prev = athletic.get(c.player_sk);
    if (!prev || n > prev.n) athletic.set(c.player_sk, { pos: c.pos, score: n ? (sum / n) * 10 : null, n, c });
  }

  // ---- COLLEGE crosswalk: (normName, canonSchool) -> [{player_sk, draftYear}] from combine ----
  const bridge = new Map<string, { sk: number; draftYear: number }[]>();
  const bridgeName = new Map<string, { sk: number; draftYear: number }[]>();
  for (const r of db.prepare(
    `SELECT CAST(xr.player_sk AS INTEGER) sk, c.player_name, c.school, c.draft_year
       FROM raw_combine c JOIN player_xref xr ON xr.source='pfr' AND xr.source_id=c.pfr_player_id
      WHERE c.pos IN ('QB','RB','WR','TE') AND c.draft_year IS NOT NULL`,
  ).all() as { sk: number; player_name: string; school: string; draft_year: number }[]) {
    const nm = norm(r.player_name);
    (bridge.get(`${nm}|${canonSchool(r.school)}`) ?? bridge.set(`${nm}|${canonSchool(r.school)}`, []).get(`${nm}|${canonSchool(r.school)}`)!).push({ sk: r.sk, draftYear: r.draft_year });
    (bridgeName.get(nm) ?? bridgeName.set(nm, []).get(nm)!).push({ sk: r.sk, draftYear: r.draft_year });
  }
  // draft age (age at draft) for breakout age
  const draftAge = new Map<number, { age: number; year: number }>();
  for (const r of db.prepare(
    `SELECT CAST(xr.player_sk AS INTEGER) sk, d.age, d.season FROM raw_nfl_draft_pick d
       JOIN player_xref xr ON xr.source='pfr' AND xr.source_id=d.pfr_player_id WHERE d.age IS NOT NULL`,
  ).all() as { sk: number; age: number; season: number }[]) draftAge.set(r.sk, { age: r.age, year: r.season });

  // team totals for the dominator denominator
  const team = new Map<string, { ry: number; rz: number; rtd: number; ztd: number }>();
  for (const t of db.prepare("SELECT season, team, team_rec_yards, team_rush_yards, team_rec_tds, team_rush_tds FROM raw_college_team_season").all() as { season: number; team: string; team_rec_yards: number; team_rush_yards: number; team_rec_tds: number; team_rush_tds: number }[])
    team.set(`${t.season}|${t.team}`, { ry: t.team_rec_yards, rz: t.team_rush_yards, rtd: t.team_rec_tds, ztd: t.team_rush_tds });

  // resolve each college player-season to a player_sk, compute its dominator
  const bySk = new Map<number, { season: number; dom: number; match: string }[]>();
  const resolve = (nm: string, school: string, season: number): { sk: number; match: string } | null => {
    const pick = (cands: { sk: number; draftYear: number }[] | undefined): number | null => {
      if (!cands) return null;
      // the combine player drafted soonest AFTER this college season, within a 6-year window
      const after = cands.filter((c) => c.draftYear > season && c.draftYear <= season + 6).sort((a, b) => a.draftYear - b.draftYear);
      return after.length ? after[0].sk : null;
    };
    const nsy = pick(bridge.get(`${nm}|${school}`)); if (nsy != null) return { sk: nsy, match: "name+school+year" };
    const ny = pick(bridgeName.get(nm)); if (ny != null) return { sk: ny, match: "name+year" };
    return null;
  };
  for (const p of db.prepare("SELECT season, player_name, team, rec_yards, rush_yards, rec_tds, rush_tds FROM raw_college_player_season").all() as { season: number; player_name: string; team: string; rec_yards: number; rush_yards: number; rec_tds: number; rush_tds: number }[]) {
    const t = team.get(`${p.season}|${p.team}`); if (!t) continue;
    const yShare = (t.ry + t.rz) > 0 ? (p.rec_yards + p.rush_yards) / (t.ry + t.rz) : 0;
    const tdShare = (t.rtd + t.ztd) > 0 ? (p.rec_tds + p.rush_tds) / (t.rtd + t.ztd) : 0;
    const dom = 0.8 * yShare + 0.2 * tdShare;
    const hit = resolve(norm(p.player_name), canonSchool(p.team), p.season);
    if (!hit) continue;
    (bySk.get(hit.sk) ?? bySk.set(hit.sk, []).get(hit.sk)!).push({ season: p.season, dom, match: hit.match });
  }

  // ---- write feat_player_prospect ----
  const ins = db.prepare(
    `INSERT INTO feat_player_prospect (player_sk, pos, athletic_score, athletic_n, forty, vertical, broad_jump,
       cone, shuttle, bench, ht_in, wt, college_athlete_id, college_team, college_match, dominator, dominator_season, breakout_age, updated_at)
     VALUES (@sk,@pos,@score,@n,@forty,@vert,@broad,@cone,@shuttle,@bench,@ht,@wt,@cid,@cteam,@cmatch,@dom,@domSeason,@breakout,@now)
     ON CONFLICT(player_sk) DO UPDATE SET pos=excluded.pos, athletic_score=excluded.athletic_score, athletic_n=excluded.athletic_n,
       forty=excluded.forty, vertical=excluded.vertical, broad_jump=excluded.broad_jump, cone=excluded.cone, shuttle=excluded.shuttle,
       bench=excluded.bench, ht_in=excluded.ht_in, wt=excluded.wt, college_athlete_id=excluded.college_athlete_id, college_team=excluded.college_team,
       college_match=excluded.college_match, dominator=excluded.dominator, dominator_season=excluded.dominator_season,
       breakout_age=excluded.breakout_age, updated_at=excluded.updated_at`,
  );

  const allSks = new Set<number>([...athletic.keys(), ...bySk.keys()]);
  let nAthletic = 0, nCollege = 0, nCollegeSafe = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM feat_player_prospect").run(); // full refresh
    for (const sk of allSks) {
      const a = athletic.get(sk);
      const seasons = bySk.get(sk);
      let dom: number | null = null, domSeason: number | null = null, breakout: number | null = null, cmatch: string | null = null;
      if (seasons && seasons.length) {
        const peak = seasons.reduce((best, s) => (s.dom > best.dom ? s : best));
        dom = peak.dom; domSeason = peak.season;
        cmatch = peak.match; // the match tier of the season we actually report -- the right gate for trusting `dom`
        const bo = [...seasons].filter((s) => s.dom >= 0.20).sort((x, y) => x.season - y.season)[0];
        const age = draftAge.get(sk);
        if (bo && age) breakout = age.age - (age.year - bo.season); // age at Sep 1 of the breakout season
        nCollege++; if (cmatch === "name+school+year") nCollegeSafe++;
      }
      if (a) nAthletic++;
      ins.run({
        sk, pos: a?.pos ?? null, score: a?.score ?? null, n: a?.n ?? 0,
        forty: a?.c.forty ?? null, vert: a?.c.vertical ?? null, broad: a?.c.broad_jump ?? null,
        cone: a?.c.cone ?? null, shuttle: a?.c.shuttle ?? null, bench: a?.c.bench ?? null,
        ht: a ? htToInches(a.c.ht) : null, wt: a?.c.wt ?? null,
        cid: null, cteam: null, cmatch, dom, domSeason, breakout, now,
      });
    }
  })();
  db.close();
  return { rows: allSks.size, athletic: nAthletic, college: nCollege, collegeSafe: nCollegeSafe };
}
