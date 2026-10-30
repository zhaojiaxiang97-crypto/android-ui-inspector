import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugObserver } from "../electron/automation/device-actions";
import { DebugInputError } from "../electron/device/debug-input";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugSessionReport } from "../shared/debug-report";
import { debugInputEvidenceSchema } from "../shared/debug-scroll-validation";
import { debugInputMayHaveDispatched } from "../shared/debug-input-state";
import { confirmedDebugInput } from "../src/features/reports/debug-report-view";
import type { DebugInputEvidence } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const packageName = "com.example.helper", serial = "helper-input-execution", frame = { width: 160, height: 320, rotation: 0 as const };
const target = { packageName, activityName: ".Main", component: packageName + "/.Main", windowId: "adb-window", activityRecordId: "record" };
const image = sharp({ create: { width: frame.width, height: frame.height, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);
function harness(mode: "completed" | "unknown" | "missing" = "completed", list = false, parent = false) {
  const directory = mkdtempSync(join(tmpdir(), "helper-input-execution-"));
  let inputs = 0, reads = 0;
  let actualTargetId: string | undefined;
  let session: DebugSession;
  const observe: DebugObserver = async () => {
    const snapshot = helperEvidenceSnapshot({ startedAt: ++reads * 100, serial, packageName, text: inputs && mode === "completed" ? "END" : "START", ...frame });
    if (list) {
      const properties = `package="${packageName}" window-id="7" visible-to-user="true" enabled="true" clickable="false" focusable="false" focused="false" selected="false" content-desc=""`;
      const xml = `<hierarchy rotation="0"><node index="0" class="android.widget.ScrollView" resource-id="${packageName}:id/list" text="" ${properties}
        bounds="[0,0][160,320]" bounds-screen="[0,0][160,320]" visible-bounds="[0,0][160,320]" scrollable="true">
        <node index="0" class="android.widget.TextView" resource-id="${packageName}:id/result" text="${inputs ? "END" : "START"}" ${properties}
        bounds="[10,10][150,100]" bounds-screen="[10,10][150,100]" visible-bounds="[10,10][150,100]" scrollable="false"/></node></hierarchy>`;
      snapshot.root = parseUiHierarchy(xml).root; snapshot.rawXml = xml; snapshot.xmlSize = Buffer.byteLength(xml); snapshot.nodeCount = 2;
    }
    if (parent) {
      const properties = `package="${packageName}" window-id="7" visible-to-user="true" enabled="true" focusable="false" focused="false" selected="false" content-desc="" scrollable="false"`;
      const xml = `<hierarchy rotation="0"><node index="0" class="android.widget.FrameLayout" resource-id="${packageName}:id/parent" text="" ${properties}
        bounds="[0,0][160,320]" bounds-screen="[0,0][160,320]" visible-bounds="[0,0][160,320]" clickable="true">
        <node index="0" class="android.widget.TextView" resource-id="${packageName}:id/result" text="${inputs ? "END" : "START"}" ${properties}
        bounds="[10,10][150,100]" bounds-screen="[10,10][150,100]" visible-bounds="[10,10][150,100]" clickable="false"/></node></hierarchy>`;
      snapshot.root = parseUiHierarchy(xml).root; snapshot.rawXml = xml; snapshot.xmlSize = Buffer.byteLength(xml); snapshot.nodeCount = 2;
    }
    snapshot.screenshotDataUrl = await image;
    return { snapshot, target };
  };
  if (mode !== "missing") observe.helperInput = async (_serial, _target, _action, actualFrame, source, _signal, onEvidence, targetNode) => {
    actualTargetId = targetNode?.resourceId ?? undefined;
    inputs++; assert.equal(_serial, serial); assert.deepEqual(actualFrame, frame); assert.ok(source);
    const requestId = randomUUID();
    const receipt: DebugInputEvidence = { transport: "accessibility-helper", classification: mode === "completed" ? "accepted" : "command-failed",
      spawned: false, closed: false, exitCode: null, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      helperInput: { dispatchState: mode === "completed" ? "sent" : "unknown", requestId,
        ...(mode === "completed" ? { receipt: { version: 1 as const, sessionId: session.state.id, requestId, packageName,
          captureId: source.captureId, serviceInstanceId: source.serviceInstanceId, windowId: source.windowId, display: frame,
          status: "completed" as const, dispatchState: "sent" as const, startedAtMs: source.timing.completedAtMs + 1, finishedAtMs: source.timing.completedAtMs + 2 } } : {}) } };
    onEvidence(receipt);
    if (mode === "unknown") throw new DebugInputError(receipt);
  };
  session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), observe, onEvent: () => {} });
  const request = { sessionId: session.state.id, requestId: randomUUID(), backend: "accessibility-helper", action: { kind: "tap" },
    target: { selector: { resourceId: packageName + ":id/result" } }, expect: { selector: { text: "END" }, state: "visible" }, timeoutMs: 1000 };
  return { session, request, counts: () => ({ reads, inputs }), actualTargetId: () => actualTargetId,
    run: () => session.request({ name: "perform_ui_step", input: request }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("explicit Helper steps use Helper dispatch and still verify two fresh observations and report evidence", async () => {
  const h = harness();
  try {
    const result = await h.run();
    assert.equal(result.isError, undefined, String(result.message)); assert.equal(result.verified, true); assert.equal(result.dispatchState, "sent");
    assert.equal(h.counts().inputs, 1); assert.ok(h.counts().reads >= 3);
    assert.ok(confirmedDebugInput(h.session.state.steps[0]));
    const loaded = await loadTestReport(h.session.state.reportPath!);
    assert.equal(loaded.debug!.steps[0].step.inputEvidence!.transport, "accessibility-helper");
    assert.equal((await h.run()).stepId, result.stepId); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("Helper unknown without a spawned process stays unknown and the same outer request never dispatches twice", async () => {
  const h = harness("unknown");
  try {
    const first = await h.run(); assert.equal(first.dispatchState, "unknown"); assert.equal(first.verified, false);
    const step = h.session.state.steps[0]; assert.equal(step.inputEvidence!.spawned, false); assert.ok(debugInputMayHaveDispatched(step.inputEvidence));
    assert.equal((await h.run()).dispatchState, "unknown"); assert.equal(h.counts().inputs, 1);
    await loadTestReport(h.session.state.reportPath!);
  } finally { await h.dispose(); }
});

test("clickable-parent passes the resolved parent to Helper rather than the text anchor", async () => {
  const h = harness("completed", false, true);
  try {
    const result = await h.session.request({ name: "perform_ui_step", input: { ...h.request,
      target: { selector: { resourceId: packageName + ":id/result" }, target: "clickable-parent" } } });
    assert.equal(result.isError, undefined, String(result.message)); assert.equal(result.verified, true);
    assert.equal(h.actualTargetId(), packageName + ":id/parent"); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("a Helper observer without the owned input transport refuses before any shell or Helper dispatch", async () => {
  const h = harness("missing");
  try { const result = await h.run(); assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(h.counts().inputs, 0); }
  finally { await h.dispose(); }
});

test("Helper evidence cannot forge a child process or accepted receipt and reports reject foreign or reused receipts", async () => {
  const h = harness();
  try {
    await h.run();
    const evidence = h.session.state.steps[0].inputEvidence!;
    for (const patch of [{ spawned: true }, { closed: true }, { exitCode: 0 }, { helperInput: undefined },
      { helperInput: { ...evidence.helperInput!, receipt: undefined } }, { transport: undefined }])
      assert.equal(debugInputEvidenceSchema.safeParse({ ...evidence, ...patch }).success, false);
    const file = h.session.state.reportPath!, original = readFileSync(file, "utf8");
    const save = (value: DebugSessionReport) => writeFileSync(file, JSON.stringify(value));
    const foreign: DebugSessionReport = JSON.parse(original);
    foreign.steps[0].step.inputEvidence!.helperInput!.receipt!.sessionId = randomUUID(); save(foreign);
    await assert.rejects(loadTestReport(file), /Helper/);
    const duplicate: DebugSessionReport = JSON.parse(original);
    const second = structuredClone(duplicate.steps[0]); second.step.id = 2; second.step.input.requestId = randomUUID();
    duplicate.steps.push(second); duplicate.session.totalSteps = 2; save(duplicate);
    await assert.rejects(loadTestReport(file), /重复/);
    save(JSON.parse(original));
  } finally { await h.dispose(); }
});

test("scroll-only Helper receipts cannot hide foreign identity or duplicate a physical input", async () => {
  const h = harness("completed", true);
  try {
    const result = await h.session.request({ name: "scroll_until", input: { sessionId: h.session.state.id, requestId: randomUUID(),
      backend: "accessibility-helper", target: { selector: { resourceId: packageName + ":id/list" } }, direction: "down",
      until: { selector: { text: "END" }, kind: "target" }, maxScrolls: 2, timeoutMs: 1000 } });
    assert.equal(result.isError, undefined, String(result.message)); assert.equal(h.counts().inputs, 1);
    const file = h.session.state.reportPath!, original = readFileSync(file, "utf8");
    await loadTestReport(file);
    for (const method of [undefined, "gesture", "accessibility-click", "global-back"] as const) {
      const document: DebugSessionReport = JSON.parse(original);
      document.steps[0].step.scrollTask!.iterations[0].inputEvidence!.helperInput!.receipt!.method = method;
      writeFileSync(file, JSON.stringify(document));
      if (method === undefined || method === "gesture") await loadTestReport(file);
      else await assert.rejects(loadTestReport(file), /执行方式与实际动作/);
    }
    const foreign: DebugSessionReport = JSON.parse(original);
    assert.equal(foreign.steps[0].step.inputEvidence, undefined);
    foreign.steps[0].step.scrollTask!.iterations[0].inputEvidence!.helperInput!.receipt!.sessionId = randomUUID();
    writeFileSync(file, JSON.stringify(foreign)); await assert.rejects(loadTestReport(file), /Helper/);
    const duplicate: DebugSessionReport = JSON.parse(original), task = duplicate.steps[0].step.scrollTask!;
    const second = structuredClone(task.iterations[0]); second.index = 2; task.iterations.push(second);
    writeFileSync(file, JSON.stringify(duplicate)); await assert.rejects(loadTestReport(file), /重复/);
    writeFileSync(file, original);
  } finally { await h.dispose(); }
});

test("Helper report methods agree with resolved tap and back actions while historical omissions remain valid", async () => {
  for (const kind of ["tap", "back"] as const) {
    const h = harness();
    try {
      const result = kind === "tap" ? await h.run() : await h.session.request({ name: "perform_ui_step", input: { ...h.request,
        action: { kind: "back" }, target: undefined } });
      assert.equal(result.isError, undefined, String(result.message));
      const file = h.session.state.reportPath!, original = readFileSync(file, "utf8");
      for (const method of [undefined, "gesture", "accessibility-click", "global-back"] as const) {
        const document: DebugSessionReport = JSON.parse(original);
        document.steps[0].step.inputEvidence!.helperInput!.receipt!.method = method;
        writeFileSync(file, JSON.stringify(document));
        const allowed = method === undefined || (kind === "back" ? method === "global-back" : method !== "global-back");
        if (allowed) await loadTestReport(file);
        else await assert.rejects(loadTestReport(file), /执行方式与实际动作/);
      }
    } finally { await h.dispose(); }
  }
});
