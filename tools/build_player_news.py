# LAYER 1 -- GENERAL, league-neutral player fantasy-news aggregator. Pulls MULTIPLE sources and
# writes ONE per-player feed with a source-agnostic schema; it makes NO league/scoring/roster
# assumptions (that tailoring is Layer 2 -- `ff news`). Sources here:
#   - nflverse INJURIES  (structured, player-keyed): report status + injury  -> category=injury
#   - nflverse DEPTH CHARTS (structured): pos_rank                            -> category=role
#   - RSS HEADLINES (ESPN, Yahoo, CBS, PFT/NBC, RotoWire, Yardbarker)         -> category=headline
#   - SLEEPER trending add/drop (cross-league "buzz")                         -> category=trending
# Schema: player,pos,team,category,severity,detail,source,asof
#   severity: high | medium | low   (a source-neutral importance hint; the tailoring layer decides
#             what to DO with it per league)
# Run: uv run --with nflreadpy --with polars --with feedparser --with requests tools/build_player_news.py [--week N]
import os, sys, re, datetime
import polars as pl
import nflreadpy as nfl
import feedparser
import requests
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

SEASON = 2026  # the season being drafted (today). nflverse structured data may lag by a season.
WEEK = 1       # injuries: week-1 REG = the season-opener / draft-time status (no preseason feed)
if "--week" in sys.argv:
    WEEK = int(sys.argv[sys.argv.index("--week") + 1])
POS = ["QB", "RB", "WR", "TE", "K"]
RSS = {
    "espn": "https://www.espn.com/espn/rss/nfl/news",
    "yahoo": "https://sports.yahoo.com/nfl/rss.xml",
    "cbs": "https://www.cbssports.com/rss/headlines/nfl/",
    "pft": "https://profootballtalk.nbcsports.com/feed/",
    "rotowire": "https://www.rotowire.com/rss/news.php?sport=NFL",  # player-note style
    "yardbarker": "https://www.yardbarker.com/rss/sport/2",
}

rows = []  # list of dicts with the schema keys

# --- Source A: injuries (latest report at the target week). nflverse injury data lags -- if this
# season is not loaded yet, there is simply no structured injury feed; current injuries then come
# only from the live RSS headlines below (that is honest, not a bug). ---
inj_season = SEASON
try:
    inj = to_pl(nfl.load_injuries(seasons=[SEASON]))
except Exception:
    inj_season = SEASON - 1  # structured injuries lag; fall back to last season's, labelled as such
    try:
        inj = to_pl(nfl.load_injuries(seasons=[inj_season]))
    except Exception:
        inj = None
if inj is not None:
    inj = inj.filter((pl.col("season_type") == "REG") & (pl.col("week") == WEEK))
    inj = inj.filter(pl.col("report_status").is_in(["Out", "Doubtful", "Questionable"]))
    for gsis, player, pos, team, status, injury in inj.select(
        ["gsis_id", "full_name", "position", "team", "report_status", "report_primary_injury"]
    ).rows():
        if pos not in POS:
            continue
        sev = "high" if status in ("Out", "Doubtful") else "medium"
        detail = f"{status} - {injury}" if injury else status
        rows.append(dict(player=player, pos=pos, team=team or "", category="injury", severity=sev,
                         detail=detail, source="nflverse-injury", asof=f"{inj_season} wk{WEEK}"))

# --- Source B: depth-chart role (most recent snapshot per player) ---
try:
    dc = to_pl(nfl.load_depth_charts(seasons=[SEASON]))
except Exception:
    dc = to_pl(nfl.load_depth_charts(seasons=[SEASON - 1]))
dc = dc.filter(pl.col("pos_abb").is_in(POS)).sort("dt").unique(subset=["gsis_id"], keep="last")
# a name index of fantasy-relevant players (for RSS tagging) + emit role rows for backups.
# severity is a GENERAL fantasy-relevance hint (not a specific league's roster): a QB/TE/K at depth 2
# is a real backup, but an RB2/WR2 usually still starts -- so RB/WR only get concerning at depth 3+.
def role_sev(pos, depth):
    if pos in ("QB", "TE", "K"):
        return "high" if depth >= 3 else "medium"
    if depth >= 4:
        return "high"
    return "medium" if depth >= 3 else "low"

name_index = {}  # normalized "first last" -> (player, pos, team)
for player, pos, team, depth in dc.select(["player_name", "pos_abb", "team", "pos_rank"]).rows():
    if not player:
        continue
    name_index[player.lower()] = (player, pos, team or "")
    if depth is not None and depth >= 2:
        rows.append(dict(player=player, pos=pos, team=team or "", category="role", severity=role_sev(pos, depth),
                         detail=f"depth {depth} at {pos}", source="nflverse-depth", asof=f"{SEASON}"))

# --- Source C: RSS headlines, tagged to the fantasy players they name ---
# whole-name match (first AND last) to cut false positives from shared surnames.
def tag_players(text):
    t = " " + re.sub(r"\s+", " ", text.lower()) + " "
    hits = []
    for key, meta in name_index.items():
        if " " in key and (" " + key + " ") in t:
            hits.append(meta)
    return hits

for feed, url in RSS.items():
    try:
        d = feedparser.parse(url)
    except Exception as e:
        print(f"rss {feed}: ERR {str(e)[:60]}", file=sys.stderr)
        continue
    for e in d.entries[:60]:
        title = (e.get("title") or "").strip()
        summary = re.sub("<[^>]+>", " ", e.get("summary") or "")
        when = ""
        if e.get("published_parsed"):
            when = datetime.date(*e.published_parsed[:3]).isoformat()
        for player, pos, team in tag_players(title + " " + summary):
            rows.append(dict(player=player, pos=pos, team=team, category="headline", severity="low",
                             detail=title, source=f"rss:{feed}", asof=when or "recent"))

# --- Source D: Sleeper cross-league trending adds/drops (what managers everywhere are moving) ---
# Map Sleeper player_id -> name/pos/team via nflverse ff_playerids (the id crosswalk).
try:
    ids = to_pl(nfl.load_ff_playerids()).filter(pl.col("sleeper_id").is_not_null())
    sleeper_map = {}
    for sid, name, pos, team in ids.select(["sleeper_id", "name", "position", "team"]).rows():
        if sid is not None:
            sleeper_map[str(sid)] = (name, pos, team)
    for kind in ("add", "drop"):
        r = requests.get(f"https://api.sleeper.app/v1/players/nfl/trending/{kind}?limit=25", timeout=20)
        for i, item in enumerate(r.json()):
            meta = sleeper_map.get(str(item.get("player_id")))
            if not meta:
                continue
            name, pos, team = meta
            if pos not in POS:
                continue
            verb = "added" if kind == "add" else "dropped"
            rows.append(dict(player=name, pos=pos, team=team or "", category="trending",
                             severity="medium" if i < 10 else "low",
                             detail=f"trending {verb} across leagues (Sleeper #{i + 1}, {item.get('count', 0)} moves)",
                             source=f"sleeper:{kind}", asof="recent"))
except Exception as e:
    print(f"sleeper trending: ERR {str(e)[:70]}", file=sys.stderr)

# --- write the unified league-neutral feed ---
def clean(s):
    return (str(s) if s is not None else "").replace(",", ";").replace("\n", " ").strip()

# dedupe identical (player, category, detail, source) rows
seen, uniq = set(), []
for r in rows:
    k = (r["player"], r["category"], r["detail"], r["source"])
    if k in seen:
        continue
    seen.add(k)
    uniq.append(r)

os.makedirs("data", exist_ok=True)
cols = ["player", "pos", "team", "category", "severity", "detail", "source", "asof"]
with open("data/player-news.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write(",".join(cols) + "\n")
    for r in uniq:
        f.write(",".join(clean(r[c]) for c in cols) + "\n")

by_cat = {}
for r in uniq:
    by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
print(f"wrote data/player-news.csv: {len(uniq)} items -> {by_cat}")
