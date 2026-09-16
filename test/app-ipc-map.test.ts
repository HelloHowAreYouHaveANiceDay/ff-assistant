/**
 * WP14 (2026-09-16). THE IPC MAP, AS A GUARD RATHER THAN AS AN AUDIT FINDING.
 *
 * docs/ui-audit-2026-09-16.md 2.4 built this map by hand: every `window.mc.*` the renderer calls,
 * every channel `preload.js` exposes, every `ipcMain.handle`/`webContents.send` in `main.js`. It
 * found zero orphans in the main<->preload direction and FIFTEEN preload APIs with no live caller --
 * six invoked by nothing at all and nine reachable only from renderer code that had become
 * unreachable. A hand-built map is a snapshot of the day it was written, and enumerating by hand is
 * the same shape as a conformance check that names seven of fifteen drivers. So it is mechanical now.
 *
 * THREE DIRECTIONS, because each fails differently:
 *   preload -> main      a channel with no handler throws at runtime ("No handler registered").
 *   main    -> preload   a handler nothing exposes is dead weight nobody can reach.
 *   preload -> renderer  an API nobody calls is the exact dead weight this work package removed;
 *                        without this direction the surface silently re-grows.
 *
 * All three are computed from the real bytes of the three files, never from a list retyped here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PRELOAD = readFileSync("app/preload.js", "utf8");
const MAIN = readFileSync("app/main.js", "utf8");
const RENDERER = readFileSync("app/renderer/app.js", "utf8");

/** Strip // and /* *\/ comments so a channel named only in prose is not counted as wired. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const all = (src: string, re: RegExp) => uniq([...src.matchAll(re)].map((m) => m[1]));

// What preload exposes: the API NAME on window.mc, and the CHANNEL each one uses.
const preloadCode = code(PRELOAD);
const apiNames = all(preloadCode, /^\s*([A-Za-z][A-Za-z0-9_]*):\s*\(/gm);
const invoked = all(preloadCode, /ipcRenderer\.invoke\("([^"]+)"/g);
const listened = all(preloadCode, /ipcRenderer\.on\("([^"]+)"/g);

// What main provides.
const mainCode = code(MAIN);
const handled = all(mainCode, /ipcMain\.handle\("([^"]+)"/g);
const sent = all(mainCode, /webContents\.send\("([^"]+)"/g);

// What the renderer actually calls.
const rendererCode = code(RENDERER);
const called = uniq([
  ...[...rendererCode.matchAll(/\bmc\??\.([A-Za-z][A-Za-z0-9_]*)\s*(?:\?\.)?\(/g)].map((m) => m[1]),
  ...[...rendererCode.matchAll(/\bmc\.([A-Za-z][A-Za-z0-9_]*)\?\.\(/g)].map((m) => m[1]),
]);

test("the map is non-empty -- a regex that matched nothing would pass every test below", () => {
  assert.ok(apiNames.length >= 10, `preload exposed ${apiNames.length} APIs; the parse is broken`);
  assert.ok(handled.length >= 10, `main registered ${handled.length} handlers; the parse is broken`);
  assert.ok(called.length >= 8, `renderer called ${called.length} mc.* APIs; the parse is broken`);
});

test("every channel preload INVOKES has an ipcMain.handle in main.js", () => {
  const orphans = invoked.filter((c) => !handled.includes(c));
  assert.deepEqual(orphans, [], `preload invokes channels main does not handle -- these throw at runtime`);
});

test("every channel preload LISTENS on is actually sent by main.js", () => {
  const orphans = listened.filter((c) => !sent.includes(c));
  assert.deepEqual(orphans, [], `preload subscribes to pushes main never sends`);
});

test("every ipcMain.handle in main.js is exposed by preload", () => {
  const orphans = handled.filter((c) => !invoked.includes(c));
  assert.deepEqual(orphans, [], `main handles channels nothing can reach`);
});

test("every push main.js sends is subscribed by preload", () => {
  const orphans = sent.filter((c) => !listened.includes(c));
  assert.deepEqual(orphans, [], `main pushes into a renderer with no subscriber (mc:schedulerTick did this for months)`);
});

test("every window.mc API preload exposes is CALLED by the renderer", () => {
  const orphans = apiNames.filter((n) => !called.includes(n));
  assert.deepEqual(orphans, [],
    "preload exposes APIs the renderer never calls. That is the exact dead weight WP14 removed " +
    "(15 of 36); delete the API and its handler, or call it.");
});

test("every mc.* the renderer calls is exposed by preload", () => {
  const missing = called.filter((n) => !apiNames.includes(n));
  assert.deepEqual(missing, [], "the renderer calls window.mc APIs preload does not expose -- these are undefined at runtime");
});

// FAULT INJECTION. Every assertion above is a "no orphans" claim, and a comparison whose inputs never
// reach it reports no orphans forever. Prove the comparison can fail.
test("FAULT: an unhandled channel is caught", () => {
  const fake = [...invoked, "mc:doesNotExist"];
  assert.deepEqual(fake.filter((c) => !handled.includes(c)), ["mc:doesNotExist"]);
});
test("FAULT: an uncalled preload API is caught", () => {
  const fake = [...apiNames, "neverCalledByAnyone"];
  assert.deepEqual(fake.filter((n) => !called.includes(n)), ["neverCalledByAnyone"]);
});
