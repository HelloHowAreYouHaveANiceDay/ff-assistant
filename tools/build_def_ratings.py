# Defense-vs-position multipliers (how much each team allows to each position vs league average),
# built from THREE seasons and SHRUNK toward 1.0 by the amount the data itself says is real.
#
# Run: uv run --with nflreadpy --with polars tools/build_def_ratings.py
#
# WHY SHRINKAGE, and why this particular amount.
# The previous version used one season raw. That is the classic overfit: a team faces ~17 opponents
# at a position in a season, so a single-season multiplier is mostly sampling noise, and applying it
# at face value asserts far more than the sample supports. The honest question is "how much of last
# year's defense-vs-position carries into next year?" -- which is measurable, not a matter of taste.
#
# So we measure it: the YEAR-OVER-YEAR CORRELATION r of each position's multipliers across
# consecutive season pairs. Regression to the mean then gives the shrinkage directly --
#
#     shrunk = 1 + (observed - 1) * r
#
# If r is 0.25, three quarters of the observed spread is noise and gets squeezed out. If a position
# turns out to have r <= 0, NOTHING carries over, the multipliers collapse to a flat 1.0, and the
# model correctly stops pretending it knows anything about that matchup. That collapse is a feature:
# it is the one outcome a hand-picked shrinkage constant could never produce.
#
# The printed r values are the point of this script as much as the CSV is -- read them before
# trusting any matchup adjustment downstream.
import polars as pl, nflreadpy as nfl

SEASONS = [2023, 2024, 2025]          # oldest -> newest
WEIGHTS = {2023: 0.2, 2024: 0.3, 2025: 0.5}   # recency-weighted; rosters and schemes turn over
POSITIONS = ["QB", "RB", "WR", "TE"]

to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x


def season_mults(season):
    """{(team, pos): multiplier} for one season -- points allowed to a position vs league average."""
    d = to_pl(nfl.load_player_stats(seasons=[season]))

    def c(n):
        return pl.col(n) if n in d.columns else pl.lit(0)

    d = d.with_columns((
        c("passing_yards") / 25 + c("passing_tds") * 4 - c("passing_interceptions") * 2 +
        c("rushing_yards") / 10 + c("rushing_tds") * 6 + c("receiving_yards") / 10 +
        c("receiving_tds") * 6 -
        (c("rushing_fumbles_lost") + c("receiving_fumbles_lost")) * 2
    ).alias("pts")).filter(pl.col("position").is_in(POSITIONS)).filter(pl.col("week") <= 18)
    lg = d.group_by("position").agg(pl.col("pts").mean().alias("lg"))
    defp = (d.group_by(["opponent_team", "position"])
            .agg(pl.col("pts").mean().alias("allowed"), pl.len().alias("n"))
            .join(lg, on="position")
            .with_columns((pl.col("allowed") / pl.col("lg")).alias("mult")))
    return {(t, p): (m, n) for t, p, m, n in
            defp.select(["opponent_team", "position", "mult", "n"]).rows() if t}


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return 0.0 if dx == 0 or dy == 0 else num / (dx * dy)


by_season = {s: season_mults(s) for s in SEASONS}

# --- how much of a season's signal survives to the next season, per position -------------------
print("year-over-year correlation of the multipliers (this IS the shrinkage factor):")
r_by_pos = {}
for pos in POSITIONS:
    xs, ys = [], []
    for a, b in zip(SEASONS, SEASONS[1:]):          # (2023,2024), (2024,2025)
        teams = set(t for (t, p) in by_season[a] if p == pos) & \
                set(t for (t, p) in by_season[b] if p == pos)
        for t in sorted(teams):
            xs.append(by_season[a][(t, pos)][0])
            ys.append(by_season[b][(t, pos)][0])
    r = pearson(xs, ys)
    r_by_pos[pos] = max(0.0, r)                     # negative r carries no usable signal -> flatten
    kept = f"{r_by_pos[pos] * 100:.0f}% of observed spread kept"
    note = "  <-- essentially NO carryover; matchup adj is ~noise" if r_by_pos[pos] < 0.15 else ""
    print(f"  {pos}  r = {r:+.3f}   ({len(xs)} team-season pairs)   {kept}{note}")

# --- recency-weighted mean across seasons, then shrink toward 1.0 by r -------------------------
rows = []
for pos in POSITIONS:
    teams = sorted(set(t for s in SEASONS for (t, p) in by_season[s] if p == pos))
    for t in teams:
        num = den = obs = 0.0
        for s in SEASONS:
            hit = by_season[s].get((t, pos))
            if not hit:
                continue
            m, n = hit
            num += m * WEIGHTS[s]
            den += WEIGHTS[s]
            obs += n
        if den == 0:
            continue
        raw = num / den
        shrunk = 1 + (raw - 1) * r_by_pos[pos]
        rows.append((t, pos, round(shrunk, 3), round(raw, 3), round(r_by_pos[pos], 3), int(obs)))

with open("data/def-ratings.csv", "w", encoding="ascii", errors="ignore") as f:
    # col 2 (mult) is the SHRUNK value -- the one loadProjections reads. mult_raw/r/n are kept
    # alongside so the adjustment can be audited without re-running this.
    f.write("team,pos,mult,mult_raw,r,n\n")
    for t, p, m, raw, r, n in rows:
        f.write(f"{t},{p},{m},{raw},{r},{n}\n")

print(f"\nwrote data/def-ratings.csv ({len(rows)} team-pos rows, seasons {SEASONS})")
for pos in POSITIONS:
    v = [m for (_, p, m, _, _, _) in rows if p == pos]
    vr = [raw for (_, p, _, raw, _, _) in rows if p == pos]
    span = lambda a: max(a) - min(a)
    print(f"  {pos}  spread after shrinkage {span(v):.2f}  (was {span(vr):.2f} raw)")
