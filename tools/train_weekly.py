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
    "td_games", "spread_line", "total_line",
    "implied_team_total", "days_rest", "week_no", "season_line_pg",
    "td_fd", "td_ts", "td_attempts", "td_rush_yards", "rz_share_td", "prior_vol_cv",
    # WEEKLY EXPERT CONSENSUS (M2a candidate, 2026-09-16). The FantasyPros weekly positional consensus
    # rank and the panel's dispersion around it, as of this team's kickoff minus two days. Centred like
    # any other level column. src/weekly/features.ts ecrWeekTable carries the as-of rule and the era
    # bound -- the archive is 2020-2024 only, so this is NULL in every other season AND at live serve.
    "ecr_wk_rank", "ecr_wk_sd",
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
    # rolling red-zone touch share: a scorer's high-value role. QBs are excluded (their red-zone value
    # is pass attempts, already in td_attempts), like the other skill-usage columns.
    "rz_share_td": {"RB", "WR", "TE"},
    # prior-season volatility applies to every skill scorer's spread.
    "prior_vol_cv": {"RB", "WR", "TE"},
    # A quarterback runs no routes. The charted route share is a receiver's workload column and
    # fitting it for QB measures the participation feed's coverage, not his job.
    "prior_route_share": {"RB", "WR", "TE"},
}

# The columns stage one is not allowed to be run without. A two-part model whose first stage sees
# only to-date scoring fits the consequence of an injury rather than the injury.
AVAILABILITY_REQUIRED = ["inj_out", "depth_rank", "teammates_out", "prior_snap_share"]

# ---- THE 2026 SERVE REGIME, and the missingness augmentation that makes the boosted heads survive it.
#
# MEASURED on data/ff.db (scripts characterisation, 2026-09-14). At live serve the feature blocks go
# absent in a NESTED order that the historical training rows -- which almost all carry every block --
# never contained as a COMBINATION, and a tree routes on combinations. So the boosted heads collapse:
# an all-imputed forward row lands in an out-of-distribution leaf and a locked starter is projected at
# a few points with P(zero) ~ 0.7 (D19's gate-7 blocker). The linear heads are immune because they are
# additive (missing -> mean -> ~0 contribution -> the projection reverts to the season-line anchor).
#
# THE FIX has two halves, applied identically in train and serve:
#   1. The boosted design feeds a MISSING raw value as NaN (feature_value_nan / boosted_design), so
#      HistGradientBoosting's NATIVE per-split missing direction handles it -- NOT spec['missing'].
#   2. MISSINGNESS AUGMENTATION: a fraction of training rows are DUPLICATED with one or more of these
#      blocks masked to NaN, at rates matched to the measured 2026 regime, so the trees actually SEE
#      the serve-time all-missing patterns and learn to fall back on the always-present anchors
#      (season_line_pg, home, days_rest, week_no, td_games -- and the first one is in every position's
#      keep set, so a high-line locked starter routes to a low P(zero) even with every block gone).
# The augmented copies keep their source row's TARGET (hiding a report does not change the outcome),
# and are sampled uniformly, so the population's zero rate and level are preserved in expectation and
# the mean-calibration gate clause (c) is not moved.
#
# What is NEVER masked: the anchors above. What CAN be masked, and the per-copy drop probability
# (avail is essentially always gone from 2025; odds/usage/form are gone on forward weeks, partly
# present on the live week with build-live-context):
MASKABLE_GROUPS = {
    "avail": ["inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "inj_feed",
              "teammates_out"],
    "usage": ["prior_snap_share", "prior_route_share", "depth_rank"],
    "odds":  ["spread_line", "total_line", "implied_team_total"],
    "form":  ["td_ppg", "t4_mean", "t4_sd", "td_fd", "td_ts", "td_attempts", "td_rush_yards", "rz_share_td"],
    # ITS OWN GROUP, at the avail block's rate, because it goes absent for the same reason and just as
    # completely: the FantasyPros weekly-consensus archive stops in 2024, so a 2025+ or forward row has
    # no value at all. Masking it at 0.97 is the honest match to the serve regime -- a tree that never
    # saw the column absent would route a 2026 lineup into an out-of-distribution leaf (D19, gate 7).
    "ecr":   ["ecr_wk_rank", "ecr_wk_sd"],
}
MASK_DROP_P = {"avail": 0.97, "usage": 0.6, "odds": 0.5, "form": 0.4, "ecr": 0.97}

ALL_FEATURES = RATIO_TO_LINE + CENTER + INDICATOR

SELECT_COLS = [
    "feat_key", "player_sk", "season", "week", "name", "pos", "season_line_pg",
    "td_games", "td_ppg", "t4_mean", "t4_sd", "td_fd", "td_ts", "td_attempts", "td_rush_yards",
    "rz_share_td", "prior_vol_cv", "ecr_wk_rank", "ecr_wk_sd",
    "home", "spread_line", "total_line", "implied_team_total", "days_rest",
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


def feature_value_nan(spec, row):
    """The BOOSTED-ONLY evaluator, mirrored from src/weekly/projector.ts weeklyFeatureValueBoosted().

    Identical to feature_value() for a PRESENT value; the one difference is that a MISSING raw value
    (or a ratio whose line is gone) returns NaN instead of spec['missing']. HistGradientBoosting has
    native NaN handling -- it learns a per-split missing DIRECTION -- so feeding NaN lets the boosted
    trees treat 'no report' as its own case and fall back on the anchors, rather than routing a
    mean-imputed vector into a leaf that the all-imputed serve combination never trained. The linear
    heads still read feature_value() (imputation is correct for an additive model); only the boosted
    reduced design and the boosted golden path use this."""
    raw = row.get(spec["name"])
    if raw is None or (isinstance(raw, float) and not math.isfinite(raw)):
        return float("nan")
    raw = float(raw)
    t = spec["transform"]
    if t == "identity":
        return raw
    if t == "indicator":
        return 1.0 if raw else 0.0
    if t == "center":
        s = spec.get("scale", 1.0)
        return float("nan") if s == 0 else (raw - spec.get("center", 0.0)) / s
    if t == "ratio_to_line":
        line = row.get("season_line_pg")
        if line is None or not (float(line) > 0):
            return float("nan")
        return raw / float(line)
    return float("nan")


def boosted_design(rows, specs):
    """The full boosted design (NaN for missing). Reduced to a position's keep set by the caller."""
    X = np.empty((len(rows), len(specs)), dtype=float)
    for i, r in enumerate(rows):
        for j, s in enumerate(specs):
            X[i, j] = feature_value_nan(s, r)
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


def mix_quantile(q, p_zero, vals, grid):
    """THE TWO-PART MIXTURE'S q-QUANTILE, in ratio units. F(y) = pZero + (1 - pZero) * F_played(y).

    Extracted so `evaluate()` below and the VECTORISED form used by the band calibration are the same
    arithmetic rather than two implementations of it -- the drift this repo keeps finding. Mirrors
    src/weekly/projector.ts mixQ line for line, anchored at (0, 0) because the conditional
    distribution's floor is the clamp floor, which is 0."""
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


def mix_quantile_vec(q, p_zero, vals, grid):
    """`mix_quantile` for a whole matrix at once: `p_zero` is (n,), `vals` is (n, len(grid)) already
    clamped and made non-decreasing. Checked against the scalar form above on a sample by
    `band_self_check` -- a vectorised rewrite that agreed with nothing would be exactly the
    producer-grades-its-own-homework failure."""
    g = np.asarray(grid, dtype=float)
    pz = np.clip(np.asarray(p_zero, dtype=float), 0.0, 1.0)
    qp = np.where(pz >= 1.0, -1.0, (q - pz) / np.maximum(1e-300, 1.0 - pz))
    out = np.zeros(len(pz), dtype=float)
    # Beyond the top grid level the mixture is flat at the last fitted quantile.
    top = qp >= g[-1]
    out[top] = vals[top, -1]
    mid = (qp > 0) & ~top
    if mid.any():
        idx = np.searchsorted(g, qp[mid], side="left")     # first i with g[i] >= qp
        idx = np.clip(idx, 0, len(g) - 1)
        lo_q = np.where(idx > 0, g[np.maximum(idx - 1, 0)], 0.0)
        rowi = np.nonzero(mid)[0]
        lo_v = np.where(idx > 0, vals[rowi, np.maximum(idx - 1, 0)], 0.0)
        hi_v = vals[rowi, idx]
        span = g[idx] - lo_q
        out[mid] = np.where(span > 0, lo_v + (hi_v - lo_v) * ((qp[mid] - lo_q) / np.maximum(span, 1e-300)), hi_v)
    return out


def cal_band(v, scale, side, med, lo, hi):
    """THE BAND CALIBRATION APPLIED (D32). A SCALE on the ratio, re-clamped, never crossing the
    median. Mirrors src/weekly/projector.ts calBand."""
    if scale is None or not np.isfinite(scale):
        return v
    w = min(hi, max(lo, v * float(scale)))
    return min(w, med) if side == "lo" else max(w, med)


def boosted_raw(head, x):
    """The Python mirror of projector.ts boostedRaw(): baseline plus every tree's leaf value. `x` is
    the REDUCED design vector, in the boosted head-set's own `features` order (the position's keep
    set), NOT the full spec vector. Identical arithmetic to tools/train_projection.py boosted_raw."""
    s = float(head["baseline"])
    for t in head["trees"]:
        i = 0
        while not t["leaf"][i]:
            v = x[t["feature"][i]]
            if v != v:                          # NaN -> the node's missing branch
                i = t["left"][i] if t["missingLeft"][i] else t["right"][i]
            elif v <= t["threshold"][i]:
                i = t["left"][i]
            else:
                i = t["right"][i]
        s += t["value"][i]
    return s


def evaluate(artifact, row):
    """Predict one row with THIS script's own arithmetic -- the golden block's source of truth.

    MIRRORED, line for line, by src/weekly/projector.ts projectWeekly(). The mixture is where the two
    sides are most likely to drift, because it is the only part with a branch in it, so the golden
    block carries pZero as well as the four published heads.

    WHEN THE ARTIFACT IS BOOSTED (learner == "gbm" and this position carries boosted heads), a head's
    raw value is the ensemble walk over the position's REDUCED design instead of the linear dot
    product. The clamp, the base multiply and the two-part mixture are byte-identical either way --
    only the raw head value changes -- so the boosted golden block exercises exactly the same
    downstream arithmetic the linear one does.
    """
    heads = artifact["coef"][row["pos"]]
    specs = artifact["features"]
    x = [feature_value(s, row) for s in specs]
    line = row["season_line_pg"]

    bpos = None
    if artifact.get("learner") == "gbm":
        bb = artifact.get("boosted") or {}
        bpos = (bb.get("perPos") or {}).get(row["pos"])
    xb = None
    if bpos is not None:
        # The boosted reduced design uses the NaN evaluator (native missing handling), NOT the imputed
        # `x` the linear heads read -- mirrored by src/weekly/projector.ts's xb build.
        x_nan = [feature_value_nan(s, row) for s in specs]
        idx = {s["name"]: j for j, s in enumerate(specs)}
        xb = [x_nan[idx[n]] for n in bpos["features"]]

    def lin(h):
        if bpos is not None and h in bpos["heads"]:
            return boosted_raw(bpos["heads"][h], xb)
        c = heads[h]
        v = c.get("intercept", 0.0)
        for j, s in enumerate(specs):
            v += c.get(s["name"], 0.0) * x[j]
        return v

    lo, hi = artifact["clamps"]["lo"], artifact["clamps"]["hi"]

    def clamped(h):
        return min(hi, max(lo, lin(h)))

    # THE BAND CALIBRATION (D32), per position. None where the artifact carries none -- and then every
    # number below is byte-identical to what the pre-D32 trainer produced.
    cb = ((artifact.get("bandCalibration") or {}).get("perPos") or {}).get(row["pos"])
    s10 = cb["p10"] if cb else None
    s90 = cb["p90"] if cb else None

    if artifact.get("zeroModel") != "two-part":
        med = clamped("p50")
        return {"mean": line * clamped("mean"), "p50": line * med,
                "p10": line * cal_band(clamped("p10"), s10, "lo", med, lo, hi),
                "p90": line * cal_band(clamped("p90"), s90, "hi", med, lo, hi)}

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
        return mix_quantile(q, p_zero, vals, grid)

    med = mix_q(0.50)
    return {
        "mean": line * (1.0 - p_zero) * ratio,
        "p10": line * cal_band(mix_q(0.10), s10, "lo", med, lo, hi),
        "p50": line * med,
        "p90": line * cal_band(mix_q(0.90), s90, "hi", med, lo, hi),
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


def serialize_boosted_head(m, extra_shift=0.0):
    """One scikit-learn HistGradientBoosting{Classifier,Regressor} as the artifact carries it:
    `baseline` plus one tree per boosting round, each tree seven parallel node arrays. Read straight
    off scikit-learn's own predictor nodes; the walker (boosted_raw here / boostedRaw in
    src/weekly/projector.ts) reproduces predict() for a regressor and decision_function() for the
    binary classifier -- both are `baseline + sum over trees of the leaf value`, the learning rate
    already folded into the leaf values. A conformal shift (quantile heads only) rides in `baseline`,
    so raw = baseline + sum(trees) is the CALIBRATED value with no extra field to forget."""
    # A split whose only job is to separate MISSING from present (common once missingness augmentation
    # feeds NaN) carries a scikit-learn `num_threshold` of +/-inf: every finite value falls on one
    # side and NaN takes the missing branch. inf is not valid JSON and the loader refuses a non-finite
    # threshold, so it is clamped to a large FINITE sentinel that gives byte-identical routing for every
    # finite feature value (all are O(10) centred/ratio units). boosted_self_check then PROVES the
    # clamped walker still reproduces scikit-learn to 1e-9, so this cannot silently change a prediction.
    def fin_thresh(t):
        t = float(t)
        if math.isinf(t):
            return 1e30 if t > 0 else -1e30
        if math.isnan(t):
            return 1e30
        return t
    trees = []
    for it in m._predictors:
        nodes = it[0].nodes
        trees.append({
            "feature": [int(n["feature_idx"]) for n in nodes],
            "threshold": [fin_thresh(n["num_threshold"]) for n in nodes],
            "left": [int(n["left"]) for n in nodes],
            "right": [int(n["right"]) for n in nodes],
            "value": [float(n["value"]) for n in nodes],
            "leaf": [bool(n["is_leaf"]) for n in nodes],
            "missingLeft": [bool(n["missing_go_to_left"]) for n in nodes],
        })
    baseline = float(np.asarray(m._baseline_prediction).ravel()[0]) + float(extra_shift)
    return {"baseline": baseline, "trees": trees}


def fit_position_boosted(rows, specs, pos, args):
    """THE BOOSTED TWO-PART MODEL FOR ONE POSITION (Q1: does a nonlinear weekly learner help?).

    Stage one is a HistGradientBoostingClassifier on P(zero week) over the whole rostered population;
    its raw decision_function is the logit the mixture consumes, exactly where the linear stage's
    logistic score sat. Stage two is a squared-error regressor for E[ratio | played] plus one
    quantile-loss regressor per QUANTILE_GRID level, fitted on PLAYED weeks only -- the same rows,
    same reduced design (POS_GATED `keep`) and same split the linear two-part uses, so the ONLY thing
    that changes versus fit_position_two_part is linear -> trees. Hyperparameters mirror the season
    model's admitted screen settings (D16): depth 3, 300 rounds at 0.05, 30 rows/leaf, L2 1.0.

    The quantile heads are conformally calibrated TRAIN-ONLY exactly as train_projection.py's
    fit_boosted does: for head q, shift its prediction by the q-quantile of (y - out-of-fold
    prediction) over PLAYER-grouped folds on the training rows, folded into the head's baseline. A
    boosted quantile head is narrower on unseen rows than on its own training rows; this corrects the
    interval so its out-of-fold coverage is nominal, and the held-out season the harness scores never
    enters the shift. The mean and the zero classifier are left as fitted (a log-loss classifier is
    mean-calibrated on its own training rows; clause (c) then MEASURES whether that held out of
    sample rather than being fitted to pass).

    Returns (feature_names, heads_block, self_check_arrays, band_calibration) or four Nones when a
    stage cannot
    be fitted -- the caller then leaves this position linear, which the boosted `positions` list
    records so no consumer walks a head that was never fitted.
    """
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    from sklearn.model_selection import GroupKFold

    sub = [r for r in rows if r["pos"] == pos]
    if len(sub) < 500:
        return None, None, None, None
    keep = keep_for(specs, pos)
    feat_names = [specs[j]["name"] for j in keep]
    # THE BOOSTED DESIGN FEEDS NaN FOR MISSING (native HistGBM handling), not spec['missing'].
    X = boosted_design(sub, specs)[:, keep]
    groups = np.array([("p" + str(r["player_sk"])) if r.get("player_sk") is not None
                       else ("s" + str(r["season"])) for r in sub])
    yz = np.array([1 if r["pts"] <= ZERO_PTS else 0 for r in sub], dtype=int)
    y_ratio = np.array([r["pts"] / r["season_line_pg"] for r in sub], dtype=float)
    if len(set(yz.tolist())) < 2:
        return None, None, None, None
    if int((yz == 0).sum()) < 500:
        return None, None, None, None
    hp = dict(max_depth=args.gbm_depth, learning_rate=0.05, max_iter=args.gbm_iter,
              min_samples_leaf=30, l2_regularization=1.0, early_stopping=False, random_state=0)

    # ---- MISSINGNESS AUGMENTATION (MASKABLE_GROUPS / MASK_DROP_P). Duplicate a fraction of rows with
    # serve-time blocks masked to NaN so the trees learn the 2026 regime and fall back on the anchors.
    # Duplicates keep the source row's target and group, so the zero rate, level and CV grouping are
    # preserved. The RNG is seeded per position by a STABLE index (never hash(pos): PYTHONHASHSEED
    # would make the artifact non-reproducible). ----
    X_fit, yz_fit, yr_fit, grp_fit = X, yz, y_ratio, groups
    n_aug = int(round((args.aug_frac or 0.0) * len(sub)))
    if n_aug > 0:
        rng = np.random.default_rng(1234 + POS_FITTED.index(pos))
        col_group = {}
        for gname, cols in MASKABLE_GROUPS.items():
            jcols = [j for j, name in enumerate(feat_names) if name in cols]
            if jcols:
                col_group[gname] = jcols
        src = rng.integers(0, len(sub), size=n_aug)
        Xa = X[src].copy()
        for ri in range(n_aug):
            for gname, jcols in col_group.items():
                if rng.random() < MASK_DROP_P[gname]:
                    Xa[ri, jcols] = np.nan
        X_fit = np.vstack([X, Xa])
        yz_fit = np.concatenate([yz, yz[src]])
        yr_fit = np.concatenate([y_ratio, y_ratio[src]])
        grp_fit = np.concatenate([groups, groups[src]])

    clf = HistGradientBoostingClassifier(**hp).fit(X_fit, yz_fit)

    played = yz_fit == 0
    Xp = X_fit[played]
    yp = yr_fit[played]
    gp = grp_fit[played]

    mean_m = HistGradientBoostingRegressor(loss="squared_error", **hp).fit(Xp, yp)
    qmodels = {}
    for q in QUANTILE_GRID:
        qmodels[grid_head(q)] = HistGradientBoostingRegressor(loss="quantile", quantile=q, **hp).fit(Xp, yp)

    # ---- CONFORMAL INTERVAL CALIBRATION (train-only, quantile heads only). ----
    shift = {h: 0.0 for h in qmodels}
    if args.conformal_k and args.conformal_k > 0:
        k = min(int(args.conformal_k), len(set(gp.tolist())))
        if k >= 2:
            gkf = GroupKFold(n_splits=k)
            for name, q in ((grid_head(q), q) for q in QUANTILE_GRID):
                oof = np.full(len(yp), np.nan)
                for tr, te in gkf.split(Xp, yp, gp):
                    mm = HistGradientBoostingRegressor(loss="quantile", quantile=q, **hp).fit(Xp[tr], yp[tr])
                    oof[te] = mm.predict(Xp[te])
                ok = np.isfinite(oof)
                if ok.any():
                    shift[name] = float(np.quantile(yp[ok] - oof[ok], q))

    # ---- THE BAND CALIBRATION (D32): a SECOND, SEPARATE out-of-fold pass over ALL rows. ----
    #
    # WHY IT IS SEPARATE AND NOT FOLDED INTO THE LOOP ABOVE, which would have been cheaper. The
    # conformal block above splits the PLAYED rows; this one has to split ALL of them, because the
    # served p10/p90 are the MIXTURE's and a did-not-play week is exactly the row the mixture is
    # about. Re-using one fold assignment for both would change which rows the conditional shift is
    # computed on -- and that shift moves the published p50, which a calibration of the INTERVAL must
    # not do. So the shift's folds are left untouched and this pass pays for its own.
    #
    # WHAT IT SOLVES. Out-of-fold, each row gets the band it would have been served, built by exactly
    # the arithmetic src/weekly/projector.ts uses (`mix_quantile_vec`, checked against the scalar
    # `mix_quantile` on a sample). Then:
    #     s90 = Quantile_0.90 ( y / p90 )           over rows with p90 > 0
    #     s10 = Quantile_0.10 ( y / p10 )           over rows with p10 > 0
    # so that P(y > s90*p90) = 0.10 and P(y < s10*p10 | p10 > 0) = 0.10 by construction. A SCALE, not
    # a shift: see src/weekly/projector.ts WeeklyBandCalibration for why an additive offset destroys
    # the zero atom and turns every ruled-out man into a below-p10 miss.
    #
    # ONLY THE REAL ROWS COUNT. The folds are fitted on the augmented design (that is the model being
    # calibrated) but the statistic is taken on rows [0:n_real] -- the augmented duplicates are a
    # training device with masked features, not members of the population anyone is scored on.
    band = None
    bk = int(getattr(args, "band_conformal_k", 0) or 0)
    if bk > 0:
        k = min(bk, len(set(grp_fit.tolist())))
        if k >= 2:
            n_real = len(sub)
            gkf = GroupKFold(n_splits=k)
            oof_z = np.full(len(yz_fit), np.nan)
            oof_q = {grid_head(q): np.full(len(yz_fit), np.nan) for q in QUANTILE_GRID}
            for tr, te in gkf.split(X_fit, yz_fit, grp_fit):
                ctr = HistGradientBoostingClassifier(**hp).fit(X_fit[tr], yz_fit[tr])
                oof_z[te] = ctr.decision_function(X_fit[te])
                ptr = tr[yz_fit[tr] == 0]
                for q in QUANTILE_GRID:
                    mq = HistGradientBoostingRegressor(loss="quantile", quantile=q, **hp).fit(X_fit[ptr], yr_fit[ptr])
                    oof_q[grid_head(q)][te] = mq.predict(X_fit[te])
            ok = np.isfinite(oof_z[:n_real])
            for q in QUANTILE_GRID:
                ok &= np.isfinite(oof_q[grid_head(q)][:n_real])
            if ok.sum() >= 1000:
                # The served vals: the fitted shift, the clamp, then made non-decreasing -- the same
                # three steps, in the same order, as evaluate() and projectWeekly().
                vals = np.empty((int(ok.sum()), len(QUANTILE_GRID)), dtype=float)
                prev = np.full(int(ok.sum()), CLAMP_LO, dtype=float)
                for j, q in enumerate(QUANTILE_GRID):
                    name = grid_head(q)
                    v = np.clip(oof_q[name][:n_real][ok] + shift[name], CLAMP_LO, CLAMP_HI)
                    prev = np.maximum(prev, v)
                    vals[:, j] = prev
                z = oof_z[:n_real][ok]
                pz = np.where(z >= 0, 1.0 / (1.0 + np.exp(-np.abs(z))), np.exp(-np.abs(z)) / (1.0 + np.exp(-np.abs(z))))
                p10 = mix_quantile_vec(0.10, pz, vals, QUANTILE_GRID)
                p50 = mix_quantile_vec(0.50, pz, vals, QUANTILE_GRID)
                p90 = mix_quantile_vec(0.90, pz, vals, QUANTILE_GRID)
                band_self_check(pz, vals, p10, p50, p90)
                y = yr_fit[:n_real][ok]
                lo_ok = p10 > 0
                s90 = solve_upper_scale(y, p90)
                s10 = float(np.quantile(y[lo_ok] / p10[lo_ok], 0.10)) if lo_ok.sum() >= 500 else 1.0
                # BEFORE, measured on the same out-of-fold rows, so the artifact can carry the number
                # the correction was solved against rather than a claim about it.
                band = {"p10": s10, "p90": s90, "n": int(ok.sum()), "nLo": int(lo_ok.sum()),
                        "oofBefore": {"cover": float(np.mean((y >= p10) & (y <= p90))),
                                      "below": float(np.mean(y < p10)),
                                      "above": float(np.mean(y > p90)),
                                      "belowGivenFloor": float(np.mean(y[lo_ok] < p10[lo_ok]))}}
                c10 = np.minimum(np.clip(p10 * s10, CLAMP_LO, CLAMP_HI), p50)
                c90 = np.maximum(np.clip(p90 * s90, CLAMP_LO, CLAMP_HI), p50)
                band["oofAfter"] = {"cover": float(np.mean((y >= c10) & (y <= c90))),
                                    "below": float(np.mean(y < c10)),
                                    "above": float(np.mean(y > c90)),
                                    "belowGivenFloor": float(np.mean(y[lo_ok] < c10[lo_ok]))}

    heads = {"zero": serialize_boosted_head(clf),
             "mean": serialize_boosted_head(mean_m)}
    for name, m in qmodels.items():
        heads[name] = serialize_boosted_head(m, shift[name])
    # Self-check on the FIT matrices (X_fit carries the augmented NaN rows), so the walker is proven to
    # reproduce sklearn on exactly the missing patterns the serve will hit.
    check = {"X": X_fit, "Xp": Xp, "clf": clf, "mean": mean_m, "qmodels": qmodels, "shift": shift}
    return feat_names, {"features": feat_names, "heads": heads}, check, band


def solve_upper_scale(y, p90, level=0.90):
    """The scale s with P(y > s * p90) = 1 - level over ALL rows, not over the rows where p90 > 0.

    THE ROWS WITH p90 == 0 ARE WHY THIS IS NOT ONE np.quantile CALL, and leaving them out is a real
    (small) error rather than a tidiness question. A man the first stage puts at P(zero) above 0.90
    has a published p90 of exactly 0 -- the atom again -- and whether he lands above it does NOT
    depend on s: he is above iff he scored anything at all. Solving the quantile on the p90 > 0 rows
    alone therefore delivers 0.10 CONDITIONAL on those rows and 0.10 * P(p90 > 0) pooled, which
    measured 0.095 on the first fit and looked like a 5% miss of the target it was actually hitting.
    Encoding the degenerate rows as a fixed outcome -- above (a sentinel beyond any attainable ratio)
    or never -- makes the pooled quantile exact."""
    r = np.zeros(len(y), dtype=float)
    ok = p90 > 0
    r[ok] = y[ok] / p90[ok]
    # Degenerate rows: above for any s if he scored, never above otherwise.
    deg_above = (~ok) & (y > 0)
    if deg_above.any():
        r[deg_above] = np.inf
    fin = np.isfinite(r)
    n_fin = int(fin.sum())
    if len(r) < 500 or n_fin < 500:
        return 1.0
    # The miss budget the finite rows may spend: the pooled one, less what the degenerate rows spend
    # unconditionally. Expressed as a level on the finite subpopulation.
    budget = (1.0 - level) * len(r) - float(deg_above.sum())
    if not (budget > 0):
        return 1.0
    s = float(np.quantile(r[fin], 1.0 - budget / n_fin))
    return s if np.isfinite(s) and s > 0 else 1.0


def seasonline_band(sub_rows, k):
    """THE FLOOR ARTIFACT'S BAND CALIBRATION (D32) -- the same conformal scale, on the model that has
    no coefficients. Its p10/p90 are the empirical ratio quantiles, so the out-of-fold form fits them
    on the training part of each player-grouped fold and measures the scale on the held-out part.

    Returns None when the position cannot be split, which leaves it UNCALIBRATED rather than
    calibrated on itself -- an in-sample band correction is narrower than the thing it corrects."""
    from sklearn.model_selection import GroupKFold
    if len(sub_rows) < 1000:
        return None
    y = np.array([r["pts"] / r["season_line_pg"] for r in sub_rows], dtype=float)
    groups = np.array([("p" + str(r["player_sk"])) if r.get("player_sk") is not None
                       else ("s" + str(r["season"])) for r in sub_rows])
    kk = min(int(k), len(set(groups.tolist())))
    if kk < 2:
        return None
    p10 = np.full(len(y), np.nan)
    p90 = np.full(len(y), np.nan)
    p50 = np.full(len(y), np.nan)
    for tr, te in GroupKFold(n_splits=kk).split(y.reshape(-1, 1), y, groups):
        p10[te] = min(CLAMP_HI, max(CLAMP_LO, quantile(list(y[tr]), 0.10)))
        p50[te] = min(CLAMP_HI, max(CLAMP_LO, quantile(list(y[tr]), 0.50)))
        p90[te] = min(CLAMP_HI, max(CLAMP_LO, quantile(list(y[tr]), 0.90)))
    lo_ok = p10 > 0
    s90 = solve_upper_scale(y, p90)
    s10 = float(np.quantile(y[lo_ok] / p10[lo_ok], 0.10)) if lo_ok.sum() >= 500 else 1.0
    c10 = np.minimum(np.clip(p10 * s10, CLAMP_LO, CLAMP_HI), p50)
    c90 = np.maximum(np.clip(p90 * s90, CLAMP_LO, CLAMP_HI), p50)
    return {"p10": s10, "p90": s90, "n": int(len(y)), "nLo": int(lo_ok.sum()),
            "oofBefore": {"cover": float(np.mean((y >= p10) & (y <= p90))),
                          "below": float(np.mean(y < p10)), "above": float(np.mean(y > p90)),
                          "belowGivenFloor": float(np.mean(y[lo_ok] < p10[lo_ok])) if lo_ok.any() else 0.0},
            "oofAfter": {"cover": float(np.mean((y >= c10) & (y <= c90))),
                         "below": float(np.mean(y < c10)), "above": float(np.mean(y > c90)),
                         "belowGivenFloor": float(np.mean(y[lo_ok] < c10[lo_ok])) if lo_ok.any() else 0.0}}


def band_self_check(pz, vals, p10, p50, p90, n=200, tol=1e-12):
    """THE VECTORISED MIXTURE MUST REPRODUCE THE SCALAR ONE -- the same discipline
    `boosted_self_check` applies to the tree walker, applied to the only other place this file
    reimplements arithmetic the TypeScript side also implements. A rewrite that agreed with nothing
    would calibrate the band against a distribution the serve never produces."""
    if not len(pz):
        return
    idx = np.linspace(0, len(pz) - 1, min(n, len(pz))).astype(int)
    for i in idx:
        row = [float(v) for v in vals[i]]
        for q, got in ((0.10, p10[i]), (0.50, p50[i]), (0.90, p90[i])):
            want = mix_quantile(q, float(pz[i]), row, QUANTILE_GRID)
            if not abs(float(got) - want) <= tol:
                sys.exit("train_weekly: the vectorised mixture disagrees with the scalar one at q=" +
                         repr(q) + " (" + repr(float(got)) + " vs " + repr(want) + ") -- refusing to "
                         "solve a band calibration against arithmetic the serve does not use")


def boosted_self_check(perpos, checks, tol=1e-9):
    """The serialised heads, walked by boosted_raw above, must reproduce scikit-learn's own
    decision_function (the zero classifier) and predict()+shift (the regressors) on the training
    design. THIS IS THE FAULT INJECTION for Stage 2A: a serialisation that dropped a field ships a
    model that is wrong everywhere and refused nowhere, and the TypeScript loader runs the same walk
    against the golden block, so a perturbed leaf is refused on both sides."""
    for pos, block in perpos.items():
        ck = checks[pos]
        for h, head in block["heads"].items():
            if h == "zero":
                ref = ck["clf"].decision_function(ck["X"])
                Xd = ck["X"]
            elif h == "mean":
                ref = ck["mean"].predict(ck["Xp"])
                Xd = ck["Xp"]
            else:
                ref = ck["qmodels"][h].predict(ck["Xp"]) + float(ck["shift"][h])
                Xd = ck["Xp"]
            mine = np.array([boosted_raw(head, list(map(float, Xd[i]))) for i in range(len(Xd))])
            worst = float(np.max(np.abs(mine - ref))) if len(Xd) else 0.0
            if not (worst <= tol):
                sys.exit("train_weekly: boosted head " + pos + "." + h + " serialisation does not "
                         "reproduce scikit-learn (max |walk - ref| = " + repr(worst) + ") -- refusing "
                         "to write an artifact whose TypeScript walker could not possibly agree")


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
    ap.add_argument("--learner", default="linear", choices=["linear", "gbm"],
                    help="linear (DEFAULT, nothing changes): the two-part logistic+ridge heads. gbm: "
                         "additionally fit HistGradientBoosting heads (classifier stage one, regressor "
                         "mean + quantile stage two) per fitted position and serialise them onto the "
                         "artifact beside the linear heads; src/weekly/projector.ts walks them at "
                         "serve. Two-part only; K/DST stay intercept-only.")
    ap.add_argument("--gbm-depth", type=int, default=3, help="gbm: max tree depth (D16 screen setting).")
    ap.add_argument("--gbm-iter", type=int, default=300, help="gbm: boosting rounds (D16 screen setting).")
    ap.add_argument("--conformal-k", type=int, default=5,
                    help="gbm: player-grouped folds for the train-only conformal calibration of the "
                         "boosted quantile heads. 0 = off (the pre-calibration heads).")
    ap.add_argument("--band-conformal-k", type=int, default=5,
                    help="D32: player-grouped folds for the train-only BAND calibration -- the "
                         "multiplicative conformal scales on the served p10/p90. 0 = off, and the "
                         "artifact then carries no `bandCalibration` field at all, which is the "
                         "pre-D32 band byte-for-byte. Separate from --conformal-k on purpose: that "
                         "one calibrates the CONDITIONAL quantile heads (and so moves p50), this one "
                         "calibrates the published INTERVAL and must not.")
    ap.add_argument("--aug-frac", type=float, default=0.5,
                    help="gbm: MISSINGNESS AUGMENTATION rate -- augmented rows added, as a fraction of "
                         "the fitted rows, each a duplicate with serve-time feature blocks masked to "
                         "NaN (MASKABLE_GROUPS / MASK_DROP_P). Teaches the boosted trees the 2026 "
                         "serve regime so a locked starter with the whole availability/usage block "
                         "absent falls back on the season-line anchor instead of an OOD leaf. 0 = off "
                         "(the pre-robustness heads that collapse the live serve).")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    if args.learner == "gbm" and args.zero_model != "two-part":
        sys.exit("train_weekly: --learner gbm is only defined for --zero-model two-part (the shipped "
                 "serve). The boosted heads mirror the two-part stages; there is no boosted quantile "
                 "model here.")

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

    # THE BAND CALIBRATION (D32), filled per position by whichever fit path ran. Empty = no
    # `bandCalibration` field on the artifact at all, which is what every pre-D32 file carries and
    # what the consumer reads as "serve the old band".
    band_per_pos = {}

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
        # THE FLOOR'S BAND IS CALIBRATED TOO, and it is the artifact that serves K (WEEKLY_SERVE).
        # The heads are two empirical quantiles of the ratio, so the out-of-fold form is the same
        # arithmetic on player-grouped folds: fit the quantiles on the training part, measure the
        # scale on the held-out part. Cheap here -- there is no model to refit, only two order
        # statistics -- and it is the same statistic the boosted path solves.
        bk = int(args.band_conformal_k or 0)
        if bk > 0:
            for pos in list(coef):
                sub_rows = [r for r in rows if r["pos"] == pos]
                got = seasonline_band(sub_rows, bk)
                if got:
                    band_per_pos[pos] = got
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

    # ---- THE BOOSTED HEADS (Q1). Fitted ON TOP of the linear coef, position by position, and only
    # for the two-part serve. Each boosted position keeps its linear heads (the loader requires them,
    # and they are the fallback); the boosted block overrides them at serve. A position whose boosted
    # stages cannot be fitted stays linear and is left off `positions`. ----
    boosted_block = None
    if not args.season_line_only and zero_model == "two-part" and args.learner == "gbm":
        perpos, checks = {}, {}
        for pos in POS_FITTED:
            if pos not in coef:
                continue
            _names, block, ck, bnd = fit_position_boosted(rows, specs, pos, args)
            if block:
                perpos[pos] = block
                checks[pos] = ck
                if bnd:
                    band_per_pos[pos] = bnd
        if not perpos:
            sys.exit("train_weekly: --learner gbm fitted no boosted position -- refusing to write a "
                     "gbm artifact that would silently serve the linear heads everywhere")
        boosted_self_check(perpos, checks)
        boosted_block = {
            "learner": "gbm",
            "positions": list(perpos.keys()),
            "params": {"max_depth": args.gbm_depth, "max_iter": args.gbm_iter,
                       "learning_rate": 0.05, "min_samples_leaf": 30, "l2": 1.0,
                       "conformalK": int(args.conformal_k or 0),
                       "augFrac": float(args.aug_frac or 0.0)},
            "perPos": perpos,
        }

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
    if boosted_block is not None:
        artifact["learner"] = "gbm"
        artifact["boosted"] = boosted_block
    # THE BAND CALIBRATION (D32). Written only when a position actually solved one, and the whole
    # field is omitted when none did -- an artifact that declares a calibration of nothing would claim
    # something it does not have, and the consumer reads an absent field as "serve the old band".
    if band_per_pos:
        artifact["bandCalibration"] = {
            "method": "conformal-scale",
            "levels": {"lo": 0.10, "hi": 0.90},
            "k": int(args.band_conformal_k or 0),
            "fittedOn": "train-only, player-grouped out-of-fold rows of this artifact's own fit set",
            "perPos": {p: {"p10": round(b["p10"], 6), "p90": round(b["p90"], 6),
                           "n": b["n"], "nLo": b["nLo"],
                           "oofBefore": {k2: round(v2, 6) for k2, v2 in b["oofBefore"].items()},
                           "oofAfter": {k2: round(v2, 6) for k2, v2 in b["oofAfter"].items()}}
                       for p, b in band_per_pos.items()},
            "notes": "MULTIPLICATIVE conformal scales on the served p10/p90 RATIOS, solved so that "
                     "P(y > s90*p90) = 0.10 and P(y < s10*p10 | p10 > 0) = 0.10 out of fold. A scale "
                     "rather than a shift because the published p10 sits on the ZERO ATOM wherever "
                     "P(zero week) exceeds 0.10, and an additive offset would lift every one of "
                     "those off the floor and turn every ruled-out man's realised 0 into a "
                     "below-p10 miss. The pooled lower miss is therefore 0.10 times the share of "
                     "rows claiming a positive floor, which is a measurement of the atom rather "
                     "than a defect of the band. The mean and p50 are NOT touched.",
        }
    # golden is computed LAST so it reflects the served heads -- boosted where a boosted block exists.
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        # A boosted block is megabytes of node arrays; pretty-printing it is pointless bulk, but the
        # linear artifact stays indented so its diffs are readable. Match train_projection.py: compact
        # only when boosted.
        if boosted_block is not None:
            json.dump(artifact, fh)
        else:
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
        if "bandCalibration" in artifact:
            print("  BAND CALIBRATION (D32), train-only OOF, k=" + str(artifact["bandCalibration"]["k"]) +
                  " -- scales on the served p10/p90 ratios, and the OOF coverage they were solved from:")
            print("    pos   s10     s90        n   OOF before: cover/<p10/>p90    after: cover/<p10/>p90")
            for p, b in artifact["bandCalibration"]["perPos"].items():
                bf, af = b["oofBefore"], b["oofAfter"]
                print("    " + p.ljust(4) + " " + format(b["p10"], ".4f") + " " + format(b["p90"], ".4f") +
                      str(b["n"]).rjust(9) + "        " +
                      format(bf["cover"], ".3f") + "/" + format(bf["below"], ".3f") + "/" + format(bf["above"], ".3f") +
                      "          " +
                      format(af["cover"], ".3f") + "/" + format(af["below"], ".3f") + "/" + format(af["above"], ".3f"))
        if boosted_block is not None:
            n_trees = len(boosted_block["perPos"][boosted_block["positions"][0]]["heads"]["mean"]["trees"])
            print("  served learner: gbm for " + ", ".join(boosted_block["positions"]) +
                  "; trees per head " + str(n_trees) + "; self-check vs sklearn passed (linear heads "
                  "retained as fallback; K/DST stay intercept-only)")


if __name__ == "__main__":
    main()
