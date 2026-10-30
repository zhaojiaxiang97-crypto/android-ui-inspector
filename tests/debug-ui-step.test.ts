import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugObservationError } from "../electron/automation/debug-observation-error";
import { FocusUnavailableError } from "../electron/device/target";
import { DebugInputError } from "../electron/device/debug-input";
import { isDebugTimings } from "../shared/debug-timing";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugInputEvidence, UiSnapshot } from "../shared/types";

const packageName = "com.example.step", serial = "offline-device";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window-1", activityRecordId: "activity-1" };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0,
  signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
function snapshot(text = "播放"): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0");
  root.package = button.package = packageName;
  root.clickable = root.scrollable = false; root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" };
  button.resourceId = `${packageName}:id/play`; button.text = text;
  button.clickable = button.enabled = button.visibleToUser = true;
  button.scrollable = false; button.children = [];
  button.bounds = { left: 20, top: 100, right: 180, bottom: 160, raw: "" };
  root.children = [button];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial, root, nodeCount: 2, xmlSize: 0, rawXml: null, error: null, warning: null, screenshotDataUrl: null,
    captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
function harness(overrides: Partial<ConstructorParameters<typeof DebugSession>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-ui-step-"));
  let reads = 0, inputs = 0;
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => { reads++; return { snapshot: snapshot(inputs ? "暂停" : "播放"), target }; },
    input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); }, ...overrides });
  const makeInput = () => ({ sessionId: session.state.id, requestId: randomUUID(), action: { kind: "tap" },
    target: { selector: { resourceId: `${packageName}:id/play` } } });
  return { session, directory, makeInput, counts: () => ({ reads, inputs }),
    perform: (input: Record<string, unknown> = makeInput()) => session.request({ name: "perform_ui_step", input }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("composite action uses one preflight and reuses post-input observation as first of two confirmations", async () => {
  const h = harness();
  try {
    const input = { ...h.makeInput(), requestId: randomUUID().toUpperCase(), expect: { selector: { text: "暂停" } } };
    const result = await h.perform(input);
    assert.equal(result.isError, undefined); assert.equal(result.verified, true); assert.equal(result.dispatchState, "sent");
    assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
    assert.equal(isDebugTimings(result.timings), true);
    const phases = h.session.state.steps.at(-1)!.timings!.spans.map(span => span.phase);
    for (const phase of ["relocation", "validation", "input", "verification", "save", "attachments", "serialization"] as const)
      assert.ok(phases.includes(phase), `missing actual step timing: ${phase}`);
    const duplicate = await h.perform({ ...input, requestId: input.requestId.toLowerCase() });
    assert.equal(duplicate.replayed, true); assert.equal(duplicate.verified, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
    const report = JSON.parse(readFileSync(h.session.state.reportPath!, "utf8"));
    assert.equal(isDebugTimings(report.steps.at(-1).step.timings), true);
    assert.equal(report.steps.at(-1).step.verified, true);
    const reloaded = await loadTestReport(h.session.state.reportPath!);
    assert.equal(reloaded.debug!.steps.at(-1)!.verified, true);
  } finally { await h.dispose(); }
});

test("without an expectation input is sent and observed, never labelled verified", async () => {
  const h = harness();
  try { const result = await h.perform(); assert.equal(result.verified, false); assert.equal(result.dispatchState, "sent");
    assert.deepEqual(h.counts(), { reads: 2, inputs: 1 }); }
  finally { await h.dispose(); }
});

test("same request while running and after completion never repeats input; changed parameters are rejected", async () => {
  let release!: () => void, inputs = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ observe: async () => { await gate; return { snapshot: snapshot(), target }; }, input: async () => { inputs++; } });
  try {
    const input = h.makeInput(), pending = h.perform(input);
    const duplicate = await h.perform(input);
    assert.equal(duplicate.requestState, "running"); assert.equal(duplicate.replayed, true); assert.equal(inputs, 0);
    await assert.rejects(h.perform({ ...input, target: { selector: { resourceId: "different" } } }), /参数不同/);
    await assert.rejects(h.perform(), /另一个调试操作/);
    release(); const first = await pending;
    assert.equal(first.dispatchState, "sent"); assert.equal(inputs, 1);
    assert.equal((await h.perform(input)).replayed, true); assert.equal(inputs, 1);
    h.session.stop();
    const query = await h.session.request({ name: "get_ui_step", input: { sessionId: h.session.state.id, requestId: input.requestId } });
    assert.equal(query.dispatchState, "sent");
    await assert.rejects(h.perform(input), /会话已结束/);
    await assert.rejects(h.session.request({ name: "get_ui_step", input: { sessionId: randomUUID(), requestId: input.requestId } }), /不属于/);
  } finally { release(); await h.dispose(); }
});

test("missing and ambiguous selectors do not dispatch; within scopes a unique target", async () => {
  for (const scoped of [false, true]) {
    let inputs = 0;
    const h = harness({ observe: async () => {
      const page = snapshot(), scope = makeNode("0/1"), second = makeNode("0/1/0");
      Object.assign(scope, { package: packageName, resourceId: "scope", clickable: false, scrollable: false, visibleToUser: true,
        bounds: { left: 0, top: 300, right: 1080, bottom: 700, raw: "" } });
      Object.assign(second, page.root!.children[0], { id: "0/1/0", bounds: { left: 20, top: 400, right: 180, bottom: 460, raw: "" } });
      scope.children = [second]; page.root!.children.push(scope); page.nodeCount = 4;
      return { snapshot: page, target };
    }, input: async () => { inputs++; } });
    try {
      const input = h.makeInput();
      const result = await h.perform({ ...input, target: { ...input.target, ...(scoped ? { within: { resourceId: "scope" } } : {}) } });
      assert.equal(inputs, scoped ? 1 : 0); assert.equal(result.isError, scoped ? undefined : true);
      if (!scoped) assert.match(String(result.message), /唯一匹配/);
      const missing = await h.perform({ ...h.makeInput(), target: { selector: { resourceId: "missing" } } });
      assert.equal(missing.dispatchState, "not_sent");
    } finally { await h.dispose(); }
  }
});

test("null-focus after input is recovered by observation only; a pre-input null-focus cannot send", async () => {
  for (const before of [false, true]) {
    let reads = 0, inputs = 0;
    const h = harness({ observe: async () => { reads++;
      if (reads === (before ? 1 : 2)) throw new FocusUnavailableError("null-focus", "窗口切换");
      return { snapshot: snapshot(), target };
    }, input: async () => { inputs++; } });
    try {
      const result = await h.perform(); assert.equal(inputs, before ? 0 : 1);
      assert.equal(result.dispatchState, before ? "not_sent" : "sent");
      assert.equal(reads, before ? 1 : 3); assert.equal(result.observationAttempts, before ? undefined : 2);
    } finally { await h.dispose(); }
  }
});

test("failed post-input observation resumes without sending input again and verifies with two new observations", async () => {
  let reads = 0, inputs = 0, recovering = false;
  const h = harness({ observe: async () => {
    reads++; if (inputs && !recovering) throw new DebugObservationError("hierarchy_unavailable", "暂不可读");
    return { snapshot: snapshot(inputs ? "暂停" : "播放"), target };
  }, input: async () => { inputs++; } });
  try {
    const input = { ...h.makeInput(), expect: { selector: { text: "暂停" } } };
    const failed = await h.perform(input);
    assert.equal(failed.isError, true); assert.equal(failed.dispatchState, "sent"); assert.equal(reads, 4);
    assert.equal((await h.perform(input)).replayed, true); assert.equal(inputs, 1); assert.equal(reads, 4);
    recovering = true;
    const result = await h.session.request({ name: "resume_ui_step", input: { sessionId: input.sessionId, requestId: input.requestId.toUpperCase() } });
    assert.equal(result.verified, true); assert.equal(result.dispatchState, "sent"); assert.equal(inputs, 1); assert.equal(reads, 6);
    assert.equal(h.session.state.steps.at(-1)!.resolvedInput, undefined); assert.equal(h.session.state.steps.at(-1)!.inputEvidence, undefined);
    assert.equal((await h.perform(input)).verified, true); assert.equal(inputs, 1);
    const reloaded = await loadTestReport(h.session.state.reportPath!);
    assert.equal(reloaded.debug!.steps.at(-1)!.verified, true);
  } finally { await h.dispose(); }
});

test("uncertain input receipt remains unknown when observation recovery succeeds", async () => {
  let inputs = 0;
  const h = harness({ input: async () => { inputs++; throw new DebugInputError({ ...receipt, classification: "timeout", exitCode: null }); } });
  try {
    const input = h.makeInput(), failed = await h.perform(input);
    assert.equal(failed.dispatchState, "unknown");
    const result = await h.session.request({ name: "resume_ui_step", input: { sessionId: input.sessionId, requestId: input.requestId } });
    assert.equal(result.dispatchState, "unknown"); assert.equal(result.verified, false); assert.equal(inputs, 1);
    assert.equal((await h.perform(input)).replayed, true); assert.equal(inputs, 1);
  } finally { await h.dispose(); }
});

test("journal loss before dispatch fails closed", async () => {
  let inputs = 0;
  const h = harness({ observe: async () => {
    unlinkSync(join(h.directory, h.session.state.id, "requests.json"));
    return { snapshot: snapshot(), target };
  }, input: async () => { inputs++; } });
  try { const result = await h.perform(); assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(inputs, 0); }
  finally { await h.dispose(); }
});

test("controlled legacy capture + input + wait takes five observations, composite takes three", async () => {
  const old = harness(), next = harness();
  try {
    const initial = await old.session.request({ name: "capture_ui", input: { sessionId: old.session.state.id } });
    await old.session.request({ name: "tap_node", input: { sessionId: old.session.state.id, snapshotId: initial.snapshotId, nodeId: "0/0" } });
    const verified = await old.session.request({ name: "wait_for_ui", input: { sessionId: old.session.state.id, selector: { text: "暂停" } } });
    const faster = await next.perform({ ...next.makeInput(), expect: { selector: { text: "暂停" } } });
    assert.equal(verified.verified, true); assert.equal(faster.verified, true);
    assert.deepEqual(old.counts(), { reads: 5, inputs: 1 }); assert.deepEqual(next.counts(), { reads: 3, inputs: 1 });
  } finally { await old.dispose(); await next.dispose(); }
});

test("a visually confirmed old target cannot escape the newly resolved within scope", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    const page = snapshot(), old = page.root!.children[0], scope = makeNode("0/0"), other = makeNode("0/1");
    Object.assign(scope, { package: packageName, resourceId: "scope", clickable: false, scrollable: false, visibleToUser: true });
    Object.assign(other, { package: packageName, clickable: false, scrollable: false, visibleToUser: true });
    old.id = "0/0/0"; scope.children = [old]; page.root!.children = [scope]; page.nodeCount = 3;
    if (++reads > 1) {
      const replacement = structuredClone(old);
      replacement.bounds = { left: 300, top: 400, right: 460, bottom: 460, raw: "" };
      old.id = "0/1/0"; other.children = [old]; scope.children = [replacement];
      page.root!.children.push(other); page.nodeCount = 5;
    }
    return { snapshot: page, target };
  }, input: async () => { inputs++; } });
  try {
    const reference = await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id } });
    const input = h.makeInput(), result = await h.perform({ ...input,
      target: { ...input.target, within: { resourceId: "scope" } },
      visualConfirmation: { snapshotId: reference.snapshotId, description: "已查看原范围内的播放按钮" } });
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(inputs, 0);
    assert.match(String(result.message), /新定位目标与原视觉确认目标不一致/);
  } finally { await h.dispose(); }
});

test("composite back and scroll retain their original input validators", async () => {
  for (const kind of ["back", "scroll"] as const) {
    const actions: string[] = [];
    const h = harness({ observe: async () => {
      const page = snapshot(); page.root!.children = []; page.root!.resourceId = "list";
      page.root!.scrollable = true; page.root!.enabled = page.root!.visibleToUser = true; page.nodeCount = 1;
      return { snapshot: page, target };
    }, input: async (_s, _t, action) => { actions.push(action.kind); } });
    try {
      const result = await h.perform({ sessionId: h.session.state.id, requestId: randomUUID(), action: kind === "back" ? { kind }
        : { kind, direction: "down" }, ...(kind === "scroll" ? { target: { selector: { resourceId: "list" }, scrollable: true } } : {}) });
      assert.equal(result.dispatchState, "sent"); assert.equal(result.isError, undefined);
      assert.deepEqual(actions, [kind === "back" ? "back" : "swipe"]);
    } finally { await h.dispose(); }
  }
});

test("a cancellation after dispatch retains its receipt and duplicate request cannot replay it", async () => {
  let reads = 0, inputs = 0;
  const controller = new AbortController();
  const h = harness({ observe: async (_s, _p, _m, signal) => {
    if (++reads > 1) {
      controller.abort(new Error("测试取消")); assert.ok(signal); signal.throwIfAborted();
    }
    return { snapshot: snapshot(), target };
  }, input: async () => { inputs++; } });
  try {
    const input = h.makeInput();
    const result = await h.session.request({ name: "perform_ui_step", input }, controller.signal);
    assert.equal(result.dispatchState, "sent"); assert.equal(result.isError, true); assert.equal(inputs, 1);
    assert.equal(h.session.state.steps.at(-1)!.timings!.status, "cancelled");
    const duplicate = await h.perform(input);
    assert.equal(duplicate.replayed, true); assert.equal(duplicate.dispatchState, "sent"); assert.equal(inputs, 1);
    assert.equal(isDebugTimings(duplicate.timings), true);
  } finally { await h.dispose(); }
});

test("an untrusted observation backend or another window cannot authorize composite input", async () => {
  for (const mode of ["helper", "foreign-window", "hidden"]) {
    let inputs = 0;
    const h = harness({ observe: async () => {
      const page = snapshot();
      if (mode === "helper") page.inspectionSource = "accessibility-helper";
      if (mode === "foreign-window") page.root!.children[0].attributes = { ...page.root!.children[0].attributes, "window-id": "foreign" };
      if (mode === "hidden") page.root!.children[0].visibilityEvidence = "hidden";
      return { snapshot: page, target };
    }, input: async () => { inputs++; } });
    try { const result = await h.perform(); assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(inputs, 0); }
    finally { await h.dispose(); }
  }
});
