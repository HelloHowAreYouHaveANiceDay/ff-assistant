# One-command refresh: (optionally) rebuild the news feed + player report, then push the exhaustive
# draft board to a live Google Sheet -- data + formatting + clickable news links -- via bim-cli's
# google driver. bim-google has no "create spreadsheet" verb and a stdin size limit, so we create
# via its cached OAuth token and write the grid in row chunks.
#
# Run: uv run --with nflreadpy --with polars --with feedparser --with requests python tools/push_sheet.py \
#         [--spreadsheet <id-or-url>] [--title "FF Draft Board 2026"] [--no-rebuild]
#   no --spreadsheet -> creates a new sheet and prints its URL.
import os, sys, csv, json, subprocess, urllib.request

BIM = os.environ.get("BIM_BIN", r"C:/Users/TLDR/AppData/Local/bim-cli/bim")
TOKEN = r"C:/Users/TLDR/AppData/Roaming/bim-google/token.json"
CSV = "data/player-report.csv"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHUNK = 130  # rows per write (bim forwards stdin with a size cap; ~130x28 stays under it)

def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

def sh(*a, stdin=None):
    # decode as UTF-8 (bim emits UTF-8; Windows' default cp1252 crashes on special bytes)
    return subprocess.run(a, input=stdin, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=REPO)

def bim(*a):
    r = sh(BIM, "google", *a)
    out = (r.stdout or r.stderr or "").strip().splitlines()
    return out[0] if out else ""

def col_letter(i):  # 0-based index -> A, B, ... Z, AA, AB
    s = ""
    i += 1
    while i:
        i, rem = divmod(i - 1, 26)
        s = chr(65 + rem) + s
    return s

# --- 1. optional rebuild of the underlying data ---
if "--no-rebuild" not in sys.argv:
    print("rebuilding news feed + report ...")
    for deps, script in [(["nflreadpy", "polars", "feedparser", "requests"], "tools/build_player_news.py"),
                         (["nflreadpy", "polars", "requests"], "tools/build_report.py")]:
        cmd = ["uv", "run"] + sum([["--with", d] for d in deps], []) + [script]
        r = sh(*cmd)
        print(" ", script, "->", (r.stdout.strip().splitlines() or ["(no output)"])[-1])
        if r.returncode != 0:
            print(r.stderr[-400:]); sys.exit(1)

# --- 2. build the grid: hyperlink "Latest News" via NewsURL, then drop the NewsURL column ---
with open(os.path.join(REPO, CSV), encoding="utf-8", errors="ignore") as f:
    rows = list(csv.reader(f))
header = rows[0]
ni = header.index("Latest News") if "Latest News" in header else -1
ui = header.index("NewsURL") if "NewsURL" in header else -1
grid = []
for r_i, row in enumerate(rows):
    row = list(row)
    if r_i > 0 and ni >= 0 and ui >= 0 and row[ui] and row[ni]:
        row[ni] = '=HYPERLINK("%s","%s")' % (row[ui], row[ni].replace('"', '""'))
    if ui >= 0:
        row = [c for j, c in enumerate(row) if j != ui]
    out = []
    for c in row:
        if isinstance(c, str) and c.startswith("="):
            out.append(c); continue
        try:
            out.append(int(c))
        except ValueError:
            try: out.append(float(c))
            except ValueError: out.append(c)
    grid.append(out)
sheet_header = [c for j, c in enumerate(header) if j != ui]
ncol = len(sheet_header)
last = col_letter(ncol - 1)
nrow = len(grid)

# --- 3. auth (refresh token) + create-or-target the spreadsheet ---
bim("drive", "list")  # forces bim to refresh the cached token
sid = arg("--spreadsheet")
if sid and "/spreadsheets/d/" in sid:
    sid = sid.split("/spreadsheets/d/")[1].split("/")[0]
tok = json.load(open(TOKEN))["access_token"]
title = arg("--title", "FF Draft Board 2026")
if not sid:
    req = urllib.request.Request("https://sheets.googleapis.com/v4/spreadsheets",
                                 data=json.dumps({"properties": {"title": title}}).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}, method="POST")
    r = json.load(urllib.request.urlopen(req))
    sid = r["spreadsheetId"]; print("created", r["spreadsheetUrl"])

# --- 4. clear, then chunk-write the grid ---
bim("sheets", "clear", "--spreadsheet", sid, "--range", f"Sheet1!A1:{last}1000")
bim("sheets", "conditional-format", "--spreadsheet", sid, "--range", f"Sheet1!A1:{last}1000", "--clear")
for i in range(0, nrow, CHUNK):
    payload = json.dumps(grid[i:i + CHUNK])
    r = sh(BIM, "google", "sheets", "write", "--grid", "--spreadsheet", sid, "--range", f"Sheet1!A{i + 1}", stdin=payload)
    print(f"  wrote rows {i + 1}..{min(i + CHUNK, nrow)}: {(r.stdout or r.stderr).strip()[:60]}")

# --- 5. format by COLUMN NAME (robust to reordering) ---
def numfmt(name):
    if name == "OurValue$": return "$#,##0"
    if name == "40yd": return "0.00"
    if name in ("Age", "ECR", "ESPN_ADP"): return "0.0"
    if name.endswith("Pts"): return "0.0"           # ProjPts, {yr}Pts
    if name in ("Bye", "vsECR", "Wt") or name.endswith("Gms"): return "0"
    return None

bim("sheets", "format", "--spreadsheet", sid, "--range", f"Sheet1!A1:{last}1",
    "--bold", "--bg-color", "#4472C4", "--fg-color", "#FFFFFF", "--halign", "CENTER", "--freeze-rows", "1", "--freeze-cols", "2")
for i, name in enumerate(sheet_header):
    fmt = numfmt(name)
    if fmt:
        col = col_letter(i)
        bim("sheets", "format", "--spreadsheet", sid, "--range", f"Sheet1!{col}2:{col}{nrow}", "--number-format", fmt)
    if name.endswith("Gms"):
        col = col_letter(i)
        bim("sheets", "conditional-format", "--spreadsheet", sid, "--range", f"Sheet1!{col}2:{col}{nrow}",
            "--condition", "NUMBER_LESS", "--value", "10", "--bg-color", "#FCE5CD")
    if name == "SleeperBuzz":
        col = col_letter(i)
        bim("sheets", "conditional-format", "--spreadsheet", sid, "--range", f"Sheet1!{col}2:{col}{nrow}", "--condition", "TEXT_CONTAINS", "--value", "DROP", "--bg-color", "#F4CCCC")
        bim("sheets", "conditional-format", "--spreadsheet", sid, "--range", f"Sheet1!{col}2:{col}{nrow}", "--condition", "TEXT_CONTAINS", "--value", "ADD", "--bg-color", "#D9EAD3")

print(f"DONE -> https://docs.google.com/spreadsheets/d/{sid}/edit  ({nrow - 1} players, {ncol} columns)")
