import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { resolveParentTap, resolveScroll, resolveTap } from "../electron/automation/debug-target-resolution";
import { runDebugInputCommand } from "../electron/device/debug-input";
import { openLiveBridge } from "../electron/automation/mcp-live";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { debugInputArgs, type DebugInputAction } from "../electron/automation/device-actions";
import { parseFocusedWindow, type DebugTarget } from "../electron/device/target";
import { debugCommand, debugSelector } from "../shared/debug-protocol";
import type { DebugSessionEvent, UiNode, UiSnapshot } from "../shared/types";
import { readMcpSnapshot } from "../electron/automation/mcp-snapshot";
import type { DebugSessionReport } from "../shared/debug-report";

const packageName = "com.example.test";
const target: DebugTarget = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "abcd" };
function snapshot(text = "打开设置"): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0");
  root.package = button.package = packageName;
  root.clickable = false;
  button.resourceId = `${packageName}:id/settings`;
  button.text = text;
  button.clickable = button.enabled = button.visibleToUser = true;
  root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "[0,0][1080,2400]" };
  button.bounds = { left: 20, top: 100, right: 180, bottom: 160, raw: "[20,100][180,160]" };
  root.children = [button];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial: "test-device", root, nodeCount: 2, xmlSize: 0, rawXml: null, error: null, warning: null,
    screenshotDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 }, captureMode: "fast" };
}

test("explicit Helper switching creates fresh IDs; failure revokes old shares and actions stay read-only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-helper-switch-")), path = join(directory, "current.json");
  const backends: string[] = []; let fail = false, inputs = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async (_serial, _package, mode, _signal, backend = "uiautomator") => {
      backends.push(backend);
      if (fail) throw Error("Helper HTTP 401");
      const current = snapshot(); current.captureMode = mode; current.inspectionSource = backend;
      if (backend === "accessibility-helper") {
        current.root!.children[0].text = null;
        current.root!.children[0].attributes = { hint: "Account name", error: "Account is required", "state-description": "Paused" };
      }
      return { snapshot: current, target };
    }, input: async () => { inputs++; } });
  const sessionId = session.state.id;
  const capture = (backend = "uiautomator") => session.request({ name: "capture_ui", input: { sessionId, backend } });
  try {
    const initial = await capture(); assert.equal(initial.source, "uiautomator");
    const helper = await capture("accessibility-helper");
    assert.equal(helper.source, "accessibility-helper"); assert.notEqual(helper.snapshotId, initial.snapshotId);
    assert.equal(readMcpSnapshot(path).snapshot.root!.children[0].text, null);
    assert.equal(readMcpSnapshot(path).snapshot.root!.children[0].attributes!.hint, "Account name");
    assert.equal((await session.request({ name: "tap_node", input: { sessionId, snapshotId: initial.snapshotId, nodeId: "0/0" } })).isError, true);
    for (const name of ["tap_node", "scroll_node", "press_back", "wait_for_ui"]) {
      const input = name === "wait_for_ui" ? { sessionId, selector: { text: "设置" } }
        : { sessionId, snapshotId: helper.snapshotId, nodeId: "0/0", ...(name === "scroll_node" ? { direction: "down" } : {}) };
      if (name === "press_back") delete (input as Record<string, unknown>).nodeId;
      const result = await session.request({ name, input }); assert.equal(result.isError, true); assert.match(String(result.message), /Helper/);
    }
    assert.equal(inputs, 0); assert.deepEqual(backends, ["uiautomator", "accessibility-helper"]);
    const returned = await capture(); assert.notEqual(returned.snapshotId, helper.snapshotId);
    fail = true;
    const failed = await capture("accessibility-helper");
    assert.equal(failed.isError, true); assert.equal(failed.snapshotId, null); assert.equal(existsSync(path), false);
    assert.equal((await session.request({ name: "get_debug_session", input: {} })).snapshotId, null);
    assert.deepEqual(backends, ["uiautomator", "accessibility-helper", "uiautomator", "accessibility-helper"]);
    assert.equal(inputs, 0);
    assert.equal(JSON.parse(readFileSync(session.state.evidencePath!, "utf8")).after, null);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("Helper rejects deep, unknown backend and client token paths before any observation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-helper-config-")); let observations = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: join(directory, "current.json"), directory, onEvent: () => {},
    observe: async () => { observations++; return { snapshot: snapshot(), target }; } });
  try {
    for (const options of [{ backend: "unknown" }, { backend: "accessibility-helper", mode: "deep" },
      { backend: "accessibility-helper", helperTokenFile: "/untrusted/client/path" }])
      await assert.rejects(session.request({ name: "capture_ui", input: { sessionId: session.state.id, ...options } }));
    assert.equal(observations, 0);
  } finally { session.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test("stopping during a Helper source switch never republishes a late result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-helper-stop-")), path = join(directory, "current.json");
  let release: (() => void) | undefined; const events: DebugSessionEvent[] = [];
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: e => events.push(e),
    observe: async (_serial, _package, mode, _signal, backend = "uiautomator") => {
      if (backend === "accessibility-helper") await new Promise<void>(resolve => { release = resolve; });
      return { snapshot: { ...snapshot(), captureMode: mode, inspectionSource: backend }, target };
    } });
  try {
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const pending = session.request({ name: "capture_ui", input: { sessionId: session.state.id, backend: "accessibility-helper" } });
    assert.equal(existsSync(path), false); assert.ok(release);
    session.stop(); release!(); assert.equal((await pending).isError, true);
    assert.equal(existsSync(path), false); assert.equal(events.filter(e => e.snapshot).length, 1);
  } finally { session.stop(); release?.(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("stop records the first authoritative reason and rejects late work without rewriting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-stop-reason-"));
  const path = join(directory, "current.json");
  const events: DebugSessionEvent[] = [];
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory,
    onEvent: event => events.push(structuredClone(event)), observe: async () => ({ snapshot: snapshot(), target }) });
  try {
    assert.equal(session.state.stopReason, null);
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast" } });
    assert.equal(session.state.active, true);
    assert.equal(session.state.stopReason, null);
    await session.request({ name: "stop_debug_session", input: { sessionId: session.state.id } });
    const reason = "CLI / MCP 请求停止自动调试";
    assert.equal(session.state.stopReason, reason);
    assert.equal(events.at(-1)!.state.stopReason, reason);
    assert.equal(existsSync(path), false);
    const eventCount = events.length;
    session.stop("工作台切换快照，停止自动调试");
    assert.equal(session.state.stopReason, reason);
    assert.equal(events.length, eventCount);
    await assert.rejects(session.request({ name: "capture_ui", input: { sessionId: session.state.id } }), /会话已结束/);
    assert.equal(existsSync(path), false);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("automatic MCP loop: authenticated capture, safe tap, verification, evidence, cancellation and no implicit authorization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-live-"));
  const path = join(directory, "current.json");
  const events: DebugSessionEvent[] = [];
  let page = "打开设置", taps = 0, moved = false, badWindow = false, badPackage = false;
  let delayed: (() => void) | null = null;
  let delayCapture = false;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory,
    onEvent: event => events.push(structuredClone(event)),
    observe: async (_serial, _package, mode) => {
      if (delayCapture) await new Promise<void>(resolve => { delayed = resolve; });
      const current = snapshot(page);
      current.captureMode = mode;
      if (moved) current.root!.children[0].bounds!.left += 2;
      return { snapshot: current, target: { ...target, windowId: badWindow ? "changed" : target.windowId, packageName: badPackage ? "com.other.app" : packageName } };
    },
    input: async (_serial, fresh, action) => {
      assert.equal(fresh.packageName, packageName); assert.deepEqual(action, { kind: "tap", x: 100, y: 130 });
      taps++; page = "设置";
    },
  });
  const server = createInspectorMcpServer(path);
  const client = new Client({ name: "live-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => await client.callTool({ name, arguments: args }) as CallToolResult;
  const data = (result: CallToolResult) => { assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent!; };
  let bridge: Awaited<ReturnType<typeof openLiveBridge>> | null = null;
  const sessionId = session.state.id;
  try {
    assert.equal((await call("get_debug_session")).isError, true);
    bridge = await openLiveBridge(path, (command, signal) => session.request(command, signal));
    const endpoint = JSON.parse(readFileSync(`${path}.live`, "utf8"));
    if (process.platform !== "win32") assert.equal(statSync(`${path}.live`).mode & 0o777, 0o600);
    const url = `http://127.0.0.1:${endpoint.port}/`;
    const body = JSON.stringify({ name: "get_debug_session", input: {} });
    assert.equal((await fetch(url, { method: "POST", body })).status, 403);
    const headers = { Authorization: `Bearer ${endpoint.token}` };
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(17_000) })).status, 413);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ name: "shell", input: { command: "bad" } }) })).status, 400);
    assert.equal(data(await call("get_debug_session")).id, sessionId);
    assert.equal((await call("capture_ui", { sessionId: "00000000-0000-4000-8000-000000000000" })).isError, true);
    const first = data(await call("capture_ui", { sessionId }));
    assert.equal(data(await call("search_nodes", { snapshotId: first.snapshotId, query: "settings" })).total, 1);
    assert.equal((await call("get_image", { snapshotId: first.snapshotId })).content[1].type, "image");
    const sent = data(await call("tap_node", { sessionId, snapshotId: first.snapshotId, nodeId: "0/0" }));
    assert.equal(taps, 1); assert.equal(sent.dispatched, true); assert.equal(sent.verified, false);
    assert.equal(sent.dispatchState, "sent");
    assert.deepEqual(session.state.steps.at(-1)!.resolvedInput, {
      action: { kind: "tap", x: 100, y: 130 }, frame: { width: 1080, height: 2400, rotation: 0 },
      targetNodeId: "0/0", anchorNodeId: "0/0",
    });
    assert.equal(data(await call("get_debug_session")).snapshotId, sent.snapshotId);
    assert.ok(events.some(event => event.selectedNodeId === "0/0" && event.snapshot?.root?.children[0].text === "打开设置"));
    const verified = data(await call("wait_for_ui", { sessionId, selector: { text: "设置" }, timeoutMs: 1000 }));
    assert.equal(verified.verified, true);
    assert.equal((await call("tap_node", { sessionId, snapshotId: first.snapshotId, nodeId: "0/0" })).isError, true);
    const fresh = data(await call("capture_ui", { sessionId }));
    moved = true;
    assert.equal((await call("tap_node", { sessionId, snapshotId: fresh.snapshotId, nodeId: "0/0" })).isError, true);
    assert.equal(taps, 1); moved = false;
    const next = data(await call("capture_ui", { sessionId })); badWindow = true;
    assert.equal((await call("tap_node", { sessionId, snapshotId: next.snapshotId, nodeId: "0/0" })).isError, true);
    assert.equal(taps, 1); badWindow = false;
    const deep = data(await call("capture_ui", { sessionId, mode: "deep" }));
    assert.equal((await call("tap_node", { sessionId, snapshotId: deep.snapshotId, nodeId: "0/0" })).isError, true);
    badPackage = true;
    assert.equal((await call("capture_ui", { sessionId })).isError, true); badPackage = false;
    assert.equal((await call("wait_for_ui", { sessionId, selector: {}, timeoutMs: 1000 })).isError, true);
    page = "打开设置";
    const before = data(await call("capture_ui", { sessionId }));
    data(await call("tap_node", { sessionId, snapshotId: before.snapshotId, nodeId: "0/0" }));
    const failure = await call("wait_for_ui", { sessionId, selector: { text: "不存在" }, timeoutMs: 1000 });
    assert.equal(failure.isError, true); assert.equal(failure.structuredContent?.verified, false);
    const evidence = JSON.parse(readFileSync(session.state.evidencePath!, "utf8"));
    assert.equal(evidence.before.snapshot.root.children[0].text, "打开设置");
    assert.equal(evidence.after.snapshot.root.children[0].text, "设置");
    assert.equal(evidence.request.name, "wait_for_ui");
    assert.ok(existsSync(join(directory, sessionId, "steps.json")));
    // Cancel an observation even if its driver resolves late: no post-stop publish or click.
    delayCapture = true;
    const pending = session.request({ name: "capture_ui", input: { sessionId } });
    await assert.rejects(session.request({ name: "capture_ui", input: { sessionId } }), /正在执行/);
    session.stop();
    assert.ok(delayed); (delayed as () => void)();
    assert.equal((await pending).isError, true);
    assert.equal(existsSync(path), false);
    assert.equal((await call("get_snapshot")).isError, true);
    assert.equal((await call("capture_ui", { sessionId })).isError, true);
    assert.equal(taps, 2);
  } finally {
    session.stop(); bridge?.close(); await session.settled(); await client.close(); await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function scrollSnapshot(text = "第一页") {
  const current = snapshot();
  const list = makeNode("0/1", 1), row = makeNode("0/1/0", 1);
  list.package = row.package = packageName;
  list.resourceId = `${packageName}:id/list`;
  list.className = "androidx.recyclerview.widget.RecyclerView";
  list.text = list.contentDesc = null;
  list.clickable = false; list.scrollable = true;
  list.bounds = { left: 20, top: 200, right: 1000, bottom: 2000, raw: "" };
  row.bounds = { left: 40, top: 250, right: 980, bottom: 500, raw: "" };
  row.text = text; row.clickable = true; row.scrollable = false;
  list.children = [row];
  current.root!.children.push(list); current.nodeCount = 4;
  return current;
}

test("scroll/back share live preflight, stale guards, dispatch state, evidence and cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-navigation-")), path = join(directory, "current.json");
  let page = "第一页", moved = false, changedWindow = false, rotated = false, leftApp = false, failInput = false, leaveAfterInput = false;
  const inputs: DebugInputAction[] = [];
  let inputFinished: (() => void) | undefined, delayInput = false;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => undefined,
    observe: async (_serial, _packageName, mode) => {
      const current = scrollSnapshot(page); current.captureMode = mode;
      if (moved) current.root!.children[1].bounds!.top += 5;
      if (leftApp) current.root!.package = "com.other.app";
      if (rotated) current.captureGeometry = { ...current.captureGeometry!, hierarchyRotation: 2,
        beforeScreenshot: { ...current.captureGeometry!.beforeScreenshot!, rotation: 2 }, afterScreenshot: { ...current.captureGeometry!.afterScreenshot!, rotation: 2 } };
      return { snapshot: current, target: { ...target, windowId: changedWindow ? "other" : target.windowId } };
    },
    input: async (_serial, fresh, action, frame) => {
      assert.equal(fresh.packageName, packageName); assert.equal(frame.rotation, 0);
      // Sent inputs must invalidate the shared snapshot even if the transport fails.
      assert.equal(existsSync(path), false);
      inputs.push(action);
      if (failInput) throw new Error("模拟连接断开，结果未知");
      if (delayInput) await new Promise<void>(resolve => { inputFinished = resolve; });
      page = action.kind === "back" ? "第一页" : "第二页";
      if (leaveAfterInput) leftApp = true;
    },
  });
  const server = createInspectorMcpServer(path), client = new Client({ name: "navigation-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const bridge = await openLiveBridge(path, (command, signal) => session.request(command, signal));
  const sessionId = session.state.id;
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: { sessionId, ...input } }) as CallToolResult;
    assert.ok(result.structuredContent, JSON.stringify(result)); return result.structuredContent!;
  };
  const capture = () => call("capture_ui");
  const scroll = (snapshotId: unknown, extra = {}) => call("scroll_node", { snapshotId, nodeId: "0/1", direction: "down", ...extra });
  try {
    const initial = await capture(), next = await scroll(initial.snapshotId);
    assert.equal(next.dispatchState, "sent"); assert.equal(next.verified, false);
    assert.equal(inputs.length, 1);
    const swipe = inputs[0]; assert.equal(swipe.kind, "swipe");
    assert.ok(swipe.kind === "swipe" && swipe.fromY > swipe.toY && swipe.fromX === swipe.toX);
    assert.deepEqual(session.state.steps.at(-1)!.resolvedInput, {
      action: swipe, frame: { width: 1080, height: 2400, rotation: 0 }, targetNodeId: "0/1",
      scrollRegion: { viewport: { left: 20, top: 200, right: 1000, bottom: 2000 },
        confirmationBounds: { left: 486, top: 536, right: 535, bottom: 1665 }, excludedNavigationBounds: [] },
    });
    assert.equal((await call("wait_for_ui", { selector: { text: "第二页" }, timeoutMs: 1000 })).verified, true);
    assert.equal((await scroll(initial.snapshotId)).dispatchState, "not_sent");
    const back = await call("press_back", { snapshotId: (await capture()).snapshotId });
    assert.equal(back.dispatchState, "sent"); assert.equal(back.verified, false); assert.equal(inputs[1].kind, "back");
    assert.deepEqual(session.state.steps.at(-1)!.resolvedInput, {
      action: { kind: "back" }, frame: { width: 1080, height: 2400, rotation: 0 },
    });
    assert.equal((await call("wait_for_ui", { selector: { text: "第一页" }, timeoutMs: 1000 })).verified, true);
    let current = await capture(); moved = true;
    assert.equal((await scroll(current.snapshotId)).dispatchState, "not_sent"); moved = false;
    current = await capture(); changedWindow = true;
    assert.equal((await call("press_back", { snapshotId: current.snapshotId })).dispatchState, "not_sent"); changedWindow = false;
    current = await capture(); rotated = true;
    assert.equal((await scroll(current.snapshotId)).dispatchState, "not_sent"); rotated = false;
    const deep = await call("capture_ui", { mode: "deep" });
    assert.equal((await call("press_back", { snapshotId: deep.snapshotId })).dispatchState, "not_sent");
    assert.equal(inputs.length, 2);
    // Out-of-scope observations cannot authorize an action, even if the target metadata matches.
    current = await capture(); leftApp = true;
    assert.equal((await call("press_back", { snapshotId: current.snapshotId })).dispatchState, "not_sent"); leftApp = false;
    assert.equal(inputs.length, 2);
    current = await capture(); leaveAfterInput = true;
    const exited = await call("press_back", { snapshotId: current.snapshotId });
    assert.equal(exited.isError, true); assert.equal(exited.dispatchState, "sent"); assert.equal(exited.snapshotId, null);
    assert.equal((await capture()).isError, true);
    assert.equal(existsSync(path), false); assert.equal(inputs.length, 3);
    leaveAfterInput = leftApp = false;
    current = await capture(); failInput = true;
    const uncertain = await scroll(current.snapshotId);
    assert.equal(uncertain.isError, true); assert.equal(uncertain.dispatchState, "unknown"); assert.equal(uncertain.snapshotId, null);
    assert.equal((await scroll(current.snapshotId)).dispatchState, "not_sent");
    assert.equal(inputs.length, 4); failInput = false;
    // Failed expectations retain the page before scrolling, not just the post-scroll page.
    page = "第一页"; current = await capture(); await scroll(current.snapshotId);
    const failed = await call("wait_for_ui", { selector: { text: "不存在" }, timeoutMs: 1000 });
    assert.equal(failed.isError, true);
    const evidence = JSON.parse(readFileSync(session.state.evidencePath!, "utf8"));
    assert.equal(evidence.before.snapshot.root.children[1].children[0].text, "第一页");
    assert.equal(evidence.after.snapshot.root.children[1].children[0].text, "第二页");
    assert.deepEqual(evidence.steps.findLast((step: { action: string }) => step.action === "scroll_node").resolvedInput.action, inputs.at(-1));
    current = await capture(); delayInput = true;
    const pending = session.request({ name: "press_back", input: { sessionId, snapshotId: current.snapshotId } });
    for (let i = 0; !inputFinished && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(inputFinished);
    await assert.rejects(session.request({ name: "press_back", input: { sessionId, snapshotId: current.snapshotId } }), /正在执行/);
    session.stop(); inputFinished();
    assert.equal((await pending).isError, true); assert.equal(existsSync(path), false);
  } finally {
    session.stop(); bridge.close(); await session.settled(); await client.close(); await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scroll paths stay inside the visible container; input args never expose arbitrary commands", () => {
  const current = scrollSnapshot(), list = current.root!.children[1];
  const options = { direction: "down" as const, distance: 0.6, durationMs: 350 };
  for (const direction of ["up", "down", "left", "right"] as const) {
    const { action } = resolveScroll(list, current, packageName, { ...options, direction });
    assert.ok([action.fromX, action.toX].every(x => x > list.bounds!.left && x < list.bounds!.right));
    assert.ok([action.fromY, action.toY].every(y => y > list.bounds!.top && y < list.bounds!.bottom));
    if (direction === "down") assert.ok(action.fromY > action.toY);
    if (direction === "up") assert.ok(action.fromY < action.toY);
    if (direction === "right") assert.ok(action.fromX > action.toX);
    if (direction === "left") assert.ok(action.fromX < action.toX);
    assert.deepEqual(debugInputArgs(action), ["touchscreen", "-d", "0", "swipe", ...[action.fromX, action.fromY, action.toX, action.toY, 350].map(String)]);
  }
  const nested = { ...list, id: "0/1/1", resourceId: "nested", children: [] };
  list.children.push(nested);
  assert.throws(() => resolveScroll(list, current, packageName, options), /嵌套/); list.children.pop();
  current.root!.children.push({ ...nested, id: "0/2" });
  assert.throws(() => resolveScroll(list, current, packageName, options), /占用/); current.root!.children.pop();
  list.scrollable = false; assert.throws(() => resolveScroll(list, current, packageName, options), /不可滚动/); list.scrollable = true;
  list.bounds!.right = 60; assert.throws(() => resolveScroll(list, current, packageName, options), /太小/);
  list.bounds!.right = 100; assert.throws(() => resolveScroll(list, current, packageName, { ...options, direction: "right", distance: 0.1 }), /距离不足/);
  list.bounds = { left: -200, top: 200, right: 1200, bottom: 2600, raw: "" };
  const clipped = resolveScroll(list, current, packageName, options).action;
  assert.ok(clipped.fromX > 0 && clipped.fromX < 1080 && clipped.fromY < 2400 && clipped.toY >= 200);
  assert.deepEqual(debugInputArgs({ kind: "back" }), ["-d", "0", "keyevent", "KEYCODE_BACK"]);
  assert.throws(() => debugInputArgs({ kind: "tap", x: NaN, y: 0 }), /坐标/);
  assert.throws(() => debugInputArgs({ kind: "swipe", fromX: 0, fromY: 0, toX: 0, toY: 0, durationMs: 350 }), /参数/);
  assert.throws(() => debugInputArgs({ kind: "swipe", fromX: 0, fromY: 0, toX: 10, toY: 10, durationMs: 9999 }), /参数/);
  const input = { sessionId: "00000000-0000-4000-8000-000000000000", snapshotId: "00000000-0000-4000-8000-000000000000", nodeId: "0/1", ...options };
  for (const extra of [{ distance: 0 }, { distance: 1 }, { durationMs: 1001 }, { direction: "bad" }, { x: 100 }, { command: "shell" }]) {
    assert.throws(() => debugCommand.parse({ name: "scroll_node", input: { ...input, ...extra } }));
  }
  assert.throws(() => debugCommand.parse({ name: "press_back", input: { sessionId: input.sessionId, snapshotId: input.snapshotId, key: "HOME" } }));
  assert.throws(() => debugSelector.parse({ text: undefined }));
});

test("recording failures are returned to the MCP client, not only shown on desktop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-recording-")), path = join(directory, "current.json");
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path,
    directory: path, onEvent: () => undefined, observe: async () => ({ snapshot: snapshot(), target }) });
  try {
    const result = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    assert.ok(result.snapshotId); assert.ok(String(result.recordingWarning).includes("记录保存失败"));
    assert.ok(String(result.message).includes("记录保存失败"));
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("actual exit0 input rejection is saved in failure evidence and stale actions cannot retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-input-reply-")), path = join(directory, "current.json");
  let attempts = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory,
    onEvent: () => {}, observe: async () => ({ snapshot: snapshot(), target }),
    input: async (_serial, _target, _action, _frame, signal, onEvidence) => {
      attempts++;
      await runDebugInputCommand(process.execPath,
        ["-e", "process.stderr.write('java.lang.SecurityException: INJECT_EVENTS denied')"], signal, onEvidence);
    },
  });
  try {
    const initial = await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast" } });
    const command = { name: "tap_node", input: { sessionId: session.state.id, snapshotId: initial.snapshotId, nodeId: "0/0" } };
    const result = await session.request(command);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "unknown"); assert.equal(result.verified, false);
    assert.equal(result.snapshotId, null); assert.equal(existsSync(path), false);
    const saved = JSON.parse(readFileSync(session.state.evidencePath!, "utf8"));
    assert.equal(saved.step.inputEvidence.classification, "permission-denied");
    assert.equal(saved.step.inputEvidence.exitCode, 0); assert.equal(saved.step.inputEvidence.closed, true);
    assert.equal(saved.step.inputEvidence.stderr, "java.lang.SecurityException: INJECT_EVENTS denied");
    assert.deepEqual(saved.step.resolvedInput, {
      action: { kind: "tap", x: 100, y: 130 }, frame: { width: 1080, height: 2400, rotation: 0 },
      targetNodeId: "0/0", anchorNodeId: "0/0",
    });
    assert(saved.before); assert.equal(saved.after, null); // No fabricated post-input observation.
    assert.equal((await session.request(command)).dispatchState, "not_sent"); assert.equal(attempts, 1);
    const steps = JSON.parse(readFileSync(join(directory, session.state.id, "steps.json"), "utf8"));
    assert.equal(steps.steps[1].inputEvidence.classification, "permission-denied");
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("input spawn failure stays not_sent and successful receipt survives subsequent observation failure", async () => {
  for (const missing of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), "inspector-input-state-")), path = join(directory, "current.json");
    let reads = 0;
    const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
      observe: async () => { if (++reads > 2) throw Error("post-input observation failed"); return { snapshot: snapshot(), target }; },
      input: async (_serial, _target, _action, _frame, signal, onEvidence) => {
        await runDebugInputCommand(missing ? "/no-such-inspector-input-fixture" : process.execPath,
          missing ? [] : ["-e", "process.exitCode=0"], signal, onEvidence);
      },
    });
    try {
      const initial = await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast" } });
      const result = await session.request({ name: "tap_node", input: { sessionId: session.state.id, snapshotId: initial.snapshotId, nodeId: "0/0" } });
      assert.equal(result.isError, true); assert.equal(result.dispatchState, missing ? "not_sent" : "sent");
      const evidence = JSON.parse(readFileSync(session.state.evidencePath!, "utf8"));
      assert.equal(evidence.step.inputEvidence.classification, missing ? "spawn-failed" : "accepted");
      assert.equal(evidence.step.inputEvidence.closed, true); assert.equal(evidence.after, null);
      assert.deepEqual(evidence.step.resolvedInput.action, { kind: "tap", x: 100, y: 130 });
      assert.equal(evidence.step.resolvedInput.targetNodeId, "0/0");
      assert.deepEqual(JSON.parse(readFileSync(join(directory, session.state.id, "steps.json"), "utf8")).steps.at(-1).resolvedInput,
        evidence.step.resolvedInput);
    } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("click targeting rejects ambiguity, overlap, disabled/offscreen nodes and unidentifiable focus", () => {
  assert.deepEqual(parseFocusedWindow("mCurrentFocus=Window{a1b2 u0 com.example.test/.Main}"), { id: "a1b2", packageName });
  assert.equal(parseFocusedWindow("mCurrentFocus=null"), null);
  assert.deepEqual(parseFocusedWindow("mTopFocusedDisplayId=0\n Display: mDisplayId=0 (organized)\n mCurrentFocus=Window{abcd u0 com.example.test/.Main}\n Display: mDisplayId=2\n mCurrentFocus=Window{ffff u0 com.other.app/.Main}"), { id: "abcd", packageName });
  assert.equal(parseFocusedWindow("mTopFocusedDisplayId=2\n mCurrentFocus=Window{abcd u0 com.example.test/.Main}"), null);
  assert.equal(parseFocusedWindow("mCurrentFocus=Window{abcd u0 PopupWindow:123}"), null);
  const current = snapshot(), button = current.root!.children[0];
  assert.equal(resolveTap(button, current, packageName).x, 100);
  current.root!.children.push({ ...button, id: "0/1" });
  assert.throws(() => resolveTap(button, current, packageName), /不唯一/);
  current.root!.children[1].text = "遮挡按钮";
  assert.throws(() => resolveTap(button, current, packageName), /重叠/);
  current.root!.children.pop();
  button.enabled = false;
  assert.throws(() => resolveTap(button, current, packageName), /未启用/);
  button.enabled = true; button.bounds = { left: -100, top: -100, right: -10, bottom: -10, raw: "" };
  assert.throws(() => resolveTap(button, current, packageName), /不在屏幕/);
  button.resourceId = button.text = button.contentDesc = null;
  assert.throws(() => resolveTap(button, current, packageName), /稳定/);
});

function scrollCoveredTabSnapshot(): UiSnapshot {
  const current = snapshot(), tab = current.root!.children[0];
  tab.id = "0/1"; tab.className = "androidx.appcompat.app.ActionBar$Tab";
  tab.resourceId = tab.text = null; tab.contentDesc = "精选"; tab.scrollable = false;
  tab.bounds = { left: 216, top: 2218, right: 432, bottom: 2355, raw: "" };
  const scrollers = [0, 1959, 2113].map((top, index) => {
    const node = makeNode(`0/0${"/0".repeat(index)}`);
    node.package = packageName; node.clickable = false; node.scrollable = true;
    node.className = index < 2 ? "androidx.viewpager.widget.ViewPager" : "androidx.recyclerview.widget.RecyclerView";
    node.bounds = { left: 0, top, right: 1080, bottom: 2355, raw: "" };
    return node;
  });
  scrollers[0].children = [scrollers[1]]; scrollers[1].children = [scrollers[2]];
  current.root!.children = [scrollers[0], tab]; current.nodeCount = 5;
  return current;
}

test("tap permits larger same-app passive scrollers around an independent bottom tab", () => {
  const current = scrollCoveredTabSnapshot(), tab = current.root!.children[1];
  const original = structuredClone(current);
  const hit = resolveTap(tab, current, packageName);
  assert.equal(hit.node.id, tab.id); assert.deepEqual([hit.x, hit.y], [324, 2286]);
  assert.deepEqual(current, original);
});

test("tap still rejects clickable, partially covering, equal-sized and foreign scroll overlays", () => {
  for (const change of [
    (node: UiNode) => { node.clickable = true; },
    (node: UiNode) => { node.bounds!.left = 300; },
    (node: UiNode) => { node.bounds = { left: 216, top: 2218, right: 432, bottom: 2355, raw: "" }; },
    (node: UiNode) => { node.package = "com.other.app"; },
  ]) {
    const current = scrollCoveredTabSnapshot(), targetNode = current.root!.children[0];
    change(targetNode);
    assert.throws(() => resolveTap(current.root!.children[1], current, packageName), /重叠/);
  }
});

test("clickable content inside a passive scroller still blocks the tab hit", () => {
  const current = scrollCoveredTabSnapshot(), tab = current.root!.children[1];
  const button = makeNode("0/0/1"); button.package = packageName;
  button.clickable = true; button.scrollable = false; button.text = "其他按钮";
  button.bounds = { ...tab.bounds! };
  current.root!.children[0].children.push(button); current.nodeCount++;
  assert.throws(() => resolveTap(tab, current, packageName), /重叠/);
});

test("the passive-container tap exception does not allow overlapping scroll gestures", () => {
  const current = scrollCoveredTabSnapshot(), tab = current.root!.children[1];
  tab.scrollable = true;
  assert.throws(() => resolveScroll(tab, current, packageName, { direction: "down", distance: 0.6, durationMs: 350 }), /占用/);
});

function parentTapSnapshot(): UiSnapshot {
  const current = snapshot(), row = current.root!.children[0], label = makeNode("0/0/0");
  row.className = "android.view.ViewGroup";
  row.resourceId = row.text = row.contentDesc = null;
  row.scrollable = false;
  row.bounds = { left: 0, top: 80, right: 200, bottom: 190, raw: "" };
  label.package = packageName; label.className = "android.widget.TextView";
  label.text = "播放设置"; label.resourceId = `${packageName}:id/item_title`; label.contentDesc = null;
  label.clickable = label.scrollable = false; label.enabled = label.visibleToUser = true;
  label.bounds = { left: 20, top: 100, right: 180, bottom: 160, raw: "" };
  row.children = [label]; current.nodeCount = 3;
  return current;
}

test("explicit parent tap uses a named label without weakening default anonymous/nonclickable rejection", () => {
  const before = parentTapSnapshot(), after = structuredClone(before), label = before.root!.children[0].children[0];
  assert.throws(() => resolveTap(before.root!.children[0], after, packageName), /稳定/);
  assert.throws(() => resolveTap(label, after, packageName), /不可点击/);
  const hit = resolveParentTap(label, before, after, packageName);
  assert.equal(hit.node.id, "0/0"); assert.equal(hit.anchor.id, label.id);
  assert.deepEqual([hit.x, hit.y], [100, 135]);
});

test("parent tap also accepts fully containing passive scrollers and keeps nested buttons blocked", () => {
  const before = scrollCoveredTabSnapshot(), tab = before.root!.children[1], label = makeNode("0/1/0");
  label.package = packageName; label.className = "android.widget.TextView";
  label.text = "精选"; label.resourceId = label.contentDesc = null; label.clickable = label.scrollable = false;
  label.bounds = { left: 274, top: 2253, right: 368, bottom: 2316, raw: "" };
  tab.children = [label]; before.nodeCount++;
  const after = structuredClone(before);
  const hit = resolveParentTap(label, before, after, packageName);
  assert.equal(hit.node.id, tab.id); assert.equal(hit.anchor.id, label.id);
  const nested = makeNode("0/1/1"); nested.package = packageName; nested.clickable = true;
  nested.bounds = { ...label.bounds! }; after.root!.children[1].children.push(nested); after.nodeCount++;
  assert.throws(() => resolveParentTap(label, before, after, packageName), /子控件/);
});

test("bottom tab MCP tap dispatches once and retains not-sent results for clickable overlaps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-tab-tap-")), path = join(directory, "current.json");
  let inputs = 0, blocked = false;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async () => {
      const current = scrollCoveredTabSnapshot(); current.inspectionSource = "uiautomator";
      current.root!.children[1].selected = inputs > 0;
      if (blocked) current.root!.children[0].clickable = true;
      return { snapshot: current, target };
    },
    input: async (_serial, _target, action) => { assert.deepEqual(action, { kind: "tap", x: 324, y: 2286 }); inputs++; },
  });
  const server = createInspectorMcpServer(path), client = new Client({ name: "tab-tap-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
  const bridge = await openLiveBridge(path, (command, signal) => session.request(command, signal));
  const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: { sessionId: session.state.id, ...args } }) as CallToolResult;
  try {
    let captured = await call("capture_ui", {});
    const sent = await call("tap_node", { snapshotId: captured.structuredContent!.snapshotId, nodeId: "0/1", target: "self" });
    assert.equal(sent.isError, undefined); assert.equal(sent.structuredContent!.dispatchState, "sent");
    assert.equal(sent.structuredContent!.verified, false); assert.equal(inputs, 1);
    assert.equal(readMcpSnapshot(path).snapshot.root!.children[1].selected, true);
    assert.equal(session.state.steps.at(-1)!.resolvedInput!.targetNodeId, "0/1");
    blocked = true; captured = await call("capture_ui", {});
    const rejected = await call("tap_node", { snapshotId: captured.structuredContent!.snapshotId, nodeId: "0/1", target: "self" });
    assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent!.dispatchState, "not_sent"); assert.equal(inputs, 1);
    assert.equal(session.state.steps.at(-1)!.resolvedInput, undefined);
  } finally { session.stop(); await session.settled(); bridge.close(); await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("parent tap rejects duplicate labels even at different locations", () => {
  const before = parentTapSnapshot(), after = structuredClone(before), label = before.root!.children[0].children[0];
  const duplicate = structuredClone(after.root!.children[0].children[0]);
  duplicate.id = "0/1"; duplicate.bounds!.top += 300;
  after.root!.children.push(duplicate);
  assert.throws(() => resolveParentTap(label, before, after, packageName), /不唯一/);
});

test("parent tap rejects changed geometry, ancestry, parent identity and unavailable ancestors", () => {
  const before = parentTapSnapshot(), label = before.root!.children[0].children[0];
  for (const change of [
    (tree: UiSnapshot) => { tree.root!.children[0].bounds!.top++; },
    (tree: UiSnapshot) => { tree.root!.children[0].className = "changed.Row"; },
    (tree: UiSnapshot) => { tree.root!.children[0].enabled = false; },
    (tree: UiSnapshot) => { tree.root!.children[0].visibleToUser = false; },
    (tree: UiSnapshot) => { tree.root!.children[0].scrollable = true; },
    (tree: UiSnapshot) => { tree.root!.children[0].children[0].bounds!.left++; },
    (tree: UiSnapshot) => { tree.root!.children[0].children[0].package = "com.other.app"; },
    (tree: UiSnapshot) => {
      const row = tree.root!.children[0], wrapper = makeNode("0/0/0");
      wrapper.package = packageName; wrapper.bounds = row.bounds; wrapper.clickable = false;
      row.children[0].id = "0/0/0/0"; wrapper.children = row.children; row.children = [wrapper];
    },
  ]) {
    const after = structuredClone(before); change(after);
    assert.throws(() => resolveParentTap(label, before, after, packageName));
  }
});

test("parent tap rejects anonymous anchors, missing parent, outside labels and nested hit targets", () => {
  for (const variant of ["anonymous", "no-parent", "outside", "nested", "overlap"] as const) {
    const before = parentTapSnapshot(), row = before.root!.children[0], label = row.children[0];
    if (variant === "anonymous") label.text = label.resourceId = label.contentDesc = null;
    if (variant === "no-parent") row.clickable = false;
    if (variant === "outside") label.bounds!.right = 210;
    if (variant === "nested" || variant === "overlap") {
      const button = makeNode(variant === "nested" ? "0/0/1" : "0/1");
      button.package = packageName; button.clickable = true; button.bounds = { ...label.bounds! };
      (variant === "nested" ? row : before.root!).children.push(button);
    }
    assert.throws(() => resolveParentTap(label, before, structuredClone(before), packageName));
  }
});

test("parent tap MCP contract dispatches once, records anchor, and rejects changed parent without dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-parent-tap-")), path = join(directory, "current.json");
  let changed = false, inputs = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async (_serial, _package, mode) => {
      const current = parentTapSnapshot(); current.captureMode = mode;
      if (changed) current.root!.children[0].bounds!.right++;
      return { snapshot: current, target };
    },
    input: async (_serial, _target, action) => { assert.deepEqual(action, { kind: "tap", x: 100, y: 135 }); inputs++; },
  });
  const server = createInspectorMcpServer(path), client = new Client({ name: "parent-tap-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
  const bridge = await openLiveBridge(path, (command, signal) => session.request(command, signal));
  const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: { sessionId: session.state.id, ...args } }) as CallToolResult;
  try {
    let captured = await call("capture_ui", {});
    const args = { snapshotId: captured.structuredContent!.snapshotId, nodeId: "0/0/0" };
    const rejected = await call("tap_node", args);
    assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent!.dispatchState, "not_sent"); assert.equal(inputs, 0);
    captured = await call("capture_ui", {});
    const sent = await call("tap_node", { ...args, snapshotId: captured.structuredContent!.snapshotId, target: "clickable-parent" });
    assert.equal(sent.isError, undefined); assert.equal(sent.structuredContent!.dispatchState, "sent"); assert.equal(inputs, 1);
    assert.equal(sent.structuredContent!.anchorNodeId, "0/0/0");
    assert.equal(sent.structuredContent!.targetNodeId, "0/0");
    const state = await client.callTool({ name: "get_debug_session", arguments: {} }) as CallToolResult;
    assert.ok(!state.isError); const steps = state.structuredContent!.steps; assert.ok(Array.isArray(steps));
    assert.deepEqual(steps.at(-1).resolvedInput, {
      action: { kind: "tap", x: 100, y: 135 }, frame: { width: 1080, height: 2400, rotation: 0 },
      targetNodeId: "0/0", anchorNodeId: "0/0/0",
    });
    assert.match(session.state.steps.at(-1)!.message, /播放设置的父控件/);
    captured = await call("capture_ui", {}); changed = true;
    const moved = await call("tap_node", { ...args, snapshotId: captured.structuredContent!.snapshotId, target: "clickable-parent" });
    assert.equal(moved.isError, true); assert.equal(moved.structuredContent!.dispatchState, "not_sent"); assert.equal(inputs, 1);
    assert.equal(session.state.steps.at(-1)!.resolvedInput, undefined);
    assert.throws(() => debugCommand.parse({ name: "tap_node", input: { sessionId: session.state.id, ...args, target: "any-parent" } }));
  } finally { session.stop(); await session.settled(); bridge.close(); await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("accepted input on an unchanged page is not navigation success and retains the resolved target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-unchanged-page-")), path = join(directory, "current.json");
  let inputs = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async () => ({ snapshot: parentTapSnapshot(), target }),
    input: async (_serial, _target, _action, _frame, signal, onEvidence) => {
      inputs++;
      await runDebugInputCommand(process.execPath, ["-e", "process.exitCode=0"], signal, onEvidence);
    },
  });
  try {
    const captured = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const tap = { name: "tap_node", input: { sessionId: session.state.id, snapshotId: captured.snapshotId,
      nodeId: "0/0/0", target: "clickable-parent" } };
    const sent = await session.request(tap);
    assert.equal(sent.dispatchState, "sent"); assert.equal(sent.verified, false);
    const failed = await session.request({ name: "wait_for_ui", input: { sessionId: session.state.id,
      selector: { text: "播放设置", resourceId: `${packageName}:id/title_tv` }, timeoutMs: 1000 } });
    assert.equal(failed.isError, true); assert.equal(failed.verified, false);
    const evidence = JSON.parse(readFileSync(session.state.evidencePath!, "utf8"));
    const step = evidence.steps.findLast((value: { action: string }) => value.action === "tap_node");
    assert.equal(step.inputEvidence.classification, "accepted");
    assert.deepEqual(step.resolvedInput, { action: { kind: "tap", x: 100, y: 135 },
      frame: { width: 1080, height: 2400, rotation: 0 }, targetNodeId: "0/0", anchorNodeId: "0/0/0" });
    assert.deepEqual(evidence.before.snapshot.root, evidence.after.snapshot.root);
    assert.equal((await session.request(tap)).dispatchState, "not_sent"); assert.equal(inputs, 1);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

function report(session: DebugSession): DebugSessionReport {
  assert.ok(session.state.reportPath);
  return JSON.parse(readFileSync(session.state.reportPath, "utf8"));
}

test("successful steps persist their actual trees and receipt while dispatch and verification remain separate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-report-")), path = join(directory, "current.json");
  let page = "打开设置", reads = 0, inputs = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async () => { reads++; return { snapshot: { ...snapshot(page), inspectionSource: "uiautomator" }, target }; },
    input: async (_serial, _target, _action, _frame, _signal, onEvidence) => {
      inputs++; page = "设置";
      onEvidence?.({ classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null,
        durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false });
    },
  });
  try {
    const captured = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    await session.request({ name: "tap_node", input: { sessionId: session.state.id, snapshotId: captured.snapshotId, nodeId: "0/0" } });
    await session.request({ name: "wait_for_ui", input: { sessionId: session.state.id, selector: { text: "设置" }, timeoutMs: 1000 } });
    const saved = report(session);
    assert.equal(reads, 5); assert.equal(inputs, 1); // Evidence never triggers an extra observation or input.
    assert.deepEqual(saved.steps.map(item => [item.step.action, item.verified]), [["capture_ui", null], ["tap_node", false], ["wait_for_ui", true]]);
    const tapped = saved.steps[1];
    assert.equal(tapped.step.dispatchState, "sent"); assert.equal(tapped.step.inputEvidence!.classification, "accepted");
    assert.equal(tapped.before.freshness, "current"); assert.equal(tapped.after.freshness, "current");
    const text = (id: string) => {
      const evidence = saved.snapshots.find(item => item.snapshotId === id)!;
      const tree = JSON.parse(readFileSync(join(directory, session.state.id, evidence.tree!.path), "utf8"));
      return tree.snapshot.root.children[0].text;
    };
    assert.equal(text(tapped.before.snapshotId!), "打开设置"); assert.equal(text(tapped.after.snapshotId!), "设置");
    assert.equal(saved.session.totalSteps, 3); assert.equal(saved.session.droppedSteps, 0);
    session.stop("test completed");
    assert.equal(report(session).session.active, false); assert.equal(report(session).session.stopReason, "test completed");
    assert.equal(existsSync(path), false); assert.equal(report(session).steps.length, 3);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("self and parent taps record the rematched anchor's fresh ID when tree indexes change", async () => {
  for (const parent of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "inspector-step-rematched-id-")), path = join(directory, "current.json");
    let reads = 0, inputs = 0;
    const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
      observe: async () => {
        const current = parent ? parentTapSnapshot() : snapshot();
        if (++reads > 1) {
          const matching = current.root!.children[0]; matching.id = "0/1"; matching.index = 1;
          if (parent) matching.children[0].id = "0/1/0";
          const other = makeNode("0/0", 1); other.package = packageName; other.text = "different control";
          other.clickable = other.scrollable = false; other.bounds = { left: 300, top: 500, right: 500, bottom: 600, raw: "" };
          current.root!.children.unshift(other); current.nodeCount++;
        }
        return { snapshot: current, target };
      }, input: async () => { inputs++; },
    });
    try {
      const captured = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
      const result = await session.request({ name: "tap_node", input: { sessionId: session.state.id, snapshotId: captured.snapshotId,
        nodeId: parent ? "0/0/0" : "0/0", target: parent ? "clickable-parent" : "self" } });
      assert.equal(result.isError, undefined); assert.equal(inputs, 1); assert.equal(reads, 3);
      const expectedAnchor = parent ? "0/1/0" : "0/1";
      assert.equal(result.targetNodeId, "0/1"); assert.equal(result.anchorNodeId, expectedAnchor);
      assert.equal(session.state.steps.at(-1)!.resolvedInput!.anchorNodeId, expectedAnchor);
      const saved = report(session), tapped = saved.steps[1];
      assert.equal(tapped.step.resolvedInput!.targetNodeId, "0/1"); assert.equal(tapped.step.resolvedInput!.anchorNodeId, expectedAnchor);
      const tree = JSON.parse(readFileSync(join(directory, session.state.id,
        saved.snapshots.find(item => item.snapshotId === tapped.before.snapshotId)!.tree!.path), "utf8"));
      const matching = tree.snapshot.root.children[1];
      assert.equal(matching.id, "0/1"); assert.equal(parent ? matching.children[0].id : matching.id, expectedAnchor);
      assert.equal(tree.snapshot.root.children[0].text, "different control");
    } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a failed fresh capture labels the retained previous page and does not invent a post-operation observation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-previous-")), path = join(directory, "current.json");
  let reads = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async () => { if (++reads === 2) throw new Error("capture fixture unavailable"); return { snapshot: snapshot(), target }; },
  });
  try {
    const first = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const failed = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const saved = report(session), step = saved.steps[1];
    assert.equal(failed.isError, true); assert.equal(reads, 2);
    assert.equal(step.step.error!.phase, "capture"); assert.equal(step.step.error!.code, "capture_failed");
    assert.equal(step.after.freshness, "previous"); assert.equal(step.after.snapshotId, first.snapshotId);
    assert.match(step.after.reason!, /不能作为操作后结果/);
    assert.equal(saved.steps[0].step.status, "done");
    assert.equal(JSON.parse(readFileSync(session.state.evidencePath!, "utf8")).after, null);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("stop immediately persists an in-flight step's before evidence; late completion neither observes nor revives sharing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-cancelled-")), path = join(directory, "current.json");
  let release: (() => void) | undefined, reads = 0, inputs = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async () => { reads++; return { snapshot: snapshot(), target }; },
    input: async () => { inputs++; await new Promise<void>(resolve => { release = resolve; }); },
  });
  try {
    const first = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const pending = session.request({ name: "press_back", input: { sessionId: session.state.id, snapshotId: first.snapshotId } });
    for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(release); session.stop("cancel fixture");
    const stopped = report(session);
    assert.equal(stopped.session.active, false); assert.equal(stopped.session.totalSteps, 2);
    const step = stopped.steps[1];
    assert.equal(step.step.error!.code, "cancelled"); assert.equal(step.step.error!.phase, "input");
    assert.equal(step.before.freshness, "current"); assert.ok(step.before.snapshotId);
    assert.equal(step.after.freshness, "missing"); assert.equal(step.after.snapshotId, null);
    assert.ok(stopped.snapshots.find(item => item.snapshotId === step.before.snapshotId)!.tree);
    release(); assert.equal((await pending).isError, true);
    assert.equal(reads, 2); assert.equal(inputs, 1); assert.equal(existsSync(path), false);
    const final = report(session);
    assert.equal(final.steps.length, 2); assert.equal(final.session.stopReason, "cancel fixture");
    assert.equal(final.steps[1].step.error!.code, "cancelled"); assert.equal(final.steps[1].step.error!.phase, "input");
    assert.equal(final.steps[1].after.snapshotId, null);
  } finally { session.stop(); release?.(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("the default report retains the latest 100 steps with explicit dropped counts across failures and stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-roll-")), path = join(directory, "current.json");
  let reads = 0;
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: path, directory, onEvent: () => {},
    observe: async () => { if (++reads % 20 === 0) throw new Error("periodic fixture failure"); return { snapshot: snapshot(`page-${reads}`), target }; },
  });
  try {
    for (let step = 0; step < 104; step++) await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    session.stop();
    const saved = report(session);
    assert.equal(saved.steps.length, 100); assert.equal(saved.steps[0].step.id, 5); assert.equal(saved.steps.at(-1)!.step.id, 104);
    assert.equal(saved.session.totalSteps, 104); assert.equal(saved.session.droppedSteps, 4); assert.equal(saved.session.active, false);
    assert.equal(saved.steps.filter(item => item.step.status === "failed").length, 5);
    assert.equal(saved.steps.filter(item => item.step.status === "done").length, 95);
    assert.equal(reads, 104); assert.equal(session.state.steps.length, 100);
    const declared = new Set(saved.snapshots.map(item => item.snapshotId));
    for (const step of saved.steps) for (const ref of [step.before, step.after]) if (ref.snapshotId) assert.ok(declared.has(ref.snapshotId));
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("recording failures preserve the action error and an empty session still stops without a storage exception", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-storage-error-")), blocked = join(directory, "blocked");
  writeFileSync(blocked, "not a directory");
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: join(directory, "current.json"), directory: blocked,
    onEvent: () => {}, observe: async () => { throw new Error("original capture failure"); },
  });
  const empty = new DebugSession({ serial: "test-device", packageName, snapshotPath: join(directory, "empty.json"), directory: blocked, onEvent: () => {},
    observe: async () => { throw new Error("Empty session must not observe a device"); } });
  try {
    const result = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const failed = session.state.steps[0];
    assert.equal(result.isError, true); assert.deepEqual(failed.error,
      { category: "capture", code: "capture_failed", phase: "capture", message: "original capture failure" });
    assert.ok(failed.recordingErrors?.every(error => error.phase === "recording"));
    assert.ok(failed.recordingErrors?.some(error => error.code === "report_write_failed"));
    assert.equal(session.state.reportPath, null);
    assert.doesNotThrow(() => session.stop()); assert.doesNotThrow(() => empty.stop("empty stopped"));
    assert.equal(empty.state.active, false); assert.equal(empty.state.stopReason, "empty stopped");
  } finally { session.stop(); empty.stop(); await session.settled(); await empty.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("an empty session persists an inactive report when stopped", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-empty-"));
  const session = new DebugSession({ serial: "test-device", packageName, snapshotPath: join(directory, "current.json"), directory, onEvent: () => {},
    observe: async () => { throw new Error("Empty session must not observe a device"); } });
  try {
    session.stop("empty complete");
    const saved = report(session);
    assert.equal(saved.session.active, false); assert.equal(saved.session.stopReason, "empty complete");
    assert.equal(saved.session.totalSteps, 0); assert.equal(saved.session.droppedSteps, 0);
    assert.deepEqual(saved.steps, []); assert.deepEqual(saved.snapshots, []);
  } finally { session.stop(); rmSync(directory, { recursive: true, force: true }); }
});
