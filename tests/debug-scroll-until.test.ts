import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugInputError } from "../electron/device/debug-input";
import { DebugObservationError } from "../electron/automation/debug-observation-error";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugInputEvidence, UiNode, UiSnapshot } from "../shared/types";
import type { DebugScrollProgress } from "../shared/debug-scroll";

const packageName = "com.example.scroll", serial = "offline-device";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window-1", activityRecordId: "activity-1" };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0,
  signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
function node(id: string, text: string | null = null, top = 300): UiNode {
  return { ...makeNode(id), package: packageName, resourceId: null, text, contentDesc: null,
    clickable: false, scrollable: false, enabled: true, visibleToUser: true,
    bounds: { left: 40, top, right: 1000, bottom: top + 100, raw: "" }, children: [] };
}
function snapshot(text = "item-a"): UiSnapshot {
  const root = node("0"), list = node("0/0");
  root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" };
  list.resourceId = "list"; list.scrollable = true; list.className = "androidx.recyclerview.widget.RecyclerView";
  list.bounds = { left: 20, top: 200, right: 1060, bottom: 1900, raw: "" };
  list.children = [node("0/0/0", text)]; root.children = [list];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial, root, nodeCount: 3, xmlSize: 0, rawXml: null, error: null, warning: null, screenshotDataUrl: null,
    captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
type Options = Partial<ConstructorParameters<typeof DebugSession>[0]>;
function harness(page: (inputs: number, reads: number) => UiSnapshot = inputs => snapshot(inputs >= 2 ? "END" : `item-${inputs}`), overrides: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-scroll-task-"));
  let reads = 0, inputs = 0;
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => ({ snapshot: page(inputs, ++reads), target }),
    input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); }, ...overrides });
  const makeInput = (extra: Record<string, unknown> = {}) => ({ sessionId: session.state.id, requestId: randomUUID(),
    target: { selector: { resourceId: "list" } }, direction: "down", until: { selector: { text: "END" }, kind: "end_marker" }, ...extra });
  return { session, directory, makeInput, counts: () => ({ reads, inputs }),
    run: (input: Record<string, unknown> = makeInput(), signal?: AbortSignal) => session.request({ name: "scroll_until", input }, signal),
    resume: (requestId: unknown, timeoutMs = 1000) => session.request({ name: "resume_ui_step", input: { sessionId: session.state.id, requestId, timeoutMs } }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
const progress = (result: Record<string, unknown>) => result.scrollTask as DebugScrollProgress;

test("scroll task reuses each post-input observation and records every gesture", async () => {
  const h = harness();
  try {
    const input = h.makeInput(), result = await h.run(input);
    assert.equal(result.isError, undefined); assert.equal(result.verified, true); assert.equal(result.dispatchState, "sent");
    assert.equal(progress(result).stopReason, "end_reached"); assert.deepEqual(h.counts(), { reads: 4, inputs: 2 });
    const trace = progress(result);
    assert.equal(trace.iterations.length, 2); assert.equal(trace.observationIds.length, 4);
    assert.equal(trace.iterations[0].afterId, trace.iterations[1].beforeId);
    assert.notEqual(trace.confirmation!.firstSnapshotId, trace.confirmation!.secondSnapshotId);
    for (const [index, item] of trace.iterations.entries()) {
      assert.equal(item.index, index + 1); assert.equal(item.dispatchState, "sent");
      assert.equal(item.resolvedInput?.action.kind, "swipe"); assert.equal(item.inputEvidence?.classification, "accepted");
      assert.ok(item.durationMs >= 0); assert.ok(trace.observationIds.includes(item.beforeId!)); assert.ok(trace.observationIds.includes(item.afterId!));
    }
    const duplicate = await h.run(input); assert.equal(duplicate.replayed, true); assert.deepEqual(h.counts(), { reads: 4, inputs: 2 });
    await assert.rejects(h.run({ ...input, maxScrolls: 2 }), /参数不同/);
    const ledger = JSON.parse(readFileSync(join(h.directory, h.session.state.id, "requests.json"), "utf8"));
    assert.deepEqual(ledger.records[0].progress, trace);
    const report = JSON.parse(readFileSync(h.session.state.reportPath!, "utf8"));
    const savedIds = new Set(report.snapshots.map((item: { snapshotId: string }) => item.snapshotId));
    assert.ok(trace.observationIds.every(id => savedIds.has(id)), "all gesture and confirmation observations are retained");
    const loaded = await loadTestReport(h.session.state.reportPath!);
    assert.equal(loaded.debug!.steps[0].verified, true);
    assert.deepEqual(loaded.debug!.steps[0].step.scrollTask, trace);
  } finally { await h.dispose(); }
});

test("an initially visible target or end marker needs two distinct observations and zero input", async () => {
  for (const kind of ["target", "end_marker"]) {
    const h = harness(() => snapshot("END"));
    try { const result = await h.run(h.makeInput({ until: { selector: { text: "END" }, kind } }));
      assert.equal(result.verified, true); assert.equal(result.dispatchState, "not_sent");
      assert.equal(progress(result).stopReason, kind === "target" ? "target_found" : "end_reached");
      assert.deepEqual(h.counts(), { reads: 2, inputs: 0 }); assert.deepEqual(progress(result).iterations, []);
    } finally { await h.dispose(); }
  }
});

test("target confirmation must be consecutive; one-frame marker never completes the task", async () => {
  const h = harness((_inputs, reads) => snapshot(reads === 1 ? "END" : "item-a"));
  try { const result = await h.run(h.makeInput({ maxScrolls: 1 }));
    assert.equal(result.verified, false); assert.equal(progress(result).stopReason, "scroll_limit");
    assert.equal(progress(result).confirmation, undefined); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
  } finally { await h.dispose(); }
});

test("two unchanged gestures stop as no_progress, never as end", async () => {
  const h = harness(() => snapshot());
  try { const result = await h.run(); assert.equal(result.verified, false); assert.equal(progress(result).stopReason, "no_progress");
    assert.deepEqual(h.counts(), { reads: 3, inputs: 2 });
    assert.deepEqual(progress(result).iterations.map(item => item.progress), ["unchanged", "unchanged"]);
  } finally { await h.dispose(); }
});

test("recycled node IDs with different content count as progress; duplicate or absent labels are unknown", async () => {
  for (const style of ["changing", "duplicate", "unlabelled"]) {
    const h = harness(inputs => {
      const page = snapshot(style === "changing" ? `row-${inputs}` : style === "duplicate" ? "same label" : "");
      if (style === "duplicate") page.root!.children[0].children.push(node("0/0/1", "same label", 600));
      return page;
    });
    try { const result = await h.run(h.makeInput({ maxScrolls: 3 }));
      assert.equal(progress(result).stopReason, "scroll_limit"); assert.equal(result.verified, false);
      assert.equal(h.counts().inputs, 3);
      assert.ok(progress(result).iterations.every(item => item.progress === (style === "changing" ? "changed" : "unknown")));
    } finally { await h.dispose(); }
  }
});

test("matching nodes outside the clipped container, in other windows, or below hidden parents are ignored", async () => {
  for (const location of ["outside", "offscreen", "other-window", "hidden-parent", "nested-clip"]) {
    const h = harness(() => {
      const page = snapshot(), end = node("0/0/1", "END", 600);
      if (location === "outside") { end.id = "0/1"; page.root!.children.push(end); }
      else if (location === "hidden-parent") {
        const parent = node("0/0/1"); parent.visibleToUser = false; end.id = "0/0/1/0"; parent.children = [end]; page.root!.children[0].children.push(parent);
      } else if (location === "nested-clip") {
        const parent = node("0/0/1", null, 1200); parent.attributes = { "clip-children": "true" };
        end.id = "0/0/1/0"; parent.children = [end]; page.root!.children[0].children.push(parent);
      } else { if (location === "offscreen") end.bounds = { left: 40, top: 2000, right: 1000, bottom: 2200, raw: "" };
        if (location === "other-window") end.attributes = { "window-id": "foreign" };
        page.root!.children[0].children.push(end); }
      return page;
    });
    try { const result = await h.run(h.makeInput({ maxScrolls: 1 }));
      assert.equal(result.verified, false); assert.equal(progress(result).confirmation, undefined);
      // A foreign overlapping window also correctly blocks the gesture itself.
      assert.notEqual(progress(result).stopReason, "end_reached");
      if (location !== "other-window") { assert.equal(progress(result).stopReason, "scroll_limit"); assert.equal(h.counts().inputs, 1); }
    } finally { await h.dispose(); }
  }
});

test("container selectors must be unique and enabled, and duplicate target labels are not guessed", async () => {
  for (const mode of ["duplicate-container", "disabled", "duplicate-condition"]) {
    const h = harness(() => {
      const page = snapshot(mode === "duplicate-condition" ? "END" : "item-a");
      if (mode === "duplicate-container") { const list = structuredClone(page.root!.children[0]); list.id = "0/1"; list.children = []; page.root!.children.push(list); }
      if (mode === "disabled") page.root!.children[0].enabled = false;
      if (mode === "duplicate-condition") page.root!.children[0].children.push(node("0/0/1", "END", 600));
      return page;
    });
    try { const result = await h.run(); assert.equal(result.isError, true); assert.equal(result.verified, false); assert.equal(h.counts().inputs, 0); }
    finally { await h.dispose(); }
  }
});

test("loading waits without gestures and empty needs two fresh reads without claiming target success", async () => {
  const h = harness((inputs, reads) => snapshot(reads <= 2 ? "Loading" : inputs ? "END" : "item-a"));
  try { const result = await h.run(h.makeInput({ loading: { text: "Loading" } }));
    assert.equal(result.verified, true); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 });
  } finally { await h.dispose(); }
  const empty = harness(() => snapshot("Empty"));
  try { const result = await empty.run(empty.makeInput({ empty: { text: "Empty" } }));
    assert.equal(result.verified, false); assert.equal(progress(result).stopReason, "empty");
    assert.equal(progress(result).confirmation?.kind, "empty"); assert.deepEqual(empty.counts(), { reads: 2, inputs: 0 });
  } finally { await empty.dispose(); }
});

test("a disappeared container retains the first sent gesture and its post-input observation", async () => {
  const h = harness(inputs => { const page = snapshot(); if (inputs) page.root!.children = []; return page; });
  try { const result = await h.run(); assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent");
    assert.equal(progress(result).stopReason, "container_missing"); assert.equal(progress(result).iterations.length, 1);
    assert.ok(progress(result).iterations[0].afterId); assert.ok(progress(result).iterations[0].error);
  } finally { await h.dispose(); }
});

test("window, Activity instance and screen rotation stay bound across the whole task", async () => {
  for (const mode of ["window", "activity", "rotation"]) {
    let reads = 0, inputs = 0;
    const h = harness(undefined, { observe: async () => {
      const page = snapshot(`row-${++reads}`), observedTarget = { ...target };
      if (reads > 1 && mode === "window") observedTarget.windowId = "window-2";
      if (reads > 1 && mode === "activity") observedTarget.activityRecordId = "activity-2";
      if (reads > 1 && mode === "rotation") page.captureGeometry!.beforeScreenshot = page.captureGeometry!.afterScreenshot = { width: 1080, height: 2400, rotation: 1 };
      return { snapshot: page, target: observedTarget };
    }, input: async () => { inputs++; } });
    try { const result = await h.run(); assert.equal(result.isError, true); assert.equal(result.verified, false); assert.equal(inputs, 1);
      assert.equal(result.dispatchState, "sent"); assert.match(String(result.message), /窗口|屏幕|几何/);
    } finally { await h.dispose(); }
  }
});

test("uncertain input is never replayed and resume only observes the original scoped condition", async () => {
  let inputs = 0, recovered = false;
  const h = harness(() => snapshot(recovered ? "END" : "item-a"), { input: async () => {
    inputs++; throw new DebugInputError({ ...receipt, classification: "timeout", exitCode: null });
  } });
  try { const input = h.makeInput(), failed = await h.run(input); assert.equal(failed.isError, true); assert.equal(failed.dispatchState, "unknown");
    assert.equal(progress(failed).iterations[0].dispatchState, "unknown"); assert.equal(progress(failed).iterations[0].inputEvidence?.classification, "timeout");
    assert.equal((await h.run(input)).replayed, true); assert.equal(inputs, 1);
    recovered = true; const result = await h.resume(input.requestId);
    assert.equal(result.verified, true); assert.equal(result.dispatchState, "unknown"); assert.equal(inputs, 1);
    assert.deepEqual(progress(result).iterations, progress(failed).iterations);
    assert.equal(h.session.state.steps.at(-1)!.resolvedInput, undefined); assert.equal(h.session.state.steps.at(-1)!.inputEvidence, undefined);
  } finally { await h.dispose(); }
});

test("resume of a zero-input loading timeout remains read-only", async () => {
  let recovered = false;
  const h = harness(() => snapshot(recovered ? "END" : "Loading"));
  try { const input = h.makeInput({ loading: { text: "Loading" }, timeoutMs: 1000 }), failed = await h.run(input);
    assert.equal(progress(failed).stopReason, "timeout"); assert.equal(failed.dispatchState, "not_sent");
    recovered = true; const result = await h.resume(input.requestId);
    assert.equal(result.verified, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(h.counts().inputs, 0);
  } finally { await h.dispose(); }
});

test("post-input observation failure and cancellation retain every already attempted gesture", async () => {
  for (const mode of ["observation", "cancel"]) {
    let inputs = 0; const controller = new AbortController();
    const h = harness(undefined, { observe: async (_s, _p, _m, signal) => {
      if (inputs) {
        if (mode === "cancel") { controller.abort(new Error("测试停止")); signal!.throwIfAborted(); }
        throw new DebugObservationError("hierarchy_unavailable", "暂不可读");
      }
      return { snapshot: snapshot(), target };
    }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
    try { const input = h.makeInput(), result = await h.run(input, controller.signal);
      assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent"); assert.equal(inputs, 1);
      assert.equal(progress(result).iterations.length, 1); assert.equal(progress(result).iterations[0].inputEvidence?.classification, "accepted");
      assert.ok(progress(result).iterations[0].error); assert.equal((await h.run(input)).replayed, true); assert.equal(inputs, 1);
      if (mode === "cancel") assert.equal(progress(result).stopReason, "cancelled");
    } finally { await h.dispose(); }
  }
});

test("losing the durable request journal before a subsequent gesture prevents that gesture", async () => {
  let inputs = 0;
  const h = harness(undefined, { observe: async () => {
    if (inputs === 1) unlinkSync(join(h.directory, h.session.state.id, "requests.json"));
    return { snapshot: snapshot(`row-${inputs}`), target };
  }, input: async () => { inputs++; } });
  try { const result = await h.run(); assert.equal(result.isError, true); assert.equal(inputs, 1);
    assert.equal(result.dispatchState, "sent"); assert.equal(h.session.state.steps.at(-1)!.scrollTask!.iterations.length, 1);
  } finally { await h.dispose(); }
});

test("desktop stop writes a readable uncertain iteration before the in-flight input settles", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(undefined, { input: async (_s, _t, _a, _f, signal) => { entered(); await gate; signal!.throwIfAborted(); } });
  const pending = h.run();
  try {
    await started; h.session.stop();
    const loaded = await loadTestReport(h.session.state.reportPath!);
    const saved = loaded.debug!.steps[0];
    assert.equal(saved.verified, false); assert.equal(saved.step.scrollTask!.stopReason, "cancelled");
    assert.equal(saved.step.scrollTask!.iterations[0].dispatchState, "unknown");
    assert.equal(saved.step.resolvedInput, undefined); assert.equal(saved.step.inputEvidence, undefined);
    release(); assert.equal((await pending).dispatchState, "unknown");
  } finally { release(); await pending; await h.dispose(); }
});

test("within scopes the exact container and condition even when another list has the same ID", async () => {
  const h = harness(() => {
    const page = snapshot("END"), scope = node("0/0"), list = page.root!.children[0];
    scope.resourceId = "scope"; scope.bounds = list.bounds; list.id = "0/0/0"; list.children[0].id = "0/0/0/0"; scope.children = [list];
    const other = node("0/1"); other.resourceId = "list"; other.scrollable = true; other.bounds = { left: 20, top: 2000, right: 1060, bottom: 2350, raw: "" };
    page.root!.children = [scope, other]; return page;
  });
  try { const result = await h.run(h.makeInput({ target: { selector: { resourceId: "list" }, within: { resourceId: "scope" } } }));
    assert.equal(result.verified, true); assert.deepEqual(h.counts(), { reads: 2, inputs: 0 });
  } finally { await h.dispose(); }
});

test("first-gesture visual confirmation cannot authorize a later overlap", async () => {
  const image = `data:image/png;base64,${(await sharp({ create: { width: 1080, height: 2400, channels: 4, background: "#303030" } }).png().toBuffer()).toString("base64")}`;
  const h = harness(inputs => {
    const page = snapshot(`row-${inputs}`), overlay = node("0/1", "overlap", 800);
    overlay.clickable = true; overlay.resourceId = "overlay"; page.root!.children.push(overlay); page.screenshotDataUrl = image;
    return page;
  });
  try { const captured = await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id } });
    const result = await h.run(h.makeInput({ visualConfirmation: { snapshotId: captured.snapshotId, description: "列表可见，浮层未遮挡实际内容" } }));
    assert.equal(result.isError, true); assert.equal(h.counts().inputs, 1); assert.equal(result.dispatchState, "sent");
    assert.equal(progress(result).iterations.length, 2);
    assert.ok(progress(result).iterations[0].resolvedInput?.visualConfirmation);
    assert.equal(progress(result).iterations[1].dispatchState, "not_sent");
    assert.equal(progress(result).iterations[1].resolvedInput, undefined);
    assert.equal(h.session.state.steps.at(-1)!.resolvedInput, undefined); assert.equal(h.session.state.steps.at(-1)!.inputEvidence, undefined);
    assert.equal((result.recovery as { kind: string }).kind, "visual_confirmation_required");
  } finally { await h.dispose(); }
});

test("resume cannot move to a new Activity and a new request is required for more scrolling", async () => {
  let inputs = 0, activity = "activity-1";
  const h = harness(undefined, { observe: async () => ({ snapshot: snapshot(`row-${inputs}`), target: { ...target, activityRecordId: activity } }), input: async () => { inputs++; } });
  try { const input = h.makeInput({ maxScrolls: 1 }), result = await h.run(input);
    assert.equal(progress(result).stopReason, "scroll_limit"); assert.equal(inputs, 1);
    const resumed = await h.resume(input.requestId);
    assert.equal(resumed.isError, true); assert.equal(progress(resumed).stopReason, "timeout"); assert.equal(inputs, 1);
    activity = "activity-2"; const moved = await h.resume(input.requestId);
    assert.equal(moved.isError, true); assert.match(String(moved.message), /Activity/); assert.equal(inputs, 1);
    const next = await h.run(h.makeInput({ maxScrolls: 1 }));
    assert.equal(progress(next).stopReason, "scroll_limit"); assert.equal(inputs, 2);
  } finally { await h.dispose(); }
});
