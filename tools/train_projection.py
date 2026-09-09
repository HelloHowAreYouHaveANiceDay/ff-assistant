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

==================================================================================================
PHASE 2b: THE CURVE IS NO LONGER A CONSTANT. IT IS A HYPERPARAMETER, CHOSEN INSIDE THE FOLD.
==================================================================================================

Until now the curve arrived precomputed in `feat_player_season.curve_value_prior`, built by one
hand-written recipe: a +/-1 window at ranks 1-3 and +/-2 below, always monotone-repaired, always
rescaled to the preseason-ECR level. Four choices, each defensible, none ever measured, and all four
compiled into the feature builder where no evaluation could reach them. The owner's instruction for
this phase is that the projection curve's construction be SELECTED BY THE EVALUATION SYSTEM, and
this is where that happens.

Four axes, 48 combinations, selected PER POSITION by out-of-sample pinball loss:

    window       0, 1, 2, 3     how many neighbouring ranks are pooled into each rank's mean
    monotone     on / off       cumulative-min repair, which forbids the curve to climb with rank
    levelWeight  0, 0.5, 1      how far the prior-rank shape is rescaled toward the ECR-conditional
                                level (0 = prior-rank pool only, 1 = the full ECR level correction)
    form         ratio/offset   whether the linear stage multiplies the curve or adds to it

THE INNER LOOP IS FORWARD-CHAINING, not a shuffled k-fold, and that is not fastidiousness. A curve
is fitted on season pairs, so a random split lets a fold's curve be built from seasons that come
AFTER the season it is scoring -- lookahead moved one level up, into the model, where no data-level
check can see it. Forward chaining is the only split shape under which "the curve for season s was
fitted on seasons before s" is true at every point in the search.

EVERYTHING THIS SCRIPT FITS IS POINT-IN-TIME WITH RESPECT TO THE HOLDOUT. `--holdout-season Y`
means the training set is seasons STRICTLY BEFORE Y -- not "every season except Y". The curve, the
transform centres, the usage bucket means, the alpha search and the quantile heads all see only the
past. That costs real data at the early folds and it is the only version of the number that means
what it says.

WHAT ELSE CHANGED, AND WHY.

  - THE MULTIPLICATIVE STAGE IS RETIRED. `age-curve.json` and `opportunity-model.json` were fitted
    outside every fold, by their own scripts, against their own curves -- and the opportunity one
    against a curve that had seen the future, which is defect D1. Age is now a fitted feature here;
    usage enters as a ratio to its rank bucket's mean, with the bucket means computed only on
    training seasons. D1 is resolved BY CONSTRUCTION rather than by refitting an artifact that
    still lives outside the fold.
  - THE QUANTILE HEADS ARE FITTED ACROSS THE WHOLE RANK RANGE THE BOARD PRICES (1-60), with rank
    itself as a feature. Phase 2a fitted them on ranks 1-36 and scored them on 1-60, so its 0.614
    coverage was a fit on one sample scored on another; the bands came out much too narrow past
    rank 24 (0.56 at 41-60) and nothing in the fit could have known.
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
# The deepest rank anything is FITTED at. A 16-team league starts 16 QBs, 48-64 RB/WR and 16 TEs, so
# 60 covers every slot the board prices plus a bench, and the rank feature is winsorised there.
MAX_RANK = 60
# The deepest rank the CURVE is built to, which is a different question and was briefly conflated
# with the one above at a cost of 7 RMSE points. The curve is a mean, honest wherever it has 20
# observations, and it runs to WR 204 in this store; stopping it at 60 makes every deeper player
# read as a WR60 -- and 42% of the scored rows are deeper. The FIT stays inside rank 60; the curve
# does not have to.
CURVE_MAX_RANK = 400
# Below this the curve is not a meaningful denominator and the ratio is noise over a small number.
MIN_BASE = 20.0
CLAMP_LO, CLAMP_HI = 0.05, 5.0

# --- curve construction ---------------------------------------------------------------------------
# Below this many observations a rank has no honest mean of its own, and the curve ENDS there rather
# than continuing on a smaller sample. Mirrors MIN_OBS in src/data/projections.ts.
CURVE_MIN_OBS = 20
# The ECR conditional gets a lower bar because it structurally cannot reach 20: the FantasyPros
# archive spans six seasons.
ECR_MIN_OBS = 10
# The rank range the two curves' levels are matched over.
LEVEL_RANKS = 24
# A level factor outside this is a broken join, not a level correction.
LEVEL_CLAMP = (0.5, 2.0)

WINDOWS = [0, 1, 2, 3]
MONOTONE = [True, False]
LEVEL_WEIGHTS = [0.0, 0.5, 1.0]
FORMS = ["ratio", "offset"]

# name -> floor. The RATIO features are divided by the mean for the player's rank bucket, which is
# what stops them re-learning the rank the curve is already indexed by: a WR5's raw target share is
# high BECAUSE he is a WR5, and that is already priced in.
RATIO_FEATURES = {
    "prior_fd": 0.05,
    "prior_ts": 0.005,
    "prior_attempts": 1.0,
    "prior_rush_yards": 0.5,
}
# `prior_pos_rank` is here for the QUANTILE heads above all. Dispersion around the curve widens
# sharply with rank -- a WR50's season is far less predictable in proportional terms than a WR3's --
# and a quantile head with no rank term cannot express that at all. It is the single change that the
# Phase 2a coverage table (0.83 at ranks 13-24, 0.56 at 41-60) points straight at.
# ADMITTED IN PHASE 2d, in survivor order, each re-measured under the full nested evaluation rather
# than on the residuals it was screened against. The admission trace is in docs/validation.md.
#   depth_rank_sep1  screen rho -0.186 (the strongest candidate the sweep has ever produced);
#                    admitted at pinball 12.31 -> 12.03, RMSE 54.17 -> 52.79, coverage 0.759 -> 0.761.
#   contract_year    screen rho -0.124; admitted at pinball 12.03 -> 12.02, RMSE unchanged,
#                    coverage 0.761 -> 0.760. It clears the pre-registered rule (pooled CRPS improves,
#                    coverage stays in band) by 0.01, which is the edge of what this evaluation can
#                    resolve -- recorded plainly rather than dressed up, because a keep/drop rule with
#                    no effect-size floor will eventually admit noise and this is the first candidate
#                    to sit near it.
CENTER_FEATURES = ["age", "prior_games", "draft_round", "prior_pos_rank", "depth_rank_sep1"]
INDICATOR_FEATURES = ["team_changed", "contract_year"]

# ==================================================================================================
# THE EXTENSION TABLE'S CANDIDATE COLUMNS (Phase 2d), and why they are OPT-IN.
#
# `feat_player_season_ext` carries thirteen more season-level columns, every one keyed as-of
# September 1 so it is knowable at draft time by construction. They are DECLARED here -- the loader
# reads them and src/model/projector.ts can compute them -- but NONE is fitted by default. Admission
# is one flag at a time (`--add-features prior_carry_share`), because the whole discipline of the
# admission trace is that each candidate is re-measured against the baseline that would actually
# ship, not against the one it was screened on. A column that quietly joined the default list would
# be a feature admitted by a code edit rather than by a gate.
#
# Two are derived rather than read, in ONE place (src/model/features.ts loadExtSeason) so the
# trainer and the serving path cannot compute them differently:
#   adp_vs_ecr        -- ADP ranked within (season, position) minus ECR positional rank.
#   rookie_draft_pick -- draft_pick where draft_year == season, NULL otherwise.
# `depth_rank_sep1` and `contract_year` are in the DEFAULT lists above from Phase 2d onward; they
# stay named here so the loader still reads them and so `--add-features` remains a complete list of
# what the extension table offers.
EXT_CENTER = [
    "prior_snap_share", "prior_route_share", "prior_carries_per_game", "prior_carry_share",
    "prior_air_yards_share", "prior_wopr", "depth_rank_sep1", "adp", "adp_vs_ecr",
    "rookie_draft_pick",
]
EXT_INDICATOR = ["contract_year"]
EXT_RATIO = {
    # A carry rate divided by the mean for the player's rank bucket, for the same reason every other
    # ratio feature is: an RB5's raw carry share is high BECAUSE he is an RB5, and the curve has
    # already been paid for that.
    "prior_carries_per_game": 0.5,
    "prior_carry_share": 0.02,
    "prior_air_yards_share": 0.02,
    "prior_wopr": 0.02,
}
EXT_ALLOWED = {
    "prior_carries_per_game": {"QB", "RB"},
    "prior_carry_share": {"RB"},
    "prior_air_yards_share": {"WR", "TE"},
    "prior_wopr": {"WR", "TE"},
    "prior_route_share": {"RB", "WR", "TE"},
}
ALL_EXT = sorted(set(EXT_CENTER) | set(EXT_INDICATOR))
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


def load_rows(db_path, lo, hi):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.execute(
        "SELECT feat_key, player_sk, season, name, pos, prior_pos_rank, prior_pts, prior_games, age,"
        " prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,"
        " team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd, pts"
        " FROM feat_player_season"
        " WHERE season BETWEEN ? AND ? AND pts IS NOT NULL",
        (lo, hi),
    )
    rows = [dict(r) for r in cur.fetchall()]
    attach_ext(con, rows)
    con.close()
    return rows


def attach_ext(con, rows):
    """Join feat_player_season_ext onto the training rows BY SURROGATE KEY.

    Mirrors src/model/features.ts loadExtSeason(), including the two derived columns, because those
    two are the ones a second implementation would get subtly wrong -- and the golden block only
    proves the two sides agree about ARITHMETIC, not about what a column means.

    A store without the extension table leaves every column absent, which the specs' declared
    `missing` handles and `build_specs`' 200-row coverage floor keeps out of the fit entirely. The
    columns start in 2013; earlier seasons legitimately have none, and the report says so.
    """
    try:
        ext = con.execute(
            "SELECT player_sk, season, pos, draft_year, draft_pick, contract_year, prior_snap_share,"
            " prior_route_share, prior_carries_per_game, prior_carry_share, prior_air_yards_share,"
            " prior_wopr, depth_rank_sep1, adp FROM feat_player_season_ext"
        ).fetchall()
    except sqlite3.OperationalError:
        return
    by_key = {}
    adp_by_pos = {}
    for r in ext:
        d = dict(r)
        by_key[(d["season"], str(d["player_sk"]))] = d
        if d.get("adp") is not None:
            adp_by_pos.setdefault((d["season"], d["pos"]), []).append((float(d["adp"]), str(d["player_sk"])))
    adp_rank = {}
    for (season, pos), lst in adp_by_pos.items():
        lst.sort()
        for i, (_, sk) in enumerate(lst):
            adp_rank[(season, sk)] = i + 1
    for r in rows:
        sk = r.get("player_sk")
        d = by_key.get((r["season"], str(sk))) if sk is not None else None
        for c in EXT_CENTER + EXT_INDICATOR:
            if c in ("adp_vs_ecr", "rookie_draft_pick"):
                continue
            # prior_air_yards_share / prior_wopr exist on BOTH tables. The extension version wins
            # here because that is the column the screen measured; taking whichever happened to be
            # non-null would make the fitted feature a different quantity from the screened one.
            if d is not None and d.get(c) is not None:
                r[c] = d[c]
            else:
                r.setdefault(c, None)
        ar = adp_rank.get((r["season"], str(sk))) if sk is not None else None
        er = r.get("ecr_pos_rank")
        r["adp_vs_ecr"] = (ar - er) if (ar is not None and er is not None) else None
        r["rookie_draft_pick"] = (
            d["draft_pick"] if d is not None and d.get("draft_year") == r["season"] else None)


# ==================================================================================================
# THE CURVE, built here rather than read from a column, because a column cannot be a hyperparameter.
#
# `CurveSource` precomputes, per (pos, rank), the season-by-season (count, sum) of the points posted
# by players who ENTERED at that rank. Any prefix -- "everything strictly before season s" -- is then
# a lookup, so building 27 seasons x 48 variants of the curve costs almost nothing and the search
# stays honest instead of being cut down to fit a budget.
# ==================================================================================================
class CurveSource(object):
    def __init__(self, rows):
        self.seasons = sorted({r["season"] for r in rows})
        self.sidx = {s: i for i, s in enumerate(self.seasons)}
        n = len(self.seasons)
        # by_prior[pos][rank] -> (count[n], total[n]) indexed by season position
        self.by_prior = {}
        self.by_ecr = {}
        for r in rows:
            for key, store in (("prior_pos_rank", self.by_prior), ("ecr_pos_rank", self.by_ecr)):
                k = r.get(key)
                if k is None:
                    continue
                k = int(round(k))
                if k < 1 or k > CURVE_MAX_RANK + max(WINDOWS):
                    continue
                pos = store.setdefault(r["pos"], {})
                cell = pos.get(k)
                if cell is None:
                    cell = (np.zeros(n), np.zeros(n))
                    pos[k] = cell
                i = self.sidx[r["season"]]
                cell[0][i] += 1.0
                cell[1][i] += float(r["pts"])
        # cumulative, so a prefix is one subtraction
        for store in (self.by_prior, self.by_ecr):
            for pos in store.values():
                for k in list(pos.keys()):
                    c, t = pos[k]
                    pos[k] = (np.cumsum(c), np.cumsum(t))

    def _prefix(self, store, pos, rank, upto, allowed_mask):
        """(count, total) over seasons strictly before `upto` that are in `allowed_mask`."""
        cell = store.get(pos, {}).get(rank)
        if cell is None:
            return 0.0, 0.0
        if allowed_mask is None:
            # cumulative fast path
            j = -1
            for i, s in enumerate(self.seasons):
                if s < upto:
                    j = i
                else:
                    break
            if j < 0:
                return 0.0, 0.0
            return float(cell[0][j]), float(cell[1][j])
        # a restricted season set (inner folds) -- walk it; the arrays are tiny
        c = t = 0.0
        cc, tt = cell
        prev_c = prev_t = 0.0
        for i, s in enumerate(self.seasons):
            dc, dt = cc[i] - prev_c, tt[i] - prev_t
            prev_c, prev_t = cc[i], tt[i]
            if s < upto and s in allowed_mask:
                c += dc
                t += dt
        return c, t

    def raw(self, store, pos, rank, window, upto, allowed):
        c = t = 0.0
        for j in range(rank - window, rank + window + 1):
            if j < 1:
                continue
            dc, dt = self._prefix(store, pos, j, upto, allowed)
            c += dc
            t += dt
        return c, t

    def build(self, pos, variant, upto, allowed=None):
        """The curve for `pos` as of `upto`, under `variant`. [] when it cannot be built honestly."""
        window, monotone, level_w = variant[0], variant[1], variant[2]
        shape = []
        for k in range(1, CURVE_MAX_RANK + 1):
            c, t = self.raw(self.by_prior, pos, k, window, upto, allowed)
            if c < CURVE_MIN_OBS:
                break                              # the honest end of the fitted range
            shape.append(t / c)
        if not shape:
            return []
        if monotone:
            # Projection onto the monotone cone from above: it never invents a value, it only
            # refuses to let the curve climb with rank. A curve that climbs hands a worse-ranked
            # player a higher VOR, which is the ordering the whole book exists to express, inverted.
            for i in range(1, len(shape)):
                if shape[i] > shape[i - 1]:
                    shape[i] = shape[i - 1]
        f = 1.0
        if level_w > 0:
            ecr = []
            for k in range(1, LEVEL_RANKS + 1):
                c, t = self.raw(self.by_ecr, pos, k, max(1, window), upto, allowed)
                if c < ECR_MIN_OBS:
                    break
                ecr.append(t / c)
            n = min(LEVEL_RANKS, len(shape), len(ecr))
            if n >= 12:
                num, den = float(np.mean(ecr[:n])), float(np.mean(shape[:n]))
                if den > 0 and LEVEL_CLAMP[0] <= num / den <= LEVEL_CLAMP[1]:
                    full = num / den
                    f = 1.0 + level_w * (full - 1.0)
        return [v * f for v in shape]


def curve_at(curve, rank):
    """Read the curve at a rank, carrying the last fitted value past its end. Mirrors curveAt() in
    src/model/features.ts -- stated once on each side, and the golden block proves they agree."""
    if not curve or rank is None:
        return None
    k = int(round(rank))
    if k < 1:
        return None
    return curve[min(k - 1, len(curve) - 1)]


def bucket_of(rank):
    return int((rank - 1) // BUCKET)


def bucket_means(rows):
    """pos -> feature -> bucket -> mean. Computed on the TRAINING rows only, and shipped on the
    artifact, because a denominator recomputed by the consumer is a denominator that can differ."""
    acc = {}
    for r in rows:
        if r["prior_pos_rank"] is None:
            continue
        b = str(bucket_of(int(r["prior_pos_rank"])))
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
        spec = {
            "name": name, "transform": "center", "center": mu, "scale": sd,
            # 0 after centring IS the training mean: an explicit, stated mean-imputation.
            "missing": 0.0,
        }
        # WINSORISE AT THE EDGE OF THE FITTED RANGE. Nothing past rank MAX_RANK is ever in the fit,
        # and 42% of the scored rows in the store are out there -- WR runs to 225. Without the clip
        # a rank-200 receiver is priced by extrapolating a coefficient ten standard deviations past
        # anything it was fitted on, and that alone drove RB out-of-sample RMSE to 89 (r2 -0.23)
        # while every rank band 1-60 improved. The model has no opinion past 60; it should say so.
        if name == "prior_pos_rank":
            spec["clipLo"] = 1.0
            spec["clipHi"] = float(MAX_RANK)
        specs.append(spec)
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
    if spec.get("clipLo") is not None:
        raw = max(spec["clipLo"], raw)
    if spec.get("clipHi") is not None:
        raw = min(spec["clipHi"], raw)
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


def pinball(actual, q, pred):
    d = actual - pred
    return np.where(d >= 0, q * d, (q - 1) * d)


def predict_points(base, lin, form):
    """The one arithmetic both sides implement. Mirrored in projectSeason()."""
    if form == "offset":
        return np.minimum(base * CLAMP_HI, np.maximum(base * CLAMP_LO, base + lin))
    return base * np.minimum(CLAMP_HI, np.maximum(CLAMP_LO, lin))


def target(base, pts, form):
    return (pts - base) if form == "offset" else (pts / base)


# ==================================================================================================
# THE INNER LOOP.
# ==================================================================================================
def bases_for(sub, curves_by_season):
    """base per row, from the curve that was fitted on seasons before that row's own."""
    out = np.empty(len(sub))
    for i, r in enumerate(sub):
        c = curves_by_season.get(r["season"])
        b = curve_at(c, r["prior_pos_rank"]) if c else None
        out[i] = b if (b is not None and b > MIN_BASE) else np.nan
    return out


def score_variant(sub, X, specs, variant, source, pos, blocks, args):
    """Mean pinball loss, in POINTS, over the forward-chaining inner folds.

    THE QUANTILE HEADS USED HERE ARE EMPIRICAL RATIO QUANTILES of the fitted mean, not the linear
    quantile regressions the final fit uses. That is a deliberate cost/honesty trade and it is stated
    rather than hidden: 48 variants x 4 positions x 3 folds x 3 linear programs is hours, and the
    thing being SELECTED is the curve, which the mean fit and the empirical spread both depend on in
    the same direction. The selected variant is then refitted with the real quantile heads, and the
    outer cross-validation scores THAT.
    """
    from sklearn.linear_model import Ridge

    form = variant[3]
    losses = []
    for i in range(1, len(blocks)):
        train_seasons = set()
        for b in blocks[:i]:
            train_seasons |= set(b)
        val_seasons = set(blocks[i])
        # curves are built ONLY from the inner-training seasons, and only from those before the
        # season being priced. Forward chaining is what makes both statements true at once.
        need = sorted(train_seasons | val_seasons)
        curves = {}
        for s in need:
            curves[s] = source.build(pos, variant, s, allowed=train_seasons)
        base = bases_for(sub, curves)
        seasons = np.array([r["season"] for r in sub])
        pts = np.array([float(r["pts"]) for r in sub])
        ok = np.isfinite(base)
        tr = ok & np.isin(seasons, list(train_seasons))
        va = ok & np.isin(seasons, list(val_seasons))
        if tr.sum() < 100 or va.sum() < 30:
            continue
        y = target(base[tr], pts[tr], form)
        if not np.all(np.isfinite(y)):
            continue
        m = Ridge(alpha=args.alpha_default).fit(X[tr], y)
        p_tr = predict_points(base[tr], m.predict(X[tr]), form)
        r = pts[tr] / np.maximum(1e-6, p_tr)
        qs = [float(np.quantile(r, q)) for q in (0.10, 0.50, 0.90)]
        p_va = predict_points(base[va], m.predict(X[va]), form)
        loss = 0.0
        for q, mult in zip((0.10, 0.50, 0.90), qs):
            loss += float(np.mean(pinball(pts[va], q, p_va * mult)))
        losses.append(loss / 3.0)
    return float(np.mean(losses)) if losses else float("inf")


def forward_blocks(seasons, n_blocks):
    """Contiguous, chronological blocks. Not a shuffle: see the header."""
    seasons = sorted(seasons)
    if len(seasons) < n_blocks + 1:
        n_blocks = max(2, min(len(seasons), 2))
    size = max(1, len(seasons) // n_blocks)
    blocks, i = [], 0
    while i < len(seasons):
        blocks.append(seasons[i:i + size])
        i += size
    while len(blocks) > n_blocks:
        blocks[-2] = blocks[-2] + blocks[-1]
        blocks.pop()
    return blocks


def select_variant(sub, X, specs, source, pos, args):
    seasons = sorted({r["season"] for r in sub})
    blocks = forward_blocks(seasons, args.inner_folds + 1)
    best, best_loss = None, float("inf")
    table = []
    for w in WINDOWS:
        for mono in MONOTONE:
            for lw in LEVEL_WEIGHTS:
                for form in FORMS:
                    v = (w, mono, lw, form)
                    s = score_variant(sub, X, specs, v, source, pos, blocks, args)
                    table.append((s, v))
                    if s < best_loss:
                        best_loss, best = s, v
    return best, best_loss, table


def fit_position(sub, X, specs, pos, base, args, form):
    """Ridge for the mean, pinball-loss linear fits for the three quantiles.

    Regularised, and the alpha is chosen by SEASON-GROUPED cross-validation inside the training data.
    Grouping by season matters: player-seasons within a year share the scoring era, the schedule and
    the injury luck, so a random split leaks between folds and every alpha looks better than it is.
    """
    from sklearn.linear_model import Ridge, QuantileRegressor
    from sklearn.model_selection import GroupKFold

    # Zero the coefficients a position must not carry, by zeroing its COLUMN. Doing it here rather
    # than after the fit means the other coefficients are fitted in the absence of the column, not
    # fitted with it and then had it removed underneath them.
    keep = [j for j, s in enumerate(specs)
            if s["name"] not in RATIO_ALLOWED or pos in RATIO_ALLOWED[s["name"]]]
    Xk = X[:, keep]
    pts = np.array([float(r["pts"]) for r in sub])
    y = target(base, pts, form)
    groups = np.array([r["season"] for r in sub])

    alphas = [0.1, 1.0, 10.0, 100.0]
    n_splits = min(5, len(set(groups.tolist())))
    best_alpha, best_err = alphas[0], float("inf")
    if n_splits >= 2:
        gkf = GroupKFold(n_splits=n_splits)
        for a in alphas:
            err, n = 0.0, 0
            for tr, te in gkf.split(Xk, y, groups):
                m = Ridge(alpha=a).fit(Xk[tr], y[tr])
                p = m.predict(Xk[te])
                err += float(np.sum((y[te] - p) ** 2))
                n += len(te)
            if n and err / n < best_err:
                best_err, best_alpha = err / n, a
    mean_model = Ridge(alpha=best_alpha).fit(Xk, y)

    coef = {"mean": {"intercept": float(mean_model.intercept_)}}
    for j, jj in enumerate(keep):
        coef["mean"][specs[jj]["name"]] = float(mean_model.coef_[j])

    # QUANTILES ACROSS THE WHOLE RANK RANGE THE BOARD PRICES, with rank in the design.
    #
    # Phase 2a fitted these on ranks 1-36 and then scored them on 1-60, and reported the resulting
    # 0.614 coverage as a property of the model. It was a property of the experiment: past rank 24
    # the bands were far too narrow (0.56 at 41-60) and nothing in the fit had ever been asked about
    # that region. Fitting where you score is not a refinement, it is the difference between a
    # calibration and an extrapolation.
    for name, q in (("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        if len(y) >= 150:
            qm = QuantileRegressor(quantile=q, alpha=args.quantile_alpha, solver="highs").fit(Xk, y)
            c = {"intercept": float(qm.intercept_)}
            for j, jj in enumerate(keep):
                c[specs[jj]["name"]] = float(qm.coef_[j])
        else:
            c = {"intercept": quantile(y, q)}
        coef[name] = c

    # Every declared feature needs a coefficient at every head, including the ones this position is
    # not allowed to use. An ABSENT coefficient and a ZERO one look the same in a prediction and
    # completely different in a schema check, and the loader refuses the absent case on purpose.
    for h in ("mean", "p10", "p50", "p90"):
        for s in specs:
            coef[h].setdefault(s["name"], 0.0)
    return coef


def intercept_only(sub, base, specs, form):
    pts = np.array([float(r["pts"]) for r in sub])
    y = target(base, pts, form)
    out = {}
    for name, q in (("mean", None), ("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        v = float(np.mean(y)) if q is None else quantile(y, q)
        c = {"intercept": v}
        for s in specs:
            c[s["name"]] = 0.0
        out[name] = c
    return out


def usage_lift(sub, X, specs, pos, base, args, form):
    """The point-in-time per-position lift of the USAGE features, measured here rather than claimed.

    This is what replaces `opportunity-model.json`'s recorded amplitudes, and it is the number D1
    said could not be trusted: those amplitudes were fitted against a curve that had seen the future.
    Season-grouped CV inside the training data, ridge only, reported as the reduction in RMSE (in
    points) from adding the four usage-ratio columns to a model that already has age, games, draft
    round and rank.
    """
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import GroupKFold

    keep = [j for j, s in enumerate(specs)
            if s["name"] not in RATIO_ALLOWED or pos in RATIO_ALLOWED[s["name"]]]
    without = [j for j in keep if specs[j]["name"] not in RATIO_FEATURES]
    if len(without) == len(keep):
        return None
    pts = np.array([float(r["pts"]) for r in sub])
    y = target(base, pts, form)
    groups = np.array([r["season"] for r in sub])
    n_splits = min(5, len(set(groups.tolist())))
    if n_splits < 2:
        return None
    gkf = GroupKFold(n_splits=n_splits)
    err = {"with": 0.0, "without": 0.0}
    n = 0
    for tr, te in gkf.split(X, y, groups):
        for label, cols in (("with", keep), ("without", without)):
            m = Ridge(alpha=args.alpha_default).fit(X[np.ix_(tr, cols)], y[tr])
            p = predict_points(base[te], m.predict(X[np.ix_(te, cols)]), form)
            err[label] += float(np.sum((pts[te] - p) ** 2))
        n += len(te)
    if not n:
        return None
    return math.sqrt(err["without"] / n) - math.sqrt(err["with"] / n)


def evaluate(artifact, row):
    """Predict one row with THIS script's own arithmetic -- the golden block's source of truth."""
    heads = artifact["coef"][row["pos"]]
    x = [feature_value(s, row) for s in artifact["features"]]
    form = artifact.get("form", "ratio")
    out = {}
    for h in ("mean", "p10", "p50", "p90"):
        c = heads[h]
        lin = c.get("intercept", 0.0)
        for j, s in enumerate(artifact["features"]):
            lin += c.get(s["name"], 0.0) * x[j]
        b = row["base"]
        if form == "offset":
            out[h] = min(b * artifact["clamps"]["hi"], max(b * artifact["clamps"]["lo"], b + lin))
        else:
            out[h] = b * min(artifact["clamps"]["hi"], max(artifact["clamps"]["lo"], lin))
    return out


def golden_rows(artifact):
    """Five fixtures, chosen to be the ones most likely to expose a disagreement."""
    fixtures = [
        {"pos": "RB", "base": 250.0, "_rank": 1, "prior_pos_rank": 1,
         "age": 24.0, "prior_games": 17, "prior_fd": 5.0, "prior_ts": 0.18, "team_changed": 0},
        {"pos": "WR", "base": 175.0, "_rank": 12, "prior_pos_rank": 12,
         "age": 29.5, "prior_games": 15, "prior_fd": 3.1, "prior_ts": 0.22, "team_changed": 1},
        {"pos": "QB", "base": 246.0, "_rank": 12, "prior_pos_rank": 12,
         "age": 33.0, "prior_games": 16, "prior_attempts": 34.0, "prior_rush_yards": 12.0, "team_changed": 0},
        {"pos": "TE", "base": 101.0, "_rank": 24, "prior_pos_rank": 24,
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
    ap.add_argument("--as-of", default=None,
                    help="the season this artifact will project. Defaults to the holdout, else the "
                         "season after the last one in --seasons.")
    ap.add_argument("--quantile-alpha", type=float, default=0.01)
    ap.add_argument("--alpha-default", type=float, default=1.0,
                    help="ridge alpha used INSIDE the variant search, where an alpha search per "
                         "variant would multiply the cost by four and change no ordering")
    ap.add_argument("--inner-folds", type=int, default=3)
    ap.add_argument("--fixed-variant", default=None,
                    help="w,mono,levelWeight,form -- skip the search. For fault injection and for "
                         "reproducing a recorded run, never for shipping.")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--add-features", default="",
                    help="comma list of EXTENSION columns to admit into the fit, one admission step "
                         "at a time. Known: " + ", ".join(ALL_EXT) + ". Nothing is admitted by "
                         "default: a column that joined the default list by a code edit would be a "
                         "feature admitted without a gate.")
    args = ap.parse_args()

    # ---- ADMISSION. The lists are extended HERE, from the flag, so the default fit is byte-for-byte
    # the one that shipped and a candidate's effect is exactly the difference the flag makes.
    add = [s.strip() for s in args.add_features.split(",") if s.strip()]
    unknown = [a for a in add if a not in ALL_EXT]
    if unknown:
        sys.exit("train_projection: unknown --add-features " + ", ".join(unknown) +
                 ". Known: " + ", ".join(ALL_EXT))
    for a in add:
        # Already in the defaults (Phase 2d admitted two of them) -- naming it again must be a no-op
        # rather than a duplicate column in the design matrix, which would halve each copy's
        # coefficient and read as the feature getting weaker.
        if a in CENTER_FEATURES or a in INDICATOR_FEATURES or a in RATIO_FEATURES:
            continue
        if a in EXT_RATIO:
            RATIO_FEATURES[a] = EXT_RATIO[a]
            if a in EXT_ALLOWED:
                RATIO_ALLOWED[a] = EXT_ALLOWED[a]
        elif a in EXT_INDICATOR:
            INDICATOR_FEATURES.append(a)
        else:
            CENTER_FEATURES.append(a)

    lo, hi = parse_seasons(args.seasons)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    all_rows = load_rows(args.db, lo, hi)
    as_of = int(args.as_of) if args.as_of else (holdout if holdout is not None else hi + 1)

    # THE TRAINING SET IS SEASONS STRICTLY BEFORE `as_of`. Not "every season except the holdout":
    # the curve is fitted on season pairs, so a training row from a season AFTER the holdout carries
    # a base built from a window that contains the holdout. Excluding the holdout row while keeping
    # the rows whose curve saw it is lookahead that no row-level filter can catch.
    rows = [r for r in all_rows if r["season"] < as_of]
    if not rows:
        sys.exit("train_projection: no training rows -- has `ff build-features` been run?")
    source = CurveSource(rows)

    fit_rows = [r for r in rows
                if r["prior_pos_rank"] is not None and 1 <= r["prior_pos_rank"] <= MAX_RANK]
    bmeans = bucket_means(fit_rows)
    specs = build_specs(fit_rows, bmeans)

    fixed = None
    if args.fixed_variant:
        parts = args.fixed_variant.split(",")
        fixed = (int(parts[0]), parts[1].lower() in ("1", "true", "on", "mono"), float(parts[2]), parts[3])

    coef, counts, variants, curves, lifts = {}, {}, {}, {}, {}
    for pos in POS_FITTED + POS_INTERCEPT_ONLY:
        sub = [r for r in fit_rows if r["pos"] == pos]
        if len(sub) < 200:
            continue
        X = design(sub, specs)
        if fixed is not None:
            v, loss = fixed, float("nan")
        else:
            v, loss, _table = select_variant(sub, X, specs, source, pos, args)
        if v is None:
            continue
        # The FINAL curve: fitted on every training season, applied to `as_of`. Each training row
        # still gets a base from the curve as of ITS OWN season, so no row is fitted against a curve
        # that saw it.
        per_season = {s: source.build(pos, v, s) for s in sorted({r["season"] for r in sub})}
        final = source.build(pos, v, as_of)
        if not final:
            continue
        base = bases_for(sub, per_season)
        ok = np.isfinite(base)
        if ok.sum() < 200:
            continue
        sub_ok = [r for i, r in enumerate(sub) if ok[i]]
        if pos in POS_INTERCEPT_ONLY:
            coef[pos] = intercept_only(sub_ok, base[ok], specs, v[3])
        else:
            coef[pos] = fit_position(sub_ok, X[ok], specs, pos, base[ok], args, v[3])
            lift = usage_lift(sub_ok, X[ok], specs, pos, base[ok], args, v[3])
            if lift is not None:
                lifts[pos] = lift
        counts[pos] = int(ok.sum())
        curves[pos] = [round(x, 4) for x in final]
        variants[pos] = {"window": v[0], "monotone": bool(v[1]), "levelWeight": v[2],
                         "form": v[3], "n": int(ok.sum()), "innerPinball": None if loss != loss else round(loss, 4)}

    if not coef:
        sys.exit("train_projection: nothing fitted")

    # ONE form for the artifact. The projector applies a single arithmetic to every position, so a
    # per-position form would need a per-position evaluator; where the positions disagree the
    # majority wins by total training rows and the dissenting positions are refitted under it. Which
    # positions dissented is recorded on the artifact rather than smoothed away.
    weight = {}
    for pos, v in variants.items():
        weight[v["form"]] = weight.get(v["form"], 0) + v["n"]
    form = max(weight.items(), key=lambda kv: kv[1])[0]
    for pos, v in list(variants.items()):
        if v["form"] == form:
            continue
        v["formOverriddenFrom"] = v["form"]
        v["form"] = form
        sub = [r for r in fit_rows if r["pos"] == pos]
        X = design(sub, specs)
        vv = (v["window"], v["monotone"], v["levelWeight"], form)
        per_season = {s: source.build(pos, vv, s) for s in sorted({r["season"] for r in sub})}
        base = bases_for(sub, per_season)
        ok = np.isfinite(base)
        sub_ok = [r for i, r in enumerate(sub) if ok[i]]
        coef[pos] = (intercept_only(sub_ok, base[ok], specs, form) if pos in POS_INTERCEPT_ONLY
                     else fit_position(sub_ok, X[ok], specs, pos, base[ok], args, form))

    seasons = sorted({r["season"] for r in fit_rows})
    artifact = {
        "schema": SCHEMA,
        "kind": "projection",
        "fittedFrom": "tools/train_projection.py",
        "fittedAt": date.today().isoformat(),
        "seasons": seasons,
        "holdoutSeason": holdout,
        "base": "artifact_curve",
        "curve": curves,
        "curveVariant": variants,
        "features": specs,
        # EMPTY, and required to be. The stage is retired: age is a fitted feature here and usage is
        # a ratio to its rank bucket, both inside the fold. See FACTOR_FIELDS in projector.ts.
        "multiplicative": [],
        "form": form,
        "coef": coef,
        "clamps": {"lo": CLAMP_LO, "hi": CLAMP_HI},
        "notes": (
            "Curve construction (window, monotone repair, ECR level weight) and the base form were "
            "SELECTED PER POSITION by forward-chaining inner cross-validation on pinball loss; the "
            "training set is seasons strictly before " + str(as_of) + ". Ridge for the mean with "
            "alpha by season-grouped CV; p10/p50/p90 by pinball-loss linear quantile regression "
            "over ranks 1-" + str(MAX_RANK) + " with rank in the design. K and DST are "
            "intercept-only by MEASUREMENT, not omission (nested CV: K -0.0073, DST -0.0041)."
        ),
    }
    if lifts:
        artifact["usageLiftRmse"] = {k: round(v, 4) for k, v in lifts.items()}
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, indent=2)
    if not args.quiet:
        print("wrote " + args.out)
        print("  train seasons " + str(seasons[0]) + "-" + str(seasons[-1]) +
              "; as-of " + str(as_of) +
              (" holding out " + str(holdout) if holdout else "") +
              "; " + str(len(specs)) + " features; form " + form)
        print("  pos   n      curve variant                       inner pinball  usage lift (rmse pts)")
        for pos in sorted(variants):
            v = variants[pos]
            print("  " + pos.ljust(4) + " " + str(v["n"]).rjust(5) +
                  "  window " + str(v["window"]) +
                  "  monotone " + ("yes" if v["monotone"] else "no ") +
                  "  level " + format(v["levelWeight"], ".1f") +
                  "  " + str(v.get("innerPinball")).rjust(8) +
                  ("  " + format(lifts[pos], "+.3f") if pos in lifts else "") +
                  ("  (form overridden from " + v["formOverriddenFrom"] + ")" if "formOverriddenFrom" in v else "") +
                  "  curveLen " + str(len(curves[pos])))
        for pos in sorted(coef):
            m = coef[pos]["mean"]
            terms = ", ".join(k + " " + format(v, ".4f") for k, v in m.items() if k != "intercept" and abs(v) > 1e-9)
            print("  " + pos.ljust(4) + "  intercept " + format(m["intercept"], ".4f") + "  " + (terms or "(intercept only)"))
        print("  golden rows: " + str(len(artifact["golden"])))


if __name__ == "__main__":
    main()
