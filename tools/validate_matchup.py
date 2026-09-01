# Does a matchup adjustment sharpen WEEKLY projections vs a naive per-game average? If yes, it's a
# real weekly-projection edge (the +5-7 championship lever). Isolates the matchup signal: both models
# use the same "talent" (player season avg); one multiplies by opponent defense-vs-position.
# Run: uv run --with nflreadpy --with polars --with numpy tools/validate_matchup.py
import polars as pl, numpy as np, nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

years = list(range(2014, 2025))
d = to_pl(nfl.load_player_stats(seasons=years))
def c(n): return pl.col(n) if n in d.columns else pl.lit(0)
d = d.with_columns((
    c("passing_yards")/25 + c("passing_tds")*4 - c("passing_interceptions")*2 +
    c("rushing_yards")/10 + c("rushing_tds")*6 + c("receiving_yards")/10 + c("receiving_tds")*6 -
    (c("rushing_fumbles_lost") + c("receiving_fumbles_lost"))*2
).alias("pts")).select(["season", "week", "player_display_name", "position", "opponent_team", "pts"])
d = d.filter(pl.col("position").is_in(["QB", "RB", "WR", "TE"])).filter(pl.col("week") <= 18)

# player season avg (talent) and games
tal = d.group_by(["season", "player_display_name"]).agg(pl.col("pts").mean().alias("avg"), pl.len().alias("g"))
# defense-vs-position multiplier: pts allowed by opp to pos / league avg for pos, per season
posavg = d.group_by(["season", "position"]).agg(pl.col("pts").mean().alias("lg"))
defp = d.group_by(["season", "opponent_team", "position"]).agg(pl.col("pts").mean().alias("allowed"))
defp = defp.join(posavg, on=["season", "position"]).with_columns((pl.col("allowed") / pl.col("lg")).alias("mult"))

j = (d.join(tal, on=["season", "player_display_name"])
       .join(defp.select(["season", "opponent_team", "position", "mult"]), on=["season", "opponent_team", "position"])
       .filter(pl.col("g") >= 6))
naive = j.get_column("avg").to_numpy()
matchup = (j.get_column("avg") * j.get_column("mult")).to_numpy()
actual = j.get_column("pts").to_numpy()

def corr(a, b): return float(np.corrcoef(a, b)[0, 1])
def mae(a, b): return float(np.mean(np.abs(a - b)))
print(f"player-weeks: {len(actual)}")
print(f"NAIVE  (season avg):        corr {corr(naive, actual):.4f}  MAE {mae(naive, actual):.3f}")
print(f"MATCHUP(avg x def-vs-pos):  corr {corr(matchup, actual):.4f}  MAE {mae(matchup, actual):.3f}")
print(f"=> matchup {'HELPS' if corr(matchup, actual) > corr(naive, actual) else 'does NOT help'} "
      f"(corr {corr(matchup, actual)-corr(naive, actual):+.4f}, MAE {mae(matchup, actual)-mae(naive, actual):+.3f})")
# effective error sd of each (for mapping to the championship curve)
print(f"resid sd  naive {np.std(actual-naive):.2f}  matchup {np.std(actual-matchup):.2f}  (weekly pts)")
