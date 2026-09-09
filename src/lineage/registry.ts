// THE NON-INGEST PRODUCERS: feature builders and model trainers, declared once so the lineage graph
// (src/lineage/dag.ts) can draw them beside the ingest registry (src/data/ingest.ts RAW_ASSETS +
// L1_ASSETS) instead of the Data page silently stopping at the board, which is where the interesting
// lineage -- feature tables, artifacts, the scorecard -- actually starts.
//
// Every `reads`/`writes` entry below was VERIFIED by grepping the named module for the tables it
// opens (`FROM <table>` / `INSERT INTO <table>`), not guessed from the command's docstring. See the
// per-producer comment for which file was checked.
import { SHIPPED_WEEKLY_ARTIFACT, CHALLENGER_WEEKLY_ARTIFACT } from "../weekly/projector.js";
import { STREAMING_ARTIFACT } from "../weekly/streamingServe.js";

export interface Producer {
  /** The `ff <verb>` that runs this producer, or a bare description for a python trainer with no
   *  direct `ff` verb (invoked through `tools/train_*.py`). */
  id: string;
  /** One line: what this producer does. */
  what: string;
  /** Tables (or artifact files) this producer reads. */
  reads: string[];
  /** Tables (or artifact files) this producer writes. */
  writes: string[];
}

export const PRODUCERS: Producer[] = [
  {
    id: "build-features",
    what: "the feature layer proper: rank-conditioned season and week features for the projection trainer",
    // verified: src/features/build.ts -- `FROM ranking`, `FROM ranking_history`, `FROM stg_player`,
    // `INSERT INTO feat_player_season`, `feat_player_week`, `feat_curve`
    reads: ["ranking", "ranking_history", "stg_player"],
    writes: ["feat_player_season", "feat_player_week", "feat_curve"],
  },
  {
    id: "build-features-ext",
    what: "extension features: point-in-time usage/injury/depth context that build-features does not carry",
    // verified: src/features/sources/seasonExt.ts (`INSERT INTO feat_player_season_ext`),
    // src/features/sources/weekContext.ts `buildWeekContext` (`INSERT INTO feat_player_week_context`,
    // reads raw_injury/raw_depth_chart/raw_snap_count/raw_participation/raw_nfl_game/stg_player/
    // feat_player_week), src/features/sources/coverage.ts (`INSERT INTO feat_coverage`)
    reads: ["stg_player", "raw_injury", "raw_depth_chart", "raw_snap_count", "raw_participation", "raw_nfl_game", "feat_player_week"],
    writes: ["feat_player_season_ext", "feat_player_week_context", "feat_coverage"],
  },
  {
    id: "build-live-context",
    what: "the CURRENT week's context (injury/depth/news) for a season already under way -- separate " +
      "from build-features-ext because it must see the current week's news/injury reports, which the " +
      "historical builder deliberately does not backdate",
    // verified: src/features/sources/weekContext.ts `buildLiveWeekContextInto`. It also SELECTs
    // player_sk/pos/team from feat_player_week_model to know which players are already tracked for
    // the target week -- a population filter, not a value dependency (it reads no feature VALUE from
    // that table) -- so it is not declared as a `reads` edge here: build-weekly-features reads this
    // producer's OWN output (feat_player_week_context) to build feat_player_week_model in the first
    // place, and declaring the reverse would make the graph cyclic for no real lineage reason.
    reads: ["stg_player", "raw_injury", "raw_depth_chart", "player_status", "news", "feat_player_week"],
    writes: ["feat_player_week_context"],
  },
  {
    id: "build-weekly-features",
    what: "the weekly-model feature table: per-player-week season line, trailing form, matchup and rest",
    // verified: src/weekly/features.ts -- reads feat_player_season/feat_player_week/
    // feat_player_week_context/team_odds, writes feat_player_week_model
    reads: ["feat_player_season", "feat_player_week", "feat_player_week_context", "team_odds"],
    writes: ["feat_player_week_model"],
  },
  {
    id: "assemble",
    what: "L1 player_value + L2 board: joins every reference table onto the projection curve",
    // verified: src/data/assemble.ts. Two writes are declared "reads" instead here because they are
    // NOT derived from what the read side of this list feeds:
    //  - `INSERT INTO player ... ON CONFLICT DO NOTHING` is a defensive backstop (a row shell for
    //    anyone referenced elsewhere but missing from `player`), not a transform of player_bio.
    //  - `INSERT INTO ranking (..., source='espn', ...)` writes a DIFFERENT source partition of the
    //    same table build-features reads (`source='fantasypros_ecr'`) -- the table is shared but the
    //    rows are not, so declaring it as a write here would draw a false
    //    ranking -> feat_player_season -> points.csv -> ranking cycle for two partitions that never
    //    actually feed each other. Table-level lineage cannot see the partition; this is the one
    //    place that limitation had to be resolved by hand rather than by a finer-grained node.
    reads: ["stg_player", "player_bio", "team_bye", "ranking", "adp", "market_value", "news",
      "raw_espn_eligibility", "player_value", "player_value_position", "board", "points.csv",
      "rank-outcomes.json", "correlation-model.json"],
    writes: ["player_value", "player_value_position", "board"],
  },
  {
    id: "project",
    what: "the rank curve: conditional-order-statistic points by position and rank, from real history",
    // verified: src/data/projections.ts -- reads feat_player_season + ranking_history, writes points.csv
    reads: ["feat_player_season", "ranking_history"],
    writes: ["points.csv"],
  },
  {
    id: "train_projection",
    what: "python trainer: fits the season projection artifact (curve + named features + p10/p50/p90 heads)",
    // verified: tools/train_projection.py -- `FROM feat_player_season`, `FROM feat_player_season_ext`
    reads: ["feat_player_season", "feat_player_season_ext"],
    writes: ["projection-artifact.json"],
  },
  {
    id: "train_weekly",
    what: "python trainer: fits the weekly model (shipped floor + the two-part challenger)",
    // verified: tools/train_weekly.py -- `FROM feat_player_week_model`
    reads: ["feat_player_week_model"],
    writes: [CHALLENGER_WEEKLY_ARTIFACT, SHIPPED_WEEKLY_ARTIFACT],
  },
  {
    id: "train_streaming",
    what: "python trainer: fits the streaming (matchup-only) model over the free-agent-eligible pool",
    // verified: tools/train_streaming.py -- `FROM feat_player_week_model`; src/weekly/streamingFeatures.ts
    // additionally builds feat_player_week_stream from feat_player_week/feat_player_week_model/raw_nfl_game
    reads: ["feat_player_week_model", "feat_player_week", "raw_nfl_game", "feat_player_week_stream"],
    writes: [STREAMING_ARTIFACT],
  },
  {
    id: "train_price",
    what: "python trainer: fits what this room actually pays, from the league's own auction history",
    // verified: tools/train_price.py -- `FROM fact_draft_pick`
    reads: ["fact_draft_pick"],
    writes: ["price-model.json"],
  },
  {
    id: "scorecard",
    what: "freezes predictions before kickoff (write-once) and scores them once actuals land",
    // verified: src/weekly/scorecard.ts -- reads feat_player_week_model, raw_espn_projection, league,
    // fact_team_season, scorecard_prediction; writes scorecard_prediction (INSERT OR IGNORE) and
    // scorecard_result
    reads: ["feat_player_week_model", "raw_espn_projection", "league", "fact_team_season", "scorecard_prediction"],
    writes: ["scorecard_prediction", "scorecard_result"],
  },
];
