import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { boundedDebugLogText, DebugStepLogCollector, parseAndroidLogLines, sanitizeDebugLogText } from "../electron/automation/debug-logs";
import { loadTestReport } from "../electron/desktop/test-report";
import { DEBUG_LOG_LIMITS, type DebugSessionReport } from "../shared/debug-report";
import type { DebugStep, UiSnapshot } from "../shared/types";

const packageName = "com.example.logs";
const step = (): DebugStep => ({ id: 1, time: new Date().toISOString(), action: "capture_ui", input: {}, status: "failed",
  message: "original error", error: { category: "capture", phase: "capture", code: "capture_failed", message: "original error token=private-value" } });
function fakeCommands(options: { restarted?: boolean; wrongPid?: boolean; clockOffset?: number; many?: boolean } = {}) {
  let identities = 0, timestamp = Date.now(), firstTimestamp = timestamp;
  const commands: string[][] = [];
  const execute = async (args: string[]) => {
    commands.push(args);
    if (args[1] === "pidof") { identities++; return Buffer.from("42\n"); }
    if (args[2]?.endsWith("/cmdline")) return Buffer.from(`${packageName}\0`);
    if (args[2]?.endsWith("/stat")) return Buffer.from(`42 (${packageName}) ${["S", ...Array(18).fill("0"), options.restarted && identities > 1 ? "999" : "100"].join(" ")}`);
    if (args[1] === "date") {
      timestamp = Date.now() + (options.clockOffset ?? 0);
      if (!commands.some(previous => previous[0] === "logcat") && identities === 1) firstTimestamp = timestamp;
      return Buffer.from((timestamp / 1000).toFixed(3));
    }
    if (args[0] === "logcat") {
      const row = `${(timestamp / 1000).toFixed(3)} ${options.wrongPid ? "43" : "42"} 42 E Fixture: api_key=hidden-me failure`;
      return Buffer.from(`--------- beginning of main\n${((firstTimestamp - 1000) / 1000).toFixed(3)} 42 42 E Fixture: previous-step\n${Array(options.many ? 402 : 1).fill(row).join("\n")}\n`);
    }
    throw new Error("unexpected command");
  };
  return { execute, commands };
}
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "fixture" };
function snapshot(): UiSnapshot {
  const root = makeNode("0"); root.package = packageName; root.text = "ready"; root.clickable = false;
  return { serial: "fixture-device", root, nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null,
    inspectionSource: "uiautomator", captureMode: "fast", captureGeometry: { hierarchyRotation: 0,
      beforeScreenshot: { width: 100, height: 200, rotation: 0 }, afterScreenshot: { width: 100, height: 200, rotation: 0 }, screenshotSize: { width: 100, height: 200 } } };
}

test("configuration secrets are removed before bounded UTF-8 log attachments are built", () => {
  const clean = sanitizeDebugLogText('token=private api-key: secret Authorization: Bearer ABC123 https://user:pass@host.invalid x="value"', ["value"]);
  for (const value of ["private", "secret", "ABC123", "user:pass", "value"]) assert.ok(!clean.includes(value));
  const content = boundedDebugLogText(Array.from({ length: 230 }, (_, index) => `row-${index} token=private`).join("\n"));
  assert.equal(content.lineCount, 200); assert.equal(content.truncated, true); assert.match(content.text!, /row-30/);
  assert.ok(!content.text!.includes("private"));
  const unicode = boundedDebugLogText(Array(200).fill("界".repeat(1000)).join("\n"));
  assert.ok(Buffer.byteLength(unicode.text!) <= DEBUG_LOG_LIMITS.maxBytes); assert.equal(unicode.truncated, true);
});

test("disabled Android logs perform no device IO and an empty local log remains explicit", async () => {
  let calls = 0;
  const collector = new DebugStepLogCollector({ serial: "fixture", packageName, sessionId: "session", execute: async () => { calls++; throw Error(); } });
  const current = step(); delete current.error; current.status = "done";
  const window = await collector.begin(current, new AbortController().signal);
  const result = await collector.finish(window, current, new Date().toISOString(), new AbortController().signal);
  assert.equal(calls, 0); assert.equal(result[0].evidence.status, "empty"); assert.equal(result[0].text, null);
  assert.equal(result[1].evidence.attribution, "missing"); assert.match(result[1].evidence.reason!, /未开启/); collector.stop();
});

test("Android log association checks main process identity and interval, filters old lines, and records truncation", async () => {
  const commands = fakeCommands({ many: true });
  const collector = new DebugStepLogCollector({ serial: "fixture", packageName, sessionId: "session", androidLogs: true, execute: commands.execute });
  const current = step(), signal = new AbortController().signal;
  const result = await collector.finish(await collector.begin(current, signal), current, new Date().toISOString(), signal);
  assert.equal(result[1].evidence.attribution, "confirmed"); assert.equal(result[1].evidence.status, "available");
  assert.equal(result[1].evidence.truncated, true); assert.equal(result[1].evidence.lineCount, 200);
  assert.ok(!result[1].text!.includes("previous-step")); assert.ok(!result[1].text!.includes("hidden-me"));
  assert.ok(commands.commands.some(args => args.includes("--pid=42")));
  assert.ok(!commands.commands.some(args => args.includes("-c") || args.includes("settings"))); collector.stop();
});

test("restarted processes, mismatched PIDs, unknown clock and malformed log timestamps are missing evidence", async () => {
  for (const options of [{ restarted: true }, { wrongPid: true }, { clockOffset: 60000 }]) {
    const commands = fakeCommands(options), collector = new DebugStepLogCollector({ serial: "fixture", packageName, sessionId: "session", androidLogs: true, execute: commands.execute });
    const current = step(), signal = new AbortController().signal;
    const logs = await collector.finish(await collector.begin(current, signal), current, new Date().toISOString(), signal);
    assert.equal(logs[1].evidence.attribution, "missing"); assert.equal(logs[1].evidence.status, "unavailable"); assert.equal(logs[1].text, null);
    assert.match(logs[1].evidence.reason!, /缺少|缺证据/); collector.stop();
  }
  assert.throws(() => parseAndroidLogLines("untimed app crash", { pid: 42, processStartTicks: "100", deviceStartedAt: 1, deviceFinishedAt: 2 }), /时间/);
});

test("failure logs save and reopen with the exact step while missing attachments leave the original outcome unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-logs-")), commands = fakeCommands();
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory, androidLogs: true,
    logExecute: commands.execute, onEvent: () => {}, observe: async () => { throw new Error("original failure token=private-value"); } });
  try {
    const outcome = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } }); session.stop("fixture done");
    assert.equal(outcome.isError, true); assert.equal(session.state.steps[0].error!.code, "capture_failed");
    const document = JSON.parse(readFileSync(session.state.reportPath!, "utf8")) as DebugSessionReport;
    assert.equal(document.steps[0].logs!.length, 2); assert.equal(document.steps[0].logs![1].attribution, "confirmed");
    const report = await loadTestReport(session.state.reportPath!);
    assert.match(report.debug!.steps[0].logs![0].text!, /original failure/); assert.ok(!report.debug!.steps[0].logs![0].text!.includes("private-value"));
    assert.equal(report.debug!.steps[0].logs![1].loadError, null);
    const files = new Map(document.steps.flatMap(entry => (entry.logs ?? []).flatMap(log => log.file ? [[log.file.path, log.file.size] as const] : [])));
    assert.equal(document.storage.bytes, statSync(session.state.reportPath!).size + [...files.values()].reduce((sum, size) => sum + size, 0));
    const log = document.steps[0].logs![1]; rmSync(join(directory, session.state.id, log.file!.path));
    const missing = await loadTestReport(session.state.reportPath!);
    assert.match(missing.debug!.steps[0].logs![1].loadError!, /缺失/); assert.equal(missing.debug!.steps[0].step.error!.code, "capture_failed");
    assert.equal(missing.index.cases[0].attempts[0].steps[0].status, "failed");
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("stopping while reading logs cancels the owned request and settled includes its release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-log-stop-")), commands = fakeCommands();
  let reading = false, cancelled = false;
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory, androidLogs: true,
    logExecute: (args, signal) => args[0] !== "logcat" ? commands.execute(args) : new Promise((_resolve, reject) => {
      reading = true; signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
    }), onEvent: () => {}, observe: async () => { throw new Error("original capture error"); } });
  try {
    const pending = session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    for (let i = 0; i < 100 && !reading; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(reading, true); assert.equal(session.hasPendingWork, true);
    session.stop("user stop"); assert.equal(session.state.busy, false); assert.equal(session.hasPendingWork, true);
    await pending; await session.settled(); assert.equal(session.hasPendingWork, false);
    assert.equal(cancelled, true); assert.equal(session.state.progress!.phase, "cancelled");
    const loaded = await loadTestReport(session.state.reportPath!);
    assert.equal(loaded.debug!.steps[0].logs![1].status, "cancelled"); assert.equal(loaded.debug!.steps[0].logs![1].file, null);
    assert.equal(loaded.debug!.steps[0].step.error!.code, "capture_failed");
    assert.ok(!readdirSync(join(directory, session.state.id)).some(name => name.endsWith(".tmp")));
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("stopping authorization keeps pending device work visible until settled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-pending-work-"));
  let release = () => {}, observing = false;
  const observation = new Promise<{ snapshot: UiSnapshot; target: typeof target }>(resolve => {
    release = () => resolve({ snapshot: snapshot(), target });
  });
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory,
    onEvent: () => {}, observe: async () => { observing = true; return observation; } });
  try {
    assert.equal(session.hasPendingWork, false);
    const pending = session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    assert.equal(observing, true); assert.equal(session.hasPendingWork, true);
    session.stop("user stop");
    assert.equal(session.state.active, false); assert.equal(session.state.busy, false); assert.equal(session.hasPendingWork, true);
    let settled = false;
    const draining = session.settled().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false); assert.equal(session.hasPendingWork, true);
    release(); assert.equal((await pending).isError, true); await draining;
    assert.equal(settled, true); assert.equal(session.hasPendingWork, false);
  } finally { session.stop(); release(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("operation timeouts save bounded failure logs without reporting a user cancellation", async () => {
  for (const options of [{ enabled: false, slowPreflight: false }, { enabled: true, slowPreflight: false }, { enabled: true, slowPreflight: true }]) {
    const directory = mkdtempSync(join(tmpdir(), "inspector-timeout-logs-")), commands = fakeCommands();
    const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory,
      androidLogs: options.enabled, logExecute: async (args) => {
        if (options.slowPreflight && args[1] === "pidof") await new Promise(resolve => setTimeout(resolve, 1100));
        return commands.execute(args);
      }, onEvent: () => {}, observe: async () => ({ snapshot: snapshot(), target }) });
    try {
      const outcome = await session.request({ name: "wait_for_ui", input: { sessionId: session.state.id, selector: { text: "missing" }, timeoutMs: 1000 } });
      assert.equal(outcome.isError, true); assert.equal(session.state.steps[0].error!.category, "timeout");
      assert.equal(session.state.progress!.phase, "failed"); assert.equal(session.state.active, true); assert.equal(session.hasPendingWork, false);
      const loaded = await loadTestReport(session.state.reportPath!);
      const logs = loaded.debug!.steps[0].logs!;
      assert.equal(logs[0].status, "available"); assert.match(logs[0].text!, /timeout/);
      assert.equal(logs[1].status, options.enabled && !options.slowPreflight ? "available" : "unavailable");
      assert.equal(logs[1].loadError ?? null, null);
      assert.equal(commands.commands.some(args => args[0] === "logcat"), options.enabled && !options.slowPreflight);
      if (!options.enabled) assert.equal(commands.commands.length, 0);
      if (options.slowPreflight) assert.match(logs[1].reason!, /到时限|范围检查未完成/);
      assert.equal(loaded.debug!.steps[0].step.error!.category, "timeout");
    } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("caller cancellation still interrupts optional Android logs and preserves the original failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-caller-log-stop-")), commands = fakeCommands(), caller = new AbortController();
  let reading = false, cancelled = false;
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory, androidLogs: true,
    logExecute: (args, signal) => args[0] !== "logcat" ? commands.execute(args) : new Promise((_resolve, reject) => {
      reading = true; signal.addEventListener("abort", () => { cancelled = true; reject(new Error("caller cancelled")); }, { once: true });
    }), onEvent: () => {}, observe: async () => { throw new Error("original capture error"); } });
  try {
    const pending = session.request({ name: "capture_ui", input: { sessionId: session.state.id } }, caller.signal);
    for (let i = 0; i < 100 && !reading; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(reading, true); caller.abort(new Error("caller cancelled"));
    const outcome = await pending; await session.settled();
    assert.equal(cancelled, true); assert.equal(session.hasPendingWork, false); assert.equal(session.state.active, true);
    assert.equal((outcome.error as { code: string }).code, "capture_failed");
    const loaded = await loadTestReport(session.state.reportPath!);
    assert.equal(loaded.debug!.steps[0].logs![1].status, "cancelled");
    assert.equal(loaded.debug!.steps[0].step.error!.code, "capture_failed");
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("a log command that ignores abort cannot delay stop or attach its late reply", async () => {
  const commands = fakeCommands();
  let release: ((value: Buffer) => void) | null = null;
  const collector = new DebugStepLogCollector({ serial: "fixture", packageName, sessionId: "session", androidLogs: true,
    execute: (args) => args[0] !== "logcat" ? commands.execute(args) : new Promise(resolve => { release = resolve; }) });
  const current = step(), signal = new AbortController().signal, window = await collector.begin(current, signal);
  const pending = collector.finish(window, current, new Date().toISOString(), signal);
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(release); collector.stop(); const result = await pending;
  assert.equal(result[1].evidence.status, "cancelled"); assert.equal(result[1].text, null);
  (release as (value: Buffer) => void)(Buffer.from(`${(Date.now() / 1000).toFixed(3)} 42 42 E Fixture: late`));
  await Promise.resolve(); assert.equal(result[1].text, null);
});

test("log authorization, step, App, timestamps, file sizes and imported content are checked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-log-import-")), commands = fakeCommands();
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory, androidLogs: true,
    logExecute: commands.execute, onEvent: () => {}, observe: async () => { throw new Error("original failure"); } });
  try {
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id } }); session.stop();
    const path = session.state.reportPath!, original = JSON.parse(readFileSync(path, "utf8")) as DebugSessionReport;
    for (const mutate of [(document: DebugSessionReport) => { document.session.androidLogsEnabled = false; },
      (document: DebugSessionReport) => { document.steps[0].logs![1].stepId = 2; },
      (document: DebugSessionReport) => { document.steps[0].logs![1].packageName = "other.app"; },
      (document: DebugSessionReport) => { document.steps[0].logs![1].finishedAt = "2099-01-01T00:00:00.000Z"; },
      (document: DebugSessionReport) => { document.steps[0].logs![1].file!.size = DEBUG_LOG_LIMITS.maxBytes + 1; }]) {
      const document = structuredClone(original); mutate(document); writeFileSync(path, JSON.stringify(document)); await assert.rejects(loadTestReport(path));
    }
    writeFileSync(path, JSON.stringify(original));
    const document = structuredClone(original); document.steps[0].logs![1].androidScope!.pid = 999;
    writeFileSync(path, JSON.stringify(document));
    const changed = await loadTestReport(path); assert.match(changed.debug!.steps[0].logs![1].loadError!, /其他进程/);
    delete document.steps[0].logs; delete document.session.progress; delete document.session.androidLogsEnabled;
    writeFileSync(path, JSON.stringify(document)); const legacy = await loadTestReport(path); assert.equal(legacy.debug!.steps[0].logs, undefined);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("Android log range failures leave Checker acceptance separate from grant and operation completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-log-checker-"));
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory, androidLogs: true,
    logExecute: async () => { throw new Error("Android logs unavailable token=private-value"); }, onEvent: () => {}, observe: async () => ({ snapshot: snapshot(), target }) });
  try {
    const defined = await session.request({ name: "define_debug_task", input: { sessionId: session.state.id,
      definition: { goal: "ready", checkpoints: [], finalConditions: [{ id: "ready", selector: { text: "ready" }, state: "visible" }] } } });
    const result = await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId: defined.taskId } });
    assert.equal(result.verified, true); assert.equal(session.state.task!.checks[0].status, "passed"); session.stop();
    const loaded = await loadTestReport(session.state.reportPath!); assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    assert.equal(loaded.debug!.steps[1].step.status, "done"); assert.equal(loaded.debug!.steps[1].step.recordingErrors, undefined);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("stopping during optional recording preserves an already completed Checker verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-checker-log-stop-"));
  const session = new DebugSession({ serial: "fixture-device", packageName, snapshotPath: join(directory, "current.json"), directory,
    onEvent: event => { if (event.state.progress?.phase === "recording" && event.state.progress.action === "check_debug_task") session.stop("stop during optional recording"); },
    observe: async () => ({ snapshot: snapshot(), target }) });
  try {
    const defined = await session.request({ name: "define_debug_task", input: { sessionId: session.state.id,
      definition: { goal: "ready", checkpoints: [], finalConditions: [{ id: "ready", selector: { text: "ready" }, state: "visible" }] } } });
    const result = await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId: defined.taskId } });
    assert.equal(result.verified, true); assert.equal(session.state.active, false); assert.equal(session.state.steps[1].status, "done");
    assert.equal(session.state.task!.checks[0].status, "passed");
    const loaded = await loadTestReport(session.state.reportPath!); assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});
