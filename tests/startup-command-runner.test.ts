import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCommandRunner } from "../electron/platform/command-runner";

const fixture = fileURLToPath(new URL("./fixtures/startup-runner-child.cjs", import.meta.url));
function runner(mode: string) { return createCommandRunner(process.execPath, [fixture, "direct", mode]); }

test("constructing/invalid command/pre-cancel never starts a child; snapshots cannot change records", async () => {
  const r = runner("echo"), controller = new AbortController(); assert.deepEqual(r.snapshot(), []);
  await assert.rejects(r.execute(["bad\0argument"], 1000, controller.signal), /Invalid/);
  controller.abort(Error("cancel before dispatch"));
  await assert.rejects(r.execute([], 1000, controller.signal), /cancel before dispatch/); assert.deepEqual(r.snapshot(), []);
  const active = new AbortController(); const output = await r.execute(["$(not-a-shell)", "a b"], 2000, active.signal);
  assert.deepEqual(JSON.parse(output.toString()), ["$(not-a-shell)", "a b"]);
  assert.equal(r.snapshot()[0].closed, true); assert.equal(r.snapshot()[0].exitCode, 0);
  const changed = r.snapshot(); changed[0].command.push("change"); changed[0].stdout = "change";
  assert.notEqual(r.snapshot()[0].stdout, "change"); assert.equal(r.snapshot()[0].command.includes("change"), false);
});

test("real nonzero exit preserves exact exit, both streams and child close", async () => {
  const r = runner("exit");
  await assert.rejects(r.execute([], 2000, new AbortController().signal), (error: any) =>
    error.code === 7 && error.signal === null && error.stdout.toString() === "partial" && error.stderr.toString() === "denied");
  const record = r.snapshot()[0]; assert.equal(record.exitCode, 7); assert.equal(record.status, "failed");
  assert.equal(record.stdout, "partial"); assert.equal(record.stderr, "denied"); assert.equal(record.closed, true);
  assert.equal(await r.finish(100), true);
});

test("real timeout/cancellation join their own child, keep partial output and do not invent exit0", async () => {
  for (const cancel of [false, true]) {
    const r = runner("sleep"), controller = new AbortController();
    const timer = cancel ? setTimeout(() => controller.abort(Error("user cancelled child")), 300) : undefined;
    try { await assert.rejects(r.execute([], cancel ? 2000 : 300, controller.signal)); }
    finally { clearTimeout(timer); }
    const record = r.snapshot()[0]; assert.equal(record.closed, true); assert.equal(record.signal, "SIGKILL");
    assert.equal(record.exitCode, null); assert.equal(record.stdout, "partial\n");
    assert.equal(record.stopReason, cancel ? "cancelled" : "timeout"); assert.equal(await r.finish(50), true);
  }
});

test("large stdout/stderr terminate boundedly and expose truncated evidence", async () => {
  for (const mode of ["large", "stderr-large"]) {
    const r = runner(mode); await assert.rejects(r.execute([], 2000, new AbortController().signal));
    const record = r.snapshot()[0]; assert.equal(record.closed, true); assert.equal(record.stopReason, "output-limit");
    assert.equal(record.signal, "SIGKILL"); assert.equal(mode === "large" ? record.stdout.length : record.stderr.length, 4096);
    assert.equal(mode === "large" ? record.stdoutTruncated : record.stderrTruncated, true);
  }
});

test("exit0 keeps warning stderr and bounded UTF8 prefixes; missing executable stays failed", async () => {
  const r = runner("text"), output = await r.execute([], 2000, new AbortController().signal);
  assert.equal(output.length, 6000); assert.equal(r.snapshot()[0].stderr, "warning"); assert.equal(r.snapshot()[0].stdoutTruncated, true);
  const missing = createCommandRunner("/no-such-startup-fixture-executable");
  await assert.rejects(missing.execute([], 2000, new AbortController().signal));
  const record = missing.snapshot()[0]; assert.equal(record.errorCode, "ENOENT"); assert.equal(record.closed, true);
  assert.equal(record.spawned, false); assert.equal(record.status, "failed"); assert.notEqual(record.exitCode, 0);
});

test("dispatch rejection does not spawn and finish stops only its own remaining child", async () => {
  const r = runner("sleep"); await assert.rejects(r.execute([], 2000, new AbortController().signal,
    { onDispatch: () => { throw Error("no launch approval"); } }), /no launch approval/);
  assert.equal(r.snapshot()[0].spawned, false);
  const second = runner("sleep"); const pending = second.execute([], 2000, new AbortController().signal).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 100));
  const partial = second.snapshot(); assert.equal(partial[0].stdout, "partial\n"); assert.equal(partial[0].closed, false);
  assert.equal(await second.finish(1000), true); await pending; assert.equal(second.snapshot()[0].closed, true);
  assert.equal(partial[0].closed, false);
});

test("exited parent with inherited pipes cannot hold the timeout open or become a success", async () => {
  const r = runner("inherited-pipe"), start = performance.now();
  await assert.rejects(r.execute([], 200, new AbortController().signal));
  const record = r.snapshot()[0]; assert.equal(record.exitCode, 0); assert.equal(record.closed, true);
  assert.equal(record.status, "failed"); assert.equal(record.stopReason, "timeout");
  assert.equal(record.stdout, "parent exited"); assert.ok(performance.now() - start < 450);
  await new Promise(resolve => setTimeout(resolve, 600)); // The unrelated descendant exits naturally, never killed.
});
