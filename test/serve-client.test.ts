/**
 * The app's NDJSON client for `ff serve` (app/serveClient.js): EVERY rpc() SETTLES (issue #24).
 *
 * The defect: the ready promise could only be resolved by the helper's {"event":"ready"} line, and
 * the per-call timeout was armed after ready. A helper that died before ready left every rpc()
 * pending forever, which stopped the in-app scheduler for the session. These tests drive the client
 * with a fake child process, so they need neither Electron nor the engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createServeClient } = require("../app/serveClient.js");

type Fake = EventEmitter & { stdout: EventEmitter; stdin: { write: (s: string) => void }; written: string[]; killed: boolean; kill: () => void; pid: number };
function fakeChild(): Fake {
  const c = new EventEmitter() as Fake;
  c.stdout = new EventEmitter();
  c.written = [];
  c.stdin = { write: (s: string) => { c.written.push(s); } };
  c.killed = false;
  c.kill = () => { c.killed = true; };
  c.pid = 4242;
  return c;
}
// Settle within `ms` or fail the test -- the bug is a promise that NEVER settles.
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms}ms`)), ms))]);

test("a helper that exits BEFORE ready rejects rpc() instead of hanging", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  const call = client.rpc("schedule-get");
  setImmediate(() => kids[0].emit("close", 1));
  await assert.rejects(within(call, 1000), /serve exited before ready/);
  assert.equal(client.current(), null);
});

test("a spawn error before ready (node not found) rejects with the cause", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  const call = client.rpc("app-data");
  setImmediate(() => kids[0].emit("error", new Error("spawn node ENOENT")));
  await assert.rejects(within(call, 1000), /serve failed to start: spawn node ENOENT/);
});

test("a helper that never says ready is timed out, killed, and replaced on the next call", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ readyTimeoutMs: 50, spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  await assert.rejects(within(client.rpc("schedule-get"), 1000), /serve not ready after/);
  assert.equal(kids[0].killed, true);
  // Recovery: the next call spawns a fresh helper, and it works.
  const next = client.rpc("schedule-get");
  assert.equal(kids.length, 2);
  kids[1].stdout.emit("data", '{"event":"ready"}\n');
  await new Promise((r) => setImmediate(r));
  const req = JSON.parse(kids[1].written[0]);
  kids[1].stdout.emit("data", JSON.stringify({ id: req.id, ok: true, result: { enabled: false } }) + "\n");
  assert.deepEqual(await within(next, 1000), { enabled: false });
  // The killed first helper closing late must not touch the live one.
  kids[0].emit("close", 1);
  assert.equal(client.current(), kids[1]);
});

test("after a failed start, the next rpc() restarts the helper (the scheduler can recover)", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  const first = client.rpc("schedule-get");
  setImmediate(() => kids[0].emit("close", 1));
  await assert.rejects(within(first, 1000));
  const second = client.rpc("schedule-get");
  assert.equal(kids.length, 2, "a second helper is spawned");
  kids[1].stdout.emit("data", '{"event":"ready"}\n');
  await new Promise((r) => setImmediate(r));
  const req = JSON.parse(kids[1].written[0]);
  assert.equal(req.method, "schedule-get");
  kids[1].stdout.emit("data", JSON.stringify({ id: req.id, ok: true, result: 7 }) + "\n");
  assert.equal(await within(second, 1000), 7);
});

test("normal path: ready, then replies resolve/reject by id; a death after ready rejects in-flight calls", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  const a = client.rpc("a"), b = client.rpc("b", { x: 1 }), c = client.rpc("c");
  // Ready split across chunks: the line buffer must reassemble it.
  kids[0].stdout.emit("data", '{"event":"rea');
  kids[0].stdout.emit("data", 'dy"}\nnot json noise\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(kids.length, 1, "one helper for concurrent calls");
  const reqs = kids[0].written.map((s) => JSON.parse(s));
  assert.deepEqual(reqs.map((r) => r.method), ["a", "b", "c"]);
  assert.deepEqual(reqs[1].params, { x: 1 });
  kids[0].stdout.emit("data", JSON.stringify({ id: reqs[1].id, ok: true, result: "B" }) + "\n" + JSON.stringify({ id: reqs[0].id, ok: false, error: "boom" }) + "\n");
  assert.equal(await b, "B");
  await assert.rejects(a, /boom/);
  kids[0].emit("close", 0);
  await assert.rejects(within(c, 1000), /serve closed/);
});

test("a call with no reply times out (the pre-existing per-call timeout still holds)", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ rpcTimeoutMs: 30, spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  const call = client.rpc("slow");
  kids[0].stdout.emit("data", '{"event":"ready"}\n');
  await assert.rejects(within(call, 1000), /rpc timeout: slow/);
});

test("warm() starts the helper once; later calls reuse it", async () => {
  const kids: Fake[] = [];
  const client = createServeClient({ spawn: () => { const c = fakeChild(); kids.push(c); return c; } });
  client.warm(); client.warm();
  assert.equal(kids.length, 1);
  const call = client.rpc("x");
  assert.equal(kids.length, 1);
  kids[0].stdout.emit("data", '{"event":"ready"}\n');
  await new Promise((r) => setImmediate(r));
  kids[0].stdout.emit("data", JSON.stringify({ id: JSON.parse(kids[0].written[0]).id, ok: true, result: 1 }) + "\n");
  assert.equal(await within(call, 1000), 1);
});
