# Exhaustive per-player DRAFT/SCOUTING report as a Google-Sheets-ready table. One row per player,
# sorted by OUR value, joining every signal we have:
#   OUR value + 2025 projected points (data/values.csv, data/points.csv)
#   consensus: team + FantasyPros overall rank (ECR) + ECR positional rank + Edge (ECR - our rank)
#   context: bye week (schedules), age + years experience (players), last-year points + games played
#   news: injury status + depth-chart rank + Sleeper add/drop buzz + latest headline (data/player-news.csv)
# Writes data/player-report.csv (File > Import) AND data/player-report.tsv (paste into A1).
# Run: uv run --with nflreadpy --with polars tools/build_report.py
import os, re, csv, datetime
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

SEASON = 2025
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
lastyr_pts = {nkey(r["player"]): float(r["points"]) for r in read_csv("data/points-2024.csv") if r.get("points")}

# --- last-year games played (distinct 2024 REG weeks per player) from history-weekly.csv ---
lastyr_gms = {}
for r in read_csv("data/history-weekly.csv"):
    if r.get("season") == "2024":
        k = nkey(r.get("player", ""))
        lastyr_gms[k] = lastyr_gms.get(k, set())
        lastyr_gms[k].add(r.get("week"))
lastyr_gms = {k: len(v) for k, v in lastyr_gms.items()}

# --- consensus: team + ECR overall + ECR positional rank ---
rk = to_pl(nfl.load_ff_rankings())
rk = rk.filter(pl.col("page_type") == "redraft-overall").filter(pl.col("pos").is_in(POS)).unique(subset=["player"])
rk = rk.sort("ecr").with_columns((pl.col("ecr").rank("ordinal").over("pos").cast(pl.Int64)).alias("ecr_pos"))
ecr = {}
for player, pos, team, e, epos in rk.select(["player", "pos", "team", "ecr", "ecr_pos"]).rows():
    nm = player.split()[-1] if pos == "DST" else player  # match our DST-nickname convention
    ecr[nm] = {"team": team or "", "ecr": e, "ecr_pos": f"{pos}{epos}"}

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

# --- age + experience from the players table ---
players = to_pl(nfl.load_players())
pcols = [c for c in ["display_name", "birth_date", "years_of_experience"] if c in players.columns]
age_exp = {}
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
    age_exp[k] = {"age": age, "exp": ("R" if exp == 0 else (exp if exp is not None else ""))}

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
    ae = age_exp.get(k, {})
    nd = news_by_key.get(k, {})
    rows.append({
        "player": name, "pos": pos, "team": team, "bye": bye_for(team),
        "age": ae.get("age", ""), "exp": ae.get("exp", ""),
        "our_value": val, "proj_pts": round(points.get(name, 0), 1),
        "last_pts": round(lastyr_pts.get(k, 0), 1) if k in lastyr_pts else "",
        "last_gms": lastyr_gms.get(k, ""),
        "ecr": meta.get("ecr", ""), "ecr_pos": meta.get("ecr_pos", ""),
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

COLS = ["rank", "player", "pos", "pos_rank", "ecr_pos", "tier", "team", "bye", "age", "exp",
        "our_value", "edge", "proj_pts", "last_pts", "last_gms", "ecr", "injury", "depth", "buzz", "news"]
HEADER = ["Rank", "Player", "Pos", "PosRank", "ECR_Pos", "Tier", "Team", "Bye", "Age", "Exp",
          "OurValue$", "vsECR", "ProjPts", "LastYrPts", "LastYrGms", "ECR", "Injury", "Depth", "Buzz", "Latest News"]

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
