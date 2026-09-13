import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireDraftLock } from "../src/draft/lock.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ff-lock-"));
}

// A separate PROCESS that takes the lock and holds it, so the concurrency is real (two OS processes
// racing the guard) rather than two calls in one event loop.
function runHolder(lockPath: string, holdMs = 500): Promise<{ code: number | null; out: string; err: string }> {
  const code = `
    import { acquireDraftLock } from ${JSON.stringify(new URL("../src/draft/lock.ts", import.meta.url).href)};
    const release = acquireDraftLock(process.argv[1]);
    console.log("owned");
    setTimeout(() => { release(); console.log("released"); }, Number(process.argv[2]));
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, lockPath, String(holdMs)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { err += String(d); });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err })));
}

test("draft lock: concurrent contenders yield exactly one owner while held", async () => {
  const dir = tempDir();
  try {
    const lock = join(dir, "auto-draft.lock");
    const [a, b] = await Promise.all([runHolder(lock), runHolder(lock)]);
    const owners = [a, b].filter((r) => r.out.includes("owned"));
    assert.equal(owners.length, 1, `expected one owner, got ${JSON.stringify([a, b])}`);
    assert.equal(owners[0].code, 0);
    assert.ok([a, b].some((r) => r.code !== 0 && /already running|operation in progress/.test(r.err)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draft lock: stale owner recovery remains exclusive", async () => {
  const dir = tempDir();
  try {
    const lock = join(dir, "auto-draft.lock");
    writeFileSync(lock, "pid=99999999 token=old started=2026-09-09T00:00:00.000Z\n", "utf8");
    const [a, b] = await Promise.all([runHolder(lock), runHolder(lock)]);
    assert.equal([a, b].filter((r) => r.out.includes("owned")).length, 1);
    assert.ok([a, b].some((r) => r.code !== 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draft lock: old release callback cannot remove a newer owner", () => {
  const dir = tempDir();
  try {
    const lock = join(dir, "auto-draft.lock");
    const release = acquireDraftLock(lock);
    const first = readFileSync(lock, "utf8");
    rmSync(lock);
    writeFileSync(lock, "pid=99999999 token=replacement started=2026-09-09T00:00:00.000Z\n", "utf8");
    release();
    assert.notEqual(readFileSync(lock, "utf8"), first);
    assert.match(readFileSync(lock, "utf8"), /token=replacement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
