// TS port of the league-neutral news aggregator (was tools/build_player_news.py). FOUR feed-visible
// sources -- all direct TS fetches, no Python:
//   - ESPN PLAYER STATUS (local table)   -> category=injury     FRESHEST: 116 players, current to
//                                          the hour, and the only source that knew our own OUT man
//   - nflverse INJURIES (CSV)            -> category=injury     lags by a published week
//   - RSS HEADLINES (6 feeds)            -> category=headline  (tagged to players in the DB)
//   - SLEEPER trending add/drop (JSON)   -> category=trending  (via dynastyprocess id crosswalk)
// `news` is a SNAPSHOT (full refresh each run); `news_history` accumulates the same rows keyed by
// story so age and persistence are answerable. See the write block for why they are separate.
// Deliberately drops the nflverse depth-chart "role" source: it's a 52MB download whose rows are
// NOT shown in the feed (build_app_data filters to injury/headline/trending); the only loss is the
// board's minor "Depth" badge. Writes the news table (source of truth) + data/player-news.csv (kept
// byte-compatible so the not-yet-ported build_report can still join news into the board).
import { writeFileSync } from "node:fs";
import { fetchText, fetchCsv, pick, NFLVERSE, DPROC } from "./nflverse.js";
import { dataPath } from "./paths.js";
import { nameKey } from "../draft/values.js";
import { normalizeStatus } from "../inseason/availability.js";
import { type DB } from "../db/db.js";

const POS = new Set(["QB", "RB", "WR", "TE", "K"]);
const RSS: Record<string, string> = {
  espn: "https://www.espn.com/espn/rss/nfl/news",
  yahoo: "https://sports.yahoo.com/nfl/rss.xml",
  cbs: "https://www.cbssports.com/rss/headlines/nfl/",
  pft: "https://profootballtalk.nbcsports.com/feed/",
  rotowire: "https://www.rotowire.com/rss/news.php?sport=NFL",
  yardbarker: "https://www.yardbarker.com/rss/sport/2",
};

type NewsRow = { player: string; pos: string; team: string; category: string; severity: string; detail: string; source: string; asof: string; url: string };

function decode(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function parseRss(xml: string): { title: string; link: string; desc: string; date: string }[] {
  const out: { title: string; link: string; desc: string; date: string }[] = [];
  for (const blk of xml.split(/<item[\s>]/i).slice(1)) {
    const body = blk.slice(0, blk.search(/<\/item>/i));
    const tag = (t: string) => { const m = body.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? decode(m[1]) : ""; };
    let link = tag("link");
    if (!link) { const h = body.match(/<link[^>]*href="([^"]+)"/i); if (h) link = h[1]; } // atom-style
    out.push({ title: tag("title"), link, desc: tag("description"), date: tag("pubDate") });
  }
  return out;
}
// RSS pubDate -> full ISO timestamp (keeps the time, so the feed can show minute-level freshness);
// "" or unparseable -> the sync time (so it still sorts + shows "just now" rather than a bare label)
function isoDate(s: string): string { const d = new Date(s); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); }

export async function ingestNews(db: DB, season: number): Promise<Record<string, number>> {
  const rows: NewsRow[] = [];

  // name index from the player table (fantasy-relevant), for whole-name RSS tagging
  const players = db.prepare("SELECT name, position, nfl_team FROM player").all() as { name: string; position: string; nfl_team: string }[];
  const nameIndex = new Map<string, { name: string; pos: string; team: string }>();
  for (const p of players) if (p.name && p.name.includes(" ")) nameIndex.set(p.name.toLowerCase(), { name: p.name, pos: p.position, team: p.nfl_team || "" });

  // A: injuries (try season, fall back to season-1 -- nflverse structured data lags). REG week 1.
  let inj: Record<string, string>[] = [];
  for (const s of [season, season - 1]) { try { inj = await fetchCsv(`${NFLVERSE}/injuries/injuries_${s}.csv`); break; } catch { /* try next */ } }
  /**
   * THE LATEST PUBLISHED WEEK, NOT WEEK 1.
   *
   * This read `Number(pick(r, "week")) !== 1`, so the injury half of the feed was frozen on week 1
   * for the whole season. MEASURED 2026-09-23 (week 3): the 2026 file carried weeks 1 and 2, we
   * ingested 21 rows from week 1 and discarded 27 from week 2 -- and Michael Pittman Jr., who was
   * OUT on our own roster, appeared in week 2 as "Questionable - Foot" and was thrown away. The
   * symptom was a feed that looked healthy (12 high-severity injuries listed) while being a month
   * stale, which is worse than an empty one because nothing about it reads as broken.
   *
   * `maxWeek` rather than the current NFL week on purpose: nflverse publishes on its own schedule
   * and asking for a week it has not written yet would empty the feed every Wednesday. The week
   * actually used is REPORTED in the counts so a stale file is visible rather than inferred.
   */
  const usable = inj.filter((r) => pick(r, "season_type") === "REG"
    && ["Out", "Doubtful", "Questionable"].includes(pick(r, "report_status"))
    && POS.has(pick(r, "position")));
  /**
   * THE LATEST WEEK THAT ACTUALLY HAS USABLE ROWS -- filtered FIRST, then maxed.
   *
   * Taking the max week over all REG rows emptied the feed completely: nflverse had written week-3
   * rows with no report_status filled in yet, so `maxWeek` selected week 3 and every row failed the
   * status filter. 21 stale rows became 0 rows, which is a different bug with the same cause as the
   * one being fixed -- reasoning about the week on a population other than the one being consumed.
   */
  const injWeeks = usable.map((r) => Number(pick(r, "week"))).filter((w) => Number.isFinite(w));
  const injuryWeek = injWeeks.length ? Math.max(...injWeeks) : 0;
  for (const r of usable) {
    if (Number(pick(r, "week")) !== injuryWeek) continue;
    const status = pick(r, "report_status");
    if (!["Out", "Doubtful", "Questionable"].includes(status)) continue;
    const pos = pick(r, "position"); if (!POS.has(pos)) continue;
    const injury = pick(r, "report_primary_injury");
    rows.push({ player: pick(r, "full_name"), pos, team: pick(r, "team"), category: "injury",
      severity: status === "Questionable" ? "medium" : "high",
      detail: injury ? `${status} - ${injury}` : status, source: "nflverse-injury", asof: new Date().toISOString(), url: "" });
  }

  /**
   * B: ESPN PLAYER STATUS -- the freshest injury source we have, and it was not in the feed at all.
   *
   * `player_status` is already ingested for the lineup (`unavailableReason` reads it) and it beats
   * the nflverse half on both axes: 116 players carry a status against nflverse's 27, and it is
   * current to the hour rather than to the last PUBLISHED week. MEASURED 2026-09-23: Michael
   * Pittman Jr. was `Out - Ankle` here on 09-22 while nflverse week 2 still said
   * `Questionable - Foot`. Two sources, two different injuries -- so both are kept and each is
   * labelled, rather than one silently overwriting the other.
   *
   * SEVERITY COMES FROM `normalizeStatus`, the SAME function the lineup uses to decide who can play.
   * A second spelling of "is he out" here would be a second answer to that question, which is the
   * drift this repo keeps paying for -- IR, PUP, DNR and Out all map to OUT through one vocabulary.
   */
  const statusRows = db.prepare(
    `SELECT p.name, p.position AS pos, p.nfl_team AS team, ps.injury_status, ps.injury_body, ps.updated_at
       FROM player_status ps JOIN player p USING(player_id)
      WHERE ps.injury_status IS NOT NULL AND ps.injury_status <> ''`,
  ).all() as { name: string; pos: string; team: string; injury_status: string; injury_body: string | null; updated_at: string }[];
  let statusKept = 0;
  for (const r of statusRows) {
    if (!POS.has(r.pos)) continue;
    const norm = normalizeStatus(r.injury_status);
    if (norm === "ACTIVE") continue;                    // nothing to report about a healthy man
    rows.push({
      player: r.name, pos: r.pos, team: r.team || "", category: "injury",
      severity: norm === "OUT" ? "high" : "medium",
      detail: r.injury_body ? `${r.injury_status} - ${r.injury_body}` : r.injury_status,
      source: "espn-status", asof: r.updated_at || new Date().toISOString(), url: "",
    });
    statusKept++;
  }

  // C: RSS headlines tagged to the fantasy players they name (whole first+last match)
  /**
   * A FEED THAT FAILS MUST BE NAMED. `catch { continue; }` made a dead source indistinguishable from
   * a quiet one: six feeds are configured, and nothing anywhere said how many actually answered. The
   * failures are collected and returned in the counts, so "rotowire contributed nothing" can be told
   * apart from "rotowire is down" -- which on 2026-09-23 was the former (it fetched 5 items and
   * named no player on the board), but only a direct probe could establish that.
   */
  const feedFailed: string[] = [];
  for (const [feed, url] of Object.entries(RSS)) {
    let xml = "";
    try { xml = await fetchText(url); } catch (e) { feedFailed.push(`${feed}: ${(e as Error).message.slice(0, 60)}`); continue; }
    for (const it of parseRss(xml).slice(0, 60)) {
      const text = " " + (it.title + " " + it.desc).toLowerCase().replace(/\s+/g, " ") + " ";
      for (const [key, meta] of nameIndex) if (text.includes(" " + key + " ")) {
        rows.push({ player: meta.name, pos: meta.pos, team: meta.team, category: "headline", severity: "low",
          detail: it.title, source: `rss:${feed}`, asof: isoDate(it.date), url: it.link.replace(/,/g, "%2C") });
      }
    }
  }

  // D: Sleeper cross-league trending, via the dynastyprocess sleeper_id crosswalk
  try {
    const ids = await fetchCsv(`${DPROC}/db_playerids.csv`);
    const sMap = new Map<string, { name: string; pos: string; team: string }>();
    for (const r of ids) { const sid = pick(r, "sleeper_id"); if (sid) sMap.set(sid, { name: pick(r, "name", "merge_name", "player_name"), pos: pick(r, "position", "pos"), team: pick(r, "team") }); }
    for (const kind of ["add", "drop"] as const) {
      const list = JSON.parse(await fetchText(`https://api.sleeper.app/v1/players/nfl/trending/${kind}?limit=25`)) as { player_id: string; count: number }[];
      list.forEach((item, i) => {
        const meta = sMap.get(String(item.player_id));
        if (!meta || !meta.name || !POS.has(meta.pos)) return;
        rows.push({ player: meta.name, pos: meta.pos, team: meta.team || "", category: "trending",
          severity: i < 10 ? "medium" : "low",
          detail: `trending ${kind === "add" ? "added" : "dropped"} across leagues (Sleeper #${i + 1}, ${item.count || 0} moves)`,
          source: `sleeper:${kind}`, asof: new Date().toISOString(), url: "" });
      });
    }
  } catch { /* sleeper best-effort */ }

  // dedup by (player, category, detail, source)
  const seen = new Set<string>(); const uniq: NewsRow[] = [];
  for (const r of rows) { const k = `${r.player}|${r.category}|${r.detail}|${r.source}`; if (seen.has(k)) continue; seen.add(k); uniq.push(r); }

  // write news table (full refresh); player_id mirrors nameKey; url decoded (%2C -> ,) as Python did
  const ins = db.prepare("INSERT INTO news (player_id, player_name, pos, team, category, severity, detail, source, asof, url) VALUES (?,?,?,?,?,?,?,?,?,?)");
  /**
   * HISTORY ACCUMULATES IN `news_history`; `news` STAYS A FULL REFRESH.
   *
   * Three consumers (assemble.ts, appdata.ts, agent.ts) read `news` with `ORDER BY id` as a proxy
   * for freshness, which is only true BECAUSE the table is rebuilt each run. Letting rows pile up
   * there would quietly make the board show each player's OLDEST headline -- a stale-news bug of
   * exactly the kind just fixed in the injury half. So the serving path is left byte-identical and
   * the history lands beside it.
   *
   * `times_seen` and `first_seen` are what make "is this story building or fading" answerable:
   * a headline on its fifth consecutive ingest is a running story, one seen once is a blip, and the
   * snapshot in `news` cannot distinguish them.
   */
  const upHist = db.prepare(
    `INSERT INTO news_history (player_id, player_name, category, detail, source, severity, url, first_seen, last_seen, times_seen)
     VALUES (?,?,?,?,?,?,?,?,?,1)
     ON CONFLICT(player_id, category, detail, source) DO UPDATE SET
       last_seen = excluded.last_seen, times_seen = news_history.times_seen + 1,
       severity = excluded.severity, url = excluded.url, player_name = excluded.player_name`);
  // RETENTION. Unbounded growth would eventually make the history slower to query than it is worth,
  // and a story nobody has re-reported in three weeks is not live news. Pruned by last_seen, so a
  // long-running story is kept however old its first_seen is.
  const cutoff = new Date(Date.now() - 21 * 86400e3).toISOString();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM news").run();
    for (const r of uniq) ins.run(nameKey(r.player), r.player, r.pos, r.team, r.category, r.severity, r.detail, r.source, r.asof, r.url.replace(/%2C/g, ","));
    for (const r of uniq) upHist.run(nameKey(r.player), r.player, r.category, r.detail, r.source, r.severity, r.url.replace(/%2C/g, ","), r.asof, now);
    db.prepare("DELETE FROM news_history WHERE last_seen < ?").run(cutoff);
  })();

  // player-news.csv, byte-compatible with the Python writer (fields comma->';'; url stays %2C-encoded)
  const cols = ["player", "pos", "team", "category", "severity", "detail", "source", "asof", "url"] as const;
  const clean = (s: string) => (s || "").replace(/,/g, ";").replace(/\n/g, " ").trim();
  const lines = [cols.join(",")];
  for (const r of uniq) lines.push(cols.map((c) => clean(r[c])).join(","));
  writeFileSync(dataPath("player-news.csv"), lines.join("\n") + "\n", "utf8");

  const byCat: Record<string, number> = {};
  for (const r of uniq) byCat[r.category] = (byCat[r.category] || 0) + 1;
  /**
   * PROVENANCE IS LOGGED, NOT RETURNED. The caller does
   * `Object.values(await ingestNews(...)).reduce((a, b) => a + b, 0)` to get a ROW COUNT, which it
   * writes to `ingest_audit` -- so returning `injury_week: 2` and `feeds_ok: 6` added 8 phantom rows
   * to the audited total. The return contract is "counts BY CATEGORY" and nothing else belongs in it.
   *
   * What it says is the point, though: the week-1 injury freeze survived a whole season because
   * nothing ever printed WHICH week the injury half was on, and a silent `catch` meant nothing
   * printed whether a feed answered either.
   */
  const failNote = feedFailed.length ? `, FAILED ${feedFailed.join("; ")}` : "";
  console.log(`  news provenance: ${statusKept} injury rows from ESPN player_status (freshest);` +
    ` nflverse week ${injuryWeek || "none"} of its file` +
    ` (it publishes a week behind, so this trails the live ESPN player_status feed);` +
    ` ${Object.keys(RSS).length - feedFailed.length}/${Object.keys(RSS).length} RSS feeds answered${failNote}`);
  return byCat;
}
