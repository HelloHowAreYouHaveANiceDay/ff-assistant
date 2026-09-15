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

# Schema 2 (2026-09-14, D16): the artifact may carry a `learner` and a `boosted` block (serialised
# gradient-boosted ensembles) beside the linear heads. src/model/projector.ts accepts 1 and 2.
SCHEMA = 2
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
    # ADMITTED 2026-09-14 (owner decision D16, ladder rung 7): FFToday's preseason projection as a
    # ratio to the rank bucket. Gate: +0.3257 pinball vs floor 0.2750 on 2012-2020, holdout 2021-2025
    # +0.5024 (5/5, confirmed); the ADP market rank gated the same way is a null, so this is judgement,
    # not the crowd. D13 playoff gate NULL/underpowered (-0.58pp, CI [-2.08, +0.92]) at a system already
    # 95.5% playoffs. Joined in load_rows on (season, pos, name_key); see EXTERNAL_RATIO below.
    "fftoday_proj": 20.0,
}
# `prior_pos_rank` is here for the QUANTILE heads above all. Dispersion around the curve widens
# sharply with rank -- a WR50's season is far less predictable in proportional terms than a WR3's --
# and a quantile head with no rank term cannot express that at all. It is the single change that the
# Phase 2a coverage table (0.83 at ranks 13-24, 0.56 at 41-60) points straight at.
# ADMITTED IN PHASE 2d, in survivor order, each re-measured under the full nested evaluation rather
# than on the residuals it was screened against. The admission trace is in docs/validation.md.
#   depth_rank_sep1  screen rho -0.186 (the strongest candidate the sweep has ever produced);
#                    admitted at pinball 12.31 -> 12.03, RMSE 54.17 -> 52.79, coverage 0.759 -> 0.761.
#   contract_year    screen rho -0.124; admitted at pinball 12.03 -> 12.02 (the edge of resolution),
#                    then DROPPED 2026-09-14 -- see below.
# EFFECT-SIZE FLOOR NOW ENFORCED (rigor WS1). Admission no longer reads a hand-noted 12.03->12.02:
# `scripts/admit-feature.mjs` runs the nested CV baseline vs +candidate, takes the per-SEASON trained
# pinball, and admits ONLY if the season-paired improvement clears 2.9*SE (the arbiter's floor).
# `contract_year` PREDATED that floor and, when finally tested by leave-one-out (--remove, 2026-09-14),
# did NOT clear it: its own contribution was +0.0039 pinball vs a 0.0100 floor, winning only 3/9
# seasons, holdout not confirmed (docs/decisions.md acceptance block; docs/feature-frontier.md). So it
# was DROPPED from the fit (owner decision) -- not because it hurt (it is inert, ~0 effect) but because
# WS1 says a feature must clear the floor to be carried, and a grandfathered noise column is exactly
# what the floor exists to catch. It remains a COLUMN of feat_player_season_ext (data-layer coverage)
# and an --add-features candidate below, so re-admitting it later is one flag + a passing gate.
CENTER_FEATURES = ["age", "prior_games", "draft_round", "prior_pos_rank", "depth_rank_sep1"]
INDICATOR_FEATURES = ["team_changed"]

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
# `depth_rank_sep1` is in the DEFAULT list above (Phase 2d). `contract_year` WAS, until it was dropped
# 2026-09-14 for failing the WS1 floor (see above); it stays named here as an --add-features candidate
# so the loader still reads the column and re-admitting it is one flag + a passing gate.
EXT_CENTER = [
    "prior_snap_share", "prior_route_share", "prior_carries_per_game", "prior_carry_share",
    "prior_air_yards_share", "prior_wopr", "depth_rank_sep1", "adp", "adp_vs_ecr",
    "rookie_draft_pick",
    # FRONTIER CANDIDATES (2026-09-14). Prior-season / Sep-1 columns, screened one at a time via
    # --add-features; none is a default. docs/feature-frontier.md.
    "prior_out_games", "prior_yac_oe", "prior_ryoe", "prior_cpoe",
    # FRONTIER (2026-09-15): prior-season red-zone/goal-line opportunity shares from raw_pbp_player_week.
    "prior_rz_touch_share", "prior_gtg_carry_share", "prior_ez_target_share",
]
EXT_INDICATOR = ["contract_year", "qb_changed"]
EXT_RATIO = {
    # A carry rate divided by the mean for the player's rank bucket, for the same reason every other
    # ratio feature is: an RB5's raw carry share is high BECAUSE he is an RB5, and the curve has
    # already been paid for that.
    "prior_carries_per_game": 0.5,
    "prior_carry_share": 0.02,
    "prior_air_yards_share": 0.02,
    "prior_wopr": 0.02,
    # A red-zone share is high BECAUSE the man is a lead back / alpha receiver, i.e. already high-rank;
    # dividing by the rank-bucket mean isolates whatever TD-equity signal sits ABOVE the rank the curve
    # is already paid for -- the same reason the volume shares are ratios.
    "prior_rz_touch_share": 0.02,
    "prior_gtg_carry_share": 0.02,
    "prior_ez_target_share": 0.02,
}
EXT_ALLOWED = {
    "prior_carries_per_game": {"QB", "RB"},
    "prior_carry_share": {"RB"},
    "prior_air_yards_share": {"WR", "TE"},
    "prior_wopr": {"WR", "TE"},
    "prior_route_share": {"RB", "WR", "TE"},
    # FRONTIER: each NGS metric is a property of one position family; qb_changed is a skill-player
    # signal (a QB "changing his own QB" is meaningless -- that is team_changed).
    "prior_yac_oe": {"WR", "TE"},
    "prior_ryoe": {"RB"},
    "prior_cpoe": {"QB"},
    "qb_changed": {"RB", "WR", "TE"},
    # prior_out_games is deliberately NOT gated: durability applies at every position.
    # PBP opportunity: red-zone touches accrue to backs and receivers; goal-to-go carries are the
    # goal-line back (RB); end-zone targets are a receiver signal (WR/TE).
    "prior_rz_touch_share": {"RB", "WR", "TE"},
    "prior_gtg_carry_share": {"RB"},
    "prior_ez_target_share": {"WR", "TE"},
}
# ==================================================================================================
# MULTI-YEAR HISTORY -- rung 2 of the pre-deep-learning ladder (2026-09-14).
#
# Every default feature above is Y-1 only. These three are lags of feat_player_season ITSELF, joined
# by player_sk in load_rows (Y-2 and Y-3 rows), so they reach back to 2001 and need no extension-table
# rebuild. All three are RATIO features, divided by the mean for the player's Y-1 rank bucket, so each
# asks "relative to what his Y-1 rank implies, was his longer history better or worse?" -- the
# regression-to-a-longer-mean question a Y-1-only design cannot ask. Missing (no older season) is
# 1.0, "exactly what his rank implies". Candidates only: none is a default until it clears WS1.
#
#   prior2_pts   season points two seasons back (the Y-2 row's pts)
#   prior3_pts   season points three seasons back
#   hist_ppg_w   Marcel-style points per game over Y-1..Y-3, weighted 5/4/3 on BOTH points and games
#                (a 3-game Y-2 barely moves it); equals Y-1 ppg when no older season exists.
# Mirrored in src/model/features.ts (loadLagSeason / histPpgW); the golden block carries fixtures
# with these keys so the two implementations are checked, not assumed, to agree.
LAG_RATIO = {"prior2_pts": 20.0, "prior3_pts": 20.0, "hist_ppg_w": 2.0}
LAG_WEIGHTS = (5.0, 4.0, 3.0)


def hist_ppg_w(p1, g1, p2, g2, p3, g3):
    """Games-weighted three-season points per game. Mirrors histPpgW() in src/model/features.ts."""
    num = den = 0.0
    for w, p, g in zip(LAG_WEIGHTS, (p1, p2, p3), (g1, g2, g3)):
        if p is None or g is None or float(g) <= 0:
            continue
        num += w * float(p)
        den += w * float(g)
    return (num / den) if den > 0 else None


# ==================================================================================================
# A NONLINEAR BASIS THAT STAYS LINEAR IN PARAMETERS -- rung 4 of the ladder (2026-09-14).
#
# Three pre-registered terms, each derived from a field already in the row, so the TypeScript
# projector needs only the basis (src/model/features.ts basisFeatures) and no new evaluator:
#   age_sq       (age - 27)^2      curvature of the age effect: the fit above is a straight line in
#                                  age, and an age curve is not a line
#   age_hinge30  max(age - 30, 0)  the late-career cliff, as the simplest spline: one knot at 30
#   log_rank     ln(clip(rank,1,60)) the elite end of the rank axis, where the residual against the
#                                  curve is steepest and a linear rank term is flattest
# CENTER features, candidates only (--add-features). Mirrored term for term in basisFeatures().
BASIS_CENTER = ["age_sq", "age_hinge30", "log_rank"]
AGE_PIVOT, AGE_HINGE = 27.0, 30.0


def basis_features(age, rank):
    """Mirrors basisFeatures() in src/model/features.ts."""
    out = {"age_sq": None, "age_hinge30": None, "log_rank": None}
    if age is not None:
        a = float(age)
        out["age_sq"] = (a - AGE_PIVOT) ** 2
        out["age_hinge30"] = max(a - AGE_HINGE, 0.0)
    if rank is not None:
        out["log_rank"] = math.log(min(max(float(rank), 1.0), float(MAX_RANK)))
    return out


# ==================================================================================================
# AN EXTERNAL PROJECTION AS A FEATURE -- rung 7 of the ladder (2026-09-14).
#
# `raw_fftoday_proj` holds FFToday's PRESEASON season projection for 2008-2026 (its own scoring, stored
# verbatim), joined here on (season, pos, name_key). Verified a projection and not leaked actuals:
# its correlation with the season's actual points is 0.60-0.79 by season (actuals would be 1.0), and
# with prior-season points 0.64-0.82. As a RATIO to the mean for the player's Y-1 rank bucket it asks
# "does an independent human projection see him above or below what his rank implies?" -- the
# scoring-system scale divides out. A candidate, never a default: the consensus blend at the VALUE
# layer was demoted under D14; this is a different test, under the projector's own gate.
EXTERNAL_RATIO = {"fftoday_proj": 20.0}

ALL_EXT = sorted(set(EXT_CENTER) | set(EXT_INDICATOR) | set(LAG_RATIO) | set(BASIS_CENTER)
                 | set(EXTERNAL_RATIO))
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


def embargo_seasons(as_of, embargo):
    """The seasons IMMEDIATELY BEFORE `as_of` that an ADJACENT-SEASON EMBARGO removes (WS3).

    Training is already walk-forward (`season < as_of`), so `as_of` and every later season are
    excluded as future. The embargo ALSO removes the `embargo` seasons just below `as_of`, because
    year N-1 autocorrelates with year N (career arcs, roster continuity), so a fold that trains on
    N-1 and tests on N overstates generalisation to a genuinely unseen season. `embargo=0` removes
    nothing and reproduces the pre-WS3 training set byte-for-byte. Pure and unit-testable: the whole
    of the season-exclusion decision lives here.
    """
    if embargo < 0:
        raise ValueError("embargo must be >= 0, got " + str(embargo))
    return set(range(as_of - embargo, as_of))


def load_rows(db_path, lo, hi):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    # The Y-2 and Y-3 rows are joined by SURROGATE KEY (the same key prior_pts is keyed on: the Y row's
    # prior_pts equals the Y-1 row's pts for every one of 8,592 resolved pairs in the store). Their
    # `pts`/`games` are season Y-2/Y-3 targets, which are past facts at the Y anchor.
    # The FFToday archive (rung 7) is joined on (season, pos, name_key) -- the same rule
    # src/model/features.ts loadExternalProj uses -- and only where the store has the table.
    has_fftoday = con.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'raw_fftoday_proj'"
    ).fetchone()[0] > 0
    cur = con.execute(
        "SELECT s.feat_key, s.player_sk, s.season, s.name, s.pos, s.prior_pos_rank, s.prior_pts,"
        " s.prior_games, s.age, s.prior_fd, s.prior_ts, s.prior_attempts, s.prior_rush_yards,"
        " s.prior_air_yards_share, s.prior_wopr, s.team_changed, s.draft_year, s.draft_round,"
        " s.draft_pick, s.ecr_pos_rank, s.ecr_sd, s.pts,"
        " l2.pts AS lag2_pts, l2.games AS lag2_games, l3.pts AS lag3_pts, l3.games AS lag3_games"
        + (", ff.proj_fpts AS fftoday_proj" if has_fftoday else ", NULL AS fftoday_proj") +
        " FROM feat_player_season s"
        " LEFT JOIN feat_player_season l2 ON l2.player_sk = s.player_sk AND l2.season = s.season - 2"
        " LEFT JOIN feat_player_season l3 ON l3.player_sk = s.player_sk AND l3.season = s.season - 3"
        + (" LEFT JOIN raw_fftoday_proj ff ON ff.season = s.season AND ff.pos = s.pos"
           " AND ff.name_key = s.name_key" if has_fftoday else "") +
        " WHERE s.season BETWEEN ? AND ? AND s.pts IS NOT NULL",
        (lo, hi),
    )
    rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["prior2_pts"] = r.pop("lag2_pts")
        g2 = r.pop("lag2_games")
        r["prior3_pts"] = r.pop("lag3_pts")
        g3 = r.pop("lag3_games")
        r["hist_ppg_w"] = hist_ppg_w(r.get("prior_pts"), r.get("prior_games"),
                                     r["prior2_pts"], g2, r["prior3_pts"], g3)
        r.update(basis_features(r.get("age"), r.get("prior_pos_rank")))
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
            " prior_wopr, depth_rank_sep1, adp, prior_out_games, prior_yac_oe, prior_ryoe, prior_cpoe,"
            " qb_changed, prior_rz_touch_share, prior_gtg_carry_share, prior_ez_target_share"
            " FROM feat_player_season_ext"
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


def build_specs(rows, bmeans, shrink_k=0.0):
    """The feature list, with every transform parameter measured here and written onto the artifact.

    `missing` is required to be EXPLICIT. A missing input silently becoming 0 means "this player is
    exactly average" wherever a feature is centred and "he saw no usage at all" where it is not --
    a guess wearing the costume of a default. For the centred features the explicit choice is
    mean-imputation, which is 0 after centring and is stated as such; for a ratio feature it is 1.0,
    "exactly what his rank implies".

    `shrink_k` > 0 (ladder rung 3a, `--shrink-k`) switches every ratio feature to the SHRUNK transform:
    the ratio is pulled toward 1.0 by g/(g+K), g = the row's prior_games. A per-game rate from three
    games is mostly noise and from seventeen mostly signal; K is how many games the prior is worth.
    0 (the default) emits the shipped transform byte for byte.
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
        spec = {
            "name": name, "transform": "ratio_to_bucket_mean", "bucket": BUCKET,
            "floor": floor, "bucketMeans": bmeans[name], "missing": 1.0,
        }
        if shrink_k and shrink_k > 0:
            spec["transform"] = "ratio_to_bucket_mean_shrunk"
            spec["shrinkK"] = float(shrink_k)
            spec["gamesField"] = "prior_games"
        specs.append(spec)
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
    if t in ("ratio_to_bucket_mean", "ratio_to_bucket_mean_shrunk"):
        rank = row.get("_rank")
        if rank is None:
            return spec["missing"]
        b = str(bucket_of(int(rank)))
        m = spec["bucketMeans"].get(row["pos"], {}).get(b)
        if m is None or not (m > spec.get("floor", 0.0)):
            return spec["missing"]
        ratio = raw / m
        if t == "ratio_to_bucket_mean":
            return ratio
        # SHRUNK (rung 3a): mirrored in src/model/projector.ts featureValue() term for term.
        g = row.get(spec.get("gamesField", "prior_games"))
        if g is None or not (float(g) > 0):
            return spec["missing"]
        w = float(g) / (float(g) + float(spec["shrinkK"]))
        return 1.0 + w * (ratio - 1.0)
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

    Regularised, and the alpha is chosen by PLAYER-GROUPED cross-validation inside the training data
    (WS3). Grouping matters: a random split leaks between folds and every alpha looks better than it
    is. Grouping by PLAYER (not season) is the conservative choice -- a single player's seasons are
    autocorrelated (his own career arc), so letting the same player sit in both the alpha-fit and the
    alpha-scoring fold flatters the regularisation exactly the way season-grouping fixed the era leak
    but player-grouping additionally fixes. Falls back to season when player_sk is missing.
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
    # PLAYER-GROUPED (WS3): one player never spans two inner alpha folds. Fall back to season for a
    # row with no player_sk, which is the pre-WS3 grouping for exactly those rows.
    groups = np.array([("p" + str(r["player_sk"])) if r.get("player_sk") is not None
                       else ("s" + str(r["season"])) for r in sub])

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


def fit_pooled(fitted, specs, args, form, dev_mult):
    """PARTIAL POOLING ACROSS POSITIONS (ladder rung 3b, `--pool-dev-mult M`).

    fit_position fits each position alone: four ridge fits of ~700-900 rows each, and a QB coefficient
    on `age` that has never seen a running back's age. The hierarchical alternative is ONE fit whose
    design is [shared slopes | per-position intercepts | per-position DEVIATION slopes], with the
    deviation block scaled by 1/sqrt(M) so the ridge penalty on a deviation is M times the penalty on
    the shared slope. M -> infinity is one pooled model with position intercepts; M -> 0 is the
    per-position fit. Each position's served coefficient is shared + its own deviation, so the
    ARTIFACT SHAPE IS UNCHANGED and nothing on the TypeScript side moves.

    A column a position may not carry (RATIO_ALLOWED) is ZEROED for that position's rows in every
    block, so it contributes exactly nothing to the fit and the emitted 0.0 coefficient reproduces the
    fitted prediction -- the same masking fit_position does by dropping the column, done by value so
    the shared block can keep it for the positions that are allowed it.

    The quantile heads are fitted on the same augmented design but with the deviation block scaled by
    1/M rather than 1/sqrt(M): under an L1 penalty the column-scaling trick multiplies the penalty by
    the inverse scale, not its square, so 1/M is what makes "a deviation is penalised M times harder"
    true for every head. (Measured before this was fixed: at M=10 with 1/sqrt(M) the quantile heads
    were already FULLY pooled -- every deviation zeroed -- while the ridge mean head was partial, so
    the gate would have scored a different model from the one the flag describes.) The alpha search
    is the same player-grouped CV fit_position uses, over the pooled rows.
    """
    from sklearn.linear_model import Ridge, QuantileRegressor
    from sklearn.model_selection import GroupKFold

    positions = [p for p in POS_FITTED if p in fitted]
    if len(positions) < 2:
        return {}
    nf = len(specs)
    allowed = {}
    for p in positions:
        allowed[p] = np.array([s["name"] not in RATIO_ALLOWED or p in RATIO_ALLOWED[s["name"]] for s in specs])
    Xs, ys, groups, pos_idx = [], [], [], []
    for pi, p in enumerate(positions):
        sub, X, base = fitted[p]
        pts = np.array([float(r["pts"]) for r in sub])
        Xs.append(X * allowed[p][None, :].astype(float))
        ys.append(target(base, pts, form))
        groups.extend([("p" + str(r["player_sk"])) if r.get("player_sk") is not None
                       else ("s" + str(r["season"])) for r in sub])
        pos_idx.extend([pi] * len(sub))
    X_sh = np.vstack(Xs)
    y = np.concatenate(ys)
    pos_idx = np.array(pos_idx)
    groups = np.array(groups)
    n, P = len(y), len(positions)
    D = np.zeros((n, P))
    D[np.arange(n), pos_idx] = 1.0

    def augmented(scale):
        dev = np.zeros((n, P * nf))
        for pi in range(P):
            rows = np.where(pos_idx == pi)[0]
            dev[np.ix_(rows, range(pi * nf, (pi + 1) * nf))] = X_sh[rows] * scale
        return np.hstack([X_sh, D, dev])

    scale = 1.0 / math.sqrt(float(dev_mult))     # L2: penalty x M
    scale_q = 1.0 / float(dev_mult)              # L1: penalty x M
    X_aug = augmented(scale)
    X_aug_q = augmented(scale_q)

    alphas = [0.1, 1.0, 10.0, 100.0]
    n_splits = min(5, len(set(groups.tolist())))
    best_alpha, best_err = alphas[0], float("inf")
    if n_splits >= 2:
        gkf = GroupKFold(n_splits=n_splits)
        for a in alphas:
            err, cnt = 0.0, 0
            for tr, te in gkf.split(X_aug, y, groups):
                m = Ridge(alpha=a).fit(X_aug[tr], y[tr])
                err += float(np.sum((y[te] - m.predict(X_aug[te])) ** 2))
                cnt += len(te)
            if cnt and err / cnt < best_err:
                best_err, best_alpha = err / cnt, a
    mean_model = Ridge(alpha=best_alpha).fit(X_aug, y)

    def split_coef(w, b, sc):
        out = {}
        for pi, p in enumerate(positions):
            c = {"intercept": float(b + w[nf + pi])}
            for j, s in enumerate(specs):
                c[s["name"]] = (float(w[j] + w[nf + P + pi * nf + j] * sc)
                                if allowed[p][j] else 0.0)
            out[p] = c
        return out

    heads = {"mean": split_coef(mean_model.coef_, mean_model.intercept_, scale)}
    for name, q in (("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        qm = QuantileRegressor(quantile=q, alpha=args.quantile_alpha, solver="highs").fit(X_aug_q, y)
        heads[name] = split_coef(qm.coef_, qm.intercept_, scale_q)
    return {p: {h: heads[h][p] for h in ("mean", "p10", "p50", "p90")} for p in positions}


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


def evaluate(artifact, row, fb=None):
    """Predict one row with THIS script's own arithmetic -- the golden block's source of truth.

    For a boosted artifact the raw head value comes from scikit-learn's OWN predict() (`fb`, the
    fitted models), not from the Python walk: the golden block then checks the TypeScript walker
    against the producer itself, and boosted_self_check separately checks the Python walk against
    the same producer. Two independent checks on the seam, neither grading its own homework."""
    heads = artifact["coef"][row["pos"]]
    x = [feature_value(s, row) for s in artifact["features"]]
    form = artifact.get("form", "ratio")
    bb = artifact.get("boosted") if artifact.get("learner") == "gbm" else None
    x_aug = None
    if bb is not None and row["pos"] in bb["positions"]:
        x_aug = np.array([list(x) + [1.0 if p == row["pos"] else 0.0 for p in bb["positions"]]], dtype=float)
    out = {}
    for h in ("mean", "p10", "p50", "p90"):
        if x_aug is not None:
            lin = (float(fb["models"][h].predict(x_aug)[0]) + float(fb["shift"][h])) if fb is not None \
                else boosted_raw(bb["heads"][h], list(x_aug[0]))
        else:
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


def golden_rows(artifact, fb=None):
    """Five fixtures, chosen to be the ones most likely to expose a disagreement."""
    fixtures = [
        # The multi-year lags ride on the first two fixtures so an artifact that FITS them is checked
        # on the positive path, not only on the missing-value default of the fifth row.
        {"pos": "RB", "base": 250.0, "_rank": 1, "prior_pos_rank": 1,
         "age": 24.0, "prior_games": 17, "prior_fd": 5.0, "prior_ts": 0.18, "team_changed": 0,
         "prior2_pts": 210.0, "prior3_pts": 96.0, "hist_ppg_w": 15.4,
         "age_sq": 9.0, "age_hinge30": 0.0, "log_rank": 0.0, "fftoday_proj": 262.0},
        {"pos": "WR", "base": 175.0, "_rank": 12, "prior_pos_rank": 12,
         "age": 29.5, "prior_games": 15, "prior_fd": 3.1, "prior_ts": 0.22, "team_changed": 1,
         "prior2_pts": 121.0, "hist_ppg_w": 9.8,
         "age_sq": 6.25, "age_hinge30": 0.0, "log_rank": 2.4849066497880004, "fftoday_proj": 158.0},
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
        pred = evaluate(artifact, fx, fb)
        f = {k: v for k, v in fx.items() if k not in ("pos", "base", "_rank")}
        out.append({"pos": fx["pos"], "base": fx["base"], "rank": fx["_rank"], "f": f, "expect": pred})
    return out


def fit_boosted(fitted, specs, form, args):
    """THE BOOSTED LEARNER (rung 5; ADMITTED 2026-09-14, owner decision D16).

    Four HistGradientBoostingRegressor heads -- squared-error mean, quantile-loss p10/p50/p90 -- fitted
    on the SAME rows, transformed design and per-row base the linear heads use, pooled across the
    fitted positions with a one-hot position block appended to the design. Hyperparameters are the
    pre-registered screen settings (depth 3, 300 rounds at 0.05, 30 rows per leaf, L2 1.0, no early
    stopping); the gate measured +0.37 pinball vs floor 0.28 on 2012-2020 and +0.71 (5/5) on the
    2021-2025 holdout, and depth 2 / 150 rounds agreed to 0.01, so the choice is not a tuning artefact.

    Returns None when nothing is fitted. The curve variant, the transform centres and the bucket
    means are still selected/measured by the linear pipeline; the ensembles sit on top of that
    design, which is exactly what was screened.
    """
    from sklearn.ensemble import HistGradientBoostingRegressor

    positions = [p for p in POS_FITTED if p in fitted]
    if not positions:
        return None
    pidx = {p: i for i, p in enumerate(positions)}

    def onehot(pos_list):
        M = np.zeros((len(pos_list), len(positions)))
        for i, p in enumerate(pos_list):
            M[i, pidx[p]] = 1.0
        return M

    Xs, ys, groups = [], [], []
    for p in positions:
        sub, X, base = fitted[p]
        pts = np.array([float(r["pts"]) for r in sub])
        Xs.append(np.hstack([X, onehot([p] * len(sub))]))
        ys.append(target(base, pts, form))
        groups.extend([("p" + str(r["player_sk"])) if r.get("player_sk") is not None
                       else ("s" + str(r["season"])) for r in sub])
    X_tr = np.vstack(Xs)
    y_tr = np.concatenate(ys)
    groups = np.array(groups)
    hp = dict(max_depth=args.gbm_depth, learning_rate=0.05, max_iter=args.gbm_iter,
              min_samples_leaf=30, l2_regularization=1.0, early_stopping=False, random_state=0)
    models = {"mean": HistGradientBoostingRegressor(loss="squared_error", **hp).fit(X_tr, y_tr)}
    qlevels = (("p10", 0.10), ("p50", 0.50), ("p90", 0.90))
    for name, q in qlevels:
        models[name] = HistGradientBoostingRegressor(loss="quantile", quantile=q, **hp).fit(X_tr, y_tr)

    # CONFORMAL INTERVAL CALIBRATION (train-only). A boosted quantile head is fitted to its own
    # training rows and is narrower on unseen ones -- measured before this existed: pooled 10/90
    # coverage 0.729 under nested CV against the [0.75, 0.85] ship band, with the deep-rank bands
    # under 0.70. The correction is the standard split-conformal one, done with player-grouped
    # out-of-fold predictions on the TRAINING rows only: for head q, shift its raw prediction by the
    # q-quantile of (y - oof prediction), so that its out-of-fold coverage on training rows is nominal.
    # The shift is a constant in target units, folded into the head's `baseline`, so the artifact
    # shape and the TypeScript walker are untouched. Nothing here sees a held-out season; the nested
    # CV then measures whether it was enough. Precedent: D11's "calibrated refit that passes on its
    # own merit". --conformal-k 0 turns it off (the pre-calibration heads, for the record).
    shift = {h: 0.0 for h in models}
    if args.conformal_k and args.conformal_k > 0:
        from sklearn.model_selection import GroupKFold
        k = min(int(args.conformal_k), len(set(groups.tolist())))
        if k >= 2:
            gkf = GroupKFold(n_splits=k)
            for name, q in qlevels:
                oof = np.full(len(y_tr), np.nan)
                for tr, te in gkf.split(X_tr, y_tr, groups):
                    m = HistGradientBoostingRegressor(loss="quantile", quantile=q, **hp).fit(X_tr[tr], y_tr[tr])
                    oof[te] = m.predict(X_tr[te])
                ok = np.isfinite(oof)
                shift[name] = float(np.quantile(y_tr[ok] - oof[ok], q))
    return {"positions": positions, "pidx": pidx, "onehot": onehot, "models": models, "shift": shift,
            "X_tr": X_tr, "params": {"max_depth": args.gbm_depth, "max_iter": args.gbm_iter,
                                     "learning_rate": 0.05, "min_samples_leaf": 30, "l2": 1.0,
                                     "conformalK": int(args.conformal_k or 0),
                                     "conformalShift": {h: round(s, 6) for h, s in shift.items()}}}


def serialize_boosted(fb):
    """The ensembles as the artifact carries them: per head, `baseline` plus one tree per boosting
    round as parallel node arrays. Read straight off scikit-learn's own predictor nodes; the walker
    in src/model/projector.ts (treeValue/boostedRaw) mirrors predict() -- go left on
    x <= threshold, missing values per the node's flag, leaf values already carry the learning rate.
    Verified against predict() to 1e-15 on synthetic data before this was written, and re-verified
    on every fit by boosted_self_check below."""
    heads = {}
    for h, m in fb["models"].items():
        trees = []
        for it in m._predictors:
            nodes = it[0].nodes
            trees.append({
                "feature": [int(n["feature_idx"]) for n in nodes],
                "threshold": [float(n["num_threshold"]) for n in nodes],
                "left": [int(n["left"]) for n in nodes],
                "right": [int(n["right"]) for n in nodes],
                "value": [float(n["value"]) for n in nodes],
                "leaf": [bool(n["is_leaf"]) for n in nodes],
                "missingLeft": [bool(n["missing_go_to_left"]) for n in nodes],
            })
        # The conformal shift rides in the baseline: raw = baseline + sum(trees) is then the CALIBRATED
        # prediction on the TypeScript side with no extra field to forget.
        heads[h] = {"baseline": float(np.asarray(m._baseline_prediction).ravel()[0]) + float(fb["shift"][h]),
                    "trees": trees}
    return {"learner": "gbm", "positions": list(fb["positions"]), "params": dict(fb["params"]), "heads": heads}


def boosted_raw(head, x):
    """The Python mirror of projector.ts boostedRaw(): baseline plus every tree's leaf value."""
    s = float(head["baseline"])
    for t in head["trees"]:
        i = 0
        while not t["leaf"][i]:
            v = x[t["feature"][i]]
            if v != v:                         # NaN
                i = t["left"][i] if t["missingLeft"][i] else t["right"][i]
            elif v <= t["threshold"][i]:
                i = t["left"][i]
            else:
                i = t["right"][i]
        s += t["value"][i]
    return s


def boosted_self_check(block, fb, tol=1e-9):
    """The serialised block, walked by the mirror above, must reproduce scikit-learn's predict() on
    the whole training design. A serialisation that dropped a field would otherwise ship a model
    that is wrong everywhere and refused nowhere."""
    X = fb["X_tr"]
    for h, m in fb["models"].items():
        ref = m.predict(X) + float(fb["shift"][h])
        mine = np.array([boosted_raw(block["heads"][h], list(map(float, X[i]))) for i in range(len(X))])
        worst = float(np.max(np.abs(mine - ref)))
        if not (worst <= tol):
            sys.exit("train_projection: boosted head " + h + " serialisation does not reproduce predict() "
                     "(max |walk - predict| = " + repr(worst) + ") -- refusing to write an artifact "
                     "whose TypeScript walker could not possibly agree with the model")


def fit_challenger_gbm(fitted, specs, form, hold_rows, curves, args):
    """RUNG 5 -- A GRADIENT-BOOSTED CHALLENGER, AS A SCREEN, NOT A SERVING PATH.

    The artifact schema is a linear predictor, and the TypeScript projector evaluates nothing else.
    Before writing and golden-testing a tree evaluator in the draft engine, the question is whether a
    boosted model beats the ridge on the SAME folds, targets and scoring at all -- so this fits one on
    the same rows, design and per-row base the linear heads were fitted on (pooled across the fitted
    positions with a one-hot position block), predicts the holdout season's rows, and writes them to a
    SIDECAR beside the artifact (`<out>.challenger.json`). `src/model/evaluate.ts` reads the sidecar
    into a `challenger` rung scored by the same function as `trained`, and `gate-variant.mjs
    --cand-rung challenger` applies the WS1 verdict on the intersection of rows. What this is NOT: a
    shipped path. Nothing on the board reads it. If it clears the floor, building the evaluator is
    justified; if it does not, that answer cost no evaluator.

    Hyperparameters are PRE-REGISTERED and modest for ~3,000-6,000 rows: depth 3, 300 rounds at 0.05,
    30 rows per leaf, L2 1.0, no early stopping (which would need a split the folds already are).
    Quantile heads use the quantile loss at the same three levels the linear heads publish.
    """
    fb = fit_boosted(fitted, specs, form, args)
    if fb is None:
        return []
    pidx, onehot, models = fb["pidx"], fb["onehot"], fb["models"]

    hold = [r for r in hold_rows if r["pos"] in pidx and r.get("prior_pos_rank") is not None]
    if not hold:
        return []
    base = np.array([(curve_at(curves.get(r["pos"]), r["prior_pos_rank"]) or float("nan")) for r in hold],
                    dtype=float)
    ok = np.isfinite(base) & (base > 0)
    hold = [r for i, r in enumerate(hold) if ok[i]]
    base = base[ok]
    X_h = np.hstack([design(hold, specs), onehot([r["pos"] for r in hold])])
    preds = {h: predict_points(base, m.predict(X_h), form) for h, m in models.items()}
    out = []
    for i, r in enumerate(hold):
        out.append({"name": r["name"], "pos": r["pos"],
                    "mean": float(preds["mean"][i]), "p10": float(preds["p10"][i]),
                    "p50": float(preds["p50"][i]), "p90": float(preds["p90"][i])})
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
    ap.add_argument("--embargo", type=int, default=0,
                    help="ADJACENT-SEASON EMBARGO (WS3): also drop the N seasons immediately before "
                         "the holdout/as-of from the training rows, because year N-1 autocorrelates "
                         "with year N. Default 0 = the shipped behaviour (byte-identical training "
                         "set). Set 1+ only to build the embargoed ARBITER fold artifacts; NOT for "
                         "the shipped artifact, where it would silently drop the most recent real "
                         "season for no leakage benefit (there is no future season to protect).")
    ap.add_argument("--fixed-variant", default=None,
                    help="w,mono,levelWeight,form -- skip the search. For fault injection and for "
                         "reproducing a recorded run, never for shipping.")
    ap.add_argument("--quiet", action="store_true")
    # THE PRE-DEEP-LEARNING LADDER (2026-09-14). Each is a change in HOW the fit is made, gated by
    # scripts/gate-variant.mjs under the same WS1 floor as a feature. Defaults reproduce the shipped
    # fit byte for byte.
    ap.add_argument("--shrink-k", type=float, default=0.0,
                    help="rung 3a: shrink every usage RATIO toward 1.0 by g/(g+K), g = prior_games. "
                         "0 = off (the shipped transform).")
    ap.add_argument("--pool-dev-mult", type=float, default=0.0,
                    help="rung 3b: partial pooling across positions -- one fit with shared slopes and "
                         "per-position deviations penalised M times harder. 0 = off (per-position fits).")
    ap.add_argument("--learner", default="gbm", choices=["gbm", "ridge"],
                    help="which heads serve the fitted positions (D16, 2026-09-14). gbm (the default): the "
                         "boosted ensembles, serialised onto the artifact beside the linear heads. ridge: "
                         "the linear heads only -- the pre-D16 model, for A/B and for the arbiter's floor.")
    ap.add_argument("--challenger", default="none", choices=["none", "gbm"],
                    help="rung 5: also fit a gradient-boosted challenger on the same rows and write its "
                         "HOLDOUT predictions to <out>.challenger.json (a screen; nothing serves it). "
                         "Requires --holdout-season.")
    ap.add_argument("--gbm-depth", type=int, default=3)
    ap.add_argument("--gbm-iter", type=int, default=300)
    ap.add_argument("--conformal-k", type=int, default=5,
                    help="player-grouped folds for the train-only conformal calibration of the boosted "
                         "quantile heads (see fit_boosted). 0 = off.")
    ap.add_argument("--add-features", default="",
                    help="comma list of EXTENSION columns to admit into the fit, one admission step "
                         "at a time. Known: " + ", ".join(ALL_EXT) + ". Nothing is admitted by "
                         "default: a column that joined the default list by a code edit would be a "
                         "feature admitted without a gate.")
    ap.add_argument("--remove-features", default="",
                    help="comma list of DEFAULT feature columns to REMOVE from the fit (LEAVE-ONE-OUT). "
                         "The symmetric case of --add-features: it measures an ALREADY-SHIPPED feature's "
                         "contribution -- the model without it is the baseline, the full default is the "
                         "candidate (admit-feature.mjs --remove). Removing a column that is in no default "
                         "list is an error (nothing to remove), so a typo cannot silently measure a no-op.")
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
        elif a in LAG_RATIO:
            RATIO_FEATURES[a] = LAG_RATIO[a]           # every position: history is history
        elif a in EXTERNAL_RATIO:
            RATIO_FEATURES[a] = EXTERNAL_RATIO[a]      # every position: the archive covers all four
        elif a in EXT_INDICATOR:
            INDICATOR_FEATURES.append(a)
        else:
            CENTER_FEATURES.append(a)
        # Position gating applies to ANY added feature, not just ratios: fit_position keeps a spec only
        # where `s["name"] not in RATIO_ALLOWED or pos in RATIO_ALLOWED[name]`, so a center/indicator
        # candidate that belongs to one position family (an NGS metric, qb_changed) registers its
        # allowed positions HERE. Ungated candidates (prior_out_games) simply are not in EXT_ALLOWED.
        if a in EXT_ALLOWED:
            RATIO_ALLOWED[a] = EXT_ALLOWED[a]

    # ---- LEAVE-ONE-OUT. Remove a named DEFAULT column from whichever list holds it, so the fit is the
    # shipped design MINUS that one feature. `admit-feature --remove` runs this as the BASELINE arm and
    # the untouched default as the CANDIDATE arm, so the "improvement" is the feature's own contribution.
    remove = [s.strip() for s in args.remove_features.split(",") if s.strip()]
    for r in remove:
        removed = False
        if r in INDICATOR_FEATURES:
            INDICATOR_FEATURES.remove(r); removed = True
        if r in CENTER_FEATURES:
            CENTER_FEATURES.remove(r); removed = True
        if r in RATIO_FEATURES:
            del RATIO_FEATURES[r]; RATIO_ALLOWED.pop(r, None); removed = True
        if not removed:
            sys.exit("train_projection: --remove-features " + r + " is not in any default feature list "
                     "(CENTER/INDICATOR/RATIO) -- nothing to remove. A leave-one-out of an absent column "
                     "would measure a no-op, so this is an error rather than a silent 0.")

    lo, hi = parse_seasons(args.seasons)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    all_rows = load_rows(args.db, lo, hi)
    as_of = int(args.as_of) if args.as_of else (holdout if holdout is not None else hi + 1)

    # THE TRAINING SET IS SEASONS STRICTLY BEFORE `as_of`. Not "every season except the holdout":
    # the curve is fitted on season pairs, so a training row from a season AFTER the holdout carries
    # a base built from a window that contains the holdout. Excluding the holdout row while keeping
    # the rows whose curve saw it is lookahead that no row-level filter can catch.
    if args.embargo < 0:
        sys.exit("train_projection: --embargo must be >= 0, got " + str(args.embargo))
    emb = embargo_seasons(as_of, args.embargo)
    rows = [r for r in all_rows if r["season"] < as_of and r["season"] not in emb]
    if not rows:
        sys.exit("train_projection: no training rows"
                 + (" after embargo of seasons " + str(sorted(emb)) if emb else "")
                 + " -- has `ff build-features` been run (or is the embargo too wide)?")
    source = CurveSource(rows)

    fit_rows = [r for r in rows
                if r["prior_pos_rank"] is not None and 1 <= r["prior_pos_rank"] <= MAX_RANK]
    bmeans = bucket_means(fit_rows)
    specs = build_specs(fit_rows, bmeans, args.shrink_k)

    fixed = None
    if args.fixed_variant:
        parts = args.fixed_variant.split(",")
        fixed = (int(parts[0]), parts[1].lower() in ("1", "true", "on", "mono"), float(parts[2]), parts[3])

    coef, counts, variants, curves, lifts = {}, {}, {}, {}, {}
    fitted = {}                                  # pos -> (rows, design, base) for the pooled refit
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
            fitted[pos] = (sub_ok, X[ok], base[ok])
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
        if pos not in POS_INTERCEPT_ONLY:
            fitted[pos] = (sub_ok, X[ok], base[ok])

    # PARTIAL POOLING (rung 3b): after every position's form is settled, refit the fitted positions
    # jointly and replace their heads. The per-position fit above still runs, so the default path is
    # untouched and usage_lift keeps reporting per position.
    if args.pool_dev_mult > 0:
        for p, c in fit_pooled(fitted, specs, args, form, args.pool_dev_mult).items():
            coef[p] = c

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

    # THE SERVED LEARNER (D16). The ensembles are fitted on the final per-position design and base,
    # serialised, checked against scikit-learn's own predict() on the whole training design, and only
    # then declared. `--learner ridge` leaves the artifact linear (schema 2, no block).
    fb = None
    if args.learner == "gbm":
        fb = fit_boosted(fitted, specs, form, args)
        if fb is not None:
            block = serialize_boosted(fb)
            boosted_self_check(block, fb)
            artifact["learner"] = "gbm"
            artifact["boosted"] = block
            artifact["notes"] += (" SERVED HEADS (D16): gradient-boosted ensembles (HistGradientBoosting, "
                                  "depth " + str(args.gbm_depth) + ", " + str(args.gbm_iter) + " rounds) on the "
                                  "same design for " + ", ".join(fb["positions"]) + "; the linear heads remain "
                                  "for K/DST and as the --learner ridge floor.")
    artifact["golden"] = golden_rows(artifact, fb)

    # COMPACT, not pretty-printed (D16): the boosted block is ~2.5 MB of node arrays, and an indented
    # dump puts every number on its own line -- a 250,000-line diff per regeneration. One line diffs as
    # one line; nothing reads this file by line.
    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, separators=(",", ":"))

    # RUNG 5 sidecar: the challenger's predictions for the HOLDOUT season only. Written beside the
    # artifact and read by evaluate.ts into its own rung; never by the board.
    if args.challenger == "gbm":
        if holdout is None:
            sys.exit("train_projection: --challenger needs --holdout-season (it predicts held-out rows only)")
        hold_rows = [r for r in all_rows if r["season"] == as_of]
        ch_rows = fit_challenger_gbm(fitted, specs, form, hold_rows, curves, args)
        with open(args.out + ".challenger.json", "w", encoding="ascii") as fh:
            json.dump({"learner": "gbm", "holdoutSeason": holdout, "form": form,
                       "params": {"max_depth": args.gbm_depth, "max_iter": args.gbm_iter,
                                  "learning_rate": 0.05, "min_samples_leaf": 30, "l2": 1.0},
                       "rows": ch_rows}, fh)
        if not args.quiet:
            print("  challenger gbm: " + str(len(ch_rows)) + " holdout rows -> " + args.out + ".challenger.json")
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
        if artifact.get("learner") == "gbm":
            bb = artifact["boosted"]
            print("  served learner: gbm for " + ", ".join(bb["positions"]) + "; trees per head " +
                  str(len(bb["heads"]["mean"]["trees"])) + "; self-check vs predict() passed; conformal shift " +
                  json.dumps(bb["params"].get("conformalShift")))
        print("  golden rows: " + str(len(artifact["golden"])))


if __name__ == "__main__":
    main()
