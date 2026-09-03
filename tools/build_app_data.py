# Generate app/renderer/data.js (window.PLAYERS + window.LAST_YR) from data/player-report.csv,
# so the Electron app (Fantasy Mission Control) has the board data embedded. Run after build_report.
# Run: uv run python tools/build_app_data.py
import os, csv, json

CSV = "data/player-report.csv"
OUT = "app/renderer/data.js"

with open(CSV, encoding="utf-8", errors="ignore") as f:
    rows = list(csv.DictReader(f))

NUM = {"Rank", "Bye", "Age", "Wt", "40yd", "OurValue$", "vsECR", "ProjPts",
       "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "Depth"}
for r in rows:
    for k, v in list(r.items()):
        if v in ("", None):
            continue
        if k in NUM or k.endswith("Pts") or k.endswith("Gms"):
            try:
                r[k] = float(v) if "." in str(v) else int(v)
            except ValueError:
                pass

last_yr = next((k[:4] for k in (rows[0].keys() if rows else []) if k.endswith("Gms") and k[:4].isdigit()), "LastYr")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write("window.PLAYERS = " + json.dumps(rows, ensure_ascii=False) + ";\n")
    f.write(f'window.LAST_YR = "{last_yr}";\n')
print(f"wrote {OUT} ({len(rows)} players)")
