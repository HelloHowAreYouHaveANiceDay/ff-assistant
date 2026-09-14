# DST STREAMING TRAINER -- productionizes the validated DST matchup edge (docs/decisions.md D20).
#
# WHAT IT FITS. The team-defense weekly ratio pts/season_line_pg, from the twelve point-in-time
# matchup columns in feat_player_week_stream (what the OPPONENT allows + the stadium + the Vegas
# implied total), with a ridge mean head and three linear quantile heads. The served projection is
# line * clamp(ratio), which is exactly src/weekly/projector.ts projectWeekly()'s linear path -- so
# DST is served by the SAME battle-tested machinery that serves every other weekly position, and the
# only change at the serve boundary is which artifact file WEEKLY_SERVE["DST"] names.
#
# WHY A DEDICATED ARTIFACT AND NOT A NEW SERVE PATH. The screen proved a LEVEL model on these
# features (kdst_stream_fit.py); this trainer fits the RATIO instead, because the WeeklyArtifact serve
# multiplies a ratio head by the season line. The ratio reframe reproduces the edge on the SERVED
# arithmetic (LOSO served corr 0.25 vs floor 0.04; STREAMABLE pick +2.8 pts/wk holdout, 5/5) -- see
# --gate -- so nothing new has to be written on the serve side and nothing new can collapse there.
# A missing opponent column imputes to its centred mean (0), which routes an unknown-matchup DST row
# to line * intercept ~= the floor: honest degradation to the thing it replaces, linear all the way,
# no tree cliff (the D19 boost's forward-serve collapse cannot recur through a linear head).
#
# WHY IT REUSES train_weekly.py. feature_value / design / head_from / evaluate / fit_quantile_heads
# there are the golden source of truth, mirrored line-for-line in projector.ts. Importing them means
# this trainer and the TS serve cannot drift, and the golden block on the artifact (checked to 1e-6
# by loadWeeklyArtifact) proves it on every load.
#
# RUN:
#   full-data (ships): uv run --with scikit-learn --with numpy tools/train_dst_stream.py \
#                        --out data/dst-stream-artifact.json
#   blind LOSO gate:   uv run --with scikit-learn --with numpy tools/train_dst_stream.py --gate
import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import train_weekly as tw  # noqa: E402  (single source of the serve arithmetic)

# The twelve matchup features, exactly the screen's set (kdst_stream_fit.py FEATS). All `center`
# transform: a missing value imputes to the training mean (0 post-centre), which is what makes an
# unknown-matchup row fall back on the intercept -- i.e. the season line -- rather than on a guess.
FEATS = [
    "opp_pa_pos", "opp_pa_pos_n", "opp_off_sacks_allowed_pg", "opp_off_giveaways_pg",
    "opp_implied_total", "opp_def_sacks_pg", "opp_def_takeaways_pg",
    "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg", "roof_dome", "team_fga_pg", "team_pat_pg",
]
POS = "DST"


def load_dst_rows(db_path, lo, hi):
    """The served join: feat_player_week_stream x feat_player_week_model on feat_key/season/week,
    in_population=1, real points, a positive season line. Byte-for-byte the screen's export join."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cols = ", ".join("s." + f for f in FEATS)
    cur = con.execute(
        "SELECT s.season, s.week, s.pos, s.feat_key, s.player_sk, s.team, s.opponent, "
        + cols + ", m.pts AS pts, m.season_line_pg AS season_line_pg "
        "FROM feat_player_week_stream s "
        "JOIN feat_player_week_model m "
        "  ON m.feat_key = s.feat_key AND m.season = s.season AND m.week = s.week "
        "WHERE s.pos = ? AND m.in_population = 1 AND m.pts IS NOT NULL "
        "  AND m.season_line_pg IS NOT NULL AND m.season_line_pg > 0 "
        "  AND s.season BETWEEN ? AND ?",
        (POS, lo, hi),
    )
    rows = []
    for r in cur.fetchall():
        d = dict(r)
        # every FEAT present (the join guarantees pts+line; opp_* may be null and impute to mean)
        rows.append(d)
    con.close()
    return rows


def build_specs(rows):
    """One `center` spec per feature, center/scale MEASURED here and written on the artifact."""
    specs = []
    for name in FEATS:
        vals = [float(r[name]) for r in rows if r.get(name) is not None]
        if len(vals) < 200:
            continue
        mu, sd = float(np.mean(vals)), float(np.std(vals))
        if sd <= 0:
            continue
        specs.append({"name": name, "transform": "center", "center": mu, "scale": sd, "missing": 0.0})
    return specs


def fit_dst(rows, specs, args):
    """Ridge mean head (alpha by season-grouped CV) + three linear quantile heads, on pts/line."""
    from sklearn.linear_model import Ridge

    keep = list(range(len(specs)))
    X = tw.design(rows, specs)[:, keep]
    y = np.array([r["pts"] / r["season_line_pg"] for r in rows], dtype=float)
    groups = np.array([r["season"] for r in rows])
    alpha = tw.best_ridge_alpha(X, y, groups, [0.1, 1.0, 10.0, 100.0])
    mean_model = Ridge(alpha=alpha).fit(X, y)
    coef = {"mean": tw.head_from(mean_model.coef_, mean_model.intercept_, specs, keep)}
    heads = tw.fit_quantile_heads(X, y, [0.10, 0.50, 0.90], args, specs, keep)
    coef["p10"], coef["p50"], coef["p90"] = heads[0.10], heads[0.50], heads[0.90]
    return coef, mean_model, X, y, alpha


def dst_golden_rows(artifact):
    """Fixtures chosen to expose a disagreement, INCLUDING the thin-feature week-1 row where the two
    implementations fall back on their own defaults -- the row G2 lives or dies on."""
    fixtures = [
        # a soft matchup: weak, giveaway-prone offense, low implied total, dome
        {"pos": POS, "season_line_pg": 6.2, "opp_pa_pos": 7.1, "opp_pa_pos_n": 8, "opp_off_sacks_allowed_pg": 3.1,
         "opp_off_giveaways_pg": 1.9, "opp_implied_total": 17.5, "opp_def_sacks_pg": 2.2, "opp_def_takeaways_pg": 1.2,
         "opp_pass_yds_allowed_pg": 260.0, "opp_rush_yds_allowed_pg": 120.0, "roof_dome": 1, "team_fga_pg": 2.0, "team_pat_pg": 2.4},
        # a hard matchup: strong offense, high implied total, protects the ball
        {"pos": POS, "season_line_pg": 5.4, "opp_pa_pos": 5.2, "opp_pa_pos_n": 8, "opp_off_sacks_allowed_pg": 1.4,
         "opp_off_giveaways_pg": 0.8, "opp_implied_total": 28.5, "opp_def_sacks_pg": 2.6, "opp_def_takeaways_pg": 1.5,
         "opp_pass_yds_allowed_pg": 230.0, "opp_rush_yds_allowed_pg": 95.0, "roof_dome": 0, "team_fga_pg": 1.9, "team_pat_pg": 2.3},
        # WEEK ONE, every matchup column missing: MUST fall back to ~ line * intercept (the floor).
        {"pos": POS, "season_line_pg": 5.9},
        # a mid line with only the Vegas total present (the always-forward column)
        {"pos": POS, "season_line_pg": 6.0, "opp_implied_total": 21.0},
    ]
    out = []
    for fx in fixtures:
        if fx["pos"] not in artifact["coef"]:
            continue
        pred = tw.evaluate(artifact, fx)
        f = {k: v for k, v in fx.items() if k != "pos"}
        out.append({"pos": fx["pos"], "line": fx["season_line_pg"], "f": f, "expect": pred})
    return out


def self_check(artifact, mean_model, X, y, rows):
    """Prove `evaluate` (the served arithmetic) reproduces scikit-learn's OWN mean prediction, so the
    serialization (head_from) is faithful before we ship it. Mirrors the weekly trainer's discipline:
    the trainer grades its own homework against sklearn, then the TS loader re-grades the golden block."""
    sk = np.clip(mean_model.predict(X), artifact["clamps"]["lo"], artifact["clamps"]["hi"])
    worst = 0.0
    for i in range(0, len(rows), max(1, len(rows) // 500)):
        r = rows[i]
        want = float(r["season_line_pg"]) * float(sk[i])
        got = tw.evaluate(artifact, r)["mean"]
        worst = max(worst, abs(want - got))
    if not (worst <= 1e-9):
        sys.exit(f"train_dst_stream: SELF-CHECK FAILED -- evaluate() disagrees with sklearn by {worst:g} "
                 "(> 1e-9). The serialized head is not the fitted model; refusing to write.")
    return worst


def paired(impr, seasons, label, out):
    xs = np.array([impr[s] for s in seasons if s in impr], dtype=float)
    n = len(xs)
    if n < 2:
        out.append(f"    {label}: n={n} too few seasons")
        return None
    m = xs.mean()
    se = xs.std(ddof=1) / math.sqrt(n)
    floor = 2.9 * se
    wins = int((xs > 0).sum())
    verdict = "BEATS FLOOR" if m > floor else "NULL (within floor/negative)"
    out.append(f"    {label} ({n} seasons): mean {m:+.4f}  2.9*SE {floor:.4f}  wins {wins}/{n}  -> {verdict}")
    return m > floor


def gate(args):
    """Blind LOSO on the SERVED arithmetic: for each season, fit on the rest, project the held season
    through evaluate(), then paired-season accuracy (MAE) + the STREAMABLE pick test. The gate measures
    the exact model that ships, because evaluate() is the serve function."""
    lo, hi = args.lo, args.hi
    rows = load_dst_rows(args.db, lo, hi)
    seasons = sorted(set(r["season"] for r in rows))
    print(f"[DST STREAM GATE] n={len(rows)} rows, seasons {seasons[0]}-{seasons[-1]}")
    pred = np.full(len(rows), np.nan)
    yr = np.array([r["season"] for r in rows])
    y = np.array([r["pts"] for r in rows], dtype=float)
    fl = np.array([r["season_line_pg"] for r in rows], dtype=float)
    coefsum = None
    nf = 0
    for hold in seasons:
        tr = [rows[i] for i in range(len(rows)) if rows[i]["season"] != hold]
        te_idx = [i for i in range(len(rows)) if rows[i]["season"] == hold]
        if len(tr) < 200 or not te_idx:
            continue
        specs = build_specs(tr)
        coef, mm, _, _, _ = fit_dst(tr, specs, args)
        art = {"schema": 2, "kind": "weekly", "learner": "linear", "zeroModel": "quantile",
               "target": "ratio_to_season_line", "features": specs, "coef": {POS: coef},
               "clamps": {"lo": 0.0, "hi": 100.0}}
        for i in te_idx:
            pred[i] = tw.evaluate(art, rows[i])["mean"]
        c = np.array([coef["mean"][s["name"]] for s in specs])
        coefsum = c if coefsum is None else (coefsum if len(coefsum) != len(c) else coefsum + c)
        nf += 1

    def corr(a, b):
        m = np.isfinite(a) & np.isfinite(b)
        return float(np.corrcoef(a[m], b[m])[0, 1])

    print("\n[G1 CONNECTION PROOF]")
    print(f"  OUT-OF-SAMPLE corr(served pred, actual pts): {corr(pred, y):.4f}   vs   floor corr: {corr(fl, y):.4f}")
    print(f"  -> features CONNECTED (model corr >> floor's 0.043): {'YES' if corr(pred, y) > corr(fl, y) else 'NO'}")
    print(f"  OOS MAE: floor={np.nanmean(np.abs(y - fl)):.3f}  model={np.nanmean(np.abs(y - pred)):.3f}")

    SEL = [s for s in seasons if s <= 2020]
    HOLD = [s for s in seasons if s >= 2021]
    out = ["\n[G1 ACCURACY GATE -- MAE, paired by season]"]
    impr = {}
    for s in seasons:
        sel = yr == s
        impr[s] = float(np.abs(y[sel] - fl[sel]).mean() - np.nanmean(np.abs(y[sel] - pred[sel])))
    paired(impr, SEL, "SELECTION", out)
    hold_ok = paired(impr, HOLD, "HOLDOUT CONFIRM", out)
    print("\n".join(out))

    # STREAMABLE pick test: within each (season, week), drop the top-12 DST by floor (the always-
    # rostered elites), then compare realized pts of the model's top pick vs the floor's top pick.
    out = ["\n[G1 DECISION -- STREAMABLE pick (exclude top-12 by floor), realized pts, paired by season]"]
    idx_by_sw = {}
    for i, r in enumerate(rows):
        idx_by_sw.setdefault((r["season"], r["week"]), []).append(i)
    ms, fs = {}, {}
    for (s, w), idxs in idx_by_sw.items():
        idxs = sorted(idxs, key=lambda i: -fl[i])[12:]
        if len(idxs) < 2:
            continue
        mp = max(idxs, key=lambda i: (pred[i] if np.isfinite(pred[i]) else -1e9))
        fp = max(idxs, key=lambda i: fl[i])
        ms.setdefault(s, []).append(y[mp])
        fs.setdefault(s, []).append(y[fp])
    mm = np.mean([np.mean(ms[s]) for s in seasons if s in ms])
    ff = np.mean([np.mean(fs[s]) for s in seasons if s in ms])
    out.append(f"    model-pick realized {mm:.2f} vs floor-pick {ff:.2f} pts/wk")
    impr = {s: float(np.mean(ms[s]) - np.mean(fs[s])) for s in ms}
    paired(impr, SEL, "SELECTION", out)
    pick_ok = paired(impr, HOLD, "HOLDOUT CONFIRM", out)
    print("\n".join(out))

    print("\n[GATE SUMMARY]")
    print(f"  accuracy holdout beats floor: {'YES' if hold_ok else 'NO'}")
    print(f"  streamable pick holdout beats floor: {'YES' if pick_ok else 'NO'}")
    return 0 if (hold_ok and pick_ok) else 1


def train(args):
    lo, hi = args.lo, args.hi
    rows_all = load_dst_rows(args.db, lo, hi)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    rows = [r for r in rows_all if r["season"] != holdout] if holdout is not None else rows_all
    if len(rows) < 200:
        sys.exit(f"train_dst_stream: only {len(rows)} DST rows in {lo}-{hi} (holdout={holdout}); refusing.")
    specs = build_specs(rows)
    if len(specs) < len(FEATS):
        print(f"  NOTE: {len(FEATS) - len(specs)} feature(s) dropped for sparsity; {len(specs)} kept.")
    coef, mean_model, X, y, alpha = fit_dst(rows, specs, args)
    seasons = sorted(set(r["season"] for r in rows))
    artifact = {
        "schema": 2, "kind": "weekly", "learner": "linear", "zeroModel": "quantile",
        "fittedFrom": "train_dst_stream.py: ridge(pts/season_line_pg) + linear quantile heads on the "
                      "feat_player_week_stream matchup features (docs/decisions.md D20)",
        "fittedAt": datetime.now(timezone.utc).isoformat(),
        "seasons": seasons, "holdoutSeason": holdout,
        "target": "ratio_to_season_line", "population": "rostered", "trainMinLine": 0.0,
        "rowFilter": "in_population",
        "features": specs, "coef": {POS: coef}, "clamps": {"lo": 0.0, "hi": 100.0},
        "notes": "DST streaming model: the weekly DST projection is line * clamp(ratio), the ratio a "
                 "ridge on the twelve matchup columns (opp implied total dominant). Served by "
                 "projectWeekly() unchanged; a missing matchup column imputes to its centred mean, so "
                 "an unknown-matchup DST degrades to ~ the season-line floor. K stays on the floor.",
    }
    artifact["golden"] = dst_golden_rows(artifact)
    worst = self_check(artifact, mean_model, X, y, rows)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(artifact, f, indent=2)
        f.write("\n")
    print(f"  wrote {args.out}  (alpha={alpha}, n={len(rows)}, self-check worst |sklearn-evaluate|={worst:g})")
    print("  mean-head standardized coefficients (per 1 SD of the feature):")
    for s in specs:
        print(f"     {s['name']:<28} {coef['mean'][s['name']]:+.4f}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--seasons", default="2012-2025")
    ap.add_argument("--holdout-season", dest="holdout_season", default="none")
    ap.add_argument("--out", default="data/dst-stream-artifact.json")
    ap.add_argument("--quantile-alpha", dest="quantile_alpha", type=float, default=0.01)
    ap.add_argument("--quantile-max-rows", dest="quantile_max_rows", type=int, default=20000)
    ap.add_argument("--gate", action="store_true", help="blind LOSO evaluation on the served arithmetic")
    args = ap.parse_args()
    lo, hi = (int(x) for x in args.seasons.split("-"))
    args.lo, args.hi = lo, hi
    if args.gate:
        sys.exit(gate(args))
    sys.exit(train(args))


if __name__ == "__main__":
    main()
