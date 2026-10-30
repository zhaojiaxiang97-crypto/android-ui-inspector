import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugObserver } from "../electron/automation/device-actions";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { loadTestReport } from "../electron/desktop/test-report";
import { hasCompleteHelperObservationEvidence } from "../shared/helper-observation";
import { scrollUntilInput } from "../shared/debug-step-input";
import { debugPlanDefinition } from "../shared/debug-plan";
import { regressionPlanSchema } from "../scripts/automation-ui-regression";
import type { DebugScrollProgress } from "../shared/debug-scroll";
import type { DebugInputEvidence } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";
import { flattenNodes } from "../shared/tree-utils";

const packageName = "com.example.reveal", serial = "reveal-fixture", frame = { width: 200, height: 400, rotation: 0 as const };
const listId = packageName + ":id/list", markerId = packageName + ":id/end";
const condition = { selector: { resourceId: markerId, className: "Text" }, kind: "end_marker", reveal: "scroll" };
const image = sharp({ create: { ...frame, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);
const target = { packageName, activityName: ".Main", component: packageName + "/.Main", windowId: "adb-window", activityRecordId: "record" };
type Mode = "both" | "app" | "system" | "early" | "hidden" | "duplicate" | "loading" | "empty" | "loading-covered" | "empty-covered" | "unknown" | "unsafe-input"
  | "identity" | "static" | "one-frame" | "cancel" | "ancestor" | "ancestor-partial";
function harness(mode: Mode = "both") {
  const directory = mkdtempSync(join(tmpdir(), "helper-reveal-")), controller = new AbortController();
  let reads = 0, inputs = 0, resumeClear = false, session: DebugSession;
  const observe: DebugObserver = async () => {
    const snapshot = helperEvidenceSnapshot({ packageName, serial, startedAt: ++reads * 100, ...frame });
    const ready = resumeClear || inputs > 0 && !["static", "ancestor"].includes(mode) && (mode !== "one-frame" || reads === 2);
    const attrs = `package="${packageName}" window-id="7" enabled="true" clickable="false" focusable="false" focused="false" selected="false" content-desc=""`;
    const node = (index: number, cls: string, id: string, text: string, rect: string, children = "", extra = "", visible = true, original = rect) =>
      `<node index="${index}" class="${cls}" resource-id="${id}" text="${text}" ${attrs} bounds="${rect}" bounds-screen="${original}"
        visible-bounds="${rect}" visible-to-user="${visible}" scrollable="${cls === "List"}" ${extra}>${children}</node>`;
    const footer = mode === "early" ? "[20,320][180,350]" : "[20,355][180,380]";
    const rect = ready ? "[20,260][180,290]" : footer;
    const marker = node(1, "Text", markerId, mode === "identity" && inputs ? "CHANGED" : "END",
      mode === "hidden" ? "[0,0][0,0]" : rect, "", "", mode !== "hidden", mode === "hidden" ? footer : rect);
    const row = node(0, "Text", "", "row", "[20,90][180,130]");
    const extra = mode.startsWith("loading") || mode.startsWith("empty") ? node(2, "Text", "", mode.split("-")[0],
      mode.endsWith("covered") ? footer : "[20,150][180,180]") : "";
    const content = mode.startsWith("ancestor") ? node(1, "Group", "", "", `[0,40][200,${mode === "ancestor" ? 345 : 360}]`, marker, 'clip-children="true"') : marker;
    const tabs = mode === "system" ? "" : node(1, "Group", "", "", "[0,340][200,380]", [0, 1, 2].map(index => {
      const tab = node(index, "androidx.appcompat.app.ActionBar$Tab", "", "", `[${index * 66},340][${index === 2 ? 200 : (index + 1) * 66},380]`);
      return tab.replace('clickable="false"', 'clickable="true"').replace('selected="false"', `selected="${index === 0}"`);
    }).join(""));
    const xml = `<hierarchy rotation="0">${node(0, "Root", "", "", "[0,0][200,400]",
      node(0, "Group", "", "", "[0,0][200,380]", node(0, "List", listId, "", "[0,40][200,380]",
        row + content + (mode === "duplicate" ? marker.replace('index="1"', 'index="2"') : "") + extra,
        'scroll-forward-supported="true" scroll-backward-supported="true"') + tabs))}</hierarchy>`;
    const parsed = parseUiHierarchy(xml); Object.assign(snapshot, { root: parsed.root, rawXml: xml, xmlSize: Buffer.byteLength(xml), nodeCount: flattenNodes(parsed.root).size });
    if (!["app", "early", "ancestor"].includes(mode)) {
      snapshot.helperObservation!.windowsBefore.push({ id: "9", type: mode === "unknown" ? "unknown" : "system", layer: 2,
        active: false, focused: false, rootAvailable: true, packageName: "com.android.systemui", bounds: { x: 0, y: 375, width: 200, height: 25 } });
    }
    if (mode === "unsafe-input") snapshot.helperObservation!.windowsBefore.push({ id: "10", type: "system", layer: 3,
      active: false, focused: false, rootAvailable: true, packageName: "com.android.systemui", bounds: { x: 90, y: 170, width: 20, height: 20 } });
    snapshot.helperObservation!.windowsAfter = structuredClone(snapshot.helperObservation!.windowsBefore);
    assert.equal(hasCompleteHelperObservationEvidence(snapshot), true);
    snapshot.screenshotDataUrl = await image;
    return { snapshot, target };
  };
  observe.helperInput = async (_serial, _target, action, display, source, signal, onEvidence) => {
    signal.throwIfAborted(); assert.ok(source); assert.deepEqual(action, { kind: "scroll", direction: "down" }); inputs++;
    const requestId = randomUUID(), evidence: DebugInputEvidence = { transport: "accessibility-helper", classification: "accepted",
      spawned: false, closed: false, exitCode: null, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      helperInput: { dispatchState: "sent", requestId, receipt: { version: 1, sessionId: session.state.id, requestId, captureId: source.captureId,
        serviceInstanceId: source.serviceInstanceId, packageName, windowId: source.windowId, display, method: "accessibility-scroll",
        status: "completed", dispatchState: "sent", startedAtMs: source.timing.completedAtMs + 1, finishedAtMs: source.timing.completedAtMs + 2 } } };
    onEvidence(evidence); if (mode === "cancel") controller.abort();
  };
  session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent: () => {}, observe });
  const input = { sessionId: session.state.id, requestId: randomUUID(), backend: "accessibility-helper", inputMethod: "accessibility",
    target: { selector: { resourceId: listId, className: "List" } }, direction: "down", until: condition, maxScrolls: 3, timeoutMs: 3000 };
  return { input, session, counts: () => ({ reads, inputs }), clear: () => { resumeClear = true; },
    run: (request: Record<string, unknown> = input) => session.request({ name: "scroll_until", input: request }, controller.signal),
    resume: () => session.request({ name: "resume_ui_step", input: { sessionId: session.state.id, requestId: input.requestId, timeoutMs: 1000 } }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
const progress = (result: Record<string, unknown>) => result.scrollTask as DebugScrollProgress;

test("reveal is opt-in, down-only and requires exact Helper container and target identities at public and derived entries", () => {
  const h = { sessionId: randomUUID(), requestId: randomUUID(), backend: "accessibility-helper", target: { selector: { resourceId: listId, className: "List" } }, direction: "down", until: condition };
  assert.equal(scrollUntilInput.safeParse(h).success, true);
  const variants = [{ ...h, backend: "uiautomator" }, { ...h, direction: "up" }, { ...h, direction: "left" },
    { ...h, target: { selector: { resourceId: listId } } }, { ...h, target: { selector: { className: "List" } } },
    { ...h, until: { ...condition, selector: { resourceId: markerId } } }, { ...h, until: { ...condition, selector: { className: "Text" } } }];
  for (const input of [h, ...variants]) {
    const expected = input === h, { sessionId: _s, requestId: _r, backend, ...step } = input;
    assert.equal(scrollUntilInput.safeParse(input).success, expected);
    const common = { version: 1, backend, startConditions: [{ selector: { resourceId: listId } }], finalConditions: [{ selector: { resourceId: markerId } }],
      steps: [{ id: "end", kind: "scroll-until", input: step }] };
    assert.equal(debugPlanDefinition.safeParse({ ...common, title: "reveal" }).success, expected);
    const { finalConditions: _final, ...regression } = common;
    assert.equal(regressionPlanSchema.safeParse({ ...regression, id: "reveal", serial, packageName, rounds: 1, maxDurationMs: 30_000,
      returnConditions: common.finalConditions }).success, expected);
  }
});

test("known app/system bottom occlusion continues once and only complete fresh double frames confirm the end", async () => {
  for (const mode of ["both", "app", "system", "early"] as const) {
    const h = harness(mode);
    try {
      const result = await h.run(); assert.equal(result.verified, true, `${mode}: ${String(result.message)}`);
      assert.deepEqual(h.counts(), { reads: 3, inputs: 1 }); assert.equal(progress(result).stopReason, "end_reached");
      assert.notEqual(progress(result).confirmation!.firstSnapshotId, progress(result).confirmation!.secondSnapshotId);
      assert.equal((await loadTestReport(h.session.state.reportPath!)).debug!.steps[0].verified, true);
      const before = h.counts(); assert.equal((await h.run()).replayed, true); assert.deepEqual(h.counts(), before);
    } finally { await h.dispose(); }
  }
});

test("default strict end checks reject partial app/navigation exposure instead of claiming success", async () => {
  for (const mode of ["both", "app", "early"] as const) {
    const h = harness(mode);
    try {
      const { reveal: _, ...until } = h.input.until, result = await h.run({ ...h.input, until });
      assert.notEqual(result.verified, true); assert.equal(h.counts().inputs, 0); assert.equal(progress(result).confirmation, undefined);
    } finally { await h.dispose(); }
  }
});

test("hidden/duplicate/unknown/conflicting or unsafe input evidence never authorizes a reveal scroll", async () => {
  for (const mode of ["hidden", "duplicate", "unknown", "loading", "empty", "loading-covered", "empty-covered", "unsafe-input", "ancestor", "ancestor-partial"] as const) {
    const h = harness(mode);
    try {
      const result = await h.run({ ...h.input, ...(mode.startsWith("loading") ? { loading: { text: "loading" } }
        : mode.startsWith("empty") ? { empty: { text: "empty" } } : {}) });
      assert.notEqual(result.verified, true, mode); assert.equal(h.counts().inputs, 0, mode); assert.equal(progress(result).confirmation, undefined);
    } finally { await h.dispose(); }
  }
});

test("reveal retains max-scroll/no-progress/identity/cancel boundaries and never promotes a single clear frame", async () => {
  for (const mode of ["static", "identity", "cancel", "one-frame"] as const) {
    const h = harness(mode);
    try {
      const request = { ...h.input, maxScrolls: mode === "one-frame" ? 1 : 3 }, result = await h.run(request);
      assert.notEqual(result.verified, true, mode); assert.equal(progress(result).confirmation, undefined);
      assert.equal(h.counts().inputs, mode === "static" ? 2 : 1, mode);
      assert.ok(mode !== "static" || ["no_progress", "interrupted"].includes(progress(result).stopReason));
      const before = h.counts(); await h.run(request); assert.deepEqual(h.counts(), before);
    } finally { await h.dispose(); }
  }
});

test("read-only resume can confirm newly revealed frames but sends no further input while the marker remains covered", async () => {
  for (const clear of [false, true]) {
    const h = harness("static");
    try {
      await h.run(); const count = h.counts().inputs;
      if (clear) h.clear();
      const resumed = await h.resume(); assert.equal(resumed.verified, clear, String(resumed.message)); assert.equal(h.counts().inputs, count);
      if (clear) {
        assert.equal(progress(resumed).stopReason, "end_reached");
        assert.equal((await loadTestReport(h.session.state.reportPath!)).debug!.steps.at(-1)!.verified, true);
      }
    } finally { await h.dispose(); }
  }
});

test("single-window actionable reports still recheck strict footer containment in both confirmation trees", async () => {
  const h = harness("app");
  try {
    const result = await h.run(); assert.equal(result.verified, true);
    const path = h.session.state.reportPath!, report = JSON.parse(readFileSync(path, "utf8"));
    // Reuse the original, fully covered footer frame as one claimed confirmation without changing input history.
    const first = report.steps[0].step.scrollTask.confirmation.firstSnapshotId;
    const proof = report.snapshots.find((item: { snapshotId: string }) => item.snapshotId === first);
    const before = report.snapshots.find((item: { snapshotId: string }) => item.snapshotId === report.steps[0].step.scrollTask.iterations[0].beforeId);
    const document = JSON.parse(readFileSync(join(dirname(path), proof.tree.path), "utf8"));
    const original = JSON.parse(readFileSync(join(dirname(path), before.tree.path), "utf8"));
    const marker = [...flattenNodes(document.snapshot.root).values()].find(node => node.resourceId === markerId)!;
    const hidden = [...flattenNodes(original.snapshot.root).values()].find(node => node.resourceId === markerId)!;
    marker.bounds = hidden.bounds;
    for (const key of ["bounds", "bounds-screen", "visible-bounds"]) marker.attributes![key] = hidden.attributes![key];
    const bytes = Buffer.from(JSON.stringify(document)), sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactPath = `artifacts/${sha256}.json`;
    writeFileSync(join(dirname(path), artifactPath), bytes);
    proof.tree = { path: artifactPath, sha256, size: bytes.length };
    writeFileSync(path, JSON.stringify(report));
    const loaded = await loadTestReport(path); assert.equal(loaded.debug!.steps[0].verified, null);
    assert.equal(loaded.debug!.steps[0].step.dispatchState, "sent");
  } finally { await h.dispose(); }
});

test("reveal report imports also bind the earlier pending target rather than trusting only its final two frames", async () => {
  const h = harness("app");
  try {
    assert.equal((await h.run()).verified, true);
    const path = h.session.state.reportPath!, report = JSON.parse(readFileSync(path, "utf8"));
    const before = report.snapshots.find((item: { snapshotId: string }) => item.snapshotId === report.steps[0].step.scrollTask.iterations[0].beforeId);
    const document = JSON.parse(readFileSync(join(dirname(path), before.tree.path), "utf8"));
    const marker = [...flattenNodes(document.snapshot.root).values()].find(node => node.resourceId === markerId)!;
    marker.text = marker.attributes!.text = "OTHER";
    const bytes = Buffer.from(JSON.stringify(document)), sha256 = createHash("sha256").update(bytes).digest("hex"), artifactPath = `artifacts/${sha256}.json`;
    writeFileSync(join(dirname(path), artifactPath), bytes); before.tree = { path: artifactPath, sha256, size: bytes.length };
    writeFileSync(path, JSON.stringify(report));
    const loaded = await loadTestReport(path); assert.equal(loaded.debug!.steps[0].verified, null);
    assert.equal(loaded.debug!.steps[0].step.dispatchState, "sent");
  } finally { await h.dispose(); }
});
