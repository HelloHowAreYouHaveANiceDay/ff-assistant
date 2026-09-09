"""Fit the PER-POSITION STREAMING model and emit a schema-validated weekly artifact.

    uv run --with scikit-learn --with numpy tools/train_streaming.py \
        --db data/ff.db --seasons 2012-2025 --holdout-season none \
        --out data/streaming-artifact.json

WHY THIS IS A WRAPPER AND NOT A COPY.

Everything that decides a NUMBER here -- the ratio target, the two-part mixture, the season-grouped
CV, the pinball heads, the clamp, the golden-block evaluator that the TypeScript loader checks
against -- already exists in tools/train_weekly.py and is mirrored line for line by
src/weekly/projector.ts. A second copy of that arithmetic would be a third implementation of one
contract, and the two that exist are already the reason the golden block exists. So this file
imports that one and overrides exactly four things, each named and argued for below:

  1. THE SOURCE. `load_rows` reads feat_player_week_model LEFT JOINed to feat_player_week_stream, so
     the twelve opponent-and-environment columns reach the fit. Nothing else about the population
     changes: still `rostered`, still non-bye, still the season-line floor.
  2. THE FEATURE LISTS. The eleven numeric streaming columns join CENTER and `roof_dome` joins
     INDICATOR, so `build_specs` measures their centres and scales exactly as it does every other
     column.
  3. THE POSITION GATING. A quarterback has no team field-goal rate that means anything about HIM,
     and a defence has no snap share. Same rule POS_GATED already encodes for the usage block, and
     the same reason: scoring a position on a column that cannot be about it measures ~0 and then
     that null is written down as a fact about the position.
  4. K AND DST ARE FITTED, NOT INTERCEPTS. This is the whole point of the track. train_weekly.py
     puts them in POS_INTERCEPT_ONLY with a comment saying why -- "this table carries no kicking or
     defensive usage columns" -- and docs/weekly.md reports the consequence: K 2.457 vs 2.468 and
     DST 3.105 vs 3.115 against the shipped baseline, two near-ties, because two intercepts have
     nothing to add. The columns now exist, so the reason no longer holds.

WHAT THE FIRST STAGE CAN AND CANNOT SEE, PER POSITION, because the answer is not the same for all
six and a report that averages over the difference is hiding it:

  QB / RB / WR / TE / K   the availability block is populated (78-88% of rows), and P(zero week) is
                          led by the injury designation exactly as Phase 2d measured.
  DST                     feat_player_week_context has NO defensive rows at all -- 0 of 7,326 for
                          2012-2025 -- so every availability column is NULL for a defence. They are
                          therefore GATED OFF for DST rather than fitted on a constant. That is not
                          a gap being papered over: a team defence does not miss a week, its zero
                          weeks are bad games rather than absences, and P(zero | DST) is a statement
                          about the matchup, which is precisely what the columns this track adds are.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np                                    # noqa: E402
import train_weekly as tw                             # noqa: E402

# ---- 2. THE FEATURE LISTS ------------------------------------------------------------------------
# Every accumulated streaming column is a continuous quantity in its own units (points, sacks, yards,
# attempts), so it is CENTERED -- mean-imputed, which is 0 after centring and is stated as such by
# build_specs. `roof_dome` is the one indicator: a roof is a fact about the stadium, not a magnitude.
STREAM_CENTER = [
    "opp_pa_pos", "opp_pa_pos_n",
    "opp_def_sacks_pg", "opp_def_takeaways_pg",
    "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg",
    "opp_off_sacks_allowed_pg", "opp_off_giveaways_pg",
    "opp_implied_total", "team_fga_pg", "team_pat_pg",
]
STREAM_INDICATOR = ["roof_dome"]
STREAM_ALL = STREAM_CENTER + STREAM_INDICATOR

# ---- 3. THE POSITION GATING ----------------------------------------------------------------------
# WHICH POSITIONS MAY CARRY A NON-ZERO COEFFICIENT ON EACH NEW COLUMN, and why each line is drawn
# where it is. Ungated (every position): opp_pa_pos and opp_pa_pos_n, which are position-specific by
# construction; opp_implied_total, which prices the game for both sides; roof_dome, which is the
# stadium.
STREAM_GATED = {
    # A pass rush and a ball-hawking secondary are facts about what a QUARTERBACK faces. A running
    # back's week is not measurably a function of how often the defence sacks somebody else.
    "opp_def_sacks_pg": {"QB"},
    "opp_def_takeaways_pg": {"QB"},
    # Yards allowed through the air are the receiving positions' matchup; on the ground, the rushing
    # ones -- and a quarterback is on both sides of that line, because he throws and he runs.
    "opp_pass_yds_allowed_pg": {"QB", "WR", "TE"},
    "opp_rush_yds_allowed_pg": {"QB", "RB"},
    # THE DST COLUMNS. A defence scores on what the OFFENCE it faces gives away: sacks it takes and
    # turnovers it commits. No other position has any use for them, and fitting a receiver on how
    # often his opponent's quarterback is sacked would be fitting noise with a plausible name.
    "opp_off_sacks_allowed_pg": {"DST"},
    "opp_off_giveaways_pg": {"DST"},
    # THE KICKER'S COLUMNS. His own team's field-goal and extra-point rate is his opportunity. It is
    # a fact about nobody else's scoring.
    "team_fga_pg": {"K"},
    "team_pat_pg": {"K"},
}

# The AVAILABILITY block, gated OFF for DST. See the header: feat_player_week_context has no
# defensive rows, so every one of these is NULL for a defence, and a column that is constant is an
# intercept wearing a feature's name.
SKILL_AND_K = {"QB", "RB", "WR", "TE", "K"}
AVAILABILITY_GATED = {
    c: SKILL_AND_K for c in
    ["prior_snap_share", "prior_route_share", "depth_rank", "teammates_out",
     "inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "inj_feed"]
}

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]


def load_rows(db_path, lo, hi, population):
    """THE SOURCE, and the ONLY thing that differs from train_weekly.load_rows is the LEFT JOIN.

    LEFT, not INNER, and it matters: a player-week the streaming build has no row for must still
    train, with its streaming columns NULL and therefore at their declared missing-value defaults.
    An inner join would silently drop the ~6% of rows that are byes or have no opponent, which
    changes the POPULATION -- the one thing on this artifact that is a contract rather than a
    setting, and the thing a full evaluation pass was already spent discovering once.
    """
    import sqlite3

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    where = "m.pts IS NOT NULL" if population == "played" else "COALESCE(m.is_bye, 0) = 0"
    cols = ", ".join("m." + c for c in tw.SELECT_COLS) + ", " + ", ".join("s." + c for c in STREAM_ALL)
    # THE DECISION POPULATION, the same flag train_weekly.py reads and the same refusal if it is not
    # there. Six positions have to be comparable to each other and to the floor, which they only are
    # if all of them were fitted and scored on the same set.
    have = {r[1] for r in con.execute("PRAGMA table_info(feat_player_week_model)")}
    if tw.POPULATION_COLUMN not in have:
        con.close()
        sys.exit(
            "train_streaming: feat_player_week_model has no `" + tw.POPULATION_COLUMN + "` column. "
            "Run `ff build-weekly-population`; see src/weekly/population.ts for the rule.")
    built = con.execute(
        "SELECT COUNT(*) FROM feat_player_week_model"
        " WHERE season BETWEEN ? AND ? AND " + tw.POPULATION_COLUMN + " IS NOT NULL", (lo, hi)).fetchone()[0]
    if not built:
        con.close()
        sys.exit("train_streaming: `" + tw.POPULATION_COLUMN + "` exists but no row in " + str(lo) +
                 "-" + str(hi) + " has been built. Run `ff build-weekly-population`.")
    cur = con.execute(
        "SELECT " + cols + ", COALESCE(m.pts, 0.0) AS pts"
        " FROM feat_player_week_model m"
        " LEFT JOIN feat_player_week_stream s"
        "        ON s.season = m.season AND s.week = m.week AND s.feat_key = m.feat_key"
        " WHERE m.season BETWEEN ? AND ? AND " + where + " AND m.season_line_pg IS NOT NULL"
        "   AND m." + tw.POPULATION_COLUMN + " = 1",
        (lo, hi),
    )
    rows = []
    for r in cur.fetchall():
        d = dict(r)
        d["week_no"] = d["week"]
        rows.append(d)
    con.close()
    return rows


def golden_rows(artifact):
    """EIGHT FIXTURES, one per fitted position plus the two rows most likely to expose a disagreement.

    The weekly artifact's six fixtures carry no streaming column at all, which means every streaming
    coefficient would be multiplied by its missing-value default in every golden row -- so the golden
    block would be structurally incapable of catching a disagreement about the twelve columns this
    file exists to add. That is the exact shape of a check that passes forever. These carry real
    values for all of them, and they add a KICKER and a DEFENCE, whose heads did not exist before.
    """
    base_stream = {
        "opp_pa_pos": 18.5, "opp_pa_pos_n": 6, "opp_def_sacks_pg": 2.4,
        "opp_def_takeaways_pg": 1.3, "opp_pass_yds_allowed_pg": 231.0,
        "opp_rush_yds_allowed_pg": 108.0, "opp_off_sacks_allowed_pg": 2.1,
        "opp_off_giveaways_pg": 1.4, "opp_implied_total": 22.0, "team_fga_pg": 1.9,
        "team_pat_pg": 2.6, "roof_dome": 0,
    }
    fixtures = [
        {"pos": "RB", "season_line_pg": 14.5, "td_games": 6, "td_ppg": 15.2, "t4_mean": 17.0,
         "t4_sd": 4.4, "td_fd": 4.0, "td_ts": 0.15, "dvp_mult": 1.12, "dvp_n": 6, "home": 1,
         "spread_line": -3.5, "total_line": 47.5, "implied_team_total": 25.5, "days_rest": 7,
         "week_no": 7, "prior_snap_share": 0.72, "prior_route_share": 0.41, "depth_rank": 1,
         "teammates_out": 0, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1,
         **base_stream, "opp_pa_pos": 20.9, "opp_rush_yds_allowed_pg": 129.0, "opp_implied_total": 22.0},
        {"pos": "WR", "season_line_pg": 11.0, "td_games": 3, "td_ppg": 6.1, "t4_mean": 6.1,
         "t4_sd": 3.0, "td_fd": 2.2, "td_ts": 0.24, "dvp_mult": 0.88, "dvp_n": 3, "home": 0,
         "spread_line": 6.5, "total_line": 41.0, "implied_team_total": 17.25, "days_rest": 10,
         "week_no": 4, "prior_snap_share": 0.61, "prior_route_share": 0.55, "depth_rank": 2,
         "teammates_out": 1, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 1,
         "prac_dnp": 0, "prac_limited": 1, "inj_feed": 1,
         **base_stream, "opp_pa_pos": 24.4, "opp_pass_yds_allowed_pg": 199.0,
         "opp_implied_total": 23.75, "roof_dome": 1},
        {"pos": "QB", "season_line_pg": 19.5, "td_games": 11, "td_ppg": 21.0, "t4_mean": 24.5,
         "t4_sd": 6.0, "td_attempts": 35.0, "td_rush_yards": 30.0, "dvp_mult": 1.05, "dvp_n": 11,
         "home": 1, "spread_line": -7.0, "total_line": 49.5, "implied_team_total": 28.25,
         "days_rest": 6, "week_no": 12, "prior_snap_share": 1.0, "depth_rank": 1,
         "teammates_out": 0, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1,
         **base_stream, "opp_pa_pos": 16.4, "opp_def_sacks_pg": 3.1, "opp_def_takeaways_pg": 1.9,
         "opp_implied_total": 21.25},
        {"pos": "TE", "season_line_pg": 7.5, "td_games": 1, "td_ppg": 2.0, "t4_mean": 2.0,
         "t4_sd": None, "td_fd": 0.0, "td_ts": 0.08, "dvp_mult": 1.0, "dvp_n": 1, "home": 0,
         "spread_line": 1.0, "total_line": 44.0, "implied_team_total": 21.5, "days_rest": 14,
         "week_no": 3, "prior_snap_share": 0.35, "prior_route_share": 0.22, "depth_rank": 3,
         "teammates_out": 0, "inj_out": 0, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1,
         **base_stream, "opp_pa_pos": 9.8, "opp_implied_total": 22.5},
        # THE KICKER. A dome, a high team total and a team that kicks a lot of field goals -- the row
        # every one of his three columns is about, and the one that did not exist before this track.
        {"pos": "K", "season_line_pg": 8.5, "td_games": 5, "td_ppg": 8.9, "t4_mean": 9.5,
         "t4_sd": 3.1, "dvp_mult": 1.02, "dvp_n": 5, "home": 1, "spread_line": -6.0,
         "total_line": 48.0, "implied_team_total": 27.0, "days_rest": 7, "week_no": 6,
         "prior_snap_share": None, "depth_rank": 1, "teammates_out": 0, "inj_out": 0,
         "inj_doubtful": 0, "inj_questionable": 0, "prac_dnp": 0, "prac_limited": 0, "inj_feed": 1,
         **base_stream, "opp_pa_pos": 8.6, "opp_implied_total": 21.0, "team_fga_pg": 2.6,
         "team_pat_pg": 3.1, "roof_dome": 1},
        # THE DEFENCE. Its opponent is a bad offence -- sacked often, turns it over often, priced low
        # -- which is the entire streaming case for a DST and the row that proves the head reads it.
        {"pos": "DST", "season_line_pg": 6.5, "td_games": 5, "td_ppg": 7.2, "t4_mean": 8.0,
         "t4_sd": 4.0, "dvp_mult": 1.08, "dvp_n": 5, "home": 1, "spread_line": -9.5,
         "total_line": 39.0, "implied_team_total": 24.25, "days_rest": 7, "week_no": 6,
         **base_stream, "opp_pa_pos": 7.4, "opp_off_sacks_allowed_pg": 3.6,
         "opp_off_giveaways_pg": 2.3, "opp_implied_total": 14.75},
        # WEEK ONE, every optional input missing -- INCLUDING every streaming column, which is where
        # the two implementations fall back on their own defaults and are most likely to differ. It
        # is not a corner case; it is every player in week 1 of a season whose feed has not started.
        {"pos": "RB", "season_line_pg": 9.0, "week_no": 1, "td_games": 0},
        # AN OUT DESIGNATION against a soft matchup. The row where the mixture branch is taken AND
        # the streaming columns are pulling the other way: if the consumer applied the (1 - pZero)
        # factor to the wrong stage this is the fixture that says so.
        {"pos": "WR", "season_line_pg": 13.0, "td_games": 8, "td_ppg": 14.0, "t4_mean": 15.5,
         "t4_sd": 4.0, "td_fd": 3.4, "td_ts": 0.27, "dvp_mult": 1.02, "dvp_n": 8, "home": 1,
         "spread_line": -2.5, "total_line": 46.0, "implied_team_total": 24.25, "days_rest": 7,
         "week_no": 9, "prior_snap_share": 0.85, "prior_route_share": 0.78, "depth_rank": 1,
         "teammates_out": 0, "inj_out": 1, "inj_doubtful": 0, "inj_questionable": 0,
         "prac_dnp": 1, "prac_limited": 0, "inj_feed": 1,
         **base_stream, "opp_pa_pos": 30.1, "opp_pass_yds_allowed_pg": 268.0,
         "opp_implied_total": 21.75},
    ]
    out = []
    for fx in fixtures:
        if fx["pos"] not in artifact["coef"]:
            continue
        pred = tw.evaluate(artifact, fx)
        f = {k: v for k, v in fx.items() if k != "pos"}
        out.append({"pos": fx["pos"], "line": fx["season_line_pg"], "f": f, "expect": pred})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/ff.db")
    ap.add_argument("--seasons", default="2012-2025")
    ap.add_argument("--holdout-season", default="none")
    ap.add_argument("--features", default="all",
                    help="comma list of feature columns, or 'all'. 'weekly-only' fits the SAME "
                         "positions and the same trainer with the twelve streaming columns REMOVED "
                         "-- the control that isolates what the opponent block is worth, and the "
                         "only baseline P41 can honestly be measured against.")
    ap.add_argument("--out", default="data/streaming-artifact.json")
    ap.add_argument("--population", default="rostered", choices=["rostered", "played"])
    ap.add_argument("--zero-model", default="two-part", choices=["quantile", "two-part"])
    ap.add_argument("--quantile-alpha", type=float, default=0.01)
    ap.add_argument("--quantile-max-rows", type=int, default=20000)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    # ---- THE OVERRIDES, applied to the imported module so every downstream function sees them. ----
    stream_on = args.features != "weekly-only"
    tw.CENTER = list(tw.CENTER) + (STREAM_CENTER if stream_on else [])
    tw.INDICATOR = list(tw.INDICATOR) + (STREAM_INDICATOR if stream_on else [])
    tw.ALL_FEATURES = tw.RATIO_TO_LINE + tw.CENTER + tw.INDICATOR
    gates = dict(tw.POS_GATED)
    gates.update(AVAILABILITY_GATED)
    if stream_on:
        gates.update(STREAM_GATED)
    tw.POS_GATED = gates
    # 4. EVERY POSITION IS FITTED. K and DST were intercept-only because there was nothing to give
    # them; there is now.
    tw.POS_FITTED = POSITIONS
    tw.POS_INTERCEPT_ONLY = []

    lo, hi = tw.parse_seasons(args.seasons)
    holdout = None if args.holdout_season in ("none", "", None) else int(args.holdout_season)
    rows = load_rows(args.db, lo, hi, args.population)
    # NO SECOND FILTER. load_rows already selected the decision population in SQL; see train_weekly.
    # THE HOLDOUT IS REMOVED BEFORE ANYTHING IS MEASURED -- before the transform centres, before the
    # missing-value defaults, before the alpha search. Same rule as train_weekly.py and for the same
    # reason: removing it only from the final fit leaves the held-out season inside every
    # hyperparameter the model chose.
    if holdout is not None:
        rows = [r for r in rows if r["season"] != holdout]
    if not rows:
        sys.exit("train_streaming: no training rows -- has `ff build-streaming-features` been run?")

    wanted = set(tw.ALL_FEATURES) if args.features in ("all", "weekly-only") else {
        s.strip() for s in args.features.split(",") if s.strip()}
    unknown = wanted - set(tw.ALL_FEATURES)
    if unknown:
        sys.exit("train_streaming: unknown feature(s) " + ", ".join(sorted(unknown)))

    specs = tw.build_specs(rows, wanted)
    if not specs:
        sys.exit("train_streaming: no feature met its coverage floor -- nothing to fit")
    have = {s["name"] for s in specs}
    if stream_on:
        # THE REFUSAL THIS FILE ADDS. A "streaming" artifact whose streaming columns never met their
        # coverage floor is a weekly artifact under another name, and every number measured from it
        # would be reported as evidence about the opponent block. It refuses rather than emitting one.
        gone = [c for c in STREAM_ALL if c not in have]
        if gone:
            sys.exit(
                "train_streaming: these streaming columns are absent from the fitted feature set: "
                + ", ".join(gone) + ". They come from feat_player_week_stream via "
                "`ff build-streaming-features`; either that has not been run against this store or "
                "they failed the 500-row coverage floor. Fitting without them and calling the result "
                "a streaming model would report a weekly model's numbers as the opponent block's.")
    if args.zero_model == "two-part":
        gone = [c for c in tw.AVAILABILITY_REQUIRED if c not in have]
        if gone:
            sys.exit("train_streaming: --zero-model two-part needs the availability columns and "
                     "these are absent: " + ", ".join(gone))

    seasons = sorted({r["season"] for r in rows})
    fit = tw.fit_position_two_part if args.zero_model == "two-part" else tw.fit_position_quantile
    coef, counts = {}, {}
    for pos in POSITIONS:
        c, n = fit(rows, specs, pos, args)
        counts[pos] = n
        if c:
            coef[pos] = c
    if not coef:
        sys.exit("train_streaming: nothing fitted")

    zero_share = sum(1 for r in rows if r["pts"] <= tw.ZERO_PTS) / len(rows)
    artifact = {
        "schema": tw.SCHEMA,
        "kind": "weekly",
        "zeroModel": args.zero_model,
        "fittedFrom": "tools/train_streaming.py",
        "fittedAt": date.today().isoformat(),
        "seasons": seasons,
        "holdoutSeason": holdout,
        "target": "ratio_to_season_line",
        "population": args.population,
        "trainMinLine": 0.0,
        "rowFilter": tw.ROW_FILTER,
        "features": specs,
        "coef": coef,
        "clamps": {"lo": tw.CLAMP_LO, "hi": tw.CLAMP_HI},
        "notes": ("STREAMING. The weekly two-part model with the twelve point-in-time "
                  "opponent-and-environment columns of feat_player_week_stream, and with K and DST "
                  "FITTED rather than intercept-only -- they were intercepts because this table had "
                  "no kicking or defensive column, which is no longer true. Availability columns are "
                  "gated OFF for DST: feat_player_week_context has no defensive rows, and a constant "
                  "column is an intercept wearing a feature's name. Observed weather is NOT a "
                  "feature and never will be from this store: raw_nfl_game's temp and wind are "
                  "measured after the fact. Zero weeks (pts <= 0) are "
                  + format(100 * zero_share, ".1f") + "% of the training rows."
                  + ("" if stream_on else " FEATURES: weekly-only -- the streaming columns were "
                     "REMOVED, so this is the control the opponent block is measured against.")),
    }
    if args.zero_model == "two-part":
        artifact["quantileGrid"] = tw.QUANTILE_GRID
    artifact["golden"] = golden_rows(artifact)

    with open(args.out, "w", encoding="ascii") as fh:
        json.dump(artifact, fh, indent=2)
    if not args.quiet:
        print("wrote " + args.out)
        print("  seasons " + str(seasons[0]) + "-" + str(seasons[-1]) +
              (" holding out " + str(holdout) if holdout else "") +
              "; " + str(len(rows)) + " player-weeks (" + args.population + "); " +
              str(len(specs)) + " features; zero-model " + args.zero_model +
              ("" if stream_on else "; STREAMING COLUMNS REMOVED (control)"))
        print("  streaming columns fitted: " +
              (", ".join(c for c in STREAM_ALL if c in have) if stream_on else "(none -- control)"))
        for pos in POSITIONS:
            if pos not in coef:
                print("  " + pos.ljust(4) + " NOT FITTED (n=" + str(counts.get(pos, 0)) + ")")
                continue
            m = coef[pos].get("mean", {})
            terms = ", ".join(k + " " + format(v, ".4f") for k, v in
                              sorted(m.items(), key=lambda kv: -abs(kv[1]))
                              if k != "intercept" and abs(v) > 1e-4)[:220]
            print("  " + pos.ljust(4) + " n=" + str(counts.get(pos, 0)).rjust(6) +
                  "  intercept " + format(m.get("intercept", 0.0), ".4f") + "  " +
                  (terms or "(intercept only)"))
            if "zero" in coef[pos]:
                z = coef[pos]["zero"]
                zt = ", ".join(k + " " + format(v, ".4f") for k, v in
                               sorted(z.items(), key=lambda kv: -abs(kv[1]))
                               if k != "intercept" and abs(v) > 1e-4)[:200]
                print("       P(zero) logit intercept " + format(z["intercept"], ".4f") +
                      "  " + (zt or "(intercept only)"))
        print("  golden rows: " + str(len(artifact["golden"])))
        _ = np  # numpy is imported for parity with the trainer's environment check


if __name__ == "__main__":
    main()
