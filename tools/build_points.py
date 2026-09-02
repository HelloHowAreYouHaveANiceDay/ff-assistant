# Build a projected-points table for the auction values + simulator ground truth.
# v1 projection proxy = last completed season (2024) actual No-PPR fantasy points from nflverse
# (free, independent of ESPN). Swap in real preseason projections later; the pipeline is the same.
# Run: uv run --with nflreadpy --with polars tools/build_points.py
import sys
try:
    import nflreadpy as nfl
except Exception as e:
    print("need nflreadpy:", e); sys.exit(1)

YEAR = 2024
df = nfl.load_player_stats(seasons=[YEAR])          # weekly rows
import polars as pl
d = df.to_polars() if hasattr(df, "to_polars") else df
if "season_type" in d.columns: d = d.filter(pl.col("season_type") == "REG")  # regular season only (finding #10)

# aggregate weekly -> season totals for the fields we score
def col(name, alt=0):
    return pl.col(name) if name in d.columns else pl.lit(alt)

agg = (d.group_by(["player_display_name", "position"]).agg([
    col("passing_yards").sum().alias("pass_yds"),
    col("passing_tds").sum().alias("pass_td"),
    col("passing_interceptions").sum().alias("int"),
    col("rushing_yards").sum().alias("rush_yds"),
    col("rushing_tds").sum().alias("rush_td"),
    col("receiving_yards").sum().alias("rec_yds"),
    col("receiving_tds").sum().alias("rec_td"),
    (col("rushing_fumbles_lost") + col("receiving_fumbles_lost")).sum().alias("fum"),
]))

# Standard No-PPR scoring
pts = (agg
    .with_columns((
        pl.col("pass_yds") / 25 + pl.col("pass_td") * 4 - pl.col("int") * 2 +
        pl.col("rush_yds") / 10 + pl.col("rush_td") * 6 +
        pl.col("rec_yds") / 10 + pl.col("rec_td") * 6 - pl.col("fum") * 2
    ).round(1).alias("points"))
    .filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"]))
    .filter(pl.col("points") > 0)
    .select(["player_display_name", "position", "points"])
    .sort("points", descending=True)
)

rows = pts.rows()
import os
os.makedirs("data", exist_ok=True)
with open("data/points.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("player,pos,points\n")
    for name, pos, p in rows:
        f.write(f"{name},{pos},{p}\n")
    # K/DST: flat baseline (streamed, ~$1 in this league); give nominal points so they can fill.
    f.write("Justin Tucker,K,120\nBrandon Aubrey,K,130\nHarrison Butker,K,125\n")
    f.write("Ravens,DST,120\nCowboys,DST,115\n49ers,DST,118\n")
print(f"wrote data/points.csv with {len(rows)} skill players (+ nominal K/DST)")
print("top:", rows[:5])
