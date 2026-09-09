"""Fit what THIS ROOM pays on waivers, and what a bid must be to win.

    uv run --with scikit-learn --with numpy tools/train_faab.py \
        --db data/ff.db --out data/faab-model.json

WHAT THIS REPLACES. `FAAB_RULE` in src/inseason/copilot.ts says it plainly: ten percent of the
budget per point of playoff probability, capped at half, "a stated rule of thumb, not a fitted
value", because "there is no historical bid data to fit it on." There is. `fact_waiver_claim` holds
794 processed claims across 2018-2025 with the bid intact, and 145 of them are LOSING bids -- ESPN
publishes an outbid claim as FAILED_INVALIDPLAYERSOURCE carrying the amount that lost. So both
halves of the question are observable:

    price   what did the winning bid cost?        579 winners, 2018-2025
    win     would OUR bid have beaten the field?  724 outcomes, 2019-2025

TWO HEADS, AND THE SECOND IS THE ONE THAT MATTERS. A clearing-price model alone answers "what did
this go for", which is a fact about a claim somebody else made. The copilot has to answer "what
should I bid", and that is a decision under a win probability. The logistic head is what turns a
recommended dollar figure into a statement with a number attached to it.

2018 IS IN THE PRICE FIT AND OUT OF THE WIN FIT, and the asymmetry is the data's, not a choice.
ESPN retains no resolved failures for 2018 -- its losing claims are all still PENDING -- so its 92
winning bids are real prices, while its win RATE would read 100% purely because the losers are
missing. Fitting P(win) on a season whose losses were never recorded would bake that censoring in
as a fact about the room.

WHAT IT SEES. Every column is knowable before the waiver run; `fact_waiver_claim`'s own leakage
guard (scripts/faab-leakage.mjs) is what enforces that, with fault injection.

  log_rank            the player's PRESEASON positional rank by season line. Preseason, so knowing
                      it in week 9 is not knowing anything about week 9
  line_pg             that season line itself, points per game
  td_ppg              what he has actually scored per game through w-1
  prior_pts           his week w-1 points -- the spike that starts a bidding war
  week                week of season
  team_faab_share     the CLAIMING team's remaining budget, as a share of the whole
  league_faab_share   the room's remaining budget, as a share
  need_share          teams carrying fewer at his position than the league median
  pos_*               six one-hot columns

  log_bid             (win head only) the bid itself. The variable being decided.

NOT FEATURES, DELIBERATELY: `ros_pts` and `ros_games` (the outcome the claim bought -- the target of
a value question, never an input to a price one), `competing_bids` (knowable only after the run),
and `won`/`bid_amount` on the price head. G5 in the leakage guard reads the artifact's own published
feature list back and fails if any of them appears.

THE BASELINES ARE COMPUTED BY THIS SCRIPT, THROUGH THE SAME CODE PATH, and one of them is handed an
oracle on purpose. `faabFor` prices a PLAYOFF-PROBABILITY DELTA, and Track B already established
that such a delta cannot be reconstructed for a past season -- "there is no way to construct one for
2019 without inventing a 2019 board." So the rule of thumb cannot be evaluated on these claims as
written. Rather than invent the delta, the rule is given the BEST delta it could possibly have had:
deltaPp is taken proportional to the player's points above replacement at his position, and the one
free constant is chosen by grid search to MINIMISE THE RULE'S OWN MAE over every claim in every
season, in sample, with no holdout. The model is scored leave-one-season-out against that. Any
margin is therefore a lower bound on the real one.

LEAVE-ONE-SEASON-OUT, NOT A RANDOM SPLIT. Claims inside one season share a room, a budget cycle and
a set of managers; a random split leaks all three and every model looks better than it is.
"""

import argparse
import json
import math
import sqlite3
import sys
from datetime import date

import numpy as np
from sklearn.linear_model import Ridge, LogisticRegression

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]
NUMERIC = ["log_rank", "line_pg", "td_ppg", "prior_pts", "week", "team_faab_share",
           "league_faab_share", "need_share"]
POS_FEATURES = ["pos_" + p for p in POSITIONS]
PRICE_FEATURES = NUMERIC + POS_FEATURES
WIN_FEATURES = ["log_bid"] + PRICE_FEATURES
# Columns the artifact must never publish as an input. Mirrored by G5 in scripts/faab-leakage.mjs.
FORBIDDEN = {"ros_pts", "ros_games", "won", "competing_bids", "status", "bid_amount"}

RANK_WHEN_UNRANKED = 200.0


# --------------------------------------------------------------------------------------------------
# ROWS
# --------------------------------------------------------------------------------------------------
def load_rows(db):
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    cur = con.execute(
        "SELECT season, week, pos, bid_amount, won, season_line_pg, pos_line_rank, td_ppg,"
        "       prior_pts, team_faab_share, league_faab_share, teams_need_pos, teams_counted, budget"
        "  FROM fact_waiver_claim WHERE pos IS NOT NULL ORDER BY season, week")
    rows = []
    for r in cur:
        rows.append({
            "season": int(r["season"]),
            "week": int(r["week"]),
            "pos": r["pos"],
            "bid": float(r["bid_amount"]),
            "won": None if r["won"] is None else int(r["won"]),
            "budget": float(r["budget"] or 100.0),
            "f": features_of(r),
        })
    con.close()
    return rows


def features_of(r):
    """One claim's feature dict. Mirrored by featureRow() in src/inseason/faab.ts."""
    rank = r["pos_line_rank"]
    teams = r["teams_counted"] or 0
    f = {
        "log_rank": math.log(float(rank) if rank else RANK_WHEN_UNRANKED),
        "line_pg": None if r["season_line_pg"] is None else float(r["season_line_pg"]),
        "td_ppg": None if r["td_ppg"] is None else float(r["td_ppg"]),
        "prior_pts": None if r["prior_pts"] is None else float(r["prior_pts"]),
        "week": float(r["week"]),
        "team_faab_share": None if r["team_faab_share"] is None else float(r["team_faab_share"]),
        "league_faab_share": None if r["league_faab_share"] is None else float(r["league_faab_share"]),
        "need_share": (float(r["teams_need_pos"]) / teams) if teams else None,
    }
    for p in POSITIONS:
        f["pos_" + p] = 1.0 if r["pos"] == p else 0.0
    return f


def build_specs(rows, names):
    """Centre and scale each numeric column, and state the value a MISSING one takes -- which is 0
    after centring, i.e. the column's own mean. A one-hot column is left alone: shifting an
    indicator makes its coefficient a statement about nothing."""
    specs = []
    for n in names:
        if n in POS_FEATURES:
            specs.append({"name": n, "center": 0.0, "scale": 1.0, "missing": 0.0})
            continue
        vals = [r["f"][n] for r in rows if r["f"].get(n) is not None]
        c = float(np.mean(vals)) if vals else 0.0
        s = float(np.std(vals)) if vals else 1.0
        specs.append({"name": n, "center": round(c, 6), "scale": round(s if s > 1e-9 else 1.0, 6),
                      "missing": 0.0})
    return specs


def design(rows, specs, extra=None):
    X = np.zeros((len(rows), len(specs)))
    for i, r in enumerate(rows):
        vals = dict(r["f"])
        if extra:
            vals.update(extra(r))
        for j, s in enumerate(specs):
            v = vals.get(s["name"])
            X[i, j] = s["missing"] if v is None else (v - s["center"]) / s["scale"]
    return X


# --------------------------------------------------------------------------------------------------
# THE TWO HEADS
# --------------------------------------------------------------------------------------------------
def fit_price(rows, specs, alpha):
    """log1p(winning bid) on the point-in-time features, with Duan smearing back to dollars.

    DUAN SMEARING, not exp(sigma^2/2). This room's bids are lumpy at round numbers -- $1, $2, $3, $5
    are 44% of all winners -- and the parametric correction is a claim about a shape nobody checked.
    The smearing estimate is the mean of exp(residual), computed from the residuals themselves."""
    X = design(rows, specs)
    y = np.log1p(np.array([r["bid"] for r in rows]))
    m = Ridge(alpha=alpha).fit(X, y)
    resid = y - m.predict(X)
    return {
        "intercept": float(m.intercept_),
        "coef": {s["name"]: float(c) for s, c in zip(specs, m.coef_)},
        "smear": float(np.mean(np.exp(resid))),
    }


def fit_win(rows, specs, C):
    """P(win | bid, features). `log_bid` is the FIRST spec, and it has to be: the recommender solves
    the linear predictor for it, which is only closed-form because the model is linear in it."""
    X = design(rows, specs, extra=lambda r: {"log_bid": math.log1p(r["bid"])})
    y = np.array([r["won"] for r in rows])
    m = LogisticRegression(C=C, max_iter=4000).fit(X, y)
    return {
        "intercept": float(m.intercept_[0]),
        "coef": {s["name"]: float(c) for s, c in zip(specs, m.coef_[0])},
    }


def predict_price(art, row):
    """Predicted clearing price in dollars. Mirrored by clearingPrice() in src/inseason/faab.ts."""
    p = art["price"]
    t = p["intercept"]
    for s in art["priceFeatures"]:
        v = row["f"].get(s["name"])
        t += p["coef"].get(s["name"], 0.0) * (s["missing"] if v is None else (v - s["center"]) / s["scale"])
    t = max(-20.0, min(20.0, t))
    d = math.expm1(t) * p["smear"]
    return max(art["clamps"]["lo"], min(row["budget"], d))


def win_linear_parts(art, row):
    """(the part of the linear predictor that does NOT involve the bid, the bid's own spec)."""
    w = art["win"]
    t = w["intercept"]
    bid_spec = None
    for s in art["winFeatures"]:
        if s["name"] == "log_bid":
            bid_spec = s
            continue
        v = row["f"].get(s["name"])
        t += w["coef"].get(s["name"], 0.0) * (s["missing"] if v is None else (v - s["center"]) / s["scale"])
    return t, bid_spec


def predict_win(art, row, bid):
    """P(win) at a stated bid. Mirrored by pWin() in src/inseason/faab.ts."""
    rest, spec = win_linear_parts(art, row)
    z = rest + art["win"]["coef"]["log_bid"] * ((math.log1p(bid) - spec["center"]) / spec["scale"])
    z = max(-40.0, min(40.0, z))
    return 1.0 / (1.0 + math.exp(-z))


def bid_for(art, row, target):
    """The smallest whole-dollar bid whose modelled P(win) reaches `target`.

    CLOSED FORM, because the logit is linear in the standardised log bid: solve for that one term and
    invert. A search would give the same answer and would let the TypeScript and the Python drift."""
    rest, spec = win_linear_parts(art, row)
    b = art["win"]["coef"]["log_bid"]
    if b <= 1e-9:
        return None                       # a model that cannot buy a win with money is not a model
    t = min(max(target, 1e-6), 1 - 1e-6)
    need = (math.log(t / (1 - t)) - rest) / b
    dollars = math.expm1(need * spec["scale"] + spec["center"])
    return max(1.0, math.ceil(dollars - 1e-9))


# --------------------------------------------------------------------------------------------------
# BASELINES -- same code path, and the rule of thumb is handed an oracle
# --------------------------------------------------------------------------------------------------
def replacement(rows):
    """Points-per-game replacement level per (season, position): the median preseason line among the
    claims made at that position that season. In-sample by construction -- see the header."""
    by = {}
    for r in rows:
        v = r["f"]["line_pg"]
        if v is None:
            continue
        by.setdefault((r["season"], r["pos"]), []).append(v)
    return {k: float(np.median(v)) for k, v in by.items()}


def rule_dollars(row, repl, k):
    """`faabFor(deltaPp, budget)` from src/inseason/copilot.ts, with deltaPp = k * points above
    replacement. The arithmetic below IS that function -- 10% of budget per point, capped at 50%,
    floored at $1 -- and only the delta is supplied."""
    line = row["f"]["line_pg"]
    base = repl.get((row["season"], row["pos"]))
    vor = 0.0 if line is None or base is None else max(0.0, line - base)
    delta_pp = k * vor
    if delta_pp <= 0:
        return 0.0
    return max(1.0, round(min(0.5, delta_pp * 0.10) * row["budget"]))


def calibrate_rule(rows, repl):
    """Grid-search the rule's one free constant to MINIMISE ITS OWN MAE on every row, in sample."""
    best, best_k = None, 0.0
    for k in np.concatenate([np.linspace(0.0, 2.0, 201), np.linspace(2.0, 40.0, 191)]):
        e = float(np.mean([abs(rule_dollars(r, repl, k) - r["bid"]) for r in rows]))
        if best is None or e < best:
            best, best_k = e, float(k)
    return best_k, best


# --------------------------------------------------------------------------------------------------
# EVALUATION
# --------------------------------------------------------------------------------------------------
def loso_price(rows, alpha):
    """Leave-one-season-out predictions for every winning bid, plus the two honest baselines."""
    seasons = sorted({r["season"] for r in rows})
    out = []
    for s in seasons:
        tr = [r for r in rows if r["season"] != s]
        te = [r for r in rows if r["season"] == s]
        if len(tr) < 40 or not te:
            continue
        specs = build_specs(tr, PRICE_FEATURES)
        art = {"priceFeatures": specs, "price": fit_price(tr, specs, alpha), "clamps": CLAMPS}
        flat = float(np.median([r["bid"] for r in tr]))
        bypos = {}
        for p in POSITIONS:
            v = [r["bid"] for r in tr if r["pos"] == p]
            bypos[p] = float(np.median(v)) if v else flat
        for r in te:
            out.append({"season": s, "pos": r["pos"], "actual": r["bid"],
                        "model": predict_price(art, r),
                        "flat": flat, "posmed": bypos.get(r["pos"], flat)})
    return out


def loso_win(rows, C):
    seasons = sorted({r["season"] for r in rows})
    out = []
    for s in seasons:
        tr = [r for r in rows if r["season"] != s]
        te = [r for r in rows if r["season"] == s]
        if len(tr) < 60 or not te:
            continue
        specs = build_specs(tr, WIN_FEATURES)
        art = {"winFeatures": specs, "win": fit_win(tr, specs, C)}
        base = float(np.mean([r["won"] for r in tr]))
        for r in te:
            out.append({"season": s, "won": r["won"], "p": predict_win(art, r, r["bid"]), "base": base})
    return out


def season_bootstrap(rows, names, fitter, draws, seed):
    """A coefficient's uncertainty, resampled over SEASONS rather than rows.

    The unit of analysis here is the season, exactly as it is for the championship backtest: claims
    inside one season share a room and a budget cycle, so resampling rows would treat 724 correlated
    observations as 724 independent ones and produce a confidence interval several times too tight."""
    rng = np.random.default_rng(seed)
    seasons = sorted({r["season"] for r in rows})
    by = {s: [r for r in rows if r["season"] == s] for s in seasons}
    keep = {n: [] for n in names}
    for _ in range(draws):
        pick = rng.choice(seasons, size=len(seasons), replace=True)
        samp = [r for s in pick for r in by[s]]
        if len({r["season"] for r in samp}) < 2:
            continue
        try:
            c = fitter(samp)
        except Exception:
            continue
        for n in names:
            keep[n].append(c.get(n, 0.0))
    out = {}
    for n in names:
        a = np.array(keep[n])
        if not len(a):
            out[n] = None
            continue
        out[n] = {"mean": float(np.mean(a)), "lo": float(np.percentile(a, 2.5)),
                  "hi": float(np.percentile(a, 97.5)),
                  "pctPositive": round(100.0 * float(np.mean(a > 0)), 1), "draws": int(len(a))}
    return out


CLAMPS = {"lo": 1.0, "hi": 100.0}


def golden_rows(art):
    """The trainer's OWN predictions for fixture rows, recomputed by the TypeScript evaluator at
    1e-6. A producer that ships its own validator grades its own homework and passes forever."""
    def row(pos, week, rank, line, td, prior, tshare, lshare, need, budget=100.0):
        f = {"log_rank": math.log(rank) if rank else math.log(RANK_WHEN_UNRANKED),
             "line_pg": line, "td_ppg": td, "prior_pts": prior, "week": float(week),
             "team_faab_share": tshare, "league_faab_share": lshare, "need_share": need}
        for p in POSITIONS:
            f["pos_" + p] = 1.0 if p == pos else 0.0
        return {"pos": pos, "season": 0, "week": week, "budget": budget, "f": f}

    fixtures = [
        # The week-2 breakout back every room bids on, claimed by a team with a full budget.
        row("RB", 2, 30, 8.0, 14.0, 22.0, 1.0, 0.95, 0.4),
        # A late-season streamer nobody wants, claimed by a team that has spent almost everything.
        row("DST", 13, 20, 6.0, 6.5, 4.0, 0.05, 0.2, 0.1),
        # Unranked -- the row that exercises the log-rank default.
        row("WR", 7, None, None, 5.0, 11.0, 0.6, 0.5, 0.3),
        # Every column missing but the week: the missing-value defaults, all at once.
        row("TE", 5, None, None, None, None, None, None, None),
        # A hoarder late, at a big number: the corner P61 and P62 both point at.
        row("QB", 15, 5, 18.0, 20.0, 28.0, 1.0, 0.35, 0.5),
    ]
    out = []
    for fx in fixtures:
        out.append({
            "pos": fx["pos"], "week": fx["week"], "budget": fx["budget"], "f": fx["f"],
            "price": predict_price(art, fx),
            "pWinAt": {str(b): predict_win(art, fx, float(b)) for b in (1, 5, 20)},
            "bidAt70": bid_for(art, fx, 0.70),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--out", default="data/faab-model.json")
    ap.add_argument("--alpha", type=float, default=1.0)
    ap.add_argument("--C", type=float, default=1.0)
    ap.add_argument("--draws", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    rows = load_rows(a.db)
    winners = [r for r in rows if r["won"] == 1]
    # The win head drops seasons whose LOSSES were never retained -- see the header on 2018.
    scored_seasons = sorted({r["season"] for r in rows if r["won"] == 0})
    outcomes = [r for r in rows if r["won"] is not None and r["season"] in scored_seasons]

    print("fact_waiver_claim: " + str(len(rows)) + " claims, "
          + str(len(winners)) + " winning bids, " + str(len(outcomes)) + " win/loss outcomes over "
          + str(len(scored_seasons)) + " seasons " + str(scored_seasons))

    price_specs = build_specs(winners, PRICE_FEATURES)
    win_specs = build_specs(outcomes, WIN_FEATURES)
    art = {
        "kind": "faab-bid",
        "version": 1,
        "builtAt": date.today().isoformat(),
        "trainedOn": {
            "priceSeasons": sorted({r["season"] for r in winners}),
            "winSeasons": scored_seasons,
            "priceRows": len(winners),
            "winRows": len(outcomes),
            "baseWinRate": round(float(np.mean([r["won"] for r in outcomes])), 4),
        },
        "features": PRICE_FEATURES,          # the published input list; G5 reads THIS
        "priceFeatures": price_specs,
        "winFeatures": win_specs,
        "clamps": CLAMPS,
        "rankWhenUnranked": RANK_WHEN_UNRANKED,
    }
    art["price"] = fit_price(winners, price_specs, a.alpha)
    art["win"] = fit_win(outcomes, win_specs, a.C)

    # ---- baselines and LOSO --------------------------------------------------------------------
    repl = replacement(winners)
    k, rule_mae = calibrate_rule(winners, repl)
    lp = loso_price(winners, a.alpha)
    mae = lambda key: float(np.mean([abs(r[key] - r["actual"]) for r in lp]))
    model_mae, flat_mae, pos_mae = mae("model"), mae("flat"), mae("posmed")
    beat = 100.0 * (rule_mae - model_mae) / rule_mae

    lw = loso_win(outcomes, a.C)
    y = np.array([r["won"] for r in lw], dtype=float)
    p = np.array([r["p"] for r in lw])
    b = np.array([r["base"] for r in lw])
    brier, brier_base = float(np.mean((p - y) ** 2)), float(np.mean((b - y) ** 2))

    art["loso"] = {
        "priceRows": len(lp),
        "maeModel": round(model_mae, 3),
        "maeFlatMedian": round(flat_mae, 3),
        "maePositionMedian": round(pos_mae, 3),
        "maeRuleOfThumb": round(rule_mae, 3),
        "ruleDeltaPerPointAbovReplacement": round(k, 4),
        "beatsRulePct": round(beat, 1),
        "winRows": len(lw),
        "brier": round(brier, 4),
        "brierBaseRate": round(brier_base, 4),
    }

    # ---- P61 / P62 -----------------------------------------------------------------------------
    boot_win = season_bootstrap(
        outcomes, ["team_faab_share", "week", "log_bid"],
        lambda s: fit_win(s, build_specs(s, WIN_FEATURES), a.C)["coef"], a.draws, a.seed)
    boot_price = season_bootstrap(
        winners, ["team_faab_share", "week"],
        lambda s: fit_price(s, build_specs(s, PRICE_FEATURES), a.alpha)["coef"], a.draws, a.seed + 1)
    art["bootstrap"] = {"win": boot_win, "price": boot_price, "draws": a.draws, "unit": "season"}

    # ---- THE CAVEAT THAT HAS TO TRAVEL WITH THE NUMBER -----------------------------------------
    #
    # `log_bid` is the coefficient the whole recommender rests on: solving for a target win
    # probability is only meaningful if paying more actually buys a win. Resampled over seasons its
    # interval may well cross zero, and if it does, a recommended bid is a point estimate the data
    # cannot separate from "the bid does not matter". That is not a reason to withhold the model --
    # it is a reason for the copilot to SAY SO on the row, which is what `assumptions.faab` does.
    lb = boot_win.get("log_bid")
    art["bidEffect"] = {
        "coef": art["win"]["coef"]["log_bid"],
        "ci": None if lb is None else [lb["lo"], lb["hi"]],
        "significant": bool(lb is not None and lb["lo"] > 0),
        "note": ("paying more measurably raises P(win) in this room"
                 if lb is not None and lb["lo"] > 0 else
                 "the bid's effect on P(win) is NOT separable from zero at the season level -- "
                 "most claims in this room are uncontested, and a large bid is itself a signal that "
                 "a player was contested, which biases the observed effect DOWNWARD"),
    }

    # ---- POSITIVE CONTROLS: break the target on purpose and watch the fit collapse --------------
    #
    # A model that fits noise and a model that fits signal both print a number. These two say which.
    rng = np.random.default_rng(a.seed + 99)
    shuffled = [dict(r) for r in winners]
    perm = rng.permutation(len(shuffled))
    for i, r in enumerate(shuffled):
        r["bid"] = winners[perm[i]]["bid"]
    lp0 = loso_price(shuffled, a.alpha)
    perm_mae = float(np.mean([abs(r["model"] - r["actual"]) for r in lp0]))
    perm_flat = float(np.mean([abs(r["flat"] - r["actual"]) for r in lp0]))

    shuffled_w = [dict(r) for r in outcomes]
    permw = rng.permutation(len(shuffled_w))
    for i, r in enumerate(shuffled_w):
        r["won"] = outcomes[permw[i]]["won"]
    lw0 = loso_win(shuffled_w, a.C)
    y0 = np.array([r["won"] for r in lw0], dtype=float)
    perm_brier = float(np.mean((np.array([r["p"] for r in lw0]) - y0) ** 2))
    perm_base = float(np.mean((np.array([r["base"] for r in lw0]) - y0) ** 2))
    art["controls"] = {
        "permutedPriceMae": round(perm_mae, 3), "permutedPriceFlatMae": round(perm_flat, 3),
        "permutedWinBrier": round(perm_brier, 4), "permutedWinBaseBrier": round(perm_base, 4),
    }

    art["golden"] = golden_rows(art)

    leak = [f for f in art["features"] if f in FORBIDDEN]
    if leak:
        raise SystemExit("a target column reached the published feature list: " + ", ".join(leak))

    with open(a.out, "w") as fh:
        json.dump(art, fh, indent=2)

    print("\n  CLEARING PRICE -- leave-one-season-out MAE on " + str(len(lp)) + " winning bids")
    print("    model                       $" + format(model_mae, ".2f"))
    print("    per-position median         $" + format(pos_mae, ".2f"))
    print("    flat league median          $" + format(flat_mae, ".2f"))
    print("    rule of thumb (ORACLE, in-sample, best case)  $" + format(rule_mae, ".2f")
          + "   at " + format(k, ".3f") + "pp per point above replacement")
    print("\n  P54  the model's LOSO MAE beats the rule of thumb by >= 30%")
    print("       " + format(beat, ".1f") + "% better -> " + ("HELD" if beat >= 30.0 else "FAILED"))

    def verdict(name, blk, want):
        if blk is None:
            return name + "  no draws"
        sign = "positive" if want > 0 else "negative"
        ok = (blk["lo"] > 0) if want > 0 else (blk["hi"] < 0)
        return (name + "  mean " + format(blk["mean"], "+.4f") + "  95% CI ["
                + format(blk["lo"], "+.4f") + ", " + format(blk["hi"], "+.4f") + "]  "
                + format(blk["pctPositive"], ".1f") + "% of draws positive -> "
                + ("HELD" if ok else "FAILED") + " (" + sign + " and CI excludes 0)")

    print("\n  P61  the claiming team's remaining-FAAB share is a significant POSITIVE feature")
    print("       win head:   " + verdict("team_faab_share", boot_win["team_faab_share"], +1))
    print("       price head: " + verdict("team_faab_share", boot_price["team_faab_share"], +1))
    print("\n  P62  the week-of-season effect is NEGATIVE (bids fall as the season ages)")
    print("       price head: " + verdict("week", boot_price["week"], -1))
    print("       win head:   " + verdict("week", boot_win["week"], -1))

    print("\n  P(WIN) -- leave-one-season-out on " + str(len(lw)) + " outcomes")
    print("    Brier " + format(brier, ".4f") + "  against the base rate's "
          + format(brier_base, ".4f") + " (base rate "
          + format(float(np.mean(y)), ".3f") + ")")
    print("    DOES MONEY BUY A WIN?  " + verdict("log_bid", boot_win["log_bid"], +1))
    print("    " + art["bidEffect"]["note"])

    print("\n  POSITIVE CONTROLS -- the target permuted within the panel, same code path")
    print("    price  LOSO MAE $" + format(perm_mae, ".2f") + " vs its own flat-median $"
          + format(perm_flat, ".2f") + "   (real fit $" + format(model_mae, ".2f")
          + " vs $" + format(flat_mae, ".2f") + ")")
    print("    win    LOSO Brier " + format(perm_brier, ".4f") + " vs base "
          + format(perm_base, ".4f") + "   (real fit " + format(brier, ".4f")
          + " vs " + format(brier_base, ".4f") + ")")
    print("\n  wrote " + a.out + "  (" + str(len(art["golden"])) + " golden rows)")


if __name__ == "__main__":
    main()
