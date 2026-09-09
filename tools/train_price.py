"""Fit a price model of THIS room, from the picks this room actually made.

    uv run --with scikit-learn --with numpy tools/train_price.py \
        --db data/ff.db --out data/price-model.json [--holdout-season 2024]

WHAT THIS IS FOR.

Every opponent model in this repo has been a guess with a calibration bolted on afterwards. The
default `vor` book prices players with OUR OWN valuation function, which makes the field a noisy copy
of us -- the self-reference that hid the FLEX-baseline bug for months. The `rank` book is
structurally independent but its shape is an exponential decay whose steepness was tuned until the
simulated price distribution looked like the real one. Neither was FITTED on what the room paid.

`fact_draft_pick` holds 738 real picks across 2022-2025 with the market consensus as it stood.
That is a training set, and this is the model.

THE FORM: A HURDLE, BECAUSE THE $1 MASS IS THE DISTRIBUTION'S DOMINANT FEATURE.

61% of this room's picks go for $1-5 and the modal price is exactly $1. A single regression on price
-- or on log price -- treats that spike as the low tail of a smooth distribution and shaves it off,
which is precisely the region where a draft is won or lost (a $1 bid that should have been $1 costs
nothing; a $4 bid that should have been $1 costs a bench player). So two parts:

    hurdle   logistic: will this player go for more than $1 at all?
    level    log-linear on the share of the room's money, GIVEN that he does.

and the prediction recombines them, so a player the model thinks is 80% likely to go for $1 is
priced near $1 rather than at 0.8 x his conditional level.

PRICE IS MODELLED AS A SHARE OF THE ROOM'S MONEY, never in dollars. 2022-2024 were 14-team leagues
with 13 roster slots and 2025 is 16 x 12, so the same player is worth a different number of dollars
in each -- $2,800 of league money against $3,200, and thirteen slots to fill against twelve. Fitting
dollars would make the model learn the league's size along with its taste, and the size is the one
thing we already know. Dollars come back at the very end, by multiplying by the target room's money.

WHAT IT SEES, AND WHY EACH ONE IS AVAILABLE AT BID TIME.

  log_rank       the consensus POSITIONAL rank at the draft, logged. The market's own opinion.
  log_rank_sq    its square. Without it the fit is a straight line in log rank, which extrapolates
                 to a rank-1 price of $192 in a room whose top price has never exceeded $106 -- the
                 curve genuinely flattens at the very top and a log-linear form cannot bend
  no_consensus   he was not ranked at all -- a real state, and a cheap one
  sd_rel         expert dispersion relative to his rank: disagreement, scaled
  money_left     the share of the room's money still unspent. Inflation, measured
  slots_left     the share of roster slots still open. Scarcity, measured
  pick_share     how far into the draft it is. The two above cannot separate early from late

Every one of them is a quantity the simulator can compute mid-auction, which is the point: a price
model that needs anything else is a description rather than an opponent.

THE SEAM IS THE SAME ONE THE PROJECTION ARTIFACT USES -- a schema-validated artifact with a GOLDEN
BLOCK carrying this script's own predictions for fixture rows, recomputed by the TypeScript evaluator
at 1e-6. A producer that ships its own validator grades its own homework and passes forever.
"""

import argparse
import json
import math
import sqlite3
import sys
from datetime import date

import numpy as np

SCHEMA = 1
BUDGET = 200                     # dollars per team, every season this room has played
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]
# The rank a player with no consensus is treated as having. Not a guess dressed as data: the
# indicator beside it lets the fit decide what unranked actually means, and this only sets the scale.
UNRANKED = 80.0
# The rank table runs to here; anything deeper (and anything unranked) reads its last row.
RANK_TABLE_MAX = 80
# Ridge strength, chosen by leave-one-SEASON-out inside the training seasons.
ALPHAS = [0.1, 1.0, 10.0, 100.0]

# THE MARKET-STATE FEATURES ARE CONFOUNDED WITH THE PLAYER, and the confounding is not subtle.
# Expensive players are nominated EARLY, so `pick_share`, `money_left` and `slots_left` each carry a
# large share of "how good is he" on top of "where are we in the draft". Fitted with all three, the
# model prices the consensus RB1 at $101 when he is nominated first and at $2.70 when he is
# nominated late -- a room in which a superstar put up in the last hour goes for pocket change. That
# is a description of this room's NOMINATION HABITS wearing the costume of a price model, and as an
# OPPONENT it is unusable: a simulator nominates in its own order, not in this room's.
#
# `infl` is the market-state quantity that is NOT mechanically tied to draft progress: money left per
# remaining slot, over the same ratio at the start. It is exactly 1 at the first pick by
# construction, rises when the room has been stingy and falls when it has been loose, and it is the
# standard auction inflation figure. WHICH SET TO FIT IS CHOSEN BY MEASUREMENT --
# scripts/price-loso.mjs runs all three against the two existing books -- rather than argued here.
#
# THE QUADRATIC IN log_rank IS ALSO A CHOICE, and it is not free. It buys curvature at the very top
# -- a straight line in log rank extrapolates the consensus RB1 to $192 in a room whose highest bid
# ever was $106 -- and it costs MONOTONICITY: a per-position parabola fitted on 76-253 rows can and
# does come back with RB12 above RB1, which is the ordering the whole book exists to express,
# inverted. Both variants are fitted and both are measured; `scripts/price-loso.mjs` reports the
# out-of-sample MAE and the face-validity check below reports whether the curve still falls.
FEATURE_SETS = {
    "none": ["log_rank", "no_consensus", "sd_rel"],
    "inflation": ["log_rank", "no_consensus", "sd_rel", "infl"],
    "quad": ["log_rank", "log_rank_sq", "no_consensus", "sd_rel", "infl"],
    "full": ["log_rank", "log_rank_sq", "no_consensus", "sd_rel", "infl",
             "money_left", "slots_left", "pick_share"],
}
FEATURES = FEATURE_SETS["inflation"]
# Which features carry a PER-POSITION slope. The rank-to-price curve is genuinely different at each
# position -- a QB3 and an RB3 are not the same purchase in this room -- while the market-state
# terms describe the room and are shared, which is also all the data can support at 58-253 rows a
# position.
PER_POS = {"log_rank", "log_rank_sq", "no_consensus"}


def load_picks(db_path):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        "SELECT season, team_name, name, pos, price, pick_order,"
        " consensus_pos_rank_asof AS ecr, consensus_sd_asof AS sd"
        " FROM fact_draft_pick ORDER BY season, pick_order")]
    con.close()
    return rows


def build(rows):
    """One design row per pick, with the market state AS IT STOOD when that pick was made.

    `pick_order` is dense-ranked within the season rather than used as given: three of the four
    recaps carry one pick whose order parses as a four-digit number (8649, 5149, 9149), which is a
    scrape artefact. Ranking is immune to it and to any future one; using the raw value would put a
    single pick at 4700% of the way through its own draft.
    """
    by_season = {}
    for r in rows:
        by_season.setdefault(r["season"], []).append(r)
    out = []
    meta = {}
    for season, picks in by_season.items():
        picks.sort(key=lambda r: r["pick_order"])
        teams = len({r["team_name"] for r in picks})
        n = len(picks)
        league_money = teams * BUDGET
        total_slots = n
        meta[season] = {"teams": teams, "picks": n, "leagueMoney": league_money,
                        "spent": sum(r["price"] for r in picks)}
        spent = 0
        for k, r in enumerate(picks):
            ecr = r["ecr"]
            has = ecr is not None and ecr > 0
            sd = r["sd"]
            out.append({
                "season": season, "pos": r["pos"], "name": r["name"], "price": float(r["price"]),
                "leagueMoney": float(league_money),
                "rank": float(ecr) if has else None,
                "share": float(r["price"]) / league_money,
                "f": {
                    "log_rank": math.log(float(ecr) if has else UNRANKED),
                    "log_rank_sq": math.log(float(ecr) if has else UNRANKED) ** 2,
                    "no_consensus": 0.0 if has else 1.0,
                    "sd_rel": (float(sd) / float(ecr)) if (has and sd is not None and ecr > 0) else 0.0,
                    "money_left": (league_money - spent) / league_money,
                    "slots_left": (total_slots - k) / total_slots,
                    "pick_share": k / total_slots,
                    "infl": min(5.0, ((league_money - spent) / league_money)
                                / max(1e-9, (total_slots - k) / total_slots)),
                },
            })
            spent += r["price"]
    return out, meta


def specs_from(rows):
    """Centre and scale every feature on the TRAINING rows, and write the constants onto the
    artifact. A consumer that recomputes them is a consumer that can disagree with the fit."""
    specs = []
    for name in FEATURES:
        vals = [r["f"][name] for r in rows]
        mu, sd = float(np.mean(vals)), float(np.std(vals))
        specs.append({"name": name, "center": mu, "scale": sd if sd > 1e-9 else 1.0, "missing": 0.0})
    return specs


def design(rows, specs):
    X = np.zeros((len(rows), len(specs)))
    for i, r in enumerate(rows):
        for j, s in enumerate(specs):
            v = r["f"].get(s["name"])
            X[i, j] = s["missing"] if v is None else (v - s["center"]) / s["scale"]
    return X


def fit(rows, specs, alpha_h, alpha_l):
    """Per-position intercepts and rank slopes, shared market-state slopes.

    Implemented as ONE design with position-blocked columns rather than six separate fits: a shared
    slope has to be estimated on all 738 rows or it is not shared, and fitting six models and
    averaging their market-state terms is a different estimator that happens to look similar.
    """
    from sklearn.linear_model import LogisticRegression, Ridge

    idx = {s["name"]: j for j, s in enumerate(specs)}
    per_pos = [n for n in FEATURES if n in PER_POS]
    shared = [n for n in FEATURES if n not in PER_POS]
    # columns: [pos dummies] + [pos x per_pos] + [shared]
    cols = []
    for p in POSITIONS:
        cols.append(("intercept", p))
    for p in POSITIONS:
        for n in per_pos:
            cols.append((n, p))
    for n in shared:
        cols.append((n, None))

    X0 = design(rows, specs)
    X = np.zeros((len(rows), len(cols)))
    for i, r in enumerate(rows):
        for c, (name, pos) in enumerate(cols):
            if pos is not None and r["pos"] != pos:
                continue
            X[i, c] = 1.0 if name == "intercept" else X0[i, idx[name]]

    y_h = np.array([1.0 if r["price"] > 1 else 0.0 for r in rows])
    hurdle_coef = np.zeros(len(cols))
    if 0 < y_h.sum() < len(y_h):
        lr = LogisticRegression(C=1.0 / alpha_h, fit_intercept=False, max_iter=5000)
        lr.fit(X, y_h)
        hurdle_coef = lr.coef_[0]

    above = [i for i, r in enumerate(rows) if r["price"] > 1]
    y_l = np.array([math.log(rows[i]["share"] * 1000.0) for i in above])
    ridge = Ridge(alpha=alpha_l, fit_intercept=False).fit(X[above], y_l)
    level_coef = ridge.coef_
    # DUAN SMEARING, not exp(sigma^2/2). The residuals of a log fit on 400 rows are not Gaussian --
    # this room's prices are lumpy at round numbers -- and the parametric correction is a claim about
    # a shape nobody checked. The smearing estimate is the mean of exp(residual), which is the same
    # correction computed from the residuals themselves.
    resid = y_l - X[above] @ level_coef
    smear = float(np.mean(np.exp(resid)))

    raw = {}
    for p in POSITIONS:
        h, l = {}, {}
        for c, (name, pos) in enumerate(cols):
            if pos is not None and pos != p:
                continue
            key = "intercept" if name == "intercept" else name
            h[key] = h.get(key, 0.0) + float(hurdle_coef[c])
            l[key] = l.get(key, 0.0) + float(level_coef[c])
        for n in FEATURES:
            h.setdefault(n, 0.0)
            l.setdefault(n, 0.0)
        raw[p] = {"hurdle": h, "level": l}

    # ---- THE RANK EFFECT BECOMES A MONOTONE TABLE, not a polynomial -----------------------------
    #
    # A per-position parabola in log rank fitted on 58-253 picks does not stay monotone: it came back
    # with the RB3 above the RB1 and the K60 above the K1. A price book in which a worse-ranked
    # player costs more inverts the ordering the entire auction expresses, and no residual statistic
    # can see it -- MAE was the best of any variant while the curve was upside down.
    #
    # So the fitted rank terms are EVALUATED onto a table over ranks 1..RANK_TABLE_MAX and then
    # repaired by a cumulative min, exactly as src/data/projections.ts repairs the projection curve
    # and for the same reason: the repair never invents a value, it only refuses to let the curve
    # climb. Everything else stays a coefficient. The table also removes the extrapolation problem
    # at rank 1 by construction, because there is nothing left to extrapolate.
    tables, coef = {}, {}
    rank_terms = [n for n in FEATURES if n in ("log_rank", "log_rank_sq")]
    idx_specs = {s["name"]: s for s in specs}
    for p in POSITIONS:
        tbl = {}
        for head in ("hurdle", "level"):
            c = raw[p][head]
            vals = []
            for rk in range(1, RANK_TABLE_MAX + 1):
                t = c.get("intercept", 0.0)
                for n in rank_terms:
                    v = math.log(rk) if n == "log_rank" else math.log(rk) ** 2
                    s = idx_specs[n]
                    t += c.get(n, 0.0) * ((v - s["center"]) / s["scale"])
                vals.append(t)
            for i in range(1, len(vals)):
                if vals[i] > vals[i - 1]:
                    vals[i] = vals[i - 1]
            tbl[head] = [round(v, 6) for v in vals]
        tables[p] = tbl
        coef[p] = {head: {n: raw[p][head].get(n, 0.0) for n in FEATURES if n not in rank_terms}
                   for head in ("hurdle", "level")}
    return coef, tables, smear


def rank_index(artifact, rank):
    """Where a rank reads on the rank table. Unranked and anything past the table's end read its last
    row, which is the same carry-the-last-value rule the projection curve uses."""
    n = None
    for v in artifact["rankTable"].values():
        n = len(v["level"])
        break
    if not n:
        return 0
    if rank is None or rank < 1:
        return n - 1
    return min(int(round(rank)) - 1, n - 1)


def predict(artifact, row):
    """Predict one pick's price in dollars. Mirrored by evaluatePrice() in src/model/price.ts."""
    tab = artifact["rankTable"].get(row["pos"])
    coef = artifact["coef"].get(row["pos"])
    if tab is None or coef is None:
        return 1.0
    x = {}
    for s in artifact["features"]:
        v = row["f"].get(s["name"])
        x[s["name"]] = s["missing"] if v is None else (v - s["center"]) / s["scale"]
    i = rank_index(artifact, row.get("rank"))

    def lin(head):
        t = tab[head][i]
        c = coef[head]
        for s in artifact["features"]:
            t += c.get(s["name"], 0.0) * x[s["name"]]
        return max(-40.0, min(40.0, t))

    p = 1.0 / (1.0 + math.exp(-lin("hurdle")))
    level_share = math.exp(lin("level")) / 1000.0 * artifact["smear"]
    money = row["leagueMoney"]
    share = p * level_share + (1.0 - p) * (1.0 / money)
    dollars = share * money
    return max(artifact["clamps"]["lo"], min(artifact["clamps"]["hi"] * money, dollars))


def golden_rows(artifact):
    fixtures = [
        {"pos": "RB", "leagueMoney": 3200.0, "rank": 1.0,
         "f": {"no_consensus": 0.0, "sd_rel": 0.5,
               "money_left": 1.0, "slots_left": 1.0, "pick_share": 0.0, "infl": 1.0}},
        {"pos": "WR", "leagueMoney": 2800.0, "rank": 24.0,
         "f": {"no_consensus": 0.0, "sd_rel": 0.2,
               "money_left": 0.5, "slots_left": 0.5, "pick_share": 0.5, "infl": 1.0}},
        {"pos": "QB", "leagueMoney": 3200.0, "rank": 8.0,
         "f": {"no_consensus": 0.0, "sd_rel": 0.3,
               "money_left": 0.7, "slots_left": 0.6, "pick_share": 0.4, "infl": 1.1666666666666667}},
        # Unranked, and deep into a broke room: the row that exercises the rank table's last entry.
        {"pos": "K", "leagueMoney": 3200.0, "rank": None,
         "f": {"no_consensus": 1.0, "sd_rel": 0.0,
               "money_left": 0.05, "slots_left": 0.15, "pick_share": 0.9, "infl": 0.3333333333333333}},
        # Every market-state term at an extreme, to catch a sign flipped on one side.
        {"pos": "TE", "leagueMoney": 2800.0, "rank": 3.0,
         "f": {"no_consensus": 0.0, "sd_rel": 1.5,
               "money_left": 0.02, "slots_left": 0.02, "pick_share": 1.0, "infl": 1.0}},
    ]
    out = []
    for fx in fixtures:
        if fx["pos"] not in artifact["coef"]:
            continue
        out.append({"pos": fx["pos"], "leagueMoney": fx["leagueMoney"], "rank": fx["rank"],
                    "f": fx["f"], "expect": predict(artifact, fx)})
    return out


def choose_alpha(rows, specs):
    """Leave-one-SEASON-out inside the training seasons. Player-picks within a draft share the room's
    mood and its money; a random split leaks between folds and every alpha looks better than it is."""
    seasons = sorted({r["season"] for r in rows})
    if len(seasons) < 2:
        return 1.0, 1.0
    best = (float("inf"), 1.0, 1.0)
    for ah in ALPHAS:
        for al in ALPHAS:
            err, n = 0.0, 0
            for s in seasons:
                tr = [r for r in rows if r["season"] != s]
                te = [r for r in rows if r["season"] == s]
                sp = specs_from(tr)
                coef, tables, smear = fit(tr, sp, ah, al)
                art = {"coef": coef, "rankTable": tables, "features": sp, "smear": smear,
                       "clamps": {"lo": 1.0, "hi": 1.0}}
                for r in te:
                    err += abs(predict(art, r) - r["price"])
                    n += 1
            if n and err / n < best[0]:
                best = (err / n, ah, al)
    return best[1], best[2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--out", default="data/price-model.json")
    ap.add_argument("--holdout-season", default="none")
    # WHICH SEASONS ARE ELIGIBLE AT ALL, before the holdout is removed. `--holdout-season 2020` on a
    # store holding 2018-2026 trains on 2026 as well, which is a later season leaking into an
    # earlier fold -- fine for a genuine holdout, wrong for a leave-one-season-out rotation. So the
    # rotation passes `--seasons 2018-2025` and the pool is stated rather than inferred.
    ap.add_argument("--seasons", default=None, help="lo-hi, inclusive; default every season present")
    ap.add_argument("--alpha-hurdle", type=float, default=None)
    ap.add_argument("--alpha-level", type=float, default=None)
    # The DEFAULT is what ships, so the contract test re-running this script reproduces the shipped
    # model rather than a different variant with the same feature names.
    ap.add_argument("--market-state", default="quad", choices=sorted(FEATURE_SETS.keys()))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    global FEATURES
    FEATURES = FEATURE_SETS[args.market_state]

    picks = load_picks(args.db)
    if not picks:
        sys.exit("train_price: fact_draft_pick is empty -- run `ff build-picks`")
    rows, meta = build(picks)
    if args.seasons:
        parts = [int(x) for x in args.seasons.split("-")]
        lo, hi = parts[0], (parts[1] if len(parts) > 1 else parts[0])
        rows = [r for r in rows if lo <= r["season"] <= hi]
        if not rows:
            sys.exit("train_price: --seasons " + args.seasons + " selects no picks")
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    train = [r for r in rows if holdout is None or r["season"] != holdout]
    if not train:
        sys.exit("train_price: no training rows")

    if args.alpha_hurdle is None or args.alpha_level is None:
        ah, al = choose_alpha(train, specs_from(train))
    else:
        ah, al = args.alpha_hurdle, args.alpha_level

    specs = specs_from(train)
    coef, tables, smear = fit(train, specs, ah, al)
    seasons = sorted({r["season"] for r in train})
    artifact = {
        "schema": SCHEMA,
        "kind": "price",
        "fittedFrom": "tools/train_price.py",
        "fittedAt": date.today().isoformat(),
        "seasons": seasons,
        "holdoutSeason": holdout,
        "budget": BUDGET,
        "unrankedRank": UNRANKED,
        "rankTableMax": RANK_TABLE_MAX,
        "features": [sp for sp in specs if sp["name"] not in ("log_rank", "log_rank_sq")],
        "rankTable": tables,
        "coef": coef,
        "smear": smear,
        "alpha": {"hurdle": ah, "level": al},
        # `hi` is a SHARE of the room's money, not a dollar figure, so the clamp travels between a
        # 14-team and a 16-team league without meaning something different in each.
        "clamps": {"lo": 1.0, "hi": 0.06},
        "seasonMeta": {str(k): v for k, v in meta.items()},
        "marketState": args.market_state,
        "notes": (
            "Hurdle: logistic P(price > $1), then a log-linear model of the share of the room's "
            "money GIVEN price > $1, recombined so the $1 mass is respected. Per-position "
            "intercepts and rank slopes, shared market-state slopes. Duan smearing on the log "
            "retransformation. Alphas by leave-one-season-out inside the training seasons."
        ),
    }
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, indent=2)

    if not args.quiet:
        print("wrote " + args.out)
        print("  train seasons " + ",".join(str(s) for s in seasons) +
              (" holding out " + str(holdout) if holdout else "") +
              "; alpha hurdle " + str(ah) + " level " + str(al) + "; smear " + format(smear, ".4f"))
        for s in seasons:
            m = meta[s]
            print("    " + str(s) + "  " + str(m["teams"]) + " teams  " + str(m["picks"]) +
                  " picks  $" + str(m["spent"]) + " of $" + str(m["leagueMoney"]))
        print("  pos   n     rank table at 1 / 12 / 60 (hurdle | level)   shared coefficients")
        for p in POSITIONS:
            sub = [r for r in train if r["pos"] == p]
            if not sub or p not in tables:
                continue
            t = tables[p]
            terms = ", ".join(k + " " + format(v, "+.3f") for k, v in coef[p]["level"].items())
            print("  " + p.ljust(4) + " " + str(len(sub)).rjust(4) +
                  "   " + " ".join(format(t["hurdle"][i], "+6.2f") for i in (0, 11, 59)) +
                  " | " + " ".join(format(t["level"][i], "+6.2f") for i in (0, 11, 59)) +
                  "   level: " + terms)
        # In-sample fit, stated as in-sample. The honest number is the leave-one-season-out MAE that
        # scripts/price-loso.mjs reports; this one only says the fit is not broken.
        err = [abs(predict(artifact, r) - r["price"]) for r in train]
        print("  IN-SAMPLE MAE $" + format(float(np.mean(err)), ".2f") +
              "  (this is not the number to quote -- see scripts/price-loso.mjs)")
        # MONOTONICITY, checked rather than assumed. A price book in which rank 12 costs more than
        # rank 1 inverts the ordering the whole auction expresses, and no residual statistic sees it.
        M = 3200.0
        bad = []
        ranks = [1, 3, 6, 12, 24, 40, 60]

        def at(p, rk):
            return predict(artifact, {"pos": p, "leagueMoney": M, "rank": rk, "f": {
                "no_consensus": 0.0, "sd_rel": 0.3, "infl": 1.0,
                "money_left": 0.5, "slots_left": 0.5, "pick_share": 0.5}})

        for p in POSITIONS:
            if p not in coef:
                continue
            prev = None
            for rk in ranks:
                v = at(p, rk)
                if prev is not None and v > prev + 0.5:
                    bad.append(p + " rank " + str(rk))
                prev = v
            print("    " + p.ljust(4) + " price by rank " + str(ranks) + ": " +
                  " ".join(format(at(p, rk), ".0f") for rk in ranks))
        print("  MONOTONE IN RANK: " + ("yes" if not bad else "NO -- " + ", ".join(bad)))
        print("  golden rows: " + str(len(artifact["golden"])))


if __name__ == "__main__":
    main()
