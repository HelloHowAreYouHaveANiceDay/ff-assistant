# Defense-vs-position multipliers (how much each team allows to each position vs league avg) from the
# latest season, as PRIORS for the weekly projection model. Small but real edge (validate_matchup.py).
# Run: uv run --with nflreadpy --with polars tools/build_def_ratings.py
import polars as pl, nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x
d = to_pl(nfl.load_player_stats(seasons=[2024]))
def c(n): return pl.col(n) if n in d.columns else pl.lit(0)
d = d.with_columns((
    c("passing_yards")/25 + c("passing_tds")*4 - c("passing_interceptions")*2 +
    c("rushing_yards")/10 + c("rushing_tds")*6 + c("receiving_yards")/10 + c("receiving_tds")*6 -
    (c("rushing_fumbles_lost") + c("receiving_fumbles_lost"))*2
).alias("pts")).filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"])).filter(pl.col("week") <= 18)
lg = d.group_by("position").agg(pl.col("pts").mean().alias("lg"))
defp = (d.group_by(["opponent_team", "position"]).agg(pl.col("pts").mean().alias("allowed"))
          .join(lg, on="position").with_columns((pl.col("allowed") / pl.col("lg")).round(3).alias("mult")))
with open("data/def-ratings.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("team,pos,mult\n")
    for team, pos, allowed, lgv, mult in defp.select(["opponent_team", "position", "allowed", "lg", "mult"]).rows():
        if team: f.write(f"{team},{pos},{mult}\n")
print(f"wrote data/def-ratings.csv ({defp.height} team-pos rows)")
