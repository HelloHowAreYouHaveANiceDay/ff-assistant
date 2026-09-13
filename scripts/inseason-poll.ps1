# In-season continuous-update poller (Windows Task Scheduler).
#
# Runs `ff sync-actuals`, which is CHANGE-GATED: it fetches the nflverse current-season feed
# (cache-bypassed), and only when the actuals actually moved -- a game went final, or a stat
# correction landed -- does it rebuild the forward board and recompute the waiver/trade/odds
# snapshot. Until then it is a cheap no-op, so running this every few minutes is safe and idle-cheap.
#
# It is REFRESH-ONLY: it updates data and standing recommendations, and never makes an ESPN roster
# move (every copilot run is logged at status "recommended", D3).
#
# Register it to run every 15 minutes (adjust /mo for a different cadence; hourly off-gameday is
# plenty since nothing changes between slates):
#
#   schtasks /create /tn "ff-inseason-poll" ^
#     /tr "powershell -NoProfile -ExecutionPolicy Bypass -File H:\working\ff-assistant\scripts\inseason-poll.ps1" ^
#     /sc minute /mo 15
#
# Inspect / remove:
#   schtasks /query /tn "ff-inseason-poll"
#   schtasks /delete /tn "ff-inseason-poll" /f
#
# The decision snapshot it maintains is readable any time with:  npm run ff -- refresh-decisions
# (or straight from the decision_snapshot table). The poller's own output is appended to
# data\inseason-poll.log (gitignored).

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo "data\inseason-poll.log"
$ts = Get-Date -Format "s"
try {
  $out = & npm run -s ff -- sync-actuals 2>&1 | Out-String
  $code = $LASTEXITCODE
  Add-Content -Path $log -Value "[$ts] exit=$code`n$out"
  # A non-zero exit is a real failure a poller should surface; Task Scheduler records the last result.
  exit $code
} catch {
  Add-Content -Path $log -Value "[$ts] ERROR $($_ | Out-String)"
  exit 1
}
