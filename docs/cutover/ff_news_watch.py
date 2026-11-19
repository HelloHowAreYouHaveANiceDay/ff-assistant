"""ff-assistant breaking-news watch -- Hermes cron pre-run script (job 'ff-news-watch').

Refreshes league ownership + ESPN status + the news feed, then runs `ff news-watch`. Its stdout is
the job's context; when there is nothing new the last line is {"wakeAgent": false} and the agent is
never started (no tokens, no post). Repo: H:/working/ff-assistant (src/inseason/newsWatch.ts).
"""
import json, os, subprocess, sys, pathlib

REPO = r"H:\working\ff-assistant"
STATE_DIR = pathlib.Path(os.environ.get("LOCALAPPDATA", r"C:\Users\TLDR\AppData\Local")) / "hermes" / "data" / "ff-assistant"
STATE = STATE_DIR / "news-watch-state.json"
FAILS = STATE_DIR / "news-watch-fails.json"
LEAGUE = "462233"


def ff(args, env_extra=None, timeout=240):
    env = dict(os.environ, **(env_extra or {}))
    try:
        p = subprocess.run(["npm.cmd", "run", "--silent", "ff", "--", *args], cwd=REPO, env=env,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, f"timeout after {timeout}s"


def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    notes = []
    # Ownership: read through the bim bro espn session (D55). No ports, no env.
    rc, out = ff(["sync-rosters", "--league", LEAGUE], timeout=90)
    if rc != 0:
        notes.append("ownership refresh failed (bro espn session not logged in -- run `bim bro auth --site espn`) -- free-agent status may be stale")
    rc_s, _ = ff(["ingest-source", "status"])
    rc_n, out_n = ff(["ingest-source", "news"])
    if rc_s != 0:
        notes.append("ESPN status refresh failed")
    fails = json.loads(FAILS.read_text()) if FAILS.exists() else {"news": 0}
    fails["news"] = 0 if rc_n == 0 else fails.get("news", 0) + 1
    FAILS.write_text(json.dumps(fails))

    seed = [] if STATE.exists() else ["--seed"]
    rc_w, out_w = ff(["news-watch", "--league", LEAGUE, "--state", str(STATE), *seed], timeout=120)
    lines = [l for l in out_w.splitlines() if l.strip() and not l.startswith(">")]
    if rc_w != 0:
        print("ff news-watch FAILED:\n" + "\n".join(lines[-15:]))
        return
    gate_false = bool(lines) and lines[-1].replace(" ", "") == '{"wakeAgent":false}'
    if gate_false:
        if fails["news"] == 3:  # alert once on the third consecutive news-ingest failure, then stay quiet
            print("news-watch: the news ingest has failed 3 runs in a row -- the watch is blind.\n" + out_n[-800:])
            return
        print("\n".join(lines))
        return
    print("\n".join(lines))
    for n in notes:
        print("NOTE: " + n)


if __name__ == "__main__":
    main()
