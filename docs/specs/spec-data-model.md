# Spec: Data Model (SQLite)

The single local SQLite file is the shared source of truth: the agent reads/writes it through
an MCP server, and the dashboard UI reads it directly. Design for one league now; leave a
`league_id` seam for many later (D6).

## Access pattern

- **Agent -> DB:** via a SQLite MCP server (a ready-made one or a small custom server exposing
  `query` / parameterized writes). The agent asks in natural language; the MCP tool runs SQL.
- **UI -> DB:** direct read-only queries from the Electron main process for dashboards.
- **Data scripts -> DB:** direct writes when ingesting projections/injuries/roster.

Only one writer process should hold a write transaction at a time; use WAL mode.

## Tables

### `settings`
Key-value app settings (budget cap, window, platform, active league).
```
key            TEXT PRIMARY KEY
value          TEXT
updated_at     TEXT   -- ISO 8601
```

### `league`
```
league_id      TEXT PRIMARY KEY
platform       TEXT   -- 'yahoo' | 'espn'
name           TEXT
season         INTEGER
team_id        TEXT   -- the user's team within the league
scoring_json   TEXT   -- scoring settings snapshot
last_synced_at TEXT
```

### `player`
```
player_id      TEXT PRIMARY KEY   -- platform-native id, prefixed by platform
name           TEXT
position       TEXT
nfl_team       TEXT
status         TEXT   -- active | questionable | doubtful | out | ir | bye
updated_at     TEXT
```

### `roster`
The user's current roster snapshot (one row per rostered player).
```
league_id      TEXT
player_id      TEXT
slot           TEXT   -- 'QB','RB','FLEX','BN','IR', etc.
is_starter     INTEGER
snapshot_at    TEXT
PRIMARY KEY (league_id, player_id, snapshot_at)
```

### `projection`
```
league_id      TEXT
player_id      TEXT
week           INTEGER
source         TEXT   -- where it came from
proj_points    REAL
fetched_at     TEXT
PRIMARY KEY (league_id, player_id, week, source)
```

### `matchup`
```
league_id      TEXT
week           INTEGER
opponent_team_id TEXT
my_proj        REAL
opp_proj       REAL
fetched_at     TEXT
PRIMARY KEY (league_id, week)
```

### `usage_log`  (feeds the budget governor -- spec-auth-and-budget Part B/C)
```
id                 INTEGER PRIMARY KEY AUTOINCREMENT
ts                 TEXT   -- ISO 8601
run_id             TEXT   -- groups turns of one scheduled run
run_type           TEXT   -- 'lineup' | 'waiver' | 'injury_check' | 'chat'
input_tokens       INTEGER
output_tokens      INTEGER
cache_read_tokens  INTEGER
cache_write_tokens INTEGER
```

### `action_log`  (the full-auto black box -- D3)
```
id             INTEGER PRIMARY KEY AUTOINCREMENT
ts             TEXT
run_id         TEXT
run_type       TEXT
action         TEXT   -- 'set_lineup' | 'submit_waiver' | 'skip' | 'notify'
detail_json    TEXT   -- what was changed, human-summarizable
status         TEXT   -- 'planned' | 'done' | 'failed' | 'skipped'
reason         TEXT   -- e.g. 'cap' | 'plan_limit' | error text
```

## Invariants / rules

- Every automated action writes an `action_log` row with status=planned BEFORE the browser acts,
  updated to done/failed after (D3). A "done" row must never be written speculatively.
- Every agent turn appends exactly one `usage_log` row.
- `run_id` ties a run's `usage_log` rows to its `action_log` rows -- this is what lets
  `estimate(run_type)` be computed from real history (spec-auth-and-budget Part C).
- Timestamps are ISO 8601 UTC strings.

## Data ingest sources

| Table | Source | Method |
|-------|--------|--------|
| `roster`, `matchup`, `league` | Yahoo / ESPN league pages | CDP browser scrape (spec-browser-automation) |
| `player`, `projection`, injuries | Public data where available (e.g. Sleeper-style APIs) + scrape fallback | data scripts |

## Acceptance criteria

- A migration script creates the schema from empty and is idempotent (re-runnable).
- Injecting known `usage_log` rows makes the weekly-usage query return their exact sum.
- The dashboard's "current starters" view is a pure function of the latest `roster` snapshot.
