// The no-board banner must fire when the live board is unavailable, and stay silent when it is not.
// Both directions are tested, because a guard that can only ever say "no" is dead code that reads
// exactly like a guard that is passing.
//
// WHY THIS TEST EXISTS, AND WHAT WP14 (2026-09-16) CHANGED ABOUT IT.
// It began as the guard on `app/renderer/data.js` -- a 284 KB checked-in snapshot nothing
// regenerated, which rendered IDENTICALLY to the live board. A rebuilt board therefore "did not
// update" in the UI while being perfectly up to date in SQLite: the renderer had silently fallen
// back and was showing four-day-old dollar values that looked entirely plausible, which is the
// expensive kind of wrong.
//
// data.js is now DELETED (docs/ui-audit-2026-09-16.md 2.6 / 5.4). Deleting the snapshot deletes the
// failure class outright -- there is nothing plausible left to fall back TO -- so the banner's job
// changed from "these numbers are old" to "there are NO numbers, and here is which way the engine
// call failed". That is a strictly better failure: an empty board is legible, a plausible old one is
// not. Everything else this file locks is unchanged, because the second staleness path
// (`watchForRebuild`: the renderer HAD live data and it aged out underneath it) is untouched.
//
// It runs the REAL bytes of app.js -- the file is read, the functions are cut out of it by name and
// evaluated -- rather than a copy pasted into the test, so an edit to app.js that breaks the banner
// fails here instead of passing against a stale duplicate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const SRC = readFileSync("app/renderer/app.js", "utf8");

/** Cut one top-level `function name(...) { ... }` out of a source file by brace matching. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found in app/renderer/app.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

type El = { id: string; style: { cssText: string }; textContent: string };
function fakeDom() {
  const appended: El[] = [];
  const body = { style: { paddingTop: "" }, appendChild: (el: El) => appended.push(el) };
  const document = {
    getElementById: (id: string) => appended.find((e) => e.id === id) ?? null,
    createElement: () => ({ id: "", style: { cssText: "" }, textContent: "" }) as El,
    body,
  };
  return { document, body, appended };
}

function runBanner(src: { live: boolean; why: string }) {
  const dom = fakeDom();
  const fn = new Function("document", `${extractFn(SRC, "showNoBoardBanner")}; return showNoBoardBanner;`);
  fn(dom.document)(src);
  return dom;
}

test("banner appears, says the board is EMPTY rather than old, and names why the live path lost", () => {
  const dom = runBanner({ live: false, why: "no engine bridge (window.mc)" });
  assert.equal(dom.appended.length, 1, "expected exactly one banner element");
  const b = dom.appended[0];
  assert.equal(b.id, "no-board-banner");
  // The two things a reader needs now: that there is nothing on screen, and why.
  assert.match(b.textContent, /NO LIVE BOARD/);
  assert.match(b.textContent, /no engine bridge/, "must name the reason the live path failed");
  assert.match(b.textContent, /not old values/i,
    "must say the board is empty rather than stale -- the whole point of deleting data.js");
  assert.ok(dom.body.style.paddingTop, "must reserve space so it cannot cover the board");
});

test("banner is not duplicated if boot runs twice", () => {
  const dom = fakeDom();
  const fn = new Function("document", `${extractFn(SRC, "showNoBoardBanner")}; return showNoBoardBanner;`);
  const show = fn(dom.document);
  show({ live: false, why: "x" });
  show({ live: false, why: "x" });
  assert.equal(dom.appended.length, 1, "second call must be a no-op");
});

// THE POSITIVE DIRECTION. Fault injection proves the banner rejects a dead live path; it says
// nothing about whether the banner can ever stay quiet. If boot() called showNoBoardBanner
// unconditionally, every test above would still pass while the app permanently cried wolf.
test("boot only banners when the live path did NOT win", () => {
  const boot = extractFn(SRC, "boot");
  const call = boot.match(/^.*showNoBoardBanner.*$/m);
  assert.ok(call, "boot() must call showNoBoardBanner");
  assert.match(call[0], /if\s*\(\s*!\s*DATA_SOURCE\.live\s*\)/,
    "the call must be guarded on the live path having failed, not unconditional");
  assert.match(boot, /DATA_SOURCE\s*=\s*\{\s*live:\s*true/,
    "boot() must record live:true on the success path, or the guard can never be false");
});

// The empty-result path is the likelier real bug and is NOT a thrown error: appDataPayload queries
// `board` for config.season, so a season with no rows returns [] rather than raising.
test("an empty engine result is treated as failure, not success", () => {
  const boot = extractFn(SRC, "boot");
  assert.match(boot, /d\.players\.length/, "boot() must check the array is non-empty");
  assert.match(boot, /else\s*\{[\s\S]*?engine returned/,
    "a successful call returning zero players must set a reason, not fall through silently");
});

// WP14 FIX 1: main.js's nine `.catch(() => null)` handlers discarded the engine's error, and the
// renderer discarded it again -- which is how a live fault rendered as blank sections. `mc:appData`
// returns `{error}` now, and boot must SAY so rather than reporting "0 players" for a thrown rpc.
test("an engine error is reported as an error, not as zero players", () => {
  const boot = extractFn(SRC, "boot");
  assert.match(boot, /d\.error/, "boot() must read the {error} main.js now returns");
  assert.match(boot, /engine error/, "and must say so, distinctly from the empty-board case");
});

// The second staleness path: the renderer HAD live data and it aged out underneath it. Nothing is
// broken in that case, which is why nothing used to say anything.
test("boot arms the rebuild watcher on the live path", () => {
  const boot = extractFn(SRC, "boot");
  assert.match(boot, /watchForRebuild\(/, "boot() must arm the watcher when live data loads");
  const w = extractFn(SRC, "watchForRebuild");
  assert.match(w, /if\s*\(!seenAt\s*\|\|\s*!window\.mc/,
    "the watcher must no-op without a stamp or an engine bridge, or it polls forever in a browser");
  assert.match(w, /stamp === seenAt/, "it must compare against the stamp it booted with");
  // Push and poll must funnel through ONE comparison. Two copies of "has it changed?" is how the
  // fast path and the backstop drift into disagreeing about what stale means.
  assert.equal((w.match(/stamp === seenAt/g) || []).length, 1,
    "exactly one change-comparison, shared by the push and the poll");
});

// A rebuild should just APPEAR. Asking the user to click a bar made the app's own knowledge into
// the user's chore -- it knew the values changed and made them ask for them.
test("a rebuild is applied in place, not merely announced", () => {
  const w = extractFn(SRC, "watchForRebuild");
  assert.match(w, /DATA = d\.players/, "must adopt the new board, not just offer a reload");
  assert.match(w, /setPage\(curPage\)/, "must re-render the current page so the new values are visible");
  assert.match(w, /seenAt = d\.builtAt/, "must adopt the new stamp as baseline or it re-fires forever");
  // The webview carve-out: setPage on the browser page re-reveals the layer and re-runs its platform
  // switch under whoever is watching it. The page kind was "espn" until the 2026-09-16 multi-platform
  // renderer; the guard is on the platform-neutral "browser" kind now, and a guard on the OLD name is
  // exactly the silently-disabled check the rename produced (caught by WP4 of the architecture review).
  assert.match(w, /pg\.kind !== "browser"/, "must not re-render the browser page out from under the user");
  // The manual bar survives only as the failure path.
  assert.match(w, /catch \(e\) \{\s*showRebuiltBar\(\)/, "a failed fetch must fall back to the manual reload");
});

test("auto-apply is guarded against re-entrancy", () => {
  const w = extractFn(SRC, "watchForRebuild");
  assert.match(w, /if \(!stamp \|\| stamp === seenAt \|\| applying\) return/,
    "push and poll can fire together; a second apply must not race the first");
  assert.match(w, /finally \{ applying = false/, "the guard must clear even when the fetch throws");
});

// THE LAST-YEAR COLUMNS, which the snapshot used to supply the KEY for.
//
// The board serves its prior-season columns as `<year>Pts` / `<year>Gms`, so the column key is
// data-dependent. The renderer used to read that year from `window.LAST_YR` -- a global ONLY data.js
// set. Deleting data.js left it on the literal fallback "LastYr", so two columns were keyed on
// fields no row has: blank cells and a header that cannot sort. Nothing threw, and an empty cell
// reads as "no data for this player" rather than "wrong key", which is why it took clicking every
// sort header against the live app to find. The year comes from the engine's own payload now.
test("the prior-season column key comes from the engine payload, not a snapshot global", () => {
  const boot = extractFn(SRC, "boot");
  assert.match(boot, /setLastYr\(d\.lastYr\)/, "boot() must adopt the engine's lastYr");
  assert.match(extractFn(SRC, "watchForRebuild"), /setLastYr\(d\.lastYr\)/,
    "a rebuild can change the season too; the watcher must adopt it as well");
  // Comments stripped: this file explains the bug in prose, and a prose mention is not a read.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /window\.LAST_YR/, "the year must not come from a global nothing sets");
});

test("setLastYr actually re-keys the columns (the positive direction)", () => {
  const api = new Function(
    "let YR = 'LastYr'; let bst = { sort: 'Rank' };" +
    extractFn(SRC, "buildCols") + extractFn(SRC, "buildDescFirst") +
    "let COLS = buildCols(); let DESC_FIRST = buildDescFirst();" +
    extractFn(SRC, "setLastYr") +
    "return { setLastYr, cols: () => COLS.map(c => c[0]), desc: () => [...DESC_FIRST] };",
  )() as { setLastYr(y: unknown): void; cols(): string[]; desc(): string[] };

  assert.ok(api.cols().includes("LastYrPts"), "fixture precondition: starts on the fallback");
  api.setLastYr("2025");
  assert.ok(api.cols().includes("2025Pts"), "setLastYr did not re-key the columns");
  assert.ok(api.cols().includes("2025Gms"));
  assert.equal(api.cols().includes("LastYrPts"), false, "the fallback key survived the update");
  assert.ok(api.desc().includes("2025Pts"), "the descending-first set must be re-keyed with it, or the header sorts the wrong way");
  // A missing/empty year must leave the fallback alone rather than producing "undefinedPts".
  api.setLastYr(null);
  assert.ok(api.cols().includes("2025Pts"), "a null lastYr must be ignored, not adopted");
});

// THE CUT ITSELF, as a guard. The previous version of this test asserted data.js carried a date
// stamp so the banner could name it. The file is deleted; assert it STAYS deleted, and that nothing
// re-introduces a snapshot fallback -- re-adding either would restore the whole failure class.
test("there is no checked-in board snapshot to fall back to", () => {
  assert.equal(existsSync("app/renderer/data.js"), false,
    "app/renderer/data.js is back -- a snapshot that renders identically to live data is the bug");
  assert.doesNotMatch(SRC, /window\.PLAYERS|window\.NEWS|DATA_JS_STAMP/,
    "the renderer reads a snapshot global again -- the live path must be the only source");
  assert.doesNotMatch(readFileSync("app/renderer/index.html", "utf8"), /data\.js/,
    "index.html still loads a snapshot script");
});
