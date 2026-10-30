import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugObservationError } from "../electron/automation/debug-observation-error";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { hasActionableHelperEvidence, type HelperWindowEvidence } from "../shared/helper-observation";
import type { DebugInputEvidence, FastCaptureBackend, UiSnapshot } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const packageName = "com.example.helper", serial = "helper-fixture", frame = { width: 400, height: 800, rotation: 0 as const };
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "adb-abcd", activityRecordId: "activity-1" };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0,
  signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
const screenshot = sharp({ create: { width: frame.width, height: frame.height, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);
const resource = `${packageName}:id/result`;
async function page(read: number, text = "END", list = false): Promise<UiSnapshot> {
  const snapshot = helperEvidenceSnapshot({ startedAt: read * 100, packageName, serial, text, ...frame });
  snapshot.screenshotDataUrl = await screenshot;
  if (list) {
    const xml = `<hierarchy rotation="0"><node index="0" class="android.widget.ScrollView" package="${packageName}" text=""
      resource-id="list" content-desc="" bounds="[0,0][400,800]" bounds-screen="[0,0][400,800]" visible-bounds="[0,0][400,800]"
      window-id="7" visible-to-user="true" enabled="true" clickable="false" focusable="true" focused="false" scrollable="true" selected="false">
      <node index="0" class="android.widget.TextView" package="${packageName}" text="${text}" resource-id="${resource}" content-desc=""
      bounds="[20,100][380,160]" bounds-screen="[20,100][380,160]" visible-bounds="[20,100][380,160]"
      window-id="7" visible-to-user="true" enabled="true" clickable="false" focusable="false" focused="false" scrollable="false" selected="false"/>
      </node></hierarchy>`;
    Object.assign(snapshot, { root: parseUiHierarchy(xml).root, nodeCount: 2, rawXml: xml, xmlSize: Buffer.byteLength(xml) });
  }
  assert.equal(hasActionableHelperEvidence(snapshot), true);
  return snapshot;
}
function changeWindow(snapshot: UiSnapshot, id = "8") {
  snapshot.helperObservation!.windowId = id;
  for (const windows of [snapshot.helperObservation!.windowsBefore, snapshot.helperObservation!.windowsAfter]) windows[0].id = id;
  const visit = (node: NonNullable<UiSnapshot["root"]>) => { node.attributes!["window-id"] = id; node.children.forEach(visit); };
  visit(snapshot.root!);
}
function harness(options: { list?: boolean; navigate?: boolean; mutate?: (snapshot: UiSnapshot, reads: number, inputs: number, backend: FastCaptureBackend) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "helper-actions-")), path = join(directory, "current.json");
  let reads = 0, inputs = 0;
  const backends: FastCaptureBackend[] = [];
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: path, onEvent: () => {},
    observe: async (_s, _p, _m, _signal, backend = "uiautomator") => {
      backends.push(backend);
      const snapshot = await page(++reads, inputs ? "END" : "START", options.list);
      if (backend === "uiautomator") { snapshot.inspectionSource = backend; delete snapshot.helperObservation; }
      if (options.navigate && inputs && backend === "accessibility-helper") changeWindow(snapshot);
      options.mutate?.(snapshot, reads, inputs, backend);
      return { snapshot, target: options.navigate && inputs ? { ...target, windowId: "adb-efgh", activityRecordId: "activity-2", component: `${packageName}/.Detail` } : target };
    }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  const base = () => ({ sessionId: session.state.id, requestId: randomUUID(), backend: "accessibility-helper" as const });
  return { session, directory, path, backends, base, counts: () => ({ reads, inputs }),
    capture: (backend: FastCaptureBackend = "accessibility-helper") => session.request({ name: "capture_ui", input: { sessionId: session.state.id, backend } }),
    step: (input: Record<string, unknown>) => session.request({ name: "perform_ui_step", input }),
    scroll: (input: Record<string, unknown>) => session.request({ name: "scroll_until", input }),
    resume: (requestId: unknown) => session.request({ name: "resume_ui_step", input: { sessionId: session.state.id, requestId, timeoutMs: 1000 } }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("validated Helper supports legacy tap, back and scroll while keeping ADB and Accessibility window IDs distinct", async () => {
  for (const name of ["tap_node", "press_back", "scroll_node"] as const) {
    const h = harness({ list: name === "scroll_node" });
    try {
      const captured = await h.capture(); assert.equal(captured.isError, undefined, String(captured.message));
      const current = JSON.parse(readFileSync(h.path, "utf8"));
      const result = await h.session.request({ name, input: { sessionId: h.session.state.id, snapshotId: captured.snapshotId,
        ...(name === "press_back" ? {} : { nodeId: current.snapshot.root.id }), ...(name === "scroll_node" ? { direction: "down" } : {}) } });
      assert.equal(result.isError, undefined, String(result.message)); assert.equal(result.dispatchState, "sent");
      assert.deepEqual(h.counts(), { reads: 3, inputs: 1 }); assert.ok(h.backends.every(source => source === "accessibility-helper"));
    } finally { await h.dispose(); }
  }
});

test("Helper composite actions preserve one input and two post-action confirmations across normal navigation", async () => {
  for (const kind of ["tap", "back", "scroll"] as const) {
    const h = harness({ list: kind === "scroll", navigate: kind !== "scroll" });
    try {
      const input = { ...h.base(), action: { kind, ...(kind === "scroll" ? { direction: "down" } : {}) },
        ...(kind === "back" ? {} : { target: { selector: { resourceId: kind === "scroll" ? "list" : resource } } }), expect: { selector: { text: "END" } } };
      const result = await h.step(input);
      assert.equal(result.isError, undefined, String(result.message)); assert.equal(result.verified, true);
      assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
      assert.ok(h.backends.every(source => source === "accessibility-helper"));
      const ledger = JSON.parse(readFileSync(join(h.directory, h.session.state.id, "requests.json"), "utf8"));
      assert.equal(ledger.records[0].observationSource.windowId, "7", "the initial service evidence is durable");
      assert.equal((await h.step(input)).replayed, true); assert.equal(h.counts().inputs, 1);
    } finally { await h.dispose(); }
  }
});

test("Helper wait and fixed task checks stay on the explicitly selected backend", async () => {
  for (const task of [false, true]) {
    const h = harness();
    try {
      const defined = task ? await h.session.request({ name: "define_debug_task", input: { sessionId: h.session.state.id,
        definition: { goal: "确认页面", checkpoints: [], finalConditions: [{ id: "final", selector: { text: "START" }, state: "visible" }] } } }) : null;
      await h.capture();
      const result = task ? await h.session.request({ name: "check_debug_task", input: { sessionId: h.session.state.id, taskId: defined!.taskId } })
        : await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id, selector: { text: "START" } } });
      assert.equal(result.isError, undefined, String(result.message));
      if (task) assert.equal((result.taskResult as { status: string }).status, "passed"); else assert.equal(result.verified, true);
      assert.deepEqual(h.counts(), { reads: 3, inputs: 0 }); assert.ok(h.backends.every(source => source === "accessibility-helper"));
    } finally { await h.dispose(); }
  }
});

test("legacy Helper remains read-only and unknown or injected sources cannot authorize actions", async () => {
  for (const name of ["tap_node", "press_back", "scroll_node", "wait_for_ui"] as const) {
    const h = harness({ mutate: snapshot => { delete snapshot.helperObservation; } });
    try {
      const captured = await h.capture(); assert.equal(captured.isError, undefined);
      const current = JSON.parse(readFileSync(h.path, "utf8"));
      const result = await h.session.request({ name, input: { sessionId: h.session.state.id,
        ...(name === "wait_for_ui" ? { selector: { text: "START" } } : { snapshotId: captured.snapshotId }),
        ...(["tap_node", "scroll_node"].includes(name) ? { nodeId: current.snapshot.root.id } : {}), ...(name === "scroll_node" ? { direction: "down" } : {}) } });
      assert.equal(result.isError, true); assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
    } finally { await h.dispose(); }
  }
  for (const backend of ["uiautomator", "accessibility-helper"] as const) {
    const h = harness({ mutate: snapshot => { snapshot.inspectionSource = backend === "uiautomator" ? "accessibility-helper" : "uiautomator"; } });
    try { const result = await h.step({ ...h.base(), backend, action: { kind: "back" } });
      assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(h.counts().inputs, 0); }
    finally { await h.dispose(); }
  }
});

test("Helper restart blocks old snapshot preflight and cannot satisfy post-action verification", async () => {
  for (const legacy of [false, true]) {
    const service = randomUUID();
    const h = harness({ mutate: (snapshot, reads) => { if (reads >= 2) snapshot.helperObservation!.serviceInstanceId = service; } });
    try {
      const result = legacy ? await h.session.request({ name: "press_back", input: { sessionId: h.session.state.id, snapshotId: (await h.capture()).snapshotId } })
        : await h.step({ ...h.base(), action: { kind: "back" }, expect: { selector: { text: "END" } } });
      assert.equal(result.isError, true); assert.notEqual(result.verified, true);
      assert.deepEqual(h.counts(), { reads: 2, inputs: legacy ? 0 : 1 });
    } finally { await h.dispose(); }
  }
});

test("new compound observations reject missing or non-fast sources and visual confirmation cannot cross backends", async () => {
  for (const source of [undefined, "debug-view"] as const) {
    const h = harness({ mutate: snapshot => { snapshot.inspectionSource = source; delete snapshot.helperObservation; } });
    try { const result = await h.step({ ...h.base(), backend: "uiautomator", action: { kind: "back" } });
      assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(h.counts().inputs, 0); }
    finally { await h.dispose(); }
  }
  for (const backend of ["uiautomator", "accessibility-helper"] as const) {
    const h = harness();
    try {
      const captured = await h.capture(backend === "uiautomator" ? "accessibility-helper" : "uiautomator");
      const result = await h.step({ ...h.base(), backend, action: { kind: "tap" }, target: { selector: { resourceId: resource } },
        visualConfirmation: { snapshotId: captured.snapshotId, description: "画面中的入口可见" } });
      assert.equal(result.isError, true); assert.match(String(result.message), /不能跨采集来源/);
      assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
    } finally { await h.dispose(); }
  }
});

test("Helper verification rejects a repeated capture and window changes between confirmation reads", async () => {
  for (const change of ["window", "capture"] as const) {
    let captureId: string | undefined;
    const h = harness({ mutate: (snapshot, reads) => {
      if (reads === 2) captureId = snapshot.helperObservation!.captureId;
      if (reads === 3) { if (change === "window") changeWindow(snapshot); else snapshot.helperObservation!.captureId = captureId!; }
    } });
    try { const result = await h.step({ ...h.base(), action: { kind: "back" }, expect: { selector: { text: "END" } } });
      assert.equal(result.isError, true); assert.notEqual(result.verified, true); assert.equal(h.counts().inputs, 1); }
    finally { await h.dispose(); }
  }
});

test("Helper transient post-input reads and resume keep the original backend and never replay input", async () => {
  for (const restarted of [false, true]) {
    let recovering = false;
    const replacement = randomUUID();
    const h = harness({ mutate: (snapshot, _reads, inputs, backend) => {
      if (inputs && backend === "accessibility-helper" && !recovering) throw new DebugObservationError("hierarchy_unavailable", "切页中");
      if (recovering && restarted && snapshot.helperObservation) snapshot.helperObservation.serviceInstanceId = replacement;
    } });
    try {
      const input = { ...h.base(), action: { kind: "back" }, expect: { selector: { text: "END" } } };
      const failed = await h.step(input); assert.equal(failed.dispatchState, "sent"); assert.equal(failed.isError, true);
      assert.deepEqual(h.backends, Array(4).fill("accessibility-helper"));
      recovering = true;
      await h.capture("uiautomator");
      const result = await h.resume(input.requestId);
      assert.equal(result.verified === true, !restarted); assert.equal(h.counts().inputs, 1);
      assert.equal(h.backends[4], "uiautomator"); assert.ok(h.backends.slice(5).every(source => source === "accessibility-helper"));
    } finally { await h.dispose(); }
  }
});

test("Helper scroll_until pins service and native window across all gestures and read-only resume", async () => {
  for (const changed of [false, true]) {
    const h = harness({ list: true, mutate: (snapshot, _reads, inputs) => { if (changed && inputs) changeWindow(snapshot); } });
    try {
      const input = { ...h.base(), target: { selector: { resourceId: "list" } }, direction: "down", until: { selector: { text: "END" } } };
      const result = await h.scroll(input);
      assert.equal(result.verified === true, !changed, String(result.message)); assert.equal(h.counts().inputs, 1);
      const resumed = await h.resume(input.requestId);
      assert.equal(resumed.verified === true, !changed); assert.equal(h.counts().inputs, 1);
      assert.ok(h.backends.every(source => source === "accessibility-helper"));
    } finally { await h.dispose(); }
  }
});

test("explicit fallback revokes Helper snapshot before a failed UIAutomator capture", async () => {
  const h = harness({ mutate: (_snapshot, _reads, _inputs, backend) => { if (backend === "uiautomator") throw new Error("采集失败"); } });
  try {
    const captured = await h.capture(); assert.ok(existsSync(h.path));
    assert.equal((await h.capture("uiautomator")).isError, true); assert.equal(existsSync(h.path), false);
    const result = await h.session.request({ name: "press_back", input: { sessionId: h.session.state.id, snapshotId: captured.snapshotId } });
    assert.equal(result.isError, true); assert.equal(h.counts().inputs, 0);
  } finally { await h.dispose(); }
});

function externalWindow(snapshot: UiSnapshot, bounds: HelperWindowEvidence["bounds"], flags: Partial<HelperWindowEvidence> = {}) {
  const window: HelperWindowEvidence = { id: "9", type: "system", layer: 2, active: false, focused: false,
    rootAvailable: true, packageName: "com.android.systemui", bounds, ...flags };
  snapshot.helperObservation!.windowsBefore.push(window);
  snapshot.helperObservation!.windowsAfter.push(structuredClone(window));
}

test("Helper taps and scrolls allow unrelated bars but reject the actual point margin and complete swipe corridor in either preflight frame", async () => {
  for (const action of ["tap_node", "scroll_node"] as const) {
    for (const coveredRead of [0, 1, 2]) {
      const h = harness({ list: action === "scroll_node", mutate: (snapshot, reads) => {
        externalWindow(snapshot, { x: 0, y: 0, width: 400, height: 40 });
        if (reads === coveredRead) externalWindow(snapshot, action === "tap_node"
          ? { x: 220, y: 400, width: 10, height: 10 } : { x: 220, y: 300, width: 10, height: 10 }, { id: "10" });
      } });
      try {
        const capture = await h.capture(); const current = JSON.parse(readFileSync(h.path, "utf8"));
        const result = await h.session.request({ name: action, input: { sessionId: h.session.state.id, snapshotId: capture.snapshotId,
          nodeId: current.snapshot.root.id, ...(action === "scroll_node" ? { direction: "down" } : {}) } });
        assert.equal(result.isError === true, coveredRead !== 0, String(result.message));
        assert.equal(h.counts().inputs, coveredRead === 0 ? 1 : 0);
      } finally { await h.dispose(); }
    }
  }
});

test("Helper Back allows passive system bars but checks IME and competing focus on both preflight reads", async () => {
  for (const blockedRead of [0, 1, 2]) {
    const h = harness({ mutate: (snapshot, reads) => externalWindow(snapshot, { x: 0, y: 0, width: 400, height: 40 },
      { type: reads === blockedRead ? "input_method" : "system" }) });
    try {
      const capture = await h.capture();
      const result = await h.session.request({ name: "press_back", input: { sessionId: h.session.state.id, snapshotId: capture.snapshotId } });
      assert.equal(result.isError === true, blockedRead !== 0, String(result.message));
      assert.equal(h.counts().inputs, blockedRead === 0 ? 1 : 0);
    } finally { await h.dispose(); }
  }
});

test("wait and compound verification never turn an occluded match into visible, enabled, disabled or absent", async () => {
  for (const state of ["visible", "enabled", "disabled", "absent"] as const) {
    const h = harness({ list: true, mutate: snapshot => externalWindow(snapshot, { x: 350, y: 100, width: 50, height: 30 }) });
    try {
      await h.capture();
      const result = await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
        selector: { text: "START" }, state, timeoutMs: 1000 } });
      assert.equal(result.isError, true); assert.notEqual(result.verified, true); assert.equal(h.counts().inputs, 0);
    } finally { await h.dispose(); }
  }
  const h = harness({ list: true, mutate: (snapshot, _reads, inputs) => {
    if (inputs) externalWindow(snapshot, { x: 350, y: 100, width: 50, height: 30 });
  } });
  try {
    const input = { ...h.base(), action: { kind: "back" }, expect: { selector: { text: "END" } } };
    const result = await h.step(input);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent"); assert.notEqual(result.verified, true);
    const resumed = await h.resume(input.requestId);
    assert.equal(resumed.isError, true); assert.notEqual(resumed.verified, true); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("scroll_until rechecks end, empty and loading marker regions in confirmation reads and read-only recovery", async () => {
  for (const marker of ["target", "end_marker", "empty", "loading"] as const) {
    const h = harness({ list: true, mutate: (snapshot, reads) => {
      if (reads >= 2) externalWindow(snapshot, { x: 350, y: 100, width: 50, height: 30 });
    } });
    try {
      const input = { ...h.base(), target: { selector: { resourceId: "list" } }, direction: "down",
        until: { kind: marker === "end_marker" ? "end_marker" : "target", selector: { text: ["empty", "loading"].includes(marker) ? "MISSING" : "START" } },
        ...(marker === "empty" ? { empty: { text: "START" } } : marker === "loading" ? { loading: { text: "START" } } : {}) };
      const result = await h.scroll(input);
      assert.equal(result.isError, true, String(result.message)); assert.notEqual(result.verified, true); assert.equal(h.counts().inputs, 0);
      const resumed = await h.resume(input.requestId);
      assert.notEqual(resumed.verified, true); assert.equal(h.counts().inputs, 0);
    } finally { await h.dispose(); }
  }
});

test("hidden-but-covered Helper nodes cannot satisfy absence or be ignored as a scroll loading marker", async () => {
  for (const scroll of [false, true]) {
    const h = harness({ list: true, mutate: snapshot => {
      const node = snapshot.root!.children[0];
      node.visibleToUser = false; node.visibilityEvidence = "hidden"; node.attributes!["visible-to-user"] = "false";
      node.bounds = { left: 0, top: 0, right: 0, bottom: 0, raw: "[0,0][0,0]" };
      node.attributes!.bounds = node.attributes!["visible-bounds"] = "[0,0][0,0]";
      externalWindow(snapshot, { x: 350, y: 100, width: 50, height: 30 });
    } });
    try {
      await h.capture();
      const result = scroll ? await h.scroll({ ...h.base(), target: { selector: { resourceId: "list" } }, direction: "down",
        until: { selector: { text: "END" } }, loading: { text: "START" } })
        : await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
          selector: { text: "START" }, state: "absent", timeoutMs: 1000 } });
      assert.equal(result.isError, true); assert.notEqual(result.verified, true); assert.equal(h.counts().inputs, 0);
    } finally { await h.dispose(); }
  }
});

test("unknown or extra active/focused Helper windows stop all compound entry points without dispatch", async () => {
  for (const flags of [{ type: "unknown" as const }, { active: true }, { focused: true }]) {
    for (const kind of ["tap", "scroll", "back"] as const) {
      const h = harness({ list: kind === "scroll", mutate: snapshot => externalWindow(snapshot,
        { x: 0, y: 0, width: 10, height: 10 }, flags) });
      try {
        const result = await h.step({ ...h.base(), action: { kind, ...(kind === "scroll" ? { direction: "down" } : {}) },
          ...(kind === "back" ? {} : { target: { selector: { resourceId: kind === "scroll" ? "list" : resource } } }) });
        assert.equal(result.isError, true); assert.equal(h.counts().inputs, 0);
      } finally { await h.dispose(); }
    }
  }
});
