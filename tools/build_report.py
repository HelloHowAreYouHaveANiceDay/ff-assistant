# Exhaustive per-player DRAFT/SCOUTING report as a Google-Sheets-ready table. One row per player,
# sorted by OUR value, joining every signal we have:
#   OUR value + 2025 projected points (data/values.csv, data/points.csv)
#   consensus: team + FantasyPros overall rank (ECR) + ECR positional rank + Edge (ECR - our rank)
#   context: bye week (schedules), age + years experience (players), last-year points + games played
#   news: injury status + depth-chart rank + Sleeper add/drop buzz + latest headline (data/player-news.csv)
# Writes data/player-report.csv (File > Import) AND data/player-report.tsv (paste into A1).
# Run: uv run --with nflreadpy --with polars --with requests tools/build_report.py
import os, re, csv, datetime
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

SEASON = 2026            # the season being drafted (today)
LAST_YR = SEASON - 1     # last completed season, for last-year production
ASOF = datetime.date(SEASON, 9, 1)  # age reference
POS = ["QB", "RB", "WR", "TE", "K", "DST"]

def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", errors="ignore") as f:
        return list(csv.DictReader(f))

# name key mirroring src/draft/values.ts nameKey (lowercase; drop suffixes + d/st; letters only).
def nkey(s):
    s = (s or "").lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", " ", s)
    s = re.sub(r"\bd/?st\b", " ", s)
    return re.sub(r"[^a-z]", "", s)

# --- our values + projected points (both from build_projections -> exact-name join) ---
values = {r["player"]: r for r in read_csv("data/values.csv")}
points = {r["player"]: float(r["points"]) for r in read_csv("data/points.csv") if r.get("points")}

# --- last-year (LAST_YR) production + games from nflverse actuals: No-PPR points, REG games ---
lastyr_pts, lastyr_gms = {}, {}
ly = to_pl(nfl.load_player_stats(seasons=[LAST_YR])).filter(pl.col("season_type") == "REG")
def lc(n):
    return pl.col(n) if n in ly.columns else pl.lit(0)
ly = ly.with_columns((lc("passing_yards") / 25 + lc("passing_tds") * 4 - lc("passing_interceptions") * 2
                      + lc("rushing_yards") / 10 + lc("rushing_tds") * 6 + lc("receiving_yards") / 10
                      + lc("receiving_tds") * 6 - (lc("rushing_fumbles_lost") + lc("receiving_fumbles_lost")) * 2).alias("fp"))
agg = ly.group_by("player_display_name").agg([pl.col("fp").sum().alias("pts"), pl.col("week").n_unique().alias("gms")])
for name, pts, gms in agg.rows():
    k = nkey(name)
    lastyr_pts[k] = round(pts, 1)
    lastyr_gms[k] = gms

# --- consensus + per-source signals from FantasyPros ranks (ECR + expert range + ESPN/Yahoo own%) ---
rk = to_pl(nfl.load_ff_rankings())
rk = rk.filter(pl.col("page_type") == "redraft-overall").filter(pl.col("pos").is_in(POS)).unique(subset=["player"])
rk = rk.sort("ecr").with_columns((pl.col("ecr").rank("ordinal").over("pos").cast(pl.Int64)).alias("ecr_pos"))
def col_or_null(name):
    return pl.col(name) if name in rk.columns else pl.lit(None)
ecr = {}
sel = rk.select(["player", "pos", "team", "ecr", "ecr_pos",
                 col_or_null("best").alias("best"), col_or_null("worst").alias("worst"),
                 col_or_null("player_owned_avg").alias("rostered")])
for player, pos, team, e, epos, best, worst, rostered in sel.rows():
    nm = player.split()[-1] if pos == "DST" else player  # match our DST-nickname convention
    rnd = lambda x: round(x) if isinstance(x, (int, float)) else ""
    ecr[nm] = {"team": team or "", "ecr": e, "ecr_pos": f"{pos}{epos}",
               "best": rnd(best), "worst": rnd(worst), "rostered": rnd(rostered)}

# --- ESPN's own draft ranking (STANDARD scoring) via the ESPN fantasy API -> a second source rank ---
espn_rank = {}
try:
    import requests, json as _json
    _url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}/segments/0/leaguedefaults/3"
    _hdr = {"x-fantasy-filter": _json.dumps({"players": {"limit": 900, "sortDraftRanks": {"sortPriority": 1, "sortAsc": True, "value": "STANDARD"}}})}
    _r = requests.get(_url, params={"view": "kona_player_info"}, headers=_hdr, timeout=30)
    for p in _r.json().get("players", []):
        pp = p.get("player", {})
        rr = (pp.get("draftRanksByRankType", {}).get("STANDARD", {}) or {}).get("rank")
        nm = pp.get("fullName")
        if nm and rr is not None:
            espn_rank.setdefault(nkey(nm), rr)
except Exception as e:
    print(f"espn ranks: ERR {str(e)[:70]}")

# --- bye week per team (the REG week the team does not play) ---
sched = to_pl(nfl.load_schedules(seasons=[SEASON])).filter(pl.col("game_type") == "REG")
weeks_by_team = {}
for wk, home, away in sched.select(["week", "home_team", "away_team"]).rows():
    for t in (home, away):
        weeks_by_team.setdefault(t, set()).add(wk)
maxwk = max((w for ws in weeks_by_team.values() for w in ws), default=18)
bye = {t: next((w for w in range(1, maxwk + 1) if w not in ws), "") for t, ws in weeks_by_team.items()}
ALIASES = {"LAR": "LA", "LA": "LAR", "WSH": "WAS", "WAS": "WSH", "JAC": "JAX", "JAX": "JAC",
           "OAK": "LV", "SD": "LAC", "STL": "LA", "ARZ": "ARI", "CLV": "CLE", "BLT": "BAL", "HST": "HOU"}
def bye_for(team):
    return bye.get(team, bye.get(ALIASES.get(team, ""), ""))

# --- bio: age + experience + height/weight from the players table ---
def fmt_ht(h):
    # players.height may be inches (e.g. 74) or a "6-2" string -> normalize to 6'2"
    if h is None or h == "":
        return ""
    s = str(h)
    m = re.match(r"^(\d)[-'](\d{1,2})", s)
    if m:
        return f'{m.group(1)}\'{m.group(2)}"'
    try:
        inches = int(float(s))
        return f'{inches // 12}\'{inches % 12}"'
    except ValueError:
        return s

players = to_pl(nfl.load_players())
pcols = [c for c in ["display_name", "birth_date", "years_of_experience", "height", "weight"] if c in players.columns]
bio = {}
for row in players.select(pcols).iter_rows(named=True):
    k = nkey(row.get("display_name", ""))
    bd = row.get("birth_date")
    age = ""
    if bd is not None:
        try:
            d = bd if isinstance(bd, datetime.date) else datetime.date.fromisoformat(str(bd)[:10])
            age = round((ASOF - d).days / 365.25, 1)
        except Exception:
            age = ""
    exp = row.get("years_of_experience")
    wt = row.get("weight")
    bio[k] = {"age": age, "exp": ("R" if exp == 0 else (exp if exp is not None else "")),
              "ht": fmt_ht(row.get("height")), "wt": int(wt) if isinstance(wt, (int, float)) else (wt or "")}

# --- combine 40-yard dash (athleticism), keyed by nkey ---
forty = {}
try:
    cb = to_pl(nfl.load_combine())
    for name, f in cb.select(["player_name", "forty"]).rows():
        k = nkey(name)
        if f is not None and k not in forty:
            forty[k] = f
except Exception as e:
    print(f"combine: ERR {str(e)[:60]}")

# --- news: injury + depth + Sleeper buzz + latest headline, keyed by nkey ---
news_by_key = {}
for r in read_csv("data/player-news.csv"):
    k = nkey(r.get("player", ""))
    d = news_by_key.setdefault(k, {"injury": "", "depth": "", "buzz": "", "news": ""})
    cat, detail, src = r.get("category", ""), r.get("detail", ""), r.get("source", "")
    if cat == "injury":
        d["injury"] = detail
    elif cat == "role" and not d["depth"]:
        m = re.search(r"depth (\d+)", detail)
        if m:
            d["depth"] = m.group(1)
    elif cat == "trending" and not d["buzz"]:
        d["buzz"] = "ADD" if "add" in src else "DROP"
    elif cat == "headline" and not d["news"]:
        d["news"] = f"{detail} ({src})"

# --- assemble, rank by our value ---
rows = []
for name, v in values.items():
    pos = v["pos"].upper()
    val = int(float(v["value"]))
    k = nkey(name)
    meta = ecr.get(name, {})
    team = meta.get("team", "")
    b = bio.get(k, {})
    nd = news_by_key.get(k, {})
    rows.append({
        "player": name, "pos": pos, "team": team, "bye": bye_for(team),
        "age": b.get("age", ""), "exp": b.get("exp", ""), "ht": b.get("ht", ""), "wt": b.get("wt", ""),
        "forty": forty.get(k, ""),
        "our_value": val, "proj_pts": round(points.get(name, 0), 1),
        "last_pts": round(lastyr_pts.get(k, 0), 1) if k in lastyr_pts else "",
        "last_gms": lastyr_gms.get(k, ""),
        "ecr": meta.get("ecr", ""), "ecr_pos": meta.get("ecr_pos", ""),
        "best": meta.get("best", ""), "worst": meta.get("worst", ""),
        "espn_rank": espn_rank.get(k, ""), "rostered": meta.get("rostered", ""),
        "injury": nd.get("injury", ""), "depth": nd.get("depth", ""),
        "buzz": nd.get("buzz", ""), "news": nd.get("news", ""),
    })
rows.sort(key=lambda r: -r["our_value"])

pos_seen, tier_top, tier_no = {}, {}, {}
for i, r in enumerate(rows):
    r["rank"] = i + 1
    p = r["pos"]
    pos_seen[p] = pos_seen.get(p, 0) + 1
    r["pos_rank"] = f"{p}{pos_seen[p]}"
    # Edge = consensus overall rank minus our overall rank (+ = we rate them higher than the room)
    r["edge"] = (r["ecr"] - r["rank"]) if isinstance(r["ecr"], (int, float)) else ""
    if isinstance(r["edge"], (int, float)):
        r["edge"] = round(r["edge"])
    # tier: a new tier starts on a >=25% value drop within a position
    if p not in tier_top or r["our_value"] < tier_top[p] * 0.75:
        tier_no[p] = tier_no.get(p, 0) + 1
        tier_top[p] = r["our_value"]
    r["tier"] = f"{p}-T{tier_no[p]}"

# NOTE: no structured Injury column -- nflverse has no current-season injury feed yet, so current
# injuries surface via the live-RSS "Latest News" column instead (a stale year-old feed would mislead).
COLS = ["rank", "player", "pos", "pos_rank", "ecr_pos", "tier", "team", "bye", "age", "exp", "ht", "wt", "forty",
        "our_value", "edge", "proj_pts", "last_pts", "last_gms",
        "ecr", "best", "worst", "espn_rank", "rostered", "buzz", "depth", "news"]
HEADER = ["Rank", "Player", "Pos", "PosRank", "ECR_Pos", "Tier", "Team", "Bye", "Age", "Exp", "Ht", "Wt", "40yd",
          "OurValue$", "vsECR", "ProjPts", f"{LAST_YR}Pts", f"{LAST_YR}Gms",
          "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "Rostered%", "SleeperBuzz", "Depth", "Latest News"]

os.makedirs("data", exist_ok=True)
def san(x, sep):
    return str(x if x is not None else "").replace(sep, " ").replace("\n", " ").strip()

with open("data/player-report.csv", "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(HEADER)
    for r in rows:
        w.writerow([r[c] for c in COLS])
with open("data/player-report.tsv", "w", encoding="utf-8", newline="") as f:
    f.write("\t".join(HEADER) + "\n")
    for r in rows:
        f.write("\t".join(san(r[c], "\t") for c in COLS) + "\n")

print(f"wrote data/player-report.csv + .tsv ({len(rows)} players, {len(HEADER)} columns)")
print("top 5:", [(r["rank"], r["player"], r["pos_rank"], f'${r["our_value"]}', f'vsECR {r["edge"]}', f'age {r["age"]}') for r in rows[:5]])
