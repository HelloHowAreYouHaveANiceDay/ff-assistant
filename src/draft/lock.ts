// Exclusive draft ownership: one auto-draft (or Assistant browser mutation) in a seat at a time.
//
// This replaces an inline lock in ff.ts that had two races. (1) Its check was existsSync -> read ->
// write, not atomic, so two contenders starting together could BOTH pass the check and BOTH write --
// two drafters, one lock file, bidding against each other (observed 2026-09-04: three concurrent
// auto-drafts in one room). (2) Release was an unconditional unlink, so a late release from a dead
// run could delete a NEWER owner's lock. Both are fixed here: a guarded critical section serializes
// inspect/reclaim/release, and an ownership TOKEN means release only removes the exact lock it took.
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** The lock is held by a LIVE process. Thrown so the caller can print its own operator guidance
 *  (and exit) rather than the library deciding how to fail. Carries the holder's pid. */
export class DraftLockHeldError extends Error {
  constructor(public readonly pid: number, public readonly path: string) {
    super(`Another draft action is already running (pid ${pid}). Stop it before starting another.`);
    this.name = "DraftLockHeldError";
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

// Serialize inspection, stale-owner recovery, and release behind a `.guard` file created with
// exclusive `wx`. If a process dies INSIDE this short critical section, the guard is left in place
// and operator recovery is required -- a deliberately loud failure, not a silent double-entry.
function guarded<T>(path: string, operation: () => T): T {
  const guard = `${path}.guard`;
  let fd: number;
  try { fd = openSync(guard, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Draft lock operation in progress (${guard}); if its process crashed, stop automation before removing this guard.`, { cause: error });
    throw error;
  }
  try { return operation(); }
  finally { closeSync(fd); unlinkSync(guard); }
}

/**
 * Take the lock at `path`, returning a release function. Refuses if a LIVE process other than us
 * already holds it, unless `force` is set (used by `--force-lock` when the operator knows the holder
 * is dead). A dead owner -- or our own stale record -- is reclaimed. `onReclaim` fires when an
 * existing record is replaced, so a CLI can log it.
 */
export function acquireDraftLock(
  path: string,
  opts: { force?: boolean; onReclaim?: (pid: number | null) => void } = {},
): () => void {
  const owner = `pid=${process.pid} token=${randomUUID()} started=${new Date().toISOString()}\n`;
  guarded(path, () => {
    const previous = read(path);
    if (previous !== null) {
      const pid = Number(previous.match(/\bpid=(\d+)\b/)?.[1]);
      const readable = Number.isSafeInteger(pid) && pid > 0;
      if (!readable && !opts.force)
        throw new Error(`Unreadable draft lock ${path}; stop automation before removing it (or pass force).`);
      if (readable && pid !== process.pid && alive(pid) && !opts.force)
        throw new DraftLockHeldError(pid, path);
      // Reclaim: a dead owner, our own stale record, or a live one under force.
      opts.onReclaim?.(readable ? pid : null);
      unlinkSync(path);
    }
    // Exclusive create -- inside the guard, after any reclaim, so this cannot clobber a live owner.
    writeFileSync(path, owner, { encoding: "utf8", flag: "wx" });
  });
  let released = false;
  return () => {
    if (released) return;
    guarded(path, () => {
      // ONLY our exact record. A newer owner's lock is left untouched -- the release-after-death bug.
      if (read(path) === owner) unlinkSync(path);
      released = true;
    });
  };
}
