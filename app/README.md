# Fantasy Mission Control (desktop app)

The Electron desktop cockpit for the ff-assistant engine -- Phase 4. A mission-control shell
(sidebar nav + status bar) whose first view is the interactive draft board over the same data as
`tools/build_report.py` / the Google Sheet.

## Run
```
cd app
npm install                 # once; if node_modules/electron/dist/electron.exe is missing:
                            #   node node_modules/electron/install.js
npm start                   # opens the Mission Control window
```

## Refresh the data
The board reads `app/renderer/data.js` (generated). To refresh with the latest values/news:
```
# from the repo root:
uv run --with nflreadpy --with polars --with feedparser --with requests tools/build_player_news.py
uv run --with nflreadpy --with polars --with requests tools/build_report.py
uv run python tools/build_app_data.py     # -> app/renderer/data.js
```

## Layout
- `main.js` -- Electron main (window, external-link handling; `MC_CAPTURE=<png>` snapshots + quits).
- `renderer/index.html` -- the shell (sidebar + topbar + view).
- `renderer/app.js` -- nav + the draft-board table (search / filter / sort / badges / news links).
- `renderer/app.css` -- styling.
- `renderer/data.js` -- embedded player data (from `tools/build_app_data.py`).

## Next
Views stubbed for **My Team** (live roster + budget), **News** (the aggregated feed), **Draft Room**
(the live cockpit: current nomination + recommended max bid), **Settings**. These wire to the `ff`
engine via IPC. Then packaging (electron-builder) into a signed double-click installer.
