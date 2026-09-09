"""Fit the injury-duration model and emit a schema-validated artifact.

    uv run --with scikit-learn --with numpy tools/train_injury_duration.py \
        --db data/ff.db --seasons 2010-2024 --holdout-season none \
        --out data/injury-duration-artifact.json

    uv run --with scikit-learn --with numpy tools/train_injury_duration.py --nested

THE QUESTION. Given that a man is on the injury report and it is Friday, what is the probability he
misses the next k games, for k in 1..4? The copilot currently answers it with a PER-TIER RATE --
`missProb` in rosterValue.ts, `leadMissProb` in handcuff.ts -- fitted as games/17 for the player's
rank bucket, which knows his tier and nothing about the injury he has. The weekly model reads the
OUT designation, but only for the coming week. Neither has a horizon.

WHY TRAINING LIVES HERE AND SERVING LIVES IN TYPESCRIPT: the same reason train_projection.py gives.
The engine runs inside an Electron app with no Python toolchain. The seam is the ARTIFACT, and a
seam is where a producer and a consumer drift apart while both stay green -- so the artifact carries
a GOLDEN BLOCK, six fixture rows with THIS script's own probabilities, and src/inseason/
injuryHorizon.ts recomputes them and refuses the artifact if the two disagree by more than 1e-6.

FOUR SEPARATE MODELS, NOT ONE WITH A HORIZON FEATURE. P(miss next 1) and P(miss next 4) are asked of
the same row and answered from the same features, but they are different events with different base
rates (44% against 15% here) and, more to the point, different SHAPES: the designation dominates at
k=1 and the injury type dominates at k=4, which a single model with k as a feature cannot express
without an interaction on every column. Four fits also make the horizon curve monotone-checkable,
which is asserted in the contract test.

EVERYTHING IS FITTED STRICTLY BEFORE THE HOLDOUT. `--holdout-season Y` trains on seasons STRICTLY
BEFORE Y. That includes the rare-category collapse, the age centring, the winsorising bounds and the
inverse-regularisation search: all four are decisions made from data, and a collapse computed over
the full range would let the holdout tell the model which injury types are common. This is the same
rule train_projection.py states and it costs real data at the early folds.

THE BASELINES ARE COMPUTED BY THIS SCRIPT, THROUGH THE SAME CODE PATH:

  designation-only   the same regularised logistic with ONLY the designation indicators. Not a
                     lookup table of empirical rates: a lookup table would be fitted with no
                     regularisation and no intercept discipline and the comparison would be between
                     two different estimators as much as between two feature sets.
  tier availability  what the copilot uses today. 1 - (1 - m)^k where m = missProb(vm, pos, frac)
                     from data/variance-model.json. `frac` is RECONSTRUCTED: the player's within-
                     position rank on `feat_player_week_model.season_line_pg`, the preseason
                     projection per game as of September 1, which is the closest point-in-time stand
                     -in for the draft-board pool rank the shipped call site passes. That
                     reconstruction if anything FLATTERS the baseline, and it is stated because a
                     baseline built to lose is not a baseline.
"""

import argparse
import json
import math
import sqlite3
import sys
from datetime import date

import numpy as np

SCHEMA = 1
HORIZONS = [1, 2, 3, 4]

# A group must have at least this many TRAINING rows to get its own indicator. Below it the rows
# fold into `inj_other`, which is a real bucket with a coefficient rather than a silent drop. The
# threshold is a stated hyperparameter and is applied inside the fold.
MIN_GROUP_ROWS = 200

POSITIONS = ["QB", "RB", "WR", "TE"]
DESIGNATIONS = ["Out", "Doubtful", "Questionable", "Probable"]   # "" (practice-only) is the base
PRACTICE = ["DNP", "Limited"]                                    # "Full"/"" is the base

# Winsorising bounds, stated rather than fitted, at the edge of the range the feature is dense over.
# A linear coefficient outside its fitted range is an extrapolation nobody measured -- the same
# defect train_projection.py names on prior_pos_rank.
CLIPS = {
    "weeks_missed_so_far": (0, 6),
    "weeks_in_episode": (0, 8),
    "prior_episodes_same": (0, 3),
    "prior_episodes_any": (0, 6),
}


# ==================================================================================================
# LOADING
# ==================================================================================================

def load_rows(db_path, seasons):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    qs = ",".join("?" for _ in seasons)
    rows = [dict(r) for r in con.execute(
        "SELECT player_sk, season, week, pos, injury_group, designation, practice_status, "
        "       injury_secondary_present, "
        "       weeks_in_episode, weeks_missed_so_far, prior_episodes_same, prior_episodes_any, age, "
        "       miss_next_1, miss_next_2, miss_next_3, miss_next_4, games_remaining "
        "FROM feat_injury_horizon WHERE season IN (%s)" % qs, seasons)]
    # The reconstructed draft-board tier, for the tier baseline only. Ranked on the September-1
    # projection per game, within position, within season -- never on anything from the season.
    line = {}
    for r in con.execute(
        "SELECT season, player_sk, pos, MAX(season_line_pg) slp FROM feat_player_week_model "
        "WHERE season IN (%s) AND player_sk IS NOT NULL AND season_line_pg IS NOT NULL "
        "GROUP BY season, player_sk, pos" % qs, seasons):
        line.setdefault((r["season"], r["pos"]), []).append((r["slp"], str(r["player_sk"])))
    con.close()
    frac = {}
    for (season, pos), lst in line.items():
        lst.sort(key=lambda t: -t[0])
        n = len(lst)
        for i, (_, sk) in enumerate(lst):
            frac[(season, pos, sk)] = i / n if n else 0.0
    for r in rows:
        r["pool_rank_frac"] = frac.get((r["season"], r["pos"], str(r["player_sk"])))
    return rows


def load_variance_model(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def miss_prob(vm, pos, pool_rank_frac):
    """A LINE-BY-LINE PORT of missProb in src/inseason/rosterValue.ts, including the bye correction.
    Ported rather than approximated, because a baseline that is a slightly different function of the
    same artifact measures the port, not the model."""
    m = vm["pos"].get(pos)
    if not m:
        return 0.10
    avail = m["avail"]
    tiers = vm.get("tiers", len(avail))
    tier = min(len(avail) - 1, max(0, int(math.floor((pool_rank_frac or 0.0) * tiers))))
    per_playable = min(1.0, (avail[tier] if tier < len(avail) else 0.85) / (16.0 / 17.0))
    return max(0.0, min(1.0, 1.0 - per_playable))


# ==================================================================================================
# THE FEATURE SPEC -- a DECLARED list the TypeScript evaluator reads back. Three transforms, and
# each is small enough that a second implementation is checkable by the golden block.
# ==================================================================================================

def build_specs(train_rows):
    """Decide the feature list from TRAINING rows only: which injury groups clear MIN_GROUP_ROWS,
    and the age centre and scale. Both are data-dependent, so both belong inside the fold."""
    counts = {}
    for r in train_rows:
        counts[r["injury_group"] or "none"] = counts.get(r["injury_group"] or "none", 0) + 1
    kept = sorted([g for g, n in counts.items() if n >= MIN_GROUP_ROWS and g not in ("other",)])
    ages = [r["age"] for r in train_rows if r["age"] is not None]
    centre = round(float(np.mean(ages)), 4) if ages else 26.0
    scale = round(float(np.std(ages)), 4) if ages and float(np.std(ages)) > 0.5 else 3.0

    specs = []
    for d in DESIGNATIONS:
        specs.append({"name": "des_" + d.lower(), "transform": "eq", "field": "designation", "value": d})
    for p in PRACTICE:
        specs.append({"name": "prac_" + p.lower(), "transform": "eq", "field": "practice_status", "value": p})
    for g in kept:
        specs.append({"name": "inj_" + g, "transform": "eq", "field": "injury_group", "value": g})
    # Everything not kept lands here, INCLUDING an unseen group at serving time. It is an indicator
    # over a complement rather than a dropped row, so a new injury string cannot silently become the
    # reference category.
    specs.append({"name": "inj_other", "transform": "not_in", "field": "injury_group", "values": kept})
    for p in POSITIONS[1:]:
        specs.append({"name": "pos_" + p.lower(), "transform": "eq", "field": "pos", "value": p})
    for f, (lo, hi) in CLIPS.items():
        specs.append({"name": f, "transform": "clip", "field": f, "clipLo": lo, "clipHi": hi, "missing": 0.0})
    specs.append({"name": "age", "transform": "center", "field": "age",
                  "center": centre, "scale": scale, "clipLo": 20.0, "clipHi": 40.0, "missing": 0.0})
    specs.append({"name": "secondary", "transform": "eq", "field": "injury_secondary_present", "value": 1})
    return specs


def feature_value(spec, row):
    """One spec against one row. THE GOLDEN BLOCK EXISTS BECAUSE THIS FUNCTION EXISTS TWICE -- here
    and in src/inseason/injuryHorizon.ts. It is not duplication to be removed; it is the only way the
    two sides are independent enough for the comparison to mean anything."""
    t = spec["transform"]
    raw = row.get(spec["field"])
    if t == "eq":
        return 1.0 if raw == spec["value"] else 0.0
    if t == "not_in":
        return 0.0 if raw in spec["values"] else 1.0
    if raw is None:
        return float(spec.get("missing", 0.0))
    x = float(raw)
    if spec.get("clipLo") is not None:
        x = max(float(spec["clipLo"]), x)
    if spec.get("clipHi") is not None:
        x = min(float(spec["clipHi"]), x)
    if t == "clip":
        return x
    if t == "center":
        s = float(spec.get("scale", 1.0))
        return float(spec.get("missing", 0.0)) if s == 0 else (x - float(spec.get("center", 0.0))) / s
    return float(spec.get("missing", 0.0))


def design(rows, specs):
    return np.array([[feature_value(s, r) for s in specs] for r in rows], dtype=float)


# ==================================================================================================
# FITTING
# ==================================================================================================

def log_loss(y, p, eps=1e-12):
    p = np.clip(np.asarray(p, dtype=float), eps, 1 - eps)
    y = np.asarray(y, dtype=float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y, p):
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y, dtype=float)) ** 2))


def fit_head(rows, specs, k, seasons_in_train):
    """One horizon. Rows whose target is NULL (fewer than k games remain) are DROPPED, not imputed:
    they are censored, and calling a censored row a zero would teach the model that the end of a
    season heals people."""
    use = [r for r in rows if r["miss_next_%d" % k] is not None]
    if len(use) < 200:
        return None, 0
    X = design(use, specs)
    y = np.array([r["miss_next_%d" % k] for r in use], dtype=float)
    if len(set(y.tolist())) < 2:
        return None, 0
    c = choose_c(use, specs, k, seasons_in_train)
    from sklearn.linear_model import LogisticRegression
    m = LogisticRegression(C=c, max_iter=2000, solver="lbfgs")
    m.fit(X, y)
    coef = {"intercept": float(m.intercept_[0]), "_C": c}
    for i, s in enumerate(specs):
        coef[s["name"]] = float(m.coef_[0][i])
    return coef, len(use)


def choose_c(rows, specs, k, seasons_in_train):
    """FORWARD-CHAINING BY SEASON, not a shuffled k-fold. One episode contributes up to four rows and
    a shuffled split puts them on both sides, which makes every C look good and picks the least
    regularised one. With fewer than three training seasons there is nothing to chain and the middle
    of the grid is used, which is stated rather than silently defaulting to sklearn's C=1."""
    from sklearn.linear_model import LogisticRegression
    grid = [0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
    ss = sorted(set(seasons_in_train))
    if len(ss) < 3:
        return 0.3
    folds = []
    for i in range(max(1, len(ss) - 3), len(ss)):
        tr = [r for r in rows if r["season"] in ss[:i]]
        te = [r for r in rows if r["season"] == ss[i]]
        if len(tr) >= 200 and len(te) >= 50:
            folds.append((tr, te))
    if not folds:
        return 0.3
    best, best_ll = grid[len(grid) // 2], None
    for c in grid:
        tot, n = 0.0, 0
        for tr, te in folds:
            Xtr, ytr = design(tr, specs), np.array([r["miss_next_%d" % k] for r in tr], dtype=float)
            if len(set(ytr.tolist())) < 2:
                continue
            m = LogisticRegression(C=c, max_iter=2000, solver="lbfgs")
            m.fit(Xtr, ytr)
            Xte, yte = design(te, specs), np.array([r["miss_next_%d" % k] for r in te], dtype=float)
            p = m.predict_proba(Xte)[:, 1]
            tot += log_loss(yte, p) * len(te)
            n += len(te)
        if n and (best_ll is None or tot / n < best_ll):
            best, best_ll = c, tot / n
    return best


def predict(coef, specs, row):
    lin = coef.get("intercept", 0.0)
    for s in specs:
        lin += coef.get(s["name"], 0.0) * feature_value(s, row)
    return 1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, lin))))


# ==================================================================================================
# THE ARTIFACT
# ==================================================================================================

def build_artifact(rows, seasons, holdout, args):
    specs = build_specs(rows)
    coef, ns, base = {}, {}, {}
    des_specs = [s for s in specs if s["name"].startswith("des_")]
    for k in HORIZONS:
        c, n = fit_head(rows, specs, k, seasons)
        if c is None:
            raise SystemExit("horizon k=%d has too few usable rows to fit" % k)
        coef[str(k)] = c
        ns[str(k)] = n
        b, _ = fit_head(rows, des_specs, k, seasons)
        base[str(k)] = b
    a = {
        "schema": SCHEMA,
        "kind": "injury_duration",
        "fittedFrom": "tools/train_injury_duration.py",
        "fittedAt": date.today().isoformat(),
        "seasons": sorted(set(seasons)),
        "holdoutSeason": holdout,
        "horizons": HORIZONS,
        "features": specs,
        "coef": coef,
        "baselineDesignation": base,
        "baselineFeatures": des_specs,
        "trainRows": ns,
        "notes": args.notes or "",
    }
    a["golden"] = golden_rows(a)
    return a


def golden_rows(a):
    """Six fixtures, chosen to be where two implementations disagree: an unseen injury string (which
    must land on inj_other rather than on the reference category), a NULL age, a value outside the
    winsorising range, and a practice-only row with no designation at all."""
    fixtures = [
        {"designation": "Out", "practice_status": "DNP", "injury_group": "achilles", "pos": "RB",
         "weeks_missed_so_far": 2, "weeks_in_episode": 3, "prior_episodes_same": 1,
         "prior_episodes_any": 2, "age": 28.4, "injury_secondary_present": 0},
        {"designation": "Questionable", "practice_status": "Limited", "injury_group": "hamstring",
         "pos": "WR", "weeks_missed_so_far": 0, "weeks_in_episode": 0, "prior_episodes_same": 0,
         "prior_episodes_any": 0, "age": 24.0, "injury_secondary_present": 1},
        {"designation": "Out", "practice_status": "DNP", "injury_group": "concussion", "pos": "QB",
         "weeks_missed_so_far": 1, "weeks_in_episode": 1, "prior_episodes_same": 2,
         "prior_episodes_any": 3, "age": 33.7, "injury_secondary_present": 0},
        # an injury string this artifact never saw -- it MUST become inj_other, not the base level
        {"designation": "Doubtful", "practice_status": "DNP", "injury_group": "unicorn-horn",
         "pos": "TE", "weeks_missed_so_far": 0, "weeks_in_episode": 2, "prior_episodes_same": 0,
         "prior_episodes_any": 1, "age": None, "injury_secondary_present": 0},
        # practice-only: no designation at all, and every numeric past its winsorising bound
        {"designation": "", "practice_status": "DNP", "injury_group": "knee", "pos": "RB",
         "weeks_missed_so_far": 99, "weeks_in_episode": 99, "prior_episodes_same": 99,
         "prior_episodes_any": 99, "age": 61.0, "injury_secondary_present": 0},
        # everything optional missing
        {"designation": "Probable", "practice_status": "", "injury_group": "", "pos": "WR"},
    ]
    out = []
    for fx in fixtures:
        expect = {str(k): predict(a["coef"][str(k)], a["features"], fx) for k in HORIZONS}
        out.append({"f": dict(fx), "expect": expect})
    return out


# ==================================================================================================
# NESTED EVALUATION
# ==================================================================================================

def reliability(y, p, bins=5):
    y, p = np.asarray(y, dtype=float), np.asarray(p, dtype=float)
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    edges[0], edges[-1] = -1e-9, 1 + 1e-9
    out = []
    for i in range(bins):
        m = (p > edges[i]) & (p <= edges[i + 1])
        if m.sum() == 0:
            continue
        out.append({"lo": float(edges[i]), "hi": float(edges[i + 1]), "n": int(m.sum()),
                    "predicted": float(p[m].mean()), "observed": float(y[m].mean())})
    return out


def nested(db, all_rows, seasons, holdouts, vm, ablate=None):
    """One artifact per held-out season, fitted on seasons STRICTLY BEFORE it, scored on it. Both
    baselines are produced by the same loop so a difference between them and the model cannot be a
    difference between two harnesses."""
    del db
    acc = {k: {"y": [], "model": [], "des": [], "tier": []} for k in HORIZONS}
    per_season = []
    for h in holdouts:
        train = [r for r in all_rows if r["season"] < h]
        test = [r for r in all_rows if r["season"] == h]
        tr_seasons = sorted(set(r["season"] for r in train))
        if len(tr_seasons) < 3 or not test:
            continue
        specs = build_specs(train)
        des_specs = [s for s in specs if s["name"].startswith("des_")]
        # ABLATION, for asking what a BLOCK of features is worth rather than what the whole model
        # is worth. It drops columns from the CHALLENGER only; the two baselines are untouched, so
        # the ablated run is comparable to the full one row for row.
        if ablate:
            specs = [s for s in specs if not any(s["name"].startswith(p) for p in ablate)]
        row = {"season": h, "n": len(test)}
        for k in HORIZONS:
            c, _ = fit_head(train, specs, k, tr_seasons)
            b, _ = fit_head(train, des_specs, k, tr_seasons)
            if c is None or b is None:
                continue
            use = [r for r in test if r["miss_next_%d" % k] is not None]
            if not use:
                continue
            y = [r["miss_next_%d" % k] for r in use]
            pm = [predict(c, specs, r) for r in use]
            pd_ = [predict(b, des_specs, r) for r in use]
            pt = [1.0 - (1.0 - miss_prob(vm, r["pos"], r["pool_rank_frac"])) ** k for r in use]
            acc[k]["y"] += y
            acc[k]["model"] += pm
            acc[k]["des"] += pd_
            acc[k]["tier"] += pt
            row["k%d" % k] = {"n": len(use), "model": log_loss(y, pm),
                              "des": log_loss(y, pd_), "tier": log_loss(y, pt)}
        per_season.append(row)
    pooled = {}
    for k in HORIZONS:
        a = acc[k]
        if not a["y"]:
            continue
        pooled[k] = {
            "n": len(a["y"]), "base_rate": float(np.mean(a["y"])),
            "model_ll": log_loss(a["y"], a["model"]), "des_ll": log_loss(a["y"], a["des"]),
            "tier_ll": log_loss(a["y"], a["tier"]),
            "model_brier": brier(a["y"], a["model"]), "des_brier": brier(a["y"], a["des"]),
            "tier_brier": brier(a["y"], a["tier"]),
            "reliability_model": reliability(a["y"], a["model"]),
            "reliability_des": reliability(a["y"], a["des"]),
        }
    return pooled, per_season


# ==================================================================================================

def parse_seasons(s):
    parts = s.split("-")
    lo = int(parts[0])
    hi = int(parts[1]) if len(parts) > 1 else lo
    return list(range(lo, hi + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--seasons", default="2010-2024")
    ap.add_argument("--holdout-season", default="none")
    ap.add_argument("--out", default="data/injury-duration-artifact.json")
    ap.add_argument("--variance-model", default="data/variance-model.json")
    ap.add_argument("--nested", action="store_true",
                    help="run the nested evaluation over --nested-holdouts and print the table")
    ap.add_argument("--nested-holdouts", default="2015-2024")
    ap.add_argument("--nested-out", default="data/injury-duration-nested.json")
    ap.add_argument("--ablate", default="",
                    help="comma-separated feature-name PREFIXES to drop from the challenger only, "
                         "e.g. 'inj_' to ask what the injury type is worth")
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    seasons = parse_seasons(args.seasons)
    holdout = None if args.holdout_season == "none" else int(args.holdout_season)
    rows = load_rows(args.db, seasons)
    if not rows:
        raise SystemExit("no rows in feat_injury_horizon for %s -- run `ff build-injury-horizon`" % args.seasons)
    print("loaded %d horizon rows over %d seasons" % (len(rows), len(set(r["season"] for r in rows))))

    if args.nested:
        vm = load_variance_model(args.variance_model)
        holdouts = parse_seasons(args.nested_holdouts)
        ablate = [p for p in args.ablate.split(",") if p]
        pooled, per_season = nested(args.db, rows, seasons, holdouts, vm, ablate)
        print("\nNESTED BY SEASON -- trained on seasons STRICTLY BEFORE each holdout, pooled %s%s"
              % (args.nested_holdouts, ("   ABLATED: " + ",".join(ablate)) if ablate else ""))
        print("  k    n      base    model LL   designation LL   tier LL    gain vs des   gain vs tier")
        for k in HORIZONS:
            if k not in pooled:
                continue
            p = pooled[k]
            print("  %d  %5d   %6.3f    %8.5f   %12.5f   %8.5f   %10.5f   %10.5f" % (
                k, p["n"], p["base_rate"], p["model_ll"], p["des_ll"], p["tier_ll"],
                p["des_ll"] - p["model_ll"], p["tier_ll"] - p["model_ll"]))
        print("\n  Brier, same rows:")
        for k in HORIZONS:
            if k not in pooled:
                continue
            p = pooled[k]
            print("  %d   model %.5f   designation %.5f   tier %.5f" % (
                k, p["model_brier"], p["des_brier"], p["tier_brier"]))
        for k in (1, 4):
            if k not in pooled:
                continue
            print("\n  RELIABILITY, k=%d, model (quintiles of the predicted probability):" % k)
            print("    bin        n   predicted   observed")
            for b in pooled[k]["reliability_model"]:
                print("    %.2f-%.2f  %5d   %9.3f   %8.3f" % (b["lo"], b["hi"], b["n"], b["predicted"], b["observed"]))
        with open(args.nested_out, "w", encoding="utf-8") as f:
            json.dump({"pooled": {str(k): v for k, v in pooled.items()}, "perSeason": per_season}, f, indent=2)
        print("\nwrote %s" % args.nested_out)
        return

    train = [r for r in rows if holdout is None or r["season"] < holdout]
    a = build_artifact(train, sorted(set(r["season"] for r in train)), holdout, args)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(a, f, indent=2)
    print("wrote %s" % args.out)
    print("  features: %d   golden rows: %d" % (len(a["features"]), len(a["golden"])))
    for k in HORIZONS:
        print("  k=%d  n=%d  C=%.2f  intercept %+.3f" % (
            k, a["trainRows"][str(k)], a["coef"][str(k)]["_C"], a["coef"][str(k)]["intercept"]))
    print("\n  the largest coefficients, k=4 (the horizon the designation cannot carry):")
    c4 = a["coef"]["4"]
    top = sorted([(abs(v), n, v) for n, v in c4.items() if n not in ("intercept", "_C")], reverse=True)[:12]
    for _, n, v in top:
        print("    %-24s %+8.4f" % (n, v))


if __name__ == "__main__":
    sys.exit(main())
