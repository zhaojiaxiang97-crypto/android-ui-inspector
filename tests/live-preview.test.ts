import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_PREVIEW_INTERVAL_MS, acceptLivePreviewEvent, isLivePreviewSerial, isLivePreviewSessionId,
  livePreviewStatusText, livePreviewTimeLabel, type LivePreviewEvent,
} from "../shared/live-preview";
import {
  LivePreviewController, LivePreviewDisconnectedError, runPreviewScreenCommand, captureLivePreviewScreen,
  type LivePreviewImage,
} from "../electron/device/live-preview";
import { captureScreen } from "../electron/device/screen";

const image = (value = "frame"): LivePreviewImage => ({ screenshotDataUrl: `data:image/png;base64,${value}`, size: { width: 1080, height: 2400 } });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture() {
  let time = Date.parse("2026-10-12T01:00:00Z"), nextId = 0, busy = false, active = 0, peak = 0;
  const jobs: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const captures: { serial: string; signal: AbortSignal; resolve: (value: LivePreviewImage) => void; reject: (error: unknown) => void }[] = [];
  const events: LivePreviewEvent[] = [];
  const controller = new LivePreviewController({
    now: () => time, sessionId: () => `preview-${++nextId}`, isBusy: () => busy,
    onEvent: event => events.push(event),
    setTimer: (callback, delay) => {
      const job = { callback, delay, cancelled: false }; jobs.push(job);
      return () => { job.cancelled = true; };
    },
    capture: (serial, signal) => new Promise<LivePreviewImage>((resolve, reject) => {
      active++; peak = Math.max(peak, active);
      captures.push({ serial, signal, resolve: value => { active--; resolve(value); }, reject: error => { active--; reject(error); } });
    }),
  });
  return {
    controller, events, captures,
    setBusy(value: boolean) { busy = value; },
    getPeak: () => peak,
    pendingTimers: () => jobs.filter(job => !job.cancelled).length,
    async next() {
      const job = jobs.find(candidate => !candidate.cancelled);
      assert(job, "expected a scheduled frame");
      job.cancelled = true; time += job.delay; job.callback(); await flush();
      return job.delay;
    },
  };
}

test("preview is opt-in; single frame flight, low rate, pause keeps image and close clears it", async () => {
  const f = fixture();
  assert.equal(f.captures.length, 0); assert.equal(f.pendingTimers(), 0);
  const opened = await f.controller.start("device-a");
  assert.equal(opened.state.status, "running"); assert.equal(opened.frame, null);
  assert.equal(await f.next(), 0); assert.equal(f.captures.length, 1);
  assert.equal(f.pendingTimers(), 0, "no interval queues while screencap is unfinished");
  f.captures[0].resolve(image("first")); await f.controller.settled();
  const first = f.controller.getEvent().frame;
  assert(first); assert.equal(first.sequence, 1); assert.equal(first.serial, "device-a");
  assert.equal(await f.next(), LIVE_PREVIEW_INTERVAL_MS); assert.equal(f.captures.length, 2);
  const pause = f.controller.pause(opened.state.sessionId!);
  assert.equal(f.captures[1].signal.aborted, true);
  f.captures[1].resolve(image("late-paused")); await pause;
  assert.equal(f.controller.getEvent().state.status, "paused");
  assert.deepEqual(f.controller.getEvent().frame, first);
  assert.equal(f.pendingTimers(), 0);
  await f.controller.resume(opened.state.sessionId!); await f.next();
  f.captures[2].resolve(image("resumed")); await f.controller.settled();
  assert.equal(f.controller.getEvent().frame?.sequence, 2);
  assert.equal(f.getPeak(), 1);
  await f.controller.stop("closed", opened.state.sessionId!);
  assert.equal(f.controller.getEvent().frame, null);
  assert.equal(f.controller.getEvent().state.frameCapturedAt, null);
  assert.equal(f.pendingTimers(), 0);
});

test("a device switch aborts old work, drops late frames and rejects stale controls", async () => {
  const f = fixture();
  const a = await f.controller.start("device-a"); await f.next();
  const startB = f.controller.start("device-b");
  assert.equal(f.captures[0].signal.aborted, true);
  assert.equal(f.controller.getEvent().state.serial, "device-b");
  f.captures[0].resolve(image("old-device"));
  const b = await startB;
  assert.notEqual(b.state.sessionId, a.state.sessionId);
  assert.equal(b.frame, null); await f.next();
  f.captures[1].resolve(image("new-device")); await f.controller.settled();
  assert.equal(f.controller.getEvent().frame?.serial, "device-b");
  await f.controller.pause(a.state.sessionId!);
  await f.controller.stop("closed", a.state.sessionId!);
  assert.equal(f.controller.getEvent().state.status, "running");
  assert.equal(f.events.filter(event => event.frame?.screenshotDataUrl.endsWith("old-device")).length, 0);
  assert.equal(f.getPeak(), 1);
  await f.controller.dispose();
});

test("rapid reopen on the same device gets a new session; late viewer cleanup cannot close it", async () => {
  const f = fixture();
  const firstStart = f.controller.start("device-a"), secondStart = f.controller.start("device-a");
  const first = await firstStart, second = await secondStart;
  assert.notEqual(first.state.sessionId, second.state.sessionId);
  await f.controller.stop("closed", first.state.sessionId!);
  assert.equal(f.controller.getEvent().state.sessionId, second.state.sessionId);
  assert.equal(f.controller.getEvent().state.status, "running");
  assert.equal(f.pendingTimers(), 1);
  await f.controller.dispose();
});

test("busy inspection and debug work yield the stream without a backlog", async () => {
  const f = fixture();
  await f.controller.start("device-a"); f.setBusy(true); await f.next();
  assert.equal(f.captures.length, 0);
  assert.equal(f.controller.getEvent().state.activity, "waiting");
  for (let index = 0; index < 4; index++) await f.next();
  assert.equal(f.captures.length, 0); assert.equal(f.pendingTimers(), 1);
  f.setBusy(false); await f.next(); assert.equal(f.captures.length, 1);
  f.setBusy(true); const yielded = f.controller.yieldForCapture();
  assert.equal(f.captures[0].signal.aborted, true);
  f.captures[0].resolve(image("yielded-frame")); await yielded;
  assert.equal(f.controller.getEvent().frame, null);
  await f.next(); assert.equal(f.captures.length, 1);
  f.setBusy(false); await f.next(); f.captures[1].resolve(image("after-work")); await f.controller.settled();
  assert.equal(f.controller.getEvent().frame?.screenshotDataUrl, image("after-work").screenshotDataUrl);
  assert.equal(f.getPeak(), 1); await f.controller.dispose();
});

test("a failed frame pauses; disconnect and window disposal clear frames and stop polling", async () => {
  const f = fixture(); const opened = await f.controller.start("device-a"); await f.next();
  f.captures[0].resolve(image("last-good")); await f.controller.settled(); await f.next();
  f.captures[1].reject(Error("截图超时")); await f.controller.settled();
  assert.equal(f.controller.getEvent().state.status, "paused");
  assert.equal(f.controller.getEvent().state.error, "截图超时");
  assert.equal(f.controller.getEvent().frame?.sequence, 1); assert.equal(f.pendingTimers(), 0);
  await f.controller.resume(opened.state.sessionId!); await f.next();
  f.captures[2].reject(new LivePreviewDisconnectedError("offline")); await f.controller.settled();
  assert.equal(f.controller.getEvent().state.stopReason, "device-disconnected");
  assert.equal(f.controller.getEvent().frame, null); assert.equal(f.pendingTimers(), 0);
  await f.controller.start("device-a"); await f.next();
  const disposed = f.controller.dispose("app-quit");
  f.captures[3].resolve(image("late-exit")); await disposed;
  assert.equal(f.controller.getEvent().state.stopReason, "app-quit");
  assert.equal(f.controller.getEvent().frame, null); assert.equal(f.pendingTimers(), 0);
  await assert.rejects(f.controller.start("device-a"), /窗口已关闭/);
});

test("renderer events retain paused frames, reject old revisions and never cross device/session identities", async () => {
  const f = fixture(); const opened = await f.controller.start("device-a"); await f.next();
  f.captures[0].resolve(image("observed")); await f.controller.settled();
  const captured = f.controller.getEvent(), sessionId = opened.state.sessionId!;
  let view = acceptLivePreviewEvent(null, captured, "device-a", sessionId);
  assert(view?.frame); await f.controller.pause(sessionId);
  const paused = f.events.at(-1)!;
  assert.equal(paused.frame, undefined);
  view = acceptLivePreviewEvent(view, paused, "device-a", sessionId);
  assert.equal(view?.state.status, "paused"); assert.deepEqual(view?.frame, captured.frame);
  assert.equal(acceptLivePreviewEvent(view, captured, "device-a", sessionId), view);
  assert.equal(acceptLivePreviewEvent(view, { ...captured, state: { ...captured.state, serial: "device-b", revision: 999 } }, "device-a", sessionId), view);
  assert.equal(acceptLivePreviewEvent(view, { ...captured, state: { ...captured.state, sessionId: "old-session", revision: 999 } }, "device-a", sessionId), view);
  assert.equal(acceptLivePreviewEvent(view, { ...captured, state: { ...captured.state, revision: 999 }, frame: { ...captured.frame!, serial: "device-b" } }, "device-a", sessionId), view);
  await f.controller.stop(); view = acceptLivePreviewEvent(view, f.events.at(-1)!, "device-a", sessionId);
  assert.equal(view?.frame, null);
  assert.equal(livePreviewStatusText(paused.state), "已暂停");
  assert.equal(livePreviewTimeLabel(undefined), "尚未采集"); assert.equal(livePreviewTimeLabel("not-a-date"), "时间未知");
});

test("preview screenshot reuses the screen entry and skips geometry diagnostics", async () => {
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(1080, 16); png.writeUInt32BE(2400, 20);
  const calls: string[][] = [];
  const result = await captureScreen("unused-adb", "device-a", { readGeometry: false, runScreenshot: async (path, serial) => {
    calls.push([path, serial]); return { code: 0, stdout: png, stderr: "" };
  } });
  assert.deepEqual(calls, [["unused-adb", "device-a"]]);
  assert.equal(result.captureGeometry, undefined); assert.equal(result.screenshotDataUrl, `data:image/png;base64,${png.toString("base64")}`);
});

test("IPC identities are bounded and cannot become command flags or shell input", async () => {
  assert(isLivePreviewSerial("192.168.1.8:5555")); assert(isLivePreviewSessionId("preview-123"));
  for (const bad of [null, "", "-s device", ";reboot", "$(cmd)", "a".repeat(257)]) assert.equal(isLivePreviewSerial(bad), false);
  for (const bad of [null, "", "a/b", "a".repeat(129)]) assert.equal(isLivePreviewSessionId(bad), false);
  const signal = new AbortController().signal;
  await assert.rejects(captureLivePreviewScreen("-s device", signal), /设备无效/);
});

function commandFixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-preview-")), executable = join(directory, "adb");
  writeFileSync(executable, `#!${process.execPath}\n${source}\n`); chmodSync(executable, 0o755);
  return { directory, executable, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("real preview entry uses only the isolated screencap and classifies missing/invalid devices", { skip: process.platform === "win32", timeout: 15000 }, () => {
  const f = commandFixture(`
    const fs = require('node:fs');
    fs.appendFileSync(process.env.PREVIEW_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
    const mode = process.env.PREVIEW_MODE;
    if (mode === 'offline' || mode === 'unauthorized' || mode === 'missing') {
      process.stderr.write(mode === 'missing' ? "error: device 'device-a' not found" : 'error: device ' + mode); process.exit(1);
    }
    if (mode === 'invalid') process.stdout.write('not png');
    else {
      const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
      png.writeUInt32BE(13,8); png.write('IHDR',12);
      png.writeUInt32BE(mode === 'oversized' ? 10000 : 1080,16); png.writeUInt32BE(mode === 'oversized' ? 10000 : 2400,20);
      process.stdout.write(png);
    }
  `);
  mkdirSync(join(f.directory, "platform-tools")); copyFileSync(f.executable, join(f.directory, "platform-tools", "adb"));
  const calls = join(f.directory, "calls.jsonl");
  const entry = join(import.meta.dirname, "../electron/device/live-preview.ts");
  const script = `import { captureLivePreviewScreen, LivePreviewDisconnectedError } from ${JSON.stringify(entry)};
    try { const image = await captureLivePreviewScreen('device-a', new AbortController().signal); console.log(JSON.stringify({ ok: true, size: image.size, png: image.screenshotDataUrl.startsWith('data:image/png;base64,') })); }
    catch(error) { console.log(JSON.stringify({ok: false, disconnected: error instanceof LivePreviewDisconnectedError, message: error.message })); }`;
  try {
    for (const mode of ["ok", "offline", "unauthorized", "missing", "invalid", "oversized"]) {
      const child = spawnSync(process.execPath, ["-e", script], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 5000,
        env: { ...process.env, ANDROID_HOME: f.directory, ANDROID_SDK_ROOT: f.directory, PREVIEW_CALLS: calls, PREVIEW_MODE: mode } });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.ok, mode === "ok");
      if (mode === "ok") { assert.equal(result.png, true); assert.deepEqual(result.size, { width: 1080, height: 2400 }); }
      else assert.equal(result.disconnected, ["offline", "unauthorized", "missing"].includes(mode));
    }
    assert.deepEqual(readFileSync(calls, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)),
      Array.from({ length: 6 }, () => ["-s", "device-a", "exec-out", "screencap", "-p"]));
  } finally { f.cleanup(); }
});

test("owned screenshot child is cancelled and joined before returning; no remote stop command", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = commandFixture("require('node:fs').writeFileSync(process.env.PREVIEW_PID_FILE, String(process.pid)); setInterval(() => {}, 50);");
  const pidFile = join(f.directory, "pid");
  const previous = process.env.PREVIEW_PID_FILE; process.env.PREVIEW_PID_FILE = pidFile;
  try {
    const controller = new AbortController();
    const capture = runPreviewScreenCommand(f.executable, "device-a", controller.signal, 2000);
    for (let count = 0; count < 100; count++) {
      try { readFileSync(pidFile, "utf8"); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const pid = Number(readFileSync(pidFile, "utf8")); controller.abort(Error("user close"));
    await assert.rejects(capture, /user close/);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    if (previous === undefined) delete process.env.PREVIEW_PID_FILE; else process.env.PREVIEW_PID_FILE = previous;
    f.cleanup();
  }
});

test("screenshot child output and deadline are bounded; aborted work never spawns", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  for (const [source, timeout, expected] of [
    ["process.stdout.write(Buffer.alloc(9 * 1024 * 1024));setInterval(()=>{},50)", 2000, /超过 8 MiB/],
    ["process.stderr.write('x'.repeat(5000));setInterval(()=>{},50)", 2000, /错误输出过长/],
    ["setInterval(()=>{},50)", 80, /超时/],
  ] as const) {
    const f = commandFixture(source);
    try { await assert.rejects(runPreviewScreenCommand(f.executable, "device-a", new AbortController().signal, timeout), expected); }
    finally { f.cleanup(); }
  }
  const controller = new AbortController(); controller.abort(Error("already closed"));
  assert.throws(() => runPreviewScreenCommand("unused", "device-a", controller.signal), /already closed/);
});
