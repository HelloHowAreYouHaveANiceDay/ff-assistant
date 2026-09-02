# Backtest data: 2024 WEEKLY No-PPR fantasy points per player (for real season+playoff sim) plus
# 2024 SEASON totals (to derive that season's values, so the backtest is self-consistent).
# Run: uv run --with nflreadpy --with polars tools/build_weekly.py
import os
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

YEAR = 2024
d = to_pl(nfl.load_player_stats(seasons=[YEAR]))  # weekly rows
if "season_type" in d.columns: d = d.filter(pl.col("season_type") == "REG")  # regular season only (finding #10)
def c(n): return pl.col(n) if n in d.columns else pl.lit(0)
wk = d.with_columns((
    c("passing_yards")/25 + c("passing_tds")*4 - c("passing_interceptions")*2 +
    c("rushing_yards")/10 + c("rushing_tds")*6 + c("receiving_yards")/10 + c("receiving_tds")*6 -
    (c("rushing_fumbles_lost") + c("receiving_fumbles_lost"))*2
).round(1).alias("points")).select(["player_display_name", "position", "week", "points"])
wk = wk.filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"]))

os.makedirs("data", exist_ok=True)
# weekly.csv: one row per player-week
with open("data/weekly.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("player,pos,week,points\n")
    for name, pos, week, pts in wk.rows():
        f.write(f"{name},{pos},{week},{pts}\n")

# season totals for values
tot = wk.group_by(["player_display_name", "position"]).agg(pl.col("points").sum().round(1).alias("points")).sort("points", descending=True)
with open("data/points-2024.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("player,pos,points\n")
    for name, pos, pts in tot.rows():
        if pts > 0: f.write(f"{name},{pos},{pts}\n")
    # nominal K/DST so rosters fill
    f.write("Justin Tucker,K,140\nBrandon Aubrey,K,150\nChris Boswell,K,145\nCameron Dicker,K,142\n")
    f.write("Broncos,DST,140\nEagles,DST,135\nVikings,DST,138\nTexans,DST,133\n")
print(f"wrote data/weekly.csv ({wk.height} player-weeks) and data/points-2024.csv ({tot.height} players)")
print("weeks:", sorted(set(wk.get_column('week').to_list())))
