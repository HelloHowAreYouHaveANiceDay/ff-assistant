# Draft-time PLAYER NEWS from nflverse: who is injured (report status) and who is NOT the starter
# on the depth chart, as of the season opener -- the draft-relevant "news" the consensus rank may
# not fully price. Independent of ESPN. Writes data/news.csv (player,pos,team,status,injury,depth).
#   status: Out | Doubtful | Questionable  (blank = active/no designation)
#   depth : depth-chart rank at the player's position (1 = starter; >=2 = behind someone)
# Season anchors to the latest nflverse season (2025). Draft-time proxy = week 1 REG injury report
# (there is no PRESEASON injury feed) + the most recent depth chart. Draftable positions only.
# Run: uv run --with nflreadpy --with polars tools/build_news.py [--week N]
import os, sys
import polars as pl
import nflreadpy as nfl
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x

SEASON = 2025  # latest nflverse season; bump when newer data lands
WEEK = 1
if "--week" in sys.argv:
    WEEK = int(sys.argv[sys.argv.index("--week") + 1])
POS = ["QB", "RB", "WR", "TE", "K"]

# --- 1. injury report for the target week (draft-time proxy) ---
inj = to_pl(nfl.load_injuries(seasons=[SEASON]))
inj = inj.filter((pl.col("season_type") == "REG") & (pl.col("week") == WEEK))
inj = inj.filter(pl.col("report_status").is_in(["Out", "Doubtful", "Questionable"]))
inj = inj.select([
    pl.col("gsis_id"),
    pl.col("full_name").alias("player"),
    pl.col("position").alias("pos"),
    pl.col("team"),
    pl.col("report_status").alias("status"),
    pl.col("report_primary_injury").alias("injury"),
])

# --- 2. most-recent depth-chart rank per player (1 = starter) ---
dc = to_pl(nfl.load_depth_charts(seasons=[SEASON]))
# keep the latest snapshot per player (dt is the depth-chart date), skill positions only
dc = dc.filter(pl.col("pos_abb").is_in(POS)).sort("dt").unique(subset=["gsis_id"], keep="last")
dc = dc.select([pl.col("gsis_id"), pl.col("pos_rank").alias("depth"), pl.col("player_name").alias("dc_player"), pl.col("pos_abb").alias("dc_pos"), pl.col("team").alias("dc_team")])

# --- 3. UNION: every player with news (injury designation OR a non-starter depth rank at a skill pos) ---
injured = inj.join(dc.select(["gsis_id", "depth"]), on="gsis_id", how="left")
backups = dc.filter((pl.col("depth") >= 2)).join(inj.select(["gsis_id"]), on="gsis_id", how="anti").select([
    pl.col("gsis_id"), pl.col("dc_player").alias("player"), pl.col("dc_pos").alias("pos"),
    pl.col("dc_team").alias("team"), pl.lit("").alias("status"), pl.lit("").alias("injury"), pl.col("depth"),
])
rows = pl.concat([injured, backups.select(injured.columns)], how="vertical").filter(pl.col("pos").is_in(POS))

os.makedirs("data", exist_ok=True)
with open("data/news.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("player,pos,team,status,injury,depth\n")
    for r in rows.select(["player", "pos", "team", "status", "injury", "depth"]).rows():
        player, pos, team, status, injury, depth = r
        # sanitize commas out of free-text fields so the CSV stays 6 columns
        injury = (injury or "").replace(",", ";")
        f.write(f"{player},{pos},{team or ''},{status or ''},{injury},{depth if depth is not None else ''}\n")

n_inj = injured.height
n_bk = backups.height
print(f"wrote data/news.csv: {n_inj} injury-flagged (week {WEEK} {SEASON}) + {n_bk} depth-chart backups = {rows.height} rows")
print("injury statuses:", inj.get_column("status").value_counts().to_dicts())
