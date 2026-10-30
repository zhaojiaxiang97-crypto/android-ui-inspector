import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugObserver } from "../electron/automation/device-actions";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { loadTestReport } from "../electron/desktop/test-report";
import { hasCompleteHelperObservationEvidence } from "../shared/helper-observation";
import type { DebugScrollProgress } from "../shared/debug-scroll";
import type { DebugInputEvidence, UiSnapshot } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const packageName = "com.example.helper", serial = "helper-scroll-end";
const frame = { width: 200, height: 400, rotation: 0 as const };
const target = { packageName, activityName: ".Main", component: packageName + "/.Main", windowId: "adb-window", activityRecordId: "record" };
const image = sharp({ create: { ...frame, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);
const markerId = packageName + ":id/end", listId = packageName + ":id/list";

function page(read: number, markerVisible: boolean, changed: boolean): UiSnapshot {
  const snapshot = helperEvidenceSnapshot({ startedAt: read * 100, serial, packageName, ...frame });
  const node = (index: number, className: string, id: string, text: string, bounds: string, children = "", scrollable = false,
    visible = true, original = bounds) => `<node index="${index}" class="${className}" package="${packageName}"
      resource-id="${id}" text="${text}" content-desc="" bounds="${bounds}" bounds-screen="${original}" visible-bounds="${bounds}"
      window-id="7" visible-to-user="${visible}" enabled="true" clickable="false" focusable="false" focused="false"
      scrollable="${scrollable}" selected="false">${children}</node>`;
  const row = node(0, "android.widget.TextView", "", changed ? "第23项" : "第1项", "[20,80][180,140]");
  // The hidden marker remains in the full tree with a real, wholly offscreen original rectangle.
  const marker = node(1, "android.widget.TextView", markerId, "末项 · 第24项",
    markerVisible ? "[20,240][180,300]" : "[0,0][0,0]", "", false, markerVisible,
    markerVisible ? "[20,240][180,300]" : "[20,500][180,560]");
  const xml = `<hierarchy rotation="0">${node(0, "android.widget.FrameLayout", "", "", "[0,0][200,400]",
    node(0, "android.widget.ScrollView", listId, "", "[10,60][190,360]", row + marker, true))}</hierarchy>`;
  Object.assign(snapshot, { rawXml: xml, xmlSize: Buffer.byteLength(xml), root: parseUiHierarchy(xml).root, nodeCount: 4 });
  assert.equal(hasCompleteHelperObservationEvidence(snapshot), true, "each frame must satisfy the actual complete Helper contract");
  return snapshot;
}

function harness(mode: "ready" | "one-frame" | "unchanged") {
  const directory = mkdtempSync(join(tmpdir(), "helper-scroll-end-"));
  const pages: UiSnapshot[] = [], receipts: DebugInputEvidence[] = [];
  let reads = 0, inputs = 0, session: DebugSession;
  const observe: DebugObserver = async () => {
    const read = ++reads, visible = mode === "ready" ? inputs > 0 : mode === "one-frame" && read === 2;
    const snapshot = page(read, visible, mode !== "unchanged" && inputs > 0);
    snapshot.screenshotDataUrl = await image; pages.push(snapshot);
    return { snapshot, target };
  };
  observe.helperInput = async (actualSerial, actualTarget, action, display, source, signal, onEvidence, node) => {
    signal.throwIfAborted(); assert.equal(actualSerial, serial); assert.deepEqual(actualTarget, target);
    assert.equal(action.kind, "swipe"); assert.deepEqual(display, frame); assert.ok(source); assert.equal(node?.resourceId, listId);
    inputs++;
    const requestId = randomUUID();
    const receipt: DebugInputEvidence = { transport: "accessibility-helper", classification: "accepted", spawned: false,
      closed: false, exitCode: null, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      helperInput: { dispatchState: "sent", requestId, receipt: { version: 1, sessionId: session.state.id, requestId,
        captureId: source.captureId, serviceInstanceId: source.serviceInstanceId, packageName, windowId: source.windowId, display: frame,
        method: "gesture", status: "completed", dispatchState: "sent", startedAtMs: source.timing.completedAtMs + 1,
        finishedAtMs: source.timing.completedAtMs + 2 } } };
    receipts.push(receipt); onEvidence(receipt);
  };
  session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), observe, onEvent: () => {} });
  const input = { sessionId: session.state.id, requestId: randomUUID(), backend: "accessibility-helper",
    target: { selector: { resourceId: listId } }, direction: "down",
    until: { selector: { resourceId: markerId, text: "末项 · 第24项" }, kind: "end_marker" },
    maxScrolls: mode === "one-frame" ? 1 : 6, timeoutMs: 5000 };
  return { session, pages, receipts, counts: () => ({ reads, inputs }), run: () => session.request({ name: "scroll_until", input }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
const progress = (result: Record<string, unknown>) => result.scrollTask as DebugScrollProgress;

test("complete Helper offscreen end marker appears after one unique-container swipe and needs two new complete frames", async () => {
  const h = harness("ready");
  try {
    const result = await h.run(), trace = progress(result);
    assert.equal(result.isError, undefined, String(result.message)); assert.equal(result.verified, true);
    assert.equal(trace.stopReason, "end_reached"); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
    const hidden = h.pages[0].root!.children[0].children[1];
    assert.equal(hidden.visibleToUser, false); assert.equal(hidden.attributes!["bounds-screen"], "[20,500][180,560]");
    assert.deepEqual(trace.confirmation, { firstSnapshotId: trace.observationIds[1], secondSnapshotId: trace.observationIds[2], kind: "end_marker" });
    assert.notEqual(trace.confirmation!.firstSnapshotId, trace.confirmation!.secondSnapshotId);
    assert.equal(new Set(h.pages.map(snapshot => snapshot.helperObservation!.captureId)).size, 3);
    assert.ok(h.pages[1].helperObservation!.timing.startedAtMs > h.receipts[0].helperInput!.receipt!.finishedAtMs);
    assert.ok(h.pages[2].helperObservation!.timing.startedAtMs > h.pages[1].helperObservation!.timing.completedAtMs);
    assert.equal(trace.iterations[0].inputEvidence?.helperInput?.receipt?.method, "gesture");
    assert.equal((await loadTestReport(h.session.state.reportPath!)).debug!.steps[0].verified, true);
    assert.equal((await h.run()).replayed, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
  } finally { await h.dispose(); }
});

test("a one-frame visible Helper end marker cannot complete the bounded scroll", async () => {
  const h = harness("one-frame");
  try {
    const result = await h.run();
    assert.equal(result.verified, false); assert.equal(progress(result).stopReason, "scroll_limit");
    assert.equal(progress(result).confirmation, undefined); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
    assert.equal((await loadTestReport(h.session.state.reportPath!)).debug!.steps[0].verified, false);
    assert.equal((await h.run()).replayed, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
  } finally { await h.dispose(); }
});

test("two unchanged Helper swipes with the end marker still hidden stop without claiming the end", async () => {
  const h = harness("unchanged");
  try {
    const result = await h.run();
    assert.equal(result.verified, false); assert.equal(progress(result).stopReason, "no_progress");
    assert.equal(progress(result).confirmation, undefined); assert.deepEqual(h.counts(), { reads: 3, inputs: 2 });
    assert.deepEqual(progress(result).iterations.map(iteration => iteration.progress), ["unchanged", "unchanged"]);
    assert.equal(new Set(h.receipts.map(receipt => receipt.helperInput!.requestId)).size, 2);
    assert.equal((await loadTestReport(h.session.state.reportPath!)).debug!.steps[0].verified, false);
    assert.equal((await h.run()).replayed, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 2 });
  } finally { await h.dispose(); }
});
