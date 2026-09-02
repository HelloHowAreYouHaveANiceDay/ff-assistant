# Multi-season backtest data from nflverse. Writes combined files with a `season` column:
#   data/history-points.csv   season,player,pos,points   (season totals -> values)
#   data/history-weekly.csv    season,player,pos,week,points  (H2H season + playoffs)
# Range via argv: `... build_history.py 2012 2024` (default 2015-2024).
# Run: uv run --with nflreadpy --with polars tools/build_history.py [START END]
import os, sys
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

start = int(sys.argv[1]) if len(sys.argv) > 1 else 2015
end = int(sys.argv[2]) if len(sys.argv) > 2 else 2024
years = list(range(start, end + 1))
print("seasons:", years)

d = to_pl(nfl.load_player_stats(seasons=years))
if "season_type" in d.columns: d = d.filter(pl.col("season_type") == "REG")  # regular season only (finding #10)
def c(n): return pl.col(n) if n in d.columns else pl.lit(0)
wk = d.with_columns((
    c("passing_yards")/25 + c("passing_tds")*4 - c("passing_interceptions")*2 +
    c("rushing_yards")/10 + c("rushing_tds")*6 + c("receiving_yards")/10 + c("receiving_tds")*6 -
    (c("rushing_fumbles_lost") + c("receiving_fumbles_lost"))*2
).round(1).alias("points")).select(["season", "player_display_name", "position", "week", "points"])
wk = wk.filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"]))

os.makedirs("data", exist_ok=True)
with open("data/history-weekly.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("season,player,pos,week,points\n")
    for season, name, pos, week, pts in wk.rows():
        f.write(f"{season},{name},{pos},{week},{pts}\n")

tot = wk.group_by(["season", "player_display_name", "position"]).agg(pl.col("points").sum().round(1).alias("points"))
with open("data/history-points.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("season,player,pos,points\n")
    for season, name, pos, pts in tot.rows():
        if pts > 0: f.write(f"{season},{name},{pos},{pts}\n")
    # nominal K/DST per season so rosters fill (streamed in reality)
    for yr in years:
        f.write(f"{yr},Kk1_{yr},K,145\n{yr},Kk2_{yr},K,140\n{yr},Kk3_{yr},K,135\n{yr},Kk4_{yr},K,130\n")
        f.write(f"{yr},Dd1_{yr},DST,140\n{yr},Dd2_{yr},DST,135\n{yr},Dd3_{yr},DST,130\n{yr},Dd4_{yr},DST,125\n")
print(f"wrote data/history-weekly.csv ({wk.height} player-weeks) + data/history-points.csv over {len(years)} seasons")
