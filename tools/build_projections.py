# 2025 projected points = current FantasyPros REDRAFT consensus ranks (nflreadpy) mapped onto a
# historical points-by-rank curve (2024 No-PPR actuals). Forward-looking (rookies/injuries/team
# changes) with a realistic points scale, independent of ESPN. Overwrites data/points.csv.
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

# --- 2. 2024 No-PPR points-by-rank curve per position ---
d = to_pl(nfl.load_player_stats(seasons=[2024]))
def c(n): return pl.col(n) if n in d.columns else pl.lit(0)
agg = d.group_by(["player_display_name", "position"]).agg([
    c("passing_yards").sum().alias("py"), c("passing_tds").sum().alias("pt"), c("passing_interceptions").sum().alias("pi"),
    c("rushing_yards").sum().alias("ry"), c("rushing_tds").sum().alias("rt"),
    c("receiving_yards").sum().alias("cy"), c("receiving_tds").sum().alias("ct"),
    (c("rushing_fumbles_lost") + c("receiving_fumbles_lost")).sum().alias("fl"),
])
agg = agg.with_columns((pl.col("py")/25 + pl.col("pt")*4 - pl.col("pi")*2 + pl.col("ry")/10 + pl.col("rt")*6 + pl.col("cy")/10 + pl.col("ct")*6 - pl.col("fl")*2).alias("pts"))
curve = {}
for pos in ["QB", "RB", "WR", "TE"]:
    vals = agg.filter(pl.col("position") == pos).sort("pts", descending=True).get_column("pts").to_list()
    curve[pos] = [max(0.0, v) for v in vals]
# nominal flat curves for K/DST (streamed, ~$1 in this league)
curve["K"] = [130 - i for i in range(40)]
curve["DST"] = [125 - i for i in range(40)]

def proj(pos, r):
    cv = curve.get(pos) or []
    if not cv: return 0.0
    return cv[min(r, len(cv) - 1)]

rows = []
for player, pos, team, ecr, pr in rk.select(["player", "pos", "team", "ecr", "pos_rank"]).rows():
    p = round(proj(pos, int(pr)), 1)
    if p > 0: rows.append((player, pos, p))
rows.sort(key=lambda x: -x[2])

os.makedirs("data", exist_ok=True)
# nominal K/DST projections (streamed/~$1 in this league, but rosters + lineups still need them).
# Dedupe: skip any name already produced from the ECR ranks above -- appending it again created
# duplicate rows (finding #1) that flowed straight into values.csv.
existing = {nm for nm, _, _ in rows}
for i, nm in enumerate(["Justin Tucker", "Brandon Aubrey", "Chris Boswell", "Cameron Dicker", "Jake Elliott", "Ka'imi Fairbairn"]):
    if nm in existing: continue
    rows.append((nm, "K", round(150 - i * 4, 1)))
    existing.add(nm)
for i, nm in enumerate(["Broncos", "Eagles", "Vikings", "Texans", "Steelers", "Bills"]):
    if nm in existing: continue
    rows.append((nm, "DST", round(145 - i * 4, 1)))
    existing.add(nm)

with open("data/points.csv", "w", encoding="ascii", errors="ignore") as f:
    f.write("player,pos,points\n")
    for name, pos, p in rows:
        f.write(f"{name},{pos},{p}\n")
print(f"wrote data/points.csv (2025 projections) with {len(rows)} players (incl nominal K/DST)")
print("top:", [(r[0], r[1], r[2]) for r in rows[:6]])
