// Launch the user's Chrome or Edge with a CDP port + a PERSISTENT profile, so the
// ESPN login survives restarts (bro pattern). Run once; log into ESPN in the window
// that opens; then `npm run ff -- inspect-draft` attaches to it.
//
// Usage: node scripts/launch-chrome.mjs [--port 9222] [--edge]
// The persistent profile lives under ./.chrome-profile (gitignored).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const port = Number(valueOf("--port") ?? 9222);
const useEdge = args.includes("--edge");

const profileDir = resolve("./.chrome-profile");
if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

// Common Windows install locations; adjust if yours differs.
const candidates = useEdge
  ? [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ]
  : [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ];

const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.error(
    `Could not find ${useEdge ? "Edge" : "Chrome"} at:\n  ${candidates.join("\n  ")}\n` +
      `Edit scripts/launch-chrome.mjs with your browser path, or pass --edge.`,
  );
  process.exit(1);
}

const browserArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "https://www.espn.com/fantasy/football/",
];

console.log(`Launching ${bin}\n  CDP port: ${port}\n  profile:  ${profileDir}`);
console.log("Log into ESPN in the window that opens, then run: npm run ff -- inspect-draft");

const child = spawn(bin, browserArgs, { detached: true, stdio: "ignore" });
child.unref();

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
