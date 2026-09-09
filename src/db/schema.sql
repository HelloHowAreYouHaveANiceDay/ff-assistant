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

-- THE REKEY MAP. Staging used to MINT its own surrogate keys (it called resolveOrMint with an empty
-- id bag), so the store held two disjoint key spaces for the same men: of 7,961 gsis ids present in
-- both stg_player and player_xref, 7,902 disagreed. Making staging READ the registry moves almost
-- every key, and a key that moves silently is exactly the failure the surrogate key exists to
-- prevent -- so the move is RECORDED rather than performed invisibly.
--
-- One row per OLD staging key. `reason` is derived from the shape of the mapping, never asserted:
--   unchanged  the old key and the new key are the same integer
--   moved      one old key -> one new key
--   merged     several old keys -> one new key (two rows were the same man)
--   split      one old key -> several new keys (one row was two men; Marvin Harrison Sr./Jr.)
--   dropped    the old row has no successor at all (reported, never assumed benign)
-- Rebuilt in full by `ff build-staging`; a consumer holding an old key migrates through it.
CREATE TABLE IF NOT EXISTS identity_rekey (
  old_sk      INTEGER,
  new_sk      INTEGER,
  reason      TEXT,
  rebuilt_at  TEXT,
  PRIMARY KEY (old_sk, new_sk)
);
CREATE INDEX IF NOT EXISTS idx_rekey_new ON identity_rekey (new_sk);

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
  pfr_id         TEXT,               -- the only id the snap-count feed carries
  fantasypros_id TEXT,
  ambiguous      INTEGER,            -- 1 = this name_key stands for more than one real player
  source         TEXT,               -- playerids | playerids-variant | board (board = no ids for him)
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
  -- 1 = this (name_key, position) stands for MORE THAN ONE REAL PERSON in the source, distinguished
  -- only by birthdate. See player_ids_variant. The differing fields on this row are NULLed rather
  -- than resolved to one of them, on the same principle stg_player already applies to a disputed
  -- gsis id: a wrong value that looks authoritative is worse than no value.
  ambiguous      INTEGER,
  updated_at     TEXT,
  PRIMARY KEY (name_key, position)
);
CREATE INDEX IF NOT EXISTS idx_pids_gsis ON player_ids (gsis_id);
CREATE INDEX IF NOT EXISTS idx_pids_espn ON player_ids (espn_id);

-- EVERY variant of an ambiguous crosswalk key, kept in full.
--
-- WHY IT EXISTS. db_playerids.csv carries one row per real person, but this store keys players on
-- (name_key, position) and nameKey strips generational suffixes ON PURPOSE. So Marvin Harrison Sr.
-- and Marvin Harrison Jr. arrive as two rows and collide on one key, and the upsert that used to
-- resolve that collision produced a single row carrying the FATHER's name, team and 1973 birthdate
-- with the SON's gsis and espn ids -- a row that is not either man. Every consumer downstream then
-- read an identity that never existed, and nothing could report it because the row looked complete.
--
-- Keyed by birthdate because birthdate is exactly the field that distinguishes them.
CREATE TABLE IF NOT EXISTS player_ids_variant (
  name_key       TEXT,
  position       TEXT,
  birthdate      TEXT,
  name           TEXT,
  team           TEXT,
  gsis_id        TEXT,
  espn_id        TEXT,
  sleeper_id     TEXT,
  yahoo_id       TEXT,
  pfr_id         TEXT,
  fantasypros_id TEXT,
  mfl_id         TEXT,
  sportradar_id  TEXT,
  updated_at     TEXT,
  PRIMARY KEY (name_key, position, birthdate)
);

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
  -- OWN-SEASON usage, per game played. Strictly speaking a TARGET-side quantity for THIS row (it is
  -- not knowable at as_of), and it is here for one reason: season Y+1's projection needs season Y
  -- usage, and the man who has no Y+1 row at all -- retired, cut, hurt in August -- is exactly the
  -- one the backtest still has to price, because the backtest's pool is the PRIOR season's players.
  -- Before these columns he carried NULL for every usage feature (defect D3). A model must not read
  -- own_* for its own season; `loadFeatureRows` never selects them.
  own_fd          REAL,
  own_ts          REAL,
  own_attempts    REAL,
  own_rush_yards  REAL,
  own_air_yards_share REAL,
  own_wopr        REAL,
  own_games_usage INTEGER,
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

-- One row per team-season this league has played. It is a FACT table, not a feature table: it
-- records what happened, and every column comes straight from `raw_league_team_season` with the
-- single derivation `champion = (final_rank = 1)`.
--
-- WHY IT IS SEPARATE FROM THE RAW TABLE. The raw row is what ESPN returned, including the season in
-- progress, where `final_rank` is a placeholder rather than a result. A consumer scoring a
-- simulation against outcomes needs to know which seasons ARE settled, and `settled` says so on the
-- row rather than leaving every consumer to re-derive it from a season number and today's date --
-- which is exactly the kind of re-derivation that ends up meaning three different things.
CREATE TABLE IF NOT EXISTS fact_team_season (
  league_id     TEXT,
  season        INTEGER,
  team_id       TEXT,
  team_name     TEXT,
  owner_id      TEXT,
  owner         TEXT,
  wins          INTEGER,
  losses        INTEGER,
  points_for    REAL,
  playoff_seed  INTEGER,
  final_rank    INTEGER,
  champion      INTEGER,            -- 1 = won the title. Derived from final_rank, never asserted.
  made_playoffs INTEGER,            -- 1 = playoff_seed within the league's playoff field
  settled       INTEGER,            -- 1 = the season finished and its outcomes are real
  acquisitions  INTEGER,
  faab_spent    REAL,
  drops         INTEGER,
  trades        INTEGER,
  lineup_moves  INTEGER,
  updated_at    TEXT,
  PRIMARY KEY (season, team_id)
);
CREATE INDEX IF NOT EXISTS idx_fts_season ON fact_team_season (season);

-- One row per regular-season game this league played. The schedule a season simulation has to run
-- on: who played whom, in which week. Straight from `raw_league_matchup`, one row per game (the raw
-- table is already keyed by the home side, so there is no doubling to undo).
CREATE TABLE IF NOT EXISTS fact_matchup (
  league_id  TEXT,
  season     INTEGER,
  week       INTEGER,
  home_id    TEXT,
  away_id    TEXT,
  updated_at TEXT,
  PRIMARY KEY (season, week, home_id)
);
CREATE INDEX IF NOT EXISTS idx_fm_season ON fact_matchup (season);

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

-- The official weekly injury report. `date_modified` is the source's own as-of and is what makes
-- this feed usable point-in-time at all: a Wednesday practice report and a Friday game-status report
-- are different information about the same week.
--
-- TWO SCHEMAS, and the second one is why `source_schema` is a column. 2009-2025 ship 16 fields
-- including date_modified and the four injury-description fields. The 2026 file ships 13 DIFFERENT
-- fields: it adds `season_type` and has NO date_modified, no report_primary_injury, no
-- report_secondary_injury and no practice_secondary_injury. An ingester that reads the old names
-- against 2026 writes rows full of nulls and reports success.
--
-- `as_of` IS `date_modified` AND IS NULL WHERE THE FEED HAS NONE. It is deliberately not backfilled
-- with a derived week anchor: that derivation belongs to the feature layer, which knows the
-- schedule, and inventing it here would put a computed date in a raw column where nothing could tell
-- it from a published one. A NULL as_of says "this feed did not tell us when", which is true.
CREATE TABLE IF NOT EXISTS raw_injury (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  player_key TEXT NOT NULL,        -- the source's gsis_id, else its full_name. NOT resolved.
  report_date TEXT NOT NULL,       -- date_modified, else '' -- part of the key, never NULL
  as_of TEXT,                      -- = date_modified; NULL where the feed publishes none
  gsis_id TEXT, full_name TEXT, position TEXT, game_type TEXT, season_type TEXT,
  report_primary_injury TEXT, report_secondary_injury TEXT, report_status TEXT,
  practice_primary_injury TEXT, practice_secondary_injury TEXT, practice_status TEXT,
  date_modified TEXT,
  source_schema TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, team, player_key, report_date));
CREATE INDEX IF NOT EXISTS idx_raw_injury_gsis ON raw_injury (gsis_id, season, week);

-- Published depth charts. TWO INCOMPATIBLE SCHEMAS, and this is the one in this file most likely to
-- fail silently:
--   'weekly' (1999-2025): one row per player per week per formation. The rank is `depth_team`.
--   'daily'  (2026-):     a DAILY SNAPSHOT keyed by `dt`, with no week column at all. The rank is
--                         `pos_rank`, and 2026 alone is 505,423 rows / 48MB.
-- An ingester that reads `depth_team` writes zero 2026 rows; one that reads `pos_rank` writes zero
-- rows for every prior season. Both exit cleanly. `source_schema` records which file a row came from
-- so the normalisation is auditable rather than invisible.
--
-- `week = 0` on a daily row is a SENTINEL, not week zero: that feed does not say which week a
-- snapshot belongs to, and mapping a date to a week needs the schedule, which is a feature-layer
-- join. `as_of` carries the snapshot date for the daily feed and is NULL for the weekly one, which
-- publishes no date -- the same rule raw_injury follows.
CREATE TABLE IF NOT EXISTS raw_depth_chart (
  season INTEGER NOT NULL, week INTEGER NOT NULL, as_of_key TEXT NOT NULL,
  team TEXT NOT NULL, player_key TEXT NOT NULL,
  formation TEXT NOT NULL, position TEXT NOT NULL, depth_position TEXT NOT NULL,
  as_of TEXT, depth_rank INTEGER,
  gsis_id TEXT, espn_id TEXT, full_name TEXT, game_type TEXT, jersey_number TEXT,
  source_schema TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, as_of_key, team, player_key, formation, position, depth_position));
CREATE INDEX IF NOT EXISTS idx_raw_depth_gsis ON raw_depth_chart (gsis_id, season, week);

-- Snap counts, from PFR by way of nflverse. THE FEED HAS NO GSIS ID -- its player key is
-- `pfr_player_id` -- and that is preserved rather than resolved, because a resolution here is the
-- join this layer exists to keep out of raw. The crosswalk (player_xref, source 'pfr') is where the
-- feature layer picks it up.
CREATE TABLE IF NOT EXISTS raw_snap_count (
  season INTEGER NOT NULL, week INTEGER NOT NULL, game_id TEXT NOT NULL, player_key TEXT NOT NULL,
  as_of TEXT,                      -- the game day, from raw_nfl_game where we have it
  pfr_player_id TEXT, pfr_game_id TEXT, player TEXT, position TEXT, team TEXT, opponent TEXT,
  game_type TEXT,
  offense_snaps REAL, offense_pct REAL, defense_snaps REAL, defense_pct REAL, st_snaps REAL, st_pct REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, game_id, player_key));
CREATE INDEX IF NOT EXISTS idx_raw_snap_pfr ON raw_snap_count (pfr_player_id, season, week);

-- The NFL DRAFT (not our auction). One file, 1936-2025.
--
-- ONLY season/round/pick/team/position/college ARE POINT-IN-TIME. The career-total columns the feed
-- also ships (w_av, games, seasons_started, allpro, probowls, and the counting stats) are lifetime
-- AS OF THE FILE'S BUILD DATE: using them as a feature for a 2015 row leaks that player's 2016-2025
-- career into it. They are stored because raw stores what the source gave, and named here so nobody
-- reads them as knowable in the draft year.
CREATE TABLE IF NOT EXISTS raw_nfl_draft_pick (
  season INTEGER NOT NULL, round INTEGER NOT NULL, pick INTEGER NOT NULL,
  as_of TEXT,                      -- <season>-05-01, after that year's draft has finished
  team TEXT, gsis_id TEXT, pfr_player_id TEXT, cfb_player_id TEXT, pfr_player_name TEXT,
  position TEXT, category TEXT, side TEXT, college TEXT, age REAL,
  -- NOT point-in-time. See above.
  hof INTEGER, w_av REAL, car_av REAL, dr_av REAL, games REAL, seasons_started REAL,
  allpro REAL, probowls REAL, to_season REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, round, pick));
CREATE INDEX IF NOT EXISTS idx_raw_draft_gsis ON raw_nfl_draft_pick (gsis_id);

-- FantasyFootballCalculator's ADP archive: the real draft market, by format and year.
--
-- `as_of` IS `meta.end_date` -- the last day of the draft window the average was taken over, which
-- is the source's own statement of when this was knowable. Measured examples: PPR 2024 is
-- 2024-08-31..2024-09-01 over 1,371 drafts; PPR 2026 is 2026-09-01..2026-09-08 over 5,144.
--
-- `teams` IS IN THE KEY AND IS ALWAYS 12, and that is a finding rather than a convention. The API
-- accepts a `teams` parameter and IGNORES it: teams=10 and teams=14 return byte-identical player
-- lists for PPR 2024 -- same adp and times_drafted for all 205 players -- and both responses' own
-- meta says teams=12. teams=16 is HTTP 400. So the half-PPR-at-16 ADP this league would want does
-- not exist at this source, and fetching four team counts would store four copies of one row.
-- `meta_teams` records what the response claimed, so the day that changes it is visible.
CREATE TABLE IF NOT EXISTS raw_adp_history (
  format TEXT NOT NULL, season INTEGER NOT NULL, teams INTEGER NOT NULL, ffc_player_id TEXT NOT NULL,
  as_of TEXT, window_start TEXT, window_end TEXT, total_drafts INTEGER, rounds INTEGER, meta_teams INTEGER,
  name TEXT, position TEXT, team TEXT,
  adp REAL, adp_formatted TEXT, times_drafted INTEGER, high REAL, low REAL, stdev REAL, bye INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (format, season, teams, ffc_player_id));
CREATE INDEX IF NOT EXISTS idx_raw_adp_season ON raw_adp_history (season, format);

-- nflverse participation, AGGREGATED TO PLAYER-WEEK. The source grain is the PLAY: one row per snap
-- with the on-field gsis ids in a semicolon-joined `offense_players` string, 21-50MB and ~46,000
-- plays a season for 2016-2025. Storing the play grain would be ~460,000 rows nothing reads to
-- answer the one question we have of it -- how often was this man on the field for a pass -- so this
-- table is the aggregate and says so in its name and here.
--
-- WHAT `pass_plays` IS AND IS NOT. The feed's `route` column is the route run by the TARGETED
-- receiver on that play, not a per-player field, so it cannot yield "routes run" for everyone on the
-- field. `pass_plays` counts the plays this player was on the offense for WHERE A ROUTE WAS CHARTED
-- -- the standard proxy for routes run, and a different number from what a charting service sells.
-- Route SHARE is that over the team's own charted pass plays in the same week, and is computed in
-- the feature layer, not here.
CREATE TABLE IF NOT EXISTS raw_participation (
  season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL, team TEXT NOT NULL,
  as_of TEXT,                      -- the game day, from raw_nfl_game
  off_plays INTEGER, pass_plays INTEGER, games INTEGER,
  team_off_plays INTEGER, team_pass_plays INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, gsis_id, team));
CREATE INDEX IF NOT EXISTS idx_raw_part_gsis ON raw_participation (gsis_id, season, week);

-- OverTheCap contracts by way of nflverse. ONE ROW PER CONTRACT.
--
-- THERE IS NO GSIS ID IN THIS FEED. Its identity columns are a display name, `otc_id`,
-- `date_of_birth`, `college` and the draft coordinates -- which is exactly the (name, birthdate)
-- pair the identity registry matches on, and the reason `date_of_birth` is kept verbatim.
--
-- `contract_no` is the index of this contract among that player's, in file order. The feed has no
-- per-contract id, and a player signing two deals in the same year with the same team is not
-- hypothetical (an extension and a restructure), so keying on (player, year_signed) would collapse
-- them.
--
-- POINT-IN-TIME: `year_signed` plus `years` gives the window a contract was in force, and the
-- CONTRACT-YEAR FLAG a model wants -- is this his last year under contract? -- is a derivation over
-- those two evaluated at a given season, which is safe. `is_active` and the three `inflated_*`
-- columns are as of the FILE'S BUILD DATE and are not point-in-time for any historical row.
CREATE TABLE IF NOT EXISTS raw_contract (
  player_key TEXT NOT NULL, contract_no INTEGER NOT NULL,
  as_of TEXT,                      -- <year_signed>-03-01, when the league year opens
  otc_id TEXT, player TEXT, position TEXT, team TEXT, is_active INTEGER,
  year_signed INTEGER, years REAL, value REAL, apy REAL, guaranteed REAL, apy_cap_pct REAL,
  inflated_value REAL, inflated_apy REAL, inflated_guaranteed REAL,
  date_of_birth TEXT, height TEXT, weight REAL, college TEXT,
  draft_year INTEGER, draft_round INTEGER, draft_overall INTEGER, draft_team TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (player_key, contract_no));
CREATE INDEX IF NOT EXISTS idx_raw_contract_player ON raw_contract (player, date_of_birth);

-- ================= FEATURE EXTENSION TABLES =================
--
-- Two tables that extend the Phase 2a feature layer sideways rather than changing it:
-- feat_player_season and feat_player_week keep their columns and their builder, and these carry the
-- new point-in-time context from the raw feeds above. They obey every feature-layer rule in
-- docs/data-layers.md, and they are keyed on `player_sk` ALONE -- an unresolved row is not written
-- at all here, unlike the Phase 2a tables which keep it with a NK: key. That is deliberate: these
-- columns exist to be JOINED onto those rows, and a second unresolved-row convention would be a
-- second thing to get wrong.
--
-- Every column's as-of rule is written next to it. The two exceptions to "knowable before kickoff"
-- are NAMED IN THEIR OWN COLUMN NAMES, because a leak you can read off the schema is a leak someone
-- can catch.
CREATE TABLE IF NOT EXISTS feat_player_week_context (
  player_sk       INTEGER NOT NULL,
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  as_of           TEXT,              -- the day BEFORE this team's kickoff that week
  team            TEXT,
  pos             TEXT,
  -- schedule: published in the spring, so knowable at as_of
  opponent        TEXT,
  home            INTEGER,
  days_rest       INTEGER,           -- nflverse home_rest/away_rest for this team's game
  roof            TEXT,              -- a property of the stadium, known when the schedule is
  -- the market: the CLOSING line, so strictly knowable at kickoff rather than at as_of. Kept
  -- because it is the best public estimate of a game's shape and feat_player_week already carries
  -- it on the same convention -- but it is an hour of information ahead of as_of, not a week.
  spread_line     REAL,
  total_line      REAL,
  implied_team_total REAL,
  -- OBSERVED AT THE GAME. Not knowable at as_of, at all, and named so that a model using them as a
  -- predictor for a pre-kickoff decision is visible in the query rather than hidden in a column
  -- called `temp`. They are here for post-hoc analysis (how much does wind cost a passing game?),
  -- not for projection.
  temp_observed   REAL,
  wind_observed   REAL,
  -- usage through the PRIOR week only
  prior_snap_share  REAL,            -- offense_pct in the most recent week played before this one
  prior_route_share REAL,            -- charted pass plays / team charted pass plays, same week
  -- the injury report, read at two points in the week. NULL where the feed publishes no report date
  -- (2025+), which is a different thing from "no injury".
  report_status_wed   TEXT,
  report_status_fri   TEXT,
  practice_status_wed TEXT,
  practice_status_fri TEXT,
  teammates_out   INTEGER,           -- same team, same position, listed Out on the Friday report
  depth_rank      INTEGER,           -- depth chart as of this week
  -- WHICH BUILDER WROTE THIS ROW, and therefore which guarantee it carries.
  --   'archive' -- buildWeekContext, from raw_injury. Every designation is placed by the date the
  --                team FILED it, so a Friday status is backed by a filing dated at or before that
  --                Friday. test/featuresExt.test.ts asserts exactly that, per row.
  --   'live'    -- buildLiveWeekContext, from player_status + high-severity injury news, for a
  --                season the archive does not cover. A status FEED publishes a current state and
  --                one timestamp and files nothing, so `as_of` is the SNAPSHOT time and no filing
  --                exists to back-join to. The point-in-time guarantee is instead that the snapshot
  --                precedes the week's first kickoff -- weaker, different, and asserted separately.
  source          TEXT,
  updated_at      TEXT,
  PRIMARY KEY (season, week, player_sk));
CREATE INDEX IF NOT EXISTS idx_fpwc_sk ON feat_player_week_context (player_sk, season, week);

-- The preseason extension. as_of is <season>-09-01, the same anchor feat_player_season uses, so the
-- two join row for row.
CREATE TABLE IF NOT EXISTS feat_player_season_ext (
  player_sk       INTEGER NOT NULL,
  season          INTEGER NOT NULL,
  as_of           TEXT,              -- <season>-09-01
  team            TEXT,
  pos             TEXT,
  -- the NFL draft: knowable from the April of the player's rookie year onward
  draft_year      INTEGER,
  draft_round     INTEGER,
  draft_pick      INTEGER,
  -- contract: derived from (year_signed, years) evaluated at THIS season. 1 = this is the last
  -- season of the deal. NULL = we have no contract for him, which is not the same as 0.
  contract_year   INTEGER,
  contract_year_signed INTEGER,
  contract_years  REAL,
  contract_apy    REAL,
  -- prior season, all strictly before this season's first game
  prior_snap_share      REAL,
  prior_route_share     REAL,
  prior_carries_per_game REAL,
  prior_carry_share     REAL,        -- his carries / his team's carries, prior season
  prior_air_yards_share REAL,
  prior_wopr            REAL,
  -- as of September 1 specifically
  depth_rank_sep1  INTEGER,
  injury_status_sep1 TEXT,
  -- the draft market, from the FFC archive. adp_as_of is the archive's own window end and is NOT
  -- always inside the season: standard 2008 and 2009 are both stamped 2010-06-20.
  adp             REAL,
  adp_format      TEXT,
  adp_as_of       TEXT,
  adp_stdev       REAL,
  resolved_by     TEXT,              -- which rule matched: gsis | espn | sleeper | pfr | name-pos-team
  updated_at      TEXT,
  PRIMARY KEY (season, player_sk));
CREATE INDEX IF NOT EXISTS idx_fpse_sk ON feat_player_season_ext (player_sk, season);

-- COVERAGE, as data. Every column of both tables, per season, with how many rows are non-null.
-- Written by the same run that builds them, so it cannot describe a different build -- and asserted
-- by a test, because a column silently dropping to zero in a season it should cover is the failure
-- that produces a coefficient rather than an error.
CREATE TABLE IF NOT EXISTS feat_coverage (
  table_name  TEXT NOT NULL,
  column_name TEXT NOT NULL,
  season      INTEGER NOT NULL,
  rows        INTEGER,
  non_null    INTEGER,
  updated_at  TEXT,
  PRIMARY KEY (table_name, column_name, season));
-- ================= WEEKLY TRACK =================
--
-- feat_player_week_model is the point-in-time feature view a WEEKLY model trains and serves from.
-- It is a separate table from feat_player_week on purpose: that one is the raw week fact (schedule,
-- usage-to-date, target), this one adds the derived, as-of-dated columns a weekly model needs and
-- carries an as_of that is the day before the WEEK'S FIRST KICKOFF anywhere in the league -- earlier
-- and therefore stricter than feat_player_week's per-team anchor.
--
-- THE INVARIANT: a row for (season Y, week w) may contain nothing dated on or after that as_of.
-- src/weekly/features.ts states the as-of rule beside every column, and test/weekly-leakage.test.ts
-- perturbs week w's source data and asserts no week-w feature moves.
CREATE TABLE IF NOT EXISTS feat_player_week_model (
  feat_key        TEXT,
  player_sk       TEXT,
  season          INTEGER,
  week            INTEGER,
  as_of           TEXT,              -- day before the week's FIRST kickoff, league-wide
  name            TEXT,
  pos             TEXT,
  team            TEXT,
  opponent        TEXT,
  home            INTEGER,
  is_bye          INTEGER,
  season_line_pg  REAL,              -- preseason season projection / games, as of Y-09-01
  td_games        INTEGER,           -- games played through w-1
  td_ppg          REAL,              -- points per game through w-1
  t4_mean         REAL,              -- mean of the last <=4 games played before w
  t4_sd           REAL,              -- population sd of those same games (NULL when <2 games)
  td_fd           REAL,              -- first downs per game through w-1
  td_ts           REAL,              -- target share per game through w-1
  td_attempts     REAL,
  td_rush_yards   REAL,
  dvp_mult        REAL,              -- opponent defence-vs-position multiplier, weeks < w + prior yr
  dvp_n           INTEGER,           -- opponent games inside season Y that fed it
  spread_line     REAL,
  total_line      REAL,
  implied_team_total REAL,
  days_rest       REAL,              -- days since this team's previous game (NULL in its first)
  -- ------- TARGET -------
  pts             REAL,
  updated_at      TEXT,
  PRIMARY KEY (season, week, feat_key)
);
CREATE INDEX IF NOT EXISTS idx_fpwm_sk ON feat_player_week_model (player_sk, season, week);
CREATE INDEX IF NOT EXISTS idx_fpwm_pos ON feat_player_week_model (season, week, pos);

-- raw_espn_projection: ESPN's OWN weekly projection, snapshotted read-only through the app bridge.
-- A third baseline the weekly model has to beat to be worth serving. `as_of` is when the snapshot
-- was taken, and it is the whole value of the table: a projection read after the games is not a
-- projection.
CREATE TABLE IF NOT EXISTS raw_espn_projection (
  season          INTEGER,
  week            INTEGER,
  espn_player_id  TEXT,
  name            TEXT,
  pos             TEXT,
  proj_pts        REAL,
  as_of           TEXT,
  fetched_at      TEXT,
  PRIMARY KEY (season, week, espn_player_id)
);

-- scorecard_prediction is the forward record: what we said, BEFORE it could be contaminated. A row
-- is written once and never updated -- a prediction you can edit after the fact is not a prediction,
-- so the insert is OR IGNORE and re-running the snapshot is a no-op rather than a rewrite.
CREATE TABLE IF NOT EXISTS scorecard_prediction (
  season          INTEGER,
  week            INTEGER,           -- 0 for season-long kinds
  kind            TEXT,              -- 'weekly' | 'weekly_challenger' | 'season' | 'odds'
  -- 'weekly'            -> weekly | season_line | shipped_week | trailing4 | espn, all served from
  --                        the SHIPPED artifact, i.e. the one the lineup is served from.
  -- 'weekly_challenger' -> two_part: the model that failed clause (c) of the weekly gate by five
  --                        thousandths, snapshotted on the same players and the same as_of so the
  --                        live season accrues out-of-sample evidence for it. Starts at week 2.
  model           TEXT,
  subject         TEXT,              -- feat_key for player kinds, team/owner id for odds
  name            TEXT,
  pos             TEXT,
  value           REAL,
  p10             REAL,
  p90             REAL,
  as_of           TEXT,
  created_at      TEXT,
  PRIMARY KEY (season, week, kind, model, subject)
);

-- scorecard_result is the scored side, rebuilt from actuals whenever a week completes. Rebuildable
-- BY DESIGN (predictions are not): scoring is a pure function of a frozen prediction and an actual.
CREATE TABLE IF NOT EXISTS scorecard_result (
  season          INTEGER,
  week            INTEGER,
  kind            TEXT,
  model           TEXT,
  metric          TEXT,              -- 'rmse' | 'crps' | 'coverage' | 'lineup_pts' | 'brier' | 'n'
  value           REAL,
  n               INTEGER,
  scored_at       TEXT,
  PRIMARY KEY (season, week, kind, model, metric)
);

-- raw_espn_eligibility: ESPN's OWN answer to "which lineup slots may this player be started in",
-- snapshotted read-only through the app bridge. `eligible_positions_json` holds only the DEDICATED
-- slot ids mapped into our vocabulary; `raw_slots_json` keeps every id ESPN returned, including the
-- combo slots (3 RB/WR, 5 WR/TE, 7 OP, 23 FLEX) that are deliberately NOT read as positions -- every
-- receiver in football carries slot 3, so reading it as a position would mark the whole board dual.
-- See src/data/eligibility.ts for the id table.
CREATE TABLE IF NOT EXISTS raw_espn_eligibility (
  season                  INTEGER,
  espn_player_id          TEXT,
  name                    TEXT,
  default_position        TEXT,
  eligible_positions_json TEXT,
  raw_slots_json          TEXT,
  fetched_at              TEXT,
  PRIMARY KEY (season, espn_player_id)
);

-- player_eligibility: the STAGED form, on the surrogate key. Resolved through player_xref by ESPN
-- ID and never by name -- the two Justin Jeffersons share a name_key exactly, so a name join hands
-- one man the other's eligibility with no symptom.
CREATE TABLE IF NOT EXISTS player_eligibility (
  player_sk      INTEGER REFERENCES player_identity(player_sk),
  season         INTEGER,
  positions_json TEXT,
  updated_at     TEXT,
  PRIMARY KEY (player_sk, season)
);

-- player_value_position: which of a dual-eligible player's positions his dollar value was taken at.
-- A SIDECAR rather than a column on player_value because schema.sql only reaches a FRESH store
-- (every statement is CREATE ... IF NOT EXISTS), so a new column would also need an ALTER in
-- src/db/db.ts; a new table needs neither and lands on an existing store unchanged. One row per
-- valued player per season, written by the assembler alongside player_value.
CREATE TABLE IF NOT EXISTS player_value_position (
  player_id      TEXT,               -- name_key, the same key player_value uses
  season         INTEGER,
  board_pos      TEXT,               -- the position the projection carried
  value_pos      TEXT,               -- the eligible position the VOR was taken at
  eligible_json  TEXT,               -- the full eligible set, for audit
  updated_at     TEXT,
  PRIMARY KEY (player_id, season)
);
-- ================= RAW LAYER: this league's week-by-week rosters and transaction log =============
--
-- Added by the in-season backtest track. The store already held this league's auction, finish and
-- schedule; it held nothing about WHO WAS ON A ROSTER IN A GIVEN WEEK or WHO WAS STARTED, which is
-- every in-season decision the tool makes. See src/data/leagueRosters.ts for which ESPN view these
-- come from and, more importantly, which plausible-looking view does NOT answer the question:
-- leagueHistory+mRoster ignores scoringPeriodId entirely and serves the FINAL roster under every
-- week number, so a backtest built on it would conclude that nobody ever changed their lineup.
--
-- `as_of_start` / `as_of_end` are the scoring period's KICKOFF WINDOW from raw_nfl_game, and `as_of`
-- is as_of_end: a week's lineup is not knowable before its first kickoff and is fully settled at its
-- last. A point-in-time consumer for week w may read rows whose as_of is strictly before week w's
-- first kickoff, and no others. Both are NULL where the schedule is not in the store -- "we cannot
-- date this" rather than a guessed date, which is the rule raw_injury already follows.
CREATE TABLE IF NOT EXISTS raw_league_roster_week (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, team_id TEXT NOT NULL,
  espn_player_id TEXT NOT NULL, name TEXT, position TEXT,
  lineup_slot_id INTEGER, is_starter INTEGER, applied_points REAL,
  acquisition_type TEXT, acquisition_date TEXT,
  as_of TEXT, as_of_start TEXT, as_of_end TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, week, team_id, espn_player_id));
CREATE INDEX IF NOT EXISTS idx_rlrw_wk ON raw_league_roster_week (season, week);
CREATE INDEX IF NOT EXISTS idx_rlrw_pl ON raw_league_roster_week (espn_player_id, season);

-- One row per SCORING PERIOD ASKED FOR, whether or not it had data. A week ESPN served nothing for
-- is a fact worth keeping: without it, a season we never fetched and a season ESPN has purged look
-- identical.
CREATE TABLE IF NOT EXISTS raw_league_roster_week_status (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  available INTEGER NOT NULL, rows INTEGER NOT NULL, note TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, week));

-- ONE ROW PER TRANSACTION ITEM, not per transaction: a free-agent pickup is one ESPN transaction
-- containing an ADD item and a DROP item, and a trade contains four. `item_no` is the index in
-- ESPN's own array, for the same reason raw_league_pick keys on the array index -- the feed
-- publishes no per-item id. name/position are absent BY THE FEED (an item carries only playerId);
-- identity is resolved downstream through player_xref, never here.
CREATE TABLE IF NOT EXISTS raw_league_transaction (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  transaction_id TEXT NOT NULL, item_no INTEGER NOT NULL,
  type TEXT, item_type TEXT, executed_at TEXT, proposed_at_ms INTEGER,
  team_id TEXT, member_id TEXT, espn_player_id TEXT,
  from_team_id TEXT, to_team_id TEXT, from_lineup_slot_id INTEGER, to_lineup_slot_id INTEGER,
  bid_amount REAL, status TEXT, execution_type TEXT, is_pending INTEGER,
  as_of_start TEXT, as_of_end TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, transaction_id, item_no));
CREATE INDEX IF NOT EXISTS idx_rlt_wk ON raw_league_transaction (season, week);
CREATE INDEX IF NOT EXISTS idx_rlt_pl ON raw_league_transaction (espn_player_id, season);

CREATE TABLE IF NOT EXISTS raw_league_transaction_status (
  league_id TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  available INTEGER NOT NULL, rows INTEGER NOT NULL, note TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, week));

-- ================= FEATURE LAYER: weekly roster state, the free-agent pool, lineup regret ========
--
-- Identity RESOLVED (raw_league_roster_week.espn_player_id -> player_xref -> player_sk), which is
-- what makes these joinable to feat_player_week_model and to the weekly projector's output.
CREATE TABLE IF NOT EXISTS fact_roster_week (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team_id TEXT NOT NULL, player_sk TEXT NOT NULL,
  espn_player_id TEXT, name TEXT, pos TEXT, slot TEXT, lineup_slot_id INTEGER, is_starter INTEGER,
  actual_pts REAL, as_of TEXT, built_at TEXT,
  PRIMARY KEY (season, week, team_id, player_sk));
CREATE INDEX IF NOT EXISTS idx_frw_sk ON fact_roster_week (player_sk, season, week);

-- Every skill/K/DST player with a weekly feature row in that season who was NOT on any roster in
-- week w. "On nobody's roster" is the definition of a free agent this league actually uses; waiver
-- status is not distinguishable from the roster feed and is therefore not claimed.
CREATE TABLE IF NOT EXISTS fact_fa_pool_week (
  season INTEGER NOT NULL, week INTEGER NOT NULL, player_sk TEXT NOT NULL,
  pos TEXT, name TEXT, actual_pts REAL, ros_pts REAL, ros_games INTEGER, built_at TEXT,
  PRIMARY KEY (season, week, player_sk));
CREATE INDEX IF NOT EXISTS idx_ffpw_pos ON fact_fa_pool_week (season, week, pos);

-- What each team STARTED, what the best legal lineup from that same roster would have scored, and
-- the difference. `optimal_pts` is HINDSIGHT: it uses the week's realised points, so it is a ceiling
-- nobody could have hit, not a target. It is the denominator the tool has to be measured against.
CREATE TABLE IF NOT EXISTS fact_lineup_week (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team_id TEXT NOT NULL,
  started_pts REAL, optimal_pts REAL, bench_left REAL,
  starters INTEGER, roster_n INTEGER, slots_json TEXT, optimal_json TEXT, built_at TEXT,
  PRIMARY KEY (season, week, team_id));
-- feat_player_week_stream: WHAT THE OPPONENT ALLOWS, AS OF THE WEEK. The streaming half of the
-- weekly feature view; src/weekly/streamingFeatures.ts owns it and states each column's as-of rule.
--
-- SAME INVARIANT AS feat_player_week_model: a row for (season Y, week w) may contain nothing dated on
-- or after that as_of. Every accumulated column is bounded by `week < w` of Y, blended with all of
-- Y-1 and shrunk toward the league mean over the same window. test/streaming-leakage.test.ts perturbs
-- week w's own source rows and asserts nothing here moved; scripts/streaming-leak-audit.mjs
-- recomputes the columns independently on the table that actually shipped and moves the bound to
-- `<= w` as the positive control.
--
-- TEMPERATURE AND WIND ARE ABSENT ON PURPOSE. raw_nfl_game carries them and says out loud that they
-- are OBSERVED -- not knowable before kickoff. This store holds no forecast feed, and a forecast is a
-- different quantity from an observation, so the columns are not built. `roof` IS built: a stadium's
-- roof is knowable when the schedule is published.
--
-- KEYED (season, week, feat_key), matching feat_player_week_model, NOT (player_sk, season, week): a
-- small number of player-weeks carry a NULL surrogate key, and a NULL inside a SQLite primary key
-- does not conflict with another NULL, so keying on it would let one man write two rows.
CREATE TABLE IF NOT EXISTS feat_player_week_stream (
  feat_key                 TEXT,
  player_sk                TEXT,
  season                   INTEGER,
  week                     INTEGER,
  as_of                    TEXT,     -- day before the week's FIRST kickoff, league-wide
  pos                      TEXT,
  team                     TEXT,
  opponent                 TEXT,
  opp_pa_pos               REAL,     -- fantasy pts the opponent allowed per game to THIS position
  opp_pa_pos_n             INTEGER,  -- team-games of season-Y evidence behind it; <= w-1 always
  opp_def_sacks_pg         REAL,     -- opponent DEFENCE: sacks made per game
  opp_def_takeaways_pg     REAL,     -- opponent DEFENCE: interceptions + opponent fumbles recovered
  opp_pass_yds_allowed_pg  REAL,
  opp_rush_yds_allowed_pg  REAL,
  opp_off_sacks_allowed_pg REAL,     -- opponent OFFENCE: sacks suffered per game (what a DST eats)
  opp_off_giveaways_pg     REAL,     -- opponent OFFENCE: interceptions thrown + fumbles lost
  opp_implied_total        REAL,     -- total_line - implied_team_total, as published pre-kickoff
  roof_dome                INTEGER,  -- 1 where roof is dome/closed/indoors. NOT temp, NOT wind.
  team_fga_pg              REAL,     -- this player's OWN team: field goals attempted per game
  team_pat_pg              REAL,     -- this player's OWN team: extra points attempted per game
  updated_at               TEXT,
  PRIMARY KEY (season, week, feat_key)
);
CREATE INDEX IF NOT EXISTS idx_fpws_pos ON feat_player_week_stream (season, week, pos);

-- feat_player_week_model.in_population -- THE DECISION POPULATION, added by ALTER, not here.
--
-- It is a column on a table this file only ever reaches when the store is FRESH (every statement is
-- CREATE ... IF NOT EXISTS), so putting it in the CREATE above would land it on nobody's existing
-- database. `ensurePopulationColumn` in src/weekly/population.ts adds it idempotently, and
-- `buildPopulation` fills it as the last step of `ff build-weekly-features`.
--
-- WHAT IT MEANS: 1 exactly on the player-weeks a lineup or waiver decision in this league can
-- involve -- rostered (Track B's fact_roster_week, 2018-2025), or among the top
-- POPULATION_DEPTH[pos] at the position by preseason line. Non-bye and with a season line, always.
--
-- WHY IT IS A COLUMN AND NOT A PREDICATE EACH SIDE WRITES: tools/train_weekly.py fits on it and
-- src/weekly/evaluate.ts scores on it. When the rule lived in two places it drifted -- the trainer
-- cut at `season_line_pg >= 3` and the harness kept every non-bye row -- and the resulting 0.11 to
-- 0.21 difference in zero rate is what failed the weekly gate's zero-share clause at RB, WR and TE.
-- One column, read by both, makes the two sets equal by construction rather than by agreement.

-- ================= TRACK I: THE INJURY HORIZON =================
--
-- HOW LONG WILL HE BE OUT. The two tables below exist because every availability number this repo
-- ships is a PER-TIER RATE: `missProb` in rosterValue.ts and `leadMissProb` in handcuff.ts both read
-- the variance model's fitted games/17 for the player's rank bucket, which knows the man's tier and
-- nothing about the injury he actually has. A torn Achilles and a Questionable hamstring are the
-- same number to it. The weekly model does better -- it reads the OUT designation -- but only for
-- the coming week; it has no notion of a horizon at all.
--
-- fact_injury_episode is the EVENT: one row per continuous run of injury-report weeks, with what
-- happened afterwards (how many games he actually missed, when he returned, on what snap share).
-- Those outcome columns are the TARGET side and are deliberately NOT features -- nothing point-in-
-- time may read weeks_missed, returned_week or snap_share_on_return, because all three are dated
-- after the decision they would inform.
--
-- feat_injury_horizon is the POINT-IN-TIME view: one row per (player, season, week) in which the
-- player carried an injury report at that week's FRIDAY cutoff, holding only what was knowable then
-- plus the four censored targets. The Friday cutoff is this team's own kickoff minus two days, the
-- same anchor feat_player_week_context uses, so a Thursday-night player's Friday report is correctly
-- unavailable rather than quietly borrowed from the Sunday teams.
CREATE TABLE IF NOT EXISTS fact_injury_episode (
  player_sk       INTEGER NOT NULL,
  season          INTEGER NOT NULL,
  start_week      INTEGER NOT NULL,   -- first week the player carried an injury report at its Friday
  end_week        INTEGER,            -- last such week in this run
  weeks_reported  INTEGER,            -- how many weeks of the run carried a report
  team            TEXT,
  position        TEXT,
  injury_primary  TEXT,               -- modal named injury across the run, as reported
  injury_group    TEXT,               -- the collapsed bucket the model uses (see injuryDuration.ts)
  injury_secondary TEXT,
  first_designation TEXT,             -- report_status in start_week ('' where the row is practice-only)
  designations    TEXT,               -- JSON {"week": "designation"} across the run, in week order
  -- ---------------- OUTCOME. Not features. ----------------
  weeks_missed    INTEGER,            -- consecutive games not played from the first missed week
  returned_week   INTEGER,            -- first week played after that run; NULL where censored
  censored        INTEGER,            -- 1 = the run reached the last scheduled week with no return
  snap_share_on_return REAL,          -- offense_pct in returned_week, 2013+ only (PFR feed)
  as_of           TEXT,               -- as_of of the FIRST report in the run
  updated_at      TEXT,
  PRIMARY KEY (player_sk, season, start_week)
);
CREATE INDEX IF NOT EXISTS idx_fie_season ON fact_injury_episode (season, injury_group);

-- One row per player-week UNDER AN ACTIVE REPORT. A healthy week has no row: this table answers
-- "given that he is on the report, how long is he out", not "is he injured".
CREATE TABLE IF NOT EXISTS feat_injury_horizon (
  player_sk       INTEGER NOT NULL,
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  as_of           TEXT,               -- the Friday cutoff this row was read at (team kickoff - 2d)
  team            TEXT,
  pos             TEXT,
  episode_start_week INTEGER,
  injury_primary  TEXT,               -- as named on THIS week's report, else the latest before it
  injury_group    TEXT,
  injury_secondary_present INTEGER,
  designation     TEXT,               -- report_status at the Friday cutoff; '' where practice-only
  practice_status TEXT,
  weeks_in_episode INTEGER,           -- how many report weeks of this episode are already behind him
  weeks_missed_so_far INTEGER,        -- games in this episode he has already not played, before w
  prior_episodes_same INTEGER,        -- episodes of the SAME group starting in the last two seasons
  prior_episodes_any INTEGER,
  age             REAL,               -- years at this week's kickoff, from player_identity.birthdate
  -- ---------------- TARGETS. miss_next_k = he missed ALL of the next k GAMES (byes skipped).
  -- NULL where fewer than k scheduled games remain: censored, not zero.
  miss_next_1     INTEGER,
  miss_next_2     INTEGER,
  miss_next_3     INTEGER,
  miss_next_4     INTEGER,
  games_remaining INTEGER,            -- scheduled games from this week on, the censoring bound
  updated_at      TEXT,
  PRIMARY KEY (player_sk, season, week)
);
CREATE INDEX IF NOT EXISTS idx_fih_season ON feat_injury_horizon (season, week);

-- ==================================================================================================
-- fact_waiver_claim -- EVERY PROCESSED WAIVER CLAIM IN THIS LEAGUE, WITH ITS BID AND WHAT IT BOUGHT.
--
-- ONE ROW PER CLAIM (the ADD item of a WAIVER transaction), winners AND losers. ESPN publishes the
-- LOSING bid: a claim that was outbid comes back as status FAILED_INVALIDPLAYERSOURCE carrying the
-- amount that lost, inside the same `mTransactions2` view Track B already fetched. That single fact
-- is what makes P(win | bid) fittable here rather than assumable; without it only the clearing price
-- is observable. 2018 is the exception -- ESPN retains no resolved failures for it, only PENDING --
-- so it is a winners-only season, which the coverage read-back states rather than hides.
--
-- POINT-IN-TIME, and the columns that are not are named as targets. `team_faab_left`,
-- `league_faab_left` and `teams_need_pos` are computed from transactions and rosters STRICTLY BEFORE
-- this claim's own waiver run; `ros_pts`/`ros_games` are the outcome the claim bought and exist to
-- be predicted, never to predict. `competing_bids` is knowable only after the run and is stored for
-- reporting, NOT as a model feature.
CREATE TABLE IF NOT EXISTS fact_waiver_claim (
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  transaction_id  TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  espn_player_id  TEXT NOT NULL,
  player_sk       TEXT,             -- player_xref for real players, the roster D/ST map for defences
  name            TEXT,
  pos             TEXT,
  bid_amount      REAL,
  status          TEXT,             -- ESPN's own status, verbatim
  won             INTEGER,          -- 1 EXECUTED, 0 outbid (FAILED_INVALIDPLAYERSOURCE), NULL other
  competing_bids  INTEGER,          -- OTHER processed claims on the same player-week. NOT a feature.
  executed_at     TEXT,             -- LOCAL date-time of the waiver run
  proposed_at_ms  INTEGER,
  -- ------- POINT-IN-TIME FEATURES (every one knowable before the run) -------
  season_line_pg  REAL,             -- preseason projection / games, as of Y-09-01
  pos_line_rank   INTEGER,          -- rank of season_line_pg inside his position that week (1 = best)
  td_ppg          REAL,             -- points per game through w-1
  td_games        INTEGER,
  t4_mean         REAL,             -- mean of the last <=4 games played before w
  prior_pts       REAL,             -- his points in week w-1 (NULL in week 1)
  team_faab_left  REAL,             -- budget minus this team's EXECUTED spend BEFORE this run
  league_faab_left REAL,            -- the same, summed over every team in the season
  team_faab_share REAL,             -- team_faab_left / budget
  league_faab_share REAL,           -- league_faab_left / (teams * budget)
  teams_need_pos  INTEGER,          -- teams carrying fewer at this position than the league median
  teams_counted   INTEGER,
  budget          REAL,             -- the season's FAAB budget per team
  -- ------- TARGET (the outcome the claim bought; never an input) -------
  ros_pts         REAL,             -- his points from week w to the end of the season
  ros_games       INTEGER,
  built_at        TEXT,
  PRIMARY KEY (season, transaction_id, espn_player_id)
);
CREATE INDEX IF NOT EXISTS idx_fwc_player ON fact_waiver_claim (season, week, player_sk);

-- fact_prediction: THE PREGISTERED-PREDICTION LEDGER, machine-readable. Every P<n>/W<n> id in
-- docs/redesign-2026-09.md's prediction tables, transcribed exactly (outcome wording included -- see
-- data/predictions.json, the checked-in source `ff ledger sync` rebuilds this table from). A
-- programme where the ledger and the doc can drift is a programme where "held" quietly comes to mean
-- "nobody re-checked the doc"; this table exists so the Model page can show the ledger, and the id
-- completeness test (test/prediction-ledger.test.ts) can prove every id in the doc has a row and
-- every row's id is still in the doc.
CREATE TABLE IF NOT EXISTS fact_prediction (
  id          TEXT PRIMARY KEY,   -- 'P12', 'W3'
  doc_section TEXT,               -- the docs/redesign-2026-09.md heading the row lives under
  claim       TEXT,               -- the prediction, verbatim
  outcome     TEXT,               -- 'held' | 'failed' | 'split' | 'pending' -- mechanically extracted
                                   -- from the doc's own HELD/FAILED markers, not re-judged here
  measured    TEXT,               -- the doc's outcome cell, verbatim (the measured value, in prose)
  synced_at   TEXT
);
