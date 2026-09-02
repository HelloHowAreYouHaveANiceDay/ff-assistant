# 2025 projected points = current FantasyPros REDRAFT consensus ranks (nflreadpy) mapped onto a
# points-by-rank curve = MEAN of 2019-2024 REGULAR-SEASON No-PPR actuals (multi-season so no single
# year sets the scale; REG-only so playoff games don't inflate totals -- finding #10). Forward-looking
# (rookies/injuries/team changes), realistic scale, independent of ESPN. Overwrites data/points.csv.
# Run: uv run --with nflreadpy --with polars tools/build_projections.py
import os
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

# --- 1. current-year redraft-overall consensus ranks ---
rk = to_pl(nfl.load_ff_rankings())
rk = rk.filter(pl.col("page_type") == "redraft-overall").select(["player", "pos", "team", "ecr"])
rk = rk.filter(pl.col("pos").is_in(["QB", "RB", "WR", "TE", "K", "DST"])).unique(subset=["player"])
# within-position rank by ecr (0-indexed)
rk = rk.sort("ecr").with_columns(pl.col("ecr").rank("ordinal").over("pos").cast(pl.Int64).alias("pos_rank") - 1)

# --- 2. points-by-rank curve per position = MEAN over 2019-2024 REGULAR-SEASON totals ---
SEASONS = list(range(2019, 2025))  # 2019..2024 inclusive
d = to_pl(nfl.load_player_stats(seasons=SEASONS))
if "season_type" in d.columns: d = d.filter(pl.col("season_type") == "REG")  # exclude NFL playoffs
def c(n): return pl.col(n) if n in d.columns else pl.lit(0)
agg = d.group_by(["season", "player_display_name", "position"]).agg([
    c("passing_yards").sum().alias("py"), c("passing_tds").sum().alias("pt"), c("passing_interceptions").sum().alias("pi"),
    c("rushing_yards").sum().alias("ry"), c("rushing_tds").sum().alias("rt"),
    c("receiving_yards").sum().alias("cy"), c("receiving_tds").sum().alias("ct"),
    (c("rushing_fumbles_lost") + c("receiving_fumbles_lost")).sum().alias("fl"),
])
agg = agg.with_columns((pl.col("py")/25 + pl.col("pt")*4 - pl.col("pi")*2 + pl.col("ry")/10 + pl.col("rt")*6 + pl.col("cy")/10 + pl.col("ct")*6 - pl.col("fl")*2).alias("pts"))
# rank-k curve = the AVERAGE season points of the k-th best player at that position across seasons.
curve = {}
for pos in ["QB", "RB", "WR", "TE"]:
    per_season = []
    for yr in SEASONS:
        vals = agg.filter((pl.col("position") == pos) & (pl.col("season") == yr)).sort("pts", descending=True).get_column("pts").to_list()
        per_season.append([max(0.0, v) for v in vals])
    maxlen = max((len(v) for v in per_season), default=0)
    curve[pos] = [sum(v[k] for v in per_season if k < len(v)) / sum(1 for v in per_season if k < len(v)) for k in range(maxlen)]

def proj(pos, r):
    cv = curve.get(pos) or []
    if not cv: return 0.0
    return cv[min(r, len(cv) - 1)]

rows = []
for player, pos, team, ecr, pr in rk.select(["player", "pos", "team", "ecr", "pos_rank"]).rows():
    r = int(pr)
    if pos in ("K", "DST"):
        # No shaped curve for K/DST: they stream and computeValues clamps their $ to ~$2 (Step 2).
        # Give a small descending nominal so they stay in the table and keep ECR order.
        p = round(max(1.0, 20.0 - r * 0.1), 1)
    else:
        p = round(proj(pos, r), 1)
    # ESPN names a defense by its team NICKNAME ("Broncos D/ST"), so store D/ST as the last token
    # ("Denver Broncos" -> "Broncos"); nameKey then bridges both sides (finding #5). K stays a name.
    nm = player.split()[-1] if pos == "DST" else player
    if p > 0: rows.append((nm, pos, p))
rows.sort(key=lambda x: -x[2])

os.makedirs("data", exist_ok=True)
# K/DST come straight from the ECR ranks above (35 K, 32 DST -- full coverage), so there is no
# hardcoded named append to dedupe any more (finding #1).

with open("data/points.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("player,pos,points\n")
    for name, pos, p in rows:
        f.write(f"{name},{pos},{p}\n")
print(f"wrote data/points.csv (2025 projections) with {len(rows)} players (incl nominal K/DST)")
print("top:", [(r[0], r[1], r[2]) for r in rows[:6]])
