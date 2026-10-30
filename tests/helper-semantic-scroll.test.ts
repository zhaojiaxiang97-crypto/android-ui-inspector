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
import { hasCompleteHelperObservationEvidence } from "../shared/helper-observation";
import type { DebugScrollProgress } from "../shared/debug-scroll";
import type { DebugInputAction, DebugInputEvidence } from "../shared/types";
import type { DebugSessionReport } from "../shared/debug-report";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const packageName = "com.example.helper", serial = "helper-semantic-scroll", frame = { width: 200, height: 400, rotation: 0 as const };
const listId = packageName + ":id/list", markerId = packageName + ":id/end";
const target = { packageName, activityName: ".Main", component: packageName + "/.Main", windowId: "adb-window", activityRecordId: "record" };
const image = sharp({ create: { ...frame, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);

function harness(options: { unsupported?: boolean; loseSupport?: boolean; unknownProgress?: boolean; partialProgress?: boolean; replacementProgress?: boolean; blocked?: boolean; fail?: boolean; lostReply?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "helper-semantic-scroll-"));
  let reads = 0, session: DebugSession;
  const actions: DebugInputAction[] = [];
  const observe: DebugObserver = async () => {
    const snapshot = helperEvidenceSnapshot({ startedAt: ++reads * 100, packageName, serial, ...frame });
    const supported = !(options.unsupported || options.loseSupport && actions.length > 0);
    const partial = options.partialProgress || options.replacementProgress;
    const anchorY = options.replacementProgress ? 210 : 210 - actions.length * 20;
    const markerVisible = actions.length >= (partial ? 3 : 1) && !options.loseSupport && !options.unknownProgress;
    const attrs = `package="${packageName}" window-id="7" enabled="true" clickable="false" focusable="false" focused="false" selected="false" content-desc=""`;
    const rect = "[0,0][200,400]", list = "[10,60][190,360]", row = "[20,80][180,140]";
    const marker = markerVisible ? "[20,240][180,300]" : "[0,0][0,0]";
    const xml = `<hierarchy rotation="0"><node index="0" class="Root" resource-id="" text="" ${attrs}
      bounds="${rect}" bounds-screen="${rect}" visible-bounds="${rect}" visible-to-user="true" scrollable="false">
      <node index="0" class="android.widget.ScrollView" resource-id="${listId}" text="" ${attrs}
        bounds="${list}" bounds-screen="${list}" visible-bounds="${list}" visible-to-user="true" scrollable="true"
        scroll-forward-supported="${supported}" scroll-backward-supported="${supported}">
        <node index="0" class="Text" resource-id="" text="${options.unknownProgress || partial ? "固定项" : "第" + (actions.length + 1) + "项"}" ${attrs}
          bounds="${row}" bounds-screen="${row}" visible-bounds="${row}" visible-to-user="true" scrollable="false"/>
        ${partial ? `<node index="1" class="Text" resource-id="" text="${options.replacementProgress ? "page-" + actions.length : "clear-anchor"}" ${attrs}
          bounds="[20,${anchorY}][180,${anchorY + 30}]" bounds-screen="[20,${anchorY}][180,${anchorY + 30}]"
          visible-bounds="[20,${anchorY}][180,${anchorY + 30}]" visible-to-user="true" scrollable="false"/>` : ""}
        <node index="${partial ? 2 : 1}" class="Text" resource-id="${markerId}" text="END" ${attrs} bounds="${marker}"
          bounds-screen="${markerVisible ? marker : "[20,500][180,560]"}" visible-bounds="${marker}"
          visible-to-user="${markerVisible}" scrollable="false"/>
      </node></node></hierarchy>`;
    Object.assign(snapshot, { root: parseUiHierarchy(xml).root, rawXml: xml, xmlSize: Buffer.byteLength(xml), nodeCount: partial ? 5 : 4 });
    if (options.unknownProgress || partial || options.blocked) {
      const e = snapshot.helperObservation!;
      e.windowsBefore.push({ id: "8", type: "system", layer: 2, active: false, focused: false, rootAvailable: true,
        packageName: "com.android.systemui", bounds: options.blocked ? { x: 90, y: 180, width: 30, height: 30 }
          : { x: 170, y: 80, width: 30, height: 60 } });
      e.windowsAfter = structuredClone(e.windowsBefore);
    }
    assert.equal(hasCompleteHelperObservationEvidence(snapshot), true);
    snapshot.screenshotDataUrl = await image;
    return { snapshot, target };
  };
  observe.helperInput = async (_serial, _target, action, display, source, signal, onEvidence, node) => {
    signal.throwIfAborted(); assert.ok(source); assert.deepEqual(display, frame); assert.equal(node?.resourceId, listId);
    actions.push(action);
    const requestId = randomUUID();
    const evidence: DebugInputEvidence = { transport: "accessibility-helper", classification: options.fail ? "command-failed" : "accepted",
      spawned: false, closed: false, exitCode: null, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      helperInput: { dispatchState: options.fail ? "unknown" : "sent", requestId, receipt: {
        version: 1, sessionId: session.state.id, requestId, captureId: source.captureId, serviceInstanceId: source.serviceInstanceId,
        packageName, windowId: source.windowId, display: frame, method: action.kind === "scroll" ? "accessibility-scroll" : "gesture",
        status: options.fail ? "cancelled" : "completed", dispatchState: options.fail ? "unknown" : "sent",
        ...(options.fail ? { errorCode: "dispatch_error" as const } : {}),
        startedAtMs: source.timing.completedAtMs + 1, finishedAtMs: source.timing.completedAtMs + 2 } } };
    if (options.lostReply) delete evidence.helperInput!.receipt;
    onEvidence(evidence); if (options.fail) throw new DebugInputError(evidence);
  };
  session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), observe, onEvent: () => {} });
  const input = { sessionId: session.state.id, requestId: randomUUID(), backend: "accessibility-helper", inputMethod: "accessibility",
    target: { selector: { resourceId: listId, className: "android.widget.ScrollView" } }, direction: "down",
    until: { selector: { resourceId: markerId, text: "END" }, kind: "end_marker" }, maxScrolls: 6, timeoutMs: 5000 };
  return { session, input, actions, counts: () => ({ reads, inputs: actions.length }),
    run: (request: Record<string, unknown> = input) => session.request({ name: "scroll_until", input: request }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
const progress = (result: Record<string, unknown>) => result.scrollTask as DebugScrollProgress;

test("explicit semantic scroll sends the selected vertical action once and verifies two new complete Helper frames", async () => {
  for (const direction of ["up", "down"] as const) {
    const h = harness();
    try {
      const request = { ...h.input, direction }, result = await h.run(request);
      assert.equal(result.verified, true, String(result.message)); assert.deepEqual(h.actions, [{ kind: "scroll", direction }]);
      assert.deepEqual(h.counts(), { reads: 3, inputs: 1 }); assert.equal(progress(result).stopReason, "end_reached");
      const iteration = progress(result).iterations[0];
      assert.deepEqual(iteration.resolvedInput?.action, { kind: "scroll", direction });
      assert.ok(iteration.resolvedInput?.scrollRegion); assert.equal(iteration.inputEvidence?.helperInput?.receipt?.method, "accessibility-scroll");
      const file = h.session.state.reportPath!, original = readFileSync(file, "utf8");
      assert.equal((await loadTestReport(file)).debug!.steps[0].verified, true);
      for (const change of ["method", "direction", "request"] as const) {
        const report: DebugSessionReport = JSON.parse(original), step = report.steps[0].step;
        if (change === "method") step.scrollTask!.iterations[0].inputEvidence!.helperInput!.receipt!.method = "gesture";
        else if (change === "direction") step.scrollTask!.iterations[0].resolvedInput!.action = { kind: "scroll", direction: direction === "up" ? "down" : "up" };
        else step.input.inputMethod = "gesture";
        writeFileSync(file, JSON.stringify(report)); await assert.rejects(loadTestReport(file), /滚动|回执|执行方式/);
      }
      writeFileSync(file, original);
      assert.equal((await h.run(request)).replayed, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
    } finally { await h.dispose(); }
  }
});

test("unsupported or changed semantic scroll support stops before another action without gesture fallback", async () => {
  for (const loseSupport of [false, true]) {
    const h = harness(loseSupport ? { loseSupport: true } : { unsupported: true });
    try {
      const result = await h.run(); assert.equal(result.isError, true); assert.equal(result.verified, false);
      assert.equal(h.actions.length, loseSupport ? 1 : 0); assert.ok(h.actions.every(action => action.kind === "scroll"));
      const before = h.counts(); assert.equal((await h.run()).replayed, true); assert.deepEqual(h.counts(), before);
      await loadTestReport(h.session.state.reportPath!);
    } finally { await h.dispose(); }
  }
});

test("unknown semantic input never retries or falls back, while omitted inputMethod remains a gesture", async () => {
  for (const lostReply of [false, true]) {
  const h = harness({ fail: true, lostReply });
  try {
    const result = await h.run(); assert.equal(result.dispatchState, "unknown"); assert.equal(result.verified, false);
    assert.deepEqual(h.actions, [{ kind: "scroll", direction: "down" }]);
    assert.equal((await h.run()).replayed, true); assert.deepEqual(h.counts(), { reads: 1, inputs: 1 });
    await loadTestReport(h.session.state.reportPath!);
  } finally { await h.dispose(); }
  }
  const legacy = harness();
  try {
    const { inputMethod: _, ...request } = legacy.input, result = await legacy.run(request);
    assert.equal(result.verified, true); assert.equal(legacy.actions[0].kind, "swipe");
  } finally { await legacy.dispose(); }
});

test("two sent Helper inputs with unprovable progress stop interrupted without declaring no-progress or the end", async () => {
  for (const inputMethod of ["gesture", "accessibility"] as const) {
    const h = harness({ unknownProgress: true });
    try {
      const request = { ...h.input, inputMethod }, result = await h.run(request);
      assert.equal(result.verified, false); assert.equal(progress(result).stopReason, "interrupted");
      assert.match(String(result.message), /进展证据/); assert.deepEqual(h.counts(), { reads: 3, inputs: 2 });
      assert.deepEqual(progress(result).iterations.map(iteration => iteration.progress), ["unknown", "unknown"]);
      assert.equal(progress(result).confirmation, undefined);
      await loadTestReport(h.session.state.reportPath!);
      assert.equal((await h.run(request)).replayed, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 2 });
    } finally { await h.dispose(); }
  }
});

test("partial clear directional change permits further semantic scrolling but only two end frames verify completion", async () => {
  for (const replacementProgress of [false, true]) {
  const h = harness(replacementProgress ? { replacementProgress: true } : { partialProgress: true });
  try {
    const result = await h.run(); assert.equal(result.verified, true, String(result.message));
    assert.deepEqual(h.counts(), { reads: 5, inputs: 3 });
    assert.deepEqual(progress(result).iterations.map(iteration => iteration.progress), ["changed", "changed", "changed"]);
    assert.ok(progress(result).confirmation); await loadTestReport(h.session.state.reportPath!);
  } finally { await h.dispose(); }
  }
});

test("semantic scroll retains the existing corridor occlusion rejection before any input", async () => {
  const h = harness({ blocked: true });
  try {
    const result = await h.run(); assert.equal(result.isError, true); assert.equal(result.verified, false);
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 }); await loadTestReport(h.session.state.reportPath!);
  } finally { await h.dispose(); }
});
