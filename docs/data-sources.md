# Data sources: what we have, what we could have, and what each one feeds

`docs/data-layers.md` says what a RAW table is and why identity is decided once, in staging. This
document is the inventory that layer model implies and the repo never had: **one entry per source,
whether or not we ingest it**, with the four facts that decide whether a feature built on it can be
trusted.

The four facts, in order of how often getting them wrong has cost this repo real time:

1. **Grain and key.** What one row is, and what makes two rows distinct. `ranking_history` is keyed
   `(source, type, date, name_key, position)` because dropping `position` silently merged two men.
2. **As-of semantics.** *When was this knowable?* Not when we fetched it. A feature stamped with a
   fetch date is a leak wearing a timestamp. Feeds differ: nflverse schedules publish a closing line
   dated to kickoff; an injury report is dated to the day it was filed; the FFC ADP archive publishes
   the date window its drafts were sampled over.
3. **Seasons covered, measured.** Every range below was probed, not remembered. A source that starts
   in 2016 makes any feature built on it null for 17 of our 27 backtest seasons, and a model that
   silently imputes zero there will learn "2016 is when players started running routes".
4. **What consumes it.** A source with no consumer is not an asset, it is a download. Several rows
   below say `ingested-but-unused`, which is a real and useful state -- it means the fetch is proven
   and only the feature is missing.

Statuses used: **ingested** (a raw table is written and something reads it), **ingested-but-unused**
(written, nothing reads it), **proposed** (not written; the fetch path is verified here),
**evaluated-and-rejected** (measured, did not pay, with the reference).

Everything marked "measured" in this document was measured on 2026-09-08 by fetching the feed.

---

## 1. nflverse

Public CSV over HTTPS from GitHub release assets, no key, no rate limit we have hit. `src/data/nflverse.ts`
owns the URLs and the disk cache (`data/cache/<tag>.csv.gz`).

**A trap that applies to the whole section: nflverse asset names are per-tag and inconsistent.**
Some feeds ship one combined file (`draft_picks.csv`), some ship one file per season
(`injuries_2024.csv`) with NO combined file, and some ship both. Guessing a name produces a 404, and
a fetch wrapped in `try { } catch { return empty }` -- which is the pattern `features/build.ts`
already uses -- turns that 404 into a silently empty feature. The authoritative list is the GitHub
releases API: `https://api.github.com/repos/nflverse/nflverse-data/releases/tags/<tag>` returns every
asset name. Probe it before adding a feed; do not type a filename from memory.

### 1.1 Player weekly stats -- `stats_player_week_<season>.csv`

- **What.** One row per player per game, with our whole scoring vocabulary plus usage: `target_share`,
  `air_yards_share`, `wopr`, `racr`, `pacr`, EPA per phase.
- **Grain / key.** (season, week, player_id (gsis), season_type). 150 columns.
- **As-of.** The game. Knowable only after it is played -- so it may only ever appear in a feature
  row as **prior** information (`prior_*` in `feat_player_season`, `td_*` in `feat_player_week`).
- **Seasons.** 1999-2025 (cached locally as `pw-<season>.csv.gz`, all 27 present).
- **Raw table.** None. Read straight from the cache by `src/data/history.ts` and `src/features/build.ts`.
  This is a documented exception to the raw rule: the file cache *is* the raw layer for it, and
  materialising 27 seasons x ~5,000 rows x 150 columns into SQLite has no consumer today.
- **Feeds.** `history-points.csv`, `history-weekly.csv`, `feat_player_season.prior_*`,
  `feat_player_week.td_*`. Consumed by the projector, the opportunity model, the backtest.
- **Status.** ingested.
- **Unread columns** (from `scripts/nflverse-audit.mjs`, 46 of 150): the fumble-detail family
  (`sack_fumbles`, `rushing_fumbles`, `receiving_fumbles`, `fumble_recovery_*`, `fumbles_forced_by_opp`,
  `fumbles_not_forced`, `fumbles_out_of_bounds`), the field-goal *miss* detail (`fg_missed_0_19`
  through `fg_missed_60_`, `fg_pct`, `fg_*_list`, `fg_*_distance`), the punting family (`pt_*`, 14
  columns), `def_2pt_atts`/`def_2pt_made`, `gwfg_missed`/`gwfg_blocked`/`gwfg_distance`, `pat_blocked`,
  `pat_pct`, and `fantasy_points` (we compute our own under the league's rules, deliberately).
  Nothing in that list is obviously a season-long fantasy signal; the kicker distance detail is the
  only part worth a look, and only for K projection variance.

### 1.2 Team weekly stats -- `stats_team_week_<season>.csv`

- **Grain / key.** (season, week, team, season_type). 138 columns, the same vocabulary aggregated.
- **As-of.** The game; prior-only, as above.
- **Seasons.** 1999-2025.
- **Raw table.** None (file cache), same exception.
- **Feeds.** DST scoring in `history.ts` (points allowed / yards allowed by team-week).
- **Status.** ingested.
- **Unread columns.** The same 46 families as 1.1, plus `timeouts`.

### 1.3 Schedules / games -- `schedules/games.csv`

- **What.** One row per game, 46 columns. It is not just a calendar: it carries the **closing Vegas
  line** (`spread_line`, `total_line`, plus moneylines and side odds), **weather** (`temp`, `wind`),
  **venue** (`roof`, `surface`, `stadium`, `location`), **rest** (`away_rest`, `home_rest`), the
  result, and cross-source game ids (`gsis`, `pfr`, `espn`, `ftn`, `pff`).
- **Grain / key.** (game_id). Two teams per row -- a per-team view needs the row read twice, which is
  what `ingestByes` and `buildWeekFeatures` both do, separately.
- **As-of.** `gameday` for everything settled at kickoff. `spread_line` and `total_line` are the
  **closing** line, so they are knowable the day of the game and NOT a week earlier; `temp`/`wind` are
  observed, so they are strictly a game-time fact and using them as a *pre*-game feature is a leak
  unless the row is a same-day one. `away_rest`/`home_rest` are pure calendar and knowable in July.
- **Seasons.** 1999-2026, 7,549 rows, 2.2MB. Vegas lines are populated from 1999; `temp`/`wind` are
  sparse (dome games have neither).
- **Raw table.** `raw_nfl_game` (this branch). Previously only a derived slice landed, in `game`
  (season, week, team, opponent, home, spread_line, total_line) -- 544 rows, one season.
- **Feeds.** `game`, `team_bye`, `feat_player_week.{spread_line,total_line,implied_team_total}`,
  `feat_player_week_context.*` (this branch).
- **Status.** ingested.
- **Unread columns** (20 of 46): `overtime`, `old_game_id`, `nfl_detail_id`, `pff`, `ftn`,
  `away_moneyline`, `home_moneyline`, `away_spread_odds`, `home_spread_odds`, `under_odds`,
  `over_odds`, `away_qb_id`, `home_qb_id`, `away_qb_name`, `home_qb_name`, `away_coach`, `home_coach`,
  `referee`, `stadium_id`, `stadium`. `away_qb_id`/`home_qb_id` are the interesting pair: the starting
  quarterback is the single largest driver of a pass-catcher's week and we have never used it.

### 1.4 Snap counts -- `snap_counts_<season>.csv`

- **What.** Per player per game: `offense_snaps`, `offense_pct`, defense and special-teams equivalents.
- **Grain / key.** (season, week, pfr_player_id, game_id). **Keyed by PFR id, not gsis** -- the feed
  has no gsis column at all, so it can only reach `player_sk` through `player_xref` (source `pfr`) or
  through (name, position, team).
- **As-of.** The game; prior-only.
- **Seasons, measured.** Assets exist for 2012-2025 but **the 2012 file is a header and nothing else**
  -- which is exactly the shape that reads as "no snaps were taken in 2012" if a builder divides by
  a count it never checks. Real coverage is **2013-2025, 324,611 rows**: 23,799-23,890 a season
  through 2019, then 24,999 (2020) and 26,381-26,615 from 2021 (the 17-game schedule). No 2026 asset
  yet. `pfr_player_id` is present on 100% of rows; `as_of` resolves to a game day from
  `raw_nfl_game` on 100% of rows.
- **Raw table.** `raw_snap_count` (this branch).
- **Feeds.** `player_advanced.snap_pct` already ingests the CURRENT season only, name-keyed, via
  `src/data/advanced.ts`. The historical table is new and feeds `feat_player_week_context.prior_snap_share`
  and `feat_player_season_ext.prior_snap_share`.
- **Status.** ingested (this branch); the current-season slice was already ingested-and-used.

### 1.5 Participation -- `pbp_participation_<season>.csv`

- **What.** One row per PLAY, with `route` (the route the play's receivers ran), `players_on_play`,
  `offense_players` (semicolon-joined gsis ids), `offense_formation`, `defenders_in_box`,
  `time_to_throw`, `was_pressure`, coverage type.
- **Grain / key.** (nflverse_game_id, play_id). **Not a player-week grain.** Routes run per player
  must be aggregated by counting the plays a player's gsis id appears in `offense_players` on -- and
  `route` is a property of the PLAY, not of the player, so "routes run" from this feed means
  "pass plays this player was on the field for", which is the standard proxy and is not the same
  number a charting service sells.
- **As-of.** The game; prior-only.
- **Seasons, measured.** 2016-2025. 2016-2023 files carry 20 columns; 2024-2025 add
  `offense_names`, `defense_names`, `offense_positions`, `defense_positions`, `offense_numbers`,
  `defense_numbers`.
- **Cost.** **21-50MB per season, ~46,000 plays.** Ten seasons is roughly 400MB fetched and about
  460,000 rows to scan. This is by far the most expensive feed in this document, and the only one
  where the aggregation is a real computation rather than a column rename.
- **Raw table.** `raw_participation`, **aggregated to player-week** (see the ingester's header for why
  the play grain is not stored): `off_plays`, `pass_plays`, `games`, and the team denominators
  `team_off_plays` / `team_pass_plays` on the same row, so a share can never be computed against a
  denominator nobody can see.
- **Measured after ingesting 2016-2025:** 182,303 player-weeks, 17,524-19,149 a season, 21 weeks
  before 2021 and 22 after. `as_of` (the game day, joined from `raw_nfl_game`) resolves on 100%.
  Face validity, 2023 week 1: every starting quarterback is at 100% of his team's charted pass
  plays, and Keenan Allen at 33/33 is the top non-quarterback. 2026 has no asset yet.
- **Feeds.** `prior_route_share` in both new feature tables.
- **Status.** ingested (this branch).

### 1.6 FTN charting -- `ftn_charting_<season>.csv`

- **What.** Play-level charting: `is_play_action`, `is_screen_pass`, `is_rpo`, `is_motion`,
  `is_no_huddle`, `n_blitzers`, `is_catchable_ball`, `is_contested_ball`, `is_drop`,
  `is_interception_worthy`, `read_thrown`.
- **Grain / key.** (nflverse_game_id, ftn_play_id). Play level; **no player id at all** -- it joins to
  participation or pbp by play, not to a player directly.
- **As-of.** The game; prior-only.
- **Seasons, measured.** 2022-2025 only. 8.3MB / ~48,000 plays per season.
- **Feeds.** Nothing. Four seasons of a play-level feed with no player key is a poor fit for a
  season-long auction model: it cannot produce a per-player column without going through
  participation first, and it covers 4 of 27 backtest seasons.
- **Status.** proposed, low priority. Recorded here so the next person does not re-discover the
  4-season limit after building the join.

### 1.7 Next Gen Stats -- `nextgen_stats/ngs_{passing,receiving,rushing}.csv.gz`

- **What.** Receiving: `avg_cushion`, `avg_separation`, `avg_intended_air_yards`,
  `percent_share_of_intended_air_yards`, `avg_yac_above_expectation`. Rushing:
  `rush_yards_over_expected`, `percent_attempts_gte_eight_defenders`, `avg_time_to_los`,
  `efficiency`. Passing: `avg_time_to_throw`, `aggressiveness`, `completion_percentage_above_expectation`.
- **Grain / key.** (season, season_type, week, player_gsis_id). **Carries gsis directly**, which makes
  it one of the cheapest feeds to resolve. `week = 0` rows are season aggregates in the same file --
  a builder that does not filter them double-counts every player.
- **As-of.** The game; prior-only.
- **Seasons, measured.** Per-season assets exist 2016-2024; the combined `ngs_*.csv.gz` files carry
  the full history in one fetch (receiving 1.0MB / ~14,700 rows, passing 0.6MB, rushing 0.3MB).
  **Only players above a usage threshold appear** -- this is a leaderboard feed, not a census, so
  absence from it is not zero.
- **Raw table.** `raw_ngs`.
- **Status.** proposed.

### 1.8 Depth charts -- `depth_charts_<season>.csv`

- **What.** Where a player sits on his team's published depth chart.
- **Grain / key.** **Two incompatible schemas, and this is the trap.**
  - 2001-**2024**: `(season, club_code, week, game_type, depth_team, gsis_id, position,
    depth_position, formation)` -- one row per player per week per formation, `depth_team` is the
    rank (1 = starter). ~28,000-38,000 rows a season over 21-22 weeks.
  - **2025 and 2026: a completely different file** -- `(dt, team, player_name, espn_id, gsis_id,
    pos_grp_id, pos_grp, pos_id, pos_name, pos_abb, pos_slot, pos_rank)`. It is a **dated snapshot**
    keyed by `dt` (a timestamp), with no `week` column at all: 553,770 rows for 2025 over 219 dates
    and 504,563 for 2026 over 170 dates.
  - An ingester that reads `depth_team` silently produces zero rows for 2025-2026; one that reads
    `pos_rank` silently produces zero for every season before that. Measured -- an earlier draft of
    this document said the change began in 2026 because only the 2026 file had been probed.
  - **`dt` IS A TIMESTAMP AND THE FEED PUBLISHES MORE THAN ONE SNAPSHOT A DAY.** Measured on the
    2026 file: 505,422 rows, 500,611 distinct (date, team, player, pos_grp, pos_abb, pos_name,
    pos_slot) tuples, and **not one** of the 4,811 collisions was a byte-identical repeat. Keying on
    the date rather than the full timestamp therefore discards real, later snapshots in silence.
- **As-of.** The old schema: the week it describes, knowable before that week's games -- but the feed
  publishes no date, so `as_of` is NULL and the week anchor has to come from the schedule in the
  feature layer. The new schema: `dt` is literally the as-of, and `as_of` carries its date while the
  primary key carries the whole timestamp.
- **Seasons.** 2001-2026. 1999 and 2000 return HTTP 404.
- **Raw table.** `raw_depth_chart`, normalised across both schemas with the source schema recorded.
- **Feeds.** `depth_rank` in both new feature tables. `player_status.depth` already carries a live
  depth value from Sleeper (current season only, name-keyed).
- **Status.** ingested (this branch).

### 1.9 Injuries and practice reports -- `injuries_<season>.csv`

- **What.** The official weekly injury report: `report_status` (Out / Doubtful / Questionable),
  `practice_status`, and the injury descriptions.
- **Grain / key.** (season, week, team, gsis_id, game_type) plus the report date. **`date_modified`
  is the as-of**, and it is what makes this feed usable point-in-time at all: a Wednesday practice
  report and a Friday game-status report are different information about the same week.
- **Schema drift, measured after ingesting all 18 seasons.** 2009-**2024** carry 16 columns including
  `report_primary_injury`, `report_secondary_injury`, `practice_primary_injury`,
  `practice_secondary_injury` and `date_modified`. **2025 AND 2026 carry 13 different columns**: they
  add `season_type` and have **no `date_modified`, no `report_primary_injury`, no
  `report_secondary_injury` and no `practice_secondary_injury`**. (An earlier draft of this document
  said the change began in 2026, from probing the 2026 file alone; ingesting the whole range showed
  2025 had already switched. The ingester therefore reads the shape from each FILE's header rather
  than from the season number -- a guard keyed on the year is a guard keyed on a name, and it keeps
  passing after the thing it guards moves.) So for 2025 onward there is no report date in the feed
  and the as-of must be derived from the schedule, in the feature layer.
- **`as_of` coverage, measured.** 2009: **17 of 4,821 rows** carry `date_modified` -- the as-of is
  effectively absent for that season. 2010-2024: complete. 2025-2026: zero, by the drift above.
- **`report_status` is roughly half-populated from 2016 on** (2,430-2,828 of ~5,100-6,200 rows a
  year, against 4,200-5,300 of ~4,500-5,500 in 2010-2015). Most rows are practice reports with no
  game-status designation. Its vocabulary is `Out`, `Doubtful`, `Questionable`, `Probable`, `Note` --
  and **`Probable` was discontinued by the league after 2015**, so the vocabulary is not stable
  across the range either.
- **Seasons, measured.** 2009-2026, 90,763 rows. 1999-2008 return HTTP 404 -- injury reports do not
  exist in this commons before 2009, so any injury feature is structurally null for 10 of our 27
  backtest seasons.
- **Raw table.** `raw_injury`.
- **Feeds.** `feat_player_week_context.{report_status, practice_status, teammates_out}` and
  `feat_player_season_ext.injury_status`. `player_status` already carries a LIVE injury status from
  Sleeper for the current season, name-keyed.
- **Status.** ingested (this branch).

### 1.10 NFL draft picks -- `draft_picks/draft_picks.csv`

- **What.** The NFL draft (not our auction): round, pick, team, college, plus career totals.
- **Grain / key.** (season, round, pick). Carries `gsis_id` and `pfr_player_id`.
- **As-of.** Draft weekend -- late April of the player's rookie year, so it is knowable for every
  September 1 anchor from that year on. The career-total columns (`w_av`, `games`, `seasons_started`,
  `allpro`, `probowls`) are **lifetime as of the file's build date and are NOT point-in-time** --
  using them as a feature for a 2015 row leaks the player's 2016-2025 career into it. Only
  `season/round/pick/team/position` are safe.
- **Seasons, measured.** **1980-2026**, 12,927 rows, 1.7MB in one file. Hand-checked against the real
  drafts: 2023 has 259 selections and 2024 has 257, both over seven rounds (compensatory picks are
  why neither is round). `gsis_id` is present on 3,071 of the 3,078 picks from 2015 on.
- **Caveat already handled in `features/build.ts`.** The feed's `gsis_id` is a legacy PFR-style token
  for old drafts and a real gsis for modern ones; only the modern form can match.
- **Raw table.** `raw_nfl_draft_pick`.
- **Feeds.** `feat_player_season.{draft_year, draft_round, draft_pick}` (already), and the same three
  in `feat_player_season_ext` read from the raw table instead of re-fetching.
- **Status.** ingested (this branch); previously read from the file cache with no raw table.

### 1.11 Contracts -- `contracts/historical_contracts.csv.gz`

- **What.** Every contract OverTheCap holds: `year_signed`, `years`, `value`, `apy`, `guaranteed`,
  `apy_cap_pct`, plus `season_history`.
- **Grain / key.** One row per contract. **There is no gsis id.** The identity columns are `player`
  (a display name), `otc_id`, `date_of_birth`, `college`, `draft_year`, `draft_round`,
  `draft_overall`. So resolution must go name + birthdate, which is exactly the pair
  `player_identity` uses, or `otc_id` via `player_xref` if the crosswalk carries it.
- **As-of.** `year_signed` plus the contract length gives the window a contract was in force. The
  **contract-year flag** a model wants -- "is this his last year under contract?" -- is a derivation
  over (year_signed, years) evaluated at the season in question, and it is point-in-time safe.
  `is_active` and `inflated_*` are NOT: they are as-of the file build.
- **Seasons.** 31,893 contracts, 1.2MB, in one file.
- **Identity coverage, measured.** `date_of_birth` is present on **19,791 of 31,893 rows (62%)** --
  so the (name, birthdate) route the identity registry uses is available for under two thirds of
  contracts and the rest fall back to name plus position plus team.
- **Raw table.** `raw_contract`, keyed `(player_key, contract_no)` -- the feed has no per-contract id
  and a player can sign two deals in one year (an extension and a restructure), so `contract_no` is
  the index among that player's contracts in file order. Measured: more than 1,000 players have more
  than one.
- **`as_of` = `<year_signed>-03-01`**, when the NFL league year opens and a signing becomes public.
- **Status.** ingested (this branch).

### 1.12 Rosters (weekly) -- `weekly_rosters/roster_weekly_<season>.csv`

- **What.** The full ID crosswalk plus bio, **per week**: `gsis_id`, `espn_id`, `sportradar_id`,
  `yahoo_id`, `rotowire_id`, `pff_id`, `pfr_id`, `fantasy_data_id`, `sleeper_id`, `esb_id`,
  `smart_id`, plus `birth_date`, `height`, `weight`, `college`, `years_exp`, `entry_year`,
  `rookie_year`, `draft_club`, `draft_number`, `status`, `depth_chart_position`, `ngs_position`.
- **Grain / key.** (season, week, gsis_id). 14.9MB / ~46,600 rows for 2024.
- **As-of.** The week. This is the only feed that gives a **point-in-time TEAM** for a player --
  `players.csv` gives only `latest_team`, which is a today-fact and is wrong for every historical row.
- **Raw table.** None. The crosswalk half is already covered by `player_ids` (11,927 rows, from
  `src/data/playerIds.ts`).
- **Status.** proposed. The weekly-team column is the reason to want it: several joins currently use
  the team a player is on NOW to resolve who he was in 2014.

### 1.13 Players (bio) -- `players/players.csv`

- **Grain / key.** One row per player, keyed `gsis_id`. 39 columns.
- **As-of.** Today. `latest_team`, `last_season`, `status`, `ngs_status` are all current-state and are
  not point-in-time for any historical row.
- **Raw table.** `player_ids` (crosswalk) and `player_bio` (physicals). `player_bio` is **name-keyed**
  and is one of the tables `docs/data-layers.md` names as the cause of the age-curve bug.
- **Feeds.** birthdate -> `stg_player` -> `feat_player_season.age`.
- **Status.** ingested.
- **Unread columns** (13 of 39): `common_first_name`, `nfl_id`, `ngs_position_group`, `ngs_position`,
  `headshot`, `college_conference`, `last_season`, `latest_team`, `ngs_status`,
  `ngs_status_short_description`, `pff_position`, `pff_status`, `draft_team`.

### 1.14 Combine -- `combine/combine.csv`

- **Grain / key.** (draft_year, player). Name-keyed in our ingest -- `ingestBio` builds a
  `nameKey -> forty` map with "first non-empty wins", which is the loose kind of join this repo has
  been burned by; the comment there acknowledges it.
- **As-of.** February of the draft year.
- **Feeds.** `player_bio.forty` -> the board's `40yd` column.
- **Status.** ingested. **Unread columns:** `draft_team`, `draft_ovr`, `cfb_id`, `school`.

### 1.15 PFR advanced stats -- `pfr_advstats/advstats_week_{pass,rush,rec,def}_<season>.csv`

- **Grain / key.** (season, week, pfr_player_id). Weekly assets exist **2018-2025 only**; season-level
  `advstats_season_*.csv` covers more.
- **As-of.** The game; prior-only.
- **Raw table.** `player_advanced` holds a season-level slice for the CURRENT season, name-keyed,
  from `src/data/advanced.ts`.
- **Status.** ingested (current season only). The 2018+ weekly history is proposed and unbuilt.
- **Note.** The obvious URL guesses (`advstats_week_rec.csv`, `.csv.gz`) are **404** -- the weekly
  files are per season. This is the asset-naming trap from the section header.

### 1.16 ESPN QBR -- `espn_data/qbr_week_level.csv`

- **Grain / key.** (season, game_id, player_id) -- an ESPN player id, not gsis.
- **What.** `qbr_total`, `qbr_raw`, `pts_added`, `epa_total`, `qb_plays`, and a `qualified` flag.
- **Seasons.** 2.4MB / ~10,700 rows, weekly.
- **Status.** proposed, low priority for an auction model: it is a QB-only quality metric and the
  `away_qb_id`/`home_qb_id` columns in the schedules feed (1.3) are the cheaper way to get at the
  same "who is throwing" question for pass-catchers.

---

## 2. FantasyPros ECR archive

- **What.** The consensus expert ranking, scraped repeatedly through each offseason and season.
- **Grain / key.** `ranking_history (source, ecr_type, date, name_key, position)` -- **544,340 rows**,
  the largest table in the store. `position` is in the key because dropping it merged two men.
- **As-of.** `scrape_date`, and this feed is the reason the point-in-time rule exists here at all:
  the same player has a different consensus rank in June and in late August, and using the late one
  for a June decision is lookahead. `features/build.ts` restricts a season's preseason ECR to the
  **latest scrape in August or the first week of September**.
- **Seasons.** The archive backs the whole backtest range; per-season coverage is in `feat_coverage`.
- **Feeds.** `feat_player_season.{ecr_pos_rank, ecr_sd}`, `fact_draft_pick.consensus_*`, the
  conditional rank curve, the live board.
- **Status.** ingested, and heavily used.
- **Identity.** Name-keyed at the raw grain, resolved to `player_sk` at the feature grain by
  `buildSkResolver`. The raw table stays name-keyed on purpose -- that is the raw rule.

## 3. FantasyFootballCalculator ADP archive

- **What.** Real mock/redraft ADP by year and format from `https://fantasyfootballcalculator.com/api/v1/adp/<format>?teams=N&year=Y&position=all`.
  Public, no key, JSON. Per player: `adp`, `adp_formatted`, `times_drafted`, `high`, `low`, `stdev`, `bye`.
- **Grain / key.** (format, year, player). Response `meta` carries `type`, `teams`, `rounds`,
  `total_drafts`, `start_date`, `end_date`.
- **As-of.** `meta.end_date` -- the last day of the draft window the average was taken over. Measured
  examples: PPR 2024 is `2024-08-31..2024-09-01` over 1,371 drafts; PPR 2026 is `2026-09-01..2026-09-08`
  over 5,144. This is a genuine as-of and it is close to, but not the same as, the September 1 anchor.
- **TWO ARCHIVES ARE BACK-DATED, and using them at their own season's anchor is leakage.** Measured
  after ingesting all 60 season/format pairs: **`standard` 2008 and `standard` 2009 are both stamped
  `2010-06-20`** -- a window that closed after both of those seasons had been played. Every other
  pair is stamped in its own late August or early September. A test asserts exactly those two and no
  others, so a third appearing is a failure rather than a silent leak.
- **THE `teams` PARAMETER IS IGNORED. Measured, not assumed.** Requesting `teams=10` and `teams=14`
  for PPR 2024 returns **byte-identical player lists** (205 players, same `adp`, same `times_drafted`
  for every one), and **both responses' own `meta.teams` says `12`**. `teams=16` returns **HTTP 400**.
  So the "half-PPR at 12 / 14 / 16 teams" this league would actually want **cannot be obtained from
  this API**, and storing four team counts would be storing four copies of one row. We fetch
  `teams=12` only and record that fact in the table.
- **Seasons with data, measured** (players returned, `teams=12`, `position=all`):
  - `standard`: 2008-2026 (2007 empty). 145-226 players per year.
  - `ppr`: 2010-2026 (2007-2009 empty).
  - `half-ppr`: **2018-2026 only** -- nine years. Our league is half-PPR, so the format that matches
    it is the shortest archive of the three.
  - `2qb`: 2014-2026. `dynasty`: 2015-2026. `rookie`: 2014-2026 with 2024 and 2026 empty.
- **Raw table.** `raw_adp_history`.
- **Feeds.** `feat_player_season_ext.adp` (preseason market price, an independent second opinion to
  ECR). `adp` (192 rows) already holds the CURRENT season from the same API via `src/data/advanced.ts`.
- **Status.** ingested (this branch) for the history; the current season was already ingested.

## 4. Sleeper

- **What.** `players/nfl` (the full player dump with injury status and depth), and `players/nfl/trending/{add,drop}`.
- **Grain / key.** Sleeper player id; our ingest maps it to `name_key` and keeps only players already
  in our universe.
- **As-of.** Now. There is no archive -- **a Sleeper read is only ever a snapshot of today**, so it
  can feed the live board and can never feed a historical feature row. This is the cleanest example
  in the document of a source that is useful and structurally unable to be point-in-time.
- **Raw tables.** `player_status` (498 rows), `trending` (187 rows).
- **Status.** ingested (current season only, by construction).

## 5. ESPN, through the desktop app's bridge

Read-only HTTP through the app's logged-in webview (`src/browser/appBridge.ts`). No key; the session
is the credential. Everything below is a GET.

### 5.1 League history -- `raw_league_season`, `raw_league_team_season`, `raw_league_pick`, `raw_league_matchup`, `raw_league_division`

- **What.** Our own league: format per season (size, auction budget, PPR points, slot counts), every
  auction pick with its price and owner, per-team in-season activity (acquisitions, FAAB spent, drops,
  trades, lineup moves, acquisitions by week), the finish (wins, losses, points for, final rank,
  playoff seed), and the head-to-head schedule with divisions.
- **Grain / key.** `(league_id, season)`, `(league_id, season, team_id)`, `(league_id, season, pick_no)`,
  `(league_id, season, week, home_id)`, `(league_id, season, division_id)`. `pick_no` is the order the
  source returned.
- **As-of.** The season. Prices are the draft, activity is in-season, `final_rank` is after the
  playoffs -- so a row is a MIXTURE of as-ofs and the raw table keeps them all rather than picking one.
  Any feature built on it must choose: `price` is knowable in August, `final_rank` is not.
- **Seasons, measured.** 2018-2026 available; 2012-2017 return **HTTP 404** and are recorded
  `available=0` with the note. 15 season rows, 130 team-seasons, **1,658 picks**, 1,050 games.
  Per-season auction totals: 2018 $2,757, 2019 $2,789, 2020 $2,769, 2021 $2,772, 2022 $2,796,
  2023 $2,783, 2024 $2,767, 2025 $3,157, 2026 $3,148. The league went 14 -> 16 teams in 2025.
- **Fetch path and cost.** `ff ingest-raw league-history --seasons 2012-2026`, ~9s for 15 seasons.
- **Feeds.** `fact_draft_pick` (738 rows) is built from the same adaptor call today; it can now be
  rebuilt from the raw table instead. The price model and the inflation model are the consumers.
- **Status.** ingested (this branch). Before it, these rows existed only because a scratchpad script
  had been run once by hand -- the store's most league-specific data was not reproducible.

### 5.2 Projections, ownership, ADP, draft ranks

- **What.** ESPN's own projections and `percentOwned`, plus its draft rank and ADP, read from
  `kona_player_info` / the player-info views.
- **Grain / key.** ESPN player id; our ingest name-keys it.
- **As-of.** Now. ESPN publishes no archive we can reach, so these share Sleeper's limitation.
- **Raw tables.** `ownership` (192 rows), and the ESPN rank/ADP columns on the board.
- **Status.** ingested (current season only).

### 5.3 Rosters, free agents, matchups (live)

- **What.** `teams()`, `freeAgents()`, `matchups()` through the adaptor.
- **As-of.** Now.
- **Status.** ingested into operational state (`roster`, `matchup`), not into the pipeline.

## 6. Other ingested sources

| source | raw table | rows | grain | as-of | status |
|---|---|---|---|---|---|
| RSS news / injury feed | `news` | 81 | (name_key, category, asof) | `asof`, the item's own publish time | ingested |
| FantasyCalc market values | `market_value` | 199 | (name_key, format) | now | ingested |
| Boris Chen tiers | `boris_tier` | 151 | (name_key, position) | now | ingested |
| FantasyPros weekly ranks | `weekly_rank` | 1,614 | (name_key, week) | scrape | ingested |
| DynastyProcess trade values | `trade_value` | 452 | (name_key) | now | ingested |
| ESPN Vegas implied totals | `team_odds` | 32 | (team) | now | ingested |
| PFR season efficiency + snap % | `player_advanced` | 374 | (name_key) | current season | ingested |
| team byes | `team_bye` | 32 | (season, team) | derived from schedules | ingested |

## 7. Evaluated and rejected

These are in `docs/validation.md` and `docs/edges.md` with their numbers; they are listed here so a
future inventory pass does not re-propose them as new.

- **Per-manager behavioural profiles as a predictive feature.** Predicting an owner's held-out season
  from his own history is *worse* than assuming league-average (7.99pp vs 7.67pp, 44/92 wins). The
  data exists -- it is now `raw_league_team_season` -- and it does not generalise. See `CLAUDE.md`.
- **`multQB` as a positional multiplier.** Measured exactly 0.0 once the broader `aggr` lever shipped:
  it was the global shading effect wearing a costume. See `docs/validation.md`.
- **Three positional multipliers found on an older baseline.** Each looked like +1pp and then vanished
  or reversed sign when re-measured against the baseline that shipped.

---

## 8. Remaining name-keyed joins -- an inventory, not a migration

`docs/data-layers.md` step 2 is "move consumers onto the stable key one at a time". This is the list
of what has not moved. **Nothing here is changed by this branch**; it is written down so the next
migration can be scoped from a list rather than a grep.

A join is listed if it resolves a player by `nameKey(...)` or by a `name_key` column rather than by
`player_sk`.

**Ingest / pipeline (`src/data/`)**

| file | what it joins by name | risk |
|---|---|---|
| `advanced.ts` | `nameKey(player)` for PFR advanced, snap %, trade values, Sleeper status/trending, FFC ADP, FantasyCalc, Boris tiers -- 8 separate ingesters | every one of them writes a table the board reads |
| `assemble.ts` | last-year points, ESPN rank/ADP, `player_bio`, FFC ADP, FantasyCalc; `stgByName` groups `stg_player` BY NAME to detect ambiguity, then attaches `player_sk` by `(name_key, position)` with a name-only fallback | the board itself; the fallback is the guessing step the layer model forbids |
| `ingest.ts` | `ingestEcr` mints `player_id = nameKey(player)`; `ingestBio` matches combine 40s by name_key with first-wins | `player.player_id` IS a name key, which is why everything downstream is |
| `news.ts` | `nameKey(r.player)` to tag an RSS item to a player | a mis-tagged headline, low stakes |
| `ecrHistory.ts` | name_key + position (the key that was fixed once already) | the archive |
| `projections.ts` | `${season}|${nameKey(name)}|${pos}` to join actuals for curve fitting | a fit input |

**Draft runtime and agent**

| file | what it joins by name |
|---|---|
| `draft/simContext.ts` | bye weeks by `nameKey(name)`; roster rows by `nameKey(b.name)` |
| `draft/values.ts`, `draft/strategy.ts` | the value book is keyed by name |
| `agent/agent.ts` | roster position lookup and the ownership snapshot, both `nameKey(...)` |
| `league/index.ts` | `resolvePlayer` and the projection lookup are name-based by design (a human types a name) |

**Feature/fact layer (already resolved, listed for completeness)**

`features/build.ts` and `features/picks.ts` both carry `name_key` as an ATTRIBUTE and key on
`player_sk` (`featKey` falls back to `NK:<name>|<pos>` and marks the row unresolved rather than
guessing). That is the intended end state.

**Scripts** (13 files: `add-opportunity-sk.mjs`, `analyze-mocks.mjs`, `fit-age-curve.mjs`,
`lib-roster.mjs`, `opponent-roster.mjs`, `playoff-sos.mjs`, `power-rankings.mjs`, `season-odds.mjs`,
`sim-convergence.mjs`, `trade-odds.mjs`, `waiver-check.mjs`, `waiver-targets.mjs`, `win-win.mjs`)
all resolve players by name. Most are analysis one-offs against a live roster, where a name is the
input the user gives; `fit-age-curve.mjs` is the exception that matters, because it is a FIT and a
name-keyed fit produces a coefficient rather than an error.
