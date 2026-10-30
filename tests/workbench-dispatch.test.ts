import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppMenuState } from "../shared/types";
import { workbenchCommands, type WorkbenchCommand } from "../shared/workbench-commands";
import { dispatchWorkbenchAction, dispatchWorkbenchShortcut, type WorkbenchDispatchContext, type WorkbenchHandlers } from "../src/features/workbench/workbench-dispatch";

const ready: AppMenuState = { devices: [{ serial: "connected", state: "device", model: "fixture" }, { serial: "offline", state: "offline", model: "fixture" }],
  selectedSerial: "connected", loading: false, capturing: false, inspecting: true, hasSnapshot: true, canCapture: true,
  filtered: false, canSelectDevice: true, hasRawXml: true, hasScreenshot: true };
function harness(overrides: Partial<WorkbenchDispatchContext> = {}) {
  const calls: string[] = [];
  const handlers = {} as WorkbenchHandlers;
  for (const key of Object.keys(workbenchCommands) as WorkbenchCommand[]) handlers[key] = () => { calls.push(key); };
  const context: WorkbenchDispatchContext = { state: ready, debugActive: false, debugStarting: false, handlers,
    onDevice: serial => calls.push(`device:${serial}`), onDoubleClick: action => calls.push(`double:${action}`), ...overrides };
  return { calls, context, dispatch: (action: Parameters<typeof dispatchWorkbenchAction>[0]) => dispatchWorkbenchAction(action, context) };
}
test("all command entry points reject unavailable capture, save, import and filtered-tree operations", () => {
  const h = harness({ state: { ...ready, capturing: true, filtered: true } });
  for (const type of ["capture", "save", "open-snapshot", "export-snapshot", "expand-all", "collapse-all"] as const) assert.equal(h.dispatch({ type }), false);
  assert.deepEqual(h.calls, []);
  assert.equal(h.dispatch({ type: "cancel" }), true);
  assert.deepEqual(h.calls, ["cancel"]);
  h.context.state = ready;
  assert.equal(h.dispatch({ type: "save" }), true);
  h.context.debugActive = true;
  assert.equal(h.dispatch({ type: "open-snapshot" }), false);
  assert.equal(h.dispatch({ type: "mcp-share" }), false);
  assert.equal(h.dispatch({ type: "mcp-stop" }), true);
});
test("device changes validate ready targets and preserve the explicit deselect action", () => {
  const h = harness();
  assert.equal(h.dispatch({ type: "device", serial: "offline" }), false);
  assert.equal(h.dispatch({ type: "device", serial: "missing" }), false);
  assert.equal(h.dispatch({ type: "device", serial: "connected" }), true);
  assert.equal(h.dispatch({ type: "device", serial: "" }), true);
  h.context.state = { ...ready, canSelectDevice: false };
  assert.equal(h.dispatch({ type: "device", serial: "connected" }), false);
  assert.deepEqual(h.calls, ["device:connected", "device:"]);
});
function shortcut(overrides: Partial<KeyboardEvent> = {}) {
  let prevented = false;
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const event = { key: "s", metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false, repeat: false,
    defaultPrevented: false, isComposing: false, keyCode: 0, preventDefault: () => { prevented = true; }, ...overrides } as KeyboardEvent;
  return { event, prevented: () => prevented };
}
test("shortcuts preserve IME input, modal exclusion, held-key suppression and native-menu ownership", () => {
  const h = harness();
  for (const overrides of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    const key = shortcut(overrides); dispatchWorkbenchShortcut(key.event, { nativeMenu: false, modalOpen: false, dispatch: h.dispatch });
    assert.equal(key.prevented(), false);
  }
  const native = shortcut(); dispatchWorkbenchShortcut(native.event, { nativeMenu: true, modalOpen: false, dispatch: h.dispatch });
  assert.equal(native.prevented(), false);
  for (const [overrides, modalOpen] of [[{ repeat: true }, false], [{}, true]] as const) {
    const key = shortcut(overrides); dispatchWorkbenchShortcut(key.event, { nativeMenu: false, modalOpen, dispatch: h.dispatch });
    assert.equal(key.prevented(), true);
  }
  assert.deepEqual(h.calls, []);
  const key = shortcut(); dispatchWorkbenchShortcut(key.event, { nativeMenu: false, modalOpen: false, dispatch: h.dispatch });
  assert.equal(key.prevented(), true); assert.deepEqual(h.calls, ["save"]);
});
