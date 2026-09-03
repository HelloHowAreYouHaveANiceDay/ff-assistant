// TS port of the league-neutral news aggregator (was tools/build_player_news.py). Three feed-visible
// sources -- all direct TS fetches, no Python:
//   - nflverse INJURIES (CSV)            -> category=injury
//   - RSS HEADLINES (6 feeds)            -> category=headline  (tagged to players in the DB)
//   - SLEEPER trending add/drop (JSON)   -> category=trending  (via dynastyprocess id crosswalk)
// Deliberately drops the nflverse depth-chart "role" source: it's a 52MB download whose rows are
// NOT shown in the feed (build_app_data filters to injury/headline/trending); the only loss is the
// board's minor "Depth" badge. Writes the news table (source of truth) + data/player-news.csv (kept
// byte-compatible so the not-yet-ported build_report can still join news into the board).
import { writeFileSync } from "node:fs";
import { fetchText, fetchCsv, pick } from "./nflverse.js";
import { nameKey } from "../draft/values.js";
import { type DB } from "../db/db.js";

const POS = new Set(["QB", "RB", "WR", "TE", "K"]);
const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
const DPROC = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";
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
// RSS pubDate -> ISO date (best-effort); "" -> "recent"
function isoDate(s: string): string { if (!s) return "recent"; const d = new Date(s); return Number.isNaN(d.getTime()) ? "recent" : d.toISOString().slice(0, 10); }

export async function ingestNews(db: DB, season: number): Promise<Record<string, number>> {
  const rows: NewsRow[] = [];

  // name index from the player table (fantasy-relevant), for whole-name RSS tagging
  const players = db.prepare("SELECT name, position, nfl_team FROM player").all() as { name: string; position: string; nfl_team: string }[];
  const nameIndex = new Map<string, { name: string; pos: string; team: string }>();
  for (const p of players) if (p.name && p.name.includes(" ")) nameIndex.set(p.name.toLowerCase(), { name: p.name, pos: p.position, team: p.nfl_team || "" });

  // A: injuries (try season, fall back to season-1 -- nflverse structured data lags). REG week 1.
  let inj: Record<string, string>[] = []; let injSeason = season;
  for (const s of [season, season - 1]) { try { inj = await fetchCsv(`${NFLVERSE}/injuries/injuries_${s}.csv`); injSeason = s; break; } catch { /* try next */ } }
  for (const r of inj) {
    if (pick(r, "season_type") !== "REG" || Number(pick(r, "week")) !== 1) continue;
    const status = pick(r, "report_status");
    if (!["Out", "Doubtful", "Questionable"].includes(status)) continue;
    const pos = pick(r, "position"); if (!POS.has(pos)) continue;
    const injury = pick(r, "report_primary_injury");
    rows.push({ player: pick(r, "full_name"), pos, team: pick(r, "team"), category: "injury",
      severity: status === "Questionable" ? "medium" : "high",
      detail: injury ? `${status} - ${injury}` : status, source: "nflverse-injury", asof: `${injSeason} wk1`, url: "" });
  }

  // C: RSS headlines tagged to the fantasy players they name (whole first+last match)
  for (const [feed, url] of Object.entries(RSS)) {
    let xml = ""; try { xml = await fetchText(url); } catch { continue; }
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
          source: `sleeper:${kind}`, asof: "recent", url: "" });
      });
    }
  } catch { /* sleeper best-effort */ }

  // dedup by (player, category, detail, source)
  const seen = new Set<string>(); const uniq: NewsRow[] = [];
  for (const r of rows) { const k = `${r.player}|${r.category}|${r.detail}|${r.source}`; if (seen.has(k)) continue; seen.add(k); uniq.push(r); }

  // write news table (full refresh); player_id mirrors nameKey; url decoded (%2C -> ,) as Python did
  const ins = db.prepare("INSERT INTO news (player_id, player_name, pos, team, category, severity, detail, source, asof, url) VALUES (?,?,?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    db.prepare("DELETE FROM news").run();
    for (const r of uniq) ins.run(nameKey(r.player), r.player, r.pos, r.team, r.category, r.severity, r.detail, r.source, r.asof, r.url.replace(/%2C/g, ","));
  })();

  // player-news.csv, byte-compatible with the Python writer (fields comma->';'; url stays %2C-encoded)
  const cols = ["player", "pos", "team", "category", "severity", "detail", "source", "asof", "url"] as const;
  const clean = (s: string) => (s || "").replace(/,/g, ";").replace(/\n/g, " ").trim();
  const lines = [cols.join(",")];
  for (const r of uniq) lines.push(cols.map((c) => clean(r[c])).join(","));
  writeFileSync("data/player-news.csv", lines.join("\n") + "\n", "utf8");

  const byCat: Record<string, number> = {};
  for (const r of uniq) byCat[r.category] = (byCat[r.category] || 0) + 1;
  return byCat;
}
