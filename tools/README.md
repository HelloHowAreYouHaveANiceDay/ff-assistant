# tools/ — legacy Python pipeline (superseded)

These are the **original** nflverse/FantasyPros data scripts. The data layer has since been
**ported to TypeScript** under `src/data/*` (run via `ff ingest` / `ff ingest-source <id>`), which
is what the CLI and the app actually use. The Python here is kept for **provenance** — each TS
module names its origin (e.g. `assemble.ts` "was `build_report.py`") — and as a cross-check when a
port is in doubt. **Do not extend these; add to `src/data/` instead.**

| Python (legacy) | Ported to (live) |
|---|---|
| `build_report.py` | `src/data/assemble.ts` |
| `build_player_news.py` | `src/data/news.ts` |
| `build_projections.py` | `src/data/projections.ts` |
| `build_points.py` | `src/data/projections.ts` (curve) |
| `build_history.py` / `build_weekly.py` | `src/data/history.ts` |
| `build_app_data.py` | `src/data/appdata.ts` |
| `build_def_ratings.py` | `src/data/rankings.ts` (def ratings) |

**Still invoked (not yet ported):**
- `push_sheet.py` — exports the board to the Google Sheet (called from the app's "push to sheet").
- `validate_matchup.py` — projection-calibration validator (the 57k player-week check cited in
  `src/projections.ts`); run by hand.
