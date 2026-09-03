# Exhaustive per-player DRAFT REPORT as a Google-Sheets-ready table. Joins everything we have into
# one row per player, sorted by OUR value:
#   our VOR->$ value + projected points (data/values.csv, data/points.csv)
#   team + FantasyPros consensus rank (load_ff_rankings)  -- the ECR column is the independent check
#   bye week (load_schedules)
#   injury status + depth-chart rank + latest news/buzz (data/player-news.csv, if built)
# Writes data/player-report.csv (import: File > Import) AND data/player-report.tsv (paste into A1).
# Run: uv run --with nflreadpy --with polars tools/build_report.py
import os, re, csv
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

SEASON = 2025
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

# --- team + consensus (ECR) rank from FantasyPros; join by name to our players ---
rk = to_pl(nfl.load_ff_rankings())
rk = rk.filter(pl.col("page_type") == "redraft-overall").filter(pl.col("pos").is_in(POS)).unique(subset=["player"])
ecr = {}
for player, pos, team, e in rk.select(["player", "pos", "team", "ecr"]).rows():
    nm = player.split()[-1] if pos == "DST" else player  # match our DST-nickname convention
    ecr[nm] = {"team": team or "", "ecr": e}

# --- bye week per team from the schedule (the REG week the team does not play) ---
sched = to_pl(nfl.load_schedules(seasons=[SEASON])).filter(pl.col("game_type") == "REG")
weeks_by_team = {}
for wk, home, away in sched.select(["week", "home_team", "away_team"]).rows():
    for t in (home, away):
        weeks_by_team.setdefault(t, set()).add(wk)
maxwk = max((w for ws in weeks_by_team.values() for w in ws), default=18)
bye = {t: next((w for w in range(1, maxwk + 1) if w not in ws), "") for t, ws in weeks_by_team.items()}
# FantasyPros vs nflverse team-abbreviation variants -> make bye lookup robust.
ALIASES = {"LAR": "LA", "LA": "LAR", "WSH": "WAS", "WAS": "WSH", "JAC": "JAX", "JAX": "JAC",
           "OAK": "LV", "LV": "LV", "SD": "LAC", "STL": "LA", "ARZ": "ARI", "CLV": "CLE",
           "BLT": "BAL", "HST": "HOU"}
def bye_for(team):
    if team in bye:
        return bye[team]
    return bye.get(ALIASES.get(team, ""), "")

# --- news: injury status + depth + latest headline/buzz, keyed by nkey ---
news_by_key = {}
for r in read_csv("data/player-news.csv"):
    k = nkey(r.get("player", ""))
    d = news_by_key.setdefault(k, {"injury": "", "depth": "", "news": ""})
    cat, detail = r.get("category", ""), r.get("detail", "")
    if cat == "injury":
        d["injury"] = detail
    elif cat == "role" and not d["depth"]:
        m = re.search(r"depth (\d+)", detail)
        if m:
            d["depth"] = m.group(1)
    elif cat in ("headline", "trending") and not d["news"]:
        d["news"] = f"{detail} ({r.get('source','')})"

# --- assemble rows, ranked by our value ---
rows = []
for name, v in values.items():
    pos = v["pos"].upper()
    val = int(float(v["value"]))
    meta = ecr.get(name, {})
    team = meta.get("team", "")
    nd = news_by_key.get(nkey(name), {})
    rows.append({
        "player": name, "pos": pos, "team": team, "bye": bye_for(team),
        "our_value": val, "proj_pts": round(points.get(name, 0), 1),
        "ecr": meta.get("ecr", ""), "injury": nd.get("injury", ""),
        "depth": nd.get("depth", ""), "news": nd.get("news", ""),
    })
rows.sort(key=lambda r: -r["our_value"])

# overall rank + positional rank + a simple value-gap tier within position
pos_seen = {}
for i, r in enumerate(rows):
    r["rank"] = i + 1
    pos_seen[r["pos"]] = pos_seen.get(r["pos"], 0) + 1
    r["pos_rank"] = f'{r["pos"]}{pos_seen[r["pos"]]}'
# tier: within each position, a new tier starts on a >=25% value drop from the tier's top
tier_top, tier_no = {}, {}
for r in rows:
    p = r["pos"]
    if p not in tier_top or r["our_value"] < tier_top[p] * 0.75:
        tier_no[p] = tier_no.get(p, 0) + 1
        tier_top[p] = r["our_value"]
    r["tier"] = f'{p}-T{tier_no[p]}'

COLS = ["rank", "player", "pos", "pos_rank", "tier", "team", "bye", "our_value", "proj_pts", "ecr", "injury", "depth", "news"]
HEADER = ["Rank", "Player", "Pos", "PosRank", "Tier", "Team", "Bye", "OurValue$", "ProjPts", "ECR", "Injury", "Depth", "Latest News"]

os.makedirs("data", exist_ok=True)
def sanitize(x, sep):
    s = str(x if x is not None else "")
    return s.replace(sep, " ").replace("\n", " ").strip()

with open("data/player-report.csv", "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(HEADER)
    for r in rows:
        w.writerow([r[c] for c in COLS])
with open("data/player-report.tsv", "w", encoding="utf-8", newline="") as f:
    f.write("\t".join(HEADER) + "\n")
    for r in rows:
        f.write("\t".join(sanitize(r[c], "\t") for c in COLS) + "\n")

print(f"wrote data/player-report.csv + .tsv ({len(rows)} players)")
print("top 8:", [(r["rank"], r["player"], r["pos_rank"], f'${r["our_value"]}', f'bye {r["bye"]}') for r in rows[:8]])
