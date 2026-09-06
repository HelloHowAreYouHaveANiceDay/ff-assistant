# POSITIVE CONTROL for the near-zero defense-vs-position correlations in build_def_ratings.py.
#
# A correlation of ~0.00 and a silently-misaligned join look EXACTLY alike: both print a small
# number. So before believing "DvP carries no signal", prove the same code can (a) return 1.0 when
# it must, (b) return ~0 when it must, and (c) recover a correlation that is known to be real.
#
# Run: uv run --with nflreadpy --with polars tools/verify_dvp_signal.py
import random
import polars as pl, nflreadpy as nfl

SEASONS = [2023, 2024, 2025]
POSITIONS = ["QB", "RB", "WR", "TE"]
to_pl = lambda x: x.to_polars() if hasattr(x, "to_polars") else x


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return 0.0 if dx == 0 or dy == 0 else num / (dx * dy)


def load(season):
    d = to_pl(nfl.load_player_stats(seasons=[season]))

    def c(n):
        return pl.col(n) if n in d.columns else pl.lit(0)

    return d.with_columns((
        c("passing_yards") / 25 + c("passing_tds") * 4 - c("passing_interceptions") * 2 +
        c("rushing_yards") / 10 + c("rushing_tds") * 6 + c("receiving_yards") / 10 +
        c("receiving_tds") * 6 -
        (c("rushing_fumbles_lost") + c("receiving_fumbles_lost")) * 2
    ).alias("pts")).filter(pl.col("position").is_in(POSITIONS)).filter(pl.col("week") <= 18)


raw = {s: load(s) for s in SEASONS}


def defense_mults(season, pos):
    """{team: multiplier} -- points ALLOWED to `pos`, vs league average."""
    d = raw[season].filter(pl.col("position") == pos)
    lg = d.select(pl.col("pts").mean()).item()
    g = d.group_by("opponent_team").agg(pl.col("pts").mean().alias("a"))
    return {t: a / lg for t, a in g.rows() if t}


def offense_pts(season):
    """{team: points SCORED per player-game} -- a known-stable team trait, used as a control."""
    d = raw[season]
    g = d.group_by("team").agg(pl.col("pts").mean().alias("a"))
    return {t: a for t, a in g.rows() if t}


def yoy(fn, label, pos=None):
    xs, ys = [], []
    for a, b in zip(SEASONS, SEASONS[1:]):
        A = fn(a, pos) if pos else fn(a)
        B = fn(b, pos) if pos else fn(b)
        for t in sorted(set(A) & set(B)):
            xs.append(A[t]); ys.append(B[t])
    return pearson(xs, ys), len(xs), xs, ys


print("=== CONTROL 1: a season against ITSELF must give r = 1.000")
m = defense_mults(2025, "RB")
ts = sorted(m)
print(f"  RB defense 2025 vs 2025      r = {pearson([m[t] for t in ts], [m[t] for t in ts]):+.3f}   (must be +1.000)")

print("\n=== CONTROL 2: teams SHUFFLED must give r ~ 0.000 (proves the join is what carries signal)")
r_true, n, xs, ys = yoy(defense_mults, "RB", "RB")
sh = ys[:]; random.seed(7); random.shuffle(sh)
print(f"  RB defense, correct pairing  r = {r_true:+.3f}   ({n} pairs)")
print(f"  RB defense, shuffled pairing r = {pearson(xs, sh):+.3f}   (must be near 0)")

print("\n=== CONTROL 3: a trait known to persist -- team OFFENSE year over year")
r_off, n_off, _, _ = yoy(offense_pts, "offense")
print(f"  team offense pts/player-game r = {r_off:+.3f}   ({n_off} pairs)")
print("  If this is clearly positive, the pipeline CAN detect real year-over-year signal --")
print("  so a ~0 for defense-vs-position is a fact about defenses, not a bug in the join.")

print("\n=== THE MEASUREMENT: defense vs position, year over year")
for pos in POSITIONS:
    r, n, _, _ = yoy(defense_mults, pos, pos)
    print(f"  {pos} defense                    r = {r:+.3f}   ({n} pairs)")
