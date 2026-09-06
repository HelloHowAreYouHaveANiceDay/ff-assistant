# How many fantasy points is one point of betting spread actually worth, per position?
#
# playoff-sos.mjs converts an opponent-strength rating (in points of spread) into an expected
# fantasy swing. That conversion was a rule of thumb. This measures it, so the headline number in
# a trade decision is a regression slope rather than an assertion.
#
# Method: for every completed 2023-25 game with a posted line, take each team's FEATURE player at
# each position (its top fantasy scorer that week -- the player you would actually be starting) and
# regress his points on his team's own spread. Spread is team-relative and NEGATIVE = favoured, so a
# NEGATIVE slope means "more favoured -> more points", which is the expected direction.
#
# Run: uv run --with nflreadpy --with polars tools/spread_to_points.py
import polars as pl, nflreadpy as nfl

SEASONS = [2023, 2024, 2025]
POSITIONS = ["QB", "RB", "WR", "TE"]
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

sched = to_pl(nfl.load_schedules())
sched = sched.filter(pl.col("season").is_in(SEASONS)).filter(pl.col("spread_line").is_not_null())
# one row per TEAM per game; nflverse spread_line is POSITIVE when HOME is favoured, so flip for home
home = sched.select(
    pl.col("season"), pl.col("week"), pl.col("home_team").alias("team"),
    (-pl.col("spread_line")).alias("spread"), pl.col("total_line").alias("total"))
away = sched.select(
    pl.col("season"), pl.col("week"), pl.col("away_team").alias("team"),
    pl.col("spread_line").alias("spread"), pl.col("total_line").alias("total"))
lines = pl.concat([home, away])

d = to_pl(nfl.load_player_stats(seasons=SEASONS))


def c(n):
    return pl.col(n) if n in d.columns else pl.lit(0)


d = d.with_columns((
    c("passing_yards") / 25 + c("passing_tds") * 4 - c("passing_interceptions") * 2 +
    c("rushing_yards") / 10 + c("rushing_tds") * 6 + c("receiving_yards") / 10 +
    c("receiving_tds") * 6 - (c("rushing_fumbles_lost") + c("receiving_fumbles_lost")) * 2
).alias("pts")).filter(pl.col("position").is_in(POSITIONS)).filter(pl.col("week") <= 18)

# the FEATURE player: each team's top scorer at the position that week
feat = (d.sort("pts", descending=True)
        .group_by(["season", "week", "team", "position"]).head(1)
        .join(lines, on=["season", "week", "team"], how="inner"))

print("fantasy points regressed on the team's OWN spread (negative spread = favoured)")
print("a NEGATIVE slope is the expected direction: more favoured -> more points\n")
print("  pos   slope (pts per pt of spread)   n      mean pts   implied: 3-pt harder schedule costs")
for pos in POSITIONS:
    g = feat.filter(pl.col("position") == pos).select(["pts", "spread"]).drop_nulls()
    xs = g["spread"].to_list()
    ys = g["pts"].to_list()
    n = len(xs)
    if n < 30:
        print(f"  {pos}   too few rows ({n})")
        continue
    mx, my = sum(xs) / n, sum(ys) / n
    var = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / var if var else 0.0
    # correlation, to say whether the slope is worth anything at all
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    r = (sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / ((var ** 0.5) * dy)) if var and dy else 0.0
    print(f"  {pos}   {slope:+.3f}  (r={r:+.3f})".ljust(38) +
          f"{n:>5}   {my:>7.1f}      {abs(slope) * 3:>4.1f} pts/wk")
print("\nThe last column is the number playoff-sos.mjs should use: what a 3-point swing in")
print("opponent quality -- roughly the gap between an average and a top-5 playoff schedule -- is")
print("worth per week to a player you are actually starting.")
