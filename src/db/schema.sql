-- ff-assistant single-store schema (better-sqlite3). Idempotent: safe to re-run.
-- Aligns with docs/specs/spec-data-model.md plus the draft/board layer this app needs now.
--
-- CANONICAL PLAYER KEY = name_key (normalized name, mirrors src/draft/values.ts nameKey). EVERY
-- player_id column across every layer is a name_key, so tables join to `player`. Source-native ids
-- (gsis/fp/espn) ride alongside on `player` for a future stable-id crosswalk.
--
-- LAYERS (each has distinct refresh semantics -- do not mix them):
--   L0 identity & config   settings, player                              (slow-changing)
--   L1 reference facts      player_bio, player_value, ranking, team_bye, news   (FULL-REFRESH per ingest)
--   L2 presentation         board                                        (MATERIALIZED view of L1; ONE writer = the assembler)
--   L3 draft runtime        draft, draft_pick, draft_state, my_roster    (LIVE-UPSERT, per draft session)
--   L4 governance           usage_log, action_log                        (APPEND-ONLY logs)
--   L5 in-season (future)   league, roster, projection, matchup          (per league; unused until in-season)

-- ============================ L0: identity & config ============================

-- key-value app settings ('config' JSON = budget/slots/flex_ok/season; 'last_ingest'; ...)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT
);

-- canonical player identity (player_id = name_key). source ids are the crosswalk seam.
CREATE TABLE IF NOT EXISTS player (
  player_id   TEXT PRIMARY KEY,      -- name_key
  name        TEXT,
  position    TEXT,
  nfl_team    TEXT,
  status      TEXT,                  -- in-season use: active|questionable|doubtful|out|ir|bye
  gsis_id     TEXT,
  fp_id       TEXT,
  espn_id     TEXT,
  updated_at  TEXT
);

-- ================== L1: reference facts (FULL-REFRESH per ingest) ==================

-- physicals + combine
CREATE TABLE IF NOT EXISTS player_bio (
  player_id      TEXT PRIMARY KEY REFERENCES player(player_id),
  height         TEXT,
  weight         INTEGER,
  forty          REAL,
  birth_date     TEXT,
  rookie_season  INTEGER,
  exp            INTEGER,
  college        TEXT,
  updated_at     TEXT
);

-- OUR valuation + draft-season projection (proj_pts here is the full-season number; the L5
-- `projection` table is the in-season WEEKLY grain -- different things, do not conflate)
CREATE TABLE IF NOT EXISTS player_value (
  player_id   TEXT PRIMARY KEY REFERENCES player(player_id),   -- legacy name_key
  player_sk   INTEGER REFERENCES player_identity(player_sk),  -- stable identity: join HERE, not on the name
  season      INTEGER,
  our_value   INTEGER,
  our_rank    INTEGER,
  pos_rank    TEXT,
  tier        TEXT,
  proj_pts    REAL,
  last_pts    REAL,
  last_gms    INTEGER,
  updated_at  TEXT
);

-- per-source consensus rankings: one row per (player, source, season) -- ECR, ESPN, ...
-- (bye here is the SOURCE-reported bye; team_bye is the canonical schedule-derived one)
CREATE TABLE IF NOT EXISTS ranking (
  player_id     TEXT,
  source        TEXT,                -- 'fantasypros_ecr' | 'espn' | ...
  season        INTEGER,
  overall_rank  REAL,
  pos_rank      TEXT,
  best          INTEGER,
  worst         INTEGER,
  adp           REAL,
  rostered_pct  REAL,
  bye           INTEGER,
  fetched_at    TEXT,
  PRIMARY KEY (player_id, source, season)
);

-- advanced usage/efficiency from prior-season nflverse (snap_counts + PFR advanced): the talent/
-- usage signal beyond consensus. Prior full season; keyed by name_key.
CREATE TABLE IF NOT EXISTS player_advanced (
  player_id   TEXT PRIMARY KEY REFERENCES player(player_id),
  season      INTEGER,
  snap_pct    REAL,                     -- snap_counts: avg offensive snap share
  targets     INTEGER,                  -- PFR: season targets
  adot        REAL,                     -- PFR: avg depth of target
  yac_r       REAL,                     -- PFR: yards-after-catch per reception
  drop_pct    REAL,                     -- PFR: drop rate %
  updated_at  TEXT
);

-- dynastyprocess redraft/dynasty trade values (for the agent's trade analysis)
CREATE TABLE IF NOT EXISTS trade_value (
  player_id   TEXT PRIMARY KEY REFERENCES player(player_id),
  value_1qb   INTEGER,                  -- 1-QB league trade value
  value_2qb   INTEGER,                  -- superflex value
  age         REAL,
  draft_year  INTEGER,
  updated_at  TEXT
);

-- Sleeper live player status: current injury designation + depth-chart order (more real-time than
-- the nflverse/RSS injury signals)
CREATE TABLE IF NOT EXISTS player_status (
  player_id     TEXT PRIMARY KEY REFERENCES player(player_id),
  injury_status TEXT,                   -- Questionable | Doubtful | Out | IR | PUP | ...
  injury_body   TEXT,
  depth_order   INTEGER,                -- 1 = starter
  roster_status TEXT,                   -- Active | Inactive
  updated_at    TEXT
);

-- Vegas implied team totals from ESPN's free odds feed (offensive environment; streaming/DST signal)
CREATE TABLE IF NOT EXISTS team_odds (
  team          TEXT PRIMARY KEY,
  opponent      TEXT,
  spread        REAL,                   -- team's line (negative = favored)
  total         REAL,                   -- game over/under
  implied_total REAL,                   -- team's implied points
  updated_at    TEXT
);

-- Fantasy Football Calculator real draft-market ADP (where players actually go) + draft range.
-- The signal our ECR rank lacks: consensus rank vs ADP = the draft-day value gap.
CREATE TABLE IF NOT EXISTS adp (
  player_id     TEXT PRIMARY KEY REFERENCES player(player_id),
  adp           REAL,                   -- average draft position
  high          INTEGER,                -- earliest drafted
  low           INTEGER,                -- latest drafted
  stdev         REAL,
  times_drafted INTEGER,
  scoring       TEXT,                   -- FFC format used (standard | half-ppr | ppr)
  scraped       TEXT
);

-- FantasyCalc market values: trade values derived from thousands of REAL trades, plus 30-day
-- momentum and a Sleeper/ESPN id crosswalk. Distinct from dynastyprocess trade_value (a second,
-- trade-market opinion) and carries the trend our static values don't.
CREATE TABLE IF NOT EXISTS market_value (
  player_id    TEXT PRIMARY KEY REFERENCES player(player_id),
  value        INTEGER,
  overall_rank INTEGER,
  pos_rank     INTEGER,
  trend_30d    INTEGER,                 -- 30-day value change (momentum)
  adp          REAL,
  tier         INTEGER,
  sleeper_id   TEXT,                    -- crosswalk seam
  espn_id      TEXT,
  updated_at   TEXT
);

-- Sleeper league-wide add/drop counts (last 24h): the waiver/hype pulse.
CREATE TABLE IF NOT EXISTS trending (
  player_id TEXT,
  kind      TEXT,                       -- add | drop
  count     INTEGER,
  scraped   TEXT,
  PRIMARY KEY (player_id, kind)
);

-- FantasyPros WEEKLY positional rankings (current week) -- the in-season start/sit signal
CREATE TABLE IF NOT EXISTS weekly_rank (
  player_id   TEXT,
  pos         TEXT,
  rank        INTEGER,
  ecr         REAL,
  best        INTEGER,
  worst       INTEGER,
  sd          REAL,
  scraped     TEXT,
  PRIMARY KEY (player_id, pos)
);

-- Boris Chen tiers: GMM clustering of expert consensus into positional tiers. The distinct signal
-- vs our own value is the TIER BREAK (where the cluster boundary falls) -- the reach-now/wait cue.
CREATE TABLE IF NOT EXISTS boris_tier (
  player_id  TEXT,
  pos        TEXT,
  tier       INTEGER,               -- 1 = top cluster
  pos_rank   INTEGER,               -- order within position (file order)
  scoring    TEXT,                  -- STD | HALF | PPR
  scraped    TEXT,
  PRIMARY KEY (player_id, pos)
);

-- schedule-derived team byes (the canonical bye)
CREATE TABLE IF NOT EXISTS team_bye (
  season  INTEGER,
  team    TEXT,
  bye     INTEGER,
  PRIMARY KEY (season, team)
);

-- The full season schedule, ONE ROW PER TEAM PER GAME (both directions), so "who does X play in
-- week 16" is a point query. We already download this file to derive byes; keeping the opponent map
-- is what makes playoff-weeks strength of schedule answerable offline.
--
-- spread_line/total_line are the BOOKS' lines and are NULL for weeks not yet posted (in September
-- only ~weeks 1-7 carry them). They fill in as the season runs, which is why a week-15 SOS computed
-- at the trade deadline is far better grounded than one computed in preseason.
--
-- SIGN CONVENTION: spread_line here matches team_odds -- NEGATIVE means THIS team is favoured.
-- nflverse's raw games.csv uses the opposite (positive = HOME favoured); ingestSchedule flips it.
CREATE TABLE IF NOT EXISTS game (
  season      INTEGER,
  week        INTEGER,
  team        TEXT,
  opponent    TEXT,
  home        INTEGER,               -- 1 = team is at home
  spread_line REAL,                  -- negative = this team favoured; NULL until the book posts it
  total_line  REAL,
  PRIMARY KEY (season, week, team)
);

-- news / flags. player_name/pos/team are denormalized so the feed renders without a join AND
-- survives news about a player outside the ranking universe (so NO FK on player_id here).
CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT,                 -- name_key (joins player when present)
  player_name  TEXT,
  pos          TEXT,
  team         TEXT,
  category     TEXT,                 -- injury | headline | trending | role
  severity     TEXT,                 -- high | medium | low
  detail       TEXT,
  source       TEXT,
  asof         TEXT,
  url          TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_player ON news(player_id);

-- ============= L2: presentation (MATERIALIZED view of L1; ONE writer) =============

-- the fully-assembled per-player row the Players UI consumes (row_json keyed by display headers).
-- Derived entirely from L1 by the assembler; rebuilt wholesale each assembly. NOT a source of
-- truth -- the engine/agent read L1. Rebuild this whenever L1 changes.
CREATE TABLE IF NOT EXISTS board (
  player_id   TEXT,                  -- legacy name_key
  player_sk   INTEGER REFERENCES player_identity(player_sk),  -- stable identity: join HERE, not on the name
  season      INTEGER,
  row_json    TEXT,
  updated_at  TEXT,
  PRIMARY KEY (player_id, season)
);

-- ================= L3: draft runtime (LIVE-UPSERT, per session) =================

-- draft-session registry. 'local' = the app's working board. `kind` gates safety: the agent must
-- NEVER auto-bid a draft whose kind='real'.
CREATE TABLE IF NOT EXISTS draft (
  draft_id    TEXT PRIMARY KEY,      -- 'local' | a session id the engine creates
  kind        TEXT,                  -- 'local' | 'practice' | 'real'
  platform    TEXT,                  -- 'espn' | 'yahoo'
  league_id   TEXT,
  season      INTEGER,
  status      TEXT,                  -- 'active' | 'done'
  started_at  TEXT,
  updated_at  TEXT
);

-- every pick made in a draft (append per pick)
CREATE TABLE IF NOT EXISTS draft_pick (
  draft_id     TEXT REFERENCES draft(draft_id),
  pick_no      INTEGER,
  player_id    TEXT,                 -- name_key
  team         TEXT,
  price        INTEGER,
  nominated_by TEXT,
  ts           TEXT,
  PRIMARY KEY (draft_id, pick_no)
);

-- the live per-tick snapshot (one row per draft, upserted); state_json holds the full payload
CREATE TABLE IF NOT EXISTS draft_state (
  draft_id        TEXT PRIMARY KEY REFERENCES draft(draft_id),
  updated_at      TEXT,
  round           INTEGER,
  paused          INTEGER,
  on_block_player TEXT,              -- display name (live DOM snapshot)
  on_block_pos    TEXT,
  bid             INTEGER,
  live_inflation  REAL,
  our_budget      INTEGER,
  our_spent       INTEGER,
  our_filled      INTEGER,
  state_json      TEXT
);

-- MY drafted team (replaces the renderer's localStorage team). player_id = name_key so it joins
-- player_value -- the agent enriches my team with value/pos. name kept for display.
CREATE TABLE IF NOT EXISTS my_roster (
  draft_id   TEXT REFERENCES draft(draft_id),
  player_id  TEXT,                   -- name_key
  name       TEXT,                   -- display name
  slot       TEXT,
  price      INTEGER,
  PRIMARY KEY (draft_id, player_id)
);

-- ==================== L4: governance (APPEND-ONLY logs) ====================

CREATE TABLE IF NOT EXISTS usage_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT,
  run_id             TEXT,
  run_type           TEXT,           -- 'chat' | 'lineup' | 'waiver' | 'injury_check'
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS action_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT,
  run_id       TEXT,
  run_type     TEXT,
  action       TEXT,
  detail_json  TEXT,
  status       TEXT,                 -- planned | done | failed | skipped
  reason       TEXT
);

-- ================= L5: in-season (future; per league; unused now) =================

CREATE TABLE IF NOT EXISTS league (
  league_id      TEXT PRIMARY KEY,
  platform       TEXT,
  name           TEXT,
  season         INTEGER,
  team_id        TEXT,
  scoring_json   TEXT,
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS roster (
  league_id   TEXT,
  player_id   TEXT,
  slot        TEXT,
  is_starter  INTEGER,
  snapshot_at TEXT,
  PRIMARY KEY (league_id, player_id, snapshot_at)
);
CREATE TABLE IF NOT EXISTS projection (
  league_id   TEXT,
  player_id   TEXT,
  week        INTEGER,
  source      TEXT,
  proj_points REAL,
  fetched_at  TEXT,
  PRIMARY KEY (league_id, player_id, week, source)
);
-- who owns each player in a league (all teams' rosters) -- the board's per-league ownership overlay.
CREATE TABLE IF NOT EXISTS ownership (
  league_id    TEXT,
  player_id    TEXT,                  -- name_key
  owner        TEXT,                  -- manager display name
  team_abbrev  TEXT,
  slot         TEXT,                  -- lineup slot they're rostered in
  team_id      TEXT,                  -- ESPN numeric team id; joins to league.team_id to find OURS
  updated_at   TEXT,
  PRIMARY KEY (league_id, player_id)
);

-- ===================== IDENTITY REGISTRY: the durable surrogate key =====================
-- player_sk is minted ONCE and never changes. Source ids (gsis, espn, ...) are ATTRIBUTES held in
-- player_xref, never the identity itself -- a natural key moves when the attribute moves, which
-- breaks every stored reference. See docs/data-layers.md and src/data/identity.ts.
CREATE TABLE IF NOT EXISTS player_identity (
  player_sk    INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate; never reused, never renumbered
  name_key     TEXT,
  birthdate    TEXT,               -- the stable discriminator. POSITION IS NOT ONE: it is
                                   -- multi-valued (ESPN grants RB/WR eligibility), time-varying
                                   -- (Bredeson RB->TE) and source-specific (PK vs K). Keying on it
                                   -- split 178 real players into two surrogate keys each.
  primary_position TEXT,           -- an ATTRIBUTE, freely updatable; never part of identity
  first_name   TEXT,               -- the name we first saw; display names change, keys must not
  matched_by   TEXT,               -- how identity was decided, for debugging a merge later
  created_at   TEXT
);
-- Uniqueness on (name_key, birthdate). SQLite treats NULLs as distinct, which is the behaviour we
-- want: two players with the same name and no known birthdate stay separate rather than colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_natural ON player_identity (name_key, birthdate);

-- Position ELIGIBILITY, many per player. ESPN qualifies a player at several positions at once, so a
-- single position column cannot hold the truth -- and holding it on the identity row made position
-- changes look like new people.
CREATE TABLE IF NOT EXISTS player_position (
  player_sk  INTEGER REFERENCES player_identity(player_sk),
  position   TEXT,
  source     TEXT,
  PRIMARY KEY (player_sk, position, source)
);
CREATE INDEX IF NOT EXISTS idx_pos_sk ON player_position (player_sk);

-- One row per (source, source_id). MANY per player: a single espn_id column cannot express a player
-- with two ids, nor an id later reassigned. UNIQUE on (source, source_id) is what makes a disputed
-- id -- ten gsis ids belong to two people each -- a REFUSED link rather than a silent overwrite.
CREATE TABLE IF NOT EXISTS player_xref (
  player_sk    INTEGER REFERENCES player_identity(player_sk),
  source       TEXT,               -- gsis | espn | sleeper | fantasypros
  source_id    TEXT,
  created_at   TEXT,
  PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_xref_sk ON player_xref (player_sk);

-- ======================= STAGING: conformed, identity decided =======================
-- The layer this store never had. Raw feeds land keyed by whatever the source used (usually a
-- name) and every consumer re-solved identity for itself -- which shipped three bugs in one week,
-- the last a +19.5% markup on a player aged with another man's birth year. See docs/data-layers.md.
--
-- Keyed by player_sk from the identity registry. It was keyed by a NATURAL key derived from the
-- player's own attributes (gsis, else POS:name_key), which moves whenever an attribute moves -- a
-- player learning his gsis, or reclassified RB -> TE, silently changed identity. See identity.ts.
-- Legacy note, kept because the old text is still true of what it described:
-- player_key was the gsis id where one exists (stable across seasons and feeds) and pos:name_key
-- where it does not. Never a bare name_key: that is the thing being fixed.
CREATE TABLE IF NOT EXISTS stg_player (
  player_sk      INTEGER PRIMARY KEY REFERENCES player_identity(player_sk),
  name_key       TEXT,               -- the legacy join key, kept for migration
  name           TEXT,
  position       TEXT,
  team           TEXT,
  birthdate      TEXT,
  gsis_id        TEXT,
  espn_id        TEXT,
  sleeper_id     TEXT,
  fantasypros_id TEXT,
  ambiguous      INTEGER,            -- 1 = this name_key stands for more than one real player
  source         TEXT,               -- playerids | board (board = we lack ids for him)
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_stg_namekey ON stg_player (name_key, position);
CREATE INDEX IF NOT EXISTS idx_stg_ambig ON stg_player (ambiguous);

-- CROSS-SOURCE PLAYER IDENTITY (DynastyProcess db_playerids). The player table has carried empty
-- gsis_id/espn_id columns since the start with a comment calling them the crosswalk seam; this is
-- the table that fills them. Keyed on (name_key, position) because name_key ALONE merges distinct
-- people: A.J. Green is both a WR and a DB, Anthony Brown both a QB and a DB.
CREATE TABLE IF NOT EXISTS player_ids (
  name_key       TEXT,
  position       TEXT,
  name           TEXT,
  team           TEXT,
  birthdate      TEXT,
  gsis_id        TEXT,               -- nflverse / play-by-play
  espn_id        TEXT,
  sleeper_id     TEXT,
  yahoo_id       TEXT,
  pfr_id         TEXT,
  fantasypros_id TEXT,
  mfl_id         TEXT,
  sportradar_id  TEXT,
  updated_at     TEXT,
  PRIMARY KEY (name_key, position)
);
CREATE INDEX IF NOT EXISTS idx_pids_gsis ON player_ids (gsis_id);
CREATE INDEX IF NOT EXISTS idx_pids_espn ON player_ids (espn_id);

-- Historical FantasyPros ECR (DynastyProcess db_fpecr archive). Distinct from `ranking`, which
-- holds ONE row per (player, source, season) and so cannot answer what the market believed in a
-- PAST season -- which is what every backtest currently substitutes prior-season finishing rank for.
CREATE TABLE IF NOT EXISTS ranking_history (
  source       TEXT,                 -- fantasypros
  ecr_type     TEXT,                 -- ro/rp = redraft overall/positional, wo/wp = weekly
  season       INTEGER,
  scrape_date  TEXT,                 -- ISO date; preseason vs in-season matters, do not mix them
  player_id    TEXT,                 -- name_key, joins to player
  name         TEXT,
  pos          TEXT,
  team         TEXT,
  ecr          REAL,                 -- expert consensus rank
  sd           REAL,                 -- dispersion of expert opinion
  best         REAL,
  worst        REAL,
  fetched_at   TEXT,
  -- POSITION IS PART OF THE KEY. name_key alone merges distinct people who share a name:
  -- "A.J. Green" is both a WR and a DB, "Anthony Brown" both a QB and a DB. Without pos in the key
  -- one silently overwrites the other on any shared scrape date -- 64 ids spanned multiple positions
  -- in the first load. It also keeps a genuine reclassification (Ojulari LB -> EDGE) as two rows,
  -- which is the honest record of what the rankers actually published.
  PRIMARY KEY (source, ecr_type, scrape_date, player_id, pos)
);
CREATE INDEX IF NOT EXISTS idx_rankhist_season ON ranking_history (season, ecr_type, scrape_date);
CREATE INDEX IF NOT EXISTS idx_rankhist_player ON ranking_history (player_id, season);

CREATE TABLE IF NOT EXISTS matchup (
  league_id        TEXT,
  week             INTEGER,
  opponent_team_id TEXT,
  my_proj          REAL,
  opp_proj         REAL,
  fetched_at       TEXT,
  PRIMARY KEY (league_id, week)
);

-- ================= FEATURE LAYER: feat_* =================
--
-- POINT-IN-TIME feature tables, one row per (entity, time), carrying only what was knowable at
-- `as_of` plus the TARGET the model is fitted against. Derived, single-writer (src/features/build.ts
-- via `ff build-features`), and droppable: everything here is rebuildable from raw + staging + the
-- nflverse cache.
--
-- WHY THIS LAYER EXISTS. Before it, every fit script re-derived the same three things from scratch --
-- prior-year finish rank, prior-season usage, and the rank curve -- each with its own copy of the
-- code, its own season range, and its own name-keyed join. There were at least three separate curve
-- builders in scripts/. Copies drift, and a copy that drifts inside a fit script produces a NUMBER,
-- not an error. One table, one writer, one definition of each feature.
--
-- THE KEY IS TEXT, not the surrogate integer, and that is deliberate. It holds a `player_sk`
-- rendered as text for a person, `DST:<TEAM>` for a team defense (which is not a person and has no
-- row in the identity registry), and NULL where identity could not be resolved -- a state that is
-- recorded rather than dropped. See src/data/skResolve.ts.

CREATE TABLE IF NOT EXISTS feat_player_season (
  feat_key        TEXT,              -- player_sk, or 'NK:<name_key>|<pos>' when unresolved
  player_sk       TEXT,              -- the stable key; NULL when unresolved (row is KEPT and marked)
  season          INTEGER,
  as_of           TEXT,              -- ISO date. Preseason rows are '<season>-09-01'.
  name            TEXT,
  name_key        TEXT,
  pos             TEXT,
  team            TEXT,
  -- ------- knowable before as_of -------
  prior_pos_rank  INTEGER,           -- finish rank at this position in season-1
  prior_pts       REAL,
  prior_games     INTEGER,
  age             REAL,              -- years at as_of, from the identity registry's birthdate
  prior_fd        REAL,              -- prior-season usage PER GAME
  prior_ts        REAL,
  prior_attempts  REAL,
  prior_rush_yards REAL,
  prior_air_yards_share REAL,
  prior_wopr      REAL,
  team_changed    INTEGER,           -- 1 = different team from season-1
  draft_year      INTEGER,
  draft_round     INTEGER,
  draft_pick      INTEGER,
  ecr_pos_rank    REAL,              -- preseason consensus positional rank (see build.ts for source)
  ecr_sd          REAL,
  -- The conditional curve evaluated point-in-time: fitted ONLY on seasons strictly before `season`.
  -- Two of them because the two consumers index the curve at different ranks -- the board at ECR,
  -- the backtest at prior-year finish -- and a single column would have to pick one and silently be
  -- wrong for the other caller.
  curve_value_prior REAL,
  curve_value_ecr   REAL,
  curve_value_orderstat REAL,        -- the pre-2026-09-08 order statistic, kept for regression only
  -- ------- TARGETS (never features; a projector must not read these) -------
  pts             REAL,
  games           INTEGER,
  -- DERIVED FROM THE TARGET, and therefore a target itself: this season's own finish rank. It is
  -- here because the NEXT season's row needs it as `prior_pos_rank`, and deriving it in two places
  -- is how the two would come to disagree. A model must never read it for its own season.
  pos_rank        INTEGER,
  updated_at      TEXT,
  PRIMARY KEY (season, feat_key)
);

-- The point-in-time curve itself, one row per (season, kind, position, rank), so a consumer can read
-- the curve for season Y at ANY rank rather than only at the ranks that happen to appear on a
-- feature row. The backtest needs exactly that: its draft pool is the players who scored in Y-1, and
-- some of them never appear in Y at all.
CREATE TABLE IF NOT EXISTS feat_curve (
  season          INTEGER,
  kind            TEXT,              -- conditional | orderstat
  pos             TEXT,
  rank            INTEGER,           -- 1-based
  value           REAL,
  updated_at      TEXT,
  PRIMARY KEY (season, kind, pos, rank)
);
CREATE INDEX IF NOT EXISTS idx_feat_season_pos ON feat_player_season (season, pos);
CREATE INDEX IF NOT EXISTS idx_feat_sk ON feat_player_season (player_sk, season);

CREATE TABLE IF NOT EXISTS feat_player_week (
  feat_key        TEXT,
  player_sk       TEXT,
  season          INTEGER,
  week            INTEGER,
  as_of           TEXT,              -- the day before that week's first game, else its Tuesday
  name            TEXT,
  pos             TEXT,
  team            TEXT,
  opponent        TEXT,
  home            INTEGER,
  spread_line     REAL,              -- from the nflverse schedules feed, as published
  total_line      REAL,
  implied_team_total REAL,           -- derived: total/2 + spread/2 from this team's point of view
  is_bye          INTEGER,
  -- usage TO DATE through week-1, per game played. Strictly prior information.
  td_games        INTEGER,
  td_fd           REAL,
  td_ts           REAL,
  td_attempts     REAL,
  td_rush_yards   REAL,
  td_pts          REAL,
  -- ------- TARGET -------
  pts             REAL,
  updated_at      TEXT,
  PRIMARY KEY (season, week, feat_key)
);
CREATE INDEX IF NOT EXISTS idx_featwk_sk ON feat_player_week (player_sk, season, week);

-- ================= FACT LAYER: one row per real event =================
--
-- fact_draft_pick is one row per pick actually made in THIS league, with the market consensus as it
-- stood at the time. It is the training set a price model needs and the store had nowhere to put:
-- `draft_pick` is draft-RUNTIME state (keyed by a live draft_id, empty between drafts), which is a
-- different thing from the historical record.
CREATE TABLE IF NOT EXISTS fact_draft_pick (
  season          INTEGER,
  league_id       TEXT,
  team_id         TEXT,
  owner           TEXT,
  team_name       TEXT,
  player_sk       TEXT,              -- NULL when unresolved; the row is kept and counted
  name            TEXT,
  name_key        TEXT,
  pos             TEXT,
  price           INTEGER,
  pick_order      INTEGER,
  draft_date      TEXT,              -- NULL where unknown; consensus then falls back, see build.ts
  consensus_asof  TEXT,              -- the scrape_date the consensus columns were read at
  consensus_pos_rank_asof REAL,
  consensus_sd_asof REAL,
  updated_at      TEXT,
  PRIMARY KEY (season, team_name, pick_order)
);
CREATE INDEX IF NOT EXISTS idx_fdp_season ON fact_draft_pick (season);
CREATE INDEX IF NOT EXISTS idx_fdp_sk ON fact_draft_pick (player_sk);

-- ================= RAW LAYER: this league's own history, as ESPN gave it =================
--
-- Exactly what the adaptor returned, keyed by the source's own ids. No identity resolution: a pick
-- carries the DISPLAY NAME ESPN printed and nothing else, because resolving it here would put the
-- name-keyed join back into the raw layer, which is where docs/data-layers.md says it must not be.
--
-- `available = 0` is a first-class state, not an error. ESPN returns HTTP 404 for every season
-- before this league existed; recording that fact with its note is what makes the fetch
-- reproducible, and dropping the row would make a missing season indistinguishable from one nobody
-- ever asked for.
--
-- `pick_no` is the ORDER THE SOURCE RETURNED, 1-based. It is part of the primary key because ESPN's
-- auction feed has no per-pick id and the same player can legitimately appear twice in a season's
-- pick list (drafted, dropped, re-drafted after a trade in some formats); keying on the name alone
-- silently collapses those into one row.
CREATE TABLE IF NOT EXISTS raw_league_season (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, available INTEGER NOT NULL, size INTEGER,
  auction_budget REAL, ppr_points REAL, slot_counts_json TEXT, note TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season));
CREATE TABLE IF NOT EXISTS raw_league_team_season (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, team_id TEXT NOT NULL, name TEXT, owner_id TEXT, owner TEXT,
  acquisitions INTEGER, faab_spent REAL, drops INTEGER, trades INTEGER, lineup_moves INTEGER,
  acquisitions_by_week_json TEXT, wins INTEGER, losses INTEGER, points_for REAL, final_rank INTEGER, playoff_seed INTEGER,
  fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, team_id));
CREATE TABLE IF NOT EXISTS raw_league_pick (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, pick_no INTEGER NOT NULL, team_id TEXT, name TEXT NOT NULL,
  pos TEXT, price REAL, owner_id TEXT, owner TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, pick_no));
CREATE TABLE IF NOT EXISTS raw_league_matchup (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, home_id TEXT NOT NULL, away_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, week, home_id));
CREATE TABLE IF NOT EXISTS raw_league_division (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, division_id TEXT NOT NULL, name TEXT, team_ids_json TEXT,
  fetched_at TEXT NOT NULL, PRIMARY KEY (league_id, season, division_id));

-- ================= RAW LAYER: nflverse point-in-time feeds =================
--
-- One table per source feed, exactly what the feed gave, keyed by the source's own key. No identity
-- resolution -- the snap-count feed has no gsis id at all and that fact is preserved rather than
-- papered over, because a pfr id resolved here would be a join this layer is forbidden to make.
--
-- Every table carries `as_of`: the date the information was KNOWABLE, not the date we fetched it
-- (`fetched_at` is that, separately). The two differ by years for a historical row and confusing
-- them is how lookahead gets into a feature table without anything noticing.

-- The full nflverse schedules feed, not the six-column slice `game` holds. The Vegas line, the
-- weather, the surface, the rest days and the starting quarterbacks are all here and none of them
-- had anywhere to land.
--
-- AS-OF IS NOT ONE DATE FOR THIS ROW. `gameday`, `weekday`, `away_rest`/`home_rest`, `roof`,
-- `surface` and the opponent are knowable when the schedule is published, in the spring.
-- `spread_line`/`total_line` are the CLOSING line, knowable the day of the game. `temp` and `wind`
-- are OBSERVED and are not knowable before kickoff at all. `result` and the scores are after. So
-- `as_of` here is `gameday` -- the point by which everything except the result is settled -- and a
-- consumer that wants a column earlier than that has to say which column and why.
CREATE TABLE IF NOT EXISTS raw_nfl_game (
  season INTEGER NOT NULL, game_id TEXT NOT NULL, as_of TEXT,
  game_type TEXT, week INTEGER, gameday TEXT, weekday TEXT, gametime TEXT,
  away_team TEXT, home_team TEXT, away_score REAL, home_score REAL,
  location TEXT, result REAL, total REAL, overtime INTEGER,
  away_rest INTEGER, home_rest INTEGER,
  away_moneyline REAL, home_moneyline REAL, spread_line REAL, total_line REAL,
  away_spread_odds REAL, home_spread_odds REAL, under_odds REAL, over_odds REAL,
  div_game INTEGER, roof TEXT, surface TEXT, temp REAL, wind REAL,
  stadium_id TEXT, stadium TEXT, referee TEXT,
  away_qb_id TEXT, home_qb_id TEXT, away_qb_name TEXT, home_qb_name TEXT,
  gsis TEXT, pfr TEXT, espn TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, game_id));
CREATE INDEX IF NOT EXISTS idx_raw_game_wk ON raw_nfl_game (season, week);
