/**
 * INJURY EPISODES AND THEIR HORIZON -- how long a man is out, given what was knowable on Friday.
 *
 * WHAT IS MISSING WITHOUT THIS. Every availability number this repo ships is a PER-TIER RATE.
 * `missProb` (rosterValue.ts) and `leadMissProb` (handcuff.ts) both read the variance model's fitted
 * games/17 for the player's rank bucket and divide the bye back out. That number knows the man's
 * tier and NOTHING about the injury he actually has: a torn Achilles in week 3 and a Questionable
 * hamstring in week 3 are the same 0.13 to it. The weekly model does better -- it reads the OUT
 * designation for the coming week -- but a designation is a one-week fact and the decisions that
 * hurt (hold the handcuff, or drop him; insure the back, or don't) are four-week decisions.
 *
 * TWO TABLES, AND THE SPLIT IS THE POINT.
 *
 *   fact_injury_episode   the EVENT and what happened after it. weeks_missed, returned_week and
 *                         snap_share_on_return are all dated AFTER the decision they would inform,
 *                         so they are the target side and no feature may read them.
 *   feat_injury_horizon   the POINT-IN-TIME view: one row per (player, season, week) in which the
 *                         player carried a report at that week's FRIDAY cutoff, holding only what
 *                         was knowable then, plus four censored targets.
 *
 * THE CUTOFF IS THIS TEAM'S OWN KICKOFF MINUS TWO DAYS, exactly as feat_player_week_context anchors
 * it. Anchoring on the league's first game instead would hand a Thursday-night player a Friday
 * report filed after he had already played. `raw_injury` rows without a date are excluded outright:
 * from 2025 the feed publishes none, and an undated filing cannot be placed on either side of a
 * cutoff. That is why this builder covers 2010-2024 and says so in its coverage rather than
 * quietly emitting a season of nulls.
 *
 * WHAT COUNTS AS "ON THE REPORT". A row with a named injury (report_primary_injury, else
 * practice_primary_injury) or a real designation. A row that names no injury and reports Full
 * Participation is a roster listing, not an injury, and starting an episode on it would fill the
 * table with healthy weeks and drag every base rate toward zero.
 *
 * WHAT COUNTS AS "MISSED". `feat_player_week.pts IS NULL AND is_bye = 0` -- he has no scored row in
 * our own weekly history for a week his team played. A bye is NEITHER missed nor played: it is
 * skipped, on both sides, so "the next four weeks" means the next four GAMES. Getting that wrong
 * would score a bye as a missed game and make every horizon look longer than it is.
 *
 * THE LIMIT, STATED. The universe is `feat_player_week`, i.e. men who appear in our weekly history
 * at least once that season. A player who tore an ACL in August and never played is invisible here.
 * That biases the sample AWAY from the longest horizons, which is the direction that matters, so
 * the fitted P(miss) is a floor rather than a middle. `scripts/injury-coverage.mjs` prints it.
 */
import { openDb, nowIso, type DB } from "../../db/db.js";
import { normPos } from "../../data/stgPlayer.js";
import { buildSourceResolver, type SourceResolver } from "./resolve.js";

/**
 * THE INJURY GROUPS, and the collapse is DECLARED here rather than fitted, so the trainer, the
 * evaluator and the copilot cannot disagree about which bucket a knee is in.
 *
 * The raw feed's `report_primary_injury` is free text with 300+ distinct values ("Knee", "right
 * Knee", "Right Knee", "Knee/Ankle"). Fitting a categorical on that gives most levels an n of one,
 * which is a fit that memorises names. The buckets below are the ones with enough episodes to
 * estimate and enough clinical difference to matter; everything else lands in "other", counted.
 */
export const INJURY_GROUPS = [
  "knee", "ankle", "hamstring", "shoulder", "foot", "concussion", "groin", "back",
  "calf", "hip", "quad", "achilles", "illness", "hand", "ribs", "neck", "other", "none",
] as const;
export type InjuryGroup = typeof INJURY_GROUPS[number];

/** Free text -> a declared bucket. Substring, lower-cased, FIRST MATCH WINS in the order listed --
 *  so "Knee/Ankle" is a knee, deliberately, and the order is the severity order rather than
 *  alphabetical. A value that matches nothing is "other" and is counted as such. */
const GROUP_PATTERNS: [InjuryGroup, string[]][] = [
  ["achilles", ["achilles"]],
  ["concussion", ["concussion", "head"]],
  ["knee", ["knee", "acl", "mcl", "patell"]],
  ["hamstring", ["hamstring"]],
  ["ankle", ["ankle"]],
  ["foot", ["foot", "toe", "heel", "plantar"]],
  ["groin", ["groin", "abdom", "core muscle", "sports hernia"]],
  ["shoulder", ["shoulder", "clavicle", "collarbone", "pectoral", "bicep", "tricep"]],
  ["back", ["back", "spine", "lumbar"]],
  ["calf", ["calf", "shin", "achilles tendon"]],
  ["hip", ["hip", "pelvis", "glute"]],
  ["quad", ["quad", "thigh", "hip flexor"]],
  ["ribs", ["rib", "chest", "lung"]],
  ["neck", ["neck", "stinger"]],
  ["hand", ["hand", "wrist", "finger", "thumb", "elbow", "forearm", "arm"]],
  ["illness", ["illness", "covid", "flu", "not injury related", "personal", "rest"]],
];

export function injuryGroup(raw: string | null | undefined): InjuryGroup {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "none";
  for (const [g, pats] of GROUP_PATTERNS) for (const p of pats) if (s.includes(p)) return g;
  return "other";
}

/** The designations the model is allowed to see, normalised. A practice-only row carries "" -- which
 *  is a real state (he is on the report and the team named no designation), not a missing value. */
export function normDesignation(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.startsWith("out")) return "Out";
  if (s.startsWith("doubt")) return "Doubtful";
  if (s.startsWith("quest")) return "Questionable";
  if (s.startsWith("prob")) return "Probable";
  return "";
}

/** Practice participation, normalised to the three states the feed actually distinguishes. */
export function normPractice(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.startsWith("did not")) return "DNP";
  if (s.startsWith("limited")) return "Limited";
  if (s.startsWith("full")) return "Full";
  if (s.startsWith("out")) return "DNP";
  return "";
}

const shiftDays = (iso: string, days: number): string => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + days * 864e5).toISOString().slice(0, 10) : iso;
};

interface Filing { week: number; team: string; pos: string; asOf: string; status: string; practice: string; primary: string; secondary: string }

/** Every dated injury filing for the season, by (week, player_sk), earliest first. */
function filings(db: DB, season: number, resolver: SourceResolver): Map<string, Filing[]> {
  const out = new Map<string, Filing[]>();
  for (const r of db.prepare(
    `SELECT week, gsis_id, full_name, position, team, report_status, practice_status, as_of,
            report_primary_injury, report_secondary_injury, practice_primary_injury, practice_secondary_injury
     FROM raw_injury WHERE season = ? AND as_of IS NOT NULL ORDER BY as_of`,
  ).all(season) as Record<string, string | number | null>[]) {
    const res = resolver.resolve({
      gsis: r.gsis_id as string | null, name: r.full_name as string | null,
      pos: r.position as string | null, team: r.team as string | null,
    });
    resolver.count("nflverse injuries (episodes)", res);
    if (res.sk == null) continue;
    const primary = String(r.report_primary_injury ?? "").trim() || String(r.practice_primary_injury ?? "").trim();
    const secondary = String(r.report_secondary_injury ?? "").trim() || String(r.practice_secondary_injury ?? "").trim();
    const status = normDesignation(r.report_status as string | null);
    const practice = normPractice(r.practice_status as string | null);
    // A row naming no injury and reporting Full participation is a roster listing. See the header.
    if (!primary && !status && practice !== "DNP" && practice !== "Limited") continue;
    const k = `${r.week}|${res.sk}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push({
      week: Number(r.week), team: String(r.team ?? ""), pos: normPos(String(r.position ?? "")),
      asOf: String(r.as_of), status, practice, primary, secondary,
    });
  }
  return out;
}

/** The latest filing at or before `cutoff`, or null. */
function at(list: Filing[] | undefined, cutoff: string): Filing | null {
  if (!list) return null;
  let best: Filing | null = null;
  for (const f of list) if (f.asOf <= cutoff && (!best || f.asOf > best.asOf)) best = f;
  return best;
}

interface PlayerWeek { week: number; played: boolean; bye: boolean; team: string; pos: string }

export interface InjuryDurationResult {
  seasons: number[];
  episodes: number;
  horizonRows: number;
  perSeason: {
    season: number; episodes: number; horizonRows: number; censoredEpisodes: number;
    withSnapOnReturn: number; missNext1: number; missNext4Observed: number;
  }[];
  byGroup: { group: string; episodes: number; meanWeeksMissed: number; censoredPct: number }[];
  resolution: { source: string; rows: number; resolved: number; byRule: Record<string, number> }[];
}

export interface BuildInjuryOpts {
  dbPath?: string;
  seasons: number[];
  /** FAULT INJECTION ONLY. Reads each week's designation from the FOLLOWING week's report -- the
   *  exact leak `scripts/injury-leak-guard.mjs` exists to catch. Never true in production; the
   *  guard asserts that turning it on MOVES the features it claims to protect, which is the only
   *  thing that distinguishes a working guard from one that cannot fail. */
  leakNextWeekDesignation?: boolean;
}

export function buildInjuryDuration(opts: BuildInjuryOpts): InjuryDurationResult {
  const db = openDb(opts.dbPath);
  const resolver = buildSourceResolver(db);
  const now = nowIso();
  const seasons = opts.seasons.slice().sort((a, b) => a - b);
  const res: InjuryDurationResult = {
    seasons: [], episodes: 0, horizonRows: 0, perSeason: [], byGroup: [], resolution: [],
  };

  // Birth dates, for `age`. player_identity is the registry the surrogate keys come from.
  const birth = new Map<number, string>();
  for (const r of db.prepare("SELECT player_sk, birthdate FROM player_identity WHERE birthdate IS NOT NULL AND birthdate <> ''").all() as { player_sk: number; birthdate: string }[]) {
    birth.set(Number(r.player_sk), r.birthdate);
  }

  const insEp = db.prepare(
    `INSERT INTO fact_injury_episode (player_sk, season, start_week, end_week, weeks_reported, team,
       position, injury_primary, injury_group, injury_secondary, first_designation, designations,
       weeks_missed, returned_week, censored, snap_share_on_return, as_of, updated_at)
     VALUES (@sk,@season,@start,@end,@wr,@team,@pos,@ip,@ig,@is,@fd,@ds,@wm,@rw,@cen,@snap,@asOf,@now)
     ON CONFLICT(player_sk, season, start_week) DO UPDATE SET
       end_week=excluded.end_week, weeks_reported=excluded.weeks_reported, team=excluded.team,
       position=excluded.position, injury_primary=excluded.injury_primary,
       injury_group=excluded.injury_group, injury_secondary=excluded.injury_secondary,
       first_designation=excluded.first_designation, designations=excluded.designations,
       weeks_missed=excluded.weeks_missed, returned_week=excluded.returned_week,
       censored=excluded.censored, snap_share_on_return=excluded.snap_share_on_return,
       as_of=excluded.as_of, updated_at=excluded.updated_at`,
  );
  const insH = db.prepare(
    `INSERT INTO feat_injury_horizon (player_sk, season, week, as_of, team, pos, episode_start_week,
       injury_primary, injury_group, injury_secondary_present, designation, practice_status,
       weeks_in_episode, weeks_missed_so_far, prior_episodes_same, prior_episodes_any, age,
       miss_next_1, miss_next_2, miss_next_3, miss_next_4, games_remaining, updated_at)
     VALUES (@sk,@season,@week,@asOf,@team,@pos,@start,@ip,@ig,@isec,@des,@prac,@wie,@wms,@pes,@pea,
       @age,@m1,@m2,@m3,@m4,@gr,@now)
     ON CONFLICT(player_sk, season, week) DO UPDATE SET
       as_of=excluded.as_of, team=excluded.team, pos=excluded.pos,
       episode_start_week=excluded.episode_start_week, injury_primary=excluded.injury_primary,
       injury_group=excluded.injury_group, injury_secondary_present=excluded.injury_secondary_present,
       designation=excluded.designation, practice_status=excluded.practice_status,
       weeks_in_episode=excluded.weeks_in_episode, weeks_missed_so_far=excluded.weeks_missed_so_far,
       prior_episodes_same=excluded.prior_episodes_same, prior_episodes_any=excluded.prior_episodes_any,
       age=excluded.age, miss_next_1=excluded.miss_next_1, miss_next_2=excluded.miss_next_2,
       miss_next_3=excluded.miss_next_3, miss_next_4=excluded.miss_next_4,
       games_remaining=excluded.games_remaining, updated_at=excluded.updated_at`,
  );

  // Episode starts SO FAR, for the two-season recurrence features. Accumulated IN THIS LOOP and
  // never seeded from the table, for two reasons that both bit:
  //
  //   1. The table's `injury_group` is the MODAL label over the whole run, which includes weeks
  //      after any horizon row inside it. Reading it back would leak. What is recorded here is the
  //      group named in the episode's own START WEEK -- the strongest label that is knowable when
  //      the episode begins.
  //   2. Seeding from a table this pass is about to rewrite counts every episode once against
  //      itself on a re-run, so the same command would give different numbers the second time.
  //
  // THE CONTRACT THAT FOLLOWS: the recurrence window only sees seasons INSIDE `seasons`. Building
  // 2019 alone reports prior_episodes_* as 0 for everyone; the CLI therefore defaults to the whole
  // 2010-2024 range, and 2010-2011 carry a naturally short lookback like any other lagged feature.
  const priorStarts = new Map<number, { season: number; week: number; group: string }[]>();

  const groupTally = new Map<string, { n: number; missed: number; censored: number }>();

  for (const season of seasons) {
    // --- the play record, from our own weekly history -----------------------------------------
    const byPlayer = new Map<number, Map<number, PlayerWeek>>();
    for (const r of db.prepare(
      `SELECT week, player_sk, pos, team, is_bye, pts FROM feat_player_week
       WHERE season = ? AND player_sk IS NOT NULL`,
    ).all(season) as { week: number; player_sk: string; pos: string; team: string; is_bye: number; pts: number | null }[]) {
      const sk = Number(r.player_sk);
      if (!Number.isInteger(sk)) continue;              // synthetic DST keys are not people
      (byPlayer.get(sk) ?? byPlayer.set(sk, new Map()).get(sk)!).set(r.week, {
        week: r.week, played: r.pts != null, bye: r.is_bye === 1,
        team: r.team ?? "", pos: normPos(r.pos ?? ""),
      });
    }
    if (!byPlayer.size) continue;
    const maxWeek = Math.max(...[...byPlayer.values()].flatMap((m) => [...m.keys()]));

    // --- the schedule, for the Friday cutoff ---------------------------------------------------
    const gameday = new Map<string, string>();
    for (const g of db.prepare(
      "SELECT week, home_team, away_team, gameday FROM raw_nfl_game WHERE season = ? AND game_type = 'REG'",
    ).all(season) as { week: number; home_team: string; away_team: string; gameday: string | null }[]) {
      if (!g.gameday) continue;
      gameday.set(`${g.home_team}|${g.week}`, g.gameday);
      gameday.set(`${g.away_team}|${g.week}`, g.gameday);
    }
    const friOf = (week: number, team: string): string | null => {
      const d = gameday.get(`${team}|${week}`);
      return d ? shiftDays(d, -2) : null;
    };

    // --- snap share on return -------------------------------------------------------------------
    const snapAt = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT week, pfr_player_id, player, position, team, offense_pct FROM raw_snap_count
       WHERE season = ? AND game_type = 'REG' AND offense_pct IS NOT NULL`,
    ).all(season) as { week: number; pfr_player_id: string; player: string; position: string; team: string; offense_pct: number }[]) {
      const r2 = resolver.resolve({ pfr: r.pfr_player_id, name: r.player, pos: r.position, team: r.team });
      resolver.count("nflverse snap counts (episodes)", r2);
      if (r2.sk != null) snapAt.set(`${r.week}|${r2.sk}`, r.offense_pct);
    }

    const reps = filings(db, season, resolver);

    // --- per player: the reported weeks, at each week's own Friday -----------------------------
    let nEp = 0, nH = 0, nCen = 0, nSnap = 0, nM1 = 0, nM4 = 0;
    db.transaction(() => {
      db.prepare("DELETE FROM fact_injury_episode WHERE season = ?").run(season);
      db.prepare("DELETE FROM feat_injury_horizon WHERE season = ?").run(season);

      for (const [sk, weeks] of byPlayer) {
        // The Friday state of every week, or null. THE ONLY PLACE A REPORT IS READ.
        const state = new Map<number, Filing>();
        for (let w = 1; w <= maxWeek; w++) {
          const pw = weeks.get(w);
          if (!pw || pw.bye) continue;
          const cutoff = friOf(w, pw.team);
          if (!cutoff) continue;
          // The leak, when injected: read the FOLLOWING week's report instead of this one's.
          const readWeek = opts.leakNextWeekDesignation ? w + 1 : w;
          const readTeam = weeks.get(readWeek)?.team ?? pw.team;
          const readCutoff = opts.leakNextWeekDesignation ? (friOf(readWeek, readTeam) ?? cutoff) : cutoff;
          const f = at(reps.get(`${readWeek}|${sk}`), readCutoff);
          if (f) state.set(w, f);
        }
        if (!state.size) continue;

        // Episodes: maximal runs of reported weeks, BRIDGING A BYE. A bye is not evidence that an
        // injury ended, and splitting on it would manufacture a second episode every ninth week.
        const reported = [...state.keys()].sort((a, b) => a - b);
        const runs: number[][] = [];
        for (const w of reported) {
          const last = runs.length ? runs[runs.length - 1][runs[runs.length - 1].length - 1] : null;
          let contiguous = false;
          if (last != null) {
            contiguous = true;
            for (let g = last + 1; g < w; g++) {
              const pw = weeks.get(g);
              if (!pw || !pw.bye) { contiguous = false; break; }   // a played/missed gap week ends it
            }
          }
          if (contiguous) runs[runs.length - 1].push(w);
          else runs.push([w]);
        }

        for (const run of runs) {
          const startWeek = run[0], endWeek = run[run.length - 1];
          const first = state.get(startWeek)!;
          // The modal named injury across the run. A run whose type changes keeps ONE row and the
          // modal label; splitting on a relabel would double-count one injury as two episodes.
          const tally = new Map<string, number>();
          for (const w of run) { const p = state.get(w)!.primary; if (p) tally.set(p, (tally.get(p) ?? 0) + 1); }
          let modal = "", best = 0;
          for (const [p, c] of tally) if (c > best) { modal = p; best = c; }
          const group = injuryGroup(modal);

          // --- the outcome. The first missed GAME inside the reported run -- a man can be
          // Questionable for two weeks, play both, and go down in the third, and that third week is
          // the one the horizon is about. Weeks outside the run are not searched: a miss six weeks
          // after the last report is a different event, and attributing it here would inflate every
          // duration. From that first miss the run of consecutive missed GAMES is counted forward
          // without bound (a bye is skipped, never counted as missed).
          let firstMiss: number | null = null;
          for (const w of run) {
            const pw = weeks.get(w);
            if (!pw || pw.bye) continue;
            if (!pw.played) { firstMiss = w; break; }
          }
          let missed = 0, returnedWeek: number | null = null, censored = 0;
          if (firstMiss != null) {
            let w = firstMiss;
            for (; w <= maxWeek; w++) {
              const pw = weeks.get(w);
              if (!pw || pw.bye) continue;
              if (pw.played) { returnedWeek = w; break; }
              missed++;
            }
            if (returnedWeek == null) censored = 1;
          }
          const desig: Record<string, string> = {};
          for (const w of run) desig[String(w)] = state.get(w)!.status;
          insEp.run({
            sk, season, start: startWeek, end: endWeek, wr: run.length,
            team: first.team, pos: first.pos || weeks.get(startWeek)?.pos || "",
            ip: modal, ig: group, is: first.secondary,
            fd: first.status, ds: JSON.stringify(desig),
            wm: missed, rw: returnedWeek, cen: censored,
            snap: returnedWeek != null ? (snapAt.get(`${returnedWeek}|${sk}`) ?? null) : null,
            asOf: first.asOf, now,
          });
          nEp++;
          if (censored) nCen++;
          if (returnedWeek != null && snapAt.has(`${returnedWeek}|${sk}`)) nSnap++;
          const gt = groupTally.get(group) ?? { n: 0, missed: 0, censored: 0 };
          gt.n++; gt.missed += missed; gt.censored += censored;
          groupTally.set(group, gt);

          // --- the horizon rows, one per reported week of the run ----------------------------
          //
          // THE INJURY LABEL ON A HORIZON ROW IS POINT-IN-TIME AND `modal` IS NOT. The first cut of
          // this fell back to the episode's modal injury when a week's own filing named nothing --
          // and `modal` is computed over the WHOLE run, so a relabel in week 9 rewrote week 6's
          // group and, through it, week 6's prior_episodes_same. scripts/injury-leak-guard.mjs
          // caught it on its first run (19 cells moved). The fallback is now the most recent NAMED
          // injury at or before this week, which is the strongest thing a Friday reader could have.
          let named = "";
          for (const [i, w] of run.entries()) {
            const f = state.get(w)!;
            if (f.primary) named = f.primary;
            const groupNow = injuryGroup(named);
            const pw = weeks.get(w)!;
            // games already missed inside this episode, strictly before w
            let missedSoFar = 0;
            for (let p = startWeek; p < w; p++) {
              const q = weeks.get(p);
              if (q && !q.bye && !q.played) missedSoFar++;
            }
            // the next k GAMES from w on, byes skipped
            const nextGames: PlayerWeek[] = [];
            for (let n = w; n <= maxWeek && nextGames.length < 4; n++) {
              const q = weeks.get(n);
              if (q && !q.bye) nextGames.push(q);
            }
            let remaining = 0;
            for (let n = w; n <= maxWeek; n++) { const q = weeks.get(n); if (q && !q.bye) remaining++; }
            const missK = (k: number): number | null => {
              if (nextGames.length < k) return null;             // censored, not zero
              for (let j = 0; j < k; j++) if (nextGames[j].played) return 0;
              return 1;
            };
            // recurrence: episodes of the same group starting STRICTLY BEFORE this week, in this
            // season or the two before it. An episode's START is knowable at its start; nothing
            // about its outcome is read here.
            const hist = priorStarts.get(sk) ?? [];
            let same = 0, any = 0;
            for (const h of hist) {
              if (h.season < season - 2 || h.season > season) continue;
              if (h.season === season && h.week >= w) continue;
              if (h.season === season && h.week === startWeek) continue;   // this very episode
              any++;
              if (h.group === groupNow) same++;
            }
            const bd = birth.get(sk);
            const kick = gameday.get(`${pw.team}|${w}`) ?? null;
            const age = bd && kick
              ? Math.round(((Date.parse(`${kick}T00:00:00Z`) - Date.parse(`${bd}T00:00:00Z`)) / (365.2425 * 864e5)) * 100) / 100
              : null;
            const m1 = missK(1), m4 = missK(4);
            insH.run({
              sk, season, week: w, asOf: friOf(w, pw.team), team: pw.team, pos: pw.pos || f.pos,
              start: startWeek, ip: named, ig: groupNow,
              isec: f.secondary ? 1 : 0, des: f.status, prac: f.practice,
              wie: i, wms: missedSoFar, pes: same, pea: any, age,
              m1, m2: missK(2), m3: missK(3), m4, gr: remaining, now,
            });
            nH++;
            if (m1 === 1) nM1++;
            if (m4 != null) nM4++;
          }
          // This episode is now prior evidence for later weeks and seasons, LABELLED BY ITS START
          // WEEK -- not by the modal, which is not knowable until the run ends. See priorStarts.
          (priorStarts.get(sk) ?? priorStarts.set(sk, []).get(sk)!)
            .push({ season, week: startWeek, group: injuryGroup(first.primary) });
        }
      }
    })();

    res.seasons.push(season);
    res.episodes += nEp; res.horizonRows += nH;
    res.perSeason.push({
      season, episodes: nEp, horizonRows: nH, censoredEpisodes: nCen,
      withSnapOnReturn: nSnap, missNext1: nM1, missNext4Observed: nM4,
    });
  }

  res.byGroup = [...groupTally.entries()].map(([group, t]) => ({
    group, episodes: t.n,
    meanWeeksMissed: t.n ? Math.round((t.missed / t.n) * 100) / 100 : 0,
    censoredPct: t.n ? Math.round((t.censored / t.n) * 1000) / 10 : 0,
  })).sort((a, b) => b.episodes - a.episodes);
  res.resolution = resolver.stats();
  db.close();
  return res;
}
