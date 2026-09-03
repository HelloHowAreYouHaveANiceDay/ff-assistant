# Generate app/renderer/data.js (window.PLAYERS + window.NEWS + window.CONFIG + window.LAST_YR)
# from the single SQLite store (data/ff.db): the materialized `board` view + the `news` table,
# both populated by build_report / build_player_news. Run after those. Run: uv run python tools/build_app_data.py
import os, json, sqlite3

DB = "data/ff.db"
OUT = "app/renderer/data.js"
SEASON = 2026

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

# window.PLAYERS: the assembled board rows (row_json keyed by the display headers), ordered by rank.
rows = [json.loads(r["row_json"]) for r in con.execute(
    "SELECT row_json FROM board WHERE season = ? ORDER BY CAST(json_extract(row_json,'$.Rank') AS INTEGER)", (SEASON,))]

# Numeric coercion (identical to the old CSV path so the payload shape is unchanged).
NUM = {"Rank", "Bye", "Age", "Wt", "40yd", "OurValue$", "vsECR", "ProjPts",
       "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "Depth"}
for r in rows:
    for k, v in list(r.items()):
        if v in ("", None):
            continue
        if k in NUM or k.endswith("Pts") or k.endswith("Gms"):
            try:
                r[k] = float(v) if "." in str(v) else int(v)
            except (ValueError, TypeError):
                pass

last_yr = next((k[:4] for k in (rows[0].keys() if rows else []) if k.endswith("Gms") and k[:4].isdigit()), "LastYr")

# window.NEWS: the feed categories, from the news table (player_name -> player; url already un-escaped).
news = [dict(player=r["player_name"], pos=r["pos"], team=r["team"], category=r["category"],
             severity=r["severity"], detail=r["detail"], source=r["source"], asof=r["asof"], url=r["url"])
        for r in con.execute(
            "SELECT * FROM news WHERE category IN ('injury','headline','trending') ORDER BY id")]
con.close()

config = {
    "season": SEASON,
    "budget": 200,
    "slots": ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE", "BE"],
    "flex_ok": ["RB", "WR", "TE"],
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("window.PLAYERS = " + json.dumps(rows, ensure_ascii=False) + ";\n")
    f.write("window.NEWS = " + json.dumps(news, ensure_ascii=False) + ";\n")
    f.write("window.CONFIG = " + json.dumps(config) + ";\n")
    f.write(f'window.LAST_YR = "{last_yr}";\n')
print(f"wrote {OUT} from SQLite ({len(rows)} players, {len(news)} news items)")
