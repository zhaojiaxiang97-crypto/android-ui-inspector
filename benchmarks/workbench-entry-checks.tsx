import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import App from "../src/App";
import type { AdbProbeResult, AppMenuAction, DeviceInfo, UiSnapshot } from "../shared/types";
import type { HomeState } from "../shared/device-state";
import { TREE_COLLAPSE_STORAGE_KEY } from "../shared/tree-collapse";
import { COLOR_ALIAS_STORAGE_KEY } from "../shared/inspector-colors";
import { verifyHomeDrawers, verifyHomeState, verifyDeviceChooser, verifyHomePreferences, verifyWorkbenchCommands,
  verifyEmptyWorkbench, verifyCaptureFailure } from "./workbench-entry-verification";

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean) { for (let i = 0; i < 60; i++) { if (predicate()) return; await tick(); } throw new Error("Entry state did not settle"); }
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector); check(found, `Missing ${selector}`); return found;
}
async function click(selector: string) { flushSync(() => { const control = element(selector); control.focus(); control.click(); }); await tick(); await tick(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

export function createWorkbenchEntryChecks(appRoot: Root, source: UiSnapshot) {
  const original = JSON.stringify(source);
  const device = (serial: string, model: string, state = "device"): DeviceInfo => ({ serial, model, state, androidVersion: "fixture", product: null, transportId: null });
  const ready = device(source.serial, "本地检查设备"), second = device("second-fixture", "中文长设备名称 / ".repeat(20));
  const pending = device("pending-fixture", "等待授权的设备", "unauthorized"), offline = device("offline-fixture", "离线设备", "offline");
  const connected: AdbProbeResult = { adbPath: "fixture-only", adbVersion: "fixture", devices: [ready, second, pending, offline], error: null };
  const calls = { probes: 0, captures: 0, cancels: 0, saves: 0, exports: [] as string[], forbidden: 0 };
  let probe: AdbProbeResult | Promise<AdbProbeResult> = connected;
  let capture: UiSnapshot | Promise<UiSnapshot> = source;
  let listener: ((action: AppMenuAction) => void) | null = null;
  let history = false;
  const bridge: Window["electronApi"] = {
    runtime: { sandboxed: true, contextIsolated: true, fixtureMode: true, nativeMenu: false },
    probeAdb: async () => { calls.probes++; return probe; },
    inspectDevice: async serial => { calls.captures++; return { ...(await capture), serial }; },
    cancelInspection: async () => { calls.cancels++; },
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    onAppMenuAction: callback => { listener = callback; return () => { if (listener === callback) listener = null; }; },
    captureGroup: forbidden, refreshViewNode: forbidden, readViewStyle: forbidden, showLayerMenu: forbidden,
    copyText: async () => {},
    loadSnapshots: async () => ({ error: null, snapshots: history ? [{ id: "synthetic-history", capturedAt: "2026-10-10T00:00:00Z", savedAt: "2026-10-10T00:00:01Z", snapshot: source }] : [] }),
    saveSnapshot: async () => { calls.saves++; return { snapshots: [], error: "合成检查，没有写入文件。" }; },
    clearSnapshots: forbidden,
    startDebugSession: forbidden,
    exportSnapshot: async request => { calls.exports.push(request.format); return { canceled: true, filePath: null, error: null }; },
    importSnapshotFile: async () => ({ canceled: true, filePath: null, data: null, error: null }),
  };
  async function forbidden(): Promise<never> { calls.forbidden++; throw new Error("Entry fixtures must not call a device or alter history"); }
  async function mount(next: AdbProbeResult | Promise<AdbProbeResult>, withHistory = false) {
    flushSync(() => appRoot.render(null));
    probe = next; history = withHistory; window.electronApi = bridge;
    flushSync(() => appRoot.render(<App />));
    await tick(); await tick();
  }
  function send(action: AppMenuAction) { check(listener, "App menu subscription missing"); flushSync(() => listener!(action)); }
  function key(key: string, shiftKey = false, repeat = false) {
    const mac = /Mac/.test(navigator.platform);
    const event = new KeyboardEvent("keydown", { key, metaKey: mac, ctrlKey: !mac, shiftKey, repeat, bubbles: true, cancelable: true });
    flushSync(() => document.dispatchEvent(event)); return event;
  }
  function state() { return element(".home-view").dataset.state; }
  const stateProbe = (value: HomeState): AdbProbeResult | Promise<AdbProbeResult> => {
    if (value === "loading") return new Promise(() => {});
    if (value === "connected") return connected;
    if (value === "adb-missing") return { ...connected, devices: [], adbPath: null };
    if (value === "no-device") return { ...connected, devices: [] };
    if (value === "unauthorized") return { ...connected, devices: [pending] };
    if (value === "offline") return { ...connected, devices: [offline] };
    return { ...connected, error: "本地连接错误 / ".repeat(30) };
  };
  async function showState(value: HomeState, withHistory = false) { await mount(stateProbe(value), withHistory); await verifyHomeState(value, false, flushSync); return value; }
  async function showCommands() {
    await mount(connected); const before = calls.captures;
    capture = { ...source, rawXml: "<hierarchy />" }; key("r"); await until(() => Boolean(document.querySelector(".tree-row")));
    await click(".workbench-utilities > summary");
    await Promise.all([...document.querySelectorAll<HTMLElement>(".inspection-header button")].flatMap(button => button.getAnimations()).map(animation => animation.finished.catch(() => {})));
    const reachableCommands = verifyWorkbenchCommands();
    check(calls.captures === before + 1 && !calls.forbidden && JSON.stringify(source) === original, "Command showcase exceeded its synthetic scope");
    const captureButton = element(".workbench-device-tools .capture-button");
    return { syntheticCaptures: 1, reachableCommands, sourceUnchanged: true, deviceActions: 0, historyWrites: 0,
      captureControl: { className: captureButton.className, color: getComputedStyle(captureButton).color } };
  }

  async function verify() {
    const oldCollapse = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
    const oldAliases = localStorage.getItem(COLOR_ALIAS_STORAGE_KEY);
    localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY);
    localStorage.removeItem(COLOR_ALIAS_STORAGE_KEY);
    try {
    const first = deferred<AdbProbeResult>(); await mount(first.promise);
    check(state() === "loading" && element<HTMLButtonElement>(".home-primary-action").disabled, "Initial probe flashes an error or exposes refresh");
    const probeCount = calls.probes; await click(".home-primary-action");
    check(calls.probes === probeCount && key("r").defaultPrevented && calls.captures === 0, "Busy home allowed another request");
    first.resolve({ ...connected, devices: [] }); await until(() => state() === "no-device");

    for (const value of ["connected", "unauthorized", "offline", "adb-missing", "no-device", "error"] as const) {
      await showState(value);
      if (value !== "connected") { send({ type: "capture" }); check(calls.captures === 0, "Unavailable home device was captured"); }
    }

    const retry = deferred<AdbProbeResult>(); probe = retry.promise;
    const retryCount = calls.probes; await click(".home-primary-action"); key("r", true); await click(".home-primary-action");
    check(state() === "loading" && calls.probes === retryCount + 1, "Refresh duplicated or retained an error state");
    retry.resolve(connected); await until(() => state() === "connected");
    const late = deferred<AdbProbeResult>(); await mount(late.promise); await mount(connected); late.resolve({ ...connected, adbPath: null }); await tick(); await tick();
    check(state() === "connected", "Unmounted probe replaced a newer connection");

    await verifyDeviceChooser([false, false, true, true], "cancel", flushSync);
    await click(".home-secondary-actions button:last-child"); await click(".home-device-option:nth-child(2)");
    check(element(".home-center-state h2").textContent === second.model && calls.captures === 0, "Home switch captured automatically or lost full device name");

    await verifyHomePreferences(flushSync, () => { key("r"); check(calls.captures === 0, "Shortcut captured under a modal"); });
    send({ type: "preferences" }); await tick(); check(element<HTMLSelectElement>(".preferences-panel select").value === "focus-branch", "Menu opened a different preference");
    await click(".entry-dialog-close");

    capture = { ...source, rawXml: "<hierarchy />" }; key("r"); await until(() => Boolean(document.querySelector(".tree-row")));
    check(Number(calls.captures) === 1 && element<HTMLSelectElement>('[aria-label="双击行为"]').value === "focus-branch", "Shortcut did not capture once or preference diverged");
    await click(".workbench-utilities > summary");
    verifyWorkbenchCommands();
    key("s"); key("s", true); await click("[data-command=export-xml]");
    await click(".workbench-utilities > summary"); await click("[data-command=export-png]");
    check(calls.saves === 1 && calls.exports.join() === "json,xml,png", "Save/export shortcuts did not dispatch once");
    probe = { ...connected, error: "合成连接异常" }; key("r", true); await until(() => state() === "error");
    send({ type: "capture" }); send({ type: "device", serial: ready.serial });
    check(Number(calls.captures) === 1 && element<HTMLSelectElement>("#device-select").disabled && element<HTMLButtonElement>(".workbench-device-tools .capture-button").disabled, "Failed connection reused a stale device for capture/switch");
    probe = connected; key("r", true); await until(() => state() === "connected");
    send({ type: "preferences" }); await tick();
    check(element<HTMLSelectElement>(".preferences-panel select").value === "focus-branch", "Workbench preferences lost the setting");
    flushSync(() => { element<HTMLSelectElement>(".preferences-panel select").value = "toggle"; element(".preferences-panel select").dispatchEvent(new Event("change", { bubbles: true })); });
    await click(".entry-dialog-close"); check(element<HTMLSelectElement>('[aria-label="双击行为"]').value === "toggle", "Tree quick setting diverged from preferences");
    key("h", true); await until(() => !document.querySelector(".inspection-active"));

    const busy = deferred<UiSnapshot>(); capture = busy.promise; key("r"); await until(() => Boolean(document.querySelector(".workbench-cancel")));
    const busyCount = calls.captures; key("r"); key("r", false, true); send({ type: "save" }); send({ type: "export-json" });
    check(calls.captures === busyCount && calls.saves === 1 && calls.exports.length === 3 && element<HTMLSelectElement>("#device-select").disabled, "Busy state accepts duplicate capture/export/device switch");
    key("."); await until(() => Boolean(document.querySelector(".capture-failure-feedback"))); busy.resolve(source); await tick(); await tick();
    check(calls.cancels === 1 && !document.querySelector(".tree-row") && element(".capture-failure-feedback").textContent?.includes("已取消"), "Cancel failed or a late capture restored the workbench");
    key("h", true); await until(() => !document.querySelector(".inspection-active"));

    capture = { ...source, root: null, screenshotDataUrl: null, rawXml: null }; key("r"); await until(() => Boolean(document.querySelector(".inspector-empty-grid")));
    verifyEmptyWorkbench();
    key("h", true); await until(() => !document.querySelector(".inspection-active"));
    capture = { ...source, root: null, screenshotDataUrl: null, error: "合成 Debug 连接失败" }; key("r"); await until(() => Boolean(document.querySelector(".capture-failure-feedback")));
    verifyCaptureFailure(); const failedCount = calls.captures; await tick(); await tick(); check(calls.captures === failedCount, "Failure automatically retries");
    capture = source; await click(".capture-retry"); await until(() => Boolean(document.querySelector(".tree-row")));
    check(calls.captures === failedCount + 1, "Explicit retry starts more than one request");

    await mount({ ...connected, devices: [] }, true); send({ type: "history" }); await tick();
    check(element<HTMLDialogElement>(".home-history").open && Boolean(document.querySelector(".snapshot-history-item")), "Saved history is unreachable without a device");
    const drawers = await verifyHomeDrawers(); send({ type: "history" }); await tick();
    await click(".home-history .snapshot-history-item"); await until(() => Boolean(document.querySelector(".tree-row")));
    check(element<HTMLButtonElement>(".workbench-device-tools .capture-button").disabled, "History view captures a missing device");
    const fullHint = element(".tree-toolbar .tree-hint").textContent;
    await click('.tree-row[data-tree-id="' + source.root!.id + '"]');
    send({ type: "preferences" }); await tick();
    const setField = (selector: string, value: string) => flushSync(() => {
      const control = element<HTMLInputElement | HTMLTextAreaElement>(selector);
      const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
    setField('[aria-label="初始显示层级"]', "0");
    check(element<HTMLButtonElement>(".preferences-actions button:nth-child(1)").disabled && document.querySelector(".preferences-error"), "Invalid depth could be saved");
    setField('[aria-label="初始显示层级"]', "1"); setField('[aria-label="默认收起的类型"]', "Svg*");
    check(element<HTMLButtonElement>(".preferences-actions button:nth-child(2)").disabled, "Wildcard class could be applied");
    setField('[aria-label="默认收起的类型"]', "SvgView"); await click(".preferences-actions button:nth-child(1)");
    check(element(".tree-toolbar .tree-hint").textContent === fullHint && JSON.parse(localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY)!).depth === 1, "Saving future defaults changed the current tree or was not persisted");
    await click(".preferences-actions button:nth-child(2)");
    check(document.querySelectorAll(".tree-row").length === 1 && element(".tree-toolbar .tree-hint").textContent?.startsWith("1/"), "Apply did not fold the current tree");
    const dialog = element(".preferences-panel"); check(dialog.scrollWidth <= dialog.clientWidth + 1, "Collapse preferences overflowed the dialog");
    setField('[aria-label="颜色别名"]', "#123456 = 主色\n#123456FF = 重复");
    check(element<HTMLButtonElement>(".preferences-color-actions button:first-child").disabled && element(".preferences-colors [role=alert]").textContent?.includes("重复"), "Duplicate color alias could be saved");
    setField('[aria-label="颜色别名"]', "rgba(18,52,86,0.5) = 半透明主色\n#0066FF = 品牌主色");
    await click(".preferences-color-actions button:first-child");
    check(JSON.parse(localStorage.getItem(COLOR_ALIAS_STORAGE_KEY)!).entries[0].color === "rgba(18, 52, 86, 0.5)"
      && element(".preferences-colors [role=status]").textContent?.includes("已保存"), "Alias save lost RGBA precision or success feedback");
    await click(".entry-dialog-close"); await click(".tree-expand-all");
    check(element(".tree-toolbar .tree-hint").textContent === fullHint, "Manual expand-all could not override initial rules");
    await click(".tree-interaction-settings > summary"); await click(".tree-interaction-settings-body > button");
    check(element<HTMLInputElement>('[aria-label="初始显示层级"]').value === "1" && element<HTMLTextAreaElement>('[aria-label="默认收起的类型"]').value === "SvgView", "Quick collapse settings lost the saved preference");
    await click(".entry-dialog-close");
    await mount({ ...connected, devices: [] }, true); send({ type: "history" }); await tick();
    await click(".home-history .snapshot-history-item"); await until(() => Boolean(document.querySelector(".tree-row")));
    check(document.querySelectorAll(".tree-row").length === 1, "New offline history ignored initial folding");
    send({ type: "preferences" }); await tick();
    check(element<HTMLTextAreaElement>('[aria-label="颜色别名"]').value === "rgba(18, 52, 86, 0.5) = 半透明主色\n#0066FFFF = 品牌主色", "Remounted preferences lost colors, aliases or alpha precision");
    await click(".preferences-color-actions button:last-child");
    check(JSON.parse(localStorage.getItem(COLOR_ALIAS_STORAGE_KEY)!).entries.length === 2, "Clearing a draft deleted saved aliases before save");
    await click(".preferences-color-actions button:first-child");
    check(JSON.parse(localStorage.getItem(COLOR_ALIAS_STORAGE_KEY)!).entries.length === 0, "Saving a cleared draft retained aliases");
    setField('[aria-label="颜色别名"]', "#123456 = 本次窗口主色");
    const originalSetItem = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = function(key: string, value: string) {
        if (key === COLOR_ALIAS_STORAGE_KEY) throw new Error("Synthetic preference write failure");
        return originalSetItem.call(this, key, value);
      };
      await click(".preferences-color-actions button:first-child");
      check(element(".preferences-colors [role=status]").textContent?.includes("本机保存失败")
        && JSON.parse(localStorage.getItem(COLOR_ALIAS_STORAGE_KEY)!).entries.length === 0, "Preference write failure claimed persistent success");
    } finally { Storage.prototype.setItem = originalSetItem; }
    await click(".entry-dialog-close");
    send({ type: "preferences" }); await tick();
    check(element<HTMLTextAreaElement>('[aria-label="颜色别名"]').value === "#123456FF = 本次窗口主色", "Write failure discarded the applied current-window aliases");
    await click(".entry-dialog-close");
    localStorage.setItem(COLOR_ALIAS_STORAGE_KEY, '{"version":1,"entries":[{"color":"red","alias":"invalid"}]}');
    await mount(connected); send({ type: "preferences" }); await tick();
    check(element<HTMLTextAreaElement>('[aria-label="颜色别名"]').value === "", "Corrupt alias preference crashed or invented a color");
    await click(".entry-dialog-close");
    const beforePreview = calls.captures;
    await showState("connected", true);
    check(element<HTMLImageElement>(".home-target-preview img").getAttribute("src") === source.screenshotDataUrl
      && element(".home-target-preview figcaption").textContent?.includes("上次采集"), "Saved preview lost its source or historical label");
    check(element(".home-target-preview img").getBoundingClientRect().height <= element(".home-target-preview").clientHeight + 1
      && getComputedStyle(element(".home-target-preview img")).objectFit === "contain", "Preview crops the captured screen");
    await click(".home-secondary-action[aria-haspopup=dialog]"); await click(".home-device-option:nth-child(2)");
    check(!document.querySelector(".home-target-preview img") && document.querySelector(".home-preview-placeholder"), "Different device inherited another device's preview");
    check(calls.captures === beforePreview, "Home preview initiated a device capture");
    check(!calls.forbidden && JSON.stringify(source) === original, "Entry checks performed device IO or mutated source");
    await showState("connected");
    return { fixtureOnly: true, drawers, calls: { ...calls, historyWrites: 0, deviceActions: 0, sourceUnchanged: true }, scenarios: [
      "initial loading and empty home do not expose capture", "seven honest home states and long connection details", "single refresh and late probe isolation",
      "modal device chooser, disabled unavailable devices and return focus", "one persistent preference across home/menu/tree/workbench",
      "shared save/export/capture shortcuts and source availability", "busy capture, cancellation and late reply isolation",
      "empty/failed workbench, explicit retry and offline history",
      "historical preview stays labelled, matches the selected device and performs no capture",
      "default collapse: validation, save/apply separation, quick settings, manual override and offline remount",
      "color aliases: duplicate validation, exact RGBA persistence, draft clearing, honest write failure and corrupt preference fallback",
    ] };
    } finally {
      if (oldCollapse === null) localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY); else localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, oldCollapse);
      if (oldAliases === null) localStorage.removeItem(COLOR_ALIAS_STORAGE_KEY); else localStorage.setItem(COLOR_ALIAS_STORAGE_KEY, oldAliases);
    }
  }
  return { verify, showState, showCommands };
}
