"""Fit the WEEKLY projection and emit a schema-validated artifact.

    uv run --with scikit-learn --with numpy tools/train_weekly.py \
        --db data/ff.db --seasons 2010-2025 --holdout-season none \
        --features all --out data/weekly-artifact.json

WHY TRAINING LIVES HERE AND SERVING LIVES IN TYPESCRIPT: the same reason tools/train_projection.py
gives one horizon up. The engine is TypeScript and runs inside an Electron app on a machine with no
Python, in the middle of a live season. Quantile regression is a linear program. The seam between
the two is the ARTIFACT, and a seam is exactly where a producer and a consumer drift apart while
both stay green -- so the artifact carries a GOLDEN BLOCK, five fixture rows with THIS script's own
predictions, and src/weekly/projector.ts refuses the artifact if it cannot reproduce them to 1e-6.

WHAT IS FITTED.

The target is `pts / season_line_pg` -- the week's actual points as a multiple of what the preseason
season projection said the player was worth per game. The season line already encodes who the player
is; fitting points directly would spend the model's capacity re-learning talent. Every coefficient
is then a statement about what the season line gets WRONG week to week, which is the only thing a
weekly model can add.

THE ZERO ATOM.

Weekly fantasy points are zero-inflated even among players who dressed. Two treatments are
defensible: a two-part model (P(zero week) from availability signals, times the ratio given a real
week), or quantile heads that can reach zero. THIS SCRIPT USES QUANTILE HEADS -- the clamp floor is
exactly 0, not the season model's 0.01, so p10 is free to sit on the atom and does.

The reason is not elegance. The signals that would drive a two-part model's first stage -- injury
designation as of the Friday report, depth-chart rank, whether the man ahead of him is out -- are the
DATA TRACK's `feat_player_week_context` and do not exist in this table yet. A zero-probability stage
fitted on to-date scoring alone fits the CONSEQUENCE of an injury rather than the injury; it would
look like structure while measuring what the mean head already sees. `--zero-model two-part` is
reserved for when those columns land, and refuses to run until they do rather than fitting a stage
it cannot honestly feed.

THE MEAN HEAD IS FITTED ON THE POOLED TARGET, ZEROS INCLUDED. A lineup wants E[points]; the pooled
ridge estimates exactly that, and excluding zero weeks would make every projection an estimate of
"points given a good week", which is systematically too high for precisely the players a lineup
should be benching.
"""

import argparse
import json
import math
import sqlite3
import sys
from datetime import date

import numpy as np

SCHEMA = 1
POS_FITTED = ["QB", "RB", "WR", "TE"]
POS_INTERCEPT_ONLY = ["K", "DST"]

# Below this preseason line the ratio is noise over a small number: a 1.0-points-per-game line and a
# 12-point week is a ratio of 12, and thirty of those dominate the fit. TRAINING ONLY -- a small line
# still projects at serve time, it just projects small.
TRAIN_MIN_LINE = 3.0
# The clamp is on the RATIO. lo is 0 and not 0.01, on purpose: the quantile heads have to be able to
# reach the zero atom, and a small positive floor would quietly convert every projected zero week
# into a small positive number that no metric flags.
CLAMP_LO, CLAMP_HI = 0.0, 4.0

# Feature name -> transform family. The names are validated against src/weekly/features.ts's
# published dictionary by the TypeScript loader; this list is the producing half of that contract.
RATIO_TO_LINE = ["td_ppg", "t4_mean", "t4_sd"]
CENTER = [
    "td_games", "dvp_mult", "dvp_n", "spread_line", "total_line",
    "implied_team_total", "days_rest", "week_no", "season_line_pg",
    "td_fd", "td_ts", "td_attempts", "td_rush_yards",
]
INDICATOR = ["home"]

# Which positions may carry a non-zero coefficient on each usage feature. A quarterback has no target
# share and no receiving first downs; scoring him on them measures ~0 and then that null gets written
# down as a fact about quarterbacks. His workload is attempts and rushing yards.
POS_GATED = {
    "td_fd": {"RB", "WR", "TE"},
    "td_ts": {"RB", "WR", "TE"},
    "td_attempts": {"QB"},
    "td_rush_yards": {"QB"},
}

ALL_FEATURES = RATIO_TO_LINE + CENTER + INDICATOR


def parse_seasons(s):
    parts = s.split("-")
    lo = int(parts[0])
    hi = int(parts[1]) if len(parts) > 1 else lo
    return lo, hi


def load_rows(db_path, lo, hi, population):
    """THE TRAINING POPULATION, and it is a train-serve contract, not a filter.

    `played` is every week the man actually appeared. `rostered` -- the DEFAULT -- is every non-bye
    week, with a week he did not play scored as the ZERO it is for the manager who started him.

    This distinction was not obvious and cost a full evaluation pass to find. Fitting on `played` and
    then serving every rostered week makes the model an estimator of E[points | he plays], which is
    systematically too high for exactly the players a lineup should be benching: the first evaluation
    run showed the trained model biased +0.8 to +1.7 points against every baseline's roughly -0.4,
    and coverage at 0.57 against a nominal 0.80. Nothing in the fit or the artifact was wrong; the
    two sides were answering different questions and both were internally consistent.

    A bye is excluded from BOTH populations. Every model knows about a bye equally, from the
    schedule, so scoring it would hand every model the same free lunch and flatter all of them.
    """
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    where = "pts IS NOT NULL" if population == "played" else "COALESCE(is_bye, 0) = 0"
    cur = con.execute(
        "SELECT feat_key, player_sk, season, week, name, pos, season_line_pg,"
        " td_games, td_ppg, t4_mean, t4_sd, td_fd, td_ts, td_attempts, td_rush_yards,"
        " dvp_mult, dvp_n, home, spread_line, total_line, implied_team_total, days_rest,"
        " COALESCE(pts, 0.0) AS pts"
        " FROM feat_player_week_model"
        " WHERE season BETWEEN ? AND ? AND " + where + " AND season_line_pg IS NOT NULL",
        (lo, hi),
    )
    rows = []
    for r in cur.fetchall():
        d = dict(r)
        d["week_no"] = d["week"]
        rows.append(d)
    con.close()
    return rows


def build_specs(rows, wanted):
    """The feature list, with every transform parameter MEASURED here and written on the artifact.

    `missing` is required to be explicit. For a centred feature the explicit choice is
    mean-imputation, which is 0 after centring and is stated as such. For a ratio-to-line feature it
    is 1.0 -- "exactly what his season line implies" -- which is the only default that does not move
    a projection for a player we know nothing about.
    """
    specs = []
    for name in RATIO_TO_LINE:
        if name not in wanted:
            continue
        n = sum(1 for r in rows if r.get(name) is not None)
        if n < 500:
            continue
        # t4_sd as a ratio to the line is a dispersion feature and its honest default is not 1.0
        # (that would claim a spread as wide as the player's whole line); it is the training mean.
        miss = 1.0
        if name == "t4_sd":
            vals = [float(r[name]) / float(r["season_line_pg"])
                    for r in rows if r.get(name) is not None and r.get("season_line_pg")]
            miss = float(np.mean(vals)) if vals else 0.0
        specs.append({"name": name, "transform": "ratio_to_line", "missing": miss})
    for name in CENTER:
        if name not in wanted:
            continue
        vals = [float(r[name]) for r in rows if r.get(name) is not None]
        if len(vals) < 500:
            continue
        mu, sd = float(np.mean(vals)), float(np.std(vals))
        if sd <= 0:
            continue
        specs.append({"name": name, "transform": "center", "center": mu, "scale": sd, "missing": 0.0})
    for name in INDICATOR:
        if name not in wanted:
            continue
        if sum(1 for r in rows if r.get(name) is not None) < 500:
            continue
        specs.append({"name": name, "transform": "indicator", "missing": 0.0})
    return specs


def feature_value(spec, row):
    """The evaluator, mirrored from src/weekly/projector.ts weeklyFeatureValue().

    This existing twice is the whole reason the golden block exists. It is not duplication to be
    refactored away -- it is two independent implementations of one contract, and the artifact
    carries the fixtures that prove they agree.
    """
    raw = row.get(spec["name"])
    if raw is None or (isinstance(raw, float) and not math.isfinite(raw)):
        return spec["missing"]
    raw = float(raw)
    t = spec["transform"]
    if t == "identity":
        return raw
    if t == "indicator":
        return 1.0 if raw else 0.0
    if t == "center":
        s = spec.get("scale", 1.0)
        return spec["missing"] if s == 0 else (raw - spec.get("center", 0.0)) / s
    if t == "ratio_to_line":
        line = row.get("season_line_pg")
        if line is None or not (float(line) > 0):
            return spec["missing"]
        return raw / float(line)
    return spec["missing"]


def design(rows, specs):
    X = np.zeros((len(rows), len(specs)), dtype=float)
    for i, r in enumerate(rows):
        for j, s in enumerate(specs):
            X[i, j] = feature_value(s, r)
    return X


def quantile(a, q):
    return float(np.quantile(np.asarray(a, dtype=float), q)) if len(a) else 1.0


def fit_position(rows, specs, pos, args):
    """Ridge for the mean, pinball-loss linear fits for the three quantiles.

    Alpha is chosen by SEASON-GROUPED cross-validation inside the training data. Grouping by season
    matters more here than at the season horizon: player-weeks inside one year share the scoring era,
    the schedule and the injury luck, and a random split puts the same player's week 4 in the
    training fold and his week 5 in the test fold, which is a leak that flatters every alpha.

    THE QUANTILES ARE FITTED ACROSS THE FULL RANK RANGE, unlike the season model, which caps at
    rank 36 because its curve flattens past that. There is no such flattening here: the denominator
    is a per-player season line, not a rank-indexed curve, so `actual/line` keeps meaning the same
    thing all the way down the board -- and a lineup decision at the bottom of a roster is exactly
    where a weekly spread has to be right.
    """
    from sklearn.linear_model import Ridge, QuantileRegressor
    from sklearn.model_selection import GroupKFold

    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 500:
        return None, len(sub)
    keep = [j for j, s in enumerate(specs)
            if s["name"] not in POS_GATED or pos in POS_GATED[s["name"]]]
    X_all = design(sub, specs)
    X = X_all[:, keep]
    y = np.array([r["pts"] / r["season_line_pg"] for r in sub], dtype=float)
    groups = np.array([r["season"] for r in sub])

    alphas = [0.1, 1.0, 10.0, 100.0]
    n_splits = min(5, len(set(groups.tolist())))
    best_alpha, best_err = alphas[0], float("inf")
    if n_splits >= 2:
        gkf = GroupKFold(n_splits=n_splits)
        for a in alphas:
            err, n = 0.0, 0
            for tr, te in gkf.split(X, y, groups):
                m = Ridge(alpha=a).fit(X[tr], y[tr])
                p = m.predict(X[te])
                err += float(np.sum((y[te] - p) ** 2))
                n += len(te)
            if n and err / n < best_err:
                best_err, best_alpha = err / n, a
    mean_model = Ridge(alpha=best_alpha).fit(X, y)

    coef = {"mean": {"intercept": float(mean_model.intercept_)}}
    for j, jj in enumerate(keep):
        coef["mean"][specs[jj]["name"]] = float(mean_model.coef_[j])

    # The quantile solver is O(n^2)-ish in the number of rows; a uniform subsample keeps it tractable
    # without selecting on anything. Seeded, so a rerun reproduces the artifact byte for byte.
    rng = np.random.default_rng(7)
    idx = np.arange(len(y))
    if len(y) > args.quantile_max_rows:
        idx = rng.choice(idx, size=args.quantile_max_rows, replace=False)
        idx.sort()
    Xq, yq = X[idx], y[idx]
    for name, q in (("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        if len(yq) >= 300:
            qm = QuantileRegressor(quantile=q, alpha=args.quantile_alpha, solver="highs").fit(Xq, yq)
            c = {"intercept": float(qm.intercept_)}
            for j, jj in enumerate(keep):
                c[specs[jj]["name"]] = float(qm.coef_[j])
        else:
            c = {"intercept": quantile(yq, q)}
        coef[name] = c

    # Every declared feature needs a coefficient at every head, including the ones this position is
    # not allowed to use. An ABSENT coefficient and a ZERO one look the same in a prediction and
    # completely different in a schema check, and the loader refuses the absent case on purpose.
    for h in ("mean", "p10", "p50", "p90"):
        for s in specs:
            coef[h].setdefault(s["name"], 0.0)
    return coef, len(sub)


def intercept_only(rows, pos, specs):
    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 200:
        return None, 0
    ratios = [r["pts"] / r["season_line_pg"] for r in sub]
    out = {}
    for name, q in (("mean", None), ("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        v = float(np.mean(ratios)) if q is None else quantile(ratios, q)
        c = {"intercept": v}
        for s in specs:
            c[s["name"]] = 0.0
        out[name] = c
    return out, len(sub)


def evaluate(artifact, row):
    """Predict one row with THIS script's own arithmetic -- the golden block's source of truth."""
    heads = artifact["coef"][row["pos"]]
    x = [feature_value(s, row) for s in artifact["features"]]
    out = {}
    for h in ("mean", "p10", "p50", "p90"):
        c = heads[h]
        lin = c.get("intercept", 0.0)
        for j, s in enumerate(artifact["features"]):
            lin += c.get(s["name"], 0.0) * x[j]
        lin = min(artifact["clamps"]["hi"], max(artifact["clamps"]["lo"], lin))
        out[h] = row["season_line_pg"] * lin
    return out


def golden_rows(artifact):
    """Five fixtures, chosen to be the ones most likely to expose a disagreement."""
    fixtures = [
        {"pos": "RB", "season_line_pg": 14.5, "td_games": 6, "td_ppg": 15.2, "t4_mean": 17.0,
         "t4_sd": 4.4, "td_fd": 4.0, "td_ts": 0.15, "dvp_mult": 1.12, "dvp_n": 6, "home": 1,
         "spread_line": -3.5, "total_line": 47.5, "implied_team_total": 25.5, "days_rest": 7,
         "week_no": 7},
        {"pos": "WR", "season_line_pg": 11.0, "td_games": 3, "td_ppg": 6.1, "t4_mean": 6.1,
         "t4_sd": 3.0, "td_fd": 2.2, "td_ts": 0.24, "dvp_mult": 0.88, "dvp_n": 3, "home": 0,
         "spread_line": 6.5, "total_line": 41.0, "implied_team_total": 17.25, "days_rest": 10,
         "week_no": 4},
        {"pos": "QB", "season_line_pg": 19.5, "td_games": 11, "td_ppg": 21.0, "t4_mean": 24.5,
         "t4_sd": 6.0, "td_attempts": 35.0, "td_rush_yards": 30.0, "dvp_mult": 1.05, "dvp_n": 11,
         "home": 1, "spread_line": -7.0, "total_line": 49.5, "implied_team_total": 28.25,
         "days_rest": 6, "week_no": 12},
        {"pos": "TE", "season_line_pg": 7.5, "td_games": 1, "td_ppg": 2.0, "t4_mean": 2.0,
         "t4_sd": None, "td_fd": 0.0, "td_ts": 0.08, "dvp_mult": 1.0, "dvp_n": 1, "home": 0,
         "spread_line": 1.0, "total_line": 44.0, "implied_team_total": 21.5, "days_rest": 14,
         "week_no": 3},
        # WEEK ONE, every optional input missing. This is the row where the two implementations fall
        # back on their own defaults, which is precisely where they are most likely to differ -- and
        # it is not a corner case, it is every player in week 1.
        {"pos": "RB", "season_line_pg": 9.0, "week_no": 1, "td_games": 0},
    ]
    out = []
    for fx in fixtures:
        if fx["pos"] not in artifact["coef"]:
            continue
        pred = evaluate(artifact, fx)
        # `season_line_pg` stays IN `f` as well as being the denominator. It is both: the ratio's
        # divisor AND a declared regression feature (does the ratio model miss systematically at high
        # lines?). Stripping it here dropped it from the consumer's feature dict while the trainer
        # still read it, and the golden block caught the two sides disagreeing by 4.05 points on
        # fixture 0 -- which is exactly the failure this block exists for, found on its first run.
        f = {k: v for k, v in fx.items() if k != "pos"}
        out.append({"pos": fx["pos"], "line": fx["season_line_pg"], "f": f, "expect": pred})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--seasons", default="2010-2025")
    ap.add_argument("--holdout-season", default="none")
    ap.add_argument("--features", default="all",
                    help="comma list of feature columns, or 'all'. The report says which it used.")
    ap.add_argument("--out", default="data/weekly-artifact.json")
    ap.add_argument("--population", default="rostered", choices=["rostered", "played"],
                    help="rostered (default) = every non-bye week, a did-not-play week scored as the "
                         "zero it is for the manager who started him; played = appearances only. "
                         "MUST match what the evaluator scores, or the model answers a different "
                         "question from the one asked.")
    ap.add_argument("--zero-model", default="quantile", choices=["quantile", "two-part"])
    ap.add_argument("--season-line-only", action="store_true",
                    help="emit the floor artifact: every coefficient zero, mean intercept 1.0")
    ap.add_argument("--quantile-alpha", type=float, default=0.01)
    ap.add_argument("--quantile-max-rows", type=int, default=20000)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if args.zero_model == "two-part":
        sys.exit(
            "train_weekly: --zero-model two-part is reserved for when the DATA TRACK's "
            "feat_player_week_context lands (injury designation, depth-chart rank, teammates out). "
            "Fitting P(zero week) on to-date scoring alone fits the consequence of an injury rather "
            "than the injury, and would look like structure while measuring what the mean head "
            "already sees. Refusing rather than fitting a stage this table cannot honestly feed.")

    lo, hi = parse_seasons(args.seasons)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    rows = load_rows(args.db, lo, hi, args.population)
    rows = [r for r in rows if r["season_line_pg"] and r["season_line_pg"] >= TRAIN_MIN_LINE]
    # THE HOLDOUT IS REMOVED BEFORE ANYTHING IS MEASURED -- before the transform centres, before the
    # missing-value defaults, before the alpha search. Removing it only from the final fit would
    # leave the held-out season inside every hyperparameter the model chose, which is the selection
    # effect the whole harness exists to keep out of the score.
    if holdout is not None:
        rows = [r for r in rows if r["season"] != holdout]
    if not rows:
        sys.exit("train_weekly: no training rows -- has `ff build-weekly-features` been run?")

    wanted = set(ALL_FEATURES) if args.features == "all" else {
        s.strip() for s in args.features.split(",") if s.strip()}
    unknown = wanted - set(ALL_FEATURES)
    if unknown:
        sys.exit("train_weekly: unknown feature(s) " + ", ".join(sorted(unknown)) +
                 ". Known: " + ", ".join(ALL_FEATURES))

    seasons = sorted({r["season"] for r in rows})
    positions = POS_FITTED + POS_INTERCEPT_ONLY

    if args.season_line_only:
        specs = []
        coef, counts = {}, {}
        for pos in positions:
            sub = [r["pts"] / r["season_line_pg"] for r in rows if r["pos"] == pos]
            if len(sub) < 200:
                continue
            coef[pos] = {
                "mean": {"intercept": 1.0},
                "p10": {"intercept": quantile(sub, 0.10)},
                "p50": {"intercept": quantile(sub, 0.50)},
                "p90": {"intercept": quantile(sub, 0.90)},
            }
            counts[pos] = len(sub)
        notes = ("season-line-only floor: mean intercept exactly 1.0, so the projection IS the "
                 "preseason season line per game. Quantile intercepts are the EMPIRICAL ratio "
                 "quantiles on the training seasons, which is a measured spread rather than an "
                 "invented one.")
    else:
        specs = build_specs(rows, wanted)
        if not specs:
            sys.exit("train_weekly: no feature met its coverage floor -- nothing to fit")
        coef, counts = {}, {}
        for pos in POS_FITTED:
            c, n = fit_position(rows, specs, pos, args)
            counts[pos] = n
            if c:
                coef[pos] = c
        for pos in POS_INTERCEPT_ONLY:
            c, n = intercept_only(rows, pos, specs)
            if c:
                coef[pos] = c
                counts[pos] = n
        notes = ("Ridge on the ratio actual/season-line, alpha by season-grouped CV inside the "
                 "training data; p10/p50/p90 by pinball-loss linear quantile regression across the "
                 "FULL rank range. Zero weeks are IN the fit and the clamp floor is exactly 0, so "
                 "p10 can sit on the zero atom. K and DST are intercept-only: this table carries no "
                 "kicking or defensive usage columns, so there is nothing to give them.")

    if not coef:
        sys.exit("train_weekly: nothing fitted")

    zero_share = (sum(1 for r in rows if r["pts"] <= 1.0) / len(rows)) if rows else 0.0
    artifact = {
        "schema": SCHEMA,
        "kind": "weekly",
        "fittedFrom": "tools/train_weekly.py",
        "fittedAt": date.today().isoformat(),
        "seasons": seasons,
        "holdoutSeason": holdout,
        "target": "ratio_to_season_line",
        "population": args.population,
        "trainMinLine": TRAIN_MIN_LINE,
        "features": specs,
        "coef": coef,
        "clamps": {"lo": CLAMP_LO, "hi": CLAMP_HI},
        "notes": notes + " Zero weeks (pts <= 1.0) are " + format(100 * zero_share, ".1f") +
                 "% of the training rows.",
    }
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, indent=2)
    if not args.quiet:
        print("wrote " + args.out)
        print("  seasons " + str(seasons[0]) + "-" + str(seasons[-1]) +
              (" holding out " + str(holdout) if holdout else "") +
              "; " + str(len(rows)) + " player-weeks (" + args.population + "); " +
              str(len(specs)) + " features")
        print("  features used: " + (", ".join(s["name"] for s in specs) or "(none)"))
        print("  waiting on the data track: injury_status_friday, depth_chart_rank, teammates_out, "
              "prior_snap_share, prior_route_share, vegas_implied_team_total")
        for pos in sorted(coef):
            m = coef[pos]["mean"]
            terms = ", ".join(k + " " + format(v, ".4f")
                              for k, v in sorted(m.items()) if k != "intercept" and abs(v) > 1e-4)
            print("  " + pos.ljust(4) + " n=" + str(counts.get(pos, 0)).rjust(6) +
                  "  intercept " + format(m["intercept"], ".4f") + "  " + (terms or "(intercept only)"))
        print("  golden rows: " + str(len(artifact["golden"])))


if __name__ == "__main__":
    main()
