"""Fit the WEEKLY projection and emit a schema-validated artifact.

    uv run --with scikit-learn --with numpy tools/train_weekly.py \
        --db data/ff.db --seasons 2010-2025 --holdout-season none \
        --features all --zero-model two-part --out data/weekly-artifact.json

WHY TRAINING LIVES HERE AND SERVING LIVES IN TYPESCRIPT: the same reason tools/train_projection.py
gives one horizon up. The engine is TypeScript and runs inside an Electron app on a machine with no
Python, in the middle of a live season. Quantile regression is a linear program. The seam between
the two is the ARTIFACT, and a seam is exactly where a producer and a consumer drift apart while
both stay green -- so the artifact carries a GOLDEN BLOCK, six fixture rows with THIS script's own
predictions, and src/weekly/projector.ts refuses the artifact if it cannot reproduce them to 1e-6.

WHAT IS FITTED.

The target is `pts / season_line_pg` -- the week's actual points as a multiple of what the preseason
season projection said the player was worth per game. The season line already encodes who the player
is; fitting points directly would spend the model's capacity re-learning talent. Every coefficient
is then a statement about what the season line gets WRONG week to week, which is the only thing a
weekly model can add.

THE ZERO ATOM, AND THE TWO MODELS THAT CAN TREAT IT.

Weekly fantasy points are zero-inflated twice over: a rostered man can fail to play at all, and a
receiver who plays can catch nothing. Measured on 2010-2025 rostered non-bye weeks, 29.5% of the rows
this script trains on score at or below 1.0 point.

  --zero-model quantile  (Phase 2c, and still the default)
      One set of heads fitted on the POOLED target, zeros included, with the clamp floor at exactly
      0 so p10 is free to sit on the atom and does. Its limitation is structural rather than a
      calibration failure: 0.10 is the smallest quantile level it publishes, so the largest zero
      probability it can express is 0.10, however certain the zero is. Against an actual zero share
      near 0.40 that is not a model that is slightly wrong, it is a model that cannot say the thing.

  --zero-model two-part  (Phase 2d, and what the availability columns make honest)
      Stage one: P(zero week), a per-position REGULARISED LOGISTIC fit led by the injury designation,
      the practice report, depth-chart rank and how many team-mates at his position are Out.
      Stage two: the ratio GIVEN HE PLAYED, fitted on played weeks only, at a grid of quantile levels.
      The published p10/p50/p90 are the MIXTURE's, so p10 is exactly 0 whenever the zero probability
      exceeds 0.10, and E[points] is P(he plays) * E[ratio | he plays] * line.

WHY --zero-model two-part USED TO REFUSE TO RUN. The signals that drive stage one -- injury
designation, depth-chart rank, whether the man ahead of him is out -- were the DATA TRACK's
`feat_player_week_context` and were not joined into this table. A zero-probability stage fitted on
to-date scoring alone fits the CONSEQUENCE of an injury rather than the injury; it would look like
structure while measuring what the mean head already sees. Those columns have landed, so the refusal
is now CONDITIONAL on them actually being in the feature set rather than unconditional -- and it is
still a refusal, because a two-part model fitted without them is the same worthless thing it always
was.
"""

import argparse
import hashlib
import json
import math
import sqlite3
import sys
from datetime import date

import numpy as np

SCHEMA = 2
POS_FITTED = ["QB", "RB", "WR", "TE"]
POS_INTERCEPT_ONLY = ["K", "DST"]

# Below this preseason line the ratio is noise over a small number: a 1.0-points-per-game line and a
# 12-point week is a ratio of 12, and thirty of those dominate the fit. TRAINING ONLY -- a small line
# still projects at serve time, it just projects small.
TRAIN_MIN_LINE = 3.0
# THE ROW FILTER, AND WHY IT IS NO LONGER THE LINE CUT.
#
# `season_line_pg >= TRAIN_MIN_LINE` was a modelling convenience, and the harness scored a different
# set -- every non-bye rostered row, deep bench included. The two zero rates differ by 0.11 (QB),
# 0.11 (RB), 0.16 (WR) and 0.21 (TE), three to seven times the weekly gate's 0.030 tolerance, and no
# intercept fitted on the first can be calibrated for the second. So the population is now defined
# ONCE, by the DECISION, in src/weekly/population.ts, and materialised as a flag column that both
# this trainer and the TypeScript harness read. Nothing about the rule is restated in Python: this
# file reads `in_population`, it does not recompute it.
POPULATION_COLUMN = "in_population"
ROW_FILTER = "in_population"

# MEN CARRIED AT EACH POSITION PLUS THE STATED MARGIN. A COPY, and it is checked rather than trusted:
# `population_signature` below asserts these against what the store's flags imply, so a change to
# src/weekly/population.ts that is not mirrored here fails loudly instead of producing a hash that
# silently disagrees with the one the registry computes.
POPULATION_DEPTH = {"QB": 42, "RB": 71, "WR": 79, "TE": 41, "K": 34, "DST": 37}


def population_signature(con):
    """THE STORE'S POPULATION, AS A SHORT STRING, byte-identical to `populationSignature` in
    src/weekly/population.ts.

    WHY THE ARTIFACT CARRIES IT. `rowFilter: "in_population"` says WHICH RULE selected the training
    rows. It does not say WHICH POPULATION -- rebuild the flags with a different depth or another
    season of roster feed and an artifact fitted on the old set still declares the same rule, still
    loads, and models players the store no longer selects. The hash is what makes that visible;
    `weeklyPopulationProblem` in src/draft/models.ts refuses an artifact whose hash has moved.

    The body must serialise EXACTLY as JSON.stringify does on the TypeScript side: no spaces, keys in
    insertion order, seasons as [season, count] pairs ascending. A hash that differs only in
    whitespace is a hash that never matches, which would read as a permanently stale artifact.
    """
    rows = con.execute(
        "SELECT season, COUNT(*) FROM feat_player_week_model"
        " WHERE " + POPULATION_COLUMN + " = 1 GROUP BY season ORDER BY season").fetchall()
    if not rows:
        return None, 0
    body = json.dumps(
        {"depth": POPULATION_DEPTH, "seasons": [[int(s), int(n)] for s, n in rows]},
        separators=(",", ":"),
    )
    total = sum(int(n) for _, n in rows)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16], total


# The clamp is on the RATIO. lo is 0 and not 0.01, on purpose: the quantile heads have to be able to
# reach the zero atom, and a small positive floor would quietly convert every projected zero week
# into a small positive number that no metric flags.
CLAMP_LO, CLAMP_HI = 0.0, 4.0

# THE SECOND STAGE'S QUANTILE GRID. The consumer interpolates the mixture on it, so it is written ON
# the artifact rather than agreed by convention. Seven levels rather than three because the mixture
# shift q -> (q - pZero)/(1 - pZero) moves the level that has to be evaluated: with a zero
# probability of 0.3, the published p50 is the 0.286-quantile of the played distribution and the
# published p90 is its 0.857-quantile, neither of which a three-level ladder can supply.
QUANTILE_GRID = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.90]

# A zero WEEK, and the same threshold src/weekly/evaluate.ts uses. `pts <= 0`, not the 1.0 the
# earlier note quoted: gate clause (b) is coverage conditional on pts > 0 and clause (c) is the share
# of zero weeks, and those two have to partition the same rows.
ZERO_PTS = 0.0

# Feature name -> transform family. The names are validated against src/weekly/features.ts's
# published dictionary by the TypeScript loader; this list is the producing half of that contract.
RATIO_TO_LINE = ["td_ppg", "t4_mean", "t4_sd"]
CENTER = [
    "td_games", "dvp_mult", "dvp_n", "spread_line", "total_line",
    "implied_team_total", "days_rest", "week_no", "season_line_pg",
    "td_fd", "td_ts", "td_attempts", "td_rush_yards",
    # THE AVAILABILITY BLOCK. Every one of these is keyed to this team's own kickoff rather than to
    # the league week's first kickoff; src/weekly/features.ts CONTEXT_FIELDS carries each column's
    # as-of rule and the reason the anchor is different.
    "prior_snap_share", "prior_route_share", "depth_rank", "teammates_out",
]
INDICATOR = [
    "home",
    "inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited",
    # NOT an injury signal: 1 where the feed published a dated report for this league-week at all.
    # From 2025 it stopped publishing dates, so every status is NULL for reasons that have nothing
    # to do with who could play, and without this column the model reads that as a healthy league.
    "inj_feed",
]

# Which positions may carry a non-zero coefficient on each usage feature. A quarterback has no target
# share and no receiving first downs; scoring him on them measures ~0 and then that null gets written
# down as a fact about quarterbacks. His workload is attempts and rushing yards.
POS_GATED = {
    "td_fd": {"RB", "WR", "TE"},
    "td_ts": {"RB", "WR", "TE"},
    "td_attempts": {"QB"},
    "td_rush_yards": {"QB"},
    # A quarterback runs no routes. The charted route share is a receiver's workload column and
    # fitting it for QB measures the participation feed's coverage, not his job.
    "prior_route_share": {"RB", "WR", "TE"},
}

# The columns stage one is not allowed to be run without. A two-part model whose first stage sees
# only to-date scoring fits the consequence of an injury rather than the injury.
AVAILABILITY_REQUIRED = ["inj_out", "depth_rank", "teammates_out", "prior_snap_share"]

ALL_FEATURES = RATIO_TO_LINE + CENTER + INDICATOR

SELECT_COLS = [
    "feat_key", "player_sk", "season", "week", "name", "pos", "season_line_pg",
    "td_games", "td_ppg", "t4_mean", "t4_sd", "td_fd", "td_ts", "td_attempts", "td_rush_yards",
    "dvp_mult", "dvp_n", "home", "spread_line", "total_line", "implied_team_total", "days_rest",
    "prior_snap_share", "prior_route_share", "depth_rank", "teammates_out",
    "inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "inj_feed",
]


def parse_seasons(s):
    parts = s.split("-")
    lo = int(parts[0])
    hi = int(parts[1]) if len(parts) > 1 else lo
    return lo, hi


def grid_head(q):
    """Grid level -> head name. Mirrored in src/weekly/projector.ts gridHead()."""
    return "q" + str(int(round(q * 100))).rjust(2, "0")


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

    NOTE the two-part model uses BOTH: stage one is fitted on the whole `rostered` population (that
    is where the zeros are) and stage two on its played subset. It is one population with a split
    inside it, not two populations, which is why the artifact still records `rostered`.
    """
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    where = "pts IS NOT NULL" if population == "played" else "COALESCE(is_bye, 0) = 0"
    # THE DECISION POPULATION, READ AND NOT RECOMPUTED. A missing or unbuilt column is a REFUSAL and
    # not a fallback to "everything": falling back would silently fit the old, wider set while the
    # artifact claimed the new one, which is the same class of defect this whole change is about.
    cols = {r[1] for r in con.execute("PRAGMA table_info(feat_player_week_model)")}
    if POPULATION_COLUMN not in cols:
        con.close()
        sys.exit(
            "train_weekly: feat_player_week_model has no `" + POPULATION_COLUMN + "` column. It is "
            "the decision population defined in src/weekly/population.ts and materialised by "
            "`ff build-weekly-population`; without it this trainer and the harness would select "
            "different players and the gate's zero-share clause would measure that gap rather than "
            "the model.")
    built = con.execute(
        "SELECT COUNT(*) FROM feat_player_week_model"
        " WHERE season BETWEEN ? AND ? AND " + POPULATION_COLUMN + " IS NOT NULL", (lo, hi)).fetchone()[0]
    if not built:
        con.close()
        sys.exit(
            "train_weekly: the `" + POPULATION_COLUMN + "` column exists but no row in " +
            str(lo) + "-" + str(hi) + " has been built. Run `ff build-weekly-population`.")
    cur = con.execute(
        "SELECT " + ", ".join(SELECT_COLS) + ", COALESCE(pts, 0.0) AS pts"
        " FROM feat_player_week_model"
        " WHERE season BETWEEN ? AND ? AND " + where + " AND season_line_pg IS NOT NULL"
        "   AND " + POPULATION_COLUMN + " = 1",
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

    An INDICATOR's missing default is 0, which for the injury block means "not carrying that
    designation". That is the right reading where the feed spoke and said nothing about him, and the
    WRONG one where the feed did not speak at all -- which is precisely what `inj_feed` is for: it
    is 0 exactly there, so the model has a column that separates the two cases instead of a default
    that quietly conflates them.
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


def keep_for(specs, pos):
    return [j for j, s in enumerate(specs)
            if s["name"] not in POS_GATED or pos in POS_GATED[s["name"]]]


def head_from(model_coef, model_intercept, specs, keep):
    """One head, as a {intercept, feature: coefficient} dict with EVERY declared feature present.

    An ABSENT coefficient and a ZERO one look the same in a prediction and completely different in a
    schema check, and the loader refuses the absent case on purpose.
    """
    c = {"intercept": float(model_intercept)}
    for j, jj in enumerate(keep):
        c[specs[jj]["name"]] = float(model_coef[j])
    for s in specs:
        c.setdefault(s["name"], 0.0)
    return c


def flat_head(value, specs):
    c = {"intercept": float(value)}
    for s in specs:
        c[s["name"]] = 0.0
    return c


def best_ridge_alpha(X, y, groups, alphas):
    """Alpha by SEASON-GROUPED cross-validation inside the training data.

    Grouping by season matters more here than at the season horizon: player-weeks inside one year
    share the scoring era, the schedule and the injury luck, and a random split puts the same
    player's week 4 in the training fold and his week 5 in the test fold, which is a leak that
    flatters every alpha.
    """
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import GroupKFold

    n_splits = min(5, len(set(groups.tolist())))
    best, best_err = alphas[0], float("inf")
    if n_splits < 2:
        return best
    gkf = GroupKFold(n_splits=n_splits)
    for a in alphas:
        err, n = 0.0, 0
        for tr, te in gkf.split(X, y, groups):
            m = Ridge(alpha=a).fit(X[tr], y[tr])
            p = m.predict(X[te])
            err += float(np.sum((y[te] - p) ** 2))
            n += len(te)
        if n and err / n < best_err:
            best_err, best = err / n, a
    return best


def fit_quantile_heads(X, y, levels, args, names_specs, keep):
    """Pinball-loss linear quantile regression at each level, on a seeded uniform subsample.

    THE QUANTILES ARE FITTED ACROSS THE FULL RANK RANGE, unlike the season model, which caps at
    rank 36 because its curve flattens past that. There is no such flattening here: the denominator
    is a per-player season line, not a rank-indexed curve, so `actual/line` keeps meaning the same
    thing all the way down the board -- and a lineup decision at the bottom of a roster is exactly
    where a weekly spread has to be right.
    """
    from sklearn.linear_model import QuantileRegressor

    rng = np.random.default_rng(7)
    idx = np.arange(len(y))
    if len(y) > args.quantile_max_rows:
        idx = rng.choice(idx, size=args.quantile_max_rows, replace=False)
        idx.sort()
    Xq, yq = X[idx], y[idx]
    out = {}
    for q in levels:
        if len(yq) >= 300:
            qm = QuantileRegressor(quantile=q, alpha=args.quantile_alpha, solver="highs").fit(Xq, yq)
            out[q] = head_from(qm.coef_, qm.intercept_, names_specs, keep)
        else:
            out[q] = flat_head(quantile(yq, q), names_specs)
    return out


def fit_position_quantile(rows, specs, pos, args):
    """The Phase 2c model: ridge for the mean and three quantile heads, all on the POOLED target."""
    from sklearn.linear_model import Ridge

    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 500:
        return None, len(sub)
    keep = keep_for(specs, pos)
    X = design(sub, specs)[:, keep]
    y = np.array([r["pts"] / r["season_line_pg"] for r in sub], dtype=float)
    groups = np.array([r["season"] for r in sub])

    alpha = best_ridge_alpha(X, y, groups, [0.1, 1.0, 10.0, 100.0])
    mean_model = Ridge(alpha=alpha).fit(X, y)
    coef = {"mean": head_from(mean_model.coef_, mean_model.intercept_, specs, keep)}
    heads = fit_quantile_heads(X, y, [0.10, 0.50, 0.90], args, specs, keep)
    coef["p10"], coef["p50"], coef["p90"] = heads[0.10], heads[0.50], heads[0.90]
    return coef, len(sub)


def fit_position_two_part(rows, specs, pos, args):
    """STAGE ONE: will he play. STAGE TWO: how much, given he did.

    Stage one is a logistic on the WHOLE rostered population -- that is where the zeros are -- with
    the inverse-regularisation strength chosen by season-grouped CV on log loss, for the same reason
    the ridge alpha is: a random split puts the same player's week 4 and week 5 on opposite sides.

    Stage two is fitted on PLAYED WEEKS ONLY, which is the one place in this file where that
    population is correct: it is estimating E[ratio | he played] and the quantiles of the same
    conditional distribution, and the mixture puts the zeros back at serve time.
    """
    from sklearn.linear_model import LogisticRegression, Ridge
    from sklearn.model_selection import GroupKFold

    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 500:
        return None, len(sub)
    keep = keep_for(specs, pos)
    X = design(sub, specs)[:, keep]
    groups = np.array([r["season"] for r in sub])
    yz = np.array([1 if r["pts"] <= ZERO_PTS else 0 for r in sub], dtype=int)

    # ---- stage one ----
    if len(set(yz.tolist())) < 2:
        return None, len(sub)
    n_splits = min(5, len(set(groups.tolist())))
    Cs = [0.03, 0.1, 0.3, 1.0]
    bestC, best_ll = Cs[0], float("inf")
    if n_splits >= 2:
        gkf = GroupKFold(n_splits=n_splits)
        for C in Cs:
            ll, n = 0.0, 0
            for tr, te in gkf.split(X, yz, groups):
                if len(set(yz[tr].tolist())) < 2:
                    continue
                m = LogisticRegression(C=C, max_iter=2000).fit(X[tr], yz[tr])
                p = np.clip(m.predict_proba(X[te])[:, 1], 1e-9, 1 - 1e-9)
                ll += float(-np.sum(yz[te] * np.log(p) + (1 - yz[te]) * np.log(1 - p)))
                n += len(te)
            if n and ll / n < best_ll:
                best_ll, bestC = ll / n, C
    zm = LogisticRegression(C=bestC, max_iter=2000).fit(X, yz)
    coef = {"zero": head_from(zm.coef_[0], zm.intercept_[0], specs, keep)}

    # ---- OPTIONAL: PLATT-STYLE INTERCEPT RECALIBRATION OF STAGE ONE ----
    #
    # THE PRE-REGISTERED P48 CORRECTION -- KEPT, AND IT MEASURED ~ZERO. READ THIS BEFORE REUSING IT.
    #
    # The weekly gate's clause (c) asks whether the model's mean predicted P(zero week) matches the
    # actual share, per position, within 0.030. The two-part model missed at RB (0.031), WR (0.039)
    # and TE (0.074), always in the same direction -- which looks exactly like a LEVEL error with an
    # obvious one-number fix. So: ONE number per position, added to the intercept, chosen so the mean
    # predicted probability ON THE TRAINING FOLD equals the observed zero rate on the same rows.
    # Every coefficient left as fitted. The solve is a bisection on a strictly increasing function.
    #
    # MEASURED, 2026-09-09: the shifts are +0.0009, +0.0003, -0.0005, -0.0005 at QB/RB/WR/TE, and
    # `ff evaluate-weekly --recalibrate-zero` reproduces the failing numbers to three decimals. P48
    # FAILED, and it could not have done anything else, for two reasons:
    #
    #   1. An MLE logistic WITH an intercept is already mean-calibrated on its own training set --
    #      the intercept's score equation is exactly sum(p_i) = sum(y_i). Only the L2 penalty
    #      perturbs it, which is the 0.0005. There was never anything here to correct.
    #   2. The trainer fits on `season_line_pg >= trainMinLine` and the harness scores EVERY non-bye
    #      row, including the deep bench where a zero is near-certain. Those two populations differ
    #      in zero rate by 0.11 to 0.21 at QB/RB/WR/TE (`scripts/zero-share-population.mjs`), so no
    #      intercept chosen on the first can be right for the second.
    #
    # ON THE TRAINING FOLD IS STILL THE ENTIRE POINT, and it is why the flag is kept rather than
    # deleted: choosing the shift on the SCORED rows would close clause (c) by fitting the gate,
    # which makes the gate unfailable and measures nothing. The flag exists so that the honest
    # version is the easy one to run and the dishonest one has to be written on purpose.
    if getattr(args, "recalibrate_zero", False):
        z_raw = X @ zm.coef_[0] + zm.intercept_[0]
        target = float(yz.mean())

        def mean_p(shift):
            return float(np.mean(1.0 / (1.0 + np.exp(-(z_raw + shift)))))

        lo, hi = -10.0, 10.0
        # A guard, not a formality: if the target is outside what any shift can reach (it cannot be,
        # for a target strictly inside (0,1), but a degenerate fold could make it so) the bisection
        # would silently return a bound.
        if mean_p(lo) <= target <= mean_p(hi):
            for _ in range(80):
                mid = 0.5 * (lo + hi)
                if mean_p(mid) < target:
                    lo = mid
                else:
                    hi = mid
            shift = 0.5 * (lo + hi)
            coef["zero"]["intercept"] = float(coef["zero"]["intercept"] + shift)
            print(f"  {pos}: stage-one intercept recalibrated by {shift:+.4f} "
                  f"(train mean P(zero) {mean_p(0.0):.4f} -> {mean_p(shift):.4f}, actual {target:.4f})")
        else:
            print(f"  {pos}: stage-one recalibration SKIPPED -- target {target:.4f} is outside "
                  f"[{mean_p(lo):.4f}, {mean_p(hi):.4f}], which no intercept shift can reach")

    # ---- stage two, on played weeks only ----
    played = yz == 0
    if int(played.sum()) < 500:
        return None, len(sub)
    Xp = X[played]
    yp = np.array([r["pts"] / r["season_line_pg"] for r in sub], dtype=float)[played]
    gp = groups[played]
    alpha = best_ridge_alpha(Xp, yp, gp, [0.1, 1.0, 10.0, 100.0])
    mean_model = Ridge(alpha=alpha).fit(Xp, yp)
    coef["mean"] = head_from(mean_model.coef_, mean_model.intercept_, specs, keep)
    for q, h in fit_quantile_heads(Xp, yp, QUANTILE_GRID, args, specs, keep).items():
        coef[grid_head(q)] = h
    return coef, len(sub)


def logit(p):
    p = min(1 - 1e-9, max(1e-9, float(p)))
    return math.log(p / (1 - p))


def intercept_only(rows, pos, specs, zero_model):
    """K and DST: this table carries no kicking or defensive usage columns, so there is nothing to
    give them beyond the ratio's own distribution. Under the two-part model that still means two
    intercepts -- the empirical zero rate and the played distribution -- not one."""
    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 200:
        return None, 0
    ratios = [r["pts"] / r["season_line_pg"] for r in sub]
    if zero_model == "quantile":
        out = {}
        for name, q in (("mean", None), ("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
            v = float(np.mean(ratios)) if q is None else quantile(ratios, q)
            out[name] = flat_head(v, specs)
        return out, len(sub)
    played = [r["pts"] / r["season_line_pg"] for r in sub if r["pts"] > ZERO_PTS]
    if len(played) < 100:
        return None, 0
    zero_rate = 1.0 - len(played) / len(sub)
    out = {"zero": flat_head(logit(zero_rate), specs),
           "mean": flat_head(float(np.mean(played)), specs)}
    for q in QUANTILE_GRID:
        out[grid_head(q)] = flat_head(quantile(played, q), specs)
    return out, len(sub)


def evaluate(artifact, row):
    """Predict one row with THIS script's own arithmetic -- the golden block's source of truth.

    MIRRORED, line for line, by src/weekly/projector.ts projectWeekly(). The mixture is where the two
    sides are most likely to drift, because it is the only part with a branch in it, so the golden
    block carries pZero as well as the four published heads.
    """
    heads = artifact["coef"][row["pos"]]
    specs = artifact["features"]
    x = [feature_value(s, row) for s in specs]
    line = row["season_line_pg"]

    def lin(h):
        c = heads[h]
        v = c.get("intercept", 0.0)
        for j, s in enumerate(specs):
            v += c.get(s["name"], 0.0) * x[j]
        return v

    lo, hi = artifact["clamps"]["lo"], artifact["clamps"]["hi"]

    def clamped(h):
        return min(hi, max(lo, lin(h)))

    if artifact.get("zeroModel") != "two-part":
        return {h: line * clamped(h) for h in ("mean", "p10", "p50", "p90")}

    z = lin("zero")
    p_zero = 1.0 / (1.0 + math.exp(-z)) if z >= 0 else math.exp(z) / (1.0 + math.exp(z))
    ratio = clamped("mean")
    grid = artifact["quantileGrid"]
    vals, prev = [], lo
    for q in grid:
        v = max(prev, clamped(grid_head(q)))
        vals.append(v)
        prev = v

    def mix_q(q):
        if p_zero >= 1:
            return 0.0
        qp = (q - p_zero) / (1.0 - p_zero)
        if not (qp > 0):
            return 0.0
        if qp >= grid[-1]:
            return vals[-1]
        lo_q, lo_v = 0.0, 0.0
        for i, g in enumerate(grid):
            if qp <= g:
                span = g - lo_q
                return lo_v + (vals[i] - lo_v) * ((qp - lo_q) / span) if span > 0 else vals[i]
            lo_q, lo_v = g, vals[i]
        return vals[-1]

    return {
        "mean": line * (1.0 - p_zero) * ratio,
        "p10": line * mix_q(0.10), "p50": line * mix_q(0.50), "p90": line * mix_q(0.90),
        "pZero": p_zero,
    }


def golden_rows(artifact):
    """Six fixtures, chosen to be the ones most likely to expose a disagreement."""
    fixtures = [
        {"pos": "RB", "season_line_pg": 14.5, "td_games": 6, "td_ppg": 15.2, "t4_mean": 17.0,
         "t4_sd": 4.4, "td_fd": 4.0, "td_ts": 0.15, "dvp_mult": 1.12, "dvp_n": 6, "home": 1,
         "spread_line": -3.5, "total_line": 47.5, "implied_team_total": 25.5, "days_rest": 7,
         "week_no": 7, "prior_snap_share": 0.72, "prior_route_share": 0.41, "depth_rank": 1,
         "teammates_out": 0, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1},
        {"pos": "WR", "season_line_pg": 11.0, "td_games": 3, "td_ppg": 6.1, "t4_mean": 6.1,
         "t4_sd": 3.0, "td_fd": 2.2, "td_ts": 0.24, "dvp_mult": 0.88, "dvp_n": 3, "home": 0,
         "spread_line": 6.5, "total_line": 41.0, "implied_team_total": 17.25, "days_rest": 10,
         "week_no": 4, "prior_snap_share": 0.61, "prior_route_share": 0.55, "depth_rank": 2,
         "teammates_out": 1, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 1,
         "prac_dnp": 0, "prac_limited": 1, "inj_feed": 1},
        {"pos": "QB", "season_line_pg": 19.5, "td_games": 11, "td_ppg": 21.0, "t4_mean": 24.5,
         "t4_sd": 6.0, "td_attempts": 35.0, "td_rush_yards": 30.0, "dvp_mult": 1.05, "dvp_n": 11,
         "home": 1, "spread_line": -7.0, "total_line": 49.5, "implied_team_total": 28.25,
         "days_rest": 6, "week_no": 12, "prior_snap_share": 1.0, "depth_rank": 1,
         "teammates_out": 0, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1},
        {"pos": "TE", "season_line_pg": 7.5, "td_games": 1, "td_ppg": 2.0, "t4_mean": 2.0,
         "t4_sd": None, "td_fd": 0.0, "td_ts": 0.08, "dvp_mult": 1.0, "dvp_n": 1, "home": 0,
         "spread_line": 1.0, "total_line": 44.0, "implied_team_total": 21.5, "days_rest": 14,
         "week_no": 3, "prior_snap_share": 0.35, "prior_route_share": 0.22, "depth_rank": 3,
         "teammates_out": 0, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1},
        # WEEK ONE, every optional input missing. This is the row where the two implementations fall
        # back on their own defaults, which is precisely where they are most likely to differ -- and
        # it is not a corner case, it is every player in week 1.
        {"pos": "RB", "season_line_pg": 9.0, "week_no": 1, "td_games": 0},
        # AN OUT DESIGNATION. The row the two-part model exists for: a healthy-looking usage history
        # with the Friday report saying he will not play. Under the quantile model this fixture is
        # nearly indistinguishable from the first one; under the two-part model p10 and p50 must
        # collapse onto the atom, and if the consumer's mixture branch is wrong this is the row that
        # says so.
        {"pos": "WR", "season_line_pg": 13.0, "td_games": 8, "td_ppg": 14.0, "t4_mean": 15.5,
         "t4_sd": 4.0, "td_fd": 3.4, "td_ts": 0.27, "dvp_mult": 1.02, "dvp_n": 8, "home": 1,
         "spread_line": -2.5, "total_line": 46.0, "implied_team_total": 24.25, "days_rest": 7,
         "week_no": 9, "prior_snap_share": 0.85, "prior_route_share": 0.78, "depth_rank": 1,
         "teammates_out": 0, "inj_out": 1, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 1, "prac_limited": 0, "inj_feed": 1},
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
    ap.add_argument("--recalibrate-zero", action="store_true",
                    help="two-part only: after fitting stage one, shift each position's LOGISTIC "
                         "INTERCEPT so the mean predicted P(zero week) on the TRAINING rows equals "
                         "the observed zero rate. Coefficients are untouched -- this corrects the "
                         "level, which is what the weekly gate's clause (c) measures, and cannot "
                         "change the model's ranking of players. K and DST already use the empirical "
                         "rate and are unaffected.")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    lo, hi = parse_seasons(args.seasons)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    rows = load_rows(args.db, lo, hi, args.population)
    # The identity of the population these rows came from, stamped on the artifact. Read from the
    # SAME store, in the same run, so it cannot describe a different build than the one fitted.
    _con = sqlite3.connect(args.db)
    try:
        pop_hash, pop_rows = population_signature(_con)
    finally:
        _con.close()
    # NO SECOND FILTER HERE. `load_rows` selected the decision population in SQL; re-cutting it on
    # the season line would put a Python-side rule back beside the shared one, which is the drift
    # this change removed.
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
        zero_model = "quantile"
        notes = ("season-line-only floor: mean intercept exactly 1.0, so the projection IS the "
                 "preseason season line per game. Quantile intercepts are the EMPIRICAL ratio "
                 "quantiles on the training seasons, which is a measured spread rather than an "
                 "invented one.")
    else:
        specs = build_specs(rows, wanted)
        if not specs:
            sys.exit("train_weekly: no feature met its coverage floor -- nothing to fit")
        zero_model = args.zero_model
        # THE REFUSAL, now conditional on the columns rather than unconditional. A two-part model
        # whose first stage cannot see the injury report, the depth chart or the snap history is
        # fitting the CONSEQUENCE of an injury (a bad recent week) rather than the injury, and it
        # would look like structure while measuring what the mean head already sees.
        if zero_model == "two-part":
            have = {s["name"] for s in specs}
            gone = [c for c in AVAILABILITY_REQUIRED if c not in have]
            if gone:
                sys.exit(
                    "train_weekly: --zero-model two-part needs the availability columns and these "
                    "are absent from the fitted feature set: " + ", ".join(gone) + ". They come "
                    "from feat_player_week_context via `ff build-weekly-features`; either that has "
                    "not been run against this store, or --features excluded them, or they failed "
                    "the 500-row coverage floor. Fitting P(zero week) on to-date scoring alone fits "
                    "the consequence of an injury rather than the injury, so this refuses rather "
                    "than fitting a stage it cannot honestly feed.")
        coef, counts = {}, {}
        fit = fit_position_two_part if zero_model == "two-part" else fit_position_quantile
        for pos in POS_FITTED:
            c, n = fit(rows, specs, pos, args)
            counts[pos] = n
            if c:
                coef[pos] = c
        for pos in POS_INTERCEPT_ONLY:
            c, n = intercept_only(rows, pos, specs, zero_model)
            if c:
                coef[pos] = c
                counts[pos] = n
        if zero_model == "two-part":
            notes = ("TWO-PART. Stage one is a per-position logistic on P(pts <= 0) over the whole "
                     "rostered population, C by season-grouped CV on log loss. Stage two is ridge "
                     "for E[ratio | played] plus pinball-loss quantile heads at " +
                     str(len(QUANTILE_GRID)) + " levels, fitted on PLAYED weeks only. The published "
                     "p10/p50/p90 are the MIXTURE's, so p10 is exactly 0 wherever the zero "
                     "probability exceeds 0.10 -- which a pooled quantile fit cannot say at all. "
                     "K and DST are two intercepts: this table carries no kicking or defensive "
                     "usage columns.")
        else:
            notes = ("Ridge on the ratio actual/season-line, alpha by season-grouped CV inside the "
                     "training data; p10/p50/p90 by pinball-loss linear quantile regression across "
                     "the FULL rank range. Zero weeks are IN the fit and the clamp floor is exactly "
                     "0, so p10 can sit on the zero atom. K and DST are intercept-only: this table "
                     "carries no kicking or defensive usage columns.")

    if not coef:
        sys.exit("train_weekly: nothing fitted")

    zero_share = (sum(1 for r in rows if r["pts"] <= ZERO_PTS) / len(rows)) if rows else 0.0
    artifact = {
        "schema": SCHEMA,
        "kind": "weekly",
        "zeroModel": zero_model,
        "fittedFrom": "tools/train_weekly.py",
        "fittedAt": date.today().isoformat(),
        "seasons": seasons,
        "holdoutSeason": holdout,
        "target": "ratio_to_season_line",
        "population": args.population,
        # 0: the line cut is no longer the rule. `rowFilter` says what is.
        "trainMinLine": 0.0,
        "rowFilter": ROW_FILTER,
        # WHICH population, not just which rule. See `population_signature`.
        "populationHash": pop_hash,
        "populationRows": pop_rows,
        "features": specs,
        "coef": coef,
        "clamps": {"lo": CLAMP_LO, "hi": CLAMP_HI},
        "notes": notes + " Zero weeks (pts <= 0) are " + format(100 * zero_share, ".1f") +
                 "% of the training rows.",
    }
    if zero_model == "two-part":
        artifact["quantileGrid"] = QUANTILE_GRID
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, indent=2)
    if not args.quiet:
        print("wrote " + args.out)
        print("  seasons " + str(seasons[0]) + "-" + str(seasons[-1]) +
              (" holding out " + str(holdout) if holdout else "") +
              "; " + str(len(rows)) + " player-weeks (" + args.population + "); " +
              str(len(specs)) + " features; zero-model " + zero_model)
        print("  features used: " + (", ".join(s["name"] for s in specs) or "(none)"))
        print("  STILL waiting on the data track: report_status_wed, practice_status_wed "
              "(the feed's dated filings land at kickoff minus two or later, so the Wednesday pair "
              "is empty), a live in-week odds feed")
        for pos in sorted(coef):
            m = coef[pos].get("mean", {})
            terms = ", ".join(k + " " + format(v, ".4f")
                              for k, v in sorted(m.items()) if k != "intercept" and abs(v) > 1e-4)
            print("  " + pos.ljust(4) + " n=" + str(counts.get(pos, 0)).rjust(6) +
                  "  intercept " + format(m.get("intercept", 0.0), ".4f") + "  " +
                  (terms or "(intercept only)"))
            if "zero" in coef[pos]:
                z = coef[pos]["zero"]
                zt = ", ".join(k + " " + format(v, ".4f")
                               for k, v in sorted(z.items(), key=lambda kv: -abs(kv[1]))
                               if k != "intercept" and abs(v) > 1e-4)
                print("       P(zero) logit intercept " + format(z["intercept"], ".4f") +
                      "  " + (zt or "(intercept only)"))
        print("  golden rows: " + str(len(artifact["golden"])))


if __name__ == "__main__":
    main()
