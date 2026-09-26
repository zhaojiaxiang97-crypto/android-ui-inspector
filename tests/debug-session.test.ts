import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession, resolveScroll, resolveTap } from "../electron/debug-session";
import { openLiveBridge } from "../electron/mcp-live";
import { createInspectorMcpServer } from "../electron/mcp-server";
import { debugInputArgs, parseFocusedWindow, type DebugInputAction, type DebugTarget } from "../electron/adb";
import { debugCommand, debugSelector } from "../shared/debug-protocol";
import type { DebugSessionEvent, UiSnapshot } from "../shared/types";

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
    assert.equal((await call("wait_for_ui", { selector: { text: "第二页" }, timeoutMs: 1000 })).verified, true);
    assert.equal((await scroll(initial.snapshotId)).dispatchState, "not_sent");
    const back = await call("press_back", { snapshotId: (await capture()).snapshotId });
    assert.equal(back.dispatchState, "sent"); assert.equal(back.verified, false); assert.equal(inputs[1].kind, "back");
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
