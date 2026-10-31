// THE NDJSON CLIENT FOR THE PERSISTENT `ff serve` HELPER -- dependency-free CommonJS so it can be
// unit-tested (test/serve-client.test.ts) with a fake child instead of Electron + a real engine.
//
// Protocol: the helper prints {"event":"ready"} once its imports and openDb() are done, then answers
// {id,method,params} lines with {id,ok,result|error}. The client (re)starts the helper on demand.
//
// EVERY CALL SETTLES (issue #24). The ready promise used to be resolvable only by the "ready" line,
// and the per-call timeout was armed inside `ready.then(...)`. A helper that died BEFORE ready (a
// better-sqlite3 ABI mismatch after an Electron/node bump, a migration throwing inside openDb, the
// store held by another process) therefore left every rpc() pending forever -- which stopped the
// in-app scheduler for the session (schedulerCycle never reached its reschedule) and left the
// Status page spinning with no error text. Now an exit before ready, or no ready within
// `readyTimeoutMs`, REJECTS the ready promise, so rpc() rejects and rpcOr() can show {error}.
function createServeClient({ spawn, readyTimeoutMs = 60000, rpcTimeoutMs = 30000 }) {
  let child = null, buf = "", ready = null, pending = new Map(), reqId = 0;

  function start() {
    const c = spawn();
    child = c; buf = "";
    let settled = false, res, rej, startT = null;
    ready = new Promise((a, b) => { res = a; rej = b; });
    ready.catch(() => {}); // no unhandled rejection when nobody is waiting on this start
    const fail = (msg) => { if (!settled) { settled = true; clearTimeout(startT); rej(new Error(msg)); } };
    startT = setTimeout(() => {
      fail(`serve not ready after ${Math.round(readyTimeoutMs / 1000)}s`);
      // A hung helper is useless and still holds the store: drop it so the next call respawns.
      if (child === c) child = null;
      try { c.kill(); } catch (_) { /* already gone */ }
    }, readyTimeoutMs);
    c.stdout.on("data", (d) => {
      if (child !== c) return; // a replaced/abandoned instance
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.event === "ready") { if (!settled) { settled = true; clearTimeout(startT); res(); } continue; }
        const p = pending.get(o.id);
        if (p) { pending.delete(o.id); o.ok ? p.resolve(o.result) : p.reject(new Error(o.error)); }
      }
    });
    let died = false;
    const die = (err) => {
      if (died) return; died = true;
      fail(err && err.message ? `serve failed to start: ${err.message}` : "serve exited before ready");
      if (child !== c) return; // already replaced; its calls belong to the new instance
      child = null;
      for (const p of pending.values()) p.reject(new Error("serve closed"));
      pending.clear();
    };
    c.on("close", () => die()); c.on("error", (e) => die(e));
  }

  function rpc(method, params) {
    if (!child) start();
    const c = child;
    return ready.then(() => new Promise((resolve, reject) => {
      if (child !== c) { reject(new Error("serve closed")); return; }
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      c.stdin.write(JSON.stringify({ id, method, params: params || {} }) + "\n");
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("rpc timeout: " + method)); } }, rpcTimeoutMs);
    }));
  }

  // `warm()` starts the helper eagerly (app launch) so the first real call does not pay its startup.
  return { rpc, warm: () => { if (!child) start(); }, current: () => child };
}

module.exports = { createServeClient };
