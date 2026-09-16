// Run the test suite inside a disposable TMPDIR.
//
// Why this exists: ~100 call sites across test/ do mkdtempSync(join(tmpdir(), "ff-...")), and most
// have no teardown. Individually each leak is small; in aggregate they had put 11,719 directories
// (10.6 GB) into %TEMP%. The same defect in test/board-stamp.test.ts -- which copied the whole
// ~1 GB store per run -- reached 287 GB in nine days and took C: down to 26 GB free.
//
// Fixing 100 sites one at a time rots: the next test written will forget its rmSync too, and
// nothing fails when it does. Redirecting tmpdir() for the whole run fixes every site at once,
// including sites that do not exist yet. os.tmpdir() reads TMPDIR (POSIX) and TEMP/TMP (Windows),
// so setting all three covers both.
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = join(root, ".tmp-test");

const wipe = () => rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });

wipe();
mkdirSync(sandbox, { recursive: true });

// Explicit file list: with shell:false nothing expands a glob for us.
const passed = process.argv.slice(2);
const files = passed.length
  ? passed
  : readdirSync(join(root, "test"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => join("test", f));

const run = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
});

// Clean up even on failure -- a red run leaks exactly as much as a green one.
wipe();

process.exit(run.status ?? 1);
