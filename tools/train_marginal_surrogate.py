"""M2i -- train the LEARNED surrogate for the simulated roster marginal. NOTHING HERE SHIPS.

    uv run --with scikit-learn --with numpy tools/train_marginal_surrogate.py \
        --train <train.jsonl> --out data/marginal-surrogate.candidate.json

WHAT IT FITS. A small MLP from the roster-state + candidate features published by
`src/draft/marginalSurrogate.ts` (`SURROGATE_FEATURE_FIELDS`) to the SIMULATED marginal in
percentage points of P(playoffs) -- the quantity `src/draft/rosterMarginal.ts` measures properly and
`src/draft/lineupMarginal.ts` approximates badly (Track G: rank correlation -0.29 after six buys).

THE CONTRACT WITH THE SERVE PATH is the projector's, and three parts of it are load-bearing:

  1. The feature ORDER is the consumer's published list, carried on the artifact and checked at
     load. A weight vector applied to a permuted design matrix scores plausibly and means nothing.
  2. The artifact carries the STANDARDISER. Fitting a scaler here and re-deriving one at serve time
     is the classic half-shipped model: both sides look right and the predictions are garbage.
  3. The artifact carries a GOLDEN BLOCK -- scikit-learn's own `predict()` for five fixture rows, in
     the target's units. The TypeScript walker is checked against THIS PRODUCER at load, never
     against a second implementation of itself.

THE HOLDOUT IS BY SEASON, always. Sixty candidates from one roster state share a budget curve, a
baseline and a set of random numbers; a random row split would put the same simulation on both sides
and report its own leakage as skill. Model selection uses the LAST TWO TRAINING SEASONS as an inner
validation set (never the scoring seasons), and the final model is refitted on all training seasons.

DEGENERATE STATES ARE EXCLUDED FROM THE FIT BY DEFAULT and the count is printed. A state whose
simulated book is flat at $0 across all sixty candidates measures the Monte Carlo floor, not the
marginal; 60 zero labels per such state teaches the model to answer zero. `--keep-degenerate` puts
them back, so the choice is a flag rather than a silence.
"""
import argparse
import json
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler


def load(paths, keep_degenerate):
    X, Y, season, state_id, pos, vor_rank = [], [], [], [], [], []
    n_states = n_drop = 0
    for path in paths:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                st = json.loads(line)
                n_states += 1
                if st["degenerate"] and not keep_degenerate:
                    n_drop += 1
                    continue
                sid = "%s|%s|%s|%s" % (st["season"], st["strategy"], st["seed"], st["buys"])
                for r in st["rows"]:
                    X.append(r["x"])
                    Y.append(r["y"])
                    season.append(st["season"])
                    state_id.append(sid)
                    pos.append(r["pos"])
                    vor_rank.append(r["vorRank"])
    return (np.asarray(X, dtype=float), np.asarray(Y, dtype=float),
            np.asarray(season), np.asarray(state_id), np.asarray(pos),
            np.asarray(vor_rank), n_states, n_drop)


def rank(a):
    order = np.argsort(a, kind="mergesort")
    r = np.empty(len(a), dtype=float)
    i = 0
    while i < len(a):
        j = i
        while j + 1 < len(a) and a[order[j + 1]] == a[order[i]]:
            j += 1
        r[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return r


def pearson(a, b):
    if len(a) < 3:
        return float("nan")
    a = a - a.mean()
    b = b - b.mean()
    da, db = np.sqrt((a * a).sum()), np.sqrt((b * b).sum())
    if da <= 0 or db <= 0:
        return float("nan")
    return float((a * b).sum() / (da * db))


def mean_state_rho(y, yhat, state_id):
    """Mean of the PER-STATE rank correlations -- never a pooled one.

    Pooling across states mixes the level differences BETWEEN states into a statistic that exists to
    measure a within-state ordering, which is the mistake `scripts/marginal-agreement.mjs` names in
    its own tables. A state with fewer than three rows cannot produce one and is skipped rather than
    counted as agreement."""
    out = []
    for sid in np.unique(state_id):
        m = state_id == sid
        if m.sum() < 3:
            continue
        r = pearson(rank(y[m]), rank(yhat[m]))
        if np.isfinite(r):
            out.append(r)
    return (float(np.mean(out)) if out else float("nan")), len(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep-degenerate", action="store_true")
    ap.add_argument("--shuffle-labels", action="store_true",
                    help="FAULT INJECTION: permute the target WITHIN each state. A pipeline that "
                         "still scores well is measuring its own feature structure, not the marginal.")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--features", default="src/draft/marginalSurrogate.ts",
                    help="only used for the error message; the names come from the data file's meta")
    ap.add_argument("--feature-names", required=True,
                    help="JSON file carrying the published feature list (the data script's .meta.json)")
    args = ap.parse_args()

    names = json.load(open(args.feature_names, "r", encoding="utf-8"))["features"]

    X, Y, season, state_id, pos, vor_rank, n_states, n_drop = load(args.train, args.keep_degenerate)
    if X.shape[1] != len(names):
        sys.exit("feature width %d does not match the published list (%d)" % (X.shape[1], len(names)))
    print("train: %d states read, %d dropped as degenerate, %d rows, %d features"
          % (n_states, n_drop, len(Y), X.shape[1]))
    print("seasons: %s" % (sorted(set(season.tolist())),))

    rng = np.random.default_rng(args.seed)
    if args.shuffle_labels:
        for sid in np.unique(state_id):
            m = state_id == sid
            Y[m] = rng.permutation(Y[m])
        print("FAULT INJECTION: labels permuted within every state")

    # INNER VALIDATION BY SEASON -- the last two training seasons. Never the scoring seasons.
    seasons_sorted = sorted(set(season.tolist()))
    val_seasons = set(seasons_sorted[-2:])
    tr = np.array([s not in val_seasons for s in season])
    va = ~tr
    print("inner validation seasons: %s  (%d train rows, %d val rows)"
          % (sorted(val_seasons), tr.sum(), va.sum()))

    scaler = StandardScaler().fit(X[tr])
    y_mean, y_scale = float(Y[tr].mean()), float(Y[tr].std() or 1.0)

    grid = [
        ((64, 32), 1e-3), ((64, 32), 1e-2), ((128, 64), 1e-3),
        ((128, 64), 1e-2), ((32,), 1e-3), ((256, 128, 64), 1e-2),
    ]
    best = None
    for hidden, alpha in grid:
        m = MLPRegressor(hidden_layer_sizes=hidden, activation="relu", alpha=alpha,
                         solver="adam", learning_rate_init=1e-3, batch_size=256,
                         max_iter=400, early_stopping=True, n_iter_no_change=20,
                         validation_fraction=0.1, random_state=args.seed)
        m.fit(scaler.transform(X[tr]), (Y[tr] - y_mean) / y_scale)
        pv = m.predict(scaler.transform(X[va])) * y_scale + y_mean
        rho, ns = mean_state_rho(Y[va], pv, state_id[va])
        mae = float(np.mean(np.abs(pv - Y[va])))
        print("  hidden=%-16s alpha=%-7g  inner-val mean state rho %.4f (%d states)  MAE %.4f"
              % (str(hidden), alpha, rho, ns, mae))
        # SELECTION IS ON THE ORDERING, stated before the numbers: H1 is a rank correlation, so the
        # model is chosen on the inner-validation rank correlation and not on MAE. Choosing on MAE
        # here is exactly the mistake Track G's calibration selection rule was written to avoid --
        # least squares with little magnitude signal collapses every price toward one number.
        if best is None or (np.isfinite(rho) and rho > best[0]):
            best = (rho, hidden, alpha)
    print("selected: hidden=%s alpha=%g (inner-val rho %.4f)" % (best[1], best[2], best[0]))

    # REFIT ON EVERY TRAINING SEASON with the selected shape. The scaler is refitted too, on the same
    # rows the final model sees -- a scaler fitted on a subset of the final training data is a second,
    # silent train/serve skew.
    scaler = StandardScaler().fit(X)
    y_mean, y_scale = float(Y.mean()), float(Y.std() or 1.0)
    model = MLPRegressor(hidden_layer_sizes=best[1], activation="relu", alpha=best[2],
                         solver="adam", learning_rate_init=1e-3, batch_size=256,
                         max_iter=400, early_stopping=True, n_iter_no_change=20,
                         validation_fraction=0.1, random_state=args.seed)
    model.fit(scaler.transform(X), (Y - y_mean) / y_scale)
    fit_pred = model.predict(scaler.transform(X)) * y_scale + y_mean
    rho_in, ns_in = mean_state_rho(Y, fit_pred, state_id)
    print("in-sample mean state rho %.4f (%d states) -- reported as a FIT statistic, not validation"
          % (rho_in, ns_in))

    # THE GOLDEN BLOCK: five RAW feature rows and scikit-learn's OWN prediction in the target's units,
    # taken through the exact pipeline the walker must reproduce. Rows are spread across the data
    # rather than taken from the head, so a walker that is right about one corner of feature space
    # cannot pass.
    idx = np.linspace(0, len(X) - 1, 5).astype(int)
    golden = []
    for i in idx:
        xi = X[i]
        yi = float(model.predict(scaler.transform(xi.reshape(1, -1)))[0] * y_scale + y_mean)
        golden.append({"x": [float(v) for v in xi], "y": yi})

    layers = [{"w": [[float(v) for v in row] for row in c], "b": [float(v) for v in b]}
              for c, b in zip(model.coefs_, model.intercepts_)]

    art = {
        "schema": 1,
        "kind": "marginal-surrogate",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "notes": ("M2i candidate. Trained on the SIMULATED roster marginal (playoffs pp) from "
                  "scripts/marginal-surrogate-data.mjs. NOT SHIPPED; read only behind "
                  "FF_V3_MARGINAL=learned." + (" SHUFFLED-LABEL FAULT INJECTION." if args.shuffle_labels else "")),
        "target": "playoffs_pp",
        "features": names,
        "xMean": [float(v) for v in scaler.mean_],
        "xScale": [float(v if v else 1.0) for v in scaler.scale_],
        "yMean": y_mean,
        "yScale": y_scale,
        "activation": "relu",
        "layers": layers,
        "golden": golden,
        "meta": {
            "trainSeasons": seasons_sorted,
            "innerValSeasons": sorted(val_seasons),
            "states": int(n_states), "degenerateDropped": int(n_drop), "rows": int(len(Y)),
            "hidden": list(best[1]), "alpha": best[2],
            "innerValStateRho": best[0], "inSampleStateRho": rho_in,
            "shuffledLabels": bool(args.shuffle_labels),
            "nIter": int(model.n_iter_),
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(art, fh)
    print("wrote %s (%d layers, %s)" % (args.out, len(layers), best[1]))


if __name__ == "__main__":
    main()
