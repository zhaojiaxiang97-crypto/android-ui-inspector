import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugObserver } from "../electron/automation/device-actions";

test("authorization owns one lazy observer and settled waits for its cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "observer-lifecycle-"));
  let observed = 0, closed = 0, owner = "", lifetime: AbortSignal | undefined, release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const session = new DebugSession({ serial: "fixture", packageName: "com.example.fixture", directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => { throw Error("unowned observer must not run"); },
    createObserver: (sessionId, signal) => {
      owner = sessionId; lifetime = signal;
      const observe: DebugObserver = async () => { observed++; throw Error("offline fixture"); };
      return Object.assign(observe, { close: () => { closed++; assert.equal(signal.aborted, true); return cleanup; } });
    } });
  try {
    assert.equal(owner, session.state.id); assert.equal(observed, 0); assert.equal(lifetime!.aborted, false);
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    assert.equal(observed, 1);
    session.stop("授权撤销"); session.stop("重复停止");
    assert.equal(closed, 1); assert.equal(session.hasPendingWork, true);
    let settled = false;
    const done = session.settled().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    release(); await done;
    assert.equal(session.hasPendingWork, false); assert.equal(session.state.active, false);
    await assert.rejects(session.request({ name: "capture_ui", input: { sessionId: session.state.id } }), /会话已结束/);
    assert.equal(observed, 1);
  } finally { release(); session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("observer cleanup failure is recorded and cannot revive the authorization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "observer-cleanup-failure-"));
  const observe: DebugObserver = async () => { throw Error("no device"); };
  const session = new DebugSession({ serial: "fixture", packageName: "com.example.fixture", directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {}, observe,
    createObserver: () => Object.assign(observe, { close: async () => { throw Error("owned forward changed"); } }) });
  try {
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    session.stop(); await session.settled();
    assert.equal(session.state.active, false); assert.equal(session.hasPendingWork, false);
    assert.ok(session.state.steps.at(-1)!.recordingErrors?.some(error => error.code === "observation_cleanup_failed"));
    const report = JSON.parse(readFileSync(session.state.reportPath!, "utf8"));
    assert.match(report.session.stopReason, /观察连接清理失败/);
    assert.ok(report.steps.at(-1).step.recordingErrors.some((error: { code: string }) => error.code === "observation_cleanup_failed"));
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("cleanup failure before any observation is retained as a session warning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "observer-empty-cleanup-"));
  const observe: DebugObserver = async () => { throw Error("no device"); };
  const session = new DebugSession({ serial: "fixture", packageName: "com.example.fixture", directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {}, observe,
    createObserver: () => Object.assign(observe, { close: async () => { throw Error("cleanup fixture"); } }) });
  try {
    session.stop(); await session.settled();
    assert.equal(session.state.steps.length, 0);
    const report = JSON.parse(readFileSync(session.state.reportPath!, "utf8"));
    assert.match(report.session.stopReason, /观察连接清理失败/);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});
