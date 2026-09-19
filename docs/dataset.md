# The published dataset

A snapshot of this repo's **derived and public-source** tables, so a new clone does not have to
re-pull and re-train everything before it can model anything.

### Download

One URL, and it never changes -- it always resolves to the newest release:

```
curl -LO https://github.com/HelloHowAreYouHaveANiceDay/ff-assistant/releases/latest/download/ff-dataset.db.gz
curl -LO https://github.com/HelloHowAreYouHaveANiceDay/ff-assistant/releases/latest/download/ff-dataset.db.gz.sha256
sha256sum -c ff-dataset.db.gz.sha256
gunzip ff-dataset.db.gz
```

A DATED copy is attached to every release too (`ff-dataset-<date>.db.gz`), for pinning a specific
snapshot. The stable name is what `latest/download` needs: that pointer matches on the asset's
FILENAME, so a dated name resolves only while its release happens to be the newest one -- which
looks correct right up until the second release exists.

## Releases are cut from `main`

A published dataset must be traceable to mainline history, or "which code produced this?" answers
with a commit nobody can find. `ff export-dataset --for-release` refuses anywhere but a clean,
pushed `main` -- the rule lives in the tool rather than in a runbook, because a rule that depends on
whoever is running the command holds until the first hurried afternoon.

---

## What is in it

31 tables, ~3.67M rows, 474 MB uncompressed (~99 MB gzipped). Three groups:

| group | examples | why it is here |
|---|---|---|
| public NFL feeds | `raw_depth_chart` (1.9M), `raw_snap_count` (326k), `raw_injury` (91k), `raw_participation`, `raw_pbp_player_week`, `raw_nfl_game`, `raw_combine`, `raw_ngs` | already redistributable, but slow to re-pull |
| player identity | `player`, `player_bio`, `player_identity`, `player_xref`, `stg_player` | the join keys everything else uses |
| the derived modelling layer | `feat_player_week` (297k), `feat_player_week_model` (188k), `feat_player_week_context`, `feat_curve`, `feat_player_prospect`, `feat_injury_horizon`, `fact_injury_episode` | **the expensive part** -- needs the full ingest *and* the training runs to reproduce |

The last group is the reason to publish at all. The public feeds are cheap for anyone to fetch; the
feature tables are not.

## Keys: how to join this to anything else

**`player_sk` IS SNAPSHOT-LOCAL. Do not use it as a durable key.** It is a minted surrogate, and an
identity rebuild reassigns it: this store's own `identity_rekey` log records a single rebuild moving
**11,974 of 12,021 keys**. Joining release N on `player_sk` and then upgrading to release N+1 gives
you the wrong players *silently* -- every row still matches something.

Use **`dim_player_key`** instead. One row per `player_sk` in the snapshot, bridging it to the ids
the rest of the ecosystem uses:

| column | coverage |
|---|---|
| `mfl_id` | **96.7%** -- the DynastyProcess crosswalk's own row key, and the best coverage here |
| `pfr_id` | 81.4% |
| `espn_id` | 70.9% |
| `gsis_id` | 70.8% -- nflverse's key for NFL stats |
| `sportradar_id` | 65.6% |
| `sleeper_id` | 58.3% |

```sql
SELECT f.*, k.gsis_id, k.mfl_id
FROM feat_player_week f JOIN dim_player_key k USING (player_sk);
```

`resolved_by` records HOW each row was bridged, so you can discount the weaker route:

- `xref-gsis` (2,671) -- exact, through the gsis cross-reference.
- `staged-name-key` (1,023) -- a NAME join, used only after the exact route missed. Name keys flagged
  `ambiguous` (shared by more than one real player) are **excluded rather than resolved**: attaching
  somebody else's ids to a row that still looks fully populated is worse than a null.
- `dst-synthetic` (32) -- `DST:<TEAM>` is deterministic by construction. **These are the only keys in
  the dataset safe to join on directly across releases.**
- `unresolved` (96) -- emitted with nulls rather than dropped, because a player with no external id
  is information.

The full DynastyProcess map is shipped as `player_ids`, and `player_xref` / `stg_player` are included
so you can re-derive the bridge yourself if you disagree with the routing.

## What is NOT in it, and why

**Nothing from anybody's fantasy league.** 57 tables are excluded, including every one of:

```
ownership              raw_league_season        fact_team_season
league                 raw_league_team_season   fact_matchup
draft / draft_state    raw_league_pick          fact_draft_pick
roster / my_roster     raw_league_matchup       fact_roster_week
matchup                raw_league_roster_week   fact_lineup_week
action_log             raw_league_transaction   fact_waiver_claim
decision_snapshot      raw_league_division      fact_fa_pool_week
```

Those tables hold **other people's data**: sixteen managers' ESPN account GUIDs, their usernames,
eighteen member ids, and their complete add/drop/waiver/trade history, pulled with one owner's
authenticated session from a private league. None of them agreed to publication, and a
roster-and-transaction history re-identifies its league to anyone who knows it. That is a consent
question rather than a technical one, and no amount of column-stripping makes it not one.

### How the exclusion is enforced

Not by remembering. `src/data/datasetExport.ts` carries an **allowlist that fails CLOSED**, plus a
structural column scan, and `test/dataset-export-privacy.test.ts` asserts both:

- **An allowlist, not a denylist.** A denylist fails *open*: a table added next month is published
  by default and nobody finds out until it is on the internet. An allowlist fails *closed*: a new
  table is merely missing until someone deliberately adds it. There is a test that creates an
  unclassified table and asserts it is excluded.
- **A column scan, re-run every export.** The allowlist is a decision made once; the scan re-checks
  it against the live schema, so a table approved in March that gains a `league_id` in September
  **refuses the export** rather than quietly shrinking it.
- **A content scan.** The real manager handles are searched across every text column of every table
  about to be exported -- the only check that does not depend on column *names*, and so the only one
  that would catch a handle embedded in a JSON blob or a log line.

Audit of the published file, run on the exact artifact rather than on the plan that made it:

```
tables                : 31
league tables         : NONE
private columns       : NONE
manager handles found : 0  (16 handles searched)
```

`VACUUM INTO` is deliberately not used to build it: that copies the whole database, private tables
included, and a later `DROP` leaves those rows in freed pages a determined reader can recover. The
export is a fresh file that only ever had allowlisted tables copied into it.

## Regenerate it yourself

```
npm run ff -- export-dataset --out ff-dataset.db
```

Prints the row counts and how many tables were withheld, and writes `<out>.manifest.json`.

## IT IS A SNAPSHOT

Read `generatedAt` in the manifest before trusting anything in it during a season. This repo has an
expensive history with stale caches that looked live -- a downloaded snapshot is exactly that shape.
`npm run ff -- feeds` dates every feed in a store against a declared max age and tells you what to
re-run.

## Attribution and terms

- The NFL play-by-play, injury, depth-chart, snap-count, participation, combine and Next Gen Stats
  tables are derived from **[nflverse](https://github.com/nflverse)**, and carry nflverse's own
  terms. Please credit nflverse in anything built on them.
- Preseason projection columns derive from **FFToday**.
- ADP and trending columns derive from **Sleeper**.
- `player_ids` and `dim_player_key`'"'"'s external ids derive from the **DynastyProcess player ID map**
  ([dynastyprocess/data](https://github.com/dynastyprocess/data)), the crosswalk served as
  `nflreadr::load_ff_playerids()`. Please credit DynastyProcess. Its licence is stated on their
  repository -- check it before redistributing this dataset further; I have not independently
  verified the terms.
- This dataset is offered for research and personal use, with **no warranty** and no claim of
  ownership over any upstream source's data. If you are a rights-holder and want something removed,
  open an issue and it will be taken down.
- No ESPN league content is included -- see above.
