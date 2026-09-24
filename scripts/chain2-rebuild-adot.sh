#!/usr/bin/env bash
# PHASE 2: populate the two prior-season role columns, then measure them.
#
# Phase 1 is done and every arm REJECTED (see docs/validation.md). This is the pre-registered
# remainder: the adot/WOPR pair needs columns that exist in the schema but are still NULL, so it
# needs the weekly rebuild that phase 1 was blocking.
#
# base2 IS RE-RUN AND THAT IS NOT OPTIONAL. The rebuild rewrites feat_player_week_model; a rebuild
# can move any column, so pairing a post-rebuild candidate against phase 1's pre-rebuild baseline
# would be two facts sampled from two separate runs. base2 also doubles as a CONTROL on the
# rebuild itself: if the rebuild changed nothing but the two new columns, base2's per-season CRPS
# should reproduce base's almost exactly, and a large drift means the rebuild moved something it
# should not have.
set -o pipefail
cd /h/working/ff-assistant || exit 1
S=/c/Users/TLDR/AppData/Local/Temp/claude/H--working-ff-assistant/1ac0e82e-cc20-466b-8f06-08caf8b704e4/scratchpad
LOG=$S/chain2.log
exec >>"$LOG" 2>&1
say() { echo "[$(date '+%H:%M:%S')] $*"; }

say "=== PHASE 2 START ==="

# ---- 1. consistent, VERIFIED backup ------------------------------------------------------------
BK=data/ff.db.bak-chain2-$(date '+%Y%m%d-%H%M%S')
say "backup -> $BK (VACUUM INTO; cp cannot see the WAL while the desktop app holds the store)"
node - "$BK" <<'NODE'
const Database = require("better-sqlite3");
const out = process.argv[2];
const db = new Database("data/ff.db", { readonly: true });
db.prepare("VACUUM INTO ?").run(out);
db.close();
const chk = new Database(out, { readonly: true });
const r = chk.prepare("PRAGMA integrity_check").get();
const v = r.integrity_check ?? Object.values(r)[0];
chk.close();
console.log("integrity_check: " + v);
if (String(v) !== "ok") process.exit(1);
NODE
[ $? = 0 ] || { say "ABORT: backup failed or did not verify"; exit 1; }
say "  backup verified: $(wc -c < "$BK") bytes"

# ---- 2. rebuild -------------------------------------------------------------------------------
# --artifact-dir IS NOT OPTIONAL: without it every historical season's line is projected from an
# artifact that has SEEN that season, contaminating the whole weekly table with lookahead. The
# blind artifacts were confirmed current (fittedAt 2026-09-19, same as the shipped projector).
say "rebuilding weekly features 2010-2026 with the BLIND artifact dir..."
npm run ff -- build-weekly-features --seasons 2010-2026 --current-season 2026 \
  --artifact-dir data/fold-artifacts-d16 > "$S/rebuild.log" 2>&1
RB=$?
say "  rebuild exit=$RB"
tail -12 "$S/rebuild.log"
[ "$RB" = "0" ] || { say "ABORT: rebuild failed"; exit 1; }

# ---- 3. PROVE THE LEVER IS CONNECTED -----------------------------------------------------------
# A present-but-empty column and a column with no effect give the SAME flat null. Without this the
# adot arm could measure a dead lever and report a null that reads exactly like a real one.
say "asserting the new columns are populated..."
node - > "$S/coverage.txt" 2>&1 <<'NODE'
const D = require("better-sqlite3")("data/ff.db", { readonly: true });
const r = D.prepare(
  `SELECT COUNT(*) n,
          SUM(prior_air_yards_share IS NOT NULL) a,
          SUM(prior_wopr IS NOT NULL) w
     FROM feat_player_week_model
    WHERE pos IN ('WR','TE') AND season BETWEEN 2012 AND 2025`).get();
const pa = (100 * r.a) / r.n, pw = (100 * r.w) / r.n;
console.log(`WR/TE rows ${r.n} | prior_air_yards_share ${r.a} (${pa.toFixed(1)}%) | prior_wopr ${r.w} (${pw.toFixed(1)}%)`);
console.log(pa > 30 && pw > 30 ? "CONNECTED" : "DEAD_LEVER");
D.close();
NODE
cat "$S/coverage.txt"
grep -q CONNECTED "$S/coverage.txt" || { say "ABORT: columns empty after rebuild -- the arm would measure a dead lever"; exit 1; }

# ---- 4. the two arms, through the RESILIENT runner ---------------------------------------------
sed 's/$/,prior_air_yards_share,prior_wopr/' "$S/base-features.txt" > "$S/adot-features.txt"
cp "$S/base-features.txt" "$S/base2-features.txt"
say "running base2 + adot (keep-artifacts + resume, 2 concurrent)"
ARMS="base2 adot" bash scripts/run-weekly-arms.sh
say "  base2=$(cat "$S/status-base2.txt" 2>/dev/null) adot=$(cat "$S/status-adot.txt" 2>/dev/null)"

# ---- 5. clean the npm banner off, then gate ----------------------------------------------------
node - "$S" <<'NODE'
const fs = require("fs"); const S = process.argv[2];
// `npm run` prints its banner to STDOUT and the evaluator prints progress there too, so the file
// is banner + progress + JSON and a plain JSON.parse throws. Take the first line that is exactly
// "{" and parses to EOF -- not the last brace, because a progress line can contain one.
function extract(t) {
  const pos = []; if (t.startsWith("{")) pos.push(0);
  for (let i = 0; (i = t.indexOf("\n{", i)) !== -1; i++) pos.push(i + 1);
  for (const p of pos) { const s = t.slice(p).trim(); try { const v = JSON.parse(s); if (v && typeof v === "object") return { v, s }; } catch {} }
  return null;
}
for (const arm of ["base2", "adot"]) {
  const p = `${S}/eval-${arm}.json`;
  if (!fs.existsSync(p)) { console.log(`${arm}: MISSING`); continue; }
  const raw = fs.readFileSync(p, "utf8"); const got = extract(raw);
  if (!got) { console.log(`${arm}: no parseable JSON in ${raw.length} bytes`); continue; }
  const by = got.v.bySeason ?? {}; fs.writeFileSync(p, got.s + "\n");
  console.log(`${arm}: ${Object.keys(by).length} seasons, cleaned`);
}
NODE

if [ "$(cat "$S/status-base2.txt" 2>/dev/null)" = "0" ] && [ "$(cat "$S/status-adot.txt" 2>/dev/null)" = "0" ]; then
  say "--- PAIRED FLOOR: base2 vs adot ---"
  node --import tsx scripts/weekly-paired-floor.mjs \
    --baseline "$S/eval-base2.json" --candidate "$S/eval-adot.json" > "$S/gate-adot.txt" 2>&1
  cat "$S/gate-adot.txt"
  say "--- CONTROL: base2 vs phase-1 base (should be ~identical if the rebuild moved only the new columns) ---"
  node --import tsx scripts/weekly-paired-floor.mjs \
    --baseline "$S/eval-base.json" --candidate "$S/eval-base2.json" > "$S/gate-rebuild-control.txt" 2>&1
  tail -12 "$S/gate-rebuild-control.txt"
else
  say "SKIP gate: an arm failed."
fi
say "=== PHASE 2 DONE ==="
