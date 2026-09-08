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
  player_id   TEXT PRIMARY KEY REFERENCES player(player_id),
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
  player_id   TEXT,                  -- name_key
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
  position     TEXT,
  first_name   TEXT,               -- the name we first saw; display names change, keys must not
  matched_by   TEXT,               -- how identity was decided, for debugging a merge later
  created_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_natural ON player_identity (name_key, position);

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
-- player_key is the gsis id where one exists (stable across seasons and feeds) and pos:name_key
-- where it does not. Never a bare name_key: that is the thing being fixed.
CREATE TABLE IF NOT EXISTS stg_player (
  player_key     TEXT PRIMARY KEY,   -- gsis_id, else POS:name_key
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
