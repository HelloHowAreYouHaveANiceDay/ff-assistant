"""Fit the season projection and emit a schema-validated artifact.

    uv run --with scikit-learn --with numpy tools/train_projection.py \
        --db data/ff.db --seasons 1999-2025 --holdout-season none \
        --out data/projection-artifact.json

WHY TRAINING LIVES HERE AND SERVING LIVES IN TYPESCRIPT.

The engine is TypeScript and must stay so: it runs inside an Electron app on a machine with no
Python toolchain, in the middle of a live auction. Fitting is a different job with different
dependencies -- quantile regression is a linear program -- and pretending otherwise means either a
hand-rolled solver in the draft engine or no quantiles at all.

The seam between them is the ARTIFACT, and a seam is exactly where a producer and a consumer drift
apart while both stay green. This repo has the scar: a producer that ships its own validator grades
its own homework and passes forever while every consumer rejects its output. So the artifact carries
a GOLDEN BLOCK -- five fixture feature rows together with THIS script's own predictions for them --
and the TypeScript loader recomputes them and refuses the artifact if the two disagree by more than
1e-6. That is the only test that can catch a transform the two sides implement differently, because
it is the only one where the two implementations are genuinely independent.

WHAT IS FITTED.

The target is the RATIO of actual points to the point-in-time conditional curve, not points. The
curve is a strong, honest predictor that already encodes rank; fitting points directly would spend
the model's capacity re-learning it. Predicting the ratio makes every coefficient a statement about
what the curve gets wrong, which is the only thing worth fitting -- and it is the same
parameterisation the shipped age and opportunity multipliers already use, so their measured lifts
are comparable to these.

The model class is deliberately small: a per-position linear predictor over named features, clamped.
The TypeScript evaluator is then a dot product, and the golden block is enough to prove the two
agree. Anything richer would need its own evaluator shipped beside it, and the artifact schema says
so out loud rather than leaving the next person to discover it.
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
# K and DST are intercept-only ON PURPOSE, not by omission. scripts/fit-kdst.mjs screened the
# fg_*/pat_*/def_* columns and NOTHING survived nested cross-validation (K -0.0073, DST -0.0041);
# the harness was verified able to detect a planted signal first, so that is a measurement and not a
# silence. See EVALUATED_NOT_SHIPPED in src/draft/models.ts.
POS_INTERCEPT_ONLY = ["K", "DST"]

BUCKET = 6
MAX_RANK = 60
# Below this the curve is not a meaningful denominator and the ratio is noise over a small number.
MIN_BASE = 20.0
# Beyond this rank the curve has flattened onto its last fitted value, so actual/curve stops
# measuring dispersion and starts measuring how far past the end of the curve we are.
QUANTILE_MAX_RANK = 36
CLAMP_LO, CLAMP_HI = 0.05, 5.0

# name -> (transform, source column). The RATIO features are divided by the mean for the player's
# rank bucket, which is what stops them re-learning the rank the curve is already indexed by: a
# WR5's raw target share is high BECAUSE he is a WR5, and that is already priced in.
RATIO_FEATURES = {
    "prior_fd": 0.05,
    "prior_ts": 0.005,
    "prior_attempts": 1.0,
    "prior_rush_yards": 0.5,
}
CENTER_FEATURES = ["age", "prior_games", "draft_round"]
INDICATOR_FEATURES = ["team_changed"]
# Which positions may carry a non-zero coefficient on each ratio feature. A quarterback has no
# target share and no receiving first downs; scoring him on them measured ~0 for twenty seasons and
# that null was then written down as a fact about quarterbacks. His workload is attempts and rushing
# yards. The pass catchers are the other way round.
RATIO_ALLOWED = {
    "prior_fd": {"RB", "WR", "TE"},
    "prior_ts": {"RB", "WR", "TE"},
    "prior_attempts": {"QB"},
    "prior_rush_yards": {"QB"},
}


def parse_seasons(s):
    parts = s.split("-")
    lo = int(parts[0])
    hi = int(parts[1]) if len(parts) > 1 else lo
    return lo, hi


def load_rows(db_path, lo, hi, base_col):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.execute(
        "SELECT feat_key, player_sk, season, name, pos, prior_pos_rank, prior_pts, prior_games, age,"
        " prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,"
        " team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd,"
        " " + base_col + " AS base, pts"
        " FROM feat_player_season"
        " WHERE season BETWEEN ? AND ? AND pts IS NOT NULL AND " + base_col + " IS NOT NULL",
        (lo, hi),
    )
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows


def bucket_of(rank):
    return int((rank - 1) // BUCKET)


def bucket_means(rows):
    """pos -> feature -> bucket -> mean. Computed on the TRAINING rows only, and shipped on the
    artifact, because a denominator recomputed by the consumer is a denominator that can differ."""
    acc = {}
    for r in rows:
        if r["prior_pos_rank"] is None:
            continue
        b = str(bucket_of(r["prior_pos_rank"]))
        for f in RATIO_FEATURES:
            v = r.get(f)
            if v is None:
                continue
            acc.setdefault(f, {}).setdefault(r["pos"], {}).setdefault(b, []).append(float(v))
    out = {}
    for f, by_pos in acc.items():
        out[f] = {}
        for pos, by_b in by_pos.items():
            out[f][pos] = {b: float(np.mean(v)) for b, v in by_b.items() if len(v) >= 10}
    return out


def build_specs(rows, bmeans):
    """The feature list, with every transform parameter measured here and written onto the artifact.

    `missing` is required to be EXPLICIT. A missing input silently becoming 0 means "this player is
    exactly average" wherever a feature is centred and "he saw no usage at all" where it is not --
    a guess wearing the costume of a default. For the centred features the explicit choice is
    mean-imputation, which is 0 after centring and is stated as such; for a ratio feature it is 1.0,
    "exactly what his rank implies".
    """
    specs = []
    for name in CENTER_FEATURES:
        vals = [float(r[name]) for r in rows if r.get(name) is not None]
        if len(vals) < 200:
            continue
        mu, sd = float(np.mean(vals)), float(np.std(vals))
        if sd <= 0:
            continue
        specs.append({
            "name": name, "transform": "center", "center": mu, "scale": sd,
            # 0 after centring IS the training mean: an explicit, stated mean-imputation.
            "missing": 0.0,
        })
    for name in INDICATOR_FEATURES:
        n = sum(1 for r in rows if r.get(name) is not None)
        if n < 200:
            continue
        specs.append({"name": name, "transform": "indicator", "missing": 0.0})
    for name, floor in RATIO_FEATURES.items():
        if name not in bmeans:
            continue
        specs.append({
            "name": name, "transform": "ratio_to_bucket_mean", "bucket": BUCKET,
            "floor": floor, "bucketMeans": bmeans[name], "missing": 1.0,
        })
    return specs


def feature_value(spec, row):
    """The evaluator, mirrored from src/model/projector.ts featureValue().

    This function existing twice is the whole reason the golden block exists. It is not duplication
    to be refactored away -- it is two independent implementations of one contract, and the artifact
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
    if t == "ratio_to_bucket_mean":
        rank = row.get("_rank")
        if rank is None:
            return spec["missing"]
        b = str(bucket_of(int(rank)))
        m = spec["bucketMeans"].get(row["pos"], {}).get(b)
        if m is None or not (m > spec.get("floor", 0.0)):
            return spec["missing"]
        return raw / m
    return spec["missing"]


def design(rows, specs):
    X = np.zeros((len(rows), len(specs)), dtype=float)
    for i, r in enumerate(rows):
        r = dict(r)
        r["_rank"] = r.get("prior_pos_rank")
        for j, s in enumerate(specs):
            X[i, j] = feature_value(s, r)
    return X


def quantile(a, q):
    return float(np.quantile(np.asarray(a, dtype=float), q)) if len(a) else 1.0


def fit_position(rows, specs, pos, args):
    """Ridge for the mean, pinball-loss linear fits for the three quantiles.

    Regularised, and the alpha is chosen by SEASON-GROUPED cross-validation inside the training data.
    Grouping by season matters: player-seasons within a year share the scoring era, the schedule and
    the injury luck, so a random split leaks between folds and every alpha looks better than it is.
    """
    from sklearn.linear_model import Ridge, QuantileRegressor
    from sklearn.model_selection import GroupKFold

    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 200:
        return None, len(sub)
    # Zero the coefficients a position must not carry, by zeroing its COLUMN. Doing it here rather
    # than after the fit means the other coefficients are fitted in the absence of the column, not
    # fitted with it and then had it removed underneath them.
    keep = [j for j, s in enumerate(specs)
            if s["name"] not in RATIO_ALLOWED or pos in RATIO_ALLOWED[s["name"]]]
    X_all = design(sub, specs)
    X = X_all[:, keep]
    y = np.array([r["pts"] / r["base"] for r in sub], dtype=float)
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

    coef = {}
    coef["mean"] = {"intercept": float(mean_model.intercept_)}
    for j, jj in enumerate(keep):
        coef["mean"][specs[jj]["name"]] = float(mean_model.coef_[j])

    # QUANTILES on the subset the board actually prices. Past rank 36 the curve has flattened and
    # `actual / curve` measures distance past the end of the curve rather than dispersion; left
    # uncapped it produced a p90 ratio of 2.24 at QB, i.e. a 731-point quarterback.
    qidx = [i for i, r in enumerate(sub)
            if r["prior_pos_rank"] is not None and r["prior_pos_rank"] <= QUANTILE_MAX_RANK]
    Xq, yq = X[qidx], y[qidx]
    for name, q in (("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        if len(yq) >= 150:
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
    sub = [r for r in rows
           if r["pos"] == pos and r["prior_pos_rank"] is not None
           and r["prior_pos_rank"] <= QUANTILE_MAX_RANK]
    if len(sub) < 50:
        return None
    ratios = [r["pts"] / r["base"] for r in sub]
    out = {}
    for name, q in (("mean", None), ("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        v = float(np.mean(ratios)) if q is None else quantile(ratios, q)
        c = {"intercept": v}
        for s in specs:
            c[s["name"]] = 0.0
        out[name] = c
    return out


def evaluate(artifact, row):
    """Predict one row with THIS script's own arithmetic -- the golden block's source of truth."""
    heads = artifact["coef"][row["pos"]]
    x = [feature_value(s, row) for s in artifact["features"]]
    mult = 1.0
    for k in artifact["multiplicative"]:
        v = row.get(k, 1.0)
        mult *= v if (v is not None and v > 0) else 1.0
    out = {}
    for h in ("mean", "p10", "p50", "p90"):
        c = heads[h]
        lin = c.get("intercept", 0.0)
        for j, s in enumerate(artifact["features"]):
            lin += c.get(s["name"], 0.0) * x[j]
        lin = min(artifact["clamps"]["hi"], max(artifact["clamps"]["lo"], lin))
        out[h] = row["base"] * lin * mult
    return out


def golden_rows(artifact):
    """Five fixtures, chosen to be the ones most likely to expose a disagreement."""
    fixtures = [
        {"pos": "RB", "base": 250.0, "_rank": 1,
         "age": 24.0, "prior_games": 17, "prior_fd": 5.0, "prior_ts": 0.18, "team_changed": 0},
        {"pos": "WR", "base": 175.0, "_rank": 12,
         "age": 29.5, "prior_games": 15, "prior_fd": 3.1, "prior_ts": 0.22, "team_changed": 1},
        {"pos": "QB", "base": 246.0, "_rank": 12,
         "age": 33.0, "prior_games": 16, "prior_attempts": 34.0, "prior_rush_yards": 12.0, "team_changed": 0},
        {"pos": "TE", "base": 101.0, "_rank": 24,
         "age": 26.0, "prior_games": 12, "prior_fd": 1.9, "prior_ts": 0.14, "team_changed": 0},
        # Every optional input missing. This is the row where the two implementations fall back on
        # their own defaults, which is precisely where they are most likely to differ.
        {"pos": "RB", "base": 120.0, "_rank": 30},
    ]
    out = []
    for fx in fixtures:
        if fx["pos"] not in artifact["coef"]:
            continue
        pred = evaluate(artifact, fx)
        f = {k: v for k, v in fx.items() if k not in ("pos", "base", "_rank")}
        out.append({"pos": fx["pos"], "base": fx["base"], "rank": fx["_rank"], "f": f, "expect": pred})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--seasons", default="1999-2025")
    ap.add_argument("--holdout-season", default="none")
    ap.add_argument("--out", default="data/projection-artifact.json")
    ap.add_argument("--base", default="curve_value_prior",
                    choices=["curve_value_prior", "curve_value_ecr", "curve_value_orderstat"])
    ap.add_argument("--quantile-alpha", type=float, default=0.01)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    lo, hi = parse_seasons(args.seasons)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    rows = load_rows(args.db, lo, hi, args.base)
    rows = [r for r in rows
            if r["base"] and r["base"] > MIN_BASE
            and r["prior_pos_rank"] is not None and r["prior_pos_rank"] <= MAX_RANK]
    # THE HOLDOUT IS REMOVED BEFORE ANYTHING IS MEASURED -- before the bucket means, before the
    # transform centres, before the alpha search. Removing it only from the final fit would leave the
    # held-out season inside every hyperparameter the model chose, which is the selection effect this
    # whole harness exists to keep out of the score.
    if holdout is not None:
        rows = [r for r in rows if r["season"] != holdout]
    if not rows:
        sys.exit("train_projection: no training rows -- has `ff build-features` been run?")

    bmeans = bucket_means(rows)
    specs = build_specs(rows, bmeans)

    coef, counts = {}, {}
    for pos in POS_FITTED:
        c, n = fit_position(rows, specs, pos, args)
        counts[pos] = n
        if c:
            coef[pos] = c
    for pos in POS_INTERCEPT_ONLY:
        c = intercept_only(rows, pos, specs)
        if c:
            coef[pos] = c
            counts[pos] = sum(1 for r in rows if r["pos"] == pos)

    if not coef:
        sys.exit("train_projection: nothing fitted")

    seasons = sorted({r["season"] for r in rows})
    artifact = {
        "schema": SCHEMA,
        "kind": "projection",
        "fittedFrom": "tools/train_projection.py",
        "fittedAt": date.today().isoformat(),
        "seasons": seasons,
        "holdoutSeason": holdout,
        "base": args.base,
        "features": specs,
        # EMPTY, and that is the point. Age is a fitted feature here, so declaring the age multiplier
        # as well would apply age twice -- once as a coefficient and once as a factor. The curve-only
        # artifact declares both because it has no coefficients at all.
        "multiplicative": [],
        "coef": coef,
        "clamps": {"lo": CLAMP_LO, "hi": CLAMP_HI},
        "notes": (
            "Ridge on the ratio actual/curve, alpha chosen by season-grouped CV inside the training "
            "data; p10/p50/p90 by pinball-loss linear quantile regression on ranks 1-"
            + str(QUANTILE_MAX_RANK) + ". K and DST are intercept-only by MEASUREMENT, not omission "
            "(nested CV: K -0.0073, DST -0.0041; see EVALUATED_NOT_SHIPPED in src/draft/models.ts)."
        ),
    }
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, indent=2)
    if not args.quiet:
        print("wrote " + args.out)
        print("  seasons " + str(seasons[0]) + "-" + str(seasons[-1]) +
              (" holding out " + str(holdout) if holdout else "") +
              "; base " + args.base + "; " + str(len(specs)) + " features")
        for pos in sorted(coef):
            m = coef[pos]["mean"]
            terms = ", ".join(k + " " + format(v, ".4f") for k, v in m.items() if k != "intercept" and abs(v) > 1e-9)
            print("  " + pos.ljust(4) + " n=" + str(counts.get(pos, 0)).rjust(5) +
                  "  intercept " + format(m["intercept"], ".4f") + "  " + (terms or "(intercept only)"))
        print("  golden rows: " + str(len(artifact["golden"])))


if __name__ == "__main__":
    main()
